#!/usr/bin/env node
// Keep development tooling separate from the checkout receiving accepted product commits.
import {spawnSync,spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
const control=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const stateDir=join(control,'.loop');
const target=join(stateDir,'integration');
const branch='codex/autonomous';
function git(args,cwd=control){const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0)throw new Error(r.stderr.trim());return r.stdout.trim();}
await mkdir(stateDir,{recursive:true});
try{await readFile(join(target,'.git'));}catch(error){if(error.code!=='ENOENT')throw error;const exists=spawnSync('git',['show-ref','--verify','--quiet',`refs/heads/${branch}`],{cwd:control}).status===0;git(['worktree','add',...(exists?[]:['-b',branch]),target,exists?branch:'HEAD']);}
if(git(['status','--porcelain'],target))throw new Error('Dedicated integration checkout is dirty; preserve and reconcile it before launch.');
if(git(['branch','--show-current'],target)!==branch)throw new Error('Dedicated integration checkout is on an unexpected branch.');
const env={...process.env,LOOP_STATE_DIR:stateDir,LOOP_CODEX_HOME:process.env.LOOP_CODEX_HOME??'/Users/sobhi/.codex-deepseek-worker',LOOP_REVIEW_CODEX_HOME:process.env.LOOP_REVIEW_CODEX_HOME??'/Users/sobhi/.codex',LOOP_WORKER_MODEL:process.env.LOOP_WORKER_MODEL??'deepseek-flash',LOOP_WORKER_EFFORT:process.env.LOOP_WORKER_EFFORT??'max',LOOP_REVIEW_MODEL:process.env.LOOP_REVIEW_MODEL??'gpt-5.6-sol',LOOP_REVIEW_EFFORT:process.env.LOOP_REVIEW_EFFORT??'high',LOOP_MAX_AGENTS:process.env.LOOP_MAX_AGENTS??'2',LOOP_TERMINALS:'direct'};
console.log(`Control: ${control}\nIntegration: ${target} (${branch})\nState: ${stateDir}\nWorkers: ${env.LOOP_WORKER_MODEL}; reviewer: ${env.LOOP_REVIEW_MODEL}`);
const child=spawn(process.execPath,[join(control,'scripts','loop.mjs'),...process.argv.slice(2)],{cwd:target,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
