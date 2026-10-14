// AudioWorklet runs independently of the UI; 20 ms mono PCM frames at 16 kHz.
class EchoCapture extends AudioWorkletProcessor {
  constructor(){super();this.frame=new Int16Array(320);this.position=0;}
  process(inputs){const samples=inputs[0]?.[0];if(samples)for(const sample of samples){this.frame[this.position++]=Math.round(Math.max(-1,Math.min(1,sample))*32767);if(this.position===320){this.port.postMessage(this.frame.buffer,[this.frame.buffer]);this.frame=new Int16Array(320);this.position=0;}}return true;}
}
registerProcessor('echo-capture',EchoCapture);
