import { createReferenceResolver, type CalibrationRecord, type DisplayTransform, type GazeSample, type ResolveRequest } from '../../../../packages/gaze/src/index';
import type { GazeHostOptions, GazeHostResult } from './gaze-host';
/** WebGazer owns camera inference, regression and Kalman filtering. This host holds only
 * validated screen coordinates and measured uncertainty, in memory for the current session. */
export function createWebGazerHost(options: GazeHostOptions) {
  const now=options.now??Date.now;
  const resolver=createReferenceResolver({now:()=>new Date(now())});
  let display:DisplayTransform|null=null, calibration:CalibrationRecord|null=null;
  let samples:GazeSample[]=[], generation=0, reason='not_started';
  function stop(){display=null;calibration=null;samples=[];reason='stopped';}
  function status(){
    const live=display&&options.displays().find(d=>d.displayId===display!.displayId);
    if(display&&(!live||JSON.stringify(live)!==JSON.stringify(display))){stop();reason='display_unavailable';}
    if(!display||!calibration?.accepted)return {state:'unavailable' as const,reason};
    if(!samples.length||now()-Date.parse(samples.at(-1)!.timestamp)>800)return {state:'unavailable' as const,reason:'pupil_tracking_lost'};
    return {state:'active' as const,displayId:display.displayId,calibrationGeneration:generation};
  }
  return {
    dispose:stop,
    sample(){return status().state==='active'?samples.at(-1)??null:null;},
    recentSamples(){return status().state==='active'?samples.slice():[];},
    resolve(request:ResolveRequest){return resolver.resolve({...request,gaze:status().state==='active'&&calibration?{calibration,samples}:null});},
    async handle(payload:unknown):Promise<GazeHostResult>{
      if(!payload||typeof payload!=='object')return {ok:false,error:'invalid_request'};
      const r=payload as Record<string,unknown>;
      if(r.projectId!==options.activeProjectId())return {ok:false,error:'inactive_project'};
      if(r.command==='stop')stop();
      else if(r.command==='start'){
        stop();if(r.enabled!==true)return {ok:false,error:'camera_enable_required'};
        display=options.displays().find(d=>d.displayId===r.displayId)??null;
        if(!display)return {ok:false,error:'display_unavailable'};
        reason='calibration_required';generation++;
      }else if(r.command==='webgazer-calibration'){
        if(!display||calibration||!Array.isArray(r.errors)||r.errors.length!==5)return {ok:false,error:'invalid_request'};
        const errors=r.errors as unknown[];
        if(!errors.every(e=>Array.isArray(e)&&e.length===2&&e.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=2*Math.max(display!.width,display!.height))))return {ok:false,error:'invalid_request'};
        const pairs=errors as [number,number][];
        const rms=Math.sqrt(pairs.reduce((sum,[x,y])=>sum+x*x+y*y,0)/5);
        // Accuracy is measured at unseen targets; wrong, collapsed or jittery fits are refused.
        const limit=Math.min(display.width,display.height)*.16;
        const worst=Math.max(...pairs.map(([x,y])=>Math.hypot(x,y)));
        const accepted=rms<=limit&&worst<=limit*1.6;
        const variance=(axis:0|1)=>Math.max(40*40,pairs.reduce((sum,e)=>sum+e[axis]*e[axis],0)/5);
        calibration={accepted,calibrationGeneration:generation,displayId:display.displayId,cameraId:'webgazer-local',framesUsed:45,framesRejected:0,validationFramesUsed:5,residualCovariance2x2:[[variance(0),0],[0,variance(1)]],displayArrangementGeneration:display.arrangementGeneration,recordedAt:new Date(now()).toISOString()};
        if(!accepted){reason='calibration_rejected';return {ok:false,calibration,error:`Calibration error is ${Math.round(rms)} points. Try again with steady lighting and your head comfortably still.`};}
        reason='pupil_tracking_lost';
      }else if(r.command==='webgazer-sample'){
        if(!display||!calibration?.accepted)return {ok:false,error:'calibration_required'};
        if(status().reason==='display_unavailable')return {ok:false,error:'display_unavailable'};
        if(typeof r.x!=='number'||typeof r.y!=='number'||!Number.isFinite(r.x)||!Number.isFinite(r.y)||r.x<display!.originX||r.x>display!.originX+display!.width||r.y<display!.originY||r.y>display!.originY+display!.height)return {ok:false,error:'invalid_request'};
        samples.push({timestamp:new Date(now()).toISOString(),displayId:display!.displayId,meanX:r.x,meanY:r.y,covariance2x2:calibration!.residualCovariance2x2,quality:.8,calibrationGeneration:generation,displayTransform:display!});
        samples=samples.filter(s=>now()-Date.parse(s.timestamp)<=10000).slice(-600);
      }else if(r.command!=='status')return {ok:false,error:'invalid_request'};
      const state=status();return {ok:true,status:state,displays:options.displays(),calibration,latestSample:state.state==='active'?samples.at(-1)!:undefined} as GazeHostResult;
    },
  };
}
