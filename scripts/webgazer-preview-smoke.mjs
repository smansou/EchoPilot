// Real vendored WebGazer preview DOM, fed only synthetic canvas streams.
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import electron from 'electron';

const root=process.cwd(),directory=await mkdtemp('/private/tmp/echo-webgazer-preview-');
const reproduceOldCss=process.argv.includes('--reproduce-old-css');
const cases=[{name:'640x480',width:640,height:480},{name:'1280x720',width:1280,height:720},{name:'480x640',width:480,height:640}];
const screenshots=cases.map(test=>`/private/tmp/echopilot-preview-${test.name}.png`);

await build({stdin:{contents:"import './apps/desktop/src/renderer/desktop.css';import './apps/desktop/src/renderer/webgazer-calibration.css';import {sizeWebGazerPreview} from './apps/desktop/src/renderer/webgazer-preview';window.sizeWebGazerPreview=sizeWebGazerPreview;",resolveDir:root,loader:'tsx'},bundle:true,outfile:join(directory,'preview.js'),platform:'browser',jsx:'automatic'});

const fixture=`
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw Error(message)};
const near=(actual,expected,tolerance=1)=>Math.abs(actual-expected)<=tolerance;
window.runPreviewCase=async({name,width,height})=>{
  const wg=window.webgazer;
  assert(wg&&window.sizeWebGazerPreview,'Vendored WebGazer or production preview helper did not load');
  let sizingCalls=0;
  const setViewerSize=wg.setVideoViewerSize.bind(wg);
  wg.setVideoViewerSize=(w,h)=>{sizingCalls++;return setViewerSize(w,h)};
  const emptyVideo=document.createElement('video');emptyVideo.style.width='77px';emptyVideo.style.height='55px';
  window.sizeWebGazerPreview(wg,emptyVideo);
  assert(sizingCalls===0,'Zero video metadata must not resize the WebGazer preview');
  assert(emptyVideo.style.width==='77px'&&emptyVideo.style.height==='55px','Zero metadata changed preview sizing');

  const source=document.createElement('canvas');source.width=width;source.height=height;
  const context=source.getContext('2d');
  let frame=0;
  const draw=()=>{frame++;context.fillStyle='#393442';context.fillRect(0,0,width,height);context.fillStyle='#b39acb';context.fillRect(Math.floor((frame%10)*width/10),Math.floor(height*.2),Math.max(8,width/18),Math.max(8,height/20));context.strokeStyle='#80c29b';context.lineWidth=Math.max(2,Math.round(Math.min(width,height)/150));context.strokeRect(width*.22,height*.08,width*.56,height*.84)};
  draw();window.redraw=setInterval(draw,40);window.stream=source.captureStream(25);
  navigator.mediaDevices.getUserMedia=async()=>window.stream;
  class PreviewFixtureTracker {getEyePatches(){return null}drawFaceOverlay(){}getPositions(){return null}reset(){}}
  wg.addTrackerModule('PreviewFixture',PreviewFixtureTracker);
  wg.params.faceMeshSolutionPath='echo://app/vendor/webgazer/mediapipe/face_mesh';
  wg.params.showVideo=true;wg.params.showFaceOverlay=true;wg.params.showFaceFeedbackBox=true;wg.params.videoViewerWidth=240;wg.params.videoViewerHeight=180;
  wg.saveDataAcrossSessions(false).setRegression('ridge').setTracker('PreviewFixture').applyKalmanFilter(false).showPredictionPoints(false).showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);
  await wg.begin();
  const video=document.getElementById('webgazerVideoFeed'),overlay=document.getElementById('webgazerFaceOverlay'),feedback=document.getElementById('webgazerFaceFeedbackBox'),container=document.getElementById('webgazerVideoContainer'),trackingCanvas=wg.getVideoElementCanvas();
  await waitFor(()=>video&&video.videoWidth===width&&video.videoHeight===height&&overlay&&feedback,5000);
  const sizeCallsBeforeHelper=sizingCalls;
  window.sizeWebGazerPreview(wg,video);
  await delay(60);
  assert(sizingCalls===sizeCallsBeforeHelper+1,'Production helper should size the ready video exactly once');
  const videoRect=video.getBoundingClientRect(),overlayRect=overlay.getBoundingClientRect(),feedbackRect=feedback.getBoundingClientRect(),containerRect=container.getBoundingClientRect();
  const expected=wg.computeValidationBoxSize();
  const validation={top:parseFloat(feedback.style.top),left:parseFloat(feedback.style.left),width:parseFloat(feedback.style.width),height:parseFloat(feedback.style.height)};
  assert(videoRect.width>0&&videoRect.height>0,'The actual WebGazer preview video has no displayed size');
  assert(near(videoRect.width/videoRect.height,width/height,.015),'Preview aspect ratio does not match native camera dimensions');
  assert(near(overlayRect.left,videoRect.left)&&near(overlayRect.top,videoRect.top)&&near(overlayRect.width,videoRect.width)&&near(overlayRect.height,videoRect.height),'Face overlay is not aligned to the visible video');
  assert(near(feedbackRect.width,feedbackRect.height),'Face feedback box was stretched into a rectangle');
  assert(feedbackRect.left>=videoRect.left-1&&feedbackRect.top>=videoRect.top-1&&feedbackRect.right<=videoRect.right+1&&feedbackRect.bottom<=videoRect.bottom+1,'Face feedback box extends outside the displayed video');
  assert(near(feedbackRect.left+feedbackRect.width/2,videoRect.left+videoRect.width/2)&&near(feedbackRect.top+feedbackRect.height/2,videoRect.top+videoRect.height/2),'Face feedback square is not centered in the displayed video');
  assert(near(validation.top,expected[0])&&near(validation.left,expected[1])&&near(validation.width,expected[2])&&near(validation.height,expected[3]),'Feedback square CSS geometry differs from WebGazer computeValidationBoxSize()');
  assert(near(feedbackRect.width,expected[2])&&near(feedbackRect.height,expected[3]),'Displayed feedback square differs from WebGazer validation size');
  const scaleX=videoRect.width/width,scaleY=videoRect.height/height;
  const sourceSquare={left:(feedbackRect.left-videoRect.left)/scaleX,top:(feedbackRect.top-videoRect.top)/scaleY,size:feedbackRect.width/scaleX};
  const expectedSourceSize=Math.min(width,height)*wg.params.faceFeedbackBoxRatio;
  assert(near(sourceSquare.size,expectedSourceSize,1.5),'Displayed feedback square maps to the wrong source-space validation size');
  assert(near(sourceSquare.left,(width-expectedSourceSize)/2,1.5)&&near(sourceSquare.top,(height-expectedSourceSize)/2,1.5),'Displayed feedback square maps away from the centered source-space validation square');
  assert(near(trackingCanvas.width,width,0)&&near(trackingCanvas.height,height,0),'WebGazer internal sensor canvas resolution was changed');
  assert(near(video.videoWidth,width,0)&&near(video.videoHeight,height,0),'Camera stream intrinsic resolution was changed');
  assert(videoRect.left>=containerRect.left-1&&videoRect.top>=containerRect.top-1&&videoRect.right<=containerRect.right+1&&videoRect.bottom<=containerRect.bottom+1,'Fitted video escapes the WebGazer preview container');
  wg.pause();
  return {name,width,height,display:{x:videoRect.x,y:videoRect.y,width:videoRect.width,height:videoRect.height},container:{width:containerRect.width,height:containerRect.height},overlay:{x:overlayRect.x,y:overlayRect.y,width:overlayRect.width,height:overlayRect.height},feedback:{x:feedbackRect.x,y:feedbackRect.y,width:feedbackRect.width,height:feedbackRect.height},validation,sourceSquare,sourceResolution:{width:trackingCanvas.width,height:trackingCanvas.height},zeroMetadataNoOp:true,secureContext:isSecureContext};
};
function waitFor(predicate,timeout){return new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(predicate())return resolve();if(Date.now()-start>timeout)return reject(Error('Timed out waiting for WebGazer loadeddata preview DOM'));setTimeout(poll,20)};poll()})}
window.cleanupPreviewCase=()=>{clearInterval(window.redraw);window.webgazer?.end();window.stream?.getTracks().forEach(track=>track.stop())};
`;

