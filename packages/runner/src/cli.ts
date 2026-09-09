import { readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { loadProject } from './config.js';
import { Runner } from './runner.js';
import { serve } from './server.js';
import { chooseModel } from './policy.js';
const root=resolve(process.cwd());const args=process.argv.slice(2).filter(a=>a!=='--');
async function main(){
 if(args.includes('--help')){console.log('pnpm runner: local dashboard (paused)\n--run: start bounded worker loop\n--dry-run: show model assignments; no paid calls\n--status | --pause | --resume | --stop: control running server');return;}
 const control=args.find(a=>['--status','--pause','--resume','--stop'].includes(a));
 if(control){const session=JSON.parse(await readFile(join(root,'.runner','session.json'),'utf8')) as {origin:string;token:string};const response=await fetch(session.origin+(control==='--status'?'/api/state':'/api/control'),control==='--status'?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Runner-Token':session.token},body:JSON.stringify({action:control.slice(2)})});const value=await response.json() as Record<string,unknown>;delete value.token;if(!response.ok)throw new Error(String(value.error));console.log(JSON.stringify(value,null,2));return;}
 const {config,tickets}=await loadProject(root);
 if(args.includes('--dry-run')){console.table(tickets.map(t=>({id:t.id,blockedBy:t.deps.join(','),...chooseModel(t,config)})));return;}
 const runner=new Runner(root,tickets,config);const server=await serve(runner);
 console.log(`EchoPilot Build Control: ${server.origin}\nLoop paused. Start in the dashboard. No model calls until started.`);
 let closing=false;const close=()=>{if(closing)return;closing=true;void server.close().then(()=>process.exit(0));};process.once('SIGINT',close);process.once('SIGTERM',close);
 if(args.includes('--run'))try{await runner.resume();}catch(error){console.error(error instanceof Error?error.message:error);}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
