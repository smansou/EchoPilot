// Quality-preserving local crop smoke test with synthetic camera input only.
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import electron from 'electron';

const root=process.cwd(),directory=await mkdtemp('/private/tmp/echo-gaze-camera-');
const screenshotCases=[
  {name:'640x480',width:640,height:480},
  {name:'1280x720',width:1280,height:720,forceFallback:true},
  {name:'1920x1080',width:1920,height:1080},
  {name:'480x640',width:480,height:640},
];
const screenshots=screenshotCases.map(item=>`/private/tmp/echopilot-gaze-camera-${item.name}.png`);

await build({stdin:{contents:"import {planGazeCrop,createGazeCameraCapture} from './apps/desktop/src/renderer/gaze-camera';window.planGazeCrop=planGazeCrop;window.createGazeCameraCapture=createGazeCameraCapture;",resolveDir:root,loader:'tsx'},bundle:true,outfile:join(directory,'camera.js'),platform:'browser',jsx:'automatic'});

const fixture=`
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw Error(message)};
const near=(actual,expected,tolerance=1)=>Math.abs(actual-expected)<=tolerance;
const planKeys=['sourceWidth','sourceHeight','outputWidth','outputHeight','cropX','cropY','cropWidth','cropHeight'];
const expectedPlans=[
  {sourceWidth:1920,sourceHeight:1080,outputWidth:640,outputHeight:480,cropX:480,cropY:180,cropWidth:960,cropHeight:720},
  {sourceWidth:1280,sourceHeight:720,outputWidth:640,outputHeight:480,cropX:320,cropY:120,cropWidth:640,cropHeight:480},
  {sourceWidth:640,sourceHeight:480,outputWidth:640,outputHeight:480,cropX:0,cropY:0,cropWidth:640,cropHeight:480},
  {sourceWidth:320,sourceHeight:240,outputWidth:320,outputHeight:240,cropX:0,cropY:0,cropWidth:320,cropHeight:240},
  {sourceWidth:640,sourceHeight:360,outputWidth:480,outputHeight:360,cropX:80,cropY:0,cropWidth:480,cropHeight:360},
];
function makePattern(width,height){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{willReadFrequently:true});let serial=0;
  const draw=()=>{serial++;for(let y=0;y<height;y+=80){for(let x=0;x<width;x+=80){const r=32+(Math.floor(x/80)*43+Math.floor(y/80)*13)%190,g=35+(Math.floor(x/80)*19+Math.floor(y/80)*47)%185,b=40+(Math.floor(x/80)*31+Math.floor(y/80)*29)%180;context.fillStyle='rgb('+r+','+g+','+b+')';context.fillRect(x,y,Math.min(80,width-x),Math.min(80,height-y));}}context.fillStyle=serial%2?'#ffffff':'#000000';context.fillRect(0,0,8,8);};
  draw();return {canvas,context,draw,get serial(){return serial}};
}
function createSourceStream(pattern){
  const stream=pattern.canvas.captureStream(0),track=stream.getVideoTracks()[0];
  track.requestFrame?.();
  return {stream,track};
}
function installTrackCapabilities(track,width,height){
  const applied=[];
  Object.defineProperty(track,'getCapabilities',{configurable:true,value:()=>({width:{min:width,max:width},height:{min:height,max:height},frameRate:{min:1,max:30},zoom:{min:1,max:4,step:.1}})});
  Object.defineProperty(track,'getSettings',{configurable:true,value:()=>({width,height,frameRate:30})});
  Object.defineProperty(track,'applyConstraints',{configurable:true,value:async constraints=>{applied.push(constraints)}});
  return applied;
}
function samplePoints(plan){
  const points=[];
  for(let y=9;y<plan.outputHeight-9&&points.length<5;y+=7)for(let x=9;x<plan.outputWidth-9&&points.length<5;x+=7){
    const sx=plan.cropX+Math.floor((x+.5)*plan.cropWidth/plan.outputWidth),sy=plan.cropY+Math.floor((y+.5)*plan.cropHeight/plan.outputHeight);
    if(sx%80>18&&sx%80<62&&sy%80>18&&sy%80<62)points.push({x,y,sx,sy});
  }
  assert(points.length>=4,'Could not find stable pixel samples inside the source pattern');return points;
}
function supportsConstraints(){
  const media=navigator.mediaDevices,original=media.getSupportedConstraints?.bind(media);
  media.getSupportedConstraints=()=>({...original?.(),resizeMode:true});
}
let encodingCalls=0;
for(const name of ['toDataURL','toBlob']){const original=HTMLCanvasElement.prototype[name];if(original)HTMLCanvasElement.prototype[name]=function(...args){encodingCalls++;return original.apply(this,args)}}
if(globalThis.OffscreenCanvas?.prototype?.convertToBlob){const original=OffscreenCanvas.prototype.convertToBlob;OffscreenCanvas.prototype.convertToBlob=function(...args){encodingCalls++;return original.apply(this,args)}}
let active=null;
window.runPlanTests=()=>{
  const plans=[];
  for(const expected of expectedPlans){
    const plan=window.planGazeCrop(expected.sourceWidth,expected.sourceHeight,1.5);
    for(const key of planKeys)assert(plan[key]===expected[key],key+' mismatch for '+expected.sourceWidth+'x'+expected.sourceHeight+': '+plan[key]+' !== '+expected[key]);
    assert(plan.cropX===(plan.sourceWidth-plan.cropWidth)/2&&plan.cropY===(plan.sourceHeight-plan.cropHeight)/2,'Crop must stay centered');
    assert(plan.cropWidth>=plan.outputWidth&&plan.cropHeight>=plan.outputHeight,'Plan must never upscale input pixels');
    assert(plan.outputWidth%4===0&&plan.outputHeight%3===0&&plan.outputWidth/plan.outputHeight===4/3,'Output must use a 4:3 frame');
    assert(Number.isFinite(plan.zoom)&&plan.zoom>=1,'Plan zoom must be finite and at least 1');
    plans.push(plan);
  }
  return plans;
};
window.openCaptureCase=async({name,width,height,forceFallback=false})=>{
  assert(!active,'Previous capture case was not disposed');
  supportsConstraints();
  const pattern=makePattern(width,height),source=createSourceStream(pattern),applied=installTrackCapabilities(source.track,width,height),requests=[];
  const sourceTimer=setInterval(()=>{pattern.draw();source.track.requestFrame?.()},30);
  const capture=window.createGazeCameraCapture(async constraints=>{requests.push(constraints);return source.stream});
  const nativeProcessor=globalThis.MediaStreamTrackProcessor;
  if(forceFallback)globalThis.MediaStreamTrackProcessor=undefined;
  let outputStream;
  try{outputStream=await capture.open()}finally{if(forceFallback)globalThis.MediaStreamTrackProcessor=nativeProcessor}
  const plan=capture.info()?.plan;
  assert(plan&&plan.sourceWidth===width&&plan.sourceHeight===height,'Capture info must expose the actual input crop plan');
  assert(requests.length===1,'A capture must request the camera exactly once');
  assert(requests[0].audio===false,'Camera request must be video-only');
  const videoConstraints=requests[0].video;
  const widthConstraint=videoConstraints?.width,heightConstraint=videoConstraints?.height;
  const requestedWidth=typeof widthConstraint==='number'?widthConstraint:(widthConstraint?.ideal||widthConstraint?.max||widthConstraint?.exact);
  const requestedHeight=typeof heightConstraint==='number'?heightConstraint:(heightConstraint?.ideal||heightConstraint?.max||heightConstraint?.exact);
  assert(requestedWidth===1920&&requestedHeight===1080,'Camera request must ask for a 1920x1080 source');
  assert(videoConstraints.resizeMode==='none'||videoConstraints.resizeMode?.exact==='none','When resizeMode is supported, request must use resizeMode:none');
  assert(capture.info().zoomCapabilityExposed===true,'Reported camera zoom capability must be exposed as metadata');
  assert(capture.info().sourceFrameRate===30,'Camera frame rate metadata should be reported when available');
  assert(capture.info().backend===(forceFallback?'video-element':'video-frame'),'Unexpected camera frame-processing backend: '+capture.info().backend);
  assert(applied.length===0,'Capability reporting must not apply physical zoom constraints');
  assert(outputStream instanceof MediaStream&&outputStream.getVideoTracks().length===1,'Capture must return one processed video track');
  const outputTrack=outputStream.getVideoTracks()[0];
  const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.srcObject=outputStream;document.body.append(video);
  await video.play().catch(()=>{});
  await waitFor(()=>video.readyState>=2&&video.videoWidth===plan.outputWidth&&video.videoHeight===plan.outputHeight,4000,'processed output metadata');
  const pixels=document.createElement('canvas');pixels.width=plan.outputWidth;pixels.height=plan.outputHeight;const pixelContext=pixels.getContext('2d',{willReadFrequently:true});
  pixelContext.drawImage(video,0,0,plan.outputWidth,plan.outputHeight);
  const samples=samplePoints(plan).map(point=>{
    const sourcePixel=pattern.context.getImageData(point.sx,point.sy,1,1).data,outputPixel=pixelContext.getImageData(point.x,point.y,1,1).data;
    assert([0,1,2].every(channel=>Math.abs(sourcePixel[channel]-outputPixel[channel])<=4),'Output pixel does not match its center-cropped source position at '+point.x+','+point.y);
    return {out:[point.x,point.y],source:[point.sx,point.sy],rgb:Array.from(outputPixel).slice(0,3)};
  });
  await waitFor(()=>capture.fresh()&&capture.sequence()>0,1200,'fresh processed camera frames');
  const initialSequence=capture.sequence();await delay(120);
  assert(capture.sequence()>initialSequence,'The capture sequence must advance as new source frames arrive');
  assert(encodingCalls===0,'Camera pixels must stay in memory without image encoding');
  active={name,width,height,pattern,source,sourceTimer,timer:sourceTimer,applied,requests,capture,outputStream,outputTrack,video,outputCanvas:pixels};
  return {name,plan,backend:capture.info().backend,sequence:capture.sequence(),output:{width:video.videoWidth,height:video.videoHeight},request:requests[0],zoomCapabilityExposed:capture.info().zoomCapabilityExposed,physicalZoomCalls:applied.length,pixelSamples:samples,encodedImageCalls:encodingCalls};
};
window.testStallAndResume=async()=>{
  assert(active,'No active capture');
  clearInterval(active.timer);
  await delay(480);
  assert(!active.capture.fresh(),'Freshness must expire when source frames stall');
  active.timer=setInterval(()=>{active.pattern.draw();active.source.track.requestFrame?.()},30);
  await waitFor(()=>active.capture.fresh(),1500,'fresh frames after source resumes');
  return {staleAfterSourceStall:true,freshAfterResume:true};
};
window.testSourceEnded=async()=>{
  assert(active,'No active capture');active.source.track.stop();await delay(50);
  assert(!active.capture.fresh(),'Freshness must fall immediately when the source track ends');
  return {freshnessFalseAfterSourceEnded:true};
};
window.testHiddenCapture=async()=>{
  assert(active,'No active capture');await delay(500);
  assert(active.capture.fresh(),'Capture freshness must continue while the Electron window is hidden');
  return {freshWhileHidden:true};
};
window.testResolutionChange=async()=>{
  assert(active,'No active capture');
  const outputTrack=active.outputTrack;
  active.pattern.canvas.width=active.width+16;active.pattern.canvas.height=active.height;
  active.pattern.draw();active.source.track.requestFrame?.();
  await waitFor(()=>active.video.videoWidth!==active.width||outputTrack.readyState==='ended',2000,'source resolution change');
  await waitFor(()=>outputTrack.readyState==='ended',1500,'processed output to fail closed');
  assert(!active.capture.fresh(),'Resolution changes must invalidate freshness');
  assert(active.capture.problem()?.includes('format'),'A format change should explain why capture stopped');
  return {resolutionChangeFailedClosed:true,outputTrackState:outputTrack.readyState};
};
window.disposeActive=async()=>{
  if(!active)return null;
  const value=active;
  value.capture.dispose();
  clearInterval(value.timer);
  value.video.pause();value.video.srcObject=null;value.video.remove();
  await delay(80);
  const disposed={sourceStopped:value.source.track.readyState==='ended',outputStopped:value.outputTrack.readyState==='ended'};
  assert(disposed.sourceStopped,'dispose() must stop the original camera track');
  assert(disposed.outputStopped,'dispose() must stop the processed output track');
  active=null;return disposed;
};
window.testPendingDisposal=async()=>{
  let resolvePermission;const pendingRequests=[];
  const pending=window.createGazeCameraCapture(constraints=>{pendingRequests.push(constraints);return new Promise(resolve=>resolvePermission=resolve)});
  let settled=false;const open=pending.open().then(stream=>({stream}),error=>({error:String(error)})).then(result=>{settled=true;return result});
  await waitFor(()=>resolvePermission,1000,'camera permission request');
  pending.dispose();
  await waitFor(()=>settled,250,'pending open to reject immediately after disposal');
  assert(settled,'dispose() must settle a pending OS permission request without waiting for the OS');
  const latePattern=makePattern(640,480),late=createSourceStream(latePattern);
  resolvePermission(late.stream);
  const result=await open;
  await delay(100);
  assert(result.error||!result.stream,'Opening after dispose must not expose the late source stream');
  assert(result.error?.includes('AbortError'),'Late permission should reject with AbortError after disposal');
  assert(late.track.readyState==='ended','dispose() during pending permission must stop the late-arriving camera track');
  assert(pendingRequests.length===1,'Pending permission path should issue one video-only request');
  return {disposedDuringPermission:true,lateSourceStopped:true};
};
function waitFor(predicate,timeout,label){return new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(predicate())return resolve();if(Date.now()-start>timeout)return reject(Error('Timed out waiting for '+label));setTimeout(poll,20)};poll()})}
`;