const oldCss=reproduceOldCss?'<style>#webgazerVideoContainer{width:240px!important;height:180px!important}#webgazerVideoContainer video,#webgazerVideoContainer canvas{width:100%!important;height:100%!important;object-fit:cover!important}</style>':'';
const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src blob:; worker-src blob:"><link rel="stylesheet" href="/preview.css">${oldCss}</head><body><main class="gaze-calibration"></main><script src="/vendor/webgazer/webgazer.js"></script><script src="/preview.js"></script><script src="/fixture.js"></script></body></html>`;
await writeFile(join(directory,'index.html'),html);
await writeFile(join(directory,'fixture.js'),fixture);
await writeFile(join(directory,'main.cjs'),`const{app,BrowserWindow,protocol,session}=require('electron');const fs=require('node:fs');const path=require('node:path');const root=${JSON.stringify(root)},directory=${JSON.stringify(directory)},cases=${JSON.stringify(cases)},shots=${JSON.stringify(screenshots)};app.setPath('userData',path.join(directory,'profile'));app.on('window-all-closed',()=>{});protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);app.whenReady().then(async()=>{const external=[];session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(!details.url.startsWith('echo://app/')&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:'))external.push(details.url);callback({cancel:!details.url.startsWith('echo://app/')&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:')});});protocol.handle('echo',request=>{const name=new URL(request.url).pathname.slice(1);if(name==='index.html')return new Response(fs.readFileSync(path.join(directory,'index.html')),{headers:{'Content-Type':'text/html'}});if(name==='preview.js'||name==='preview.css'||name==='fixture.js')return new Response(fs.readFileSync(path.join(directory,name)),{headers:{'Content-Type':name.endsWith('.css')?'text/css':'text/javascript'}});const file=path.join(root,'dist/renderer',name);if(!fs.existsSync(file))return new Response('missing local resource',{status:404});return new Response(fs.readFileSync(file),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.wasm')?'application/wasm':'application/octet-stream'}});});try{const results=[];for(let i=0;i<cases.length;i++){const w=new BrowserWindow({show:true,frame:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.webContents.on('console-message',(_e,level,message)=>{if(level>=2)console.error('PREVIEW_PAGE '+message);});await w.loadURL('echo://app/index.html');const result=await w.webContents.executeJavaScript('window.runPreviewCase('+JSON.stringify(cases[i])+')');const image=await w.webContents.capturePage();fs.writeFileSync(shots[i],image.toPNG());await w.webContents.executeJavaScript('window.cleanupPreviewCase()');w.destroy();results.push(result)}if(external.length)throw Error('Unexpected external resource requests: '+external.join(', '));console.log('WEBGAZER_PREVIEW '+JSON.stringify({results,screenshots:shots,externalRequests:external,cameraUsed:false,reproducedOldCss:${reproduceOldCss}}));app.exit(0)}catch(error){console.error('PREVIEW_ERROR '+error.stack);app.exit(1)}});`);

try {
  await new Promise((resolvePromise,reject)=>{
    const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const timeout=setTimeout(()=>{child.kill();reject(Error(output.slice(-5000)||'Electron preview smoke timed out'))},50000);
    child.on('exit',code=>{clearTimeout(timeout);if(code===0&&output.includes('WEBGAZER_PREVIEW ')){console.log(output.split('\n').filter(line=>line.includes('WEBGAZER_PREVIEW')).join('\n'));resolvePromise()}else reject(Error(output.slice(-5000)||`Electron exited ${code} without a preview result`))});
  });
} finally {
  await rm(directory,{recursive:true,force:true});
}
