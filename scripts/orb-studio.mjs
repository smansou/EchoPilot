import {createServer} from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../assets/branding/editor');const output=resolve(import.meta.dirname,'../artifacts/branding');
const files={'/':['index.html','text/html'],'/index.html':['index.html','text/html'],'/style.css':['style.css','text/css'],'/editor.js':['editor.js','text/javascript']};
const server=createServer(async(req,res)=>{try{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='POST'&&req.url==='/selection'){
  if(req.headers.origin!==`http://${req.headers.host}`){res.writeHead(403).end();return;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.writeHead(413).end();return;}}
  const value=JSON.parse(body),s=value.composition;
  if(!s||!['light','dark','none'].includes(s.theme)||!['A','B','C','D','E','F'].includes(s.id)||!['x','y','r'].every(k=>Number.isFinite(s[k]))||s.x < -128||s.x>1152||s.y < -128||s.y>1152||s.r<128||s.r>700||typeof value.svg!=='string'||!value.svg.startsWith('<svg')||value.svg.length>16000){res.writeHead(400).end();return;}
  await mkdir(output,{recursive:true});await writeFile(join(output,'selection.json.tmp'),JSON.stringify({savedAt:new Date().toISOString(),composition:s},null,2)+'\n');await rename(join(output,'selection.json.tmp'),join(output,'selection.json'));await writeFile(join(output,'selection.svg'),value.svg);res.setHeader('Content-Type','application/json');res.end('{"saved":true}');return;
 }
 const file=files[req.url];if(req.method!=='GET'||!file){res.writeHead(404).end();return;}res.setHeader('Content-Type',file[1]);res.end(await readFile(join(root,file[0])));
 }catch{res.writeHead(400).end('Could not complete this request.');}});
server.listen(Number(process.env.CLEO_STUDIO_PORT||4176),'127.0.0.1',()=>console.log('Cleo orb studio: http://127.0.0.1:'+server.address().port));
