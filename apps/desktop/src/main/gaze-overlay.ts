import { BrowserWindow, screen, globalShortcut } from 'electron';
import { resolve } from 'node:path';
import type { createGazeHost } from './gaze-host';
import { createGazeMotion } from './gaze-motion';
/** Calibration is a normal, closable window. During tracking only a 96px click-through
 * marker is above apps. A renderer failure can never leave a screen-sized blocker. */
export function createGazeOverlay(options:{host:ReturnType<typeof createGazeHost>;bundleDir:string;projectId():string}){
  let window:BrowserWindow|null=null,marker:BrowserWindow|null=null;
  let generation=0,ownsEscape=false,timer:ReturnType<typeof setInterval>|null=null;
  let expiry:ReturnType<typeof setTimeout>|null=null,hostStarted=false,tracking=false,lastSample=0;
  const motion=createGazeMotion();
  async function teardown(){
    if(timer)clearInterval(timer);timer=null;if(expiry)clearTimeout(expiry);expiry=null;
    if(ownsEscape){globalShortcut.unregister('Escape');ownsEscape=false;}
    const previous=window,point=marker;window=null;marker=null;tracking=false;motion.reset();
    if(point&&!point.isDestroyed())point.destroy();if(previous&&!previous.isDestroyed())previous.destroy();
    if(hostStarted){hostStarted=false;await options.host.handle({command:'stop',projectId:options.projectId()});}
  }
  async function close(){generation++;await teardown();}
  async function start(displayId:string){
    const token=++generation;await teardown();if(token!==generation)throw Error('Gaze setup was canceled.');
    const display=screen.getAllDisplays().find(d=>String(d.id)===displayId);if(!display)throw Error('Display disconnected.');
    try{
      hostStarted=true;const result=await options.host.handle({command:'start',projectId:options.projectId(),displayId,enabled:true});
      if(token!==generation)throw Error('Gaze setup was canceled.');if(!result.ok)throw Error('Gaze could not start.');
      const created=new BrowserWindow({...display.workArea,title:'EchoPilot · Gaze calibration',frame:true,transparent:false,alwaysOnTop:false,fullscreenable:false,movable:false,resizable:false,maximizable:false,minimizable:true,closable:true,show:false,backgroundColor:'#191820',webPreferences:{preload:resolve(options.bundleDir,'../preload/index.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      window=created;created.setMenuBarVisibility(false);
      created.webContents.setWindowOpenHandler(()=>({action:'deny'}));created.webContents.on('will-navigate',e=>e.preventDefault());
      created.once('closed',()=>{if(token===generation&&window===created)void close();});
      created.webContents.once('render-process-gone',()=>{if(token===generation)void close();});
      // Keep Escape through the entire session; native close, Cmd-W/Q and Settings also work.
      ownsEscape=globalShortcut.register('Escape',()=>{void close();});
      created.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&(input.key==='Escape'||((input.meta||input.control)&&input.key.toLowerCase()==='w'))){event.preventDefault();void close();}});
      expiry=setTimeout(()=>{if(token===generation)void close();},5*60*1000);
      await created.loadURL('echo://app/index.html?view=gaze');
      if(token!==generation||window!==created||created.isDestroyed())throw Error('Gaze setup was canceled.');
      created.show();
      timer=setInterval(()=>{
        if(token!==generation)return;
        const live=screen.getAllDisplays().find(d=>String(d.id)===displayId);
        if(!live||JSON.stringify(live.bounds)!==JSON.stringify(display.bounds)){void close();return;}
        if(!tracking)return;
        if(Date.now()-lastSample>800){marker?.hide();motion.reset();return;}
        const point=motion.step(Date.now());if(point&&marker&&!marker.isDestroyed()){marker.setPosition(Math.round(Math.max(display.bounds.x,Math.min(display.bounds.x+display.bounds.width-96,point.x-48))),Math.round(Math.max(display.bounds.y,Math.min(display.bounds.y+display.bounds.height-96,point.y-48))));if(!marker.isVisible())marker.showInactive();}
      },16);
    }catch(error){if(token===generation){generation++;await teardown();}throw error;}
  }
  async function handle(contents:Electron.WebContents,request:Record<string,unknown>){
    if(contents!==window?.webContents||contents.isDestroyed())throw Error('Untrusted gaze renderer');
    const token=generation;
    if(request.action==='gaze-config'){const bounds=window.getContentBounds();return {originX:bounds.x,originY:bounds.y};}
    if(request.action==='gaze-close'){await close();return {ok:true};}
    if(request.action==='gaze-calibrated'){
      if(tracking)throw Error('Gaze is already calibrated.');
      const result=await options.host.handle({command:'webgazer-calibration',projectId:options.projectId(),errors:request.errors});
      if(token!==generation)return {ok:false};
      if(result.ok){
        const created=new BrowserWindow({width:96,height:96,frame:false,transparent:true,hasShadow:false,focusable:false,alwaysOnTop:true,skipTaskbar:true,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
        marker=created;created.once('closed',()=>{if(token===generation&&marker===created)void close();});created.webContents.once('render-process-gone',()=>{if(token===generation)void close();});created.setIgnoreMouseEvents(true);created.setAlwaysOnTop(true,'floating');
        await created.loadURL('data:text/html,'+encodeURIComponent('<html style="background:transparent"><body style="margin:0;background:transparent;overflow:hidden"><div style="position:absolute;left:32px;top:32px;width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 30% 25%,#fff,#d6c6f4 40%,#a187d4 80%);box-shadow:0 0 0 10px #cbb4ed20,0 0 24px #cbb4ed70;opacity:.85"></div></body></html>'));
        if(token!==generation){if(!created.isDestroyed())created.destroy();return {ok:false};}
        tracking=true;if(expiry)clearTimeout(expiry);expiry=null;window?.hide();
      }
      return result;
    }
    if(request.action==='gaze-sample'){
      if(!tracking)return {ok:false};
      const result=await options.host.handle({command:'webgazer-sample',projectId:options.projectId(),x:request.x,y:request.y});
      if(token!==generation)return {ok:false};if(!result.ok){if(result.error==='display_unavailable')await close();return result;}
      const point=result.latestSample;if(point){lastSample=Date.now();motion.push(point.meanX,point.meanY);}return {ok:true};
    }
    throw Error('Unknown gaze command');
  }
  return {start,close,handle,owns(contents:Electron.WebContents){return window?.webContents===contents;},stop:close};
}