const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; media-src blob:; connect-src 'self'; worker-src blob:"><style>html,body{margin:0;width:100%;height:100%;background:#191820;color:#eee;font:14px sans-serif}body{display:grid;place-items:center}video{width:640px;height:480px;max-width:90vw;max-height:75vh;object-fit:contain;border:1px solid #756780;border-radius:10px;background:#292630}</style></head><body><script src="/camera.js"></script><script src="/fixture.js"></script></body></html>`;
await writeFile(join(directory,'index.html'),html);
await writeFile(join(directory,'fixture.js'),fixture);
await writeFile(join(directory,'main.cjs'),`const{app,BrowserWindow,protocol,session}=require('electron');const fs=require('node:fs');const path=require('node:path');const directory=${JSON.stringify(directory)},root=${JSON.stringify(root)},shots=${JSON.stringify(screenshots)};app.setPath('userData',path.join(directory,'profile'));protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);app.whenReady().then(async()=>{const external=[];session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(!details.url.startsWith('echo://app/')&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:'))external.push(details.url);callback({cancel:!details.url.startsWith('echo://app/')&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:')});});protocol.handle('echo',request=>{const name=new URL(request.url).pathname.slice(1);if(name==='index.html')return new Response(fs.readFileSync(path.join(directory,'index.html')),{headers:{'Content-Type':'text/html'}});if(name==='camera.js'||name==='fixture.js')return new Response(fs.readFileSync(path.join(directory,name)),{headers:{'Content-Type':'text/javascript'}});return new Response('not found',{status:404});});try{const w=new BrowserWindow({show:true,frame:false,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.webContents.on('console-message',(_e,level,message)=>{if(level>=2)console.error('GAZE_CAMERA_PAGE '+message);});await w.loadURL('echo://app/index.html');const plans=await w.webContents.executeJavaScript('window.runPlanTests()');const results=[];for(let i=0;i<${screenshotCases.length};i++){const result=await w.webContents.executeJavaScript('window.openCaptureCase('+JSON.stringify(${JSON.stringify(screenshotCases)}[i])+')');const image=await w.webContents.capturePage();fs.writeFileSync(shots[i],image.toPNG());if(i===0||i===1){w.hide();results.push(await w.webContents.executeJavaScript('window.testHiddenCapture()'));w.show();results.push(await w.webContents.executeJavaScript('window.testStallAndResume()'));if(i===0)results.push(await w.webContents.executeJavaScript('window.testSourceEnded()'));}if(i===2)results.push(await w.webContents.executeJavaScript('window.testResolutionChange()'));results.push(result);results.push(await w.webContents.executeJavaScript('window.disposeActive()'));}results.push(await w.webContents.executeJavaScript('window.testPendingDisposal()'));if(external.length)throw Error('Unexpected network requests: '+external.join(', '));console.log('GAZE_CAMERA '+JSON.stringify({plans,results,screenshots:shots,externalRequests:external,cameraUsed:false}));app.exit(0)}catch(error){console.error('GAZE_CAMERA_ERROR '+error.stack);app.exit(1)}});`);

try {
  await new Promise((resolvePromise,reject)=>{
    const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const timeout=setTimeout(()=>{child.kill();reject(Error(output.slice(-5000)||'Electron gaze camera smoke timed out'))},60000);
    child.on('exit',code=>{clearTimeout(timeout);if(code===0&&output.includes('GAZE_CAMERA ')){console.log(output.split('\n').filter(line=>line.includes('GAZE_CAMERA ')).join('\n'));resolvePromise()}else reject(Error(output.slice(-5000)||`Electron exited ${code} without a camera result`))});
  });
} finally {
  await rm(directory,{recursive:true,force:true});
}
