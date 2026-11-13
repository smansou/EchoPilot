import {Workspace} from './Workspace';
import {captureWakeAudio} from './wake-capture';
import { WebGazerCalibration } from './WebGazerCalibration';
import { startLiveWebRTC } from './live-webrtc';
import { startLivePCM, type AudioHandle, type LiveMedia } from './live-pcm';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionState, SessionHistory } from '../main/desktop-session';
type Bridge={onNavigate?(listener:(page:string)=>void):()=>void;onLiveMedia(listener:(event:LiveMedia)=>void):()=>void;desktop(input:Record<string,unknown>):Promise<any>;keyEntry(input:{provider:string;secret:string}):Promise<unknown>;onGazeOverlay(listener:(state:any)=>void):()=>void};
const bridge=()=> (window as unknown as {echo:Bridge}).echo;
async function api(path:string,body?:unknown){const response=await fetch(new URL(path,location.href),body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error??'Please try again.');return result;}
function Icon({name,size=20}:{name:string;size?:number}) {const paths:Record<string,ReactNode>={settings:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,voice:<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3"/></>,gaze:<><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,history:<><path d="M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v6l4 2"/></>,arrow:<path d="m9 5 7 7-7 7"/>,check:<path d="m5 12 4 4L19 6"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,key:<><circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3"/></>,spark:<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></>,shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>};return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.spark}</svg>;}
function Orb({small=false}:{small?:boolean}){return <span className={`echo-orb ${small?'small':''}`} aria-hidden="true"><i/><b/></span>;}
function Shortcut({children}:{children:ReactNode}){return <kbd>{children}</kbd>;}
function Toggle({checked,onChange,label}:{checked:boolean;onChange:()=>void;label:string}){return <button type="button" className="toggle" role="switch" aria-checked={checked} aria-label={label} onClick={onChange}><span/></button>;}
const EMPTY:SessionState={id:null,mode:'dictation',phase:'idle',message:'',transcript:'',reply:'',recording:false};
function Notch(){
  const [state,setState]=useState<SessionState>(EMPTY);
  const liveAudio=useRef<AudioHandle|null>(null);
  const recorder=useRef<MediaRecorder|null>(null);
  const current=useRef<SessionState>(EMPTY);
  const starting=useRef(false);
  const generation=useRef(0);
  const cleanup=useRef<()=>void>(()=>{});
  const standby=useRef<AbortController|null>(null);const wakeFrames=useRef<Uint8Array[]>([]);const preserveWake=useRef(false);
  useEffect(()=>{let disposed=false,busy=false,failed=false,pending=0;
    const stop=()=>{standby.current?.abort();standby.current=null;for(const frame of wakeFrames.current)frame.fill(0);wakeFrames.current=[];};
    const poll=async()=>{if(busy||disposed)return;busy=true;try{const wake=await bridge().desktop({action:'wake-status'});if(disposed)return;if(!wake.capture&&wake.liveActive&&standby.current)preserveWake.current=true;if((!wake.capture||current.current.recording)&&!preserveWake.current){stop();if(!wake.preferences.enabled)failed=false;return;}if(standby.current||preserveWake.current||current.current.recording||failed)return;const controller=new AbortController();standby.current=controller;await captureWakeAudio({signal:controller.signal,chunk:bytes=>{wakeFrames.current.push(bytes);if(wakeFrames.current.length>400){if(preserveWake.current){const id=current.current.id;preserveWake.current=false;stop();failed=true;if(id)void bridge().desktop({action:'live-error',id});return;}wakeFrames.current.shift();}if(preserveWake.current)return;if(pending>=8){stop();failed=true;return;}pending++;void bridge().desktop({action:'wake-audio',bytes}).catch(()=>{stop();failed=true;}).finally(()=>pending--);},failed:()=>{stop();failed=true;}});}catch{if(standby.current){stop();failed=true;}}finally{busy=false;}};
    void poll();const timer=setInterval(()=>void poll(),250);return()=>{disposed=true;clearInterval(timer);stop();};
  },[]);
  useEffect(()=>{if(state.mode==='agent'&&state.id&&standby.current){wakeFrames.current=wakeFrames.current.slice(-50);preserveWake.current=true;}else if(state.recording||!state.id){preserveWake.current=false;standby.current?.abort();standby.current=null;if(state.recording)wakeFrames.current=[];}},[state.mode,state.id,state.recording]);
  useEffect(()=>{let active=true;const poll=async()=>{try{const next=await bridge().desktop({action:'status'});if(active){current.current=next;setState(next);}}catch{}};void poll();const timer=setInterval(()=>void poll(),100);return()=>{active=false;clearInterval(timer);generation.current++;cleanup.current();};},[]);
  useEffect(()=>{
    if(state.mode!=='agent'||!state.id||state.phase==='idle'||state.phase==='error')return;
    const controller=new AbortController();const id=state.id;
    const openingAudio=preserveWake.current?()=>{const frames=wakeFrames.current;wakeFrames.current=[];preserveWake.current=false;standby.current?.abort();standby.current=null;return frames;}:undefined;
    const options={...(openingAudio?{openingAudio}:{}),id,signal:controller.signal,request:(input:Record<string,unknown>)=>bridge().desktop(input),onFailure:()=>void bridge().desktop({action:'live-error',id})};
    const start=(state as SessionState & {transport?:string}).transport==='pcm'?startLivePCM({...options,subscribe:listener=>bridge().onLiveMedia(listener)}):startLiveWebRTC(options);
    void start.then(handle=>{if(controller.signal.aborted)handle.close();else {liveAudio.current=handle;if(current.current.phase==='closing')handle.quiet();}}).catch(error=>{if(!controller.signal.aborted)void bridge().desktop({action:'live-error',id,code:error instanceof Error?error.name:undefined});});
    return()=>{controller.abort();liveAudio.current=null;preserveWake.current=false;standby.current?.abort();standby.current=null;wakeFrames.current=[];};
  },[state.mode,state.id]);
  useEffect(()=>{if(state.phase==='closing')liveAudio.current?.quiet();},[state.phase]);
  useEffect(()=>{
    if(state.mode==='agent'){generation.current++;cleanup.current();return;}
    if(!state.recording){if(recorder.current?.state==='recording')recorder.current.stop();if(state.phase==='idle'||state.phase==='error'){generation.current++;cleanup.current();}return;}
    if(recorder.current||starting.current||!state.id)return;
    const id=state.id;const token=generation.current;starting.current=true;
    void (async()=>{
      let stream:MediaStream|null=null;let context:AudioContext|null=null;let interval:ReturnType<typeof setInterval>|undefined;
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
        if(token!==generation.current||current.current.id!==id||!current.current.recording){stream.getTracks().forEach(t=>t.stop());return;}
        const mic=new MediaRecorder(stream,{mimeType:'audio/webm;codecs=opus'});recorder.current=mic;
        const chunks:Blob[]=[];let bytes=0;let sent=false;
        const release=()=>{if(interval)clearInterval(interval);stream?.getTracks().forEach(t=>t.stop());void context?.close();recorder.current=null;};cleanup.current=()=>{sent=true;if(mic.state==='recording')mic.stop();release();};
        mic.ondataavailable=e=>{bytes+=e.data.size;if(bytes<=8_000_000)chunks.push(e.data);else{sent=true;void bridge().desktop({action:'error',id,message:'Recording is too long. Please try a shorter passage.'});cleanup.current();}};
        mic.onerror=()=>{void bridge().desktop({action:'error',id,message:'Microphone interrupted. Please try again.'});cleanup.current();};
        mic.onstop=()=>{release();if(sent||current.current.id!==id)return;sent=true;void new Blob(chunks,{type:'audio/webm'}).arrayBuffer().then(buffer=>bridge().desktop({action:'audio',id,bytes:new Uint8Array(buffer)})).catch(()=>bridge().desktop({action:'error',id,message:'Could not finish recording. Please try again.'}));};
        mic.start(200);await bridge().desktop({action:'ready',id});
        context=new AudioContext();const analyser=context.createAnalyser();analyser.fftSize=1024;context.createMediaStreamSource(stream).connect(analyser);const data=new Float32Array(analyser.fftSize);let heard=false;let lastSpeech=Date.now();const began=Date.now();
        interval=setInterval(()=>{analyser.getFloatTimeDomainData(data);const rms=Math.sqrt(data.reduce((sum,n)=>sum+n*n,0)/data.length);if(rms>.018){heard=true;lastSpeech=Date.now();}if(mic.state==='recording'&&((state.mode==='agent'&&heard&&Date.now()-lastSpeech>1100&&Date.now()-began>1000)||Date.now()-began>90000))mic.stop();},100);
      }catch{stream?.getTracks().forEach(t=>t.stop());await bridge().desktop({action:'error',id,message:'Allow microphone access in System Settings, then try again.'});}
      finally{starting.current=false;}
    })();
  },[state.id,state.recording,state.phase,state.mode]);
  return <main onMouseEnter={()=>void bridge().desktop({action:'widget-interactive',interactive:true})} onMouseLeave={()=>void bridge().desktop({action:'widget-interactive',interactive:false})} className={`notch ${(state as SessionState&{companionVisible?:boolean}).companionVisible?'detached':''} ${state.phase==='idle'?'hidden':''}`}><div className="notch-top"><span className={`notch-orb-state ${state.reply?'speaking':state.recording?'listening':'quiet'}`}><Orb small/></span><div className="notch-copy"><strong>{state.message||'Cleo'}</strong><span>{state.mode==='dictation'?'Dictation':'Live agent'}</span></div>{state.phase==='listening'||state.phase==='confirming'?<span className="listening-dot" aria-hidden="true"/>:<span className={`activity ${state.phase}`}/>}<button className="notch-close" aria-label="Cancel session" onClick={()=>void bridge().desktop({action:'cancel'})}><Icon name="close" size={16}/></button></div>{state.reply&&!(state as SessionState&{companionVisible?:boolean}).companionVisible&&state.phase!=='done'&&<p className="notch-reply" role="status">{state.reply}</p>}{state.phase==='error'&&<p className="notch-reply">{state.transcript||'Press your shortcut to try again.'}</p>}<div className="notch-edge"/></main>;
}

export function DesktopApp(){const view=new URLSearchParams(location.search).get('view');return view==='gaze'?<WebGazerCalibration/>:view==='widget'?<Notch/>:<Workspace/>;}
