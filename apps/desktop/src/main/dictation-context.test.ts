import test from 'node:test';
import assert from 'node:assert/strict';
import {createDictationContextService,resolveScopedVoiceTranscript} from './dictation-context.js';
import {createOpenAITextProvider} from '../../../../packages/providers/src/openai-text/index.js';
import {createSecurityKernel} from '../../../../packages/security/src/index.js';
import {createContextAssembler} from '../../../../packages/memory/src/context/index.js';
import type {TimelineItem} from '../../../../packages/memory/src/store/types.js';
import type {DesktopObserveResult} from './desktop-observe.js';

async function setup(options?:{tokenizer?:{count(text:string):number};capacity?:number}) {
 let project = 'p'; let privacy = 0; let clock = Date.parse('2026-10-01T12:00:00Z'); let calls = 0;
 let fetchDelay = false; let aborted = false; let lateRelease: (()=>void) | undefined;
 let text = JSON.stringify({text:'sequel',edits:[]}); let screenCalls=0;
 const requests:Record<string,unknown>[]=[];
 const provider=createOpenAITextProvider({model:()=> 'gpt-6-luna',secrets:{get:async()=> 'fake',put:async()=>{},delete:async()=>{}},fetcher:async(_url,init)=>{calls++;requests.push(JSON.parse(String(init.body)));if(fetchDelay) await new Promise<void>(resolve=>{lateRelease=resolve;init.signal?.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}));}});
 const kernel=createSecurityKernel({storage:{read:async()=>null,write:async()=>{}},secrets:{get:async()=>null,put:async()=>{},delete:async()=>{}},provider,capture:{invoke:async()=>({artifactRef:'unused'})}});
 await kernel.ready();
 let timeline:TimelineItem[]=Array.from({length:12},(_,i)=>({id:String(i),kind:'event',summary:'SQLite '+ 'x'.repeat(500),sourceEventIds:[],occurredAt:new Date(clock-i*1000).toISOString()}));
 let observation: DesktopObserveResult = {outcome:'denied',code:'empty_evidence',detail:null};
 const service=createDictationContextService({activeProjectId:()=>project,privacyGeneration:()=>privacy,model:()=> 'gpt-6-luna',now:()=>clock,timeline:async()=>timeline,observeContext:async()=>{screenCalls++;return observation;},provider:()=>({kernel,provider}),assembler:createContextAssembler({tokenizer:options?.tokenizer??{count:text=>Math.ceil(text.length/4)},imageTokens:()=>0}),modelDescriptor:()=>({modelId:'gpt-6-luna',contextCapacity:options?.capacity??32768})});
 return {service,kernel,requests,delay:()=>{fetchDelay=true;},aborted:()=>aborted,release:()=>lateRelease?.(),calls:()=>calls,screenCalls:()=>screenCalls,setProject:(value:string)=>{project=value;},setPrivacy:()=>{privacy++;},setText:(value:string)=>{text=value;},setTimeline:(value:TimelineItem[])=>{timeline=value;},setObservation:(value:DesktopObserveResult)=>{observation=value;},advance:(ms:number)=>{clock+=ms;}};
}
async function review(h:Awaited<ReturnType<typeof setup>>,raw='sequel',screen=false) {const result=await h.service.handle({command:'preview',projectId:'p',rawTranscript:raw,includeScreen:screen});assert.equal(result.ok,true);assert.ok(result.preview);return result.preview;}

