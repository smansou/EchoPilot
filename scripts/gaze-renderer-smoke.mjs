import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const root = process.cwd();
const stallVariant = process.argv.includes('--stall-camera');
if (process.argv.includes('--real')) {
  throw new Error('--real is gated off in this guided-renderer smoke. A static-face fixture cannot validate human gaze accuracy.');
}

const directory = await mkdtemp('/private/tmp/echo-gaze-renderer-');
const outputPath = resolve('artifacts/gaze-renderer-acceptance.json');

// This is an API-compatible deterministic fake, not an accuracy fixture. It requests its
// stream through the renderer's production adapter, follows visible targets, and records the
// same 45 deliberate samples. The underlying 1920x1080 source is a local synthetic canvas.
const stub = String.raw`
(() => {
  let callback = () => {}, timer = null, sourceTimer = null, paused = false, active = false;
  let sourceStream = null, sourceTrack = null, outputStream = null, outputTrack = null;
  let sourceDrawCount = 0, sourceConstraints = null, previewCount = 0;
  const samples = [];
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
    if (!dot) return { x: innerWidth / 2, y: innerHeight / 2 };
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
    async clearData() { samples.length = 0; return this; },
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
    getRegression() { return [{ getData: () => samples }]; },
    setRegression() { return this; },
    setTracker() { return this; },
    applyKalmanFilter() { return this; },
    showVideoPreview(value) { container.style.display = value ? 'block' : 'none'; return this; },
    showPredictionPoints() { return this; },
    saveDataAcrossSessions() { return this; },
    removeMouseEventListeners() { return this; },
    recordScreenPosition(x, y, type) { samples.push({ x, y, type }); return this; },
    setGazeListener(fn) { callback = fn; return this; },
    getTracker() { return { getPositions: () => [{ x: 1, y: 2 }, { x: 3, y: 4 }] }; },
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
  let overlay;
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
    overlay = createGazeOverlay({host,bundleDir:${JSON.stringify(resolve('dist/main'))},projectId:()=> 'desktop'});
    ipcMain.handle('echo:desktop',(event,input)=>{if(input?.action==='__fixture-track-stopped'){if(input.which==='source')mockSourceTrackReleased=true;if(input.which==='processed')mockProcessedTrackReleased=true;return {ok:true};}return overlay.handle(event.sender,input);});
    await overlay.start(String(display.id));
    const stallCamera=${stallVariant};
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw Error('Calibration window did not open.');
    const run = code => window.webContents.executeJavaScript(code);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (expression, label, timeout=15000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await run(expression)) return; await wait(40); }
      throw Error('Timed out waiting for ' + label + '.');
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
    for (let target=0; target<9; target++) {
      await until("document.querySelector('.calibration-dot') && document.querySelector('.calibration-dot').textContent.includes('/5')", 'training target '+(target+1));
      await wait(850);
      for (let click=0; click<5; click++) {
        await run("document.querySelector('.calibration-dot').click()");
        await wait(270);
      }
      const count = await run('window.fixtureTrainingCount()');
      if (count !== (target+1)*5) throw Error('Expected '+((target+1)*5)+' real click records after target '+(target+1)+', got '+count+'.');
    }
    if (await run('window.fixtureTrainingCount()') !== 45) throw Error('Expected exactly 45 deliberate training clicks.');

    // Each of the five held-out targets is armed through its Start button. The renderer itself
    // enforces 1s settling, 2.8s measurement and at least 20 fresh observations.
    for (let target=0; target<5; target++) {
      await until("document.querySelector('.calibration-dot') && document.querySelector('.calibration-dot').textContent.includes('Start')", 'held-out target '+(target+1));
      await run("document.querySelector('.calibration-dot').click()");
      await until("document.querySelector('.calibration-target-help')?.innerText.includes('%')", 'held-out measurement '+(target+1));
      if (target<4) await until("document.querySelector('.calibration-dot')?.textContent.includes('Start')", 'next held-out target '+(target+2), 10000);
    }

    await until("document.querySelector('.calibration-dot') === null && document.querySelector('.calibration-tutorial') === null", 'calibration completion', 10000);
    await until('window.fixtureTrainingCount() === 45', 'retained 45 training observations');
    await wait(100);
    const first = host.sample();
    if (!first) throw Error('The native WebGazer host did not publish a calibrated sample.');
    if (window.isVisible()) throw Error('Calibration window should be hidden after success.');
    const marker = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
    if (!marker || marker.isDestroyed()) throw Error('Click-through gaze marker was not created.');
    await wait(350);
    const later = host.sample();
    if (!later || later.timestamp === first.timestamp) throw Error('Hidden renderer stopped publishing fresh gaze samples.');

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
    if(!mockSourceTrackReleased||!mockProcessedTrackReleased)throw Error('Cleanup did not stop both the original source and processed camera tracks.');
    if (externalRequests.length) throw Error('Unexpected external requests: '+externalRequests.join(', '));

    const result = {variant:stallCamera?'stall-camera':'manual-stop',actualRenderer:true,actualProtocol:true,actualOverlay:true,actualWebGazerHost:true,productionCameraAdapter:true,sourceResolution:'1920x1080',webgazerInput:'640x480',feedbackGeometry:true,tutorial:true,setup:true,trainingClicks:45,heldOutTargets:5,heldOutFramesMinimum:20,calibrationAccepted:true,trackingContinuedWhileHidden:true,windowsClosed:true,sourceTrackReleased:mockSourceTrackReleased,processedTrackReleased:mockProcessedTrackReleased,sourceFramesFrozen,stallShutdownMs,cameraUsed:false,externalRequests};
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
