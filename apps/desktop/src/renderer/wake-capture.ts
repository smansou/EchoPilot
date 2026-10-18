/** Local-only 16 kHz capture. Nothing here contacts a provider or persists audio. */
export async function captureWakeAudio(options:{signal:AbortSignal;chunk(bytes:Uint8Array):void;failed():void}){
  let stream:MediaStream|null=null,context:AudioContext|null=null,capture:AudioWorkletNode|null=null;let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;capture?.disconnect();stream?.getTracks().forEach(t=>t.stop());void context?.close();options.signal.removeEventListener('abort',stop);};
  options.signal.addEventListener('abort',stop,{once:true});
  try{options.signal.throwIfAborted();stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(options.signal.aborted||stopped){stream.getTracks().forEach(t=>t.stop());throw Error('Capture canceled.');}
    for(const track of stream.getAudioTracks())track.onended=()=>{stop();options.failed();};
    context=new AudioContext({sampleRate:16000});await context.audioWorklet.addModule(new URL('./live-pcm-worklet.js',import.meta.url));options.signal.throwIfAborted();
    capture=new AudioWorkletNode(context,'echo-capture');capture.onprocessorerror=()=>{stop();options.failed();};capture.port.onmessage=event=>{if(!stopped)options.chunk(new Uint8Array(event.data));};
    context.createMediaStreamSource(stream).connect(capture);const mute=context.createGain();mute.gain.value=0;capture.connect(mute).connect(context.destination);await context.resume();options.signal.throwIfAborted();return stop;
  }catch(error){stop();throw error;}
}
