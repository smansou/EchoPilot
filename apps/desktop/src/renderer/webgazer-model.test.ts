import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitGazeModel,installGazeModel,validGazeModel,compatibleGazeViewport} from './webgazer-model';

class Regression {
  eyeFeaturesClicks={data:[] as number[][]};screenXClicksArray={data:[] as number[][]};screenYClicksArray={data:[] as number[][]};ridgeParameter=1e-5;
  init(){this.eyeFeaturesClicks={data:[]};this.screenXClicksArray={data:[]};this.screenYClicksArray={data:[]};}
  addData(eyes:unknown,point:number[]){this.eyeFeaturesClicks.data.push(eyes as number[]);this.screenXClicksArray.data.push([point[0]!]);this.screenYClicksArray.data.push([point[1]!]);}
  predict(_eyes:unknown):{x:number;y:number}|null{return null;}
}
test('fitted coefficients predict unseen observations and serialize without eye patches or training vectors',()=>{
  const reg=new Regression();for(let i=0;i<45;i++){const x=i%9,y=Math.floor(i/9);reg.addData([1,x,y],[200+100*x+5*y,50+8*x+90*y]);}
  const model=fitGazeModel(reg);assert.ok(model);assert.equal(model.x.length,3);
  assert.ok(installGazeModel(reg,model));
  const prediction=reg.predict([1,2.5,1.5]);assert.ok(prediction);assert.ok(Math.abs(prediction.x-457.5)<2);assert.ok(Math.abs(prediction.y-205)<2);
  assert.equal(reg.eyeFeaturesClicks.data.length,45,'inference must not mutate training data');
  const saved=JSON.parse(JSON.stringify(model));assert.deepEqual(Object.keys(saved).sort(),['version','x','y']);
  const restored=new Regression();assert.ok(installGazeModel(restored,saved));assert.deepEqual(restored.predict([1,2.5,1.5]),prediction);
});
test('bad models and incompatible feature extraction fail closed',()=>{
  for(const value of [null,{}, {version:1,x:[NaN],y:[1]},{version:1,x:[1],y:[1,2]},{version:2,x:[1],y:[1]}])assert.equal(validGazeModel(value),false);
  const reg=new Regression();assert.equal(fitGazeModel(reg),null);
  assert.equal(installGazeModel(reg,{version:1,x:[1,2],y:[3,4]}),true);
  assert.equal(reg.predict([1]),null);assert.equal(reg.predict(null),null);
});

test('native frame rounding does not discard a fit; actual viewport changes require recalibration',()=>{assert.equal(compatibleGazeViewport([1512,857],1512,858),true);assert.equal(compatibleGazeViewport([1512,857],1512,900),false);assert.equal(compatibleGazeViewport([1512,857],1280,857),false);});