test('preview is local, immutable, bounded to recent eight persistent summaries',async()=>{
 const h=await setup();const preview=await review(h);assert.equal(h.calls(),0);assert.equal(h.screenCalls(),0);assert.equal(preview.evidence.length,8);assert.ok(preview.evidence.every(row=>row.text.length<=400));assert.ok(Object.isFrozen(preview));assert.ok(Object.isFrozen(preview.evidence));
 assert.equal(preview.contextBudget,'exact');
 h.setTimeline([{id:'old',kind:'event',summary:'old',sourceEventIds:[],occurredAt:'2026-09-20T00:00:00Z'}]);assert.equal((await review(h)).evidence.length,0);
});
test('raw transcript bound is 16,384 UTF-8 bytes, not characters',async()=>{
 const h=await setup();
 const multibyte='é'.repeat(9_000); // 18,000 UTF-8 bytes but only 9,000 characters
 assert.equal((await h.service.handle({command:'preview',projectId:'p',rawTranscript:multibyte,includeScreen:false})).error,'invalid_transcript');
 const boundary='é'.repeat(8_192); // exactly 16,384 UTF-8 bytes
 const preview=await review(h,boundary);
 assert.equal(preview.rawText,boundary);assert.equal(preview.rawText.length,8_192);assert.equal(preview.contextBudget,'exact');assert.equal(h.calls(),0);
});
test('capture larger than the display excerpt is retained whole and never dispatched over budget',async()=>{
 const h=await setup({tokenizer:{count:text=>Buffer.byteLength(text,'utf8')},capacity:8192});
 const raw='word '.repeat(1_800).trim(); // 8,999 characters, beyond the 8,192-character coordinator excerpt
 const preview=await review(h,raw);
 assert.equal(preview.rawText,raw);assert.equal(preview.contextBudget,'exceeded');
 const result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});
 assert.equal(result.ok,true);assert.equal(result.rawText,raw);assert.equal(result.fallback,'context_budget');assert.equal(result.correction,undefined);assert.equal(h.calls(),0);
});
test('retained transcripts are rejected after foreign, private, or stale scope changes',async()=>{
 const retained={phase:'final' as const,text:'captured words',observedAt:'2026-10-01T12:00:00Z',projectId:'p',privacy:3,privateActive:false};
 const scope={projectId:'p',privacy:3,privateActive:false};
 assert.deepEqual(resolveScopedVoiceTranscript(retained,scope),{phase:'final',text:'captured words',observedAt:'2026-10-01T12:00:00Z'});
 assert.equal(resolveScopedVoiceTranscript(retained,{...scope,projectId:'other'}),null);
 assert.equal(resolveScopedVoiceTranscript(retained,{...scope,privacy:4}),null);
 assert.equal(resolveScopedVoiceTranscript(retained,{...scope,privateActive:true}),null);
 assert.equal(resolveScopedVoiceTranscript({...retained,privateActive:true},scope),null);
 assert.equal(resolveScopedVoiceTranscript({...retained,projectId:null},scope),null);
 assert.equal(resolveScopedVoiceTranscript(null,scope),null);
});
test('confirmed immutable prompt uses fixed JSON schema, targeted grant and one-shot consumption',async()=>{
 const h=await setup();const preview=await review(h);const result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});assert.equal(result.ok,true);assert.equal(result.correction?.text,'sequel');assert.equal(h.calls(),1);assert.equal(h.requests[0]!.input,preview.prompt);assert.equal(((h.requests[0]!.text as any).format).name,'dictation_correction');
 assert.equal((await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true})).error,'preview_missing');assert.equal(h.calls(),1);
});
test('privacy changes, cancellation, expiry and foreign projects cannot send',async()=>{
 for(const mutate of ['privacy','cancel','expiry','project']) {const h=await setup();const preview=await review(h);if(mutate==='privacy')h.setPrivacy();if(mutate==='project')h.setProject('other');if(mutate==='expiry')h.advance(60001);if(mutate==='cancel')h.service.clear();const result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});assert.equal(result.ok,false);assert.equal(h.calls(),0);}
});
test('malformed JSON and protected token edit preserve committed raw transcript',async()=>{
 const h=await setup();h.setText('{broken');let preview=await review(h);let result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});assert.equal(result.correction?.text,'sequel');assert.equal(result.correction?.fallback,'reasoner_error');
 h.setText(JSON.stringify({text:'use 43',edits:[{start:4,end:6,original:'42',replacement:'43',basis:'evidence',acousticReason:null,confidence:1}]}));preview=await review(h,'use 42');result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});assert.equal(result.correction?.text,'use 42');assert.equal(result.correction?.gates.harmfulEditsApplied,0);assert.equal(result.correction?.unresolvedSpans[0]!.reason,'protected_token');
});
test('screen evidence is opt-in, omits secure/redacted nodes and bounds rows',async()=>{
 const h=await setup();h.setTimeline([]);h.setObservation({outcome:'observed',evidence:{kind:'desktop_observe',projectId:'p',observedAtMs:0,application:{pid:1,bundleId:'test',name:'Test',bundleIdTruncated:false,nameTruncated:false},window:{role:'window',title:'',roleTruncated:false,titleTruncated:false},nodes:Array.from({length:20},(_,i)=>({depth:0,role:'AXTextArea',subrole:i===0?'AXSecureTextField':null,label:null,value:'x'.repeat(500),redacted:i===1,labelTruncated:false,valueTruncated:false,roleTruncated:false,subroleTruncated:false})),quality:'full',truncated:false,truncations:[],stats:{visitedNodes:20,emittedNodes:20,maxDepthReached:0,estimatedBytes:0}}});
 const preview=await review(h,'sequel',true);assert.equal(h.screenCalls(),1);assert.equal(preview.evidence.length,12);assert.ok(preview.evidence.every(row=>row.text.length<=200&&row.source==='screen'));assert.equal(h.calls(),0);
});
test('scope cancellation while grant persistence awaits revokes grant before dispatch',async()=>{
 const h=await setup();const preview=await review(h);const original=h.kernel.grantCapability.bind(h.kernel);let release!:()=>void;let created!:()=>void;
 const entered=new Promise<void>(resolve=>{created=resolve;}); const delayed=new Promise<void>(resolve=>{release=resolve;});
 let revoked=0;const revoke=h.kernel.revokeCapability.bind(h.kernel);h.kernel.revokeCapability=async input=>{revoked++;return revoke(input);};
 h.kernel.grantCapability=async input=>{const grant=await original(input);created();await delayed;return grant;};
 const result=h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});await entered;h.setPrivacy();release();const completed=await result;assert.equal(completed.ok,false);assert.equal(completed.rawText,'sequel');assert.equal(h.calls(),0);assert.equal(revoked,1);
});
test('over-budget provider correction returns raw text and drops edits',async()=>{
 const h=await setup();h.setText(JSON.stringify({text:'SQLite',edits:[{start:0,end:6,original:'sequel',replacement:'SQLite',basis:'evidence',acousticReason:null,confidence:1}]}));
 const preview=await review(h);const targeted=h.kernel.runTargeted.bind(h.kernel);h.kernel.runTargeted=async id=>{const response=await targeted(id);h.advance(3001);return response;};
 const result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});assert.equal(result.ok,true);assert.equal(result.correction?.text,'sequel');assert.equal(result.fallback,'latency_budget');assert.equal(result.correction?.edits.length,0);
});

