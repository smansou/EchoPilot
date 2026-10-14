import {test} from 'node:test';import assert from 'node:assert/strict';import {startLiveWebRTC} from './live-webrtc';
test('continuous realtime media owns one peer and releases microphone/speaker on cancel',async()=>{
  const originalAudio=globalThis.Audio,originalPeer=globalThis.RTCPeerConnection;const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');let stopped=0,closed=0,paused=0;const requests:any[]=[];
  class Peer{connectionState='new';iceGatheringState='complete';localDescription={sdp:'v=0'};channel:any={};ontrack:any;onconnectionstatechange:any;createDataChannel(){return this.channel;};addTrack(){}async createOffer(){return {sdp:'v=0',type:'offer'};}async setLocalDescription(){}async setRemoteDescription(){this.channel.onmessage({data:JSON.stringify({type:'session.started'})});this.connectionState='connected';this.onconnectionstatechange?.();}close(){closed++;}}
  try{globalThis.Audio=class {autoplay=false;srcObject:any;pause(){paused++;}async play(){}} as any;globalThis.RTCPeerConnection=Peer as any;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}],getAudioTracks:()=>[{}]})}}});
    const controller=new AbortController();const stop=await startLiveWebRTC({id:'session',signal:controller.signal,request:async input=>{requests.push(input);return {sdp:'v=0'};},onFailure(){throw Error('unexpected');}});
    assert.deepEqual(requests.map(r=>r.action),['live-connect','live-ready']);assert.equal(stopped,0);controller.abort();stop.close();assert.equal(stopped,1);assert.equal(closed,1);assert.equal(paused,1);
  }finally{globalThis.Audio=originalAudio;globalThis.RTCPeerConnection=originalPeer;if(nav)Object.defineProperty(globalThis,'navigator',nav);}
});
