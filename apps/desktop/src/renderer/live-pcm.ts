export type LiveMedia={sessionId:string;type:'audio'|'interrupt';pcmBase64?:string;sampleRate?:24000};
export type AudioHandle={close():void;quiet():void};
export async function startLivePCM(options:{openingAudio?():Uint8Array[];id:string;signal:AbortSignal;request(input:Record<string,unknown>):Promise<any>;subscribe(listener:(event:LiveMedia)=>void):()=>void;onFailure():void}):Promise<AudioHandle>{
  let stream:MediaStream|null=null;let input:AudioContext|null=null;let output:AudioContext|null=null;let capture:AudioWorkletNode|null=null;let unsubscribe=()=>{};let closed=false;let quiet=false;let pending=0;let connected=false;let next=0;
  let openingFrames:Uint8Array[]=[];let openingBytes=0;let flushing=false;
  const sources=new Set<AudioBufferSourceNode>();
  function interrupt(){for(const source of sources){try{source.stop();}catch{}}sources.clear();next=0;}
  function silence(){quiet=true;stream?.getAudioTracks().forEach(t=>t.enabled=false);interrupt();}
  function close(){if(closed)return;closed=true;for(const frame of openingFrames)frame.fill(0);openingFrames=[];silence();unsubscribe();capture?.disconnect();stream?.getTracks().forEach(t=>t.stop());void input?.close();void output?.close();options.signal.removeEventListener('abort',close);}
  const fail=()=>{if(!closed){close();options.onFailure();}};
  options.signal.addEventListener('abort',close,{once:true});
  try{
    options.signal.throwIfAborted();
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(closed||options.signal.aborted){stream.getTracks().forEach(t=>t.stop());throw Error('Canceled');}
    for(const track of stream.getAudioTracks())track.onended=fail;
    input=new AudioContext({sampleRate:16000});output=new AudioContext({sampleRate:24000});
    await input.audioWorklet.addModule(new URL('./live-pcm-worklet.js',import.meta.url));options.signal.throwIfAborted();
    capture=new AudioWorkletNode(input,'echo-capture');capture.onprocessorerror=fail;
    capture.port.onmessage=event=>{if(closed||quiet)return;if(!connected||flushing){openingBytes+=event.data.byteLength;if(openingBytes>256000){fail();return;}openingFrames.push(new Uint8Array(event.data));return;}if(pending>=8){fail();return;}pending++;void options.request({action:'live-audio',id:options.id,bytes:new Uint8Array(event.data)}).catch(fail).finally(()=>pending--);};
    openingFrames=options.openingAudio?.()??[];openingBytes=openingFrames.reduce((n,f)=>n+f.length,0);
    const source=input.createMediaStreamSource(stream);source.connect(capture);
    const mute=input.createGain();mute.gain.value=0;capture.connect(mute).connect(input.destination);
    unsubscribe=options.subscribe(event=>{
      if(event.sessionId!==options.id||closed||quiet)return;
      if(event.type==='interrupt'){interrupt();return;}
      try{
        if(!output||!event.pcmBase64)return;
        const raw=atob(event.pcmBase64);if(!raw.length||raw.length%2||raw.length>144000)throw Error('Invalid audio');
        const buffer=output.createBuffer(1,raw.length/2,24000);const samples=buffer.getChannelData(0);
        for(let i=0;i<samples.length;i++){const value=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);samples[i]=(value>=32768?value-65536:value)/32768;}
        // A bounded queue preserves timing without accumulating unbounded delayed speech.
        next=Math.max(next,output.currentTime+.015);if(next-output.currentTime>60)throw Error('Audio queue exceeded');
        const player=output.createBufferSource();player.buffer=buffer;player.connect(output.destination);sources.add(player);player.onended=()=>{sources.delete(player);player.disconnect();};player.start(next);next+=buffer.duration;
      }catch{fail();}
    });
    await options.request({action:'live-connect',id:options.id});options.signal.throwIfAborted();flushing=true;connected=true;
    while(openingFrames.length){options.signal.throwIfAborted();const bytes=openingFrames.shift()!;openingBytes-=bytes.length;await options.request({action:'live-audio',id:options.id,bytes});}flushing=false;

    await Promise.all([input.resume(),output.resume()]);options.signal.throwIfAborted();
    await options.request({action:'live-ready',id:options.id});return {close,quiet:silence};
  }catch(error){close();throw error;}
}