test('actual scoped kernel/provider applies evidence-backed identifier and retains reviewed proof',async()=>{
 const h=await setup();h.setText(JSON.stringify({text:'use SQLite',edits:[{start:4,end:10,original:'sequel',replacement:'SQLite',basis:'evidence',acousticReason:null,confidence:0.95}]}));
 const preview=await review(h,'use sequel');const result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});
 assert.equal(result.ok,true);assert.equal(result.correction?.text,'use SQLite');assert.equal(h.calls(),1);assert.equal(h.requests[0]!.input,preview.prompt);
 assert.equal(result.correction?.edits.length,1);assert.ok(result.correction?.edits[0]!.evidenceIds.length);
 assert.ok(result.correction?.edits[0]!.evidenceIds.every(id=>preview.evidence.some(row=>row.id===id&&row.text.includes('SQLite'))));
 assert.ok(preview.evidence.length<=8&&preview.evidence.every(row=>row.text.length<=400));assert.equal(result.correction?.gates.harmfulEditsApplied,0);assert.equal(result.correction?.fallback,'none');
});
test('hard three-second deadline aborts outstanding provider and revokes grant without accepting late output',async()=>{
 const h=await setup();h.delay();const preview=await review(h);let revoked=0;const revoke=h.kernel.revokeCapability.bind(h.kernel);h.kernel.revokeCapability=async input=>{revoked++;return revoke(input);};
 const started=performance.now();const result=await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true});const elapsed=performance.now()-started;
 assert.equal(result.ok,true);assert.equal(result.rawText,'sequel');assert.equal(result.fallback,'latency_budget');assert.ok(elapsed>=2900&&elapsed<4500,`deadline returned in ${elapsed}ms`);assert.equal(h.aborted(),true);assert.equal(revoked,1);
 h.release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await h.service.handle({command:'confirm',projectId:'p',previewId:preview.previewId,confirmed:true})).error,'preview_missing');
});
