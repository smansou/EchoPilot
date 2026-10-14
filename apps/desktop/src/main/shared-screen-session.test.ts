import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSharedScreenSession} from './shared-screen-session';
import type {AttentionResult} from './shared-attention';
import type {DesktopObserveResult,ForegroundEvidence} from './desktop-observe';
import type {GazeSample} from '../../../../packages/gaze/src';
function harness(secondParagraph=false) {
  let clock=1000,allowed=true,voice:string|null=null,pending:Promise<DesktopObserveResult>|null=null;
  let samples:GazeSample[]=[],highlights:AttentionResult[]=[],sent:string[]=[];
  const evidence=():ForegroundEvidence=>({kind:'desktop_observe',observedAtMs:clock,projectId:'p',application:{pid:42,bundleId:'app.reader',name:'Reader',bundleIdTruncated:false,nameTruncated:false},window:{id:'w1',role:'AXWindow',roleTruncated:false,title:'Document',titleTruncated:false,frame:{x:0,y:0,width:800,height:600}},nodes:[{depth:1,role:'AXStaticText',subrole:null,label:'One paragraph',value:null,frame:{x:100,y:100,width:500,height:250},labelTruncated:false,valueTruncated:false,redacted:false,roleTruncated:false,subroleTruncated:false}],quality:'full',truncated:false,truncations:[],stats:{visitedNodes:1,emittedNodes:1,maxDepthReached:1,estimatedBytes:1000}});
  const sample=(at=clock):GazeSample=>({timestamp:new Date(at).toISOString(),displayId:'d',meanX:350,meanY:225,covariance2x2:[[40**2,0],[0,40**2]],quality:.9,calibrationGeneration:1,displayTransform:{displayId:'d',originX:0,originY:0,width:800,height:600,scale:1,arrangementGeneration:1}});
  const session=createSharedScreenSession({allowed:()=>allowed,samples:()=>samples,observe:()=>{const value=evidence();const expanded=secondParagraph?{...value,nodes:[...value.nodes,{...value.nodes[0]!,label:'Second paragraph',frame:{x:100,y:400,width:500,height:160}}]}:value;return pending??Promise.resolve({outcome:'observed',evidence:expanded});},voiceSession:()=>voice,send:text=>{sent.push(text);return true;},highlight:result=>{highlights.push(result);},now:()=>clock});
  return {session,highlights,sent,evidence,clock:()=>clock,time(at:number){clock=at;},gaze(at=clock,quality=.9,x=350,y=225){samples=[{...sample(at),quality,meanX:x,meanY:y}];},loseGaze(){samples=[];},allow(value:boolean){allowed=value;},voice(value:string|null){voice=value;},defer(p:Promise<DesktopObserveResult>){pending=p;},async ready(){samples=[sample()];session.enable(true);await Promise.resolve();await Promise.resolve();for(let at=1100;at<=1400;at+=100){clock=at;samples=[sample()];session.tick();await Promise.resolve();}assert.ok(session.target());}};
}
test('local highlights work with no voice sender; permission loss clears targets and context',async()=>{
  const h=harness();try{await h.ready();assert.equal(h.sent.length,0);assert.equal(h.highlights.at(-1)?.target?.label,'One paragraph');h.session.pin('this paragraph');assert.ok(h.session.context()?.referent?.target);h.allow(false);h.session.tick();assert.equal(h.session.target(),null);assert.equal(h.session.context(),null);assert.equal(h.highlights.at(-1)?.target,null);}finally{h.session.dispose();}
});
test('gaze loss invalidates chosen and pinned references instead of preserving a convenient stale target',async()=>{
  const h=harness();try{await h.ready();const target=h.session.target()!;h.session.choose(target.id);h.loseGaze();h.session.tick();assert.equal(h.session.target(),null);assert.equal(h.session.context()?.screen.targetId??null,null);assert.equal(h.highlights.at(-1)?.target,null);}finally{h.session.dispose();}
});
test('scene freshness beyond 1.2s invalidates manual choice and semantic snapshot despite ongoing gaze',async()=>{
  const h=harness();try{await h.ready();const id=h.session.target()!.id;h.session.choose(id);h.defer(new Promise(()=>{}));h.time(2301);h.gaze();h.session.tick();assert.equal(h.session.target(),null);assert.equal(h.highlights.at(-1)?.target,null);assert.equal(h.session.context()?.screen.targetId??null,null);}finally{h.session.dispose();}
});
test('future-dated gaze cannot validate an earlier pinned reference',async()=>{
  const h=harness();try{await h.ready();h.session.pin('this');h.time(1500);h.gaze(9000);h.session.tick();assert.equal(h.session.target(),null);assert.equal(h.session.context()?.referent?.target,null);}finally{h.session.dispose();}
});
test('late observation completion cannot resurrect disabled session state',async()=>{
  const h=harness();let finish!:(value:DesktopObserveResult)=>void;const pending=new Promise<DesktopObserveResult>(resolve=>{finish=resolve;});h.defer(pending);h.gaze();h.session.enable(true);h.session.enable(false);finish({outcome:'observed',evidence:h.evidence()});await Promise.resolve();await Promise.resolve();assert.equal(h.session.status().enabled,false);assert.equal(h.session.target(),null);assert.equal(h.session.status().regions,0);h.session.dispose();
});
test('explicit local choice stays the referent when a subsequent transcript pins this',async()=>{
  const h=harness();try{await h.ready();const root=h.session.context()?.screen.regions.find(r=>r.kind==='window');assert.ok(root);h.session.choose(root.id);assert.equal(h.session.target()?.id,root.id);h.session.pin('this one');assert.equal(h.session.target()?.id,root.id);assert.equal(h.session.context()?.referent?.target?.id,root.id);}finally{h.session.dispose();}
});
test('fake in-memory live sink observes bounded semantic changes without screenshots',async()=>{
  const h=harness();try{h.voice('fake-memory-only');await h.ready();for(let at=1500;at<=3500;at+=100){h.time(at);h.gaze();h.session.tick();await Promise.resolve();}const packets=h.sent.map(s=>JSON.parse(s)).filter(s=>s.sharedScreen?.sequence);assert.ok(packets.length>0);assert.ok(packets.length<=4);for(const packet of packets){assert.ok(Buffer.byteLength(JSON.stringify(packet.sharedScreen))<=1200);assert.doesNotMatch(JSON.stringify(packet),/imageData|base64|covariance|meanX/);}assert.ok(h.session.status().bytesInLastMinute<=8000);}finally{h.session.dispose();}
});
test('repeated private ticks invalidate remote-memory context once and clear the local overlay',async()=>{
  const h=harness();try{h.voice('fake-memory-only');await h.ready();h.allow(false);for(let at=1500;at<=2000;at+=100){h.time(at);h.session.tick();}const invalidations=h.sent.map(s=>JSON.parse(s)).filter(s=>s.sharedScreen?.reason==='Screen sharing paused while private or muted');assert.equal(invalidations.length,1);assert.equal(h.highlights.at(-1)?.target,null);assert.equal(h.session.context(),null);}finally{h.session.dispose();}
});
test('fresh but unusable gaze cannot preserve an earlier stable pinned target',async()=>{
  const h=harness();try{await h.ready();h.session.pin('this');h.time(1500);h.gaze(1500,.1);h.session.tick();assert.equal(h.session.target(),null);assert.equal(h.session.context()?.referent?.target??null,null);}finally{h.session.dispose();}
});
test('references from before tracking loss do not reappear as previous after gaze resumes',async()=>{
  const h=harness(true);try{await h.ready();for(let at=1500;at<=1900;at+=100){h.time(at);h.gaze(at,.9,350,480);h.session.tick();await Promise.resolve();}assert.equal(h.session.target()?.label,'Second paragraph');h.time(2000);h.loseGaze();h.session.tick();for(let at=2100;at<=2600;at+=100){h.time(at);h.gaze(at,.9,350,480);h.session.tick();await Promise.resolve();}assert.equal(h.session.target()?.label,'Second paragraph');h.session.pin('previous');assert.equal(h.session.target(),null);assert.equal(h.session.context()?.referent?.target??null,null);}finally{h.session.dispose();}
});
