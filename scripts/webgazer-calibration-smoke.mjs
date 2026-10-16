// Renderer orchestration fixture. Uses fake face landmarks and captures the UI in Electron; no camera or human accuracy claim.
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import electron from 'electron';

const directory=await mkdtemp('/private/tmp/echo-calibration-smoke-');
const screenshotPaths=[
  '/private/tmp/echopilot-calibration-20261016-tutorial.png',
  '/private/tmp/echopilot-calibration-20261016-setup.png',
  '/private/tmp/echopilot-calibration-20261016-training.png',
  '/private/tmp/echopilot-calibration-20261016-result.png',
];

await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import'./apps/desktop/src/renderer/desktop.css';import{WebGazerCalibration}from'./apps/desktop/src/renderer/WebGazerCalibration';createRoot(document.getElementById('root')).render(React.createElement(WebGazerCalibration));",resolveDir:process.cwd(),loader:'tsx'},bundle:true,outfile:join(directory,'ui.js'),platform:'browser',jsx:'automatic'});

const fixture=`
let tick=100,callback,positions=null,heldPositions=null,records=[],paused=false,calibrationPayload,clearCount=0,beginCount=0,endCount=0,stopCount=0,mode='normal',lastTargetKey='',previewNode=null;
const acceptedAt=[],validationStartedAt=[],validationDurations=[];
Object.defineProperty(performance,'now',{value:()=>tick});
window.echo={desktop:async request=>{if(request.action==='gaze-config')return {originX:0,originY:0};if(request.action==='gaze-calibrated'){calibrationPayload=request;return {ok:false,error:'Fixture rejection: review setup'};}return {ok:true};}};
window.webgazer={params:{},setRegression(){return this},setTracker(){return this},applyKalmanFilter(){return this},showPredictionPoints(){return this},showVideoPreview(value){this.preview=value;return this},showFaceOverlay(value){this.overlay=value;return this},showFaceFeedbackBox(value){this.feedback=value;return this},saveDataAcrossSessions(){return this},setGazeListener(cb){callback=cb;return this},getTracker(){return {getPositions:()=>positions}},getRegression(){return [{getData:()=>records}]},recordScreenPosition(x,y){if(!paused&&positions){records.push({x,y});acceptedAt.push(tick)}return this},removeMouseEventListeners(){this.listenersRemoved=true;return this},clearData:async function(){records=[];acceptedAt.length=0;clearCount++},begin:async function(){beginCount++;window.cameraBeganAt=tick;paused=false;previewNode=document.createElement('div');previewNode.id='webgazerVideoContainer';previewNode.innerHTML='<svg viewBox="0 0 240 180" aria-label="Mock camera preview"><rect width="240" height="180" fill="#393442"/><rect x="52" y="16" width="136" height="148" rx="65" fill="none" stroke="#77b993" stroke-width="2"/><ellipse cx="120" cy="74" rx="36" ry="43" fill="#d6c5e7"/><path d="M84 69c3-43 68-49 72 0-12-12-24-16-38-14-14 1-24 7-34 14Z" fill="#625770"/><path d="M104 78h3m23 0h3" stroke="#51475a" stroke-width="4" stroke-linecap="round"/></svg>';document.body.append(previewNode);const video=document.createElement('video');Object.defineProperty(video,'srcObject',{value:{getTracks:()=>[{stop(){stopCount++}}]}});previewNode.append(video)},pause(){paused=true},end(){paused=true;endCount++;previewNode?.remove();previewNode=null}};
const feedback=document.getElementById('webgazerFaceFeedbackBox');
const timer=setInterval(()=>{if(paused)return;tick+=100;if(mode==='missing'){positions=null;feedback.style.borderColor='red';}else if(mode==='stale'){positions=heldPositions||[];feedback.style.borderColor='green';}else{positions=[];heldPositions=positions;feedback.style.borderColor='green';}const active=document.querySelector('.calibration-click');const key=active?[active.style.left,active.style.top,active.textContent].join(':'):'';if(key!==lastTargetKey){lastTargetKey=key;window.targetChangedAt=tick;}callback?.(positions?{x:parseFloat(active?.style.left||'50')*innerWidth/100,y:parseFloat(active?.style.top||'50')*innerHeight/100}:null)},10);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{for(let i=0;i<1000;i++){if(fn())return;await delay(10)}throw Error('Renderer state timeout at synthetic time '+tick)};
const assert=(condition,message)=>{if(!condition)throw Error(message)};
const target=()=>document.querySelector('.calibration-click');
const help=()=>document.querySelector('.calibration-target-help');
const checkGeometry=()=>{const preview=document.getElementById('webgazerVideoContainer'),dot=target(),label=help();assert(preview&&dot&&label,'Camera preview, active target, or inline help missing');const p=preview.getBoundingClientRect(),d=dot.getBoundingClientRect(),h=label.getBoundingClientRect();assert(d.right<=p.left||d.left>=p.right||d.bottom<=p.top||d.top>=p.bottom,'Active target overlaps camera preview');assert(h.left>=-1&&h.top>=-1&&h.right<=innerWidth+1&&h.bottom<=innerHeight+1,'Inline target help is outside the '+innerWidth+'x'+innerHeight+' viewport');};
const checkSetupGeometry=()=>{const preview=document.getElementById('webgazerVideoContainer'),setup=document.querySelector('.calibration-setup');assert(preview&&setup,'Camera preview or camera setup panel missing');assert(preview.getBoundingClientRect().bottom<=setup.getBoundingClientRect().top+1,'Camera setup content overlaps the camera preview');};
window.smoke={
  async leaveTutorial(){
    assert(document.querySelector('.calibration-tutorial'),'Tutorial must appear before camera startup');
    assert(beginCount===0,'Camera started before the user finished the tutorial');
    document.querySelector('.calibration-tutorial__next').click();await wait(()=>document.querySelector('#calibration-tutorial-title')?.textContent==='Follow with your eyes');
    document.querySelector('.calibration-tutorial__next').click();await wait(()=>document.querySelector('#calibration-tutorial-title')?.textContent==='Click, then check');
    assert(document.querySelector('.calibration-tutorial__next')?.textContent.includes('Start camera'),'Final tutorial action must say Start camera');
    document.querySelector('.calibration-tutorial__next').click();
    await wait(()=>beginCount===1&&document.querySelector('.calibration-setup'));
    await wait(()=>document.querySelector('.calibration-setup strong')?.textContent.includes('ready'));
    assert(tick-Number(window.cameraBeganAt)>=600,'Camera ready state appeared before 600ms of stable face feedback');
    assert(window.webgazer.preview&&window.webgazer.overlay&&window.webgazer.feedback&&window.webgazer.listenersRemoved,'Camera feedback or listener isolation is missing');
    checkSetupGeometry();
    return {beginCount,stableFaceMs:tick-window.cameraBeganAt};
  },
  async waitSettled(selector){
    await delay(700);const element=document.querySelector(selector);assert(element,'Expected screenshot surface missing: '+selector);assert(Number(getComputedStyle(element).opacity)>=.99,'Screenshot surface has not finished its entrance animation: '+selector);
  },
  async testSmallViewport(){
    await delay(120);checkGeometry();
    return {sizeChecked:innerWidth+'x'+innerHeight,targetAndHelpFit:true};
  },
  async beginTraining(){
    assert(document.querySelector('.calibration-start')?.textContent==='Begin calibration','Setup must ask for an explicit Begin calibration action');
    document.querySelector('.calibration-start').click();
    await wait(()=>target()&&help());
    checkGeometry();
    return {firstTarget:target().textContent};
  },
  async train(){
    const click=()=>target().click();
    await wait(()=>tick>=window.targetChangedAt+850);
    // One fresh frame can only train once; an immediate second click and rapid repeat are rejected.
    mode='stale';await delay(15);click();assert(records.length===1,'First deliberate click was not accepted');click();assert(records.length===1,'A duplicate face frame was counted twice');
    mode='normal';await delay(12);click();assert(records.length===1,'Rapid clicks less than 250ms apart were accepted');
    while(records.length<5){await delay(28);click();}
    await wait(()=>target()?.textContent==='0/5'&&parseFloat(target().style.left)==50);
    mode='missing';await wait(()=>help()?.textContent.includes('Pause'));
    assert(records.length===5,'A missing face contributed a training sample');
    mode='normal';await wait(()=>document.querySelector('.calibration-setup strong')?.textContent.includes('ready')||help()?.textContent.includes('Look here'));
    for(let area=1;area<9;area++){
      await wait(()=>target()?.textContent==='0/5');
      await wait(()=>tick>=window.targetChangedAt+850);
      while(records.length<(area+1)*5){await delay(28);click();}
    }
    assert(records.length===45,'Expected 45 accepted training clicks, got '+records.length);
    assert(acceptedAt.length===45&&acceptedAt.slice(1).every((time,i)=>time-acceptedAt[i]>=250),'Accepted training clicks were not unique and at least 250ms apart');
    await wait(()=>target()?.textContent==='Start');
    checkGeometry();
    return {trainingSamples:records.length,minClickInterval:Math.min(...acceptedAt.slice(1).map((time,i)=>time-acceptedAt[i])),missingFaceRejected:true,duplicateRejected:true,rapidClickRejected:true};
  },
  async validate(){
    const startCheck=()=>{validationStartedAt.push(tick);target().click();};
    startCheck();await wait(()=>target()?.textContent==='Look'&&help()?.textContent.includes('%'));
    const firstProgress=help().textContent;
    mode='missing';await wait(()=>help()?.textContent.includes('Pause'));
    assert(records.length===45,'Validation loss must not add training samples');
    assert(help().textContent.includes('Pause'),'Tracking loss did not pause validation feedback');
    mode='normal';await wait(()=>help()?.textContent.includes('Keep looking'));
    assert(help().textContent.includes('Keep looking · 0%'),'Validation progress must reset when tracking is lost and resume from zero');
    await wait(()=>target()?.textContent==='Start');
    validationDurations.push(tick-validationStartedAt.at(-1));
    for(let area=1;area<5;area++){
      startCheck();await wait(()=>target()?.textContent==='Look');
      await wait(()=>target()?.textContent==='Start'||calibrationPayload);
      validationDurations.push(tick-validationStartedAt.at(-1));
      if(calibrationPayload)break;
    }
    await wait(()=>calibrationPayload);
    assert(calibrationPayload.validation.framesUsed===45,'Held-out checks changed training sample count');
    assert(calibrationPayload.validation.targets.length===5,'Expected five independent validation areas');
    assert(calibrationPayload.validation.targets.every(area=>area.frames>=20),'Each check needs at least 20 fresh face observations');
    assert(validationDurations.length===5&&validationDurations.every(ms=>ms>=2800),'Each independent area must be observed for at least 2800ms: '+validationDurations);
    assert(document.querySelector('.calibration-result'),'Rejected result screen missing');
    return {validationAreas:5,minFreshFrames:Math.min(...calibrationPayload.validation.targets.map(area=>area.frames)),minAreaDuration:Math.min(...validationDurations),trackingLossPaused:true,rejected:true};
  },
  async reviewSetup(){
    document.querySelector('.calibration-retry').click();
    await wait(()=>document.querySelector('.calibration-tutorial'));
    await wait(()=>endCount>=1&&stopCount>=1);
    assert(beginCount===1,'Review setup restarted the camera before user consent');
    clearInterval(timer);
    return {tutorialRestored:true,cameraNotRestarted:true,tracksReleased:stopCount};
  }
};
`;

