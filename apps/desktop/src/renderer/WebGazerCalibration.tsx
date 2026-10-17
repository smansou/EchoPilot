import { useEffect, useRef, useState } from 'react';
import type { GazeCalibrationDiagnostics } from '../main/gaze-host';
import { createGazeCameraCapture, type GazeCameraInfo } from './gaze-camera';
import { sizeWebGazerPreview } from './webgazer-preview';
import {fitGazeModel,installGazeModel,compatibleGazeViewport,type GazeModel,type RidgeModule} from './webgazer-model';
import type {GazeProfile} from '../main/gaze-preferences';
import { createGazeSignal, eyesOpen, screenPoint } from './gaze-signal';
import { CalibrationTutorial } from './CalibrationTutorial';
import './webgazer-calibration.css';
// Reserve the top centre for visible camera feedback. The remaining eight positions
// span the screen; the centre is trained last, following the upstream workflow.
const targets=[[.04,.06],[.5,.42],[.96,.06],[.04,.5],[.96,.5],[.04,.94],[.5,.94],[.96,.94],[.5,.5],[.08,.12],[.92,.12],[.08,.88],[.92,.88],[.5,.65]] as const;
type Prediction={x:number;y:number}|null;
type WebGazer={params:Record<string,unknown>;setVideoViewerSize(width:number,height:number):unknown;begin():Promise<unknown>;pause():void;end():void;clearData():Promise<void>;showFaceOverlay(value:boolean):WebGazer;showFaceFeedbackBox(value:boolean):WebGazer;getRegression():(RidgeModule&{getData():unknown[]})[];setRegression(value:string):WebGazer;setTracker(value:string):WebGazer;applyKalmanFilter(value:boolean):WebGazer;showVideoPreview(value:boolean):WebGazer;showPredictionPoints(value:boolean):WebGazer;saveDataAcrossSessions(value:boolean):WebGazer;removeMouseEventListeners():WebGazer;recordScreenPosition(x:number,y:number,event:string):WebGazer;setGazeListener(callback:(prediction:Prediction)=>void):WebGazer;getTracker():{getPositions():unknown[]|null}};
const desktop=(request:Record<string,unknown>):Promise<any>=>(window as any).echo.desktop(request);
type View={phase:'tutorial'|'setup'|'training'|'validation'|'error'|'tracking';index:number;error:string;progress:number;ready:boolean;checking:boolean;settling:boolean;diagnostics?:GazeCalibrationDiagnostics|undefined};
const initial:View={phase:'tutorial',index:-1,error:'',progress:0,ready:false,checking:false,settling:false};
export function WebGazerCalibration(){
  const [attempt,setAttempt]=useState(0),[tutorialDone,setTutorialDone]=useState(false);
  const click=useRef<(()=>void)|null>(null),startCalibration=useRef<(()=>void)|null>(null);
  const [view,setView]=useState<View>(initial);
  const [reusing,setReusing]=useState(false);const forceCalibration=useRef(false);
  const [cameraInfo,setCameraInfo]=useState<GazeCameraInfo|null>(null);
  const startup=useRef<Promise<void>|null>(null);
  const stopCamera=useRef<(()=>void)|null>(null);
  useEffect(()=>{let active=true;void desktop({action:'gaze-config'}).then(config=>{if(active&&config.profile)setTutorialDone(true);}).catch(()=>{});return()=>{active=false;};},[]);
  useEffect(()=>{
    if(!tutorialDone)return;
    let cameraCapture:ReturnType<typeof createGazeCameraCapture>|null=null;
    let disposed=false,loadedModule=false,wg:WebGazer|undefined,index=-1,observations=0,targetAt=0,lastSent=0,lastClick=-Infinity;
    let advancing=false,finished=false,failed=false,checkArmed=false,interrupted=false;
    let faceAt=-Infinity,greenSince=0,faceSerial=0,usedSerial=-1,validationSerial=-1,lastPositions:unknown[]|null=null,framesUsed=0,framesRejected=0,lastUI=0,lastSourceSequence=-1,lastReceivedFrames=-1;
    let receivingVideo:HTMLVideoElement|null=null;
    const signal=createGazeSignal();
    let openEyes=false,lastUsableAt=-Infinity,reportedLoss=false,resuming=false;
    let model:GazeModel|null=null,cameraSignature='',configuration:any=null;
    let healthFrames=-1,receiverProgressAt=0,stalledAt=0;
    const validationTargets:Record<string,number>[]=[],errors:number[][]=[];
    let predictions:{x:number;y:number}[]=[],sampleStarted=0;
    let deadline:ReturnType<typeof setTimeout>|undefined,health:ReturnType<typeof setInterval>|undefined;
    const green=()=>document.getElementById('webgazerFaceFeedbackBox')?.style.borderColor==='green';
    const ready=()=>openEyes&&!interrupted&&performance.now()-faceAt<350&&green()&&greenSince>0&&performance.now()-greenSince>=600;
    function cleanup(){cameraCapture?.dispose();if(deadline)clearTimeout(deadline);if(health)clearInterval(health);wg?.pause();document.querySelectorAll('video').forEach(video=>(video.srcObject as MediaStream|null)?.getTracks().forEach(track=>track.stop()));try{wg?.end();}catch{}if(loadedModule&&(window as any).webgazer===wg)delete (window as any).webgazer;}
    stopCamera.current=cleanup;
    function fail(message:string,diagnostics?:GazeCalibrationDiagnostics|undefined){if(failed||disposed)return;failed=true;click.current=null;startCalibration.current=null;cleanup();if(finished)void desktop({action:'gaze-close'}).catch(()=>{});setView(s=>({...s,phase:'error',error:message,ready:false,diagnostics}));}
    function setTarget(){
      if(index===9&&!model){model=fitGazeModel(wg!.getRegression()[0]!);if(!model||!installGazeModel(wg!.getRegression()[0]!,model)){fail('The local gaze model could not fit these observations. Please review setup.');return;}}
      signal.reset();targetAt=performance.now();observations=0;predictions=[];sampleStarted=0;checkArmed=index>=9;validationSerial=-1;
      setView({phase:index<9?'training':'validation',index,error:'',progress:0,ready:ready(),checking:index>=9,settling:index<9});
      click.current=index<9?train:()=>{if(!ready())return;checkArmed=true;targetAt=performance.now();setView(s=>({...s,checking:true,error:''}));};
    }
    function train(){const time=performance.now();
      if(disposed||failed||advancing||index<0||index>=9)return;
      if(!ready()||time-targetAt<800||usedSerial===faceSerial||time-lastClick<120){framesRejected++;return;}
      const [tx,ty]=targets[index]!,before=wg!.getRegression()[0]!.getData().length;
      wg!.recordScreenPosition(tx*innerWidth,ty*innerHeight,'click');
      if(wg!.getRegression()[0]!.getData().length!==before+1){framesRejected++;return;}
      usedSerial=faceSerial;lastClick=time;framesUsed++;observations++;
      setView(s=>({...s,error:'',progress:observations}));
      if(observations===5){index++;setTarget();}
    }
    function blur(){interrupted=true;greenSince=0;predictions=[];sampleStarted=0;targetAt=performance.now();if(!finished&&!failed)setView(s=>({...s,ready:false,progress:s.phase==='validation'?0:s.progress}));}
    function focus(){interrupted=false;targetAt=performance.now();}
    window.addEventListener('blur',blur);window.addEventListener('focus',focus);
    setCameraInfo(null);setView({...initial,phase:'setup'});
    async function start(){try{
      const config=await desktop({action:'gaze-config'});configuration=config;if(disposed)return;
      const script=document.createElement('script');script.src='echo://app/vendor/webgazer/webgazer.js';
      if(!(window as any).webgazer)await new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(Error('The local gaze module could not load.'));document.head.appendChild(script);}).then(()=>{loadedModule=true;});
      if(disposed)return;wg=(window as any).webgazer as WebGazer;
      wg.params.faceMeshSolutionPath='echo://app/vendor/webgazer/mediapipe/face_mesh';
      wg.params.videoViewerWidth=240;wg.params.videoViewerHeight=180;
      wg.saveDataAcrossSessions(false).setRegression('ridge').setTracker('TFFacemesh').applyKalmanFilter(false).showPredictionPoints(false).showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);
      await wg.clearData();if(disposed)return;
      startCalibration.current=()=>{if(!ready())return;index=resuming?9:0;setTarget();};
      wg.setGazeListener(prediction=>{
        if(disposed||advancing||failed)return;
        const time=performance.now(),positions=wg!.getTracker().getPositions();
        if(cameraCapture?.problem()){fail(cameraCapture.problem()!);return;}
        const sourceSequence=cameraCapture?.sequence();
        // A fresh capture alone is not enough if the receiving video stalled.
        const receivedFrames=receivingVideo?.getVideoPlaybackQuality().totalVideoFrames;
        const consumerChanged=!cameraCapture||receivedFrames!==undefined&&receivedFrames!==lastReceivedFrames;
        const fresh=(cameraCapture?.fresh()??true)&&consumerChanged&&(sourceSequence===undefined||sourceSequence!==lastSourceSequence)&&!!positions&&positions!==lastPositions;
        if(fresh){lastPositions=positions;if(receivedFrames!==undefined)lastReceivedFrames=receivedFrames;if(sourceSequence!==undefined)lastSourceSequence=sourceSequence;faceAt=time;faceSerial++;}
        if(interrupted||time-faceAt>=350||!green())greenSince=0;else if(!greenSince)greenSince=time;
        openEyes=eyesOpen(positions)&&time-faceAt<350;
        const finite=fresh&&openEyes&&prediction&&Number.isFinite(prediction.x)&&Number.isFinite(prediction.y);
        if(finite)lastUsableAt=time;
        const filtered=finite?signal.push(prediction,time):null;
        if(finished){
          if(time-lastUsableAt>250&&!reportedLoss){reportedLoss=true;signal.reset();void desktop({action:'gaze-lost'}).catch(()=>{});}
          if(filtered&&time-lastSent>=50){lastSent=time;reportedLoss=false;
            const point=screenPoint({x:filtered.x+config.originX,y:filtered.y+config.originY},config.displayBounds);
            void desktop({action:'gaze-sample',...point}).then(result=>{if(!result.ok)fail('Tracking stopped. Return to Settings to start gaze again.');}).catch(()=>fail('Tracking stopped. Return to Settings to start gaze again.'));
          }return;
        }
        if(time-lastUI>=100){lastUI=time;setView(s=>({...s,ready:ready(),settling:index>=0&&index<9&&time-targetAt<800}));}
        if(index===-1&&resuming&&ready()){index=9;setTarget();}
        if(index>=0&&index<9){if(ready())train();return;}
        if(index<9||!checkArmed)return;
        if(time-targetAt>15000){fail('The camera did not provide enough consistent eye observations to finish this check. You can try setup again or continue without gaze.');return;}
        if(!ready()){predictions=[];sampleStarted=0;setView(s=>s.progress>0?{...s,progress:0}:s);return;}
        if(!filtered)return; // A blink or an isolated bad eye patch cannot become a check sample.
        if(!sampleStarted)sampleStarted=time;
        // Settling precedes measurement. Count each actual camera observation once;
        // a stale landmark array or a brief loss of the face cannot complete a check.
        if(time-sampleStarted<1000||validationSerial===faceSerial)return;
        validationSerial=faceSerial;predictions.push(filtered);
        setView(s=>({...s,progress:Math.min(100,Math.round(Math.min(predictions.length/20,(time-sampleStarted-1000)/1200)*100))}));
        if(time-sampleStarted<2200||predictions.length<20)return;
        const position=targets[index]!,x=position[0]*innerWidth,y=position[1]*innerHeight;
        validationTargets.push({targetX:x+config.originX,targetY:y+config.originY,meanX:predictions.reduce((sum,p)=>sum+p.x,0)/predictions.length+config.originX,meanY:predictions.reduce((sum,p)=>sum+p.y,0)/predictions.length+config.originY,frames:predictions.length});
        errors.push([Math.sqrt(predictions.reduce((sum,p)=>sum+(p.x-x)**2,0)/predictions.length),Math.sqrt(predictions.reduce((sum,p)=>sum+(p.y-y)**2,0)/predictions.length)]);
        index++;if(index<targets.length){setTarget();return;}
        advancing=true;click.current=null;
        void desktop({action:'gaze-calibrated',errors,validation:{targets:validationTargets,framesUsed,framesRejected,mode:resuming?'resume':'full'},profile:{version:1,model:model!,cameraSignature,viewport:[innerWidth,innerHeight],display:configuration.displayKey,trainedAt:new Date().toISOString()} satisfies GazeProfile}).then(result=>{if(disposed)return;if(!result.ok){fail(result.error||'This calibration could not separate screen areas reliably. You can try setup again or continue without gaze.',result.calibrationDiagnostics);return;}finished=true;wg?.showVideoPreview(false);advancing=false;setView({...initial,phase:'tracking'});}).catch(()=>fail('Calibration could not finish. Return to Settings to start gaze again.'));
      });
      deadline=setTimeout(()=>fail('The camera could not start. Check camera access in System Settings, then try setup again.'),20000);
      // WebGazer keeps ownership of inference/regression. Intercept only its
      // camera request in this isolated renderer to supply a bounded input stream.
      const media=navigator.mediaDevices,originalGetUserMedia=media.getUserMedia;
      const provideCamera:typeof media.getUserMedia=async constraints=>{
        if(disposed||!constraints?.video||constraints.audio)throw new DOMException('Gaze camera request was cancelled.','AbortError');
        cameraCapture??=createGazeCameraCapture(request=>originalGetUserMedia.call(media,request));
        const stream=await cameraCapture.open();
        if(disposed){cameraCapture.dispose();throw new DOMException('Gaze camera request was cancelled.','AbortError');}
        const info=cameraCapture.info();setCameraInfo(info);cameraSignature=JSON.stringify([info?.cameraId,info?.plan]);return stream;
      };
      media.getUserMedia=provideCamera;
      try{await wg.begin();}finally{if(media.getUserMedia===provideCamera)media.getUserMedia=originalGetUserMedia;}
      if(deadline)clearTimeout(deadline);if(disposed||failed){cleanup();return;}
      const camera=document.getElementById('webgazerVideoFeed') as HTMLVideoElement|null;
      receivingVideo=camera;receiverProgressAt=performance.now();if(camera)sizeWebGazerPreview(wg,camera);
      wg.removeMouseEventListeners();
      const saved=config.profile as GazeProfile|null;
      if(!forceCalibration.current&&saved&&saved.cameraSignature===cameraSignature&&compatibleGazeViewport(saved.viewport,innerWidth,innerHeight)&&installGazeModel(wg.getRegression()[0]!,saved.model)){
        model=saved.model;resuming=true;setReusing(true);
      }else {setReusing(false);if(saved)setView(s=>({...s,error:saved.cameraSignature!==cameraSignature?'Camera framing changed. A fresh calibration is needed.':!compatibleGazeViewport(saved.viewport,innerWidth,innerHeight)?'Screen size changed. A fresh calibration is needed.':'Saved model is incompatible. A fresh calibration is needed.'}));}
      health=setInterval(()=>{
        if(disposed||failed)return;
        if(cameraCapture?.problem()){fail(cameraCapture.problem()!);return;}
        const time=performance.now(),frames=receivingVideo?.getVideoPlaybackQuality().totalVideoFrames;
        if(frames!==undefined&&frames!==healthFrames){healthFrames=frames;receiverProgressAt=time;}
        if(finished){
          const stalled=!!cameraCapture&&(!cameraCapture.fresh()||time-receiverProgressAt>800);
          if(!stalled)stalledAt=0;
          else if(!stalledAt)stalledAt=time;
          else if(time-stalledAt>2000)fail('The camera stopped updating. Start gaze setup again.');
          return;
        }
        if(cameraCapture?.fresh()===false||time-faceAt>=350){greenSince=0;predictions=[];sampleStarted=0;setView(s=>({...s,ready:false,progress:s.phase==='validation'?0:s.progress}));}
        if(checkArmed&&time-targetAt>15000)fail('The camera did not provide enough eye observations. You can try setup again or continue without gaze.');
      },200);
    }catch(error){fail(error instanceof Error?error.message:'Camera could not start. Check camera access in System Settings.');}}
    const previousStartup=startup.current;
    startup.current=(async()=>{await previousStartup;if(!disposed)await start();})();
    return()=>{disposed=true;if(stopCamera.current===cleanup)stopCamera.current=null;click.current=null;startCalibration.current=null;window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);cleanup();};
  },[attempt,tutorialDone]);
  const target=targets[view.index];
  const close=()=>{stopCamera.current?.();void desktop({action:'gaze-close'});};
  return <main className="gaze-calibration" data-calibrating={view.phase==='training'||view.phase==='validation'}>
    <button className="gaze-cancel" onClick={close}>Stop gaze · Esc</button>
    {!tutorialDone&&<CalibrationTutorial onComplete={()=>setTutorialDone(true)}/>}
    {view.phase==='setup'&&<section className="calibration-setup" aria-live="polite"><span>Camera check</span><h1>Find a comfortable position</h1><p>Your camera preview is above. When the outline stays green, you’re ready.</p><strong>{view.ready?'Face in view · ready':'Waiting for a clear view of your eyes…'}</strong><p>Rest the computer on a stable surface. During calibration, keep your head comfortably steady and move your eyes between targets.</p><button className="calibration-start" disabled={!view.ready} onClick={()=>startCalibration.current?.()}>{reusing?'Check and start gaze':'Begin calibration'}</button>{view.error&&<p role="status">{view.error}</p>}{cameraInfo&&<small>{cameraInfo.plan.zoom>1.01?'Closer camera framing enabled':'Standard framing · limited by capture resolution'}. Framing stays fixed during gaze use.</small>}<small>Camera images stay on this Mac.</small></section>}
    {(view.phase==='training'||view.phase==='validation')&&target&&<>
      <div className="calibration-progress">{view.phase==='training'?`Learn your gaze · ${view.index+1} of 9`:`Check the result · ${view.index-8} of 5`}</div>
      <button aria-label="Calibration target" aria-disabled={!view.ready||view.settling} className="calibration-dot calibration-click" onClick={()=>click.current?.()} style={{left:`${target[0]*100}%`,top:`${target[1]*100}%`}}>{view.index<9?`${view.progress}/5`:'Look'}</button>
      <div className="calibration-target-help" role="status" style={{left:`${target[0]*100}%`,top:`${target[1]*100}%`,transform:`translate(${target[0]<.2?'0%':target[0]>.8?'-100%':'-50%'},${target[1]>.75?'calc(-100% - 48px)':'48px'})`}}><strong>{!view.ready?'Pause · face out of view':view.settling?'Look here for a moment':view.index<9?'Keep looking here':`Checking accuracy · ${view.progress}%`}</strong><p>{!view.ready?'The camera preview above will turn green when your eyes are in view.':view.settling?'Follow the light, then let your eyes settle.':view.index<9?'No clicks needed. The light moves when this area is learned.':'Measuring a new area. Keep following the light.'}</p></div>
    </>}
    {view.phase==='error'&&<section className="calibration-result" role="alert"><span>Gaze isn’t ready yet</span><h1>This fit wasn’t reliable</h1><p>{view.error}</p>{view.diagnostics&&<details><summary>Calibration details</summary>{cameraInfo&&<p>Camera input: {cameraInfo.plan.sourceWidth}×{cameraInfo.plan.sourceHeight} · crop: {cameraInfo.plan.cropWidth}×{cameraInfo.plan.cropHeight} · tracking: {cameraInfo.plan.outputWidth}×{cameraInfo.plan.outputHeight}. No crop is enlarged.</p>}<p>{view.diagnostics.failedChecks.join('. ')}.</p><p>Horizontal response: {view.diagnostics.horizontalResponse.toFixed(2)} · Vertical response: {view.diagnostics.verticalResponse.toFixed(2)}</p><p>{view.diagnostics.areas.map((area,i)=>`Area ${i+1}: ${Math.round(area.error)} points (${area.frames} observations)`).join(' · ')}</p><small>Screen points measure error on this screen, not a percentage score. These summaries stay in memory.</small></details>}<p>Keep even lighting and a comfortable position. If this fit fails again, the accuracy details will help identify why.</p><button className="calibration-retry" onClick={()=>{forceCalibration.current=true;setReusing(false);setView(initial);setTutorialDone(false);setAttempt(a=>a+1);}}>Review setup</button><button onClick={close}>Continue without gaze</button></section>}
  </main>;
}
