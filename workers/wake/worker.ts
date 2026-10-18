import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {SentencePieceProcessor} from '@sctg/sentencepiece-js';
const require=createRequire(join(__dirname,'wake-worker.cjs'));
const {KeywordSpotter}=require('./wake-runtime/sherpa-onnx-node');
const directory=join(__dirname,'wake-model');
const temporary=mkdtempSync(join(tmpdir(),'echo-wake-'));
let tokenizer:SentencePieceProcessor|null=null;let spotter:any=null,stream:any=null;
const send=(value:unknown)=>process.send?.(value);
function create(phrase:string,threshold:number){
  if(!/^[a-zA-Z][a-zA-Z' -]{2,59}$/.test(phrase)||!Number.isFinite(threshold)||threshold<.1||threshold>.9)throw Error('Use a short English wake phrase.');
  const pieces=tokenizer!.encodePieces(phrase.trim().toUpperCase());
  const vocabulary=new Set(readFileSync(join(directory,'tokens.txt'),'utf8').split('\n').map(line=>line.split(' ')[0]));
  if(!pieces.length||pieces.some(p=>!vocabulary.has(p)))throw Error('This wake phrase contains sounds the installed English model cannot encode.');
  const keywords=join(temporary,'keywords.txt');writeFileSync(keywords,pieces.join(' ')+` :1.5 #${threshold} @WAKE\n`,{mode:0o600});
  const detector=new KeywordSpotter({featConfig:{sampleRate:16000,featureDim:80},modelConfig:{transducer:{encoder:join(directory,'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),decoder:join(directory,'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),joiner:join(directory,'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx')},tokens:join(directory,'tokens.txt'),numThreads:1,provider:'cpu',debug:0},keywordsFile:keywords,maxActivePaths:4,numTrailingBlanks:1,keywordsScore:1.5,keywordsThreshold:threshold});
  return detector;
}
function feed(detector:any,target:any,pcm:Int16Array){const samples=new Float32Array(pcm.length);for(let i=0;i<pcm.length;i++)samples[i]=pcm[i]!/32768;target.acceptWaveform({samples,sampleRate:16000});let hit=false;while(detector.isReady(target)){detector.decode(target);if(detector.getResult(target).keyword){hit=true;detector.reset(target);}}return hit;}
let queue=Promise.resolve();
process.on('message',(input:any)=>{queue=queue.then(async()=>{
  try {
    if(input.type==='configure'){
      tokenizer??=new SentencePieceProcessor();await tokenizer.loadFromB64StringModel(readFileSync(join(directory,'bpe.model')).toString('base64'));
      spotter=create(input.phrase,input.threshold);stream=spotter.createStream();send({type:'ready'});
    }else if(input.type==='audio'&&spotter&&input.pcm instanceof Int16Array&&input.pcm.length<=8000){if(feed(spotter,stream,input.pcm))send({type:'detected'});}
    else if(input.type==='reset'&&spotter){stream=spotter.createStream();send({type:'reset'});}
    else if(input.type==='calibrate'&&tokenizer){
      const measurements=[];
      for(const threshold of [.2,.35,.5,.65]){const detector=create(input.phrase,threshold);let positives=0,negatives=0;
        for(const sample of input.samples){if(!(sample.pcm instanceof Int16Array)||sample.pcm.length>640000)throw Error('Invalid calibration audio.');const target=detector.createStream();let detected=false;
          for(let i=0;i<sample.pcm.length;i+=1600)detected=feed(detector,target,sample.pcm.subarray(i,i+1600))||detected;
          detected=feed(detector,target,new Int16Array(16000))||detected;
          if(detected){if(sample.positive)positives++;else negatives++;}
        }measurements.push({threshold,positives,negatives});}
      send({type:'calibrated',measurements});
    }
  }catch(error){if(process.env.ECHOPILOT_WAKE_DEBUG==='1')console.error(error);send({type:'error',message:'Local wake detection failed. Check the bundled model and choose an English phrase.'});}
}).catch(()=>{});});
process.on('SIGTERM',()=>{rmSync(temporary,{recursive:true,force:true});process.exit(0);});
process.on('disconnect',()=>{rmSync(temporary,{recursive:true,force:true});process.exit(0);});
