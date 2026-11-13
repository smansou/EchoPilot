import {test} from 'node:test';import assert from 'node:assert/strict';import {startLiveWebRTC} from './live-webrtc';
test('continuous realtime media owns one peer and releases microphone/speaker on cancel',async()=>{
  const originalAudio=globalThis.Audio,originalPeer=globalThis.RTCPeerConnection;const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');let stopped=0,closed=0,paused=0;const requests:any[]=[];
  class Peer{connectionState='new';iceGatheringState='complete';localDescription={sdp:'v=0'};channel:any={};ontrack:any;onconnectionstatechange:any;createDataChannel(){return this.channel;};addTrack(){}async createOffer(){return {sdp:'v=0',type:'offer'};}async setLocalDescription(){}async setRemoteDescription(){this.channel.onmessage({data:JSON.stringify({type:'session.started'})});this.connectionState='connected';this.onconnectionstatechange?.();}close(){closed++;}}
  try{globalThis.Audio=class {autoplay=false;srcObject:any;pause(){paused++;}async play(){}} as any;globalThis.RTCPeerConnection=Peer as any;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}],getAudioTracks:()=>[{}]})}}});
    const controller=new AbortController();const stop=await startLiveWebRTC({id:'session',signal:controller.signal,request:async input=>{requests.push(input);return {sdp:'v=0'};},onFailure(){throw Error('unexpected');}});
    assert.deepEqual(requests.map(r=>r.action),['live-connect','live-ready']);assert.equal(stopped,0);controller.abort();stop.close();assert.equal(stopped,1);assert.equal(closed,1);assert.equal(paused,1);
  }finally{globalThis.Audio=originalAudio;globalThis.RTCPeerConnection=originalPeer;if(nav)Object.defineProperty(globalThis,'navigator',nav);}
});

test('wake replay leaves the audio path at the first provider answer and cancellation cannot restore capture',async()=>{
 const keys=['Audio','RTCPeerConnection','AudioContext','AudioWorkletNode'] as const;const originals=new Map(keys.map(key=>[key,(globalThis as any)[key]]));const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let peer:any,worklet:any,replayClosed=0,replayStopped=0,failed=0;let completeReplacement:(()=>void)|undefined;const replacements:any[]=[];
 const mic={enabled:true,stop(){this.enabled=false;}};const microphone={getTracks:()=>[mic],getAudioTracks:()=>[mic]};const replay={getTracks:()=>[{stop(){replayStopped++;}}],getAudioTracks:()=>[{replay:true}]};
 class Peer{connectionState='new';iceGatheringState='complete';localDescription={sdp:'v=0'};channel:any={};onconnectionstatechange:any;constructor(){peer=this;}createDataChannel(){return this.channel;}addTrack(track:any){assert.equal(track.replay,true);return {replaceTrack:(next:any)=>{replacements.push(next);return new Promise<void>(resolve=>{completeReplacement=resolve;});}};}async createOffer(){return {sdp:'v=0',type:'offer'};}async setLocalDescription(){}async setRemoteDescription(){this.channel.onmessage({data:'{"type":"session.started"}'});this.connectionState='connected';this.onconnectionstatechange();}close(){}}
 try{
  (globalThis as any).Audio=class{pause(){}play(){return Promise.resolve();}};(globalThis as any).RTCPeerConnection=Peer;
  (globalThis as any).AudioContext=class{audioWorklet={addModule:async()=>{}};createMediaStreamDestination(){return {stream:replay};}createMediaStreamSource(){return {connect:()=>({connect(){}})};}async resume(){}async close(){replayClosed++;}};
  (globalThis as any).AudioWorkletNode=class{port={postMessage(){},onmessage:null};constructor(){worklet=this;}disconnect(){}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>microphone}}});
  const controller=new AbortController();const handle=await startLiveWebRTC({id:'wake',signal:controller.signal,openingAudio:()=>[new Uint8Array([0,1])],request:async()=>({sdp:'v=0'}),onFailure(){failed++;}});
  assert.equal(replacements.length,0);
  peer.channel.onmessage({data:'{"type":"session.output_transcript.delta","delta":"Hello"}'});
  peer.channel.onmessage({data:'{"type":"session.output_transcript.delta","delta":" again"}'});
  worklet.port.onmessage({data:{caughtUp:true}});
  assert.deepEqual(replacements,[mic]);assert.equal(replayClosed,0);
  handle.quiet();assert.equal(mic.enabled,false);controller.abort();completeReplacement!();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mic.enabled,false);assert.equal(replayStopped,1);assert.equal(replayClosed,1);assert.equal(failed,0);
 }finally{for(const [key,value] of originals)(globalThis as any)[key]=value;if(nav)Object.defineProperty(globalThis,'navigator',nav);}
});
