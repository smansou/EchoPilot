#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rename, stat, writeFile, appendFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root=process.cwd();
const loopDir=join(root,'.loop');
const statePath=join(loopDir,'state.json');
const eventPath=join(loopDir,'events.jsonl');
const worktreeRoot=join(loopDir,'worktrees');
const runRoot=join(loopDir,'runs');
const PORT=4318;
const IDLE_MS=180_000;
const CALL_MS=30*60_000;
const CHECK_MS=5*60_000;
const AGENT_BIN=process.env.LOOP_AGENT_BIN??'codex';
const DEFAULT_MODEL=process.env.LOOP_MODEL??'deepseek-flash';
const MAX_ACTIVE=Math.max(0,Number.parseInt(process.env.LOOP_MAX_AGENTS??'0',10)||0);
const MAX_TRANSIENT_FAILURES=Math.max(1,Number.parseInt(process.env.LOOP_MAX_TRANSIENT_FAILURES??'3',10)||3);
const MAX_SUBSTANTIVE_FAILURES=Math.max(1,Number.parseInt(process.env.LOOP_MAX_SUBSTANTIVE_FAILURES??'3',10)||3);
const forbidden=['.git','.github','.loop','.runner','.agents','.codex','scripts/loop.mjs','backlog.json'];
const extraPaths={F02:['apps/desktop/src/renderer/main.tsx','apps/desktop/src/renderer/styles.css'],S01:['apps/desktop/src/main/index.ts','native/macos/Package.swift']};
const checks=[['pnpm','typecheck'],['pnpm','test'],['pnpm','build']];
let state;
let integration=Promise.resolve();
let saveQueue=Promise.resolve();
let stopping=false;

const schema={
 test:{type:'object',properties:{outcome:{type:'string',enum:['completed','not_applicable','blocked']},summary:{type:'string'},testFiles:{type:'array',items:{type:'string'}},testCommand:{type:'array',items:{type:'string'}},evidence:{type:'array',items:{type:'string'}}},required:['outcome','summary','testFiles','testCommand','evidence'],additionalProperties:false},
 worker:{type:'object',properties:{outcome:{type:'string',enum:['completed','blocked']},summary:{type:'string'},evidence:{type:'array',items:{type:'string'}},risks:{type:'array',items:{type:'string'}}},required:['outcome','summary','evidence','risks'],additionalProperties:false},
 review:{type:'object',properties:{verdict:{type:'string',enum:['approve','request_changes']},summary:{type:'string'},issues:{type:'array',items:{type:'string'}},testIssue:{type:'boolean'}},required:['verdict','summary','issues','testIssue'],additionalProperties:false},
};

