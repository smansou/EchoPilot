import { createHash } from 'node:crypto';
import { readdir, stat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export type SessionSource = {ref:string;text:string};
export type CodingSession = {sessionId:string;nativeId:string;agent:'Codex'|'Claude';project:string;updatedAt:string;title:string;version:string;activity:'recently_updated'|'saved';coverage:string;reportedState?:'working'|'waiting'|'interrupted'|'unknown';stateReportedAt?:string};
type IndexedSession = CodingSession & {path:string;size:number;offset:number;line:number;sources:SessionSource[]};
export const redactSessionText=(text:string)=>text.replace(/sk-[a-zA-Z0-9_-]{16,}/g,'[redacted key]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',}]+/gi,'$1[redacted]');
const words=(text:string)=>[...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)??[])].slice(0,24);
const publicRow=({path,size,offset,line,sources,...row}:IndexedSession):CodingSession=>row;
/** SQLite FTS5 is the retrieval engine. Raw records stay local; only selected excerpts leave it.
 * The index is memory-only; the host may persist its bounded snapshot using OS encryption. */
export function createCodingContext(home=homedir(),options:{now?:()=>number;load?():unknown;save?(snapshot:unknown):void;allowed?():boolean}={}) {
  const now=options.now??Date.now;
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE excerpts USING fts5(session UNINDEXED, ref UNINDEXED, text, tokenize="unicode61");');
  const sessions=new Map<string,IndexedSession>();
  let discovered=-Infinity;let refreshed=-Infinity;let flight:Promise<void>|null=null;let disposed=false;let generation=0;let lastSave=0;
  const allowed=()=>!disposed&&(options.allowed?.()??true);
  function index(row:IndexedSession){db.prepare('DELETE FROM excerpts WHERE session=?').run(row.sessionId);const insert=db.prepare('INSERT INTO excerpts(session,ref,text) VALUES(?,?,?)');for(const source of row.sources)insert.run(row.sessionId,source.ref,source.text);}
  try {const saved=options.load?.();if(Array.isArray(saved))for(const row of saved.slice(0,160)){if(row&&typeof row.path==='string'&&row.path.startsWith(home+'/')&&typeof row.sessionId==='string'&&Array.isArray(row.sources)&&row.sources.length<=48&&row.sources.every((s:any)=>typeof s.ref==='string'&&typeof s.text==='string'&&s.text.length<=6000)){sessions.set(row.sessionId,row);index(row);}}}catch{}
  async function read(row:IndexedSession,full=false,question='',page=0){
    const epoch=generation;const handle=await open(row.path,'r').catch(()=>null);if(!handle)return;
    try {
      const info=await handle.stat();if(info.size>500_000_000)return;
      if(full&&page>0&&page*8*1024*1024>=info.size)throw Error('Evidence page exceeds the saved session.');
      const version=`${info.mtimeMs}:${info.size}`;if(row.version===version&&row.sources.length&&!full)return;
      const reset=info.size<row.offset||row.version!==version&&info.size===row.size;
      if(reset){row.offset=0;row.line=0;row.sources=[];}
      // Cold sessions read the beginning and recent tail. Selected historical questions can read
      // bounded 8 MiB pages; subsequent updates consume only appended complete lines.
      let offset=full?page*8*1024*1024:row.offset;let limit=full?8*1024*1024:256*1024;
      const ranges:{start:number;size:number;tail:boolean}[]=[];
      if(full&&info.size-offset>limit){ranges.push({start:offset,size:limit,tail:offset>0},{start:Math.max(offset+limit,info.size-131072),size:Math.min(131072,info.size-offset-limit),tail:true});}
      else if(!full&&info.size-offset>limit){ranges.push({start:offset,size:32768,tail:offset>0},{start:Math.max(offset+32768,info.size-limit),size:limit,tail:true});}
      else ranges.push({start:offset,size:Math.max(0,Math.min(info.size-offset,limit)),tail:offset>0});
      for(const range of ranges){
        const buffer=Buffer.alloc(range.size);const {bytesRead}=await handle.read(buffer,0,buffer.length,range.start);
        if(!allowed()||epoch!==generation)return;
        const data=buffer.subarray(0,bytesRead);const last=data.lastIndexOf(10);let complete=last<0?data.subarray(0,0):data.subarray(0,last+1);
        if(range.start+bytesRead===info.size&&last<data.length-1){try{JSON.parse(data.subarray(last+1).toString('utf8'));complete=data;}catch{}}
        let lines=complete.toString('utf8').split('\n');let sourceOffset=range.start;
        if(range.tail&&range.start>0){const previous=Buffer.alloc(1);await handle.read(previous,0,1,range.start-1);if(previous[0]!==10){sourceOffset=range.start+complete.indexOf(10)+1;lines=lines.slice(1);}}
        if(!allowed()||epoch!==generation)return;
        for(const line of lines){const recordOffset=sourceOffset;sourceOffset+=Buffer.byteLength(line)+1;
          if(!line||line.length>262144)continue;
          try {const raw=JSON.parse(line),payload=raw.payload??raw;
            const event=raw.type==='event_msg'?payload.type:raw.type==='system'?raw.subtype:null;
            const reported=event==='task_started'?'working':event==='task_complete'||event==='turn_duration'?'waiting':event==='turn_aborted'?'interrupted':null;
            if(reported){row.reportedState=reported;row.stateReportedAt=typeof raw.timestamp==='string'?raw.timestamp.slice(0,50):new Date(info.mtimeMs).toISOString();}
            row.project ||= typeof payload.cwd==='string'?payload.cwd:typeof raw.cwd==='string'?raw.cwd:'';
            if(raw.type==='session_meta'&&typeof payload.id==='string')row.nativeId=payload.id;
            if(typeof raw.sessionId==='string')row.nativeId=raw.sessionId;
            const message=raw.message??payload;const role=message.role??raw.type;
            if(!['user','assistant'].includes(role))continue;
            let text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter((p:any)=>['text','input_text','output_text'].includes(p.type)).map((p:any)=>p.text??'').join('\n'):'';
            // Codex event_msg duplicates response_item; only canonical messages are indexed.
            if(!text?.trim()||raw.isSidechain===true||/^<(?:environment_context|turn_aborted|permissions)[\s\S]*<\/(?:environment_context|turn_aborted|permissions)>\s*$/.test(text))continue;
            text=redactSessionText(text);
            if(role==='assistant'&&['end_turn','tool_use'].includes(message.stop_reason)){row.reportedState=message.stop_reason==='end_turn'?'waiting':'working';row.stateReportedAt=typeof raw.timestamp==='string'?raw.timestamp.slice(0,50):new Date(info.mtimeMs).toISOString();}
            if(role==='user'&&!row.title&&!/^<(?:environment_context|permissions|turn_aborted)/.test(text))row.title=text.slice(0,220);
            const ref=`${row.sessionId}:B${recordOffset}`;
            // Retain both ends of long messages, with explicit omission rather than silent clipping.
            const excerpt=text.length>5800?text.slice(0,2800)+'\n[message middle omitted]\n'+text.slice(-2800):text;
            row.sources.push({ref,text:`${role}: ${excerpt}`});
          }catch{}
        }
        row.line+=lines.length-1;offset=range.start+complete.length;
      }
      row.sources=[...new Map(row.sources.map(s=>[s.ref,s])).values()];
      if(row.sources.length>48){const terms=words(question);const relevant=terms.length?row.sources.map(s=>({s,score:terms.filter(t=>s.text.toLowerCase().includes(t)).length})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,12).map(r=>r.s):[];row.sources=[...new Map([...row.sources.slice(0,6),...relevant,...row.sources.slice(-30)].map(s=>[s.ref,s])).values()];}
      row.offset=offset;row.size=info.size;row.version=version;row.updatedAt=new Date(info.mtimeMs).toISOString();
      row.coverage=info.size>limit?'partial: opening and recent saved messages; middle may be missing':'bounded saved message excerpts';
      row.activity=now()-info.mtimeMs<120000?'recently_updated':'saved';index(row);
    }finally{await handle.close();}
  }
  async function metadata(row:IndexedSession){
    const epoch=generation;if(row.project)return;const handle=await open(row.path,'r').catch(()=>null);if(!handle)return;
    try{const buffer=Buffer.alloc(16384);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(!allowed()||epoch!==generation)return;
      for(const [lineNumber,line] of buffer.subarray(0,bytesRead).toString('utf8').split('\n').entries())try{const raw=JSON.parse(line),payload=raw.payload??raw;row.project ||= typeof payload.cwd==='string'?payload.cwd:typeof raw.cwd==='string'?raw.cwd:'';
        if(raw.type==='session_meta'&&typeof payload.id==='string')row.nativeId=payload.id;if(typeof raw.sessionId==='string')row.nativeId=raw.sessionId;
        const message=raw.message??payload;if((message.role??raw.type)==='user'&&!row.title){const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter((p:any)=>['text','input_text'].includes(p.type)).map((p:any)=>p.text??'').join('\n'):'';if(content&&!/^<(?:environment_context|permissions|turn_aborted)/.test(content)){row.title=redactSessionText(content).slice(0,220);row.sources=[{ref:`${row.sessionId}:L${lineNumber+1}`,text:'user: '+redactSessionText(content).slice(0,1500)}];row.coverage='opening metadata only; retrieve the session for later progress';index(row);}}
      }catch{}
    }finally{await handle.close();}
  }
  async function refresh(force=false){
    if(!allowed())return;if(flight)return flight;if(!force&&now()-refreshed<2000)return;
    const epoch=generation;
    const task=(async()=>{
      if(!force&&now()-discovered<30000){for(const row of ranked().slice(0,40))await read(row);refreshed=now();return;}
      const files:{path:string;agent:'Codex'|'Claude';mtime:number;size:number}[]=[];let count=0;
      async function walk(directory:string,agent:'Codex'|'Claude',depth=0){
        if(depth>7||count>20000||!allowed())return;
        const entries=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
        for(const entry of entries){if(++count>20000)break;if(entry.isSymbolicLink())continue;const path=join(directory,entry.name);
          if(entry.isDirectory()&&entry.name!=='subagents')await walk(path,agent,depth+1);
          else if(entry.isFile()&&entry.name.endsWith('.jsonl')){const info=await stat(path).catch(()=>null);if(info)files.push({path,agent,mtime:info.mtimeMs,size:info.size});}
        }
      }
      await Promise.all([walk(join(home,'.codex','sessions'),'Codex'),walk(join(home,'.codex','archived_sessions'),'Codex'),walk(join(home,'.claude','projects'),'Claude')]);
      if(!allowed()||epoch!==generation)return;
      const paths=new Set(files.map(f=>f.path));for(const [id,row]of sessions)if(!paths.has(row.path)){sessions.delete(id);db.prepare('DELETE FROM excerpts WHERE session=?').run(id);}
      // Metadata can cover thousands of sessions; hot excerpt memory stays bounded to 160 sessions.
      const sorted=files.sort((a,b)=>b.mtime-a.mtime);
      for(const [i,file]of sorted.entries()){
        const id=createHash('sha256').update(file.path).digest('hex').slice(0,20);
        const row=sessions.get(id)??{sessionId:id,nativeId:basename(file.path,'.jsonl'),agent:file.agent,project:'',updatedAt:new Date(file.mtime).toISOString(),title:'',version:'',path:file.path,size:0,offset:0,line:0,sources:[],activity:'saved' as const,coverage:'not indexed yet'};
        sessions.set(id,row);if(i<40)await read(row);else await metadata(row);
        if(!allowed()||epoch!==generation)return;
        if(i>=160&&row.sources.length>1){row.sources=row.sources.slice(0,1);row.offset=0;row.coverage='opening excerpt only; retrieve the session for later progress';index(row);}
      }
      discovered=now();refreshed=now();if(options.save&&now()-lastSave>30000){lastSave=now();options.save([...sessions.values()].filter(r=>r.sources.length).slice(0,160));}
    })();flight=task;try{await task;}finally{if(flight===task)flight=null;}
  }
  function ranked(query=''){
    for(const row of sessions.values())row.activity=now()-Date.parse(row.updatedAt)<120000?'recently_updated':'saved';
    const terms=words(query);return [...sessions.values()].filter(s=>s.project).map(s=>({s,score:terms.filter(t=>(s.project+' '+s.title).toLowerCase().includes(t)).length})).sort((a,b)=>b.score-a.score||b.s.updatedAt.localeCompare(a.s.updatedAt)).map(r=>r.s);
  }
  function lookup(sessionId:string){return sessions.get(sessionId)??[...sessions.values()].find(s=>s.nativeId===sessionId);}
  function search(query:string,sessionId?:string,limit=10):SessionSource[]{
    if(!allowed())return [];
    const terms=words(query).filter(t=>!['the','what','that','this','project','session','working','about','codex','claude','agent','progress'].includes(t));
    const id=sessionId?lookup(sessionId)?.sessionId:undefined;
    if(sessionId&&!id)return [];
    let hits:SessionSource[]=[];
    if(terms.length){const match=terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
      hits=db.prepare(`SELECT ref,text FROM excerpts WHERE excerpts MATCH ? ${id?'AND session=?':''} ORDER BY bm25(excerpts) LIMIT ?`).all(...(id?[match,id,limit]:[match,limit])) as SessionSource[];}
    const recent=(id?[lookup(id)!]:ranked(query).slice(0,3)).flatMap(s=>[...s.sources.filter(source=>source.text.startsWith('user:')).slice(0,1),...s.sources.slice(-3)]);
    return [...new Map([...hits,...recent].map(s=>[s.ref,s])).values()].slice(0,limit);
  }
  async function catalog(query=''){await refresh();return ranked(query).slice(0,40).map(publicRow);}
  async function evidence(sessionId:string,question:string,page=0){if(!Number.isInteger(page)||page<0||page>64)throw Error('Choose a valid evidence page.');await refresh();const row=lookup(sessionId);if(!row)throw Error('Session was not found. List sessions to disambiguate.');await read(row,true,question,page);return {...publicRow(row),coverage:`Saved excerpts from page ${page} (8 MiB), plus the recent tail when needed. Long messages may be abridged.`,nextPage:row.size>(page+1)*8*1024*1024?page+1:null,sources:search(question,row.sessionId,12)};}
  return {catalog,evidence,refresh,search,
    peek:()=>allowed()?ranked().slice(0,16).map(publicRow):[],
    async version(id:string){const row=lookup(id);if(!row)return null;const info=await stat(row.path).catch(()=>null);return info?`${info.mtimeMs}:${info.size}`:null;},
    resolve(id:string){const row=lookup(id);return row?{...publicRow(row),cwd:row.project}:null;},
    status:()=>({sessions:sessions.size,indexed:[...sessions.values()].filter(s=>s.sources.length).length,refreshedAt:Number.isFinite(refreshed)?new Date(refreshed).toISOString():null,refreshing:!!flight}),
    clear(){generation++;sessions.clear();db.exec('DELETE FROM excerpts');refreshed=-Infinity;},
    dispose(){disposed=true;generation++;sessions.clear();db.close();},
    async context(question:string,foreground=''){
      if(!/project|session|codex|claude|coding|working|worked|agent|progress|repo|codebase|remember|brainstorm|simplif|approach|design|architect|improve|this|that|it/i.test(question))return '';
      await refresh();const rows=ranked(question+' '+foreground);if(!rows.length)return 'No readable local Claude or Codex sessions were found.';
      const terms=words(question);const matched=rows.filter(s=>terms.some(t=>basename(s.project).toLowerCase().includes(t))).slice(0,2);
      return JSON.stringify({coverage:'Saved records, not verified live status. Ask which project when ambiguous.',sessions:(matched.length?matched:rows.slice(0,5)).map(publicRow),sources:matched.flatMap(s=>search(question,s.sessionId,6))});
    },
  };
}
