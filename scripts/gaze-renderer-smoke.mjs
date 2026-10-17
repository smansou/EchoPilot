import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const root = process.cwd();
const stallVariant = process.argv.includes('--stall-camera');
const compact = process.argv.includes('--compact');
if (process.argv.includes('--real')) {
  throw new Error('--real is gated off in this guided-renderer smoke. A static-face fixture cannot validate human gaze accuracy.');
}

const directory = await mkdtemp('/private/tmp/echo-gaze-renderer-');
const outputPath = resolve(compact?'artifacts/gaze-renderer-compact-acceptance.json':'artifacts/gaze-renderer-acceptance.json');

// This is an API-compatible deterministic fake, not an accuracy fixture. It requests its
// stream through the renderer's production adapter, follows visible targets, and records the
// same 45 deliberate samples. The underlying 1920x1080 source is a local synthetic canvas.
const stub = String.raw`
(() => {
  // This synthetic-camera fixture must not depend on the user leaving their
  // desktop idle. Explicit blur/pause behaviour is tested in the UI fixture.
  window.addEventListener('blur',()=>queueMicrotask(()=>window.dispatchEvent(new Event('focus'))));
  let callback = () => {}, timer = null, sourceTimer = null, paused = false, active = false;
  let sourceStream = null, sourceTrack = null, outputStream = null, outputTrack = null;
  let sourceDrawCount = 0, sourceConstraints = null, previewCount = 0;
  const samples = [];
  class FixtureReg {
    constructor(){this.init();}
    init(){this.eyeFeaturesClicks={data:[]};this.screenXClicksArray={data:[]};this.screenYClicksArray={data:[]};this.ridgeParameter=1e-5;}
    addData(eyes,position){this.eyeFeaturesClicks.data.push([1,position[0]/1000,position[1]/1000]);this.screenXClicksArray.data.push([position[0]]);this.screenYClicksArray.data.push([position[1]]);}
    getData(){return samples;}
    predict(){return null;}
  }
  const regression=new FixtureReg();
  const container = document.createElement('div');
  container.id = 'webgazerVideoContainer';
  container.style.position='fixed';container.style.top='24px';container.style.left='50%';container.style.transform='translateX(-50%)';
  const video = document.createElement('video');
  video.id='webgazerVideoFeed';
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  container.appendChild(video);
  const feedback = document.createElement('canvas');
  feedback.id = 'webgazerFaceFeedbackBox';
  feedback.style.position='absolute';
  feedback.style.borderColor = 'green';
  feedback.style.border = '3px solid green';
  container.appendChild(feedback);
  const face = document.createElement('canvas');
  face.id = 'webgazerFaceOverlay';
  face.style.position='absolute';
  container.appendChild(face);
  function reportTrackStopped(which) {
    void window.echo.desktop({action:'__fixture-track-stopped',which}).catch(()=>{});
  }
  function instrument(track,which) {
    let reported=false;const stop=track.stop.bind(track);
    if(which==='source'){const settings=track.getSettings.bind(track);Object.defineProperty(track,'getSettings',{value:()=>({...settings(),deviceId:'fixture-camera-stable'})});}
    Object.defineProperty(track,'stop',{configurable:true,value(){if(!reported){reported=true;reportTrackStopped(which)}stop();}});
    return track;
  }
  const sourceCanvas=document.createElement('canvas');sourceCanvas.width=1920;sourceCanvas.height=1080;
  const sourceContext=sourceCanvas.getContext('2d');
  function drawSource() {
    sourceDrawCount++;
    sourceContext.fillStyle='#292832';sourceContext.fillRect(0,0,1920,1080);
    sourceContext.fillStyle='#81708c';sourceContext.fillRect(480,180,960,720);
    sourceContext.fillStyle=sourceDrawCount%2?'#e7caef':'#8d7d98';sourceContext.fillRect(2,2,12,12);
    sourceTrack?.requestFrame?.();
  }
  drawSource();sourceStream=sourceCanvas.captureStream(0);sourceTrack=instrument(sourceStream.getVideoTracks()[0],'source');
  drawSource();
  sourceTimer=setInterval(drawSource,34);
  const originalMediaGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{
    sourceConstraints=constraints;
    if(constraints?.audio!==false||!constraints?.video)throw Error('Fixture expected a video-only camera request.');
    return sourceStream;
  };

  function prediction() {
    const dot = document.querySelector('.calibration-dot');
    if (!dot) return window.fixturePrediction || { x: innerWidth / 2, y: innerHeight / 2 };
    const style = getComputedStyle(dot);
    return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top) };
  }
  const webgazer = window.webgazer = {
    params: {},
    async begin() {
      outputStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:640},height:{ideal:480}}});
      outputTrack=instrument(outputStream.getVideoTracks()[0],'processed');
      video.srcObject=outputStream;
      document.body.appendChild(container);
      await video.play();
      if(video.videoWidth<=0||video.videoHeight<=0)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Fixture receiving video did not load.')),5000);video.addEventListener('loadeddata',()=>{clearTimeout(timeout);resolve()},{once:true})});
      this.setVideoViewerSize(240,180);
      active = true; paused = false;
      timer = setInterval(() => { if (active && !paused) callback(prediction()); }, 16);
      return this;
    },
    pause() { paused = true; clearInterval(timer); timer = null; return this; },
    end() { active = false; clearInterval(timer); timer = null; container.remove(); return this; },
    async clearData() { regression.init();samples.length = 0; return this; },
    showFaceOverlay() { return this; },
    showFaceFeedbackBox() { return this; },
    setVideoViewerSize(width,height) {
      container.style.width=width+'px';container.style.height=height+'px';
      video.style.position='absolute';video.style.left='0';video.style.top='0';video.style.width=width+'px';video.style.height=height+'px';
      face.width=video.videoWidth;face.height=video.videoHeight;face.style.width=width+'px';face.style.height=height+'px';face.style.left='0';face.style.top='0';
      const size=Math.min(video.videoWidth,video.videoHeight)*.66*(width/video.videoWidth);
      feedback.style.width=size+'px';feedback.style.height=size+'px';feedback.style.left=((width-size)/2)+'px';feedback.style.top=((height-size)/2)+'px';
      return this;
    },
    getRegression() { return [regression]; },
    setRegression() { return this; },
    setTracker() { return this; },
    applyKalmanFilter() { return this; },
    showVideoPreview(value) { container.style.display = value ? 'block' : 'none'; return this; },
    showPredictionPoints() { return this; },
    saveDataAcrossSessions() { return this; },
    removeMouseEventListeners() { return this; },
    recordScreenPosition(x, y, type) { samples.push({ x, y, type });regression.addData(null,[x,y]); return this; },
    setGazeListener(fn) { callback = fn; return this; },
    getTracker() { return { getPositions: () => {
      const face=Array.from({length:468},()=>[0,0,0]);if(window.fixtureEyesClosed)return face;
      for(const [a,b] of [[33,133],[362,263]]){face[a]=[0,0,0];face[b]=[20,0,0];}
      for(const i of [159,158,386,385])face[i]=[10,-3,0];
      for(const i of [145,153,374,380])face[i]=[10,3,0];
      return face;
    } }; },
  };
  window.fixtureTracksReleased = () => sourceTrack?.readyState === 'ended' && outputTrack?.readyState === 'ended';
  window.fixtureTrainingCount = () => samples.length;
  window.fixtureSourceDrawCount = () => sourceDrawCount;
  window.fixtureSourceConstraints = () => sourceConstraints;
  window.fixtureFreezeSource = () => { clearInterval(sourceTimer); sourceTimer=null; };
  window.fixtureResumeSource = () => { if(!sourceTimer)sourceTimer=setInterval(drawSource,34); };
})();
`;

