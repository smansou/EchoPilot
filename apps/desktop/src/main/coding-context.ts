import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readdir, stat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
type AgentSession={agent:'Codex'|'Claude';project:string;path:string;updatedAt:string;snippets:string[]};
/** Bounded, read-only discovery. Never reads auth/config files or executes agent commands. */
export function createCodingContext(home=homedir()) {
  let cached:AgentSession[]=[];let refreshed=0;
  let activeProject:string|null=null;let activeAt=0;
  async function scan(){
    if(Date.now()-refreshed<30000)return cached;
    const files:{path:string;agent:'Codex'|'Claude';mtime:number}[]=[];
    async function walk(directory:string,agent:'Codex'|'Claude',depth=0){
      if(depth>5||files.length>=400)return;
      const entries=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
      for(const entry of entries.sort((a,b)=>b.name.localeCompare(a.name)).slice(0,100)) {
        const path=join(directory,entry.name);
        if(entry.isDirectory())await walk(path,agent,depth+1);
        else if(entry.isFile()&&entry.name.endsWith('.jsonl')){const info=await stat(path).catch(()=>null);if(info&&info.size<200_000_000)files.push({path,agent,mtime:info.mtimeMs});}
        if(files.length>=400)break;
      }
    }
    await Promise.all([walk(join(home,'.codex','sessions'),'Codex'),walk(join(home,'.claude','projects'),'Claude')]);
    cached=[];
    for(const file of files.sort((a,b)=>b.mtime-a.mtime).slice(0,30)) {
      const handle=await open(file.path,'r').catch(()=>null);if(!handle)continue;
      try {
        const info=await handle.stat();const head=Buffer.alloc(Math.min(info.size,16384));await handle.read(head,0,head.length,0);
        const offset=Math.max(0,info.size-49152);const tail=Buffer.alloc(Math.min(info.size,49152));await handle.read(tail,0,tail.length,offset);
        const lines=[...head.toString('utf8').split('\n'),...tail.toString('utf8').split('\n').slice(offset?1:0)];
        let project='';const snippets:string[]=[];
        for(const line of lines){try{const row=JSON.parse(line);const data=row.payload??row;project ||= typeof data.cwd==='string'?data.cwd:typeof row.cwd==='string'?row.cwd:'';
          const message=row.message??data;const role=message.role??(row.type==='user'||row.type==='assistant'?row.type:null);
          if(role!=='user'&&role!=='assistant')continue;
          const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter((c:any)=>c.type==='text'||c.type==='input_text'||c.type==='output_text').map((c:any)=>c.text??'').join('\n'):'';
          if(content&&typeof content==='string')snippets.push(`${role}: ${content.slice(0,4000).replace(/sk-[a-zA-Z0-9_-]{16,}/g,'[redacted key]').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]')}`);
        }catch{}}
        if(project)cached.push({agent:file.agent,project,path:file.path,updatedAt:new Date(file.mtime).toISOString(),snippets:[...new Set(snippets)].slice(-24)});
      }finally{await handle.close();}
    }
    refreshed=Date.now();return cached;
  }
  const identity=(session:AgentSession)=>createHash('sha256').update(session.path).digest('hex').slice(0,20);
  async function catalog(query='') {
    const rows=await scan();
    const terms=query.toLowerCase().split(/\W+/).filter(t=>t.length>2);
    return rows.map(s=>({sessionId:identity(s),agent:s.agent,project:s.project,updatedAt:s.updatedAt,title:(s.snippets.find(t=>t.startsWith('user:'))??'Saved session').slice(0,180)}))
      .sort((a,b)=>terms.filter(t=>(b.project+b.title).toLowerCase().includes(t)).length-terms.filter(t=>(a.project+a.title).toLowerCase().includes(t)).length).slice(0,12);
  }
  async function evidence(sessionId:string,question:string) {
    const session=(await scan()).find(s=>identity(s)===sessionId);if(!session)throw Error('Session was not found. List sessions to disambiguate.');
    const info=await stat(session.path);const version=`${info.mtimeMs}:${info.size}`;
    const maxBytes=16*1024*1024;
    if(info.size===0)return {sessionId,agent:session.agent,project:session.project,version,updatedAt:new Date(info.mtimeMs).toISOString(),coverage:'empty saved session',sources:[] as {ref:string;text:string}[]};
    const stream=createReadStream(session.path,{start:0,end:Math.min(info.size,maxBytes)-1});
    const lines=createInterface({input:stream,crlfDelay:Infinity});
    const terms=question.toLowerCase().split(/\W+/).filter(t=>t.length>2);
    const matches:{ref:string;text:string;score:number;line:number}[]=[];let lineNumber=0;
    try {for await(const line of lines){lineNumber++;if(line.length>262144)continue;try{
      const row=JSON.parse(line);const payload=row.payload??row;const message=row.message??payload;const role=message.role??row.type;
      if(role!=='user'&&role!=='assistant')continue;
      const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter((c:any)=>['text','input_text','output_text'].includes(c.type)).map((c:any)=>c.text??'').join('\n'):'';
      if(!text.trim())continue;
      const clean=`${role}: ${text}`.replace(/sk-[a-zA-Z0-9_-]{16,}/g,'[redacted key]').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]');
      const score=terms.filter(t=>clean.toLowerCase().includes(t)).length;
      matches.push({ref:`${sessionId}:L${lineNumber}`,text:clean.slice(0,3000),score,line:lineNumber});
      if(matches.length>500)matches.sort((a,b)=>b.score-a.score||b.line-a.line).splice(250);
    }catch{}}}finally{lines.close();stream.destroy();}
    const selected=matches.sort((a,b)=>b.score-a.score||b.line-a.line).slice(0,10);
    // A bounded prefix search may miss late records; include bounded recent excerpts with honest coverage.
    if(info.size>maxBytes){
      const handle=await open(session.path,'r');
      try{const offset=Math.max(0,info.size-131072);const tail=Buffer.alloc(info.size-offset);await handle.read(tail,0,tail.length,offset);
        for(const [index,line] of tail.toString('utf8').split('\n').slice(1).entries()){try{const row=JSON.parse(line);const message=row.message??row.payload??row;const role=message.role??row.type;if(role!=='user'&&role!=='assistant')continue;
          const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter((part:any)=>['text','input_text','output_text'].includes(part.type)).map((part:any)=>part.text??'').join('\n'):'';
          if(content)selected.push({ref:`${sessionId}:tail${offset}:${index}`,text:`${role}: ${content}`.replace(/sk-[a-zA-Z0-9_-]{16,}/g,'[redacted key]').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').slice(0,3000),score:0,line:0});
        }catch{}}
      }finally{await handle.close();}
    }
    const bounded=[...selected.slice(0,10),...selected.slice(10).slice(-3)];
    const sources=bounded.map(({ref,text})=>({ref,text:text.slice(0,1800)}));
    return {sessionId,agent:session.agent,project:session.project,version,updatedAt:new Date(info.mtimeMs).toISOString(),coverage:info.size>maxBytes?'partial: first 16 MiB plus a fresh 128 KiB tail':'bounded excerpts selected from saved session',sources};
  }
  async function version(sessionId:string){const session=(await scan()).find(s=>identity(s)===sessionId);if(!session)return null;const info=await stat(session.path).catch(()=>null);return info?`${info.mtimeMs}:${info.size}`:null;}
  return {catalog,evidence,version,async context(question:string,foreground=''){
    if(!/project|session|codex|claude|coding|working|worked|agent|progress|repo|codebase|remember|brainstorm|simplif|approach|design|architect|improve|this|that|it/i.test(question))return '';
    const sessions=await scan();if(!sessions.length)return 'No readable local Claude or Codex sessions were found. Discovery covers local CLI session files only.';
    const terms=question.toLowerCase().split(/[^a-z0-9_-]+/).filter(t=>t.length>2&&!['the','what','that','this','project','session','working','about','codex','claude','agent','progress'].includes(t));
    const ranked=sessions.map(s=>({s,score:terms.filter(t=>basename(s.project).toLowerCase().includes(t)).length*5+(foreground.toLowerCase().includes(basename(s.project).toLowerCase())?2:0)+(s.project===activeProject&&Date.now()-activeAt<300000?1:0)})).sort((a,b)=>b.score-a.score||b.s.updatedAt.localeCompare(a.s.updatedAt));
    const matched=ranked.filter(r=>r.score>0).slice(0,2);
    const selected=matched.length?matched:ranked.slice(0,5);
    if(matched[0]){activeProject=matched[0].s.project;activeAt=Date.now();}
    function excerpts(session:AgentSession){
      const ranked=session.snippets.map((text,index)=>({text,index,score:terms.filter(term=>text.toLowerCase().includes(term)).length+(index>=session.snippets.length-3?2:0)})).sort((a,b)=>b.score-a.score).slice(0,6).sort((a,b)=>a.index-b.index);
      return ranked.map(row=>row.text).join('\n').slice(0,6500);
    }
    return 'Local agent session evidence. These are saved records, not verified live status. If the project is ambiguous ask which one.\n'+selected.map(({s})=>`${s.agent} · ${s.project} · last updated ${s.updatedAt}\n${matched.length?excerpts(s):''}`).join('\n\n').slice(0,8500);
  }};
}
