// Actual vendored WebGazer + MediaPipe using the production local crop adapter and a public test portrait.
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import electron from 'electron';

const root=process.cwd(),directory=await mkdtemp('/private/tmp/echo-gaze-camera-webgazer-');
const portraitPath=process.argv[2]??'/private/tmp/echopilot-public-portrait-20261016.jpg';
const portrait=(await readFile(portraitPath)).toString('base64');
const screenshot='/private/tmp/echopilot-gaze-camera-webgazer.png';

await build({stdin:{contents:"import {createGazeCameraCapture} from './apps/desktop/src/renderer/gaze-camera';window.createGazeCameraCapture=createGazeCameraCapture;import {fitGazeModel,installGazeModel} from './apps/desktop/src/renderer/webgazer-model';window.fitGazeModel=fitGazeModel;window.installGazeModel=installGazeModel;",resolveDir:root,loader:'tsx'},bundle:true,outfile:join(directory,'camera.js'),platform:'browser',jsx:'automatic'});

const fixture=`
const portrait=new Image();portrait.src='data:image/jpeg;base64,${portrait}';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw Error(message)};
const waitFor=(predicate,timeout,label)=>new Promise((resolve,reject)=>{const started=Date.now();const poll=()=>{if(predicate())return resolve();if(Date.now()-started>timeout)return reject(Error('Timed out waiting for '+label));setTimeout(poll,25)};poll()});
let lastEyeFeatures=null;let capture,sourceStream,sourceTrack,outputStream,frameTimer,sourceCanvas,wg,requests=[],observations=0,finitePredictions=0,accepted=0,lastSourceSequence=-1,lastRecordSequence=-1,lastTrainAt=-Infinity,recordFailures=0;
window.beginIntegration=async()=>{
  await portrait.decode();
  sourceCanvas=document.createElement('canvas');sourceCanvas.width=1920;sourceCanvas.height=1080;
  const sourceContext=sourceCanvas.getContext('2d');
  const crop={x:480,y:180,width:960,height:720};
  const scale=Math.min(crop.width/portrait.naturalWidth,crop.height/portrait.naturalHeight);
  const draw=()=>{sourceContext.fillStyle='#302b35';sourceContext.fillRect(0,0,1920,1080);const width=portrait.naturalWidth*scale,height=portrait.naturalHeight*scale;sourceContext.drawImage(portrait,crop.x+(crop.width-width)/2,crop.y+(crop.height-height)/2,width,height);sourceContext.fillStyle=Date.now()%2?'#eee':'#555';sourceContext.fillRect(2,2,8,8)};
  draw();sourceStream=sourceCanvas.captureStream(0);sourceTrack=sourceStream.getVideoTracks()[0];sourceTrack.requestFrame?.();
  frameTimer=setInterval(()=>{draw();sourceTrack.requestFrame?.()},34);
  const nativeGetUserMedia=async constraints=>{requests.push(constraints);return sourceStream};
  capture=window.createGazeCameraCapture(nativeGetUserMedia);
  navigator.mediaDevices.getUserMedia=async constraints=>{window.webgazerRequestCount=(window.webgazerRequestCount||0)+1;window.webgazerRequestConstraints=constraints;outputStream=await capture.open();return outputStream};
  wg=window.webgazer;
  assert(wg,'Vendored WebGazer script failed to load');
  wg.params.faceMeshSolutionPath='echo://app/vendor/webgazer/mediapipe/face_mesh';
  wg.params.videoViewerWidth=240;wg.params.videoViewerHeight=180;
  wg.params.showFaceOverlay=true;wg.params.showFaceFeedbackBox=true;
  wg.saveDataAcrossSessions(false).setRegression('ridge').setTracker('TFFacemesh').applyKalmanFilter(false).showPredictionPoints(false).showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);
  await wg.clearData();
  wg.setGazeListener(prediction=>{
    if(prediction?.eyeFeatures)lastEyeFeatures=prediction.eyeFeatures;
    const sequence=capture.sequence(),positions=wg.getTracker().getPositions();
    if(positions&&sequence!==lastSourceSequence){lastSourceSequence=sequence;observations++;}
    if(prediction&&Number.isFinite(prediction.x)&&Number.isFinite(prediction.y))finitePredictions++;
    if(positions&&sequence!==lastRecordSequence&&performance.now()-lastTrainAt>=100&&accepted<45){
      const before=wg.getRegression()[0].getData().length;
      wg.recordScreenPosition(320,240,'click');
      if(wg.getRegression()[0].getData().length===before+1){accepted++;lastRecordSequence=sequence;lastTrainAt=performance.now();}else recordFailures++;
    }
  });
  await wg.begin();wg.removeMouseEventListeners();
  await waitFor(()=>observations>=3&&capture.fresh(),20000,'MediaPipe face landmarks on the cropped camera stream');
  const feed=document.getElementById('webgazerVideoFeed');
  assert(feed&&feed.videoWidth===640&&feed.videoHeight===480,'WebGazer must receive the processed 640x480 stream');
  assert(requests.length===1&&requests[0].audio===false,'The crop adapter must open one video-only synthetic source');
  assert(capture.info()?.plan.sourceWidth===1920&&capture.info()?.plan.sourceHeight===1080,'The capture plan must reflect the 1920x1080 source');
  assert(capture.info()?.plan.cropWidth===960&&capture.info()?.plan.cropHeight===720,'The adapter must provide the expected centered input crop');
  assert(capture.info()?.backend==='video-frame'||capture.info()?.backend==='video-element','The adapter must identify its frame backend');
  return {backend:capture.info().backend,input:{width:capture.info().plan.sourceWidth,height:capture.info().plan.sourceHeight},webgazerVideo:{width:feed.videoWidth,height:feed.videoHeight},crop:{x:capture.info().plan.cropX,y:capture.info().plan.cropY,width:capture.info().plan.cropWidth,height:capture.info().plan.cropHeight},landmarkObservations:observations,secureContext:isSecureContext};
};
window.verifyHiddenFreshness=async()=>{
  const feed=document.getElementById('webgazerVideoFeed');
  assert(feed&&typeof feed.getVideoPlaybackQuality==='function','The WebGazer receiving video must expose playback-frame telemetry');
  wg.showVideoPreview(false);
  const before=feed.getVideoPlaybackQuality().totalVideoFrames;
  await delay(700);
  const after=feed.getVideoPlaybackQuality().totalVideoFrames;
  assert(capture.fresh(),'Cropped source freshness must continue when the Electron gaze window is hidden');
  assert(after>before,'WebGazer must continue receiving video frames while its preview is hidden');
  wg.showVideoPreview(true);wg.showVideo(true);
  return {freshWhileHidden:true,webgazerFramesBefore:before,webgazerFramesAfter:after,sequence:capture.sequence()};
};
window.testReceiverPauseResume=async()=>{
  const feed=document.getElementById('webgazerVideoFeed');
  assert(feed&&typeof feed.getVideoPlaybackQuality==='function','The WebGazer receiving video must expose playback-frame telemetry');
  await feed.play();
  await waitFor(()=>feed.getVideoPlaybackQuality().totalVideoFrames>0,1500,'WebGazer receiver playback');
  const before=feed.getVideoPlaybackQuality().totalVideoFrames;
  feed.pause();await delay(400);
  const paused=feed.getVideoPlaybackQuality().totalVideoFrames;
  assert(paused===before,'Pausing the WebGazer receiver must stop its decoded-frame counter');
  await feed.play();await waitFor(()=>feed.getVideoPlaybackQuality().totalVideoFrames>paused,1500,'WebGazer receiver resume');
  wg.showVideo(true);
  return {receiverPausedFrameCount:before,receiverPausedAfter:paused,receiverResumedFrames:feed.getVideoPlaybackQuality().totalVideoFrames};
};
window.finishIntegration=async()=>{
  await waitFor(()=>accepted===45&&finitePredictions>=12,30000,'45 training samples and finite WebGazer predictions');
  const before=wg.getRegression()[0].getData().length;
  assert(before===45,'Expected exactly 45 accepted WebGazer records, found '+before);
  assert(lastEyeFeatures,'Prediction must expose the actual current eye patches');
  const regression=wg.getRegression()[0],original=regression.predict(lastEyeFeatures),model=window.fitGazeModel(regression);
  assert(model&&window.installGazeModel(regression,model),'Actual pinned ridge must support fitted coefficients');
  const frozen=regression.predict(lastEyeFeatures);
  assert(frozen&&Math.hypot(frozen.x-original.x,frozen.y-original.y)<=2,'Frozen model must agree with upstream prediction within rounding');
  const serialized=JSON.stringify(model);assert(!serialized.includes('patch')&&!serialized.includes('features'),'Saved model contains eye data');
  const fresh=new regression.constructor();assert(window.installGazeModel(fresh,JSON.parse(serialized)),'Restored coefficients must install into an empty regression');
  const resumed=fresh.predict(lastEyeFeatures);assert(resumed&&resumed.x===frozen.x&&resumed.y===frozen.y,'Model reuse changed prediction');
  const result={frozenModelAgreesWithUpstream:true,restoredModelAgrees:true,savedCoefficients:model.x.length*2,landmarkObservations:observations,finitePredictions,acceptedRecords:accepted,retainedRecords:before,sourceSequence:capture.sequence(),adapterFresh:capture.fresh(),backend:capture.info().backend,recordFailures};
  return result;
};
window.cleanupIntegration=async()=>{
  wg.pause();wg.removeMouseEventListeners();
  capture.dispose();try{wg.end()}catch{}
  clearInterval(frameTimer);
  const result={sourceTracksStopped:sourceStream.getTracks().every(track=>track.readyState==='ended'),processedTracksStopped:outputStream.getTracks().every(track=>track.readyState==='ended'),sourceTrackCount:sourceStream.getTracks().length,processedTrackCount:outputStream.getTracks().length};
  assert(result.sourceTracksStopped&&result.processedTracksStopped,'Cleanup must stop both the original and processed camera tracks');
  return result;
};
`;

