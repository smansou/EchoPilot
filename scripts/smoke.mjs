import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
const profile = await mkdtemp(join(tmpdir(),'echopilot-smoke-'));
function run() {
  return new Promise((resolve,reject) => {
    const child = spawn(electron,['.','--smoke',`--profile=${profile}`],{stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';
    child.stdout.on('data',data => stdout+=data);
    child.stderr.on('data',data => stderr+=data);
    const timer = setTimeout(() => {child.kill('SIGKILL');reject(new Error('Smoke timed out after 20s'));},20000);
    child.on('error',error => {clearTimeout(timer);reject(error);});
    child.on('exit',code => {clearTimeout(timer);const line=stdout.split('\n').find(line => line.startsWith('ECHOPILOT_SMOKE '));if(code!==0 || !line) reject(new Error(`Electron exited ${code}: ${stderr}`)); else resolve(JSON.parse(line.slice(16)));});
  });
}
try {
  const first = await run(); const second = await run();
  if (first.id !== second.id) throw new Error('Fixture identity changed after restart');
  console.log('PASS: IPC, mute, renderer isolation, dashboard lifecycle, journal restart identity.');
} finally {await rm(profile,{recursive:true,force:true});}
