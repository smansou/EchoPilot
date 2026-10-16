import { useEffect, useRef, useState } from 'react';
import type { GazeCalibrationDiagnostics } from '../main/gaze-host';
import { CalibrationTutorial } from './CalibrationTutorial';
import './webgazer-calibration.css';
// Reserve the top centre for visible camera feedback. The remaining eight positions
// span the screen; the centre is trained last, following the upstream workflow.
const targets=[[.12,.15],[.5,.42],[.88,.15],[.12,.5],[.88,.5],[.12,.85],[.5,.85],[.88,.85],[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7],[.5,.65]] as const;
type Prediction={x:number;y:number}|null;
type WebGazer={params:Record<string,unknown>;begin():Promise<unknown>;pause():void;end():void;clearData():Promise<void>;showFaceOverlay(value:boolean):WebGazer;showFaceFeedbackBox(value:boolean):WebGazer;getRegression():{getData():unknown[]}[];setRegression(value:string):WebGazer;setTracker(value:string):WebGazer;applyKalmanFilter(value:boolean):WebGazer;showVideoPreview(value:boolean):WebGazer;showPredictionPoints(value:boolean):WebGazer;saveDataAcrossSessions(value:boolean):WebGazer;removeMouseEventListeners():WebGazer;recordScreenPosition(x:number,y:number,event:string):WebGazer;setGazeListener(callback:(prediction:Prediction)=>void):WebGazer;getTracker():{getPositions():unknown[]|null}};
const desktop=(request:Record<string,unknown>):Promise<any>=>(window as any).echo.desktop(request);
type View={phase:'tutorial'|'setup'|'training'|'validation'|'error'|'tracking';index:number;error:string;progress:number;ready:boolean;checking:boolean;settling:boolean;diagnostics?:GazeCalibrationDiagnostics|undefined};
const initial:View={phase:'tutorial',index:-1,error:'',progress:0,ready:false,checking:false,settling:false};
export function WebGazerCalibration(){
  const [attempt,setAttempt]=useState(0),[tutorialDone,setTutorialDone]=useState(false);
  const click=useRef<(()=>void)|null>(null),startCalibration=useRef<(()=>void)|null>(null);
  const [view,setView]=useState<View>(initial);
  const startup=useRef<Promise<void>|null>(null);
  const stopCamera=useRef<(()=>void)|null>(null);
  useEffect(()=>{
    if(!tutorialDone)return;
    let disposed=false,loadedModule=false,wg:WebGazer|undefined,index=-1,observations=0,targetAt=0,lastSent=0,lastClick=-Infinity;
    let advancing=false,finished=false,failed=false,checkArmed=false,interrupted=false;
    let faceAt=-Infinity,greenSince=0,faceSerial=0,usedSerial=-1,validationSerial=-1,lastPositions:unknown[]|null=null,framesUsed=0,framesRejected=0,lastUI=0;
    const validationTargets:Record<string,number>[]=[],errors:number[][]=[];
    let predictions:{x:number;y:number}[]=[],sampleStarted=0;
    let deadline:ReturnType<typeof setTimeout>|undefined,health:ReturnType<typeof setInterval>|undefined;
    const green=()=>document.getElementById('webgazerFaceFeedbackBox')?.style.borderColor==='green';
    const ready=()=>!interrupted&&performance.now()-faceAt<350&&green()&&greenSince>0&&performance.now()-greenSince>=600;
    function cleanup(){if(deadline)clearTimeout(deadline);if(health)clearInterval(health);wg?.pause();document.querySelectorAll('video').forEach(video=>(video.srcObject as MediaStream|null)?.getTracks().forEach(track=>track.stop()));try{wg?.end();}catch{}if(loadedModule&&(window as any).webgazer===wg)delete (window as any).webgazer;}
    stopCamera.current=cleanup;
    function fail(message:string,diagnostics?:GazeCalibrationDiagnostics|undefined){if(failed||disposed)return;failed=true;click.current=null;startCalibration.current=null;cleanup();setView(s=>({...s,phase:'error',error:message,ready:false,diagnostics}));}
    function setTarget(){targetAt=performance.now();observations=0;predictions=[];sampleStarted=0;checkArmed=false;validationSerial=-1;
      setView({phase:index<9?'training':'validation',index,error:'',progress:0,ready:ready(),checking:false,settling:index<9});
      click.current=index<9?train:()=>{if(!ready())return;checkArmed=true;targetAt=performance.now();setView(s=>({...s,checking:true,error:''}));};
    }
    function train(){const time=performance.now();
      if(disposed||failed||advancing||index<0||index>=9)return;
      if(!ready()||time-targetAt<800||usedSerial===faceSerial||time-lastClick<250){framesRejected++;return;}
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
    setView({...initial,phase:'setup'});
    async function start(){try{
      const config=await desktop({action:'gaze-config'});if(disposed)return;
      const script=document.createElement('script');script.src='echo://app/vendor/webgazer/webgazer.js';
      if(!(window as any).webgazer)await new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(Error('The local gaze module could not load.'));document.head.appendChild(script);}).then(()=>{loadedModule=true;});
      if(disposed)return;wg=(window as any).webgazer as WebGazer;
      wg.params.faceMeshSolutionPath='echo://app/vendor/webgazer/mediapipe/face_mesh';
      wg.params.videoViewerWidth=240;wg.params.videoViewerHeight=180;
      wg.saveDataAcrossSessions(false).setRegression('ridge').setTracker('TFFacemesh').applyKalmanFilter(true).showPredictionPoints(false).showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);
      await wg.clearData();if(disposed)return;
      startCalibration.current=()=>{if(!ready())return;index=0;setTarget();};
      wg.setGazeListener(prediction=>{
        if(disposed||advancing||failed)return;
        const time=performance.now(),positions=wg!.getTracker().getPositions();
        const fresh=!!positions&&positions!==lastPositions;
        if(fresh){lastPositions=positions;faceAt=time;faceSerial++;}
        if(interrupted||time-faceAt>=350||!green())greenSince=0;else if(!greenSince)greenSince=time;
        const finite=fresh&&prediction&&Number.isFinite(prediction.x)&&Number.isFinite(prediction.y);
        if(finished){if(finite&&time-lastSent>=50){lastSent=time;void desktop({action:'gaze-sample',x:prediction.x+config.originX,y:prediction.y+config.originY}).catch(()=>fail('Tracking stopped. Return to Settings to start gaze again.'));}return;}
        if(time-lastUI>=100){lastUI=time;setView(s=>({...s,ready:ready(),settling:index>=0&&index<9&&time-targetAt<800}));}
        if(index<9||!checkArmed)return;
        if(time-targetAt>15000){fail('The camera did not provide enough consistent eye observations to finish this check. You can try setup again or continue without gaze.');return;}
        if(!ready()){predictions=[];sampleStarted=0;setView(s=>s.progress>0?{...s,progress:0}:s);return;}
        if(!finite)return; // A single unusable eye patch (for example a blink) is skipped.
        if(!sampleStarted)sampleStarted=time;
        // Settling precedes measurement. Count each actual camera observation once;
        // a stale landmark array or a brief loss of the face cannot complete a check.
        if(time-sampleStarted<1000||validationSerial===faceSerial)return;
        validationSerial=faceSerial;predictions.push({x:prediction.x,y:prediction.y});
        setView(s=>({...s,progress:Math.min(100,Math.round(Math.min(predictions.length/20,(time-sampleStarted-1000)/1800)*100))}));
        if(time-sampleStarted<2800||predictions.length<20)return;
        const position=targets[index]!,x=position[0]*innerWidth,y=position[1]*innerHeight;
        validationTargets.push({targetX:x+config.originX,targetY:y+config.originY,meanX:predictions.reduce((sum,p)=>sum+p.x,0)/predictions.length+config.originX,meanY:predictions.reduce((sum,p)=>sum+p.y,0)/predictions.length+config.originY,frames:predictions.length});
        errors.push([Math.sqrt(predictions.reduce((sum,p)=>sum+(p.x-x)**2,0)/predictions.length),Math.sqrt(predictions.reduce((sum,p)=>sum+(p.y-y)**2,0)/predictions.length)]);
        index++;if(index<targets.length){setTarget();return;}
        advancing=true;click.current=null;
        void desktop({action:'gaze-calibrated',errors,validation:{targets:validationTargets,framesUsed,framesRejected}}).then(result=>{if(disposed)return;if(!result.ok){fail(result.error||'This calibration could not separate screen areas reliably. You can try setup again or continue without gaze.',result.calibrationDiagnostics);return;}finished=true;wg?.showVideoPreview(false);advancing=false;setView({...initial,phase:'tracking'});}).catch(()=>fail('Calibration could not finish. Return to Settings to start gaze again.'));
      });
      deadline=setTimeout(()=>fail('The camera could not start. Check camera access in System Settings, then try setup again.'),20000);
      await wg.begin();if(deadline)clearTimeout(deadline);if(disposed||failed){cleanup();return;}
      wg.removeMouseEventListeners();
      health=setInterval(()=>{if(disposed||failed||finished)return;if(performance.now()-faceAt>=350){greenSince=0;predictions=[];sampleStarted=0;setView(s=>({...s,ready:false,progress:s.phase==='validation'?0:s.progress}));}if(checkArmed&&performance.now()-targetAt>15000)fail('The camera did not provide enough eye observations. You can try setup again or continue without gaze.');},200);
    }catch(error){fail(error instanceof Error?error.message:'Camera could not start. Check camera access in System Settings.');}}
    const previousStartup=startup.current;
    startup.current=(async()=>{await previousStartup;if(!disposed)await start();})();
    return()=>{disposed=true;if(stopCamera.current===cleanup)stopCamera.current=null;click.current=null;startCalibration.current=null;window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);cleanup();};
  },[attempt,tutorialDone]);
  const target=targets[view.index];
  const close=()=>{stopCamera.current?.();void desktop({action:'gaze-close'});};
  return <main className="gaze-calibration">
    <button className="gaze-cancel" onClick={close}>Stop gaze · Esc</button>
    {!tutorialDone&&<CalibrationTutorial onComplete={()=>setTutorialDone(true)}/>}
    {view.phase==='setup'&&<section className="calibration-setup" aria-live="polite"><span>Camera check</span><h1>Find a comfortable position</h1><p>Your camera preview is above. When the outline stays green, you’re ready.</p><strong>{view.ready?'Face in view · ready':'Waiting for a clear view of your eyes…'}</strong><p>Keep the screen angle and your sitting position comfortable. You won’t need to watch instructions while following the targets.</p><button className="calibration-start" disabled={!view.ready} onClick={()=>startCalibration.current?.()}>Begin calibration</button><small>Camera images stay on this Mac.</small></section>}
    {(view.phase==='training'||view.phase==='validation')&&target&&<>
      <div className="calibration-progress">{view.phase==='training'?`Learn your gaze · ${view.index+1} of 9`:`Check the result · ${view.index-8} of 5`}</div>
      <button aria-label="Calibration target" aria-disabled={!view.ready||view.settling} className="calibration-dot calibration-click" onClick={()=>click.current?.()} style={{left:`${target[0]*100}%`,top:`${target[1]*100}%`}}>{view.index<9?`${view.progress}/5`:view.checking?'Look':'Start'}</button>
      <div className="calibration-target-help" role="status" style={{left:`${target[0]*100}%`,top:`${target[1]*100}%`,transform:`translate(${target[0]<.2?'0%':target[0]>.8?'-100%':'-50%'},${target[1]>.75?'calc(-100% - 48px)':'48px'})`}}><strong>{!view.ready?'Pause · face out of view':view.settling?'Look here for a moment':view.index<9?'Look here. Click five times.':view.checking?`Keep looking · ${view.progress}%`:'Look here, then click Start.'}</strong><p>{!view.ready?'The camera preview above will turn green when your eyes are in view.':view.settling?'Let your eyes settle. Then make five deliberate clicks.':view.index<9?'A slow, steady rhythm. Each glow counts one click.':view.checking?'Measuring only. No clicks needed.':'This checks a new area without training on it.'}</p></div>
    </>}
    {view.phase==='error'&&<section className="calibration-result" role="alert"><span>Gaze isn’t ready yet</span><h1>This fit wasn’t reliable</h1><p>{view.error}</p>{view.diagnostics&&<details><summary>Calibration details</summary><p>{view.diagnostics.failedChecks.join('. ')}.</p><p>Horizontal response: {view.diagnostics.horizontalResponse.toFixed(2)} · Vertical response: {view.diagnostics.verticalResponse.toFixed(2)}</p><p>{view.diagnostics.areas.map((area,i)=>`Area ${i+1}: ${Math.round(area.error)} points (${area.frames} observations)`).join(' · ')}</p><small>Screen points measure error on this screen, not a percentage score. These summaries stay in memory.</small></details>}<p>More clicks don’t always improve webcam gaze. You can review setup once more, or use EchoPilot without gaze.</p><button className="calibration-retry" onClick={()=>{setView(initial);setTutorialDone(false);setAttempt(a=>a+1);}}>Review setup</button><button onClick={close}>Continue without gaze</button></section>}
  </main>;
}
