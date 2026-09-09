import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile,writeFile,mkdir,open,unlink } from 'node:fs/promises';
import { join,extname } from 'node:path';
import { Runner } from './runner.js';
export async function serve(runner:Runner){
 const directory=join(runner.root,'.runner');await mkdir(directory,{recursive:true,mode:0o700});
 const lock=join(directory,'server.lock');
 try{const handle=await open(lock,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const pid=Number(await readFile(lock,'utf8'));let alive=true;try{process.kill(pid,0);}catch{alive=false;}if(alive)throw new Error('Runner already active. Use the dashboard or --status.');await unlink(lock);return serve(runner);}
 const token=randomBytes(32).toString('hex');const origin=`http://127.0.0.1:${runner.config.port}`;
 const clients=new Set<ServerResponse>();
 const send=()=>{const message=`data: ${JSON.stringify(runner.payload(token))}\n\n`;for(const client of clients)if(!client.write(message)){client.end();clients.delete(client);}};
 const server=createServer(async(req,res)=>{
  const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(req.headers.host!==`127.0.0.1:${runner.config.port}`||req.headers['sec-fetch-site']==='cross-site'){json(403,{error:'Local same-origin requests only'});return;}
   const url=new URL(req.url??'/',origin);
   if(req.method==='GET'&&url.pathname==='/api/state'){json(200,runner.payload(token));return;}
   if(req.method==='GET'&&url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});clients.add(res);res.write(`data: ${JSON.stringify(runner.payload(token))}\n\n`);req.on('close',()=>clients.delete(res));return;}
   if(req.method==='POST'&&url.pathname==='/api/control'){
    if(req.headers['x-runner-token']!==token||(req.headers.origin&&req.headers.origin!==origin)||req.headers['content-type']!=='application/json'){json(403,{error:'Invalid control request'});return;}
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4096){json(413,{error:'Request too large'});return;}}
    const input=JSON.parse(body) as {action:string;id?:string};
    switch(input.action){case'resume':await runner.resume();break;case'pause':await runner.pause();break;case'stop':await runner.stop();break;case'retry':if(!input.id)throw new Error('Ticket ID required');await runner.retry(input.id);break;default:throw new Error('Unknown control action');}
    json(200,{ok:true});return;
   }
   if(req.method!=='GET'){json(405,{error:'Method not allowed'});return;}
   const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
   if(name!=='index.html'&&!/^assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(name)){json(404,{error:'Not found'});return;}
   const data=await readFile(join(runner.root,'dist','progress',name));
   res.writeHead(200,{'Content-Type':extname(name)==='.js'?'text/javascript':extname(name)==='.css'?'text/css':'text/html','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});res.end(data);
  }catch(error){json(400,{error:error instanceof Error?error.message:'Request failed'});}
 });
 try{
  await runner.initialize();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(runner.config.port,'127.0.0.1',resolve);});
  await writeFile(join(directory,'session.json'),JSON.stringify({origin,token,pid:process.pid}),{mode:0o600});
 }catch(error){await unlink(lock);throw error;}
 const unsubscribe=runner.subscribe(send);const heartbeat=setInterval(()=>{for(const client of clients)client.write(': heartbeat\n\n');},15000);
 const close=async()=>{await runner.stop();unsubscribe();clearInterval(heartbeat);for(const client of clients)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(lock).catch(()=>undefined);await unlink(join(directory,'session.json')).catch(()=>undefined);};
 return {origin,close};
}
