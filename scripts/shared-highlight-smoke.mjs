// Native-window safety/lifecycle fixture: synthetic regions only, no user screen capture.
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import electron from 'electron';
const directory=await mkdtemp('/private/tmp/echo-highlight-smoke-');
await build({entryPoints:['apps/desktop/src/main/shared-highlight.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(directory,'highlight.cjs')});
const fixture=`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const {createSharedHighlight}=require('./highlight.cjs');app.setPath('userData',${JSON.stringify(join(directory,'profile'))});
const delay=ms=>new Promise(r=>setTimeout(r,ms));const seen=new Map();let placements=0;
const originalIgnore=BrowserWindow.prototype.setIgnoreMouseEvents;BrowserWindow.prototype.setIgnoreMouseEvents=function(value){seen.set(this.id,{...seen.get(this.id),mouseIgnored:value});return originalIgnore.call(this,value)};
const originalTop=BrowserWindow.prototype.setAlwaysOnTop;BrowserWindow.prototype.setAlwaysOnTop=function(value,level){seen.set(this.id,{...seen.get(this.id),level});return originalTop.call(this,value,level)};
const originalBounds=BrowserWindow.prototype.setBounds;BrowserWindow.prototype.setBounds=function(...args){placements++;return originalBounds.apply(this,args)};
const originalLoad=BrowserWindow.prototype.loadURL;BrowserWindow.prototype.loadURL=async function(...args){await originalLoad.apply(this,args);await delay(40)};
const attention=(revision='1')=>({state:'stable',target:{id:'synthetic',revision,type:'paragraph',label:'Synthetic paragraph',app:'Fixture',window:'Fixture',bounds:{x:300,y:200,width:500,height:300}},candidates:[],uncertaintyRadius:30,changedAt:0,observedAt:0});
app.whenReady().then(async()=>{let highlight;const ordinary=new BrowserWindow({show:false,width:420,height:260});const windows=()=>BrowserWindow.getAllWindows().filter(w=>w!==ordinary);try{
 highlight=createSharedHighlight();for(let i=0;i<8;i++)highlight.update(attention(String(i)));await delay(900);
 assert.equal(windows().length,5,'rapid lazy setup leaked windows');assert.equal(windows().filter(w=>w.isVisible()).length,5);
 const bounds=windows().map(w=>w.getBounds());assert.equal(bounds.filter(b=>b.width<=6||b.height<=6).length,4,'border has blocking center area');assert.equal(bounds.filter(b=>b.height===28&&b.width<=260).length,1,'label must stay small');
 for(const w of windows()){assert.equal(w.isFocusable(),false);assert.equal(w.isFullScreen(),false);assert.equal(seen.get(w.id)?.mouseIgnored,true);assert.equal(seen.get(w.id)?.level,'floating');}
 const before=placements;highlight.update(attention('7'));await delay(300);assert.equal(placements,before,'stable region repeated easing');
 ordinary.show();ordinary.focus();app.focus({steal:true});await delay(150);assert.equal(ordinary.isFocused(),true,'highlight prevented normal window focus');ordinary.hide();
 highlight.hide();await delay(150);assert.equal(windows().filter(w=>w.isVisible()).length,0,'hide left visible windows');highlight.dispose();await delay(100);assert.equal(windows().length,0,'dispose leaked completed windows');
 highlight=createSharedHighlight();highlight.update(attention());highlight.hide();await delay(900);assert.equal(windows().filter(w=>w.isVisible()).length,0,'pending setup resurfaced after hide');highlight.dispose();await delay(100);assert.equal(windows().length,0);
 highlight=createSharedHighlight();highlight.update(attention());highlight.dispose();await delay(900);assert.equal(windows().length,0,'pending setup recreated windows after disposal');
 highlight=createSharedHighlight();highlight.update(attention());highlight.update({...attention(),state:'unavailable',target:null});await delay(900);assert.equal(windows().filter(w=>w.isVisible()).length,0,'unavailable scene resurfaced');highlight.dispose();await delay(100);assert.equal(windows().length,0);
 ordinary.destroy();console.log('SHARED_HIGHLIGHT '+JSON.stringify({windows:5,thinEdges:4,smallLabel:true,clickThrough:true,nonfocusable:true,ordinaryWindowFocus:true,stableDoesNotAnimate:true,rapidSetupNoLeak:true,hideDuringSetup:true,disposeDuringSetup:true,privateScreenCapture:false}));app.exit(0);
 }catch(error){try{highlight?.dispose()}catch{}for(const w of BrowserWindow.getAllWindows())if(!w.isDestroyed())w.destroy();console.error(error.stack);app.exit(1)}});`;
await writeFile(join(directory,'main.cjs'),fixture);
try{await new Promise((resolve,reject)=>{const child=spawn(electron,[join(directory,'main.cjs')],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);const timeout=setTimeout(()=>{child.kill();reject(Error(output.slice(-3000)))},15000);child.on('exit',code=>{clearTimeout(timeout);code===0?(console.log(output.split('\n').filter(l=>l.includes('SHARED_HIGHLIGHT')).join('\n')),resolve()):reject(Error(output.slice(-3000)))});});}finally{await rm(directory,{recursive:true,force:true});}
