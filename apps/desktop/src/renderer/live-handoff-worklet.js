// Bounded audio spool for wake-to-WebRTC startup. Speech is replayed at its original rate.
// Once 200ms of silence has played, discard queued silence to return to live timing.
class EchoHandoff extends AudioWorkletProcessor {
  constructor(){super();this.queue=new Float32Array(16000*8);this.read=0;this.write=0;this.ready=false;this.quiet=0;this.failed=false;
    this.port.onmessage=event=>{if(event.data.quiet){this.ready=false;this.read=this.write;this.queue.fill(0);}if(event.data.ready)this.ready=true;if(event.data.pcm){const values=new Int16Array(event.data.pcm);this.append(Float32Array.from(values,n=>n/32768));}};
  }
  append(values){if(this.failed)return;if(this.write-this.read+values.length>this.queue.length){this.failed=true;this.port.postMessage({overflow:true});return;}for(const value of values)this.queue[this.write++%this.queue.length]=value;}
  process(inputs,outputs){const input=inputs[0]?.[0];if(input)this.append(input);const output=outputs[0]?.[0];if(!output||!this.ready||this.failed)return true;
    if(this.quiet>=3200){while(this.write-this.read>1600&&Math.abs(this.queue[this.read%this.queue.length])<.003)this.read++;}
    for(let i=0;i<output.length;i++){const sample=this.read<this.write?this.queue[this.read++%this.queue.length]:0;output[i]=sample;this.quiet=Math.abs(sample)<.003?this.quiet+1:0;}return true;
  }
}
registerProcessor('echo-handoff',EchoHandoff);
