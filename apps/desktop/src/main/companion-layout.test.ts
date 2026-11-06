import {test} from 'node:test';
import assert from 'node:assert/strict';
import {companionBounds,companionArrival} from './companion-layout';
test('companion stays within negative-origin and small display work areas',()=>{
 for(const area of [{x:-1920,y:-900,width:1920,height:1080},{x:0,y:30,width:300,height:200}]){
  const target={x:area.x+area.width-50,y:area.y+area.height-50,width:50,height:50};const result=companionBounds(target,area);
  assert.ok(result.x>=area.x&&result.y>=area.y);assert.ok(result.x+result.width<=area.x+area.width);assert.ok(result.y+result.height<=area.y+area.height);
  assert.deepEqual(companionArrival(result,area,1),result);
 }
});
test('orb departs from its actual notch position and accelerates before a damped bounce',async()=>{
 const {companionArrivalDuration}=await import('./companion-layout');const area={x:0,y:38,width:1440,height:850};const target=companionBounds({x:600,y:300,width:200,height:100},area);const origin={x:547,y:56};
 const duration=companionArrivalDuration(target,area,origin);assert.ok(duration>2400&&duration<4000);
 const sample=(ms:number)=>companionArrival(target,area,ms/duration,origin);
 const start=sample(0);assert.equal(start.x+27,origin.x);assert.equal(start.y+143,origin.y);
 const first=sample(200).y-start.y,second=sample(400).y-sample(200).y;assert.ok(second>first*2,'gravity should accelerate the fall');
 const ys=Array.from({length:101},(_,i)=>companionArrival(target,area,i/100,origin).y);
 assert.ok(ys.some((y,i)=>i>0&&y<ys[i-1]!-2),'bounce must reverse vertical motion');assert.deepEqual(companionArrival(target,area,1,origin),target);
});
