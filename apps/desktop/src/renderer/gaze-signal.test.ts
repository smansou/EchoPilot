import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGazeSignal,eyesOpen,screenPoint} from './gaze-signal';

test('isolated eye-patch spikes do not move a fixation',()=>{
  const filter=createGazeSignal();
  for(let t=0;t<=1000;t+=50){const p=filter.push({x:t===500?1800:300,y:t===500?-800:400},t);if(p)assert.deepEqual(p,{x:300,y:400});}
});
test('sustained movements reach all edges without overshoot at variable camera rates',()=>{
  for(const interval of [33,67,100]){
    const filter=createGazeSignal();for(let t=0;t<1000;t+=interval)filter.push({x:100,y:100},t);
    let last={x:100,y:100};
    for(let t=1100;t<=1500;t+=interval){const p=filter.push({x:1500,y:900},t);if(p){assert.ok(p.x>=last.x&&p.x<=1500);assert.ok(p.y>=last.y&&p.y<=900);last=p;}}
    assert.ok(last.x>1490&&last.y>890,JSON.stringify({interval,last}));
  }
});
test('loss and reacquisition discard old motion; duplicate and invalid observations cannot advance it',()=>{
  const filter=createGazeSignal();for(let t=0;t<=200;t+=50)filter.push({x:100,y:100},t);
  assert.equal(filter.push({x:900,y:900},200),null);
  assert.equal(filter.push({x:NaN,y:900},250),null);
  assert.equal(filter.push({x:900,y:900},1000),null);
  assert.equal(filter.push({x:900,y:900},1050),null);
  assert.deepEqual(filter.push({x:900,y:900},1100),{x:900,y:900});
});
test('closed, malformed and missing eyes cannot train or move gaze',()=>{
  const face=Array.from({length:468},()=>[0,0,0]);
  for(const [a,b] of [[33,133],[362,263]]){face[a!]=[0,0,0];face[b!]=[20,0,0];}
  for(const i of [159,158,386,385])face[i]=[10,-3,0];
  for(const i of [145,153,374,380])face[i]=[10,3,0];
  assert.equal(eyesOpen(face),true);
  assert.equal(eyesOpen(face.map(p=>[p[0]!*2,p[1]!*2,0])),true);
  for(const i of [145,153,374,380])face[i]=[10,-2,0];
  assert.equal(eyesOpen(face),false);assert.equal(eyesOpen(null),false);assert.equal(eyesOpen([]),false);
});
test('edge extrapolation saturates in global display coordinates including negative origins',()=>{
  const bounds={x:-1600,y:-900,width:1600,height:900};
  assert.deepEqual(screenPoint({x:-1700,y:-1000},bounds),{x:-1600,y:-900});
  assert.deepEqual(screenPoint({x:10,y:10},bounds),{x:0,y:0});
  assert.deepEqual(screenPoint({x:-500,y:-200},bounds),{x:-500,y:-200});
});
