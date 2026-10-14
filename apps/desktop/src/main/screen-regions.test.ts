import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenRegions} from './screen-regions';
import type {ForegroundEvidence,ForegroundEvidenceNode} from './desktop-observe';
const node=(changes:Partial<ForegroundEvidenceNode>={}):ForegroundEvidenceNode=>({depth:1,role:'AXStaticText',subrole:null,label:'Paragraph',value:null,frame:{x:100,y:100,width:300,height:160},labelTruncated:false,valueTruncated:false,redacted:false,roleTruncated:false,subroleTruncated:false,...changes});
const evidence=(nodes:ForegroundEvidenceNode[]):ForegroundEvidence=>({kind:'desktop_observe',observedAtMs:1000,projectId:'p',application:{pid:42,bundleId:'app.reader',name:'Reader',bundleIdTruncated:false,nameTruncated:false},window:{id:'w1',role:'AXWindow',roleTruncated:false,title:'Document',titleTruncated:false,frame:{x:0,y:0,width:800,height:600}},nodes,quality:'full',truncated:false,truncations:[],stats:{visitedNodes:nodes.length,emittedNodes:nodes.length,maxDepthReached:3,estimatedBytes:1000}});
test('mapper uses real clipped geometry, preserves paragraphs/sentences and stable independent revisions',()=>{
  const first=evidence([node({frame:{x:-20,y:100,width:320,height:160},textRegions:[{kind:'sentence',text:'Sentence one.',frame:{x:10,y:120,width:250,height:20},rangeStart:0,rangeLength:13}]}),node({label:'Clock 12:00',frame:{x:700,y:0,width:90,height:40}})]);
  const before=screenRegions(first);assert.equal(before.regions[1]?.bounds.x,0);assert.equal(before.regions[1]?.bounds.width,300);
  assert.equal(before.regions[2]?.type,'sentence');assert.equal(before.regions[2]?.parentId,before.regions[1]?.id);
  const after=screenRegions({...first,nodes:[first.nodes[0]!,node({label:'Clock 12:01',frame:{x:700,y:0,width:90,height:40}})]});
  assert.equal(before.regions[1]?.id,after.regions[1]?.id);assert.equal(before.regions[1]?.revision,after.regions[1]?.revision);assert.notEqual(before.revision,after.revision);
});
test('mapper never invents boxes and excludes secure parents plus their descendants',()=>{
  const mapped=screenRegions(evidence([node({frame:undefined} as unknown as Partial<ForegroundEvidenceNode>),node({depth:1,role:'AXSecureTextField',label:'Password',redacted:true}),node({depth:2,label:'Secret descendant'}),node({depth:1,label:'Public paragraph'})]));
  assert.equal(mapped.regions.length,2);assert.equal(mapped.regions[1]?.label,'Public paragraph');assert.doesNotMatch(JSON.stringify(mapped),/Password|Secret descendant/);
});
test('mapper disambiguates duplicate labels and invalidates scope when window identity changes',()=>{
  const original=evidence([node({label:'Open'}),node({label:'Open',frame:{x:450,y:100,width:100,height:80}})]);
  const a=screenRegions(original),b=screenRegions({...original,window:{...original.window,id:'w2'}});
  assert.notEqual(a.regions[1]?.id,a.regions[2]?.id);assert.notEqual(a.scope,b.scope);assert.notEqual(a.regions[1]?.id,b.regions[1]?.id);
});