const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src blob:; worker-src blob:"><style>html,body{margin:0;width:100%;height:100%;background:#17161d;color:#eee;font:14px sans-serif}#webgazerVideoContainer{z-index:2!important}</style></head><body><script src="/vendor/webgazer/webgazer.js"></script><script src="/camera.js"></script><script src="/fixture.js"></script></body></html>`;
await writeFile(join(directory,'index.html'),html);
await writeFile(join(directory,'fixture.js'),fixture);
await writeFile(join(directory,'main.cjs'),`const{app,BrowserWindow,protocol,session}=require('electron');const fs=require('node:fs');const path=require('node:path');const directory=${JSON.stringify(directory)},root=${JSON.stringify(root)},shot=${JSON.stringify(screenshot)};app.setPath('userData',path.join(directory,'profile'));protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);app.whenReady().then(async()=>{const external=[];session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(!details.url.startsWith('echo://app/')&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:'))external.push(details.url);callback({cancel:!details.url.startsWith('echo://app/')&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:')});});protocol.handle('echo',request=>{const name=new URL(request.url).pathname.slice(1);if(name==='index.html')return new Response(fs.readFileSync(path.join(directory,'index.html')),{headers:{'Content-Type':'text/html'}});if(name==='camera.js'||name==='fixture.js')return new Response(fs.readFileSync(path.join(directory,name)),{headers:{'Content-Type':'text/javascript'}});const file=path.join(root,'dist/renderer',name);if(!fs.existsSync(file))return new Response('missing local resource',{status:404});return new Response(fs.readFileSync(file),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.wasm')?'application/wasm':'application/octet-stream'}});});try{const w=new BrowserWindow({show:true,frame:false,width:800,height:600,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.webContents.on('console-message',(_e,level,message)=>{if(level>=2)console.error('WEBGAZER_CROP_PAGE '+message);});await w.loadURL('echo://app/index.html');const started=await w.webContents.executeJavaScript('window.beginIntegration()');w.hide();const hidden=await w.webContents.executeJavaScript('window.verifyHiddenFreshness()');w.show();const receiver=await w.webContents.executeJavaScript('window.testReceiverPauseResume()');const training=await w.webContents.executeJavaScript('window.finishIntegration()');fs.writeFileSync(shot,(await w.webContents.capturePage()).toPNG());const cleanup=await w.webContents.executeJavaScript('window.cleanupIntegration()');if(external.length)throw Error('Unexpected external requests: '+external.join(', '));console.log('WEBGAZER_CROP_INTEGRATION '+JSON.stringify({started,hidden,receiver,training,cleanup,externalRequests:external,screenshot:shot,cameraUsed:false,accuracyTested:false}));app.exit(0)}catch(error){console.error('WEBGAZER_CROP_ERROR '+error.stack);app.exit(1)}});`);

try {
  await new Promise((resolvePromise,reject)=>{
    const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const timeout=setTimeout(()=>{child.kill();reject(Error(output.slice(-5000)||'WebGazer crop integration timed out'))},70000);
    child.on('exit',code=>{clearTimeout(timeout);if(code===0&&output.includes('WEBGAZER_CROP_INTEGRATION ')){console.log(output.split('\n').filter(line=>line.includes('WEBGAZER_CROP_INTEGRATION ')).join('\n'));resolvePromise()}else reject(Error(output.slice(-5000)||`Electron exited ${code} without integration results`))});
  });
} finally {
  await rm(directory,{recursive:true,force:true});
}
