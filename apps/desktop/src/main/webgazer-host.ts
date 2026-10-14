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
        if(!display||calibration?.accepted||!Array.isArray(r.errors)||r.errors.length!==5)return {ok:false,error:'invalid_request'};
        const errors=r.errors as unknown[];
        if(!errors.every(e=>Array.isArray(e)&&e.length===2&&e.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=2*Math.max(display!.width,display!.height))))return {ok:false,error:'invalid_request'};
        const pairs=errors as [number,number][];
        const rms=Math.sqrt(pairs.reduce((sum,[x,y])=>sum+x*x+y*y,0)/5);
        // Coarse area targeting still needs evidence of tracking in both directions.
        // Compare unseen predictions with a constant-at-center baseline: relaxing an
        // absolute pixel threshold alone would admit collapsed regressions.
        const validation=r.validation as {targets?:unknown;framesUsed?:unknown;framesRejected?:unknown}|undefined;
        const records=validation?.targets;
        if(!Array.isArray(records)||records.length!==5||validation?.framesUsed!==45||typeof validation.framesRejected!=='number'||!Number.isInteger(validation.framesRejected)||validation.framesRejected<0)return {ok:false,error:'invalid_validation'};
        type Check={targetX:number;targetY:number;meanX:number;meanY:number;frames:number};
        if(!records.every(value=>value&&typeof value==='object'&&['targetX','targetY','meanX','meanY','frames'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]))&&Number.isInteger(value.frames)&&value.frames>=8&&value.frames<=1000))return {ok:false,error:'invalid_validation'};
        const checks=records as Check[];
        if(!checks.every(p=>p.targetX>=display!.originX&&p.targetX<=display!.originX+display!.width&&p.targetY>=display!.originY&&p.targetY<=display!.originY+display!.height&&Math.abs(p.meanX-display!.originX)<=display!.width*2&&Math.abs(p.meanY-display!.originY)<=display!.height*2))return {ok:false,error:'invalid_validation'};
        // RMS must include mean residuals; reject inconsistent or forged metadata.
        if(checks.some((p,i)=>Math.abs(p.meanX-p.targetX)>pairs[i]![0]+1||Math.abs(p.meanY-p.targetY)>pairs[i]![1]+1))return {ok:false,error:'invalid_validation'};
        const slope=(axis:'X'|'Y')=>{
          const target=axis==='X'?'targetX':'targetY',mean=axis==='X'?'meanX':'meanY';
          const center=checks.reduce((sum,p)=>sum+p[target],0)/5;
          const variance=checks.reduce((sum,p)=>sum+(p[target]-center)**2,0);
          return variance>1?checks.reduce((sum,p)=>sum+(p[target]-center)*p[mean],0)/variance:0;
        };
        const baseline=Math.sqrt(checks.reduce((sum,p)=>sum+(p.targetX-display!.originX-display!.width/2)**2+(p.targetY-display!.originY-display!.height/2)**2,0)/5);
        const worst=Math.max(...pairs.map(([x,y])=>Math.hypot(x,y)));
        const span=Math.min(display.width,display.height);
        const accepted=slope('X')>=.2&&slope('Y')>=.2&&rms<baseline*.85&&rms<=span*.4&&worst<=span*.6;
        const variance=(axis:0|1)=>Math.max(40*40,pairs.reduce((sum,e)=>sum+e[axis]*e[axis],0)/5);
        calibration={accepted,reason:accepted?'coarse_area_only':'validation_did_not_separate_areas',calibrationGeneration:generation,displayId:display.displayId,cameraId:'webgazer-local',framesUsed:45,framesRejected:validation.framesRejected,validationFramesUsed:checks.reduce((sum,p)=>sum+p.frames,0),residualCovariance2x2:[[variance(0),0],[0,variance(1)]],displayArrangementGeneration:display.arrangementGeneration,recordedAt:new Date(now()).toISOString()};
        if(!accepted){reason='calibration_rejected';return {ok:false,calibration,error:`Gaze did not reliably distinguish the test areas (${Math.round(rms)} screen points of uncertainty). Recalibrate using deliberate clicks and the green camera box.`};}
        reason='pupil_tracking_lost';
      }else if(r.command==='webgazer-sample'){
        if(!display||!calibration?.accepted)return {ok:false,error:'calibration_required'};
        if(status().reason==='display_unavailable')return {ok:false,error:'display_unavailable'};
        if(typeof r.x!=='number'||typeof r.y!=='number'||!Number.isFinite(r.x)||!Number.isFinite(r.y)||r.x<display!.originX||r.x>display!.originX+display!.width||r.y<display!.originY||r.y>display!.originY+display!.height)return {ok:false,error:'invalid_request'};
        samples.push({timestamp:new Date(now()).toISOString(),displayId:display!.displayId,meanX:r.x,meanY:r.y,covariance2x2:calibration!.residualCovariance2x2,quality:Math.max(.2,Math.min(.8,1-Math.sqrt(calibration!.residualCovariance2x2[0][0]+calibration!.residualCovariance2x2[1][1])/Math.min(display!.width,display!.height))),calibrationGeneration:generation,displayTransform:display!});
        samples=samples.filter(s=>now()-Date.parse(s.timestamp)<=10000).slice(-600);
      }else if(r.command!=='status')return {ok:false,error:'invalid_request'};
      const state=status();return {ok:true,status:state,displays:options.displays(),calibration,latestSample:state.state==='active'?samples.at(-1)!:undefined} as GazeHostResult;
    },
  };
}