const fixture = `
import { app, BrowserWindow, protocol, screen, ipcMain, session } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWebGazerHost } from './apps/desktop/src/main/webgazer-host';
import { createGazeOverlay } from './apps/desktop/src/main/gaze-overlay';

app.on('window-all-closed', () => {});
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async () => {
  let overlay,savedProfile=null,showPointer=true;
  try {
    const externalRequests = [];
    let mockSourceTrackReleased=false,mockProcessedTrackReleased=false;
    session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      if (!details.url.startsWith('echo://app/') && !details.url.startsWith('data:') && !details.url.startsWith('blob:')) externalRequests.push(details.url);
      done({cancel: !details.url.startsWith('echo://app/') && !details.url.startsWith('data:') && !details.url.startsWith('blob:')});
    });
    const renderer = ${JSON.stringify(resolve('dist/renderer'))};
    protocol.handle('echo', request => {
      const name = new URL(request.url).pathname.slice(1);
      if (name === 'vendor/webgazer/webgazer.js') return new Response(${JSON.stringify(stub)}, {headers:{'Content-Type':'text/javascript'}});
      const data = readFileSync(join(renderer, name));
      return new Response(data, {headers:{'Content-Type':name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.wasm')?'application/wasm':'application/octet-stream'}});
    });
    const display = screen.getPrimaryDisplay();
    const host = createWebGazerHost({bundleDir:'',activeProjectId:()=> 'desktop',displays:()=>[{displayId:String(display.id),originX:display.bounds.x,originY:display.bounds.y,width:display.bounds.width,height:display.bounds.height,scale:display.scaleFactor,arrangementGeneration:1}]});
    overlay = createGazeOverlay({loadProfile:()=>savedProfile,saveProfile:(_id,profile)=>{savedProfile=profile;},showPointer:()=>showPointer,host,bundleDir:${JSON.stringify(resolve('dist/main'))},projectId:()=> 'desktop'});
    ipcMain.handle('echo:desktop',(event,input)=>{if(input?.action==='__fixture-track-stopped'){if(input.which==='source')mockSourceTrackReleased=true;if(input.which==='processed')mockProcessedTrackReleased=true;return {ok:true};}return overlay.handle(event.sender,input);});
    const calibrationStartedAt=Date.now();
    await overlay.start(String(display.id));
    const stallCamera=${stallVariant};
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw Error('Calibration window did not open.');
    if(${compact})window.setContentSize(800,600);
    const run = code => window.webContents.executeJavaScript(code);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (expression, label, timeout=15000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await run(expression)) return; await wait(40); }
      throw Error('Timed out waiting for ' + label + '. UI: '+await run("document.body.innerText"));
    };

    // Step through the actual tutorial, start camera setup, and use its real buttons to provide
    // five deliberate clicks at every training target. The fake module does not auto-train.
    await until("document.querySelector('.calibration-tutorial__next')", 'tutorial');
    for (let step=0; step<3; step++) {
      await run("document.querySelector('.calibration-tutorial__next').click()");
      await wait(30);
    }
    await until("document.querySelector('.calibration-start') && !document.querySelector('.calibration-start').disabled", 'camera setup readiness');
    const cameraFixture = await run("({request:window.fixtureSourceConstraints(),video:{width:document.getElementById('webgazerVideoFeed')?.videoWidth,height:document.getElementById('webgazerVideoFeed')?.videoHeight},feedback:(()=>{const video=document.getElementById('webgazerVideoFeed')?.getBoundingClientRect(),box=document.getElementById('webgazerFaceFeedbackBox')?.getBoundingClientRect();return video&&box?{video:{x:video.x,y:video.y,width:video.width,height:video.height},box:{x:box.x,y:box.y,width:box.width,height:box.height}}:null})()})");
    const widthRequest=cameraFixture.request?.video?.width,heightRequest=cameraFixture.request?.video?.height;
    if((widthRequest?.ideal||widthRequest?.max)!==1920||(heightRequest?.ideal||heightRequest?.max)!==1080)throw Error('Renderer did not route its original camera request through the high-resolution crop adapter.');
    if(cameraFixture.request.audio!==false)throw Error('The production crop adapter did not keep its fake camera request video-only.');
    if(cameraFixture.video.width!==640||cameraFixture.video.height!==480)throw Error('The fake WebGazer did not receive the adapter’s 640x480 processed stream.');
    const feedback=cameraFixture.feedback;
    if(!feedback||Math.abs(feedback.box.width-feedback.box.height)>1||Math.abs((feedback.box.x+feedback.box.width/2)-(feedback.video.x+feedback.video.width/2))>2||Math.abs((feedback.box.y+feedback.box.height/2)-(feedback.video.y+feedback.video.height/2))>2)throw Error('The fake WebGazer feedback box is not square and centered inside the received preview.');
    await run("document.querySelector('.calibration-start').click()");
    await wait(900);
    const layout=await run("(()=>{const dot=document.querySelector('.calibration-dot').getBoundingClientRect(),preview=document.getElementById('webgazerVideoContainer').getBoundingClientRect(),help=document.querySelector('.calibration-target-help').getBoundingClientRect(),stop=document.querySelector('.gaze-cancel').getBoundingClientRect();const separate=(a,b)=>a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;return {width:innerWidth,height:innerHeight,previewClear:separate(dot,preview),stopClear:separate(dot,stop),helpFits:help.left>=0&&help.top>=0&&help.right<=innerWidth&&help.bottom<=innerHeight};})()");
    if(!layout.previewClear||!layout.stopClear||!layout.helpFits)throw Error('Calibration target layout is obstructed: '+JSON.stringify(layout));
    if(${compact}){await mkdir(${JSON.stringify(resolve('artifacts/ui-live'))},{recursive:true});writeFileSync(${JSON.stringify(resolve('artifacts/ui-live/handsfree-calibration.png'))},(await window.webContents.capturePage()).toPNG());}

    await until('window.fixtureTrainingCount() === 45', '45 hands-free calibration observations',30000);
    console.log('TRAINING_COMPLETE');

    await until("document.querySelector('.calibration-dot') === null && document.querySelector('.calibration-tutorial') === null", 'calibration completion', 30000);
    await until('window.fixtureTrainingCount() === 45', 'retained 45 training observations');
    await wait(100);
    const initialCalibrationMs=Date.now()-calibrationStartedAt;
    console.log('TRACKING');
    const first = host.sample();
    if (!first) throw Error('The native WebGazer host did not publish a calibrated sample.');
    if (window.isVisible()) throw Error('Calibration window should be hidden after success.');
    const marker = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
    if (!marker || marker.isDestroyed()) throw Error('Click-through gaze marker was not created.');
    await wait(350);
    const later = host.sample();
    if (!later || later.timestamp === first.timestamp) throw Error('Hidden renderer stopped publishing fresh gaze samples.');

    // Exercise the actual renderer -> IPC -> host -> native marker at all four
    // corners, then lose the eyes while video continues and reacquire away from centre.
    const config=await run("window.echo.desktop({action:'gaze-config'})");
    for(const [x,y] of [[display.bounds.x,display.bounds.y],[display.bounds.x+display.bounds.width,display.bounds.y],[display.bounds.x,display.bounds.y+display.bounds.height],[display.bounds.x+display.bounds.width,display.bounds.y+display.bounds.height]]){
      console.log('CORNER',x,y);
      const local={x:x-config.originX+(x===display.bounds.x?-100:100),y:y-config.originY+(y===display.bounds.y?-100:100)};
      await run('window.fixturePrediction='+JSON.stringify(local));await wait(650);
      const sample=host.sample();if(!sample||Math.abs(sample.meanX-x)>1||Math.abs(sample.meanY-y)>1)throw Error('Corner prediction was dropped or did not reach the display edge.');
      const box=marker.getBounds();const orb=await marker.webContents.executeJavaScript("(()=>{const b=document.getElementById('orb').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()");if(Math.abs(box.x+orb.x-x)>2||Math.abs(box.y+orb.y-y)>2)throw Error('Native marker centre cannot reach corner: '+JSON.stringify({box,orb,x,y}));
    }
    console.log('EYE_LOSS');
    await run('window.fixtureEyesClosed=true');await wait(400);
    if(host.sample()||marker.isVisible())throw Error('Closed eyes kept a live target or visible pointer.');
    await run('window.fixturePrediction={x:200,y:300};window.fixtureEyesClosed=false');await wait(400);
    if(!host.sample()||!marker.isVisible())throw Error('Eyes did not reacquire away from the camera centre.');
    showPointer=false;await wait(100);if(marker.isVisible()||!host.sample())throw Error('Hiding the pointer stopped gaze or left it visible');showPointer=true;await wait(100);if(!marker.isVisible())throw Error('Pointer could not be restored');
    let restartCheckMs=null;
    let stallShutdownMs=null,sourceFramesFrozen=false;
    if(stallCamera){
      const startedAt=Date.now();
      const beforeFreeze=await run('window.fixtureSourceDrawCount()');
      await run('window.fixtureFreezeSource()');
      await wait(120);
      const afterFreeze=await run('window.fixtureSourceDrawCount()');
      if(afterFreeze!==beforeFreeze)throw Error('Synthetic source kept drawing after the stall was injected.');
      sourceFramesFrozen=true;
      const end=Date.now()+5000;
      while(BrowserWindow.getAllWindows().length&&Date.now()<end)await wait(30);
      stallShutdownMs=Date.now()-startedAt;
      if(BrowserWindow.getAllWindows().length)throw Error('A stalled synthetic source did not close gaze windows within 5 seconds.');
    }else{
      if(await run('window.fixtureTracksReleased()'))throw Error('Source or processed track stopped before Stop.');
      // Invoke the real Stop button in the hidden calibration renderer; its IPC routes through the
      // actual overlay teardown and closes the marker.
      await run("document.querySelector('.gaze-cancel').click()");
      const end=Date.now()+5000;
      while(BrowserWindow.getAllWindows().length&&Date.now()<end)await wait(25);
      if(BrowserWindow.getAllWindows().length)throw Error('Stop leaked calibration or marker windows.');
    }
    if(!stallCamera&&!${compact}){
      if(!savedProfile)throw Error('Accepted calibration did not save fitted coefficients');
      const started=Date.now();await overlay.start(String(display.id));
      const resumedWindow=BrowserWindow.getAllWindows()[0];
      await wait(2000);console.log('RESUME_METADATA',JSON.stringify({savedViewport:savedProfile.viewport,currentViewport:await resumedWindow.webContents.executeJavaScript('[innerWidth,innerHeight]'),cameraSignature:savedProfile.cameraSignature,config:await resumedWindow.webContents.executeJavaScript("window.echo.desktop({action:'gaze-config'}).then(c=>({displayKey:c.displayKey,hasProfile:!!c.profile}))")}));
      const end=Date.now()+30000;while((!host.sample()||resumedWindow.isVisible())&&Date.now()<end)await wait(30);
      restartCheckMs=Date.now()-started;
      if(!host.sample()||resumedWindow.isVisible())throw Error('Saved fit did not start with a short independent accuracy check: '+await resumedWindow.webContents.executeJavaScript('document.body.innerText'));
      const retained=await resumedWindow.webContents.executeJavaScript('window.fixtureTrainingCount()');if(retained!==0)throw Error('Saved fit retrained instead of being reused');
      await overlay.stop();if(BrowserWindow.getAllWindows().length)throw Error('Restart check leaked windows');
    }
    if(!mockSourceTrackReleased||!mockProcessedTrackReleased)throw Error('Cleanup did not stop both the original source and processed camera tracks.');
    if (externalRequests.length) throw Error('Unexpected external requests: '+externalRequests.join(', '));

    const result = {variant:stallCamera?'stall-camera':'manual-stop',actualRenderer:true,actualProtocol:true,actualOverlay:true,actualWebGazerHost:true,productionCameraAdapter:true,sourceResolution:'1920x1080',webgazerInput:'640x480',feedbackGeometry:true,initialCalibrationMs,allFourCorners:true,pointerVisibilityIndependent:true,savedModelReused:!stallCamera&&!${compact},layout,restartCheckMs,closedEyesInvalidate:true,reacquisition:true,tutorial:true,setup:true,handsFreeTrainingObservations:45,heldOutTargets:5,heldOutFramesMinimum:20,calibrationAccepted:true,trackingContinuedWhileHidden:true,windowsClosed:true,sourceTrackReleased:mockSourceTrackReleased,processedTrackReleased:mockProcessedTrackReleased,sourceFramesFrozen,stallShutdownMs,cameraUsed:false,externalRequests};
    await mkdir(${JSON.stringify(resolve('artifacts'))},{recursive:true});
    writeFileSync(${JSON.stringify(outputPath)},JSON.stringify(result,null,2));
    console.log('GAZE_RENDERER '+JSON.stringify(result));
    app.exit(0);
  } catch(error) {
    console.error(error?.stack || error?.message || String(error));
    await overlay?.stop();
    app.exit(1);
  }
});
`;

await build({stdin:{contents:fixture,loader:'ts',resolveDir:root},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(directory,'main.cjs')});
try {
  await new Promise((resolvePromise,reject) => {
    const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout.on('data',data=>output+=data);
    child.stderr.on('data',data=>output+=data);
    const timer=setTimeout(()=>{child.kill();reject(Error(output.slice(-3000)));},90000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',(code,signal)=>{clearTimeout(timer);code===0?(console.log(output.slice(-3000)),resolvePromise()):reject(Error('Electron exited '+code+' ('+signal+').\n'+output.slice(-3500)));});
  });
} finally {
  await rm(directory,{recursive:true,force:true});
}
