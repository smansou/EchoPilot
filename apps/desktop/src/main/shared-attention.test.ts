import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SharedAttentionTracker,type ScreenRegion,type GazeDistribution} from './shared-attention';
const scene:ScreenRegion[]=[
  {id:'area',revision:'1',app:'Editor',window:'document',type:'region',label:'Document',bounds:{x:0,y:0,width:600,height:400}},
  {id:'a',parentId:'area',revision:'1',app:'Editor',window:'document',type:'button',label:'Open',bounds:{x:100,y:100,width:80,height:60}},
  {id:'b',parentId:'area',revision:'1',app:'Editor',window:'document',type:'button',label:'Save',bounds:{x:185,y:100,width:80,height:60}},
];
const gaze=(at:number,x=140,y=130,sigma=6):GazeDistribution=>({capturedAt:at,mean:{x,y},covariance:{xx:sigma*sigma,xy:0,yy:sigma*sigma},quality:.9});
function sample(t:SharedAttentionTracker,at:number,x=140,sigma=6) {t.observe(scene,at,at);return t.update(gaze(at,x,130,sigma),at);}
test('large uncertainty selects a region; fine distinct evidence waits for sustained dwell',()=>{
  const t=new SharedAttentionTracker();
  for(let at=0;at<=400;at+=100)sample(t,at,140,60);
  assert.equal(t.current(400).target?.id,'area');
  for(let at=500;at<=1000;at+=100)sample(t,at);
  assert.equal(t.current(1000).target?.id,'area');
  for(let at=1100;at<=1200;at+=100)sample(t,at);
  assert.equal(t.current(1200).target?.id,'a');
});
test('adjacent boundary drift holds a coarse area and never flickers fine targets',()=>{
  const t=new SharedAttentionTracker();
  for(let at=0;at<=400;at+=100)sample(t,at,182+(at%200?7:-7),45);
  assert.equal(t.current(400).target?.id,'area');
  for(let at=500;at<=2000;at+=100)sample(t,at,at%200?175:195,20);
  assert.equal(t.current(2000).target?.id,'area');
});
test('repeated samples and long gaps cannot create fixation; stale gaze invalidates current',()=>{
  const t=new SharedAttentionTracker();sample(t,0);
  t.observe(scene,700,700);t.update(gaze(0),700);
  assert.equal(t.current(700).target,null);
  sample(t,800);sample(t,900);sample(t,1000);
  assert.equal(t.current(1000).target,null);
  for(let at=1100;at<=1500;at+=100)sample(t,at);
  assert.equal(t.current(1500).target?.id,'a');
  assert.equal(t.current(3000).target,null);
});
test('revision and window geometry changes invalidate target and correction history',()=>{
  const t=new SharedAttentionTracker();for(let at=0;at<=700;at+=100)sample(t,at);
  for(let at=800;at<=1500;at+=100)sample(t,at,225);
  const correction=t.resolve('correction',1500);
  assert.equal(correction.target?.id,'b');assert.equal(correction.previous?.id,'a');assert.equal(correction.authorization,false);
  t.observe(scene.map(r=>({...r,revision:'2',window:'new-window'})),1600,1600);
  assert.equal(t.resolve('previous',1600).target,null);
  assert.equal(t.current(1600).target,null);
});
test('invalid covariance, poor quality, private regions and out-of-order scenes are safe',()=>{
  const t=new SharedAttentionTracker();t.observe(scene.map(r=>({...r,sensitive:true})),0,0);
  assert.equal(t.update(gaze(0),0).target,null);
  t.observe(scene,100,100);assert.equal(t.update({...gaze(100),covariance:{xx:1,xy:5,yy:1}},100).state,'unavailable');
  assert.equal(t.update({...gaze(200),quality:.1},200).state,'unavailable');
  t.observe([],0,300);for(let at=300;at<=1000;at+=100)sample(t,at);
  assert.equal(t.current(1000).target?.id,'a');
});
