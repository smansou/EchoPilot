import {test} from 'node:test';
import assert from 'node:assert/strict';
import {notchBounds} from './notch-layout';
test('notch opens from the physical top edge, including displays above or left of the primary',()=>{
  for(const origin of [{x:0,y:0},{x:-1920,y:-1080}]){
    const bounds={...origin,width:1920,height:1080};
    const result=notchBounds({bounds,workArea:{...bounds,y:origin.y+38,height:1000}},true);
    assert.equal(result.y,origin.y);
    assert.equal(result.x+result.width/2,origin.x+960);
    assert.equal(result.height,220);
  }
});
