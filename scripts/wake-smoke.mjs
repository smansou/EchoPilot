#!/usr/bin/env node
// Uses upstream public test audio in a Node child. No GUI, microphone, camera or provider.
import {fork} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
// Strict fixture decoding avoids the addon's external-buffer readWave helper, which Electron
// intentionally rejects. Production supplies ordinary JS-owned PCM arrays from AudioWorklet.
const file=readFileSync('models/wake/test_wavs/1.wav');assert.equal(file.toString('ascii',0,4),'RIFF');assert.equal(file.toString('ascii',8,12),'WAVE');let format=null,data=null;
for(let offset=12;offset+8<=file.length;){const size=file.readUInt32LE(offset+4);const chunk=file.subarray(offset+8,offset+8+size);if(file.toString('ascii',offset,offset+4)==='fmt ')format=chunk;if(file.toString('ascii',offset,offset+4)==='data')data=chunk;offset+=8+size+(size%2);}
assert.ok(format&&data);assert.equal(format.readUInt16LE(0),1);assert.equal(format.readUInt16LE(2),1);assert.equal(format.readUInt32LE(4),16000);assert.equal(format.readUInt16LE(14),16);
const pcm=new Int16Array(data.length/2);for(let i=0;i<pcm.length;i++)pcm[i]=data.readInt16LE(i*2);
const child=fork(process.env.ECHOPILOT_WAKE_WORKER??'dist/main/wake-worker.cjs',{execPath:process.env.ECHOPILOT_WAKE_RUNTIME??process.execPath,execArgv:[],serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});
let stderr='';child.stderr.on('data',c=>stderr=(stderr+c).slice(-2000));let started=performance.now();
await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(Error('Wake fixture timed out. '+stderr));},20000);
  child.on('error',reject);
  child.on('message',message=>{
    try{if(message.type==='error')throw Error(message.message+' '+stderr);
      if(message.type==='ready')child.send({type:'calibrate',phrase:'lovely child',samples:[{pcm,positive:true},{pcm,positive:true},{pcm,positive:true},{pcm:new Int16Array(160000),positive:false}]});
      if(message.type==='calibrated'){assert.equal(message.measurements.length,4);assert.ok(message.measurements.some(m=>m.positives===3&&m.negatives===0));clearTimeout(timer);console.log(JSON.stringify({fixture:'public sherpa KWS audio',audioSeconds:pcm.length/16000,elapsedMs:Math.round(performance.now()-started),measurements:message.measurements}));child.disconnect();resolve();}
    }catch(error){clearTimeout(timer);child.kill();reject(error);}
  });
  child.send({type:'configure',phrase:'lovely child',threshold:.5});
});
