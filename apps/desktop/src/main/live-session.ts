import {currentQuestion,matchingSessions,warmEvidence} from './continuity-retrieval';
import {buildLiveContext,clipContext,contextTokens} from './live-context';
import {randomUUID} from 'node:crypto';
import type {SessionHistory} from './desktop-session';
import type {createSessionKnowledge} from './session-knowledge';
import type {BackendRequest} from './agent-backend';
import type {LiveConnection,LiveConnectOptions,LiveEvent,LivePreferences,LiveState} from './live-types';
export type TranscriptFragment={speaker:'user'|'assistant';text:string;startMs:number;endMs:number};
/** Conversation/task semantics belong to EchoPilot; provider wire events stay in adapters. */
export function createLiveSession(options:{facts?():import('./assistant-memory').AssistantFact[];onSleep?():void;now?():number;userInput?(text:string):void;screenContext?():unknown;preferences():LivePreferences;key(provider:'openai'|'gemini'):Promise<string|null>;allowed():boolean;connect(provider:'openai'|'gemini',options:LiveConnectOptions):Promise<LiveConnection>;knowledge:ReturnType<typeof createSessionKnowledge>;backend(request:BackendRequest):Promise<string>;clearBackend():void;history():SessionHistory[];remember(item:SessionHistory):Promise<void>;changed(state:LiveState):void;media(event:{sessionId:string;type:'audio'|'interrupt';pcmBase64?:string;sampleRate?:24000}):void}){
  const now=options.now??Date.now;
  let lastActivityAt=now();let rotationPending=false;let pushedTokens=0;let controlTimer:ReturnType<typeof setTimeout>|null=null;let prefetchTimer:ReturnType<typeof setTimeout>|null=null;let suppliedSources=new Map<string,string>();let hydratedSessions=new Set<string>();let hydration:Promise<void>|null=null;
  let state:LiveState={id:null,mode:'agent',phase:'idle',message:'',reply:'',transcript:'',recording:false,transport:'webrtc',provider:'openai'};
  let connection:LiveConnection|null=null;let opening=false;let closing:Promise<void>|null=null;let controller=new AbortController();let workController=new AbortController();
  let fragments:TranscriptFragment[]=[];let revision=0;let lastInputAt=0;let inputOffset=0;let userChars=0;let closingHistory=false;
  let contextVersions=new Map<string,string>();let factsFingerprint='';
  const seen=new Set<string>();const notices=new Map<string,{offsetMs:number;task?:string}>();let running=false;
  let pumpTimer:ReturnType<typeof setTimeout>|null=null;let watchTimer:ReturnType<typeof setInterval>|null=null;let limitTimer:ReturnType<typeof setTimeout>|null=null;let refreshing=false;let refreshAfter=0;let mediaReady=false;let activeWorkId:string|null=null;
  const update=(patch:Partial<LiveState>)=>{state={...state,...patch};options.changed({...state});};
  function check(id:string,signal:AbortSignal){signal.throwIfAborted();if(state.id!==id||!options.allowed())throw Error('Live session ended.');}
  const transcript=()=>{const turns:{speaker:string;text:string;end:number}[]=[];for(const fragment of fragments.slice(-160)){const last=turns.at(-1);if(last&&last.speaker===fragment.speaker&&fragment.startMs-last.end<1500){last.text+=fragment.text;last.end=fragment.endMs;}else turns.push({speaker:fragment.speaker,text:fragment.text,end:fragment.endMs});}return turns.map(t=>`${t.speaker}: ${t.text}`).join('\n');};
  function continuityTurns(){const turns:{speaker:'user'|'assistant';text:string}[]=[];for(const fragment of fragments){const last=turns.at(-1);if(last?.speaker===fragment.speaker)last.text+=fragment.text;else turns.push({speaker:fragment.speaker,text:fragment.text});}let remaining=12000;const selected=[];for(const turn of turns.slice(-24).reverse()){if(remaining<=0)break;const text=turn.text.slice(-Math.min(remaining,2000));remaining-=text.length;selected.unshift({speaker:turn.speaker,text});}return selected;}
  async function stop(){if(closing)return closing;const id=state.id;const old=connection;connection=null;
    if(controlTimer)clearTimeout(controlTimer);controlTimer=null;if(prefetchTimer)clearTimeout(prefetchTimer);prefetchTimer=null;workController.abort();controller.abort();opening=false;mediaReady=false;notices.clear();options.clearBackend();
    if(pumpTimer)clearTimeout(pumpTimer);pumpTimer=null;if(watchTimer)clearInterval(watchTimer);watchTimer=null;if(limitTimer)clearTimeout(limitTimer);limitTimer=null;
    if(!id){update({phase:'idle',message:'',recording:false});return;}
    update({phase:'closing',message:'Ending conversation…',recording:false});
    closing=(async()=>{const finalized=old?await old.close().catch(()=>false):false;
      if(fragments.length&&!closingHistory){closingHistory=true;await options.remember({id:randomUUID(),at:new Date().toISOString(),mode:'agent',turns:continuityTurns(),text:fragments.filter(f=>f.speaker==='user').map(f=>f.text).join('').slice(-8000),result:fragments.filter(f=>f.speaker==='assistant').map(f=>f.text).join('').slice(-12000)}).catch(()=>{});}
      if(state.id===id)update({id:null,phase:'idle',message:'',transcript:'',reply:'',recording:false,finalized,asleep:false});
    })();try{await closing;}finally{closing=null;}
  }
  async function fail(message:string){const id=state.id;await stop();if(!state.id||state.id===id)update({phase:'error',message,recording:false});}
  async function start(){await stop();if(!options.allowed()){update({phase:'error',message:'Leave private or muted mode to start.'});return;}
    const preferences=options.preferences();controller=new AbortController();workController=new AbortController();fragments=[];seen.clear();notices.clear();revision=0;inputOffset=0;userChars=0;lastInputAt=0;closingHistory=false;refreshAfter=0;lastActivityAt=now();pushedTokens=0;suppliedSources.clear();hydratedSessions.clear();hydration=null;rotationPending=false;
    update({id:randomUUID(),provider:preferences.provider,transport:preferences.provider==='openai'?'webrtc':'pcm',phase:'starting',message:'Connecting voice…',recording:true,asleep:false});
  }
  async function join(id:string,sdp?:string){if(state.id!==id||opening||connection||closing)throw Error('Live connection is not pending.');opening=true;const signal=controller.signal;const provider=state.provider;
    try{const key=await options.key(provider);check(id,signal);if(!key)throw Error(`Add your ${provider==='gemini'?'Gemini':'OpenAI'} key in Setup.`);
      const catalog=options.knowledge.peek?.()??await options.knowledge.catalog();check(id,signal);
      const sharedScreen=options.screenContext?.();const warmSources=warmEvidence(catalog,options.knowledge.search??(()=>[]));const context=buildLiveContext({catalog,briefs:options.knowledge.retained(),history:options.history(),facts:options.facts?.()??[],sources:[...new Map(warmSources.map(source=>[source.ref,source])).values()]})+(sharedScreen?'\nShared screen evidence: '+clipContext(JSON.stringify(sharedScreen),1500):'');
      contextVersions=new Map(catalog.map(row=>[row.sessionId,row.updatedAt]));factsFingerprint=JSON.stringify(options.facts?.()??[]);
      const created=await options.connect(provider,{key,...(sdp?{sdp}:{}),voice:options.preferences().voice,context,signal,onEvent:event=>{if(state.id===id&&!signal.aborted)receive(event,id,signal);}});
      try{check(id,signal);}catch(error){await created.close();throw error;}connection=created;opening=false;
      update({message:provider==='gemini'?'Listening':'Connecting audio…',phase:provider==='gemini'?'listening':'starting'});
      watchTimer=setInterval(()=>{void checkIdle();void refresh(id,signal);},2000);watchTimer.unref();limitTimer=setTimeout(()=>{rotationPending=true;},40*60*1000);limitTimer.unref();
      schedule();return {sdp:created.sdp};
    }catch(error){if(state.id===id&&!signal.aborted)await fail(error instanceof Error?error.message:'Could not connect voice.');throw error;}
  }
  function receive(event:LiveEvent,id:string,signal:AbortSignal){
    if(event.type==='failure'){void fail(event.message);return;}
    if(event.type==='closed'){if(!closing)void fail('Voice connection ended. Press ⌥ Space to reconnect.');return;}
    if(event.type==='audio'){options.media({sessionId:id,...event});return;}
    if(event.type==='interrupt'){options.media({sessionId:id,type:'interrupt'});return;}
    if(event.type==='cancel-work'){notices.delete(event.id);if(activeWorkId===event.id){workController.abort();workController=new AbortController();}return;}
    if(event.type==='transcript'){
      if(event.id){if(seen.has(event.id))return;seen.add(event.id);if(seen.size>1000)seen.delete(seen.values().next().value!);}
      lastActivityAt=now();
      fragments.push({speaker:event.speaker,text:event.text,startMs:event.startMs,endMs:event.endMs});fragments.sort((a,b)=>a.startMs-b.startMs);
      if(fragments.length>400)fragments.splice(0,fragments.length-400);
      if(event.speaker==='user'){revision++;userChars+=event.text.length;lastInputAt=Date.now();inputOffset=Math.max(inputOffset,event.endMs);workController.abort();workController=new AbortController();options.userInput?.(event.text);scheduleControl();prefetch();update({transcript:(state.transcript+event.text).slice(-4000),message:'Listening',phase:'listening'});schedule();}
      else {const previous=fragments.at(-2);update({reply:((previous?.speaker==='assistant'?state.reply:'')+event.text).slice(-700),message:'Live',phase:'listening'});}
    }else if(event.type==='delegation'){
      const key=`work:${event.id}`;if(seen.has(key))return;seen.add(key);if(notices.size>=8){deliver('Please finish one request before starting another.',event.id,true);return;}
      notices.set(event.id,{offsetMs:event.offsetMs,...(event.task?{task:event.task}:{})});schedule();
    }
  }
  function deliver(content:string,id:string,speak:boolean){try{connection?.result(content,id,speak);}catch{void fail('Voice connection could not receive the result. Please reconnect.');}}
  function schedule(){if(pumpTimer)clearTimeout(pumpTimer);pumpTimer=setTimeout(()=>void pump(),300);}
  async function pump(){if(running||!mediaReady||!connection||!state.id||closing||!notices.size)return;if(Date.now()-lastInputAt<250){schedule();return;}const id=state.id;const signal=controller.signal;const next=notices.entries().next().value!;
    if(!userChars&&!next[1].task){return;}notices.delete(next[0]);const version=revision;running=true;activeWorkId=next[0];const workSignal=AbortSignal.any([signal,workController.signal,AbortSignal.timeout(45000)]);
    try{update({message:'Working with you…'});const result=await options.backend({conversation:transcript(),...(next[1].task?{task:next[1].task}:{}),revision:version,signal:workSignal});check(id,signal);
      deliver(result,next[0],revision===version);update({message:'Listening',phase:'listening'});
    }catch{if(state.id===id&&!signal.aborted&&!closing){deliver(workSignal.aborted?'The request changed or was canceled; no further action was taken.':'The backend could not finish this request. Ask the user to retry or clarify.',next[0],!workSignal.aborted);}}
    finally{running=false;activeWorkId=null;if(connection&&notices.size&&!closing)schedule();}
  }
  function pushEvidence(found:import('./coding-context').SessionSource[],coverage:string){
    if(!connection||closing||!options.allowed())return;
    const sources=found.filter(source=>suppliedSources.get(source.ref)!==source.text).slice(0,6);
    if(!sources.length)return;
    const packet=JSON.stringify({localSessionEvidence:sources.map(source=>({ref:source.ref,text:clipContext(source.text,650)})),coverage});
    const tokens=contextTokens(packet);if(pushedTokens+tokens>16000){rotationPending=true;return;}
    try{connection.context(packet);}catch{void fail('Voice connection could not receive context. Please reconnect.');return;}
    pushedTokens+=tokens;for(const source of sources)suppliedSources.set(source.ref,source.text);
  }
  function prefetch(){
    // Throttle, rather than debounce: a continuous stream of deltas must not starve retrieval.
    if(prefetchTimer)return;
    prefetchTimer=setTimeout(()=>{
      prefetchTimer=null;if(!connection||closing||!options.allowed())return;
      const question=currentQuestion(fragments);if(question.length<8)return;
      const matches=matchingSessions(question,options.knowledge.peek?.()??[]);
      const search=options.knowledge.search;
      const local=[...matches.flatMap(row=>search?.(question,row.sessionId,4)??[]),...(search?.(question)??[])];
      pushEvidence([...new Map(local.map(source=>[source.ref,source])).values()], 'Query-selected saved excerpts, not new instructions or verified live status.');
      if(hydration||!options.knowledge.evidence)return;
      const selected=matches.find(row=>!hydratedSessions.has(row.sessionId+':'+row.updatedAt));if(!selected)return;
      const id=state.id,version=revision,signal=controller.signal;
      const task=(async()=>{
        try{
          const evidence=await options.knowledge.evidence(selected.sessionId,question);
          if(signal.aborted||id!==state.id||!options.allowed())return;
          hydratedSessions.add(selected.sessionId+':'+selected.updatedAt);
          if(version===revision)pushEvidence(evidence.sources,evidence.coverage);
        }catch{/* Opportunistic local retrieval never interrupts the voice turn. Explicit research can retry. */}
      })();
      hydration=task;void task.finally(()=>{if(hydration!==task)return;hydration=null;if(!signal.aborted&&state.id===id&&revision!==version)prefetch();});
    },120);
  }
  async function sleep(){await stop();update({phase:'idle',asleep:true,message:'Sleeping'});options.onSleep?.();}
  async function checkIdle(){const seconds=options.preferences().idleTimeoutSeconds??60;if(seconds>0&&mediaReady&&!running&&!notices.size&&!closing&&now()-lastActivityAt>=seconds*1000)await sleep();}
  function scheduleControl(){if(controlTimer)clearTimeout(controlTimer);controlTimer=setTimeout(()=>{
    let userIndex=fragments.length-1;while(userIndex>=0&&fragments[userIndex]!.speaker!=='user')userIndex--;const last=fragments[userIndex];if(!last)return;const turn:TranscriptFragment[]=[];let next=last;for(const fragment of fragments.slice(0,userIndex+1).reverse()){if(fragment.speaker!=='user'||next.startMs-fragment.endMs>1500)break;turn.unshift(fragment);next=fragment;}
    const spoken=turn.map(f=>f.text).join('').trim().replace(/[’‘]/g,"'").replace(/[.,!?]/g,'').toLowerCase();
    if(/^(?:(?:okay|ok|thanks|thank you|that's all|that is all|please)\s+)*(?:hang up|end (?:the |this )?(?:call|conversation|session)|disconnect)(?: please)?$/.test(spoken))void stop();
    else if(/^(?:please )?(?:go to sleep|sleep now|stop listening)(?: please)?$/.test(spoken))void sleep();
  },700);}
  async function refresh(id:string,signal:AbortSignal){if(!mediaReady||refreshing||running||closing||Date.now()<refreshAfter||Date.now()-lastInputAt<1500)return;refreshing=true;
    try{
      if(rotationPending&&now()-lastActivityAt>4000&&!notices.size){await start();return;}
      await options.knowledge.refresh?.();check(id,signal);
      const catalog=options.knowledge.peek?.();if(!catalog)return;
      const facts=options.facts?.()??[];const nextFacts=JSON.stringify(facts);
      const changed=catalog.filter(row=>contextVersions.get(row.sessionId)!==row.updatedAt).slice(0,2);
      const removedSessions=[...contextVersions.keys()].filter(id=>!catalog.some(row=>row.sessionId===id));
      if(!changed.length&&!removedSessions.length&&nextFacts===factsFingerprint){refreshAfter=Date.now()+15000;return;}
      const update={type:'working_context_update',coverage:'Saved excerpts; these replace older excerpts for the same sessions. Not verified live status.',
        sessions:changed,sources:changed.flatMap(row=>(options.knowledge.search?.('',row.sessionId,3)??[]).map(source=>({ref:source.ref,text:clipContext(source.text,350)}))),
        ...(nextFacts!==factsFingerprint?{commitments:facts}:{}),removedSessions};
      const snapshot=JSON.stringify(update);const tokens=contextTokens(snapshot);
      if(pushedTokens+tokens>16000){rotationPending=true;return;}
      connection?.context(snapshot);pushedTokens+=tokens;
      for(const id of removedSessions)contextVersions.delete(id);for(const row of changed)contextVersions.set(row.sessionId,row.updatedAt);factsFingerprint=nextFacts;refreshAfter=Date.now()+15000;
      // Raw source changes are retrieved locally; no paid summarizer runs on a polling timer.
    }catch{refreshAfter=Date.now()+30000;}finally{refreshing=false;}
  }
  return {start,stop,sleep,checkIdle,join,status:()=>({...state}),active:()=>state.id!==null,revision:()=>revision,inputOffset:()=>inputOffset,userTextAfter:(offset:number)=>fragments.filter(f=>f.speaker==='user'&&f.endMs>offset).map(f=>f.text).join(''),note(content:string){if(!connection||closing||!options.allowed())return false;const bounded=clipContext(content,1800);if(pushedTokens+contextTokens(bounded)>20000){rotationPending=true;return false;}connection.context(bounded);pushedTokens+=contextTokens(bounded);return true;},
    ready(id:string){if(state.id===id&&!closing){mediaReady=true;update({phase:'listening',message:'Listening'});schedule();}},error(id:string,code?:string){if(state.id===id&&!closing&&state.phase!=='closing')void fail(code==='NotAllowedError'?'Microphone access is blocked. Allow EchoPilot in System Settings → Privacy & Security → Microphone.':code==='NotFoundError'?'No microphone found. Connect a microphone and try again.':code==='NotReadableError'?'The microphone is unavailable. Check your audio input and try again.':'Microphone or voice connection failed. Please try again.');},
    audio(id:string,bytes:Uint8Array){if(state.id!==id||closing||state.provider!=='gemini'||!connection?.audio)return;if(!options.allowed()){void stop();return;}try{connection.audio(bytes);}catch{void fail('Audio connection is congested. Please reconnect.');}},
  };
}
