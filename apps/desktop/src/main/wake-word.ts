import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
export type WakeCalibration={phrase:string;threshold:number;detected:number;attempts:number;falseTriggers:number;negativeSeconds:number;score:number;at:string};
export type WakePreferences={enabled:boolean;phrase:string;idleTimeoutSeconds:number;calibration:WakeCalibration|null};
export function evaluateWakeCalibration(phrase:string,measurements:{threshold:number;positives:number;negatives:number}[],positiveCount:number,negativeSeconds:number):WakeCalibration{
  if(positiveCount<3||negativeSeconds<10||!measurements.length||measurements.some(m=>!Number.isFinite(m.threshold)||m.threshold<.1||m.threshold>.9||!Number.isInteger(m.positives)||m.positives<0||m.positives>positiveCount||!Number.isInteger(m.negatives)||m.negatives<0))throw Error('Record at least three wake attempts and ten seconds of background speech.');
  const best=[...measurements].sort((a,b)=>(b.positives/positiveCount-b.negatives*2)-(a.positives/positiveCount-a.negatives*2)||b.threshold-a.threshold)[0]!;
  // Empirical calibration score only, not a population reliability probability.
  return {phrase,threshold:best.threshold,detected:best.positives,attempts:positiveCount,falseTriggers:best.negatives,negativeSeconds,score:Math.max(0,Math.round(100*(best.positives/positiveCount)/(1+best.negatives))),at:new Date().toISOString()};
}
export function createWakeWord(options:{bundleDir:string;allowed():boolean;wake():void;load?():unknown;save?(value:unknown):void;spawn?:typeof spawn}){
  let preferences:WakePreferences={enabled:false,phrase:'Hey Echo',idleTimeoutSeconds:60,calibration:null};
  try{const saved=options.load?.() as Partial<WakePreferences>|null;if(saved&&typeof saved.phrase==='string'&&/^[a-zA-Z][a-zA-Z' -]{2,59}$/.test(saved.phrase))preferences={enabled:saved.enabled===true,phrase:saved.phrase,idleTimeoutSeconds:[0,30,60,120,300].includes(saved.idleTimeoutSeconds??-1)?saved.idleTimeoutSeconds!:60,calibration:saved.calibration&&saved.calibration.phrase===saved.phrase&&Number.isFinite(saved.calibration.threshold)&&saved.calibration.threshold>=.1&&saved.calibration.threshold<=.9?saved.calibration:null};}catch{}
  if(preferences.enabled&&(!preferences.calibration||!Number.isInteger(preferences.calibration.attempts)||preferences.calibration.attempts<3||preferences.calibration.detected!==preferences.calibration.attempts||preferences.calibration.falseTriggers!==0||preferences.calibration.negativeSeconds<10))preferences.enabled=false;
  let startupTimer:ReturnType<typeof setTimeout>|null=null;let child:ChildProcess|null=null;let ready=false,error:string|null=null;let coolingUntil=0;let pending=0;let calibration=false;
  let resolveCalibration:((value:WakeCalibration)=>void)|null=null,rejectCalibration:((reason:Error)=>void)|null=null;let calibrationTimer:ReturnType<typeof setTimeout>|null=null;
  let samples:{pcm:Int16Array;positive:boolean}[]=[];let totalSamples=0;
  const available=()=>existsSync(join(options.bundleDir,'wake-worker.cjs'))&&existsSync(join(options.bundleDir,'wake-model','bpe.model'));
  function endCalibration(message:string){if(calibrationTimer)clearTimeout(calibrationTimer);calibrationTimer=null;for(const sample of samples)sample.pcm.fill(0);samples=[];totalSamples=0;calibration=false;rejectCalibration?.(Error(message));resolveCalibration=null;rejectCalibration=null;}
  function stop(){if(startupTimer)clearTimeout(startupTimer);startupTimer=null;const old=child;child=null;ready=false;pending=0;endCalibration('Calibration stopped.');if(old){if(old.connected)old.disconnect();old.kill('SIGTERM');}}
  function start(){if(child||error||!available()||!options.allowed())return;
    const processChild=(options.spawn??spawn)(process.execPath,[join(options.bundleDir,'wake-worker.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced'});child=processChild;
    processChild.stderr?.resume();startupTimer=setTimeout(()=>{if(child===processChild){error='The local wake model did not become ready.';stop();}},15000);startupTimer.unref();
    processChild.on('message',(event:any)=>{if(child!==processChild)return;if(event.type==='ready'){ready=true;if(startupTimer)clearTimeout(startupTimer);startupTimer=null;}
      else if(event.type==='detected'&&!calibration&&preferences.enabled&&options.allowed()&&Date.now()>coolingUntil){coolingUntil=Date.now()+4000;options.wake();}
      else if(event.type==='calibrated'){try{const positiveCount=samples.filter(s=>s.positive).length;const negativeSeconds=samples.filter(s=>!s.positive).reduce((n,s)=>n+s.pcm.length/16000,0);const result=evaluateWakeCalibration(preferences.phrase,event.measurements,positiveCount,negativeSeconds);preferences={...preferences,calibration:result};options.save?.(preferences);resolveCalibration?.(result);resolveCalibration=null;endCalibration('');stop();}catch(e){endCalibration(e instanceof Error?e.message:'Calibration failed.');}}
      else if(event.type==='error'){error=String(event.message).slice(0,300);stop();}});
    processChild.on('error',()=>{if(child===processChild){error='Wake listener could not start.';stop();}});
    processChild.on('exit',()=>{if(child===processChild){error='Wake listener ended. Toggle wake listening to retry.';stop();}});
    processChild.send?.({type:'configure',phrase:preferences.phrase,threshold:preferences.calibration?.threshold??.5});
  }
  return {preferences:()=>({...preferences}),status:()=>({preferences:{...preferences},available:available(),ready,error,calibrating:calibration}),
    update(input:unknown){const value=input as Partial<WakePreferences>;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid voice preferences.');
      const next={...preferences};if(value.phrase!==undefined){if(typeof value.phrase!=='string'||!/^[a-zA-Z][a-zA-Z' -]{2,59}$/.test(value.phrase)||value.phrase.trim().split(/\s+/).length>5)throw Error('Choose an English wake phrase of 3–60 characters, ideally two or three distinctive words.');if(value.phrase.trim()!==next.phrase){next.calibration=null;next.enabled=false;}next.phrase=value.phrase.trim();}
      if(value.enabled!==undefined){if(typeof value.enabled!=='boolean')throw Error('Choose whether to enable wake listening.');if(value.enabled&&(!next.calibration||next.calibration.detected<next.calibration.attempts||next.calibration.falseTriggers>0))throw Error('Calibrate the phrase with clear detections and no false triggers before enabling wake listening.');next.enabled=value.enabled;}
      if(value.idleTimeoutSeconds!==undefined){if(![0,30,60,120,300].includes(value.idleTimeoutSeconds))throw Error('Choose a supported sleep timeout.');next.idleTimeoutSeconds=value.idleTimeoutSeconds;}
      stop();error=null;preferences=next;options.save?.(preferences);return {...preferences};},
    listen(enabled:boolean){if(!enabled||!options.allowed()){stop();return;}if(preferences.enabled)start();},
    audio(bytes:Uint8Array){if(!child||!ready||!options.allowed()||calibration||bytes.length===0||bytes.length>16000||bytes.length%2)return;if(pending>=8){error='Wake audio fell behind. Listening was stopped.';stop();return;}pending++;const copy=new Int16Array(bytes.length/2);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<copy.length;i++)copy[i]=view.getInt16(i*2,true);child.send?.({type:'audio',pcm:copy},()=>{pending=Math.max(0,pending-1);});},
    beginCalibration(){stop();error=null;preferences={...preferences,enabled:false};options.save?.(preferences);if(!available())throw Error('The offline wake model is missing from this build.');if(!options.allowed())throw Error('Leave private or muted mode before calibration.');calibration=true;start();return {ready:false};},
    sample(bytes:Uint8Array,positive:boolean){if(!calibration||!ready||!options.allowed())throw Error('Wake calibration is not ready.');if(bytes.length<32000||bytes.length>640000||bytes.length%2||samples.length>=8||totalSamples+bytes.length>3_200_000)throw Error('Record a short calibration sample.');const pcm=new Int16Array(bytes.length/2);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true);samples.push({pcm,positive});totalSamples+=bytes.length;return {samples:samples.length};},
    finishCalibration(){if(!calibration||!ready||!child)throw Error('Calibration is not ready.');return new Promise<WakeCalibration>((resolve,reject)=>{resolveCalibration=resolve;rejectCalibration=reject;calibrationTimer=setTimeout(()=>{endCalibration('Calibration timed out.');stop();},30000);child!.send?.({type:'calibrate',phrase:preferences.phrase,samples});});},
    stop,dispose:stop,
  };
}
