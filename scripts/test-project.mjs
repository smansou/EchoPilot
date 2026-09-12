import {spawnSync} from 'node:child_process';
import {collectChecks} from './loop-gates.mjs';
const plan=await collectChecks(process.cwd());
const commands=plan.commands.filter(command=>command[0]==='node'&&command.includes('--test'));
if(!commands.length)throw new Error('No project tests discovered');
for(const command of commands){const result=spawnSync(command[0],command.slice(1),{stdio:'inherit',timeout:120000});if(result.status!==0){process.exitCode=result.status??1;break;}}
