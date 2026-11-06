import {test} from 'node:test';import assert from 'node:assert/strict';import {createAgentBackend} from './agent-backend';
const call=(name:string,args:unknown,id='call')=>({content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
function fixture(overrides:Record<string,unknown>={}){let revision=1;let offset=20;let user='';let executed=0;let prepared=0;let researched=0;let observed=0;const messages:any[][]=[];const replies:any[]=[];
 const backend=createAgentBackend({config:()=>({provider:'openrouter',textModel:'test',speechModel:'test'}),cloud:{agentStep:async(_config:any,history:any)=>{messages.push(structuredClone(history));return replies.shift()??{content:'Done'};}} as any,knowledge:{retained:()=>[{brief:'SQLite for offline use.'}],catalog:async()=>[],research:async()=>{researched++;return {brief:'Known',source_refs:['s:L1']};}} as any,screen:async()=>{observed++;return {text:'screen',image:'data:image/jpeg;base64,AAAA'};},prepare:async()=>{prepared++;return {label:'Set name to Atlas',execute:async()=>{executed++;}};},revision:()=>revision,inputOffset:()=>offset,userTextAfter:()=>user,contextNote(){},...overrides});
 return {backend,replies,messages,counts:()=>({executed,prepared,researched,observed}),user(text:string){user=text;revision++;offset++;},run:()=>backend.run({conversation:'user: question',revision,signal:new AbortController().signal})};
}
test('backend answers from retained context without mandatory session or screen lookup',async()=>{const f=fixture();f.replies.push({content:'SQLite supports offline access.'});assert.match(await f.run(),/offline/);assert.deepEqual(f.counts(),{executed:0,prepared:0,researched:0,observed:0});assert.match(f.messages[0]![1].content,/SQLite/);});
test('desktop action requires later exact spoken confirmation and cannot execute twice',async()=>{const f=fixture();f.replies.push(call('prepare_desktop_action',{operation:'set_value',target:'focused',value:'Atlas'}),{content:'Confirm name change?'});await f.run();const id=f.backend.pending()!.id;
 f.replies.push(call('commit_desktop_action',{proposal_id:id}),{content:'Confirmation needed'});await f.run();assert.equal(f.counts().executed,0);
 f.user('confirm');f.replies.push(call('commit_desktop_action',{proposal_id:id}),{content:'Changed'});await f.run();assert.equal(f.counts().executed,1);
 f.replies.push(call('commit_desktop_action',{proposal_id:id}),{content:'No pending action'});await f.run();assert.equal(f.counts().executed,1);
});
test('unrelated later speech is not an action confirmation',async()=>{const f=fixture();f.replies.push(call('prepare_desktop_action',{operation:'click',target:'gaze',value:''}),{content:'Confirm?'});await f.run();const id=f.backend.pending()!.id;f.user('yes but use a different name');f.replies.push(call('commit_desktop_action',{proposal_id:id}),{content:'Please clarify'});await f.run();assert.equal(f.counts().executed,0);});
test('screenshot evidence follows all tool responses in the backend message sequence',async()=>{const f=fixture();f.replies.push(call('observe_screen',{}),{content:'The screen shows a title'});await f.run();const history=f.messages[1]!;assert.deepEqual(history.map(m=>m.role),['system','user','assistant','tool','user']);assert.equal(history[4].content[1].type,'image_url');});
test('new input while backend waits prevents stale desktop actions',async()=>{let finish!:(answer:any)=>void;let prepares=0;let revision=0;const backend=createAgentBackend({config:()=>({provider:'openrouter',textModel:'test',speechModel:'test'}),cloud:{agentStep:()=>new Promise(resolve=>finish=resolve)} as any,knowledge:{retained:()=>[]} as any,screen:async()=>({text:''}),prepare:async()=>{prepares++;return {label:'edit',execute:async()=>{}};},revision:()=>revision,inputOffset:()=>0,userTextAfter:()=>'',contextNote(){}});const running=backend.run({conversation:'click',revision:0,signal:new AbortController().signal});revision++;finish(call('prepare_desktop_action',{operation:'click',target:'focused',value:''}));await assert.rejects(running,/changed/);assert.equal(prepares,0);});
test('conversation recall tools return dated local evidence without screen capture',async()=>{
 const f=fixture({history:()=>[{id:'v1',at:'2026-11-01',mode:'agent',text:'Use Tailscale',result:'Avoid public ports'}]});
 f.replies.push(call('search_conversations',{query:'Tailscale'}),{content:'We chose private access.'});await f.run();
 const result=f.messages[1]!.find(message=>message.role==='tool');assert.match(result.content,/2026-11-01/);assert.match(result.content,/Tailscale/);assert.equal(f.counts().observed,0);
});
test('clipboard copy is bounded and reports only after the actual copy callback completes',async()=>{
 const copied:string[]=[];const f=fixture({copyText:async(text:string)=>{copied.push(text);}});
 f.replies.push(call('copy_to_clipboard',{text:'A useful handoff'}),{content:'Copied.'});await f.run();assert.deepEqual(copied,['A useful handoff']);
 f.replies.push(call('copy_to_clipboard',{text:'x'.repeat(12001)},'oversized'),{content:'Too long.'});await f.run();assert.equal(copied.length,1);
});
test('continuing a known session uses its verified agent and returns the task receipt',async()=>{
 const starts:any[]=[];const f=fixture({knowledge:{retained:()=>[],catalog:async()=>[{sessionId:'s1',agent:'Claude',title:'Remote access'}]},tasks:{list:()=>[],start:async(input:any)=>{starts.push(input);return {id:'task1',status:'starting'};}}});
 f.replies.push(call('continue_session',{session_id:'s1',instruction:'Add the requested check'}),{content:'Started a fork.'});await f.run();assert.equal(starts[0].agent,'Claude');assert.equal(starts[0].sessionId,'s1');assert.match(f.messages[1]!.find(message=>message.role==='tool').content,/task1/);
});
