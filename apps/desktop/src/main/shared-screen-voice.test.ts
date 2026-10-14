import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveSession} from './live-session';
import {createAgentBackend} from './agent-backend';
import {createDesktopActions} from './desktop-actions';
import {SharedScreenContextFeed,type SemanticScreenContext} from './shared-screen-context';
import type {LiveEvent,LiveConnectOptions} from './live-types';
import type {ScreenRegion} from './shared-attention';
const settle=()=>new Promise(resolve=>setTimeout(resolve,340));
const tool=(name:string,args:unknown,id=name)=>({content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
function harness(){
  let receive!:(event:LiveEvent)=>void,connectOptions:LiveConnectOptions|undefined;
  let allowed=true,initialReads=0,focused=0,writes=0,prepared=0,offset=0;
  let currentNative={appBundleId:'fixture.app',role:'AXButton',label:'Open',fingerprint:'v1',value:'',enabled:true,focused:true};
  const regions:ScreenRegion[]=['a','b'].map((id,index)=>({id,revision:'1',app:'fixture.app:42',window:'w',type:'AXButton',label:index?'Save':'Open',bounds:{x:index*150,y:100,width:100,height:80}}));
  let lookedAt=regions[0]!,pinned:ScreenRegion|null=null;
  const notes:string[]=[],results:unknown[][]=[],messages:any[][]=[],queue:any[]=[],order:string[]=[];
  const knowledge={catalog:async()=>[],retained:()=>[],changed:async()=>[]} as any;
  const context=()=>({screen:{app:'Fixture',window:'w',revision:'scene1',targetId:(pinned??lookedAt).id,regions},referent:{target:pinned??lookedAt,ambiguous:false}});
  const actions=createDesktopActions({bundleDir:'/synthetic',activeProjectId:()=> 'p',openSession:()=>({close(){},async request(payload){if(payload.operation==='focused-control')return {targetRef:'ax:42:0',state:{...currentNative}};if(payload.operation==='inspect')return {...currentNative};if(payload.operation==='propose')return {proposalId:'fake'};if(payload.operation==='authorize')return {authorized:true};if(payload.operation==='advance'){writes++;return {status:'completed',steps:[{verification:'presence_only'}],evidenceIds:['fake:before','fake:after']};}throw Error('Unexpected fake operation');}})});
  const live=createLiveSession({preferences:()=>({provider:'gemini',voice:'Kore'}),key:async()=> 'fake-only',allowed:()=>allowed,
    knowledge,backend:request=>{order.push('backend');return backend.run(request);},clearBackend:()=>backend.clear(),history:()=>[],remember:async()=>{},changed(){},media(){},
    screenContext:()=>{initialReads++;return context();},userInput:text=>{order.push('pin:'+text);pinned=structuredClone(lookedAt);},
    connect:async(_provider,options)=>{connectOptions=options;receive=options.onEvent;return {context:text=>notes.push(text),result:(...args)=>results.push(args),close:async()=>true};}});
  const backend=createAgentBackend({config:()=>({provider:'openrouter',textModel:'fake',speechModel:'fake'}),cloud:{agentStep:async(_config:any,history:any)=>{messages.push(structuredClone(history));return queue.shift()??{content:'Observed'};}} as any,knowledge,
    screenContext:context,focusScreenTarget:(id,signal)=>{signal.throwIfAborted();const target=regions.find(r=>r.id===id);if(!target)throw Error('Target is stale or unavailable.');focused++;lookedAt=target;pinned=structuredClone(target);return {id:target.id,label:target.label,kind:target.type,authorization:false};},screen:async()=>({text:JSON.stringify(context())}),
    prepare:async action=>{prepared++;const region=pinned??lookedAt;if(!regions.some(r=>r.id===region.id&&r.revision===region.revision))throw Error('Highlighted target changed.');const draft=await actions.handle({command:'prepareAction',projectId:'p',operation:action.operation,direction:action.value});assert.equal(draft.ok,true);const preview=(await actions.handle({command:'previewPrepared',projectId:'p'})).preview!;return {label:preview.label,execute:async()=>{const outcome=await actions.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});if(!outcome.ok)throw Error(outcome.error);}};},
    revision:()=>live.revision(),inputOffset:()=>live.inputOffset(),userTextAfter:at=>live.userTextAfter(at),contextNote:text=>{live.note(text);}});
  return {live,backend,notes,results,messages,queue,order,regions,reads:()=>initialReads,connected:()=>connectOptions,counts:()=>({focused,writes,prepared}),look(id:string){lookedAt=regions.find(r=>r.id===id)!;},allow(value:boolean){allowed=value;},changeNative(){currentNative={...currentNative,fingerprint:'v2'};},
    speech(text:string){offset+=100;receive({type:'transcript',speaker:'user',text,startMs:offset-10,endMs:offset,id:'speech-'+offset});},delegate(id:string){receive({type:'delegation',id,offsetMs:offset});},
    async start(){await live.start();await live.join(live.status().id!);live.ready(live.status().id!);},async stop(){await live.stop();actions.dispose();}};
}
test('initial shared screen is read exactly once and user transcript pins before actual backend delegation',async()=>{
  const h=harness();try{await h.start();assert.equal(h.reads(),1);assert.equal((h.connected()!.context.match(/Shared screen evidence:/g)??[]).length,1);h.speech('Open this one');assert.equal(h.order[0],'pin:Open this one');h.look('b');h.queue.push({content:'The pinned Open button is selected.'});h.delegate('d');await settle();const user=JSON.parse(h.messages[0]![1].content);assert.equal(user.sharedScreen.referent.target.id,'a');assert.equal(h.order[1],'backend');assert.equal(h.results.length,1);}finally{await h.stop();}
});
test('quiet bounded context notes never create a spoken result or backend prompt',async()=>{
  const h=harness();assert.equal(h.live.note('before connection'),false);try{await h.start();const feed=new SharedScreenContextFeed({intervalMs:1000,maxBytes:1200,bytesPerMinute:8000});for(let at=0;at<=4000;at+=100){const region=h.regions[0]!;const scene:SemanticScreenContext={app:'Fixture',window:'w',revision:String(at),capturedAt:at,attention:{state:'stable',target:region,candidates:[{region,probability:.9}],uncertaintyRadius:40,changedAt:0,observedAt:at}};feed.offer(scene,at);const packet=feed.flush(at);if(packet)assert.equal(h.live.note(JSON.stringify({sharedScreen:packet})),true);}assert.equal(h.notes.length,1);assert.ok(Buffer.byteLength(h.notes[0]!)<1300);assert.equal(h.results.length,0);assert.equal(h.messages.length,0);}finally{await h.stop();}assert.equal(h.live.note('after close'),false);
});
test('correction focus tool highlights the named candidate without preparing or executing an action',async()=>{
  const h=harness();try{await h.start();h.queue.push(tool('focus_screen_target',{target_id:'b'}),{content:'The Save button is highlighted.'});h.speech('No, the Save button instead');h.delegate('correct');await settle();assert.deepEqual(h.counts(),{focused:1,writes:0,prepared:0});const receipt=JSON.parse(h.messages[1]!.find(m=>m.role==='tool').content);assert.equal(receipt.id,'b');assert.equal(receipt.authorization,false);}finally{await h.stop();}
});
test('an unavailable correction candidate is refused instead of silently using another target',async()=>{
  const h=harness();try{await h.start();h.queue.push(tool('focus_screen_target',{target_id:'gone'}),{content:'Please identify the visible button.'});h.speech('No, this one');h.delegate('missing');await settle();assert.deepEqual(h.counts(),{focused:0,writes:0,prepared:0});const receipt=JSON.parse(h.messages[1]!.find(m=>m.role==='tool').content);assert.equal(receipt.ok,false);assert.match(receipt.error,/stale|unavailable/);}finally{await h.stop();}
});
test('a prepared gaze action waits for later exact speech and rejects a stale native control',async()=>{
  const h=harness();try{await h.start();h.queue.push(tool('prepare_desktop_action',{operation:'click',target:'gaze',value:''}),{content:'Confirm Open?'});h.speech('Click this');h.delegate('prepare');await settle();const id=h.backend.pending()!.id;assert.equal(h.counts().writes,0);h.queue.push(tool('commit_desktop_action',{proposal_id:id}),{content:'Please confirm.'});h.delegate('premature');await settle();assert.equal(h.counts().writes,0);const failedConfirmation=JSON.parse(h.messages[3]!.slice().reverse().find(m=>m.role==='tool').content);assert.match(failedConfirmation.error,/fresh spoken confirmation/);
    h.changeNative();h.queue.push(tool('commit_desktop_action',{proposal_id:id}),{content:'The target changed; please retry.'});h.speech('confirm');h.delegate('stale');await settle();assert.equal(h.counts().writes,0);const stale=JSON.parse(h.messages.at(-1)!.slice().reverse().find(m=>m.role==='tool').content);assert.match(stale.error,/stale_target/);assert.equal(h.backend.pending(),null);
  }finally{await h.stop();}
});
test('later exact confirmation commits once through the native action seam',async()=>{
  const h=harness();try{await h.start();h.queue.push(tool('prepare_desktop_action',{operation:'click',target:'gaze',value:''}),{content:'Confirm Open?'});h.speech('Click this');h.delegate('prepare-once');await settle();const id=h.backend.pending()!.id;h.queue.push(tool('commit_desktop_action',{proposal_id:id}),{content:'Opened.'});h.speech('yes');h.delegate('confirm-once');await settle();assert.equal(h.counts().writes,1);h.queue.push(tool('commit_desktop_action',{proposal_id:id}),{content:'Already completed.'});h.delegate('duplicate');await settle();assert.equal(h.counts().writes,1);}finally{await h.stop();}
});
test('live background note refuses transmission when session policy becomes private or muted',async()=>{
  const h=harness();try{await h.start();h.allow(false);assert.equal(h.live.note('synthetic private label'),false);assert.equal(h.notes.length,0);}finally{await h.stop();}
});
