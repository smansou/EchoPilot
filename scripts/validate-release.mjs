#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {collectChecks} from './loop-gates.mjs';
const root=process.cwd();const output=resolve(process.env.LOOP_STATE_DIR??join(root,'.loop'),'release');await mkdir(output,{recursive:true});
const tracked=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'});if(tracked.status!==0)throw new Error('Cannot inventory release sources');
const plan=await collectChecks(root,{changedFiles:tracked.stdout.split('\0').filter(f=>f.endsWith('.swift'))});
const report={status:'incomplete',head:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),startedAt:new Date().toISOString(),coverage:plan.coverage,missing:[...plan.missing],checks:[]};
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(!pkg.scripts?.package)report.missing.push('No reproducible packaging command is defined (package.json scripts.package).');
const commands=[['pnpm','install','--frozen-lockfile','--ignore-scripts'],...plan.commands];
if(pkg.scripts?.smoke)commands.push(['pnpm','smoke']);else report.missing.push('No end-to-end desktop smoke command is defined.');
if(pkg.scripts?.package)commands.push(['pnpm','package']);
for(const [index,command]of commands.entries()){
 const result=spawnSync(command[0],command.slice(1),{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024,env:{...process.env,CI:'true'}});
 await writeFile(join(output,`check-${index}.log`),(result.stdout??'')+'\n'+(result.stderr??''),{mode:0o600});
 report.checks.push({command,exitCode:result.status,error:result.error?.message??null});
 if(result.status!==0)break;
}
try{const state=JSON.parse(await readFile(join(resolve(process.env.LOOP_STATE_DIR??join(root,'.loop')),'state.json'),'utf8'));for(const record of Object.values(state.tickets))if(record.status!=='done'||record.legacyVerification)report.missing.push(`${record.id}: ticket acceptance is not fully verified`);}catch{report.missing.push('Ticket acceptance ledger unavailable');}
report.status=report.missing.length===0&&report.checks.length===commands.length&&report.checks.every(c=>c.exitCode===0)?'passed':'incomplete';
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(`Release validation: ${report.status}. Evidence: ${join(output,'report.json')}`);
if(report.status!=='passed')process.exitCode=1;