await writeFile(join(directory,'index.html'),`<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><div id="webgazerFaceFeedbackBox" style="border:solid green"></div><script>${fixture}</script><script src="ui.js"></script></body></html>`);
await writeFile(join(directory,'main.cjs'),`const{app,BrowserWindow}=require('electron');const fs=require('fs');const shots=${JSON.stringify(screenshotPaths)};app.setPath('userData',${JSON.stringify(join(directory,'profile'))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:true,frame:false,width:1000,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});try{await w.loadFile(${JSON.stringify(join(directory,'index.html'))});await w.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");const capture=async(index,selector)=>{await w.webContents.executeJavaScript('window.smoke.waitSettled('+JSON.stringify(selector)+')');fs.writeFileSync(shots[index],(await w.webContents.capturePage()).toPNG())};await capture(0,'.calibration-tutorial');const setup=await w.webContents.executeJavaScript('window.smoke.leaveTutorial()');await capture(1,'.calibration-setup');await w.webContents.executeJavaScript('window.smoke.beginTraining()');await capture(2,'.calibration-click');w.setContentSize(800,600);await new Promise(resolve=>setTimeout(resolve,150));const layout=await w.webContents.executeJavaScript('window.smoke.testSmallViewport()');w.setContentSize(1000,800);await new Promise(resolve=>setTimeout(resolve,150));const training=await w.webContents.executeJavaScript('window.smoke.train()');const validation=await w.webContents.executeJavaScript('window.smoke.validate()');await capture(3,'.calibration-result');const review=await w.webContents.executeJavaScript('window.smoke.reviewSetup()');console.log('CALIBRATION_RENDERER '+JSON.stringify({setup,layout,training,validation,review,screenshots:shots}));app.exit(0)}catch(e){console.error(e);app.exit(1)}});`);

try {
  await new Promise((resolve,reject)=>{
    const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const timeout=setTimeout(()=>{child.kill();reject(Error(output.slice(-3500)||'Electron smoke timed out'))},40000);
    child.on('exit',code=>{clearTimeout(timeout);code===0?(console.log(output.split('\n').filter(line=>line.includes('CALIBRATION_RENDERER')).join('\n')),resolve()):reject(Error(output.slice(-3500)))});
  });
} finally {
  await rm(directory,{recursive:true,force:true});
}