function clone(value){return structuredClone(value);}
function cleanPath(path){return path.replace(/\/\*\*$/,'').replace(/\/$/,'');}
function inside(file,base){const r=relative(base,file);return r===''||(!r.startsWith('..')&&!r.startsWith('/'));}
function allowed(file,paths){
 const lower=file.toLowerCase();
 if(!file||file.startsWith('/')||file.includes('\\')||file.split('/').includes('..'))return false;
 if(forbidden.some(p=>lower===p||lower.startsWith(p+'/')))return false;
 return paths.some(p=>{const b=cleanPath(p);return file===b||file.startsWith(b+'/');});
}
function testFile(file){return /(^|\/)(test|tests|fixtures?)\//i.test(file)||/\.(test|spec)\.[cm]?[jt]sx?$/i.test(file)||/^scripts\/(check|test|smoke)[^/]*\.[cm]?[jt]s$/i.test(file);}
function overlaps(a,b){return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');}
function conflict(a,b){return a.block===b.block||ticketPaths(a).some(x=>ticketPaths(b).some(y=>overlaps(cleanPath(x),cleanPath(y))));}
function ticketPaths(ticket){return [...ticket.files,...(extraPaths[ticket.id]??[])];}
function digest(text){return createHash('sha256').update(text).digest('hex');}
function routeFor(record,role){
 const model=process.env[`LOOP_${role.toUpperCase()}_MODEL`]??DEFAULT_MODEL;
 const normal=role==='review'?'high':'medium';
 const effort=(record.substantiveFailures??0)>0?'high':normal;
 return {model,effort:process.env[`LOOP_${role.toUpperCase()}_EFFORT`]??effort};
}

function transientFailure(issue){return /timed? out|stalled|rate.?limit|quota|temporar|network|ECONN|EAI_AGAIN|overload|unavailable/i.test(issue);}
function retryDelay(failures){return Math.min(60_000,5_000*(2**Math.max(0,failures-1)));}
async function recordFailure(ticket,record,error,phase){
 const issue=String(error?.message??error).slice(0,4000);const transient=transientFailure(issue);
 const key=transient?'transientFailures':'substantiveFailures';record[key]=(record[key]??0)+1;
 const limit=transient?MAX_TRANSIENT_FAILURES:MAX_SUBSTANTIVE_FAILURES;
 record.lastFailure=issue;record.phase=phase??(/test|fixture/i.test(issue)?'test':'implement');
 record.status=record[key]>=limit?'blocked':'ready';
 record.retryAt=record.status==='ready'&&transient?Date.now()+retryDelay(record[key]):0;
 record.detail=record.status==='blocked'?`${transient?'infrastructure':'repair'} failure limit reached`:'repair queued';
 await save({at:new Date().toISOString(),ticketId:ticket.id,message:`${record.status}: ${issue}`});
}

function save(event){
 const job=saveQueue.then(async()=>{state.updatedAt=new Date().toISOString();const tmp=join(loopDir,`state.${randomUUID()}.tmp`);await writeFile(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(tmp,statePath);if(event)await appendFile(eventPath,JSON.stringify(event)+'\n',{mode:0o600});});
 saveQueue=job.catch(()=>undefined);return job;
}
async function update(id,patch,message){
 Object.assign(state.tickets[id],patch,{updatedAt:new Date().toISOString()});
 await save(message?{at:new Date().toISOString(),ticketId:id,message}:undefined);
}

async function processRun(command,args,{cwd=root,input='',timeout=CHECK_MS,onLine}={}){
 return new Promise((resolveRun,reject)=>{
  const child=spawn(command,args,{cwd,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_EDITOR:'true'}});
  let out='',err='',buffer='',timedOut=false,idle;
  const stop=()=>{try{process.kill(-(child.pid??0),'SIGTERM');}catch{child.kill('SIGTERM');}setTimeout(()=>{try{process.kill(-(child.pid??0),'SIGKILL');}catch{}},1500).unref();};
  const hard=setTimeout(()=>{timedOut=true;stop();},timeout);
  const touch=()=>{if(idle)clearTimeout(idle);if(onLine)idle=setTimeout(()=>{timedOut=true;stop();},IDLE_MS);};touch();
  child.stdout.on('data',chunk=>{out=(out+chunk).slice(-256_000);buffer+=chunk;touch();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);onLine?.(line);}});
  child.stderr.on('data',chunk=>{err=(err+chunk).slice(-256_000);touch();});
  child.on('error',reject);child.on('close',code=>{clearTimeout(hard);if(idle)clearTimeout(idle);resolveRun({code,out,err,timedOut});});
  child.stdin.end(input);
 });
}
async function git(cwd,...args){const r=await processRun('git',args,{cwd,timeout:60_000});if(r.code!==0)throw new Error(`git ${args[0]} failed: ${r.err.slice(-1500)}`);return args.includes('-z')?r.out:r.out.trim();}
async function cleanRoot(){if(await git(root,'status','--porcelain'))throw new Error('Integration checkout is dirty');return git(root,'branch','--show-current');}
async function changedFiles(cwd,base){const tracked=await git(cwd,'diff','--name-only','-z',base,'--');const untracked=await git(cwd,'ls-files','--others','--exclude-standard','-z');return [...new Set((tracked+'\0'+untracked).split('\0').filter(Boolean))];}
async function validateChanges(cwd,base,paths){for(const file of await changedFiles(cwd,base)){if(!allowed(file,paths))throw new Error(`Outside ticket ownership: ${file}`);const full=resolve(cwd,file);if(!inside(full,cwd))throw new Error(`Path escapes candidate: ${file}`);try{if((await lstat(full)).isSymbolicLink())throw new Error(`Symlink not accepted: ${file}`);}catch(error){if(error?.code!=='ENOENT')throw error;}}}

