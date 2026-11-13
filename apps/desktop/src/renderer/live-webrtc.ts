/** Direct full-duplex audio. No MediaRecorder, transcription gate, or synthesized speech queue. */
export async function startLiveWebRTC(options:{openingAudio?():Uint8Array[];id:string;signal:AbortSignal;request(input:Record<string,unknown>):Promise<any>;onFailure():void}):Promise<{close():void;quiet():void}> {
  let spool:AudioContext|null=null;let handoff:AudioWorkletNode|null=null;let stream:MediaStream|null=null;let pc:RTCPeerConnection|null=null;
  const speaker=new Audio();speaker.autoplay=true;
  let startupTimer:ReturnType<typeof setTimeout>|null=null;
  let sessionStarted=false;let reportedReady=false;let sender:RTCRtpSender|null=null;let switching=false;let replayStream:MediaStream|null=null;
  let closed=false;let disconnectTimer:ReturnType<typeof setTimeout>|null=null;
  function releaseReplay(){handoff?.disconnect();handoff=null;replayStream?.getTracks().forEach(track=>track.stop());replayStream=null;void spool?.close();spool=null;}
  function close(){if(closed)return;closed=true;if(startupTimer)clearTimeout(startupTimer);if(disconnectTimer)clearTimeout(disconnectTimer);options.signal.removeEventListener('abort',close);stream?.getTracks().forEach(track=>track.stop());releaseReplay();pc?.close();speaker.pause();speaker.srcObject=null;}
  options.signal.addEventListener('abort',close,{once:true});
  try {
    options.signal.throwIfAborted();
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(closed||options.signal.aborted){stream.getTracks().forEach(t=>t.stop());options.signal.throwIfAborted();throw Error('Canceled');}
    pc=new RTCPeerConnection();const peer=pc;
    const fail=()=>{if(!closed){close();options.onFailure();}};
    // Replay only bridges wake/connection startup. Keeping its queue in the call can
    // leave every future interruption seconds behind the physical microphone.
    // A first answer/backchannel also ends replay: prioritize the current mic over
    // any remaining startup tail. Full-duplex backchannels can therefore cut that
    // tail short; lossless replay at 1x cannot also remove a non-silent backlog.
    const useNativeMicrophone=()=>{
      const track=stream?.getAudioTracks()[0];if(closed||switching||!handoff||!sender||!track)return;
      switching=true;
      void sender.replaceTrack(track).then(()=>{releaseReplay();},fail);
    };
    peer.ontrack=event=>{if(closed)return;speaker.srcObject=event.streams[0]??new MediaStream([event.track]);void speaker.play().catch(fail);};
    const ready=()=>{if(!reportedReady&&sessionStarted&&peer.connectionState==='connected'){reportedReady=true;handoff?.port.postMessage({ready:true});if(startupTimer)clearTimeout(startupTimer);startupTimer=null;void options.request({action:'live-ready',id:options.id}).catch(fail);}};
    peer.onconnectionstatechange=()=>{
      if(peer.connectionState==='failed'){fail();return;}
      if(peer.connectionState==='disconnected'&&!disconnectTimer)disconnectTimer=setTimeout(fail,5000);
      if(peer.connectionState==='connected'){if(disconnectTimer)clearTimeout(disconnectTimer);disconnectTimer=null;ready();}
    };
    for(const track of stream.getAudioTracks())track.onended=fail;
    let outgoing=stream;
    if(options.openingAudio){
      spool=new AudioContext({sampleRate:16000});await spool.audioWorklet.addModule(new URL('./live-handoff-worklet.js',import.meta.url));options.signal.throwIfAborted();
      handoff=new AudioWorkletNode(spool,'echo-handoff');handoff.onprocessorerror=fail;handoff.port.onmessage=event=>{if(event.data.overflow)fail();else if(event.data.caughtUp)useNativeMicrophone();};
      const buffered=options.openingAudio();for(const bytes of buffered)handoff.port.postMessage({pcm:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
      const destination=spool.createMediaStreamDestination();replayStream=destination.stream;spool.createMediaStreamSource(stream).connect(handoff).connect(destination);await spool.resume();options.signal.throwIfAborted();outgoing=destination.stream;
    }
    for(const track of outgoing.getAudioTracks())sender=peer.addTrack(track,outgoing);
    // Speech control is native GPT-Live. Backend delegation runs on the main-process sideband.
    const events=peer.createDataChannel('oai-events');events.onclose=()=>{if(!closed)fail();};events.onmessage=event=>{if(closed)return;try{const value=JSON.parse(event.data);if(value.type==='session.started'){sessionStarted=true;ready();}else if(value.type==='session.output_transcript.delta'){useNativeMicrophone();}}catch{fail();}};
    const offer=await peer.createOffer();await peer.setLocalDescription(offer);options.signal.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{if(peer.iceGatheringState==='complete'){resolve();return;}const done=()=>{clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',changed);options.signal.removeEventListener('abort',abort);};const changed=()=>{if(peer.iceGatheringState==='complete'){done();resolve();}};const abort=()=>{done();reject(Error('Canceled'));};const timer=setTimeout(()=>{done();reject(Error('Audio network setup timed out.'));},5000);peer.addEventListener('icegatheringstatechange',changed);options.signal.addEventListener('abort',abort,{once:true});});
    const response=await options.request({action:'live-connect',id:options.id,sdp:peer.localDescription?.sdp});
    options.signal.throwIfAborted();if(closed)throw Error('Canceled');
    startupTimer=setTimeout(fail,15000);
    await peer.setRemoteDescription({type:'answer',sdp:response.sdp});
    return {close,quiet(){handoff?.port.postMessage({quiet:true});stream?.getAudioTracks().forEach(track=>track.enabled=false);speaker.pause();}};
  }catch(error){close();throw error;}
}
