import {SharedAttentionTracker,type AttentionResult,type ScreenRegion,type GazeDistribution} from './shared-attention';
import {SharedScreenContextFeed} from './shared-screen-context';
import {screenRegions} from './screen-regions';
import type {DesktopObserveResult} from './desktop-observe';
import type {GazeSample} from '../../../../packages/gaze/src/index';
export type SharedScreenStatus={enabled:boolean;phase:'off'|'waiting-gaze'|'reading'|'tracking'|'paused';message:string;target:{id:string;label:string;kind:string}|null;regions:number;updates:number;bytesInLastMinute:number;lastObservationMs:number;observationDurationMs:number};
export function createSharedScreenSession(options:{allowed():boolean;samples():readonly GazeSample[];observe():Promise<DesktopObserveResult>;voiceSession():string|null;send(content:string):boolean;highlight(attention:AttentionResult):void;now?():number}){
  const now=options.now??Date.now;
  const tracker=new SharedAttentionTracker();
  const feed=new SharedScreenContextFeed({intervalMs:1000,maxBytes:1200,bytesPerMinute:8000,maxRegions:4});
  let enabled=false,generation=0,flight=false,timer:ReturnType<typeof setInterval>|null=null,lastPoll=-Infinity;
  let observation:Promise<void>|null=null;
  let scene:ReturnType<typeof screenRegions>|null=null,voiceId:string|null=null;
  let status:SharedScreenStatus={enabled:false,phase:'off',message:'Screen sharing is off',target:null,regions:0,updates:0,bytesInLastMinute:0,lastObservationMs:0,observationDurationMs:0};
  let pinned:{at:number;target:ScreenRegion|null;previous:ScreenRegion|null;alternatives:ScreenRegion[];ambiguous:boolean}|null=null;
  let lastNotice='';
  let selected:{region:ScreenRegion;at:number}|null=null;
  const empty=(time:number):AttentionResult=>({state:'unavailable',target:null,candidates:[],uncertaintyRadius:0,changedAt:time,observedAt:time});
  function invalidate(message:string){if(message===lastNotice)return;if(options.voiceSession())try{lastNotice=message;options.send(JSON.stringify({sharedScreen:{state:'unavailable',targetId:null,reason:message,instruction:'Discard prior screen references. Gaze never authorizes actions.'}}));}catch{}}
  function clear(message='Screen context unavailable') {invalidate(message);tracker.reset(now());feed.reset(true);scene=null;pinned=null;selected=null;options.highlight(empty(now()));status={...status,target:null,regions:0,message};}
  function packet(){return feed.snapshot(now());}
  function usable(sample:GazeSample|undefined,time:number){if(!sample)return false;const age=time-Date.parse(sample.timestamp),xx=sample.covariance2x2[0][0],xy=sample.covariance2x2[0][1],yy=sample.covariance2x2[1][1];return age>=0&&age<800&&sample.quality>=.35&&sample.quality<=1&&[sample.meanX,sample.meanY,xx,xy,yy].every(Number.isFinite)&&xx>=0&&yy>=0&&xy*xy<=xx*yy+1e-6;}
  function attention(gaze:readonly GazeSample[],time:number){
    if(!usable(gaze.at(-1),time)){tracker.clear(time);return tracker.current(time);}
    const recent=gaze.filter(s=>usable(s,time)&&time-Date.parse(s.timestamp)<450);
    const last=recent.at(-1);if(!last)return tracker.current(time);
    const mean={x:recent.reduce((n,s)=>n+s.meanX,0)/recent.length,y:recent.reduce((n,s)=>n+s.meanY,0)/recent.length};
    const covariance={xx:last.covariance2x2[0][0]+recent.reduce((n,s)=>n+(s.meanX-mean.x)**2,0)/recent.length,xy:last.covariance2x2[0][1],yy:last.covariance2x2[1][1]+recent.reduce((n,s)=>n+(s.meanY-mean.y)**2,0)/recent.length};
    const distribution:GazeDistribution={capturedAt:Date.parse(last.timestamp),mean,covariance,quality:last.quality};
    return tracker.update(distribution,time);
  }
  function currentAttention(time:number){const value=attention(options.samples(),time);if(selected){const region=scene?.regions.find(r=>r.id===selected!.region.id&&r.revision===selected!.region.revision);if(!region||!valid(region)||time-selected.at>5000)selected=null;else return {...value,state:'stable' as const,target:region};}return value;}
  async function readOnce(){if(flight||!enabled||!options.allowed())return;const token=generation,started=now();flight=true;lastPoll=started;status={...status,phase:'reading'};
    try{const result=await options.observe();if(token!==generation||!enabled||!options.allowed())return;
      status={...status,observationDurationMs:now()-started};
      if(result.outcome!=='observed'){clear(result.outcome==='denied'?result.code.replaceAll('_',' '):'Screen context is temporarily unavailable');status={...status,phase:'paused'};return;}
      const next=screenRegions(result.evidence);
      if(next.scope!==scene?.scope){tracker.reset(now());pinned=null;selected=null;feed.reset(true);}
      scene=next;tracker.observe(next.regions,next.capturedAt,now());status={...status,regions:next.regions.length,lastObservationMs:now(),message:next.regions.length?'Local screen context ready':'This window exposes no readable target boxes'};
    }catch{if(token===generation){clear('Could not read the current window');status={...status,phase:'paused'};}}
    finally{flight=false;}
  }
  function read(){if(observation)return observation;const task=readOnce();observation=task;void task.finally(()=>{if(observation===task)observation=null;});return task;}
  function tick(){if(!enabled)return;const time=now();if(!options.allowed()){generation++;clear('Screen sharing paused while private or muted');status={...status,phase:'paused'};return;}
    const samples=options.samples();if(!usable(samples.at(-1),time)){if(status.phase!=='waiting-gaze')invalidate('Gaze tracking unavailable');tracker.reset(time);options.highlight(empty(time));pinned=null;selected=null;status={...status,phase:'waiting-gaze',target:null,message:'Calibrate gaze or look back at the screen'};return;}
    if(status.phase==='waiting-gaze'&&scene&&time-scene.capturedAt<=1200)tracker.observe(scene.regions,scene.capturedAt,time);
    if(time-lastPoll>=700)void read();
    const result=currentAttention(time);options.highlight(result);
    status={...status,phase:result.target?'tracking':scene?'reading':'paused',target:result.target?{id:result.target.id,label:result.target.label.slice(0,120),kind:result.target.type}:null};
    const sessionId=options.voiceSession();if(sessionId!==voiceId){voiceId=sessionId;feed.reset(true);}
    if(scene){feed.offer({app:scene.app,window:scene.window,revision:scene.revision,capturedAt:scene.capturedAt,attention:result},time);
      if(sessionId){const update=feed.flush(time);if(update){try{if(!options.send(JSON.stringify({sharedScreen:update})))feed.reset(true);else lastNotice='';}catch{feed.reset(true);}}}}
    const usage=feed.usage(time);status={...status,updates:usage.packets,bytesInLastMinute:usage.bytesInLastMinute};
  }
  function enable(value:boolean){generation++;enabled=value;clear(value?'Waiting for gaze':'Screen sharing is off');status={...status,enabled:value,phase:value?'waiting-gaze':'off'};if(timer)clearInterval(timer);timer=value?setInterval(tick,50):null;timer?.unref();if(value)tick();return {...status};}
  function describe(region:ScreenRegion|null){return region?{id:region.id,revision:region.revision,kind:region.type,label:region.label.slice(0,260)}:null;}
  function valid(region:ScreenRegion|null){return region&&scene&&now()-scene.capturedAt<=1200&&usable(options.samples().at(-1),now())&&scene.regions.some(r=>r.id===region.id&&r.revision===region.revision)?region:null;}
  return {enable,status:()=>({...status}),tick,read,
    context(){if(!enabled||!options.allowed())return null;if(!scene||now()-scene.capturedAt<0||now()-scene.capturedAt>1200)return null;const fresh=currentAttention(now());feed.offer({app:scene.app,window:scene.window,revision:scene.revision,capturedAt:scene.capturedAt,attention:fresh},now());const current=packet();if(!current)return null;
      return {screen:current,referent:pinned&&now()-pinned.at<10000?{at:pinned.at,ambiguous:pinned.ambiguous,target:pinned.ambiguous?null:describe(valid(pinned.target)),previous:describe(valid(pinned.previous)),alternatives:pinned.alternatives.filter(r=>valid(r)).slice(0,4).map(r=>({id:r.id,label:r.label.slice(0,180),kind:r.type}))}:null};},
    pin(text:string){if(!enabled||!options.allowed())return;const reference=/\b(previous|before)\b/i.test(text)?'previous':/\b(no|not|other|instead)\b/i.test(text)?'correction':'this';const references=tracker.resolve(reference,now());const chosen=selected&&reference!=='previous'?valid(selected.region):null;pinned={at:now(),target:chosen??references.target,previous:chosen?pinned?.previous??references.previous:references.previous,alternatives:references.alternatives.slice(0,4),ambiguous:chosen?false:references.ambiguous};},
    actionTarget(operation:string){const target=this.target();if(!target)return null;if(operation!=='scroll')return target;let candidate:ScreenRegion|undefined=target;const seen=new Set<string>();while(candidate&&!seen.has(candidate.id)){seen.add(candidate.id);if(candidate.nativeRole==='AXScrollArea')return candidate;candidate=scene?.regions.find(r=>r.id===candidate!.parentId);}return null;},
    target(){if(!enabled||!options.allowed())return null;if(pinned&&now()-pinned.at<10000)return pinned.ambiguous?null:valid(pinned.target);const result=currentAttention(now());return result.state==='stable'?valid(result.target):null;},
    find(input:{query?:string;kind?:string;direction?:string}){if(!enabled||!options.allowed()||!scene||now()-scene.capturedAt>1200)return {targets:[],unavailable:true};
      const words=(input.query??'').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,12);const anchor=this.target();
      const center=(region:ScreenRegion)=>({x:region.bounds.x+region.bounds.width/2,y:region.bounds.y+region.bounds.height/2});const origin=anchor?center(anchor):null;
      if(input.direction&&input.direction!=='near'&&!origin)return {targets:[],unavailable:true};
      const kind=input.kind??'any';const candidates=scene.regions.filter(region=>kind==='any'||kind==='control'&&/^AX/.test(region.type)||kind==='area'&&['window','area','textblock'].includes(region.type)||region.type===kind).filter(region=>words.every(word=>region.label.toLocaleLowerCase().includes(word)));
      const eligible=candidates.filter(region=>{if(!origin||!input.direction||input.direction==='near')return true;const point=center(region);return input.direction==='above'?point.y<origin.y:input.direction==='below'?point.y>origin.y:input.direction==='left'?point.x<origin.x:input.direction==='right'?point.x>origin.x:false;});
      if(origin)eligible.sort((a,b)=>{const x=center(a),y=center(b);return Math.hypot(x.x-origin.x,x.y-origin.y)-Math.hypot(y.x-origin.x,y.y-origin.y);});
      return {targets:eligible.slice(0,5).map(region=>({id:region.id,kind:region.type,label:region.label.slice(0,240),bounds:region.bounds})),truncated:eligible.length>5,authorization:false};},
    choose(id:string){if(!enabled||!options.allowed())throw Error('Enable shared screen context first.');const region=scene?.regions.find(r=>r.id===id);if(!region||now()-scene!.capturedAt>1200)throw Error('The screen target changed. Read the screen again.');selected={region,at:now()};pinned={at:now(),target:region,previous:pinned?.target??null,alternatives:[],ambiguous:false};tick();return {id:region.id,label:region.label,kind:region.type,authorization:false};},
    clear(){generation++;clear();},dispose(){enable(false);},
  };
}