async function seedLegacy(ticket,target,base){
 const legacy=state.tickets[ticket.id].legacy; if(!legacy)return false;
 const paths=ticketPaths(ticket).map(cleanPath);let seeded=false;
 if(legacy.branch){try{const common=await git(root,'merge-base',base,legacy.branch);const patch=await git(root,'diff','--binary',common,legacy.branch,'--',...paths);if(patch){const r=await processRun('git',['apply','--index','--whitespace=nowarn','-'],{cwd:target,input:patch+'\n'});if(r.code!==0)throw new Error(r.err);seeded=true;}}catch{} }
 if(legacy.worktree){try{const dirty=await git(legacy.worktree,'diff','--binary','HEAD','--',...paths);if(dirty){const r=await processRun('git',['apply','--index','--whitespace=nowarn','-'],{cwd:target,input:dirty+'\n'});if(r.code===0)seeded=true;}const files=(await git(legacy.worktree,'ls-files','--others','--exclude-standard','-z','--',...paths)).split('\0').filter(Boolean);for(const file of files){if(!allowed(file,ticketPaths(ticket)))continue;const src=resolve(legacy.worktree,file);if((await lstat(src)).isSymbolicLink())continue;const dst=resolve(target,file);await mkdir(dirname(dst),{recursive:true});await cp(src,dst,{recursive:true,force:true});seeded=true;}}catch{} }
 return seeded;
}
async function worktree(ticket){
 const record=state.tickets[ticket.id];const path=join(worktreeRoot,ticket.id);const branch=`codex/loop/${ticket.id}`;
 try{await stat(join(path,'.git'));return {path,branch,base:await git(root,'merge-base',state.integrationBranch,branch)};}catch{}
 try{await git(root,'show-ref','--verify',`refs/heads/${branch}`);await git(root,'worktree','add',path,branch);}catch{await git(root,'worktree','add','-b',branch,path,state.integrationBranch);}
 const base=await git(root,'merge-base',state.integrationBranch,branch);const seeded=await seedLegacy(ticket,path,state.integrationBranch);
 record.seeded=seeded;return {path,branch,base};
}

async function agentCall(ticket,record,role,cwd,prompt,dir){
 const route=routeFor(record,role);await update(ticket.id,{model:route.model,effort:route.effort,detail:`${role} · starting`});
 await mkdir(dir,{recursive:true});const schemaPath=join(dir,`${role}-schema.json`),resultPath=join(dir,`${role}-result.json`),logPath=join(dir,`${role}.log`);
 await writeFile(schemaPath,JSON.stringify(schema[role]),{mode:0o600});await writeFile(resultPath,'',{mode:0o600});
 const args=['exec','-c','approval_policy="never"','-s',role==='review'?'read-only':'workspace-write','-C',cwd,'-m',route.model,'-c',`model_reasoning_effort=${JSON.stringify(route.effort)}`,'--ephemeral','--json','--output-schema',schemaPath,'-o',resultPath,'-'];
 const run=await processRun(AGENT_BIN,args,{cwd,input:prompt,timeout:CALL_MS,onLine:line=>{try{const e=JSON.parse(line);if(e.type)void update(ticket.id,{detail:`${role} · ${e.type}`});}catch{}}});
 await writeFile(logPath,run.err+'\n'+run.out,{mode:0o600});
 if(run.code!==0||run.timedOut)throw new Error(run.timedOut?`${role} stalled or timed out`:run.err.slice(-1500)||`${role} failed`);
 const value=JSON.parse(await readFile(resultPath,'utf8'));return {value,route,logPath};
}

