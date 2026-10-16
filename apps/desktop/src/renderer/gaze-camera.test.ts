import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planGazeCrop} from './gaze-camera';

test('camera framing never upscales, escapes the input, or exceeds the tracking budget',()=>{
  for(const width of [4,16,320,640,720,1080,1280,1920,2560])for(const height of [3,16,240,360,480,720,1080,1920])for(const zoom of [1,1.5,2,4]){
    const p=planGazeCrop(width,height,zoom);
    assert.ok(p.cropX>=0&&p.cropY>=0&&p.cropX+p.cropWidth<=width&&p.cropY+p.cropHeight<=height);
    assert.ok(p.outputWidth<=p.cropWidth&&p.outputHeight<=p.cropHeight);
    assert.ok(p.outputWidth<=640&&p.outputHeight<=480&&p.outputWidth>0&&p.outputHeight>0);
    assert.equal(p.cropWidth*3,p.cropHeight*4);assert.equal(p.outputWidth*3,p.outputHeight*4);
    assert.ok(Math.abs(p.cropX+p.cropWidth/2-width/2)<=.5&&Math.abs(p.cropY+p.cropHeight/2-height/2)<=.5);
    assert.ok(p.zoom>=1);
  }
});
test('invalid camera dimensions and magnification cannot produce a processing buffer',()=>{
  for(const values of [[0,480,1.5],[640,0,1.5],[640,480,.5],[640,480,Infinity],[NaN,480,1.5],[640,-480,1.5]])assert.throws(()=>planGazeCrop(values[0]!,values[1]!,values[2]!));
});
