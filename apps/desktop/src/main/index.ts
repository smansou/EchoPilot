import { app, BrowserWindow, ipcMain, protocol, session, Menu } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { createCoordinator, BOOTSTRAP_EVENT, parseJournal, serializeJournal } from '../../../../packages/core/src/index';
import { parseCommand } from '../../../../packages/contracts/src/index';

protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const smoke = process.argv.includes('--smoke');
const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
if (profileArg) app.setPath('userData', resolve(profileArg.slice('--profile='.length)));
app.setName('EchoPilot');
const coordinator = createCoordinator();
let widget: BrowserWindow | null = null;
let dashboard: BrowserWindow | null = null;
const rendererRoot = resolve(__dirname, '../renderer');
function publish() {
  const state = coordinator.getState();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('echo:state', state);
  return state;
}
function createWindow(view: 'widget' | 'dashboard') {
  const isWidget = view === 'widget';
  const window = new BrowserWindow({
    width:isWidget ? 390 : 1040, height:isWidget ? 420 : 780, minWidth:isWidget ? 360 : 760,
    minHeight:isWidget ? 360 : 600, show:false, alwaysOnTop:isWidget,
    title:isWidget ? 'EchoPilot' : 'EchoPilot · Mission Control', backgroundColor:'#10171d',
    autoHideMenuBar:true,
    webPreferences:{preload:resolve(__dirname,'../preload/index.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false},
  });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (!smoke) isWidget ? window.showInactive() : window.show(); });
  void window.loadURL(`echo://app/index.html?view=${view}`);
  return window;
}
function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) { if (!smoke) dashboard.show(); return; }
  dashboard = createWindow('dashboard');
  dashboard.on('closed', () => { dashboard = null; });
}
async function bootstrapJournal() {
  const directory = join(app.getPath('userData'),'synthetic');
  const path = join(directory,'bootstrap.jsonl');
  await mkdir(directory,{recursive:true,mode:0o700});
  let events;
  try { events = parseJournal(await readFile(path,'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    events = [BOOTSTRAP_EVENT];
    await writeFile(`${path}.tmp`, serializeJournal(events),{mode:0o600});
    await rename(`${path}.tmp`,path);
  }
  for (const event of events) coordinator.ingest(event);
}
async function ready() {
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('echo', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || request.method !== 'GET') return new Response(null,{status:403});
    const name = decodeURIComponent(url.pathname).replace(/^\//,'');
    if (name !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(name)) return new Response(null,{status:404});
    try {
      const data = await readFile(join(rendererRoot,name));
      const mime = extname(name) === '.js' ? 'text/javascript' : extname(name) === '.css' ? 'text/css' : 'text/html';
      return new Response(data,{headers:{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"}});
    } catch { return new Response(null,{status:404}); }
  });
  await bootstrapJournal();
  ipcMain.handle('echo:command', (event, payload: unknown) => {
    if (![widget,dashboard].some(window => window?.webContents === event.sender) || event.senderFrame !== event.sender.mainFrame || !event.senderFrame?.url.startsWith('echo://app/index.html?view=')) throw new Error('Untrusted IPC sender');
    const command = parseCommand(payload);
    switch(command.type) {
      case 'get-state': return coordinator.getState();
      case 'set-muted': coordinator.setMuted(command.muted); break;
      case 'replay': coordinator.replay(); break;
      case 'open-dashboard': openDashboard(); break;
    }
    return publish();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'EchoPilot',submenu:[{label:'Mission Control',click:openDashboard},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
  widget = createWindow('widget');
  widget.on('closed', () => { widget = null; app.quit(); });
  app.on('activate',openDashboard);
  if (smoke) {
    await new Promise<void>((resolve,reject) => {widget!.webContents.once('did-finish-load',() => resolve());widget!.webContents.once('did-fail-load',(_e,code,description) => reject(new Error(`${code}: ${description}`)));});
    const result = await widget.webContents.executeJavaScript(`(async () => {
      const first = await window.echo.command({type:'get-state'});
      await window.echo.command({type:'set-muted',muted:true});
      const muted = await window.echo.command({type:'get-state'});
      let rejected = false; try {await window.echo.command({type:'execute',command:'no'});} catch {rejected = true;}
      await window.echo.command({type:'open-dashboard'});
      return {id:first.event?.id,muted:muted.muted,rejected,nodeExposed:typeof process !== 'undefined',rendered:document.body.textContent.includes(first.event?.text)};
    })()`);
    dashboard!.close();
    if (!result.id || !result.muted || !result.rejected || result.nodeExposed || !result.rendered || widget.isDestroyed()) throw new Error(`Smoke failed: ${JSON.stringify(result)}`);
    console.log(`ECHOPILOT_SMOKE ${JSON.stringify(result)}`);
    app.quit();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',openDashboard);
  void app.whenReady().then(ready).catch(error => {console.error('EchoPilot startup failed:',error);app.exit(1);});
}
