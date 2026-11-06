import {test} from 'node:test';import assert from 'node:assert/strict';import {createLiveSession} from './live-session';import type {LiveEvent,LiveConnectOptions} from './live-types';
const wait=()=>new Promise(r=>setTimeout(r,360));
function fixture(overrides:Record<string,unknown>={}){let receive!:(event:LiveEvent)=>void;const results:any[]=[];const calls:any[]=[];const history:any[]=[];let closeCount=0;let observed:LiveConnectOptions|undefined;
 const live=createLiveSession({preferences:()=>({provider:'gemini',voice:'Kore'}),key:async()=> 'test',allowed:()=>true,knowledge:{catalog:async()=>[{sessionId:'a',agent:'Codex',project:'Atlas',updatedAt:'2026-10-03',title:'Atlas session'}],retained:()=>[{sessionId:'a',project:'Atlas',version:'1',updatedAt:'2026-10-03',coverage:'saved evidence',brief:'Known context',source_refs:['a:L1'],uncertainties:[]}],changed:async()=>[]} as any,backend:async request=>{calls.push(request);return 'A sourced answer';},clearBackend(){},history:()=>[],remember:async item=>{history.push(item);},changed(){},media(){},connect:async(_provider,options)=>{observed=options;receive=options.onEvent;return {context(){},result:(...args)=>results.push(args),close:async()=>{closeCount++;return true;},audio(){}};},...overrides});
 return {live,results,calls,history,send:(event:LiveEvent)=>receive(event),observed:()=>observed,closes:()=>closeCount,async start(){await live.start();await live.join(live.status().id!);live.ready(live.status().id!);}};
}
const speech=(text:string,start=0):LiveEvent=>({type:'transcript',speaker:'user',text,startMs:start,endMs:start+10});
test('microphone permission errors explain the fix and can be dismissed back to idle',async()=>{
 const f=fixture();await f.start();f.live.error(f.live.status().id!,'NotAllowedError');
 await new Promise(r=>setImmediate(r));assert.equal(f.live.status().phase,'error');
 assert.match(f.live.status().message,/System Settings.*Microphone/);assert.equal(f.live.status().recording,false);
 await f.live.stop();assert.equal(f.live.status().phase,'idle');assert.equal(f.live.status().message,'');
});
test('continuous conversation retains evidence and delegates only when the voice model asks',async()=>{const f=fixture();try{await f.start();assert.equal(f.live.status().transport,'pcm');assert.match(f.observed()!.context,/Known context/);f.send(speech('Why SQLite?'));await wait();assert.equal(f.calls.length,0);f.send({type:'delegation',id:'d',offsetMs:10,task:'Explain decision'});await wait();assert.equal(f.calls.length,1);assert.equal(f.results[0][2],true);assert.match(f.calls[0].conversation,/Why SQLite/);}finally{await f.live.stop();}assert.equal(f.closes(),1);assert.equal(f.history.length,1);assert.equal(f.history[0].turns[0].speaker,'user');});
test('metadata-only delegation waits for delayed transcript instead of inventing a task',async()=>{const f=fixture();try{await f.start();f.send({type:'delegation',id:'d',offsetMs:10});await wait();assert.equal(f.calls.length,0);f.send(speech('Find '));f.send(speech('Atlas',11));await wait();assert.equal(f.calls.length,1);assert.match(f.calls[0].conversation,/Find Atlas/);}finally{await f.live.stop();}});
test('late backend result is quiet after the user changes the request',async()=>{let finish!:(text:string)=>void;const f=fixture({backend:()=>new Promise<string>(resolve=>finish=resolve)});try{await f.start();f.send(speech('Research Atlas'));f.send({type:'delegation',id:'d',offsetMs:10});await wait();f.send(speech('Actually never mind',20));finish('Old answer');await wait();assert.equal(f.results[0][2],false);}finally{await f.live.stop();}});
test('stop waits for provider finalization and keeps the media session identity until then',async()=>{let finish!:(ok:boolean)=>void;const f=fixture({connect:async()=>({context(){},result(){},close:()=>new Promise<boolean>(resolve=>finish=resolve)})});await f.start();const id=f.live.status().id;const stopping=f.live.stop();assert.equal(f.live.status().phase,'closing');assert.equal(f.live.status().recording,false);assert.equal(f.live.status().id,id);f.live.error(id!);finish(true);await stopping;assert.equal(f.live.status().id,null);assert.equal(f.live.status().finalized,true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.live.status().phase,'idle');});
test('missing provider key reports the selected provider and never opens a connection',async()=>{const f=fixture({key:async()=>null});await f.live.start();await assert.rejects(f.live.join(f.live.status().id!),/Gemini key/);assert.equal(f.live.status().phase,'error');assert.equal(f.observed(),undefined);});
test('silence disconnects live audio at the configured timeout and preserves history for resumption',async()=>{let time=0;const f=fixture({now:()=>time,preferences:()=>({provider:'gemini',voice:'Kore',idleTimeoutSeconds:60})});await f.start();f.send(speech('Keep the migration in mind'));time=59999;await f.live.checkIdle();assert.ok(f.live.active());time=60001;await f.live.checkIdle();assert.equal(f.live.status().asleep,true);assert.equal(f.live.active(),false);assert.equal(f.history.length,1);assert.match(f.history[0].text,/migration/);});
test('never-sleep preference and pending backend work prevent inactivity teardown',async()=>{let time=0;const f=fixture({now:()=>time,preferences:()=>({provider:'gemini',voice:'Kore',idleTimeoutSeconds:0})});try{await f.start();time=900000;await f.live.checkIdle();assert.equal(f.live.active(),true);}finally{await f.live.stop();}});
test('explicit fragmented hangup works locally without backend latency; quoted and negative speech do not',async()=>{const f=fixture();try{await f.start();f.send(speech("Don't hang up",0));await new Promise(r=>setTimeout(r,750));assert.equal(f.live.active(),true);f.send({type:'transcript',speaker:'assistant',text:'Okay',startMs:1000,endMs:1100});f.send(speech("That's all, ",2000));f.send(speech('hang up',2020));await new Promise(r=>setTimeout(r,750));assert.equal(f.live.active(),false);assert.equal(f.calls.length,0);}finally{await f.live.stop();}});
test('question-time evidence is prefetched locally once per source, without mandatory cloud research',async()=>{let pushes=0;let receive!:(event:LiveEvent)=>void;const f=fixture({knowledge:{catalog:async()=>[],retained:()=>[],changed:async()=>[],search:()=>[{ref:'s:L5',text:'Decision: SQLite handles offline search'}]} as any,connect:async(_provider:any,options:LiveConnectOptions)=>{receive=options.onEvent;return {context(){pushes++;},result(){},close:async()=>true};}});try{await f.start();receive(speech('Why did we choose SQLite?'));await wait();assert.equal(pushes,1);receive(speech(' And why does it work offline?',20));await wait();assert.equal(pushes,1);assert.equal(f.calls.length,0);}finally{await f.live.stop();}});
test('named sessions hydrate deeper evidence quietly and discard results after a topic change',async()=>{
 let finish!:(value:any)=>void;const packets:string[]=[];let queries=0;
 const session={agent:'Codex',sessionId:'network',title:'Remote access via Tailscale',project:'/work/network',updatedAt:'v1'};
 const f=fixture({knowledge:{peek:()=>[session],catalog:async()=>[session],retained:()=>[],search:()=>[],evidence:async()=>{queries++;return new Promise(resolve=>finish=resolve);}},connect:async(_provider:any,options:LiveConnectOptions)=>{(f as any).receive=options.onEvent;return {context:(text:string)=>packets.push(text),result(){},close:async()=>true};}});
 try{
  await f.start();(f as any).receive(speech('What did we decide about Tailscale?'));await wait();assert.equal(queries,1);
  (f as any).receive({type:'transcript',speaker:'assistant',text:'',startMs:100,endMs:150});
  (f as any).receive(speech('Now explain the audio settings',200));
  finish({sources:[{ref:'network:1',text:'OLD TOPIC evidence'}],coverage:'Saved records'});await wait();
  assert.ok(!packets.some(packet=>packet.includes('OLD TOPIC')));assert.equal(f.calls.length,0);
 }finally{await f.live.stop();}
});
test('updated evidence at the same source reference is supplied again',async()=>{
 let text='Original decision';const packets:string[]=[];let receive!:(event:LiveEvent)=>void;
 const f=fixture({knowledge:{catalog:async()=>[],retained:()=>[],search:()=>[{ref:'s:1',text}]},connect:async(_provider:any,options:LiveConnectOptions)=>{receive=options.onEvent;return {context:(packet:string)=>packets.push(packet),result(){},close:async()=>true};}});
 try{await f.start();receive(speech('Explain this decision'));await wait();text='Corrected decision';receive(speech(' again',20));await wait();assert.equal(packets.length,2);assert.match(packets[1]!,/Corrected decision/);}finally{await f.live.stop();}
});
test('long voice dialogue archives older chapters without dropping streamed words',async()=>{
 const f=fixture();const words=Array.from({length:165},(_,i)=>`phrase${i} `);
 await f.start();words.forEach((text,index)=>f.send(speech(text,index*20)));await f.live.stop();
 assert.ok(f.history.length>=2);assert.equal(f.history.map(chapter=>chapter.text).join(''),words.join(''));
});
test('OpenAI background context can continue beyond the old cumulative reconnect threshold',async()=>{
 let time=0;const f=fixture({now:()=>time,preferences:()=>({provider:'openai',voice:'marin',idleTimeoutSeconds:0})});
 try{await f.start();const id=f.live.status().id;for(let i=0;i<30;i++){time+=60001;assert.equal(f.live.note('Relevant evidence '.repeat(500)),true);}assert.equal(f.live.status().id,id);assert.equal(f.closes(),0);}finally{await f.live.stop();}
});
