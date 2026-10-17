import {BrowserWindow,screen} from 'electron';
import type {AttentionResult,AttentionBounds} from './shared-attention';
/** Four thin click-through edge windows keep the center empty even if transparency fails.
 * Native windows never cover the screen's contents or acquire keyboard/mouse focus. */
export function createSharedHighlight(){
  let edges:BrowserWindow[]=[],label:BrowserWindow|null=null,revision='',frame:AttentionBounds|null=null;
  let timer:ReturnType<typeof setInterval>|null=null,fade:ReturnType<typeof setInterval>|null=null,generation=0,disposed=false;let setupPromise:Promise<void>|null=null;
  function hide(animated=false){
    if(animated&&fade)return;
    generation++;if(timer)clearInterval(timer);timer=null;if(fade)clearInterval(fade);fade=null;revision='';frame=null;
    const windows=[...edges,...(label?[label]:[])].filter(window=>!window.isDestroyed());
    const finish=()=>{for(const window of windows){if(!window.isDestroyed()){window.hide();window.setOpacity(1);}}};
    if(!animated||!windows.some(window=>window.isVisible())){finish();return;}
    const token=generation,started=Date.now();fade=setInterval(()=>{if(token!==generation){if(fade)clearInterval(fade);fade=null;return;}const progress=Math.min(1,(Date.now()-started)/130);for(const window of windows)if(!window.isDestroyed())window.setOpacity((1-progress)**2);if(progress===1){if(fade)clearInterval(fade);fade=null;finish();}},16);
  }
  async function setup(){
    if(disposed)throw Error('Highlight disposed');
    if(edges.length===4&&edges.every(edge=>!edge.isDestroyed())&&label&&!label.isDestroyed())return;
    if(setupPromise)return setupPromise;
    setupPromise=(async()=>{
      for(const edge of edges)if(!edge.isDestroyed())edge.destroy();edges=[];if(label&&!label.isDestroyed())label.destroy();label=null;
      const created:BrowserWindow[]=[];
      const create=async(html:string)=>{const window=new BrowserWindow({width:8,height:8,enableLargerThanScreen:true,frame:false,transparent:true,hasShadow:false,focusable:false,alwaysOnTop:true,skipTaskbar:true,show:false,resizable:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});created.push(window);window.setIgnoreMouseEvents(true);window.setAlwaysOnTop(true,'floating');await window.loadURL('data:text/html,'+encodeURIComponent(html));if(disposed)throw Error('Highlight disposed');return window;};
      try{
        const batch:BrowserWindow[]=[];
        for(let index=0;index<4;index++)batch.push(await create(`<html style="background:transparent"><style>body{margin:0;background:transparent;overflow:hidden}.edge{position:absolute;inset:2px;border-radius:5px;background:linear-gradient(100deg,#b793ed,#d5c7ff 22%,#a1f4d6 52%,#bfa4f0);background-size:250% 100%;opacity:.87;box-shadow:0 0 6px #b6a0ed88;animation:flow 5s ease-in-out infinite,arrive .24s ease-out}.edge:after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,#ffffffe8,transparent);background-size:300% 100%;animation:scan 7s ease-in-out infinite;opacity:.3}@keyframes flow{0%,100%{background-position:0 50%;border-radius:6px}50%{background-position:100% 50%;border-radius:2px}}@keyframes scan{0%,100%{background-position:140% 0}50%{background-position:-80% 0}}@keyframes arrive{from{opacity:0;filter:blur(3px)}to{opacity:.87;filter:blur(0)}}@media(prefers-reduced-motion:reduce){*,*:after{animation:none!important}}</style><body><div class="edge"></div></body></html>`));
        const caption=await create('<html style="background:transparent"><body style="margin:0;overflow:hidden;background:transparent"><div style="padding:5px 12px;border-radius:12px;background:#272431ee;color:#f2eafb;font:12px -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="label"></div></body></html>');
        edges=batch;label=caption;
      }catch(error){for(const window of created)if(!window.isDestroyed())window.destroy();throw error;}
    })();
    try{await setupPromise;}finally{setupPromise=null;}
  }
  function place(b:AttentionBounds){const t=6;const bounds=[{x:b.x-3,y:b.y-3,width:b.width+6,height:t},{x:b.x+b.width-3,y:b.y,width:t,height:b.height},{x:b.x-3,y:b.y+b.height-3,width:b.width+6,height:t},{x:b.x-3,y:b.y,width:t,height:b.height}];edges.forEach((edge,i)=>{const value=bounds[i]!;if(!edge.isDestroyed()){edge.setBounds({x:Math.round(value.x),y:Math.round(value.y),width:Math.max(1,Math.round(value.width)),height:Math.max(1,Math.round(value.height))});if(!edge.isVisible())edge.showInactive();}});
    if(label&&!label.isDestroyed()){const area=screen.getDisplayMatching(b).workArea;const y=b.y-36>=area.y?b.y-36:b.y+b.height+8+28<=area.y+area.height?b.y+b.height+8:null;if(y===null){label.hide();return;}label.setBounds({x:Math.round(Math.max(area.x,Math.min(area.x+area.width-260,b.x+12))),y:Math.round(y),width:Math.min(260,Math.max(120,Math.round(b.width-24))),height:28});if(!label.isVisible())label.showInactive();}}
  function update(attention:AttentionResult){
    if(disposed)return;
    const target=attention.state==='stable'?attention.target:null;if(!target){hide(true);return;}
    if(fade){clearInterval(fade);fade=null;for(const window of [...edges,...(label?[label]:[])])if(!window.isDestroyed())window.setOpacity(1);}
    const next=JSON.stringify([target.id,target.revision]);if(next===revision)return;revision=next;
    const token=++generation;const from=frame??{x:target.bounds.x+target.bounds.width/2-10,y:target.bounds.y+target.bounds.height/2-10,width:20,height:20},to=target.bounds;frame={...to};
    if(timer)clearInterval(timer);timer=null;
    void setup().then(()=>{if(token!==generation)return;
      const text=`${/window|area|textblock/.test(target.type)?'Area':target.type==='paragraph'?'Paragraph':target.type==='sentence'?'Sentence':'Target'} · ${target.label.slice(0,50)}`;
      void label?.webContents.executeJavaScript(`document.getElementById('label').textContent=${JSON.stringify(text)}`).catch(()=>{});
      const started=Date.now();for(const window of [...edges,...(label?[label]:[])])if(!window.isDestroyed())window.setOpacity(.25);place(from);timer=setInterval(()=>{if(token!==generation){if(timer)clearInterval(timer);timer=null;return;}const progress=Math.min(1,(Date.now()-started)/220),gain=1-(1-progress)**3;for(const window of [...edges,...(label?[label]:[])])if(!window.isDestroyed())window.setOpacity(.25+.75*gain);place({x:from.x+(to.x-from.x)*gain,y:from.y+(to.y-from.y)*gain,width:from.width+(to.width-from.width)*gain,height:from.height+(to.height-from.height)*gain});if(progress===1){if(timer)clearInterval(timer);timer=null;}},16);
    }).catch(()=>{if(token===generation){revision='';hide();}});
  }
  return {update,hide,dispose(){disposed=true;hide();for(const edge of edges)if(!edge.isDestroyed())edge.destroy();edges=[];if(label&&!label.isDestroyed())label.destroy();label=null;}};
}
