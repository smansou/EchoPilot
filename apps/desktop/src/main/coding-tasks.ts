import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {realpath,stat,readdir,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter,join} from 'node:path';
import {homedir} from 'node:os';
import {redactSessionText,type createCodingContext} from './coding-context';
export type CodingTask={id:string;agent:'Codex'|'Claude';project:string;instruction:string;sourceSessionId:string|null;status:'starting'|'running'|'completed'|'failed'|'canceled';sessionId:string|null;output:string;error:string|null;startedAt:string;updatedAt:string};
/** Installed CLIs own authentication, session persistence and their normal permission gates.
 * We never write to an observed session: Codex forks it; Claude uses --fork-session.
 * Task execution is asynchronous so the live conversation stays available. */
export function createCodingTasks(options:{library:ReturnType<typeof createCodingContext>;allowed():boolean;changed?(task:CodingTask):void;spawn?:typeof spawn;env?:NodeJS.ProcessEnv}){
  let reservations=0;
  const tasks=new Map<string,{state:CodingTask;child:ChildProcess;timer:ReturnType<typeof setTimeout>}>();
  const publicTask=(task:CodingTask)=>({...task});
  function notify(task:CodingTask){task.updatedAt=new Date().toISOString();options.changed?.(publicTask(task));}
  function cancel(id:string){const task=tasks.get(id);if(!task)throw Error('Unknown coding task.');if(['starting','running'].includes(task.state.status)){task.state.status='canceled';task.child.kill('SIGTERM');clearTimeout(task.timer);const timer=setTimeout(()=>{if(task.child.exitCode===null&&task.child.signalCode===null)task.child.kill('SIGKILL');},1500);timer.unref();notify(task.state);}return publicTask(task.state);}
  return {list:()=>[...tasks.values()].map(t=>publicTask(t.state)),cancel,
    async start(input:{agent:'Codex'|'Claude';project?:string;sessionId?:string;instruction:string},signal?:AbortSignal){
      signal?.throwIfAborted();
      if(!options.allowed())throw Error('Leave private or muted mode to start coding work.');
      if(!['Codex','Claude'].includes(input.agent)||!input.instruction.trim()||input.instruction.length>12000)throw Error('Choose Codex or Claude Code and a concrete task.');
      if([...tasks.values()].filter(t=>['starting','running'].includes(t.state.status)).length+reservations>=3)throw Error('Three coding tasks are already running.');
      reservations++;try{
      const source=input.sessionId?options.library.resolve(input.sessionId):null;
      if(input.sessionId&&!source)throw Error('Choose a known source session.');
      if(source&&source.agent!==input.agent)throw Error('The source session belongs to a different coding agent.');
      const project=await realpath(source?.cwd??input.project??'');if(!(await stat(project)).isDirectory())throw Error('Choose a valid project directory.');
      signal?.throwIfAborted();if(!options.allowed())throw Error('Coding work is disabled.');
      if(source&&!/^[a-zA-Z0-9-]{12,100}$/.test(source.nativeId))throw Error('The source session has no usable native session ID.');
      const id=randomUUID(),at=new Date().toISOString();
      const state:CodingTask={id,agent:input.agent,project,instruction:redactSessionText(input.instruction),sourceSessionId:input.sessionId??null,status:'starting',sessionId:null,output:'',error:null,startedAt:at,updatedAt:at};
      const args=input.agent==='Codex'
        ?['exec',...(source?['fork',source.nativeId]:[]),'--json','-c','sandbox_mode="workspace-write"','-c','approval_policy="never"','-']
        :['--print','--verbose','--output-format','stream-json','--permission-mode','default',...(source?['--resume',source.nativeId,'--fork-session']:[])];
      const env={...(options.env??process.env)};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.CLAUDECODE;
      // Finder-launched apps often lack the user's CLI installation directories.
      const versions=await readdir(join(homedir(),'.nvm/versions/node')).catch(()=>[]);
      env.PATH=[env.PATH,...versions.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,3).map(v=>join(homedir(),'.nvm/versions/node',v,'bin')),'/opt/homebrew/bin','/usr/local/bin',homedir()+'/.local/bin',homedir()+'/.cargo/bin'].filter(Boolean).join(delimiter);
      const name=input.agent==='Codex'?'codex':'claude';let command=name;
      if(!options.spawn)for(const directory of env.PATH.split(delimiter)){const path=join(directory,name);if(await access(path,constants.X_OK).then(()=>true,()=>false)){command=path;break;}}
      signal?.throwIfAborted();if(!options.allowed())throw Error('Coding work is disabled.');
      const child=(options.spawn??spawn)(command,args,{cwd:project,env,stdio:['pipe','pipe','pipe'],shell:false});
      const timer=setTimeout(()=>{state.error='Task reached the 30-minute limit. Partial work may remain in the project.';cancel(id);state.status='failed';notify(state);},30*60*1000);timer.unref();tasks.set(id,{state,child,timer});
      let completionReceived=false;let buffer='',stderr='';const fail=(message:string)=>{if(state.status==='canceled')return;state.status='failed';state.error=redactSessionText(message).slice(-1200);clearTimeout(timer);notify(state);};
      child.on('error',()=>fail(`Could not launch ${input.agent}. Install its CLI and sign in, then retry.`));
      child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
      child.stdout?.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>1024*1024){fail('Coding agent output exceeded its frame limit.');child.kill('SIGTERM');return;}
        let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=JSON.parse(line);
          const sid=event.thread_id??event.session_id;if(typeof sid==='string')state.sessionId=sid;
          if(['thread.started','turn.started','system'].includes(event.type))state.status='running';
          let text='';if(event.type==='item.completed'&&event.item?.type==='agent_message')text=event.item.text??'';
          if(event.type==='assistant')text=(event.message?.content??[]).filter((p:any)=>p.type==='text').map((p:any)=>p.text??'').join('\n');
          if(event.type==='result'){completionReceived=true;text=event.result??'';if(Array.isArray(event.permission_denials)&&event.permission_denials.length){fail('Claude Code requires permission for part of this task. It was not granted automatically.');}if(event.is_error)fail(text||'Claude Code reported a failed turn.');else if(state.status!=='failed')state.status='completed';}
          if(event.type==='turn.completed'){completionReceived=true;state.status='completed';}
          if(event.type==='turn.failed'||event.type==='error')fail(event.error?.message??event.message??'Coding agent reported a failed turn.');
          if(text)state.output=redactSessionText((state.output+'\n'+text).trim()).slice(-12000);notify(state);
        }catch{}}
      });
      child.on('exit',code=>{clearTimeout(timer);if(state.status==='canceled')return;if(code!==0)fail(stderr||`Coding agent exited (${code}).`);else if(state.status!=='failed'){if(!completionReceived)fail('The coding agent exited without a completed-turn receipt.');else {state.status='completed';notify(state);}}});
      child.stdin?.on('error',()=>{});child.stdin?.end(input.instruction);
      while(tasks.size>30){const oldest=[...tasks].find(([,t])=>!['starting','running'].includes(t.state.status));if(!oldest)break;tasks.delete(oldest[0]);}
      return publicTask(state);
      }finally{reservations--;}
    },
    clear(){for(const task of tasks.values())if(['starting','running'].includes(task.state.status))cancel(task.state.id);tasks.clear();},dispose(){for(const [id,task] of tasks){cancel(id);clearTimeout(task.timer);if(task.child.exitCode===null&&task.child.signalCode===null)task.child.kill('SIGTERM');}},
  };
}
