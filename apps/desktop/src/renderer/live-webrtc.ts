/** Direct full-duplex audio. No MediaRecorder, transcription gate, or synthesized speech queue. */
export async function startLiveWebRTC(options:{id:string;signal:AbortSignal;request(input:Record<string,unknown>):Promise<any>;onFailure():void}):Promise<{close():void;quiet():void}> {
  let stream:MediaStream|null=null;let pc:RTCPeerConnection|null=null;
  const speaker=new Audio();speaker.autoplay=true;
  let startupTimer:ReturnType<typeof setTimeout>|null=null;
  let sessionStarted=false;let reportedReady=false;
  let closed=false;let disconnectTimer:ReturnType<typeof setTimeout>|null=null;
  function close(){if(closed)return;closed=true;if(startupTimer)clearTimeout(startupTimer);if(disconnectTimer)clearTimeout(disconnectTimer);options.signal.removeEventListener('abort',close);stream?.getTracks().forEach(track=>track.stop());pc?.close();speaker.pause();speaker.srcObject=null;}
  options.signal.addEventListener('abort',close,{once:true});
  try {
    options.signal.throwIfAborted();
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(closed||options.signal.aborted){stream.getTracks().forEach(t=>t.stop());options.signal.throwIfAborted();throw Error('Canceled');}
    pc=new RTCPeerConnection();const peer=pc;
    const fail=()=>{if(!closed){close();options.onFailure();}};
    peer.ontrack=event=>{if(closed)return;speaker.srcObject=event.streams[0]??new MediaStream([event.track]);void speaker.play().catch(fail);};
    const ready=()=>{if(!reportedReady&&sessionStarted&&peer.connectionState==='connected'){reportedReady=true;if(startupTimer)clearTimeout(startupTimer);startupTimer=null;void options.request({action:'live-ready',id:options.id}).catch(fail);}};
    peer.onconnectionstatechange=()=>{
      if(peer.connectionState==='failed'){fail();return;}
      if(peer.connectionState==='disconnected'&&!disconnectTimer)disconnectTimer=setTimeout(fail,5000);
      if(peer.connectionState==='connected'){if(disconnectTimer)clearTimeout(disconnectTimer);disconnectTimer=null;ready();}
    };
    for(const track of stream.getAudioTracks()){track.onended=fail;peer.addTrack(track,stream);}
    // Speech control is native GPT-Live. Backend delegation runs on the main-process sideband.
    const events=peer.createDataChannel('oai-events');events.onclose=()=>{if(!closed)fail();};events.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.type==='session.started'){sessionStarted=true;ready();}}catch{fail();}};
    const offer=await peer.createOffer();await peer.setLocalDescription(offer);options.signal.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{if(peer.iceGatheringState==='complete'){resolve();return;}const done=()=>{clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',changed);options.signal.removeEventListener('abort',abort);};const changed=()=>{if(peer.iceGatheringState==='complete'){done();resolve();}};const abort=()=>{done();reject(Error('Canceled'));};const timer=setTimeout(()=>{done();reject(Error('Audio network setup timed out.'));},5000);peer.addEventListener('icegatheringstatechange',changed);options.signal.addEventListener('abort',abort,{once:true});});
    const response=await options.request({action:'live-connect',id:options.id,sdp:peer.localDescription?.sdp});
    options.signal.throwIfAborted();if(closed)throw Error('Canceled');
    startupTimer=setTimeout(fail,15000);
    await peer.setRemoteDescription({type:'answer',sdp:response.sdp});
    return {close,quiet(){stream?.getAudioTracks().forEach(track=>track.enabled=false);speaker.pause();}};
  }catch(error){close();throw error;}
}
