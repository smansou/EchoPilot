import {createSharedScreenSession} from './shared-screen-session';
import {createSharedHighlight} from './shared-highlight';
import { createLiveSession } from './live-session';
import { createAgentBackend } from './agent-backend';
import { connectOpenAILive } from './openai-live';
import { connectGeminiLive } from './gemini-live';
import { resolveProviderSetup } from '../shared/provider-setup';
import { createSessionKnowledge } from './session-knowledge';
import { createCodingContext } from './coding-context';
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, screen, shell, systemPreferences } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCloudProvider, type CloudConfig, type ScreenContext } from './cloud-provider';
import { createDesktopSession, type SessionHistory, type SessionMode, type SessionState } from './desktop-session';
import { createDesktopEdit } from './desktop-edit';
import { createDesktopObserveHost } from './desktop-observe';
import { createGazeOverlay } from './gaze-overlay';
import type { createGazeHost } from './gaze-host';
import type { SecretStore } from '../../../../packages/security/src/types';
export function createDesktopExperience(options:{bundleDir:string; secrets:Pick<SecretStore,'get'>; setting(key:string):string; allowed():boolean; trusted(event:Electron.IpcMainInvokeEvent):boolean; widget():BrowserWindow|null; reveal():void; gaze:ReturnType<typeof createGazeHost>}) {
  const coding=createCodingContext();
  const cloud=createCloudProvider({secrets:options.secrets});
  const edit=createDesktopEdit(options.bundleDir);
  const observe=createDesktopObserveHost({bundleDir:options.bundleDir,timeoutMs:2500});
  let shared:ReturnType<typeof createSharedScreenSession>|undefined;
  const highlight=createSharedHighlight();
  const overlay=createGazeOverlay({onStop:()=>{shared?.enable(false);highlight.hide();},host:options.gaze,bundleDir:options.bundleDir,projectId:()=> 'desktop'});
  const historyPath=join(app.getPath('userData'),'desktop-history.enc');
  let history:SessionHistory[]=[];
  try {if(existsSync(historyPath)&&safeStorage.isEncryptionAvailable())history=JSON.parse(safeStorage.decryptString(readFileSync(historyPath))).slice(-200);}catch{}
  let gazeTarget:Awaited<ReturnType<typeof edit.atPoint>>|null=null;
  let idleTimer:ReturnType<typeof setTimeout>|null=null;
  const config=():CloudConfig=>{const setup=resolveProviderSetup(options.setting);return {provider:setup.reasoning,textModel:setup.textModel,speechModel:setup.speechModel};};
  async function observeContext(signal:AbortSignal) {
      const result:ScreenContext={text:''};
      if(shared?.status().enabled){await shared.read();signal.throwIfAborted();result.text=JSON.stringify(shared.context()??{screen:'unavailable',instruction:'Ask for clarification; older screen references are invalid.'});return result;}
      const samples=options.gaze.recentSamples().filter(s=>Date.now()-Date.parse(s.timestamp)<800&&s.quality>=.6);
      const observation=await observe.observe({projectId:'desktop'});signal.throwIfAborted();
      gazeTarget=null;
      if(observation.outcome==='observed') {
        result.text=`App: ${observation.evidence.application.name}\nWindow: ${observation.evidence.window.title}\n`+observation.evidence.nodes.filter(n=>!n.redacted&&!/secure|password/i.test(n.role+' '+n.subrole)).slice(0,60).map(n=>[n.role,n.label,n.value].filter(Boolean).join(': ').slice(0,250)).join('\n');
      }
      // Never turn an explicit exclusion or a secure field into a screenshot fallback.
      const excluded=observation.outcome==='denied'&&observation.code==='excluded_application';
      const secure=observation.outcome==='observed'&&observation.evidence.nodes.some(n=>n.redacted||/secure|password/i.test(n.role+' '+n.subrole));
      if(!excluded&&!secure) {
        if(samples.length>=4) {
          const x=samples.reduce((n,s)=>n+s.meanX,0)/samples.length,y=samples.reduce((n,s)=>n+s.meanY,0)/samples.length;
          const latest=samples.at(-1)!;
          const spread=Math.max(...samples.map(s=>Math.hypot(s.meanX-x,s.meanY-y)));
          const sigma=Math.sqrt(Math.max(latest.covariance2x2[0][0],latest.covariance2x2[1][1]));
          if(spread<70&&sigma<100) {
            const candidate=await edit.atPoint(x,y).catch(()=>null);signal.throwIfAborted();
            gazeTarget=candidate;
            if(gazeTarget)result.gaze=`Approximate gaze target: ${gazeTarget.state.role} ${gazeTarget.state.label}. Uncertainty: ${Math.round(sigma)} points. Ask for clarification if ambiguous.`;
          }
        }
        if(result.text.length<100&&systemPreferences.getMediaAccessStatus('screen')==='granted') {
          const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
          const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1280,height:800}});signal.throwIfAborted();
          const source=sources.find(s=>s.display_id===String(display.id));
          if(source&&!source.thumbnail.isEmpty())result.image=`data:image/jpeg;base64,${source.thumbnail.toJPEG(65).toString('base64')}`;
        }
      }
      return result;
    }
  async function remember(item:SessionHistory) {history=[...history,item].slice(-200);if(safeStorage.isEncryptionAvailable()){mkdirSync(app.getPath('userData'),{recursive:true});const temporary=historyPath+'.tmp';writeFileSync(temporary,safeStorage.encryptString(JSON.stringify(history)),{mode:0o600});renameSync(temporary,historyPath);}}
  function changed(state:SessionState) {
      const widget=options.widget();if(idleTimer)clearTimeout(idleTimer);idleTimer=null;
      if(state.phase==='idle'){widget?.hide();return;}
      options.reveal();
      const active=options.widget();
      if(active){const d=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());active.setBounds({x:Math.round(d.bounds.x+(d.bounds.width-440)/2),y:d.workArea.y,width:440,height:state.reply||state.phase==='error'?190:100});}
      if(state.phase==='done')idleTimer=setTimeout(()=>{if(session.status().id===state.id)session.cancel();},1600);
    }
  const session=createDesktopSession({
    config,smart:()=>options.setting('dictation.mode')!=='plain',allowed:options.allowed,
    captureTarget:edit.capture,transcribe:cloud.transcribe,
    complete:cloud.complete,insert:edit.insert,context:observeContext,
    remember,changed,
  });
  const knowledge=createSessionKnowledge({library:coding,summarize:(question,evidence,signal)=>cloud.research(config(),question,evidence,signal)});
  const backend=createAgentBackend({config,cloud,knowledge,screen:observeContext,screenContext:()=>shared?.context(),findScreenTarget:(query,signal)=>{signal.throwIfAborted();return shared?.find(query);},focusScreenTarget:(id,signal)=>{signal.throwIfAborted();return shared?.choose(id);},prepare:async(action,signal)=>{
      if(action.target==='gaze'&&shared?.status().enabled){const target=shared.actionTarget(action.operation);if(!target)throw Error('Gaze is ambiguous or stale. Name the target so it can be highlighted.');
        if(['window','area','textblock','paragraph','sentence'].includes(target.type)&&action.operation!=='scroll')throw Error('This is a reading area, not a verified actionable control. Name a button or focused text field.');
        const control=await edit.atPoint(target.bounds.x+target.bounds.width/2,target.bounds.y+target.bounds.height/2,target.nativeRole??target.type);signal.throwIfAborted();
        if(control.state.appBundleId!==target.app.split(':')[0]||control.state.role!==(target.nativeRole??target.type))throw Error('The native control does not match the highlighted target. Please clarify.');
        return edit.prepare(action,control,signal);}
      return edit.prepare(action,gazeTarget,signal);},revision:()=>live.revision(),inputOffset:()=>live.inputOffset(),userTextAfter:offset=>live.userTextAfter(offset),contextNote:content=>live.note(content)});
  const live=createLiveSession({userInput:text=>shared?.pin(text),screenContext:()=>shared?.context(),
    key:provider=>options.secrets.get(provider),preferences:()=>{const setup=resolveProviderSetup(options.setting);return {provider:setup.voice,voice:setup.voiceName};},
    allowed:options.allowed,knowledge,backend:request=>backend.run(request),clearBackend:()=>backend.clear(),
    connect:(provider,connection)=>provider==='openai'?connectOpenAILive(connection):connectGeminiLive(connection),
    history:()=>history.filter(h=>h.mode==='agent'),remember,changed,media:event=>options.widget()?.webContents.send('echo:live-media',event),
  });
  // User approved bounded screen-text sharing with the configured live/reasoning providers.
  shared=createSharedScreenSession({allowed:options.allowed,samples:()=>options.gaze.recentSamples(),observe:()=>observe.observe({projectId:'desktop',allowLocalOCR:true}),
    voiceSession:()=>live.status().phase==='listening'?live.status().id:null,send:content=>live.note(content),highlight:attention=>{overlay.suppressMarker(attention.state==='stable'&&attention.target!==null);highlight.update(attention);}});
  function status(){return live.status().phase!=='idle'?live.status():session.status();}
  let transition=Promise.resolve();let transitionVersion=0;
  function toggle(mode:SessionMode){const version=transitionVersion;transition=transition.catch(()=>{}).then(async()=>{if(version!==transitionVersion)return;
    if(mode==='agent'){session.cancel();if(live.active())await live.stop();else await live.start();}
    else {await live.stop();if(version===transitionVersion)session.toggle('dictation');}
  });return transition;}
  async function cancel(){transitionVersion++;session.cancel();await live.stop();knowledge.clear();}
  ipcMain.handle('echo:desktop',async(event,input:unknown)=>{
    if(!input||typeof input!=='object')throw Error('Untrusted request');
    const request=input as Record<string,unknown>;
    if(overlay.owns(event.sender)&&event.senderFrame===event.sender.mainFrame&&event.senderFrame?.url==='echo://app/index.html?view=gaze')return overlay.handle(event.sender,request);
    if(!options.trusted(event))throw Error('Untrusted request');
    switch(request.action){
      case 'status':return status();
      case 'toggle':if(request.mode!=='dictation'&&request.mode!=='agent')throw Error('Invalid mode');await toggle(request.mode);return status();
      case 'cancel':await cancel();return status();
      case 'live-connect':if(event.sender!==options.widget()?.webContents||typeof request.id!=='string'||(request.sdp!==undefined&&(typeof request.sdp!=='string'||request.sdp.length>65536)))throw Error('Invalid live connection');return live.join(request.id,request.sdp as string|undefined);
      case 'live-ready':if(event.sender===options.widget()?.webContents&&typeof request.id==='string')live.ready(request.id);return status();
      case 'live-error':if(event.sender===options.widget()?.webContents&&typeof request.id==='string')live.error(request.id);return status();
      case 'live-audio':if(event.sender!==options.widget()?.webContents||typeof request.id!=='string'||!(request.bytes instanceof Uint8Array)||request.bytes.byteLength>16000)throw Error('Invalid live audio');live.audio(request.id,request.bytes);return;
      case 'ready':if(typeof request.id==='string')session.ready(request.id);return session.status();
      case 'error':if(typeof request.id==='string'&&typeof request.message==='string')session.fail(request.id,request.message);return session.status();
      case 'audio':if(event.sender!==options.widget()?.webContents||typeof request.id!=='string'||!(request.bytes instanceof Uint8Array)||request.bytes.byteLength>8_000_000)throw Error('Invalid audio');await session.audio(request.id,request.bytes);return session.status();
      case 'history':return history;
      case 'clear-history':history=[];if(safeStorage.isEncryptionAvailable())writeFileSync(historyPath,safeStorage.encryptString('[]'),{mode:0o600});return [];
      case 'shared-screen-status':return shared?.status();
      case 'shared-screen-toggle':if(typeof request.enabled!=='boolean')throw Error('Choose whether to highlight screen context.');return shared?.enable(request.enabled);
      case 'gaze-start':if(typeof request.displayId!=='string')throw Error('Choose a display');await overlay.start(request.displayId);return {ok:true};
      case 'gaze-stop':await overlay.stop();return {ok:true};
      case 'open-permission': {
        const panes:Record<string,string>={Microphone:'Privacy_Microphone',Accessibility:'Privacy_Accessibility','Screen Recording':'Privacy_ScreenCapture',Camera:'Privacy_Camera'};
        if(typeof request.permission!=='string'||!panes[request.permission])throw Error('Unknown permission');
        await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[request.permission]}`);return {ok:true};
      }
      case 'permissions':return {microphone:systemPreferences.getMediaAccessStatus('microphone'),camera:systemPreferences.getMediaAccessStatus('camera'),screen:systemPreferences.getMediaAccessStatus('screen'),accessibility:systemPreferences.isTrustedAccessibilityClient(false)};
      default:throw Error('Unknown desktop command');
    }
  });
  return {toggle,cancel,dispose(){shared?.dispose();highlight.dispose();cancel();void overlay.stop();ipcMain.removeHandler('echo:desktop');},overlay};
}
