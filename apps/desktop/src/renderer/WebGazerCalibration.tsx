import { useEffect, useState } from 'react';
const targets=[[.12,.15],[.5,.15],[.88,.15],[.12,.5],[.5,.5],[.88,.5],[.12,.85],[.5,.85],[.88,.85],[.3,.3],[.7,.3],[.3,.7],[.7,.7],[.5,.6]] as const;
type Prediction={x:number;y:number}|null;
type WebGazer={params:Record<string,unknown>;begin():Promise<unknown>;pause():void;end():void;setRegression(value:string):WebGazer;setTracker(value:string):WebGazer;applyKalmanFilter(value:boolean):WebGazer;showVideoPreview(value:boolean):WebGazer;showPredictionPoints(value:boolean):WebGazer;saveDataAcrossSessions(value:boolean):WebGazer;removeMouseEventListeners():WebGazer;recordScreenPosition(x:number,y:number,event:string):WebGazer;setGazeListener(callback:(prediction:Prediction)=>void):WebGazer;getTracker():{getPositions():unknown[]|null}};
const desktop=(request:Record<string,unknown>):Promise<any>=>(window as any).echo.desktop(request);
export function WebGazerCalibration(){
  const [state,setState]=useState({index:-1,error:'',progress:0});
  useEffect(()=>{
    let disposed=false,wg:WebGazer|undefined,index=0,observations=0,targetAt=0,lastTrain=0,lastSent=0;
    let advancing=false,finished=false,failed=false;let predictions:{x:number;y:number}[]=[];const errors:number[][]=[];
    let deadline:ReturnType<typeof setTimeout>|undefined;
    function cleanup(){wg?.pause();document.querySelectorAll('video').forEach(video=>(video.srcObject as MediaStream|null)?.getTracks().forEach(track=>track.stop()));}
    function fail(message:string){failed=true;cleanup();if(!disposed)setState(s=>({...s,error:message}));}
    function setTarget(){targetAt=performance.now();lastTrain=0;observations=0;predictions=[];setState({index,error:'',progress:0});}
    async function start(){try{
      const config=await desktop({action:'gaze-config'});if(disposed)return;
      const script=document.createElement('script');script.src='echo://app/vendor/webgazer/webgazer.js';
      await new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(Error('The local gaze module could not load.'));document.head.appendChild(script);});
      if(disposed)return;wg=(window as any).webgazer as WebGazer;
      wg.params.faceMeshSolutionPath='echo://app/vendor/webgazer/mediapipe/face_mesh';
      wg.params.showFaceOverlay=false;wg.params.showFaceFeedbackBox=false;
      wg.saveDataAcrossSessions(false).setRegression('ridge').setTracker('TFFacemesh').applyKalmanFilter(true).showPredictionPoints(false).showVideoPreview(false);
      wg.setGazeListener(prediction=>{
        if(disposed||advancing||failed)return;
        const time=performance.now();const finite=prediction&&Number.isFinite(prediction.x)&&Number.isFinite(prediction.y);
        if(finished){if(finite&&time-lastSent>=50){lastSent=time;void desktop({action:'gaze-sample',x:prediction.x+config.originX,y:prediction.y+config.originY}).catch(()=>fail('Tracking stopped. Close this window and try again.'));}return;}
        if(!targetAt)return;
        if(time-targetAt>12000){fail('Your eyes could not be tracked. Close this window and try again in even lighting.');return;}
        if(time-targetAt<1000)return;
        const position=targets[index]!;const x=position[0]*innerWidth,y=position[1]*innerHeight;
        if(index<9){
          // Capture five different camera observations per target through the library API.
          if(wg!.getTracker().getPositions()&&time-lastTrain>=250){wg!.recordScreenPosition(x,y,'click');lastTrain=time;observations++;setState({index,error:'',progress:observations});}
          if(observations===5){index++;setTarget();}
        }else if(finite){
          predictions.push({x:prediction.x,y:prediction.y});
          if(time-targetAt>=2300&&predictions.length>=8){
            // Include both bias and jitter in held-out error; never train on these five targets.
            errors.push([Math.sqrt(predictions.reduce((sum,p)=>sum+(p.x-x)**2,0)/predictions.length),Math.sqrt(predictions.reduce((sum,p)=>sum+(p.y-y)**2,0)/predictions.length)]);
            index++;if(index<targets.length)setTarget();else{
              advancing=true;void desktop({action:'gaze-calibrated',errors}).then(result=>{if(disposed)return;if(!result.ok){fail(result.error||'Calibration was not accurate enough. Close this window and try again.');return;}finished=true;advancing=false;setState({index:-1,error:'',progress:0});}).catch(()=>fail('Calibration could not finish. Close this window and try again.'));
            }
          }
        }
      });
      deadline=setTimeout(()=>fail('Camera startup timed out. Close this window and try again.'),20000);
      await wg.begin();if(deadline)clearTimeout(deadline);if(disposed||failed){cleanup();return;}
      wg.removeMouseEventListeners();setTarget();
    }catch(error){if(deadline)clearTimeout(deadline);fail(error instanceof Error?error.message:'Camera could not start. Check camera access in System Settings.');}}
    void start();return()=>{disposed=true;if(deadline)clearTimeout(deadline);cleanup();};
  },[]);
  const target=targets[state.index];
  return <main className="gaze-calibration">
    <button className="gaze-cancel" onClick={()=>void desktop({action:'gaze-close'})}>Stop gaze · Esc</button>
    {target&&!state.error&&<span className="calibration-dot" style={{left:`${target[0]*100}%`,top:`${target[1]*100}%`}}/>}
    <div className="gaze-instructions" role="status"><strong>{state.error||(state.index<0?'Starting camera…':state.index<9?'Look at the light':'Checking accuracy')}</strong><p>{state.error?'Close this window to return to Settings.':state.index>=0?`${Math.min(state.index+1,14)} of 14 · Keep your head comfortably still. Follow each target with your eyes.`:'Camera images stay on this Mac.'}</p><small>You can close or minimize this window, switch apps, or press Escape at any time.</small></div>
  </main>;
}
