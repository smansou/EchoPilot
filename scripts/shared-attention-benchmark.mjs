/** Reproduce: node --import tsx scripts/shared-attention-benchmark.mjs [output.json]
 * Synthetic local evidence only. Timings are machine-specific and do not measure gaze accuracy.
 */
import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {SharedAttentionTracker} from '../apps/desktop/src/main/shared-attention.ts';
import {SharedScreenContextFeed} from '../apps/desktop/src/main/shared-screen-context.ts';
function scene(count){const columns=25,rows=Math.ceil((count-1)/columns);return [
  {id:'window',revision:'1',app:'Benchmark',window:'Synthetic',type:'window',label:'Synthetic scene',bounds:{x:0,y:0,width:columns*100,height:rows*90}},
  ...Array.from({length:count-1},(_,index)=>({id:'region-'+index,parentId:'window',revision:'1',app:'Benchmark',window:'Synthetic',type:'AXButton',label:'Synthetic control '+index,bounds:{x:(index%columns)*100+8,y:Math.floor(index/columns)*90+8,width:84,height:74}}))];}
function run(count,moving,sigma=6){const regions=scene(count),tracker=new SharedAttentionTracker(),feed=new SharedScreenContextFeed({intervalMs:1000,maxBytes:1200,bytesPerMinute:8000,maxRegions:4});const timings=[];let packets=0,bytes=0,peakMinuteBytes=0,stable=0;
  // Warm up outside the measured sequence, then reset all temporal state.
  for(let index=0;index<40;index++){const at=index*100;tracker.observe(regions,at,at);tracker.update({capturedAt:at,mean:{x:50,y:45},covariance:{xx:36,xy:0,yy:36},quality:.9},at);}tracker.reset();
  for(let index=0;index<1000;index++){const at=index*100;const region=regions[1+(moving?Math.floor(index/20)%(regions.length-1):0)];const mean={x:(sigma>35?regions[0].bounds.width/2:region.bounds.x+region.bounds.width/2)+Math.sin(index*1.7)*2,y:(sigma>35?regions[0].bounds.height/2:region.bounds.y+region.bounds.height/2)+Math.cos(index*.91)*2};
    if(index%7===0)tracker.observe(regions,at,at);const started=performance.now();const attention=tracker.update({capturedAt:at,mean,covariance:{xx:sigma*sigma,xy:sigma*sigma/4,yy:(sigma*7/6)**2},quality:.9},at);timings.push(performance.now()-started);if(attention.state==='stable')stable++;
    feed.offer({app:'Benchmark',window:'Synthetic',revision:'clock-'+index,capturedAt:Math.floor(index/7)*700,attention},at);const packet=feed.flush(at);if(packet){const size=Buffer.byteLength(JSON.stringify(packet));assert.ok(size<=1200);packets++;bytes+=size;}const usage=feed.usage(at).bytesInLastMinute;assert.ok(usage<=8000);peakMinuteBytes=Math.max(peakMinuteBytes,usage);
  }
  const sorted=timings.slice().sort((a,b)=>a-b),round=value=>Number(value.toFixed(3));
  const hypotheticalRawBytes=Buffer.byteLength(JSON.stringify({app:'Benchmark',window:'Synthetic',regions}))*100;
  return {regions:count,samples:1000,syntheticDurationSeconds:100,moving,uncertaintySigmaX:sigma,uncertaintySigmaY:Number((sigma*7/6).toFixed(2)),meanJitterAmplitude:2,updateMilliseconds:{p50:round(sorted[500]),p95:round(sorted[950]),max:round(sorted.at(-1))},stableSamples:stable,semanticPackets:packets,semanticBytes:bytes,peakRollingMinuteBytes:peakMinuteBytes,hypotheticalRawSceneAt1HzBytes:hypotheticalRawBytes,
    hypotheticalTrafficReductionPercent:Number((100*(1-bytes/hypotheticalRawBytes)).toFixed(2))};
}
const metrics={capturedAt:new Date().toISOString(),machine:{cpu:cpus()[0]?.model,arch:process.arch,node:process.version},method:'1000 deterministic synthetic jitter samples at simulated10Hz; pure local update timing only; hypothetical full synthetic AX-like JSON at1Hz traffic baseline, not a prior-product measurement.',limitations:'No human gaze accuracy, calibration, native AX/OCR latency, provider latency, network costs or comparative state-of-the-art claims.',productionBudget:{intervalMs:1000,maxPacketBytes:1200,bytesPerRollingMinute:8000},runs:[run(150,false),run(600,false),run(150,true),run(600,true),run(150,false,175),run(600,false,175)]};
assert.ok(metrics.runs.filter(run=>!run.moving).every(run=>run.semanticPackets<=3),'Stationary semantic state must suppress repeated frame/scene revisions');
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(metrics,null,2)+'\n');
process.stdout.write(JSON.stringify(metrics,null,2)+'\n');