function validTestCommand(command){return Array.isArray(command)&&command.length>0&&command.length<12&&command.every(x=>typeof x==='string'&&x.length<300)&&['pnpm','node','swift'].includes(command[0]);}
async function hashTests(cwd,files){const result={};for(const file of files)result[file]=digest(await readFile(join(cwd,file)));return result;}
async function assertTestsUnchanged(cwd,hashes){for(const [file,hash] of Object.entries(hashes??{}))if(digest(await readFile(join(cwd,file)))!==hash)throw new Error(`Implementation modified test baseline: ${file}`);}
async function runCommand(command,cwd,timeout=CHECK_MS){return processRun(command[0],command.slice(1),{cwd,timeout});}
async function commit(cwd,message){const files=await changedFiles(cwd,'HEAD');if(!files.length)return;await git(cwd,'add','--',...files);await git(cwd,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-m',message);}

async function testPhase(ticket,record,tree,dir){
 const paths=ticketPaths(ticket);const prompt=`Write the smallest meaningful failing automated acceptance test for this ticket before implementation. Ticket: ${JSON.stringify(ticket)}. Prior review: ${JSON.stringify(record.lastFailure??'none')}. You may edit only test/spec files, fixture directories, or scripts named check/test/smoke inside these owned paths: ${JSON.stringify(paths)}. Do not edit production code. Return the exact safe argv test command. The test must fail because required behavior is missing, not because of syntax, setup, imports, or placeholders. If this ticket is genuinely not automatable, return not_applicable with concrete evidence; do not invent a test.`;
 const {value}=await agentCall(ticket,record,'test',tree.path,prompt,dir);if(value.outcome==='blocked')throw new Error(value.summary);
 if(value.outcome==='not_applicable'){record.testEvidence=value.evidence;record.testFiles=[];record.testCommand=[];return;}
 if(!validTestCommand(value.testCommand))throw new Error('Test author returned unsafe/invalid command');
 const files=await changedFiles(tree.path,'HEAD');if(!files.length||files.some(f=>!testFile(f)||!allowed(f,paths)))throw new Error(`Test phase changed non-test path: ${files.filter(f=>!testFile(f)||!allowed(f,paths)).join(', ')||'no test created'}`);
 const failed=await runCommand(value.testCommand,tree.path);await writeFile(join(dir,'red-test.log'),failed.out+'\n'+failed.err,{mode:0o600});if(failed.code===0)throw new Error('New acceptance test passed before implementation');
 record.testFiles=files;record.testCommand=value.testCommand;record.testHashes=await hashTests(tree.path,files);record.testEvidence=value.evidence;await commit(tree.path,`test(${ticket.id}): add failing acceptance test`);
}

async function implementPhase(ticket,record,tree,dir){
 const paths=ticketPaths(ticket);const prompt=`Implement this ticket in the retained candidate. Ticket: ${JSON.stringify(ticket)}. Exact prior reviewer/failure findings: ${JSON.stringify(record.lastFailure??'none')}. Test command: ${JSON.stringify(record.testCommand??checks[1])}. Test files are frozen after their red baseline: ${JSON.stringify(record.testFiles??[])}. Do not modify those tests, weaken validation, or change acceptance criteria. Inspect only owned/changed files; do not read the broad implementation plan. Start editing within two targeted commands. Allowed paths: ${JSON.stringify(paths)}. Run focused checks, then return one concrete evidence item per acceptance criterion. Do not commit, push, edit loop/backlog files, create agents, launch GUI apps, or request user input.`;
 const {value}=await agentCall(ticket,record,'worker',tree.path,prompt,dir);if(value.outcome!=='completed')throw new Error(value.summary);if(value.evidence.length<ticket.accept.length)throw new Error('Implementation omitted acceptance evidence');
 await assertTestsUnchanged(tree.path,record.testHashes);await validateChanges(tree.path,tree.base,paths);if(record.testCommand?.length){const green=await runCommand(record.testCommand,tree.path);await writeFile(join(dir,'green-test.log'),green.out+'\n'+green.err,{mode:0o600});if(green.code!==0)throw new Error(`Acceptance test still fails: ${green.err.slice(-1000)}`);}await commit(tree.path,`feat(${ticket.id}): ${value.summary.replace(/\s+/g,' ').slice(0,100)}`);record.workerEvidence=value.evidence;
}

async function integrate(ticket,record,tree,dir){
 integration=integration.then(async()=>{
  await update(ticket.id,{status:'review',phase:'checks',detail:'rebasing and running deterministic checks'},'entered checks');
  await cleanRoot();try{await git(tree.path,'rebase',state.integrationBranch);}catch(error){try{await git(tree.path,'rebase','--abort');}catch{}throw error;}
  for(let i=0;i<checks.length;i++){const r=await runCommand(checks[i],tree.path);await writeFile(join(dir,`check-${i+1}.log`),r.out+'\n'+r.err,{mode:0o600});if(r.code!==0)throw new Error(`Check failed: ${checks[i].join(' ')} ${r.err.slice(-1000)}`);}
  const base=await git(root,'rev-parse','HEAD');const head=await git(tree.path,'rev-parse','HEAD');
  const prompt=`Independently review one complete ticket candidate. Ticket: ${JSON.stringify(ticket)}. Review git diff ${base}..${head}, changed source, tests, red-test evidence, and deterministic check logs in ${dir}. You do not know or need the worker's model or rationale. Verify every acceptance criterion, path ownership, security, and that tests are meaningful rather than tautological. Confirm production implementation did not alter the frozen test baseline. Do not edit. Return precise repair issues. Approve only if the complete diff is shippable.`;
  const {value}=await agentCall(ticket,record,'review',tree.path,prompt,dir);if(value.verdict!=='approve'||value.issues.length){const issue=`Review requested changes: ${value.summary} ${value.issues.join('; ')}`.slice(0,4000);const fingerprint=digest(issue.replace(/\d+/g,'#').toLowerCase());record.failureFingerprints=[...(record.failureFingerprints??[]),fingerprint].slice(-3);if(value.testIssue){record.lastFailure=issue;record.status='blocked';record.phase='test';record.detail='review rejected the test oracle';await save({at:new Date().toISOString(),ticketId:ticket.id,message:`blocked: ${issue}`});return;}await recordFailure(ticket,record,new Error(issue),'implement');return;}
  if(await git(tree.path,'rev-parse','HEAD')!==head)throw new Error('Candidate changed after review');await cleanRoot();if(await git(root,'rev-parse','HEAD')!==base)throw new Error('Integration head changed; re-review required');record.approvedHead=head;await save({at:new Date().toISOString(),ticketId:ticket.id,message:`approved ${head.slice(0,8)}`});await git(root,'merge','--ff-only',tree.branch);if(state.publish)await git(root,'push','origin',`HEAD:refs/heads/${state.integrationBranch}`);record.status='done';record.phase='done';record.commit=await git(root,'rev-parse','HEAD');record.detail=`accepted and ${state.publish?'published':'integrated'}`;await save({at:new Date().toISOString(),ticketId:ticket.id,message:`done ${record.commit.slice(0,8)}`});
 }).catch(error=>recordFailure(ticket,record,error));
 return integration;
}

async function runTicket(ticket){
 const record=state.tickets[ticket.id];record.status='implementing';record.detail='preparing candidate';record.updatedAt=new Date().toISOString();await save({at:new Date().toISOString(),ticketId:ticket.id,message:'implementation started'});
 const tree=await worktree(ticket);const dir=join(runRoot,`${ticket.id}-${record.runs+1}`);record.runs+=1;
 try{const install=await processRun('pnpm',['install','--frozen-lockfile','--ignore-scripts'],{cwd:tree.path,timeout:CHECK_MS});if(install.code!==0)throw new Error(`Dependency install failed: ${install.err.slice(-1000)}`);const existing=(await changedFiles(tree.path,tree.base)).length>0;if(!existing&&record.phase==='test')await testPhase(ticket,record,tree,dir);else if(existing&&!record.testHashes){record.phase='implement';record.testFiles=(await changedFiles(tree.path,tree.base)).filter(testFile);record.testHashes=await hashTests(tree.path,record.testFiles);}
  await implementPhase(ticket,record,tree,dir);await integrate(ticket,record,tree,dir);
 }catch(error){await recordFailure(ticket,record,error);}
}

function readyBatch(tickets,active){
 const done=new Set(Object.values(state.tickets).filter(record=>record.status==='done').map(record=>record.id));
 const occupied=tickets.filter(ticket=>active.has(ticket.id));const selected=[];
 for(const ticket of tickets){const record=state.tickets[ticket.id];if(record.status!=='ready'||(record.retryAt??0)>Date.now()||!ticket.deps.every(dep=>done.has(dep)))continue;if([...occupied,...selected].some(other=>conflict(ticket,other)))continue;if(MAX_ACTIVE&&active.size+selected.length>=MAX_ACTIVE)break;selected.push(ticket);}
 return selected;
}

function dashboard(){return `<!doctype html><meta name="viewport" content="width=device-width"><title>EchoPilot</title><style>*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#e8edf7;font:14px system-ui;padding:24px}h1{font-size:24px;margin:0 0 6px}.sub{color:#8995aa;margin-bottom:22px}.board{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:14px}.col{background:#121a2b;border:1px solid #26334a;border-radius:14px;padding:12px;min-height:70vh}.col h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#91a0b8;margin:4px 4px 12px}.card{background:#182238;border:1px solid #30405d;border-radius:10px;padding:12px;margin:9px 0}.card b{font-size:15px}.card p{color:#aeb9cb;line-height:1.35;margin:7px 0 0}.card small{display:block;color:#6f809d;margin-top:8px}.done{border-color:#285b49}.review{border-color:#7a5c27}.blocked{border-color:#8a3434}@media(max-width:1100px){.board{grid-template-columns:1fr 1fr}}@media(max-width:520px){.board{grid-template-columns:1fr}}</style><h1>EchoPilot build</h1><div class="sub" id="summary">Loading…</div><main class="board" id="board"></main><script>const columns=[['ready','Ready'],['implementing','Implementing'],['review','Review'],['blocked','Blocked'],['done','Done']];async function draw(){const s=await fetch('/state').then(r=>r.json());summary.textContent=s.running?'Loop running · '+new Date(s.updatedAt).toLocaleTimeString():'Loop stopped';board.innerHTML=columns.map(([key,title])=>'<section class="col"><h2>'+title+'</h2>'+Object.values(s.tickets).filter(t=>t.status===key).map(t=>'<article class="card '+key+'"><b>'+t.id+'</b><p>'+escape(t.detail||t.path)+'</p><small>'+(t.model?t.model+' · '+t.effort:'waiting for dependencies')+'</small></article>').join('')+'</section>').join('')}function escape(x){const d=document.createElement('div');d.textContent=x;return d.innerHTML}draw();setInterval(draw,1500)</script>`;}
function serve(){return createServer((req,res)=>{if(req.url==='/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;}res.setHeader('content-type','text/html');res.end(dashboard());}).listen(PORT,'127.0.0.1');}

async function initialize(tickets){
 await mkdir(worktreeRoot,{recursive:true});await mkdir(runRoot,{recursive:true});const branch=await cleanRoot();
 try{state=JSON.parse(await readFile(statePath,'utf8'));}catch{state={version:1,running:false,publish:true,integrationBranch:branch,updatedAt:new Date().toISOString(),tickets:{}};}
 state.integrationBranch=branch;for(const ticket of tickets){let record=state.tickets[ticket.id];if(!record){record=state.tickets[ticket.id]={id:ticket.id,path:ticket.path,status:'ready',phase:'test',detail:'waiting for dependencies',runs:0,substantiveFailures:0,transientFailures:0,updatedAt:new Date().toISOString()};}
  if(['implementing','review'].includes(record.status)){record.status='ready';record.detail='recovered after runner restart';}
  if(record.approvedHead){const merged=await processRun('git',['merge-base','--is-ancestor',record.approvedHead,state.integrationBranch],{cwd:root,timeout:60_000});if(merged.code===0){record.status='done';record.phase='done';record.commit=record.approvedHead;record.detail='reconciled accepted integration';}}
 }await save();
}
async function loop(tickets){
 state.running=true;await save();const active=new Map();
 while(!stopping){
  const candidates=readyBatch(tickets,active);
  for(const ticket of candidates){const job=runTicket(ticket).finally(()=>active.delete(ticket.id));active.set(ticket.id,job);}
  if(active.size){await Promise.race(active.values());continue;}
  if(tickets.every(t=>state.tickets[t.id].status==='done'))break;
  const retryTimes=tickets.map(t=>state.tickets[t.id]).filter(r=>r.status==='ready'&&(r.retryAt??0)>Date.now()).map(r=>r.retryAt);
  if(retryTimes.length){await new Promise(resolveWait=>setTimeout(resolveWait,Math.min(60_000,Math.max(250,Math.min(...retryTimes)-Date.now()))));continue;}
  const blocked=tickets.filter(t=>state.tickets[t.id].status!=='done');for(const t of blocked)state.tickets[t.id].detail='blocked by unresolved dependencies or repeated repair';break;
 }
 state.running=false;await save();
}
async function selfTest(){const a={id:'A',deps:[],block:'A',files:['packages/a/']},b={id:'B',deps:[],block:'B',files:['packages/b/']},c={id:'C',deps:[],block:'C',files:['packages/a/x/']};state={tickets:{A:{status:'ready'},B:{status:'ready'},C:{status:'ready'}}};if(conflict(a,b)||!conflict(a,c)||!testFile('x/a.test.ts')||allowed('../x',['x/'])||readyBatch([a,b,c],new Map()).map(x=>x.id).join(',')!=='A,B')throw new Error('self-test failed');console.log('loop self-test passed');}
async function main(){if(process.argv.includes('--self-test'))return selfTest();const tickets=JSON.parse(await readFile(join(root,'BACKLOG.json'),'utf8')).tickets;if(process.argv.includes('--dry-run')){console.table(tickets.map(t=>({id:t.id,deps:t.deps.join(','),...routeFor({substantiveFailures:0},'worker')})));return;}const available=await processRun(AGENT_BIN,['--version'],{timeout:15_000});if(available.code!==0)throw new Error(`Agent CLI is unavailable: ${AGENT_BIN}`);await initialize(tickets);const server=serve();console.log(`EchoPilot lean loop: http://127.0.0.1:${PORT}`);process.on('SIGINT',()=>{stopping=true;server.close();});process.on('SIGTERM',()=>{stopping=true;server.close();});await loop(tickets);server.close();}
main().catch(error=>{console.error(error);process.exitCode=1;});
