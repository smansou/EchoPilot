import {solveLinearSystem} from '../../../../packages/gaze/src/numerics';

export type GazeModel={version:1;x:number[];y:number[]};
type Window={data:number[][]};
/** Adapter for the pinned WebGazer 3.5.3 ridge module. Only fitted coefficients
 * cross the persistence boundary; patches and training features stay in memory. */
export type RidgeModule={eyeFeaturesClicks?:Window;screenXClicksArray?:Window;screenYClicksArray?:Window;ridgeParameter?:number;constructor:Function;init?():void;addData?(eyes:unknown,point:number[],kind:string):void;predict?(eyes:unknown):{x:number;y:number}|null};
export function validGazeModel(value:unknown):value is GazeModel {
  if(!value||typeof value!=='object')return false;
  const model=value as GazeModel;
  return model.version===1&&Array.isArray(model.x)&&Array.isArray(model.y)&&model.x.length===model.y.length&&model.x.length>0&&model.x.length<=240&&[...model.x,...model.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<1e8);
}
export function fitGazeModel(reg:RidgeModule):GazeModel|null {
  const features=reg.eyeFeaturesClicks?.data,x=reg.screenXClicksArray?.data,y=reg.screenYClicksArray?.data;
  if(!features?.length||!x||!y||x.length!==features.length||y.length!==features.length||features.length>50)return null;
  const dimension=features[0]!.length;
  if(!dimension||dimension>240||features.some(row=>row.length!==dimension||!row.every(Number.isFinite)))return null;
  const ridge=reg.ridgeParameter??1e-5;
  // Dual ridge solve: at most 50x50 once, rather than the upstream 120x120
  // normal equation fit twice on every video frame.
  const gram=features.map((a,i)=>features.map((b,j)=>a.reduce((sum,v,k)=>sum+v*b[k]!,0)+(i===j?ridge:0)));
  const fit=(labels:number[][])=>{const weights=solveLinearSystem(gram,labels.map(row=>row[0]!));return weights?Array.from({length:dimension},(_,k)=>features.reduce((sum,row,i)=>sum+row[k]!*weights[i]!,0)):null;};
  const cx=fit(x),cy=fit(y);if(!cx||!cy)return null;
  const model={version:1 as const,x:cx,y:cy};return validGazeModel(model)?model:null;
}
export function installGazeModel(reg:RidgeModule,model:GazeModel):boolean {
  if(!validGazeModel(model)||!reg.init||!reg.addData||!reg.predict)return false;
  // Reuse upstream feature extraction unchanged, in an isolated scratch module.
  // Its single transient patch is discarded on the next prediction.
  const scratch=Object.create(Object.getPrototypeOf(reg)) as RidgeModule;
  if(typeof scratch.init!=='function'||typeof scratch.addData!=='function')return false;
  reg.predict=eyes=>{
    if(!eyes)return null;
    scratch.init!();scratch.addData!(eyes,[0,0],'click');
    const features=scratch.eyeFeaturesClicks?.data[0];
    if(!features||features.length!==model.x.length||!features.every(Number.isFinite))return null;
    const x=features.reduce((sum,v,i)=>sum+v*model.x[i]!,0),y=features.reduce((sum,v,i)=>sum+v*model.y[i]!,0);
    return Number.isFinite(x)&&Number.isFinite(y)?{x:Math.floor(x),y:Math.floor(y)}:null;
  };
  return true;
}

/** Native macOS frame rounding can differ by one logical point between launches. */
export function compatibleGazeViewport(saved:readonly number[],width:number,height:number){return saved.length===2&&Math.abs(saved[0]!-width)<=2&&Math.abs(saved[1]!-height)<=2;}
