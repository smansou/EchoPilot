/** Render the approved vector and assemble every macOS iconset size. */
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
if(process.platform!=='darwin')throw Error('macOS iconutil is required.');
const directory=await mkdtemp(join(tmpdir(),'cleo-icon-'));const output=resolve('assets/branding');
const electron=process.env.ECHOPILOT_ELECTRON_PATH||createRequire(import.meta.url)('electron');
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});if(result.status!==0)throw Error(result.stderr||'Icon rendering failed.');}
try{
 const svg=await readFile(join(output,'cleo.svg'),'utf8');
 await writeFile(join(directory,'render.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,'profile'))});app.whenReady().then(async()=>{try{const w=new BrowserWindow({width:1024,height:1024,show:false,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{sandbox:true}});await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html style="background:transparent"><body style="margin:0;background:transparent;width:1024px;height:1024px">'+${JSON.stringify(svg)}+'</body></html>'));const image=(await w.webContents.capturePage()).resize({width:1024,height:1024,quality:'best'});require('node:fs').writeFileSync(${JSON.stringify(join(output,'cleo.png'))},image.toPNG());app.exit(0);}catch(e){console.error(e);app.exit(1);}});`);
 run(electron,[join(directory,'render.cjs')]);const iconset=join(directory,'Cleo.iconset');await mkdir(iconset);
 for(const size of [16,32,128,256,512])for(const scale of [1,2])run('/usr/bin/sips',['-z',String(size*scale),String(size*scale),join(output,'cleo.png'),'--out',join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
 run('/usr/bin/iconutil',['-c','icns',iconset,'-o',join(output,'cleo.icns')]);console.log('Built assets/branding/cleo.icns');
}finally{await rm(directory,{recursive:true,force:true});}
