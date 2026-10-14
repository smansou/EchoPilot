import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
const directory=await mkdtemp(join(tmpdir(),'echo-realtime-media-'));
const renderer=await build({stdin:{contents:`import {startLiveWebRTC} from './apps/desktop/src/renderer/live-webrtc';
window.runMediaSmoke=async()=>{
  const context=new AudioContext();await context.resume();
  const outbound=context.createMediaStreamDestination();const oscillator=context.createOscillator();oscillator.frequency.value=220;oscillator.connect(outbound);oscillator.start();
  const inbound=context.createMediaStreamDestination();const second=context.createOscillator();second.frequency.value=440;second.connect(inbound);second.start();
  const receiver=new RTCPeerConnection();let received=false;let ready=false;let failure=false;
  receiver.ondatachannel=event=>{event.channel.onopen=()=>event.channel.send(JSON.stringify({type:'session.started'}));};
  receiver.ontrack=()=>{received=true;};
  for(const track of inbound.stream.getTracks())receiver.addTrack(track,inbound.stream);
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async()=>outbound.stream;
  const controller=new AbortController();
  try{
    await startLiveWebRTC({id:'synthetic-local',signal:controller.signal,onFailure:()=>{failure=true;},request:async input=>{
      if(input.action==='live-ready'){ready=true;return {};}
      if(input.action!=='live-connect')throw Error('Unexpected request');
      await receiver.setRemoteDescription({type:'offer',sdp:input.sdp});
      await receiver.setLocalDescription(await receiver.createAnswer());
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ICE timeout')),6000);const check=()=>{if(receiver.iceGatheringState==='complete'){clearTimeout(timer);receiver.removeEventListener('icegatheringstatechange',check);resolve();}};receiver.addEventListener('icegatheringstatechange',check);check();});
      return {sdp:receiver.localDescription.sdp};
    }});
    for(let i=0;i<100&&!ready&&!failure;i++)await new Promise(r=>setTimeout(r,50));
    await new Promise(r=>setTimeout(r,1000));
    let bytesReceived=0,bytesSent=0;
    for(const report of (await receiver.getStats()).values()){
      if(report.type==='inbound-rtp'&&report.kind==='audio')bytesReceived+=report.bytesReceived||0;
      if(report.type==='outbound-rtp'&&report.kind==='audio')bytesSent+=report.bytesSent||0;
    }
    controller.abort();
    const released=outbound.stream.getTracks().every(t=>t.readyState==='ended');
    if(!received||!ready||failure||!released||bytesReceived<=0||bytesSent<=0)throw Error(JSON.stringify({received,ready,failure,released,bytesReceived,bytesSent}));
    return {ready,released,bytesReceived,bytesSent,microphoneUsed:false,externalProviderUsed:false};
  }finally{controller.abort();receiver.close();oscillator.stop();second.stop();inbound.stream.getTracks().forEach(t=>t.stop());await context.close();navigator.mediaDevices.getUserMedia=original;}
};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser'});
await writeFile(join(directory,'renderer.js'),renderer.outputFiles[0].text);
await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require(${JSON.stringify(resolve('node_modules/electron'))});\n` .replace(`require(${JSON.stringify(resolve('node_modules/electron'))})`,`require('electron')`)+`
const fs=require('node:fs');app.setPath('userData',${JSON.stringify(join(directory,'profile'))});
app.whenReady().then(async()=>{let window;try{window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,autoplayPolicy:'no-user-gesture-required',backgroundThrottling:false}});await window.loadURL('file://'+${JSON.stringify(join(directory,'index.html'))});await window.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(join(directory,'renderer.js'))},'utf8'));const result=await window.webContents.executeJavaScript('window.runMediaSmoke()');console.log('REALTIME_MEDIA_SMOKE '+JSON.stringify(result));app.exit(0);}catch{console.error('Realtime media smoke failed');app.exit(1);}});
`);
await writeFile(join(directory,'index.html'),'<!doctype html><title>EchoPilot synthetic media check</title>');
try{await new Promise((resolve,reject)=>{const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Local realtime media test timed out'));},30000);child.on('exit',code=>{clearTimeout(timer);if(code===0&&output.includes('REALTIME_MEDIA_SMOKE')){console.log(output.trim());resolve();}else reject(Error('Local realtime media test failed'));});child.on('error',reject);});}finally{await rm(directory,{recursive:true,force:true});}
