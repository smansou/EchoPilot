import {useEffect,useRef,useState} from 'react';
import type {AssistantFact} from '../main/assistant-memory';
import type {CodingTask} from '../main/coding-tasks';
import type {WakePreferences,WakeCalibration} from '../main/wake-word';
import {captureWakeAudio} from './wake-capture';
type Request=(input:Record<string,unknown>)=>Promise<any>;
export function AssistantSettings({request,onError}:{request:Request;onError(message:string):void}){
  const [status,setStatus]=useState<any>(null),[voice,setVoice]=useState<any>(null),[phrase,setPhrase]=useState(''),[fact,setFact]=useState('');
  const [calibrating,setCalibrating]=useState(false),[step,setStep]=useState(''),[seconds,setSeconds]=useState(0);const capture=useRef<AbortController|null>(null);
  const refresh=async()=>{const [a,b]=await Promise.all([request({action:'assistant-state'}),request({action:'wake-status'})]);setStatus(a);setVoice(b);setPhrase(previous=>previous||b.preferences.phrase);};
  useEffect(()=>{void refresh().catch(()=>onError('Assistant settings could not load.'));const timer=setInterval(()=>void refresh().catch(()=>{}),3000);return()=>{clearInterval(timer);capture.current?.abort();};},[]);
  async function save(preferences:Partial<WakePreferences>){try{await request({action:'voice-preferences-set',preferences});await refresh();}catch(e){onError(e instanceof Error?e.message:'Could not save voice settings.');}}
  async function calibrate(){const controller=new AbortController();capture.current=controller;setCalibrating(true);
    const delay=(ms:number)=>new Promise<void>((resolve,reject)=>{const done=()=>{controller.signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);reject(Error('Calibration canceled.'));};controller.signal.addEventListener('abort',abort,{once:true});});
    try{
      await request({action:'voice-preferences-set',preferences:{phrase}});await request({action:'wake-calibration-start'});setStep('Preparing local wake model…');
      for(let i=0;i<40;i++){controller.signal.throwIfAborted();const s=await request({action:'wake-status'});if(s.error)throw Error(s.error);if(s.ready)break;if(i===39)throw Error('The local wake model took too long to start.');await delay(250);}
      for(let i=0;i<4;i++){
        controller.signal.throwIfAborted();const positive=i<3,duration=positive?3:10;
        setStep(positive?`Attempt ${i+1} of 3 · say “${phrase}” once, naturally`:'Read a sentence or speak normally without your wake phrase');
        const chunks:Uint8Array[]=[];let bytes=0;
        const stop=await captureWakeAudio({signal:controller.signal,chunk:chunk=>{bytes+=chunk.length;if(bytes<=640000)chunks.push(chunk);},failed:()=>controller.abort()});
        try{for(let left=duration;left>0;left--){setSeconds(left);await delay(1000);}}finally{stop();}
        const joined=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
        await request({action:'wake-calibration-sample',bytes:joined,positive});joined.fill(0);for(const chunk of chunks)chunk.fill(0);
      }
      setStep('Checking detections and false triggers locally…');setSeconds(0);const result:WakeCalibration=await request({action:'wake-calibration-finish'});setStep(`Detected ${result.detected}/${result.attempts} attempts · ${result.falseTriggers} false triggers in ${result.negativeSeconds.toFixed(0)} seconds`);await refresh();
    }catch(e){if(!controller.signal.aborted)onError(e instanceof Error?e.message:'Calibration failed.');}
    finally{controller.abort();capture.current=null;await request({action:'wake-calibration-cancel'}).catch(()=>{});setCalibrating(false);setSeconds(0);}
  }
  const preferences=voice?.preferences as WakePreferences|undefined;
  return <div className="assistant-settings">
    <section className="card"><div className="card-title"><h2>Your work, already in mind</h2><span className="badge">Claude Code + Codex</span></div>
      <p className="muted">Recent goals, decisions and session excerpts are prepared on this Mac before you ask. Details remain searchable without filling your conversation.</p>
      <div className="assistant-metrics" aria-live="polite"><div><strong>{status?.indexed??0}</strong><span>sessions ready</span></div><div><strong>{status?.sessions instanceof Array?status.sessions.length:status?.sessions??0}</strong><span>recent sessions</span></div><div><strong>{status?.facts?.length??0}</strong><span>saved commitments</span></div></div>
      <p className="footnote">Saved records show reported progress, not a live connection to an agent. Only selected evidence is shared with your configured providers during conversations.</p>
      <button className="text-button" onClick={()=>void request({action:'assistant-refresh'}).then(refresh).catch(e=>onError(e.message))}>Refresh local context</button>
    </section>
    <section className="card"><h2>Keep the important things</h2><p className="muted">Say “remember…” or add a goal here. Unfinished work stays until you resolve or remove it.</p>
      <form className="memory-form" onSubmit={e=>{e.preventDefault();void request({action:'assistant-remember',text:fact,kind:'ongoing'}).then(()=>{setFact('');return refresh();}).catch(e=>onError(e.message));}}><input aria-label="A goal to remember" placeholder="What should stay in mind?" value={fact} maxLength={2000} onChange={e=>setFact(e.target.value)}/><button className="text-button" disabled={!fact.trim()}>Remember</button></form>
      <ul className="memory-list">{(status?.facts??[]).map((item:AssistantFact)=><li key={item.id}><div><span className="mini-label">{item.kind}</span><p>{item.text}</p></div><button className="text-button" aria-label={`Resolve ${item.text.slice(0,50)}`} onClick={()=>void request({action:'assistant-forget',id:item.id}).then(refresh).catch(e=>onError(e.message))}>Resolve</button></li>)}</ul>
    </section>
    <section className="card"><div className="form-row"><div><h2>Let the conversation rest</h2><p className="muted">Live audio disconnects after inactivity. Your work stays in memory.</p></div><select aria-label="Sleep after inactivity" value={preferences?.idleTimeoutSeconds??60} onChange={e=>void save({idleTimeoutSeconds:Number(e.target.value)})}>{[[30,'30 seconds'],[60,'1 minute'],[120,'2 minutes'],[300,'5 minutes'],[0,'Never']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div><p className="footnote">You can also say “hang up” or “go to sleep”. Press ⌥ Space to return.</p></section>
    <section className="card"><div className="form-row"><div><h2>A phrase that brings you back</h2><p className="muted">An offline listener hears only for your wake phrase while live voice is asleep.</p></div><button className="toggle" role="switch" aria-label="Wake phrase listening" aria-checked={preferences?.enabled??false} disabled={!voice?.available||calibrating||!preferences?.calibration} onClick={()=>void save({enabled:!preferences?.enabled})}><span/></button></div>
      <label className="wake-label" htmlFor="wake-phrase">Your wake phrase <span className="muted">English · two or three distinctive words work best</span></label><form className="memory-form" onSubmit={e=>{e.preventDefault();void save({phrase});}}><input id="wake-phrase" value={phrase} maxLength={60} disabled={calibrating} onChange={e=>setPhrase(e.target.value)}/><button className="text-button" disabled={calibrating||phrase===preferences?.phrase}>Save phrase</button></form>
      {!preferences?.calibration&&<p className="footnote">Calibrate your phrase before enabling wake listening.</p>}{!voice?.available&&<p role="status" className="footnote">This build is missing its offline wake model.</p>}{voice?.error&&<p role="status">{voice.error}</p>}
      {preferences?.calibration&&<div className="calibration-score"><strong>{preferences.calibration.score}/100</strong><div><span>Calibration score</span><p>{preferences.calibration.detected}/{preferences.calibration.attempts} wake attempts · {preferences.calibration.falseTriggers} false triggers in {preferences.calibration.negativeSeconds.toFixed(0)}s</p><small>A short local check, not a real-world reliability probability.</small></div></div>}
      <div className="form-row"><button className="text-button" disabled={!voice?.available||calibrating} onClick={()=>void calibrate()}>{preferences?.calibration?'Check again':'Calibrate · about 20 seconds'}</button>{calibrating&&<button className="text-button" onClick={()=>capture.current?.abort()}>Cancel</button>}</div>
      {step&&<p role="status" aria-live="polite">{step}{seconds>0?` · ${seconds}s`:''}</p>}<p className="footnote">Calibration audio is processed locally and discarded. Wake listening uses your microphone while enabled; it never grants permission for an action.</p>
    </section>
    {(status?.tasks??[]).length>0&&<section className="card"><h2>Work in motion</h2>{status.tasks.map((task:CodingTask)=><article className="coding-task" key={task.id}><div className="form-row"><strong>{task.agent} · {task.project.split('/').at(-1)}</strong><span className="badge">{task.status}</span></div><p>{task.instruction}</p>{task.output&&<pre>{task.output}</pre>}{task.error&&<p role="status">{task.error}</p>}{['starting','running'].includes(task.status)&&<button className="text-button" onClick={()=>void request({action:'coding-task-cancel',id:task.id}).then(refresh).catch(e=>onError(e.message))}>Stop task</button>}</article>)}</section>}
    <button className="text-button" onClick={()=>{if(window.confirm('Forget saved assistant commitments and the local context cache? Your coding sessions remain in their original apps.'))void request({action:'assistant-clear'}).then(refresh).catch(e=>onError(e.message));}}>Forget assistant memory</button>
  </div>;
}
