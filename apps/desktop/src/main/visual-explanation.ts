import {BrowserWindow,screen} from 'electron';
export type VisualExplanation={title:string;steps:{label:string;detail:string}[]};
export function validateExplanation(value:unknown):VisualExplanation{
  const input=value as VisualExplanation;
  if(!input||typeof input.title!=='string'||!input.title.trim()||input.title.length>100||!Array.isArray(input.steps)||input.steps.length<2||input.steps.length>6||input.steps.some(step=>!step||typeof step.label!=='string'||!step.label.trim()||step.label.length>80||typeof step.detail!=='string'||step.detail.length>240))throw Error('Use a title and two to six short, labeled steps.');
  return {title:input.title,steps:input.steps.map(step=>({...step}))};
}
/** A small, dismissible flow diagram. Model-provided strings are assigned as text, never HTML. */
export function createVisualExplanation(){
  let window:BrowserWindow|null=null;let generation=0;
  const hide=()=>{generation++;if(window&&!window.isDestroyed())window.destroy();window=null;};
  return {hide,dispose:hide,async show(value:unknown,signal?:AbortSignal){
    signal?.throwIfAborted();
    const input=validateExplanation(value);hide();const token=generation;
    const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width=Math.min(400,area.width),height=Math.min(200+input.steps.length*90,area.height-24);
    const panel=new BrowserWindow({x:area.x+area.width-width-16,y:area.y+Math.max(12,(area.height-height)/2),width,height,frame:false,transparent:true,resizable:false,show:false,alwaysOnTop:true,focusable:false,acceptFirstMouse:true,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window=panel;
    panel.setAlwaysOnTop(true,'floating');panel.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true});
    panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));panel.webContents.on('will-navigate',event=>event.preventDefault());
    await panel.loadURL('data:text/html,'+encodeURIComponent(`<html><meta charset="utf-8"><style>body{margin:0;overflow:hidden;background:transparent;color:#eceaf7;font:13px/1.55 -apple-system,sans-serif}.panel{margin:8px;background:#201e2bf5;border:1px solid #c5b4f23b;border-radius:23px;padding:24px;box-shadow:0 7px 22px #0003;box-sizing:border-box;height:calc(100vh - 16px);overflow:auto;scrollbar-width:thin;scrollbar-color:#6e6484 transparent}small{color:#b3a5cf;font-size:10px;letter-spacing:1.5px}h1{font-size:20px;font-weight:550;line-height:1.3;margin:12px 25px 22px 0}ol{list-style:none;margin:0;padding:0;counter-reset:step}li{position:relative;padding:0 0 24px 37px;counter-increment:step}li:before{content:counter(step);position:absolute;left:0;top:0;background:#b19bdd26;border:1px solid #bba3ee55;width:23px;height:23px;border-radius:8px;text-align:center;line-height:23px;color:#d9c7ff}li:not(:last-child):after{content:'';position:absolute;left:12px;top:29px;bottom:5px;width:1px;background:#bba3ee33}li:last-child{padding-bottom:0}strong{font-weight:550}p{margin:5px 0 0;font-size:12px;color:#b8b3c8}button{position:fixed;right:25px;top:24px;border:0;border-radius:50%;width:25px;height:25px;background:#ffffff12;color:#fff;cursor:pointer}button:focus-visible{outline:2px solid #c2a7ff}</style><body><section class="panel"><small>ECHOPILOT · EXPLAINED</small><button aria-label="Close explanation" onclick="window.close()">×</button><h1 id="title"></h1><ol id="steps"></ol></section></body></html>`));
    if(token!==generation||panel.isDestroyed())return {shown:false};
    await panel.webContents.executeJavaScript(`document.getElementById('title').textContent=${JSON.stringify(input.title)};for(const step of ${JSON.stringify(input.steps)}){const li=document.createElement('li'),label=document.createElement('strong'),detail=document.createElement('p');label.textContent=step.label;detail.textContent=step.detail;li.append(label,detail);document.getElementById('steps').append(li);}`);
    if(token!==generation||panel.isDestroyed())return {shown:false};if(signal?.aborted){hide();return {shown:false};}panel.showInactive();return {shown:true,title:input.title,steps:input.steps.length};
  }};
}
