/** Real Chromium media regression; synthetic input, no physical mic or provider API.
 * Run: node scripts/check-live-media-chromium.mjs [path-to-electron]
 * Requires a working Electron installation (or an explicit executable).
 * This checks transport/queue mechanics, not a live provider's barge-in latency.
 */
import {build} from 'esbuild';
import {mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const electron=process.argv[2]??createRequire(import.meta.url)('electron');
const directory=await mkdtemp(join(tmpdir(),'cleo-live-media-'));
try{
 for(const transport of ['pcm','webrtc']){
  await build({entryPoints:[join(root,`apps/desktop/src/renderer/live-${transport}.ts`)],bundle:true,format:'esm',platform:'browser',outfile:join(directory,`live-${transport}.mjs`)});
  await copyFile(join(root,`scripts/fixtures/live-media/${transport}.html`),join(directory,`${transport}.html`));
 }
 for(const worklet of ['pcm','handoff'])await copyFile(join(root,`apps/desktop/src/renderer/live-${worklet}-worklet.js`),join(directory,`live-${worklet}-worklet.js`));
 const main=join(directory,'main.cjs');
 await writeFile(main,`
 const {app,BrowserWindow}=require('electron');
 const path=require('node:path');
 app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
 app.setPath('userData',path.join(__dirname,'profile-'+process.argv[2]));
 app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  window.webContents.setAudioMuted(true);
  window.webContents.on('console-message',event=>{const message=event.message;if(message.startsWith('VOICE_CHECK_RESULT ')){console.log(message);app.exit(JSON.parse(message.slice(19)).ok?0:1);}});
  setTimeout(()=>{console.error('Synthetic Chromium media check timed out');app.exit(1);},20000);
  await window.loadFile(path.join(__dirname,process.argv[2]+'.html'));
 });`);
 for(const transport of ['pcm','webrtc']){
  const result=await new Promise((resolve,reject)=>{
   const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
   const child=spawn(electron,[main,transport],{stdio:'inherit',env:environment});
   const timer=setTimeout(()=>{child.kill();reject(Error(`${transport}: Chromium timed out`));},30000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  if(result.code!==0)throw Error(`${transport}: Chromium exited ${JSON.stringify(result)}`);
 }
}finally{await rm(directory,{recursive:true,force:true});}
