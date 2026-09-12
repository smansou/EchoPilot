import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=resolve('scripts/loop.mjs');
test('one fake ticket survives a real review rejection, repairs, gates, and integrates', {timeout:45000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-loop-integration-'));
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  await mkdir(join(root,'bin'));await mkdir(join(root,'.loop'));
  const ticket={id:'T01',block:'TEST',files:['packages/demo/'],deps:[],accept:['The demo value is correct'],path:'fixture',scope:'fixture'};
  await writeFile(join(root,'BACKLOG.json'),JSON.stringify({tickets:[ticket]}));
  await writeFile(join(root,'.gitignore'),'.loop/\nbin/\n');
  await writeFile(join(root,'package.json'),'{}');
  await writeFile(join(root,'bin','pnpm'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const fake=join(root,'bin','codex');
  await writeFile(fake,`#!${process.execPath}
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture');process.exit(0);}
const out=args[args.indexOf('-o')+1],schema=out.includes('reviewer')?'review':out.includes('review')?'review':out.includes('test')?'test':'worker';
fs.mkdirSync('packages/demo',{recursive:true});let result;
if(schema==='test'){
 fs.writeFileSync('packages/demo/value.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';test('demo exists',()=>assert.equal(existsSync(new URL('./value.mjs',import.meta.url)),true));");
 result={outcome:'completed',summary:'oracle',testFiles:['packages/demo/value.test.mjs'],testCommand:['node','--test','packages/demo/value.test.mjs'],evidence:['assertion test']};
}else if(schema==='worker'){
 const old=fs.existsSync('packages/demo/value.mjs');fs.writeFileSync('packages/demo/value.mjs',old?'export const value=2;':'export const value=1;');
 result={outcome:'completed',summary:'implemented',evidence:['demo exists'],risks:[]};
}else{
 const fixed=fs.readFileSync('packages/demo/value.mjs','utf8').includes('value=2');
 result={verdict:fixed?'approve':'request_changes',summary:fixed?'fixed':'wrong value',issues:[],testIssue:false,findings:fixed?[]:[{id:'demo-value',severity:'major',category:'ticket',description:'Change demo value to 2; existence test passes but behavior is wrong.',status:'open'}],resolvedFindingIds:fixed?['demo-value']:[]};
}
fs.writeFileSync(out,JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed'}));
`,{mode:0o700});
  git('init','-b','codex/fixture');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-m','fixture');
  await writeFile(join(root,'.loop','state.json'),JSON.stringify({version:2,publish:false,running:false,integrationBranch:'codex/fixture',tickets:{}}));
  const result=spawnSync(process.execPath,[runner],{cwd:root,encoding:'utf8',timeout:35000,maxBuffer:1024*1024,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,LOOP_AGENT_BIN:fake,LOOP_TERMINALS:'direct',LOOP_PORT:'0',LOOP_STATE_DIR:join(root,'.loop'),LOOP_MAX_AGENTS:'1'}});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const state=JSON.parse(await readFile(join(root,'.loop','state.json'),'utf8'));
  assert.equal(state.tickets.T01.status,'done',JSON.stringify(state.tickets.T01));
  assert.ok(state.tickets.T01.gateEvidence?.head);
  assert.equal(state.tickets.T01.findings.find(f=>f.id==='demo-value')?.status,'verified');
  assert.match(await readFile(join(root,'packages/demo/value.mjs'),'utf8'),/value=2/);
 }finally{await rm(root,{recursive:true,force:true});}
});
