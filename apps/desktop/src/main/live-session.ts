import {buildLiveContext} from './live-context';
import {randomUUID} from 'node:crypto';
import type {SessionHistory} from './desktop-session';
import type {createSessionKnowledge} from './session-knowledge';
import type {BackendRequest} from './agent-backend';
import type {LiveConnection,LiveConnectOptions,LiveEvent,LivePreferences,LiveState} from './live-types';
export type TranscriptFragment={speaker:'user'|'assistant';text:string;startMs:number;endMs:number};
/** Conversation/task semantics belong to EchoPilot; provider wire events stay in adapters. */
export function createLiveSession(options:{userInput?(text:string):void;screenContext?():unknown;preferences():LivePreferences;key(provider:'openai'|'gemini'):Promise<string|null>;allowed():boolean;connect(provider:'openai'|'gemini',options:LiveConnectOptions):Promise<LiveConnection>;knowledge:ReturnType<typeof createSessionKnowledge>;backend(request:BackendRequest):Promise<string>;clearBackend():void;history():SessionHistory[];remember(item:SessionHistory):Promise<void>;changed(state:LiveState):void;media(event:{sessionId:string;type:'audio'|'interrupt';pcmBase64?:string;sampleRate?:24000}):void}){
  let state:LiveState={id:null,mode:'agent',phase:'idle',message:'',reply:'',transcript:'',recording:false,transport:'webrtc',provider:'openai'};
  let connection:LiveConnection|null=null;let opening=false;let closing:Promise<void>|null=null;let controller=new AbortController();let workController=new AbortController();
  let fragments:TranscriptFragment[]=[];let revision=0;let lastInputAt=0;let inputOffset=0;let userChars=0;let closingHistory=false;
  const seen=new Set<string>();const notices=new Map<string,{offsetMs:number;task?:string}>();let running=false;
  let pumpTimer:ReturnType<typeof setTimeout>|null=null;let watchTimer:ReturnType<typeof setInterval>|null=null;let limitTimer:ReturnType<typeof setTimeout>|null=null;let refreshing=false;let refreshAfter=0;let mediaReady=false;let activeWorkId:string|null=null;
  const update=(patch:Partial<LiveState>)=>{state={...state,...patch};options.changed({...state});};
  function check(id:string,signal:AbortSignal){signal.throwIfAborted();if(state.id!==id||!options.allowed())throw Error('Live session ended.');}
  const transcript=()=>{const turns:{speaker:string;text:string;end:number}[]=[];for(const fragment of fragments.slice(-160)){const last=turns.at(-1);if(last&&last.speaker===fragment.speaker&&fragment.startMs-last.end<1500){last.text+=fragment.text;last.end=fragment.endMs;}else turns.push({speaker:fragment.speaker,text:fragment.text,end:fragment.endMs});}return turns.map(t=>`${t.speaker}: ${t.text}`).join('\n');};
  async function stop(){if(closing)return closing;const id=state.id;const old=connection;connection=null;
    workController.abort();controller.abort();opening=false;mediaReady=false;notices.clear();options.clearBackend();
    if(pumpTimer)clearTimeout(pumpTimer);pumpTimer=null;if(watchTimer)clearInterval(watchTimer);watchTimer=null;if(limitTimer)clearTimeout(limitTimer);limitTimer=null;
    if(!id){update({phase:'idle',message:'',recording:false});return;}
    update({phase:'closing',message:'Ending conversation…',recording:false});
    closing=(async()=>{const finalized=old?await old.close().catch(()=>false):false;
      if(fragments.length&&!closingHistory){closingHistory=true;await options.remember({id:randomUUID(),at:new Date().toISOString(),mode:'agent',text:fragments.filter(f=>f.speaker==='user').map(f=>f.text).join('').slice(-8000),result:fragments.filter(f=>f.speaker==='assistant').map(f=>f.text).join('').slice(-12000)}).catch(()=>{});}
      if(state.id===id)update({id:null,phase:'idle',message:'',transcript:'',reply:'',recording:false,finalized});
    })();try{await closing;}finally{closing=null;}
  }
  async function fail(message:string){const id=state.id;await stop();if(!state.id||state.id===id)update({phase:'error',message,recording:false});}
  async function start(){await stop();if(!options.allowed()){update({phase:'error',message:'Leave private or muted mode to start.'});return;}
    const preferences=options.preferences();controller=new AbortController();workController=new AbortController();fragments=[];seen.clear();notices.clear();revision=0;inputOffset=0;userChars=0;lastInputAt=0;closingHistory=false;refreshAfter=0;
    update({id:randomUUID(),provider:preferences.provider,transport:preferences.provider==='openai'?'webrtc':'pcm',phase:'starting',message:'Connecting voice…',recording:true});
  }
  async function join(id:string,sdp?:string){if(state.id!==id||opening||connection||closing)throw Error('Live connection is not pending.');opening=true;const signal=controller.signal;const provider=state.provider;
    try{const key=await options.key(provider);check(id,signal);if(!key)throw Error(`Add your ${provider==='gemini'?'Gemini':'OpenAI'} key in Setup.`);
      const catalog=await options.knowledge.catalog();check(id,signal);
      const sharedScreen=options.screenContext?.();const context=buildLiveContext({catalog,briefs:options.knowledge.retained(),history:options.history()})+(sharedScreen?'\nShared screen evidence: '+JSON.stringify(sharedScreen):'');
      const created=await options.connect(provider,{key,...(sdp?{sdp}:{}),voice:options.preferences().voice,context,signal,onEvent:event=>{if(state.id===id&&!signal.aborted)receive(event,id,signal);}});
      try{check(id,signal);}catch(error){await created.close();throw error;}connection=created;opening=false;
      update({message:provider==='gemini'?'Listening':'Connecting audio…',phase:provider==='gemini'?'listening':'starting'});
      watchTimer=setInterval(()=>void refresh(id,signal),5000);watchTimer.unref();limitTimer=setTimeout(()=>void stop(),45*60*1000);limitTimer.unref();
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
      fragments.push({speaker:event.speaker,text:event.text,startMs:event.startMs,endMs:event.endMs});fragments.sort((a,b)=>a.startMs-b.startMs);
      if(fragments.length>400)fragments.splice(0,fragments.length-400);
      if(event.speaker==='user'){revision++;userChars+=event.text.length;lastInputAt=Date.now();inputOffset=Math.max(inputOffset,event.endMs);workController.abort();workController=new AbortController();options.userInput?.(event.text);update({transcript:(state.transcript+event.text).slice(-4000),message:'Listening',phase:'listening'});schedule();}
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
  async function refresh(id:string,signal:AbortSignal){if(!mediaReady||refreshing||running||closing||Date.now()<refreshAfter||Date.now()-lastInputAt<2500)return;refreshing=true;
    try{const changed=await options.knowledge.changed();check(id,signal);if(changed[0]){const brief=await options.knowledge.research(changed[0],'Refresh goals, decisions, current progress and unresolved issues from changed records.',signal);check(id,signal);connection?.context(JSON.stringify(brief));}}catch{refreshAfter=Date.now()+60000;}finally{refreshing=false;}
  }
  return {start,stop,join,status:()=>({...state}),active:()=>state.id!==null,revision:()=>revision,inputOffset:()=>inputOffset,userTextAfter:(offset:number)=>fragments.filter(f=>f.speaker==='user'&&f.endMs>offset).map(f=>f.text).join(''),note(content:string){if(!connection||closing||!options.allowed())return false;connection.context(content);return true;},
    ready(id:string){if(state.id===id&&!closing){mediaReady=true;update({phase:'listening',message:'Listening'});schedule();}},error(id:string){if(state.id===id&&!closing&&state.phase!=='closing')void fail('Microphone or voice connection failed. Please try again.');},
    audio(id:string,bytes:Uint8Array){if(state.id!==id||closing||state.provider!=='gemini'||!connection?.audio)return;if(!options.allowed()){void stop();return;}try{connection.audio(bytes);}catch{void fail('Audio connection is congested. Please reconnect.');}},
  };
}
