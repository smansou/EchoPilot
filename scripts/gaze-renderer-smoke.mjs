import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const root = process.cwd();
if (process.argv.includes('--real')) {
  throw new Error('--real is gated off in this guided-renderer smoke. A static-face fixture cannot validate human gaze accuracy.');
}

const directory = await mkdtemp('/private/tmp/echo-gaze-renderer-');
const outputPath = resolve('artifacts/gaze-renderer-acceptance.json');

// This is an API-compatible deterministic fake, not an accuracy fixture. It emits fresh
// observations, follows the visible calibration target, and records the same 45 click samples
// that the real WebGazer ridge regressor would receive. No camera or network is used.
const stub = String.raw`
(() => {
  let callback = () => {}, timer = null, paused = false, active = false;
  let track = { readyState: 'live', stop() { this.readyState = 'ended'; void window.echo.desktop({action:'__fixture-track-stopped'}).catch(()=>{}); } };
  const samples = [];
  const container = document.createElement('div');
  container.id = 'webgazerVideoContainer';
  container.style.width='240px';container.style.height='180px';
  const video = document.createElement('video');
  Object.defineProperty(video, 'srcObject', { writable: true, value: { getTracks: () => [track] } });
  video.autoplay = true;
  container.appendChild(video);
  const feedback = document.createElement('canvas');
  feedback.id = 'webgazerFaceFeedbackBox';
  feedback.style.borderColor = 'green';
  feedback.style.border = '3px solid green';
  container.appendChild(feedback);
  const face = document.createElement('canvas');
  face.id = 'webgazerFaceOverlay';
  container.appendChild(face);
  document.body.appendChild(container);

  function prediction() {
    const dot = document.querySelector('.calibration-dot');
    if (!dot) return { x: innerWidth / 2, y: innerHeight / 2 };
    const style = getComputedStyle(dot);
    return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top) };
  }
  const webgazer = window.webgazer = {
    params: {},
    async begin() {
      active = true; paused = false;
      timer = setInterval(() => { if (active && !paused) callback(prediction()); }, 16);
      return this;
    },
    pause() { paused = true; clearInterval(timer); timer = null; return this; },
    end() { active = false; clearInterval(timer); timer = null; container.remove(); return this; },
    async clearData() { samples.length = 0; return this; },
    showFaceOverlay() { return this; },
    showFaceFeedbackBox() { return this; },
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
  window.fixtureTracksReleased = () => track.readyState === 'ended';
  window.fixtureTrainingCount = () => samples.length;
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
    let mockTrackReleased=false;
    session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      if (!details.url.startsWith('echo://app/') && !details.url.startsWith('data:')) externalRequests.push(details.url);
      done({cancel: !details.url.startsWith('echo://app/') && !details.url.startsWith('data:')});
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
    ipcMain.handle('echo:desktop',(event,input)=>{if(input?.action==='__fixture-track-stopped'){mockTrackReleased=true;return {ok:true};}return overlay.handle(event.sender,input);});
    await overlay.start(String(display.id));
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

    if(await run('window.fixtureTracksReleased()'))throw Error('Track stopped before Stop');
    // Invoke the real Stop button in the hidden calibration renderer; its IPC routes through the
    // actual overlay teardown and closes the marker.
    await run("document.querySelector('.gaze-cancel').click()");
    const end = Date.now()+5000;
    while (BrowserWindow.getAllWindows().length && Date.now()<end) await wait(25);
    if (BrowserWindow.getAllWindows().length) throw Error('Stop leaked calibration or marker windows.');
    if(!mockTrackReleased)throw Error('Stop did not explicitly release the camera track');
    if (externalRequests.length) throw Error('Unexpected external requests: '+externalRequests.join(', '));

    const result = {actualRenderer:true,actualProtocol:true,actualOverlay:true,actualWebGazerHost:true,tutorial:true,setup:true,trainingClicks:45,heldOutTargets:5,heldOutFramesMinimum:20,calibrationAccepted:true,trackingContinuedWhileHidden:true,stopClosedWindows:true,mockTrackReleased,cameraUsed:false,externalRequests};
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
