import { app, BrowserWindow, globalShortcut, ipcMain, protocol, session, Menu, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCoordinator, parseJournal, serializeJournal } from '../../../../packages/core/src/index';
import { parseCommand } from '../../../../packages/contracts/src/index';
import { createShell, WIDGET_FALLBACK_CONTROLS, type Shell } from './shell';
import { widgetStatusSnapshot, type WidgetSnapshot } from './widget-status';
import {
  applyForegroundSafeWindowBehavior,
  revealWidgetWindow,
  shouldQuitWhenAllWindowsClosed,
  widgetWindowAction,
  windowBehavior,
} from './window-policy';
import { createNativeHost, type NativeHost } from './native-host';
import { createShellTray, type ShellTray } from './tray';
import {
  KEY_ENTRY_CHANNEL,
  createDisabledProvider,
  createFileKernelStorage,
  createKeychainSecretStore,
  createNativeCaptureOperation,
  createNativeHelperBridge,
  createSecurityKernel,
  parseKeyEntryRequest,
  parseKeyEntryResult,
  type NativeHelperBridge,
  type SecurityKernel,
} from '../../../../packages/security/src/index';

protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const smoke = process.argv.includes('--smoke');
const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
if (profileArg) app.setPath('userData', resolve(profileArg.slice('--profile='.length)));
app.setName('EchoPilot');
const coordinator = createCoordinator();
/** Per-launch secret the signed native helper must echo in every message it sends. */
const helperToken = randomUUID();
// globalShortcut is only usable after `app.whenReady()`, so the shell is created inside ready().
let shell: Shell | undefined;
let widget: BrowserWindow | null = null;
let dashboard: BrowserWindow | null = null;
let tray: ShellTray | null = null;
let nativeHost: NativeHost | undefined;
function requireShell(): Shell {
  if (!shell) throw new Error('EchoPilot shell is not ready yet');
  return shell;
}
const rendererRoot = resolve(__dirname, '../renderer');
const fixtureJournalPath = resolve(__dirname, '../../fixtures/bootstrap/session.jsonl');
let secretHelperBridge: NativeHelperBridge | null = null;
let securityKernel: SecurityKernel | null = null;
/** The native helper is spawned with stdio pipes only: it is reachable from this parent process and nowhere else. */
function resolveSecretHelperPath(): string {
  const candidates = [
    resolve(__dirname, '../../../native/macos/.build/release/echopilot-secrets'),
    resolve(process.cwd(), 'native/macos/.build/release/echopilot-secrets'),
    resolve(process.cwd(), 'native/macos/.build/debug/echopilot-secrets'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0] ?? 'echopilot-secrets';
}
function getSecurityKernel(): SecurityKernel {
  if (securityKernel) return securityKernel;
  secretHelperBridge = createNativeHelperBridge({ helperPath: resolveSecretHelperPath() });
  securityKernel = createSecurityKernel({
    // Native capabilities are registered through the private parent channel; the helper advertises
    // keychain.* and capture.screen at handshake, and secrets travel on stdin rather than argv.
    secrets: createKeychainSecretStore(secretHelperBridge),
    storage: createFileKernelStorage(join(app.getPath('userData'), 'security', 'kernel-state.json')),
    capture: createNativeCaptureOperation(secretHelperBridge),
    // Local-only and Project Partner scopes are the default: egress stays unreachable until an endpoint is configured.
    provider: createDisabledProvider(),
  });
  return securityKernel;
}
function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  return [widget, dashboard].some(window => window?.webContents === event.sender)
    && event.senderFrame === event.sender.mainFrame
    && !!event.senderFrame?.url.startsWith('echo://app/index.html?view=');
}
function publish() {
  const state = coordinator.getState();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('echo:state', state);
  // The tray renders the same coordinator-derived snapshot as the widget, so a coordinator-only
  // change (the widget's Mute button) has to re-read it here.
  tray?.refresh();
  return state;
}
/**
 * The one status snapshot behind both the widget panel and the tray menu. Target session prefers
 * the signed helper's reported session and falls back to the latest coordinator event.
 */
function widgetStatus(): WidgetSnapshot {
  const state = coordinator.getState();
  // The signed helper reports *permission*; the coordinator owns the live mute state. Deriving the
  // mute affordance from that one flag keeps the widget, the tray item, and the real session in
  // step no matter which control was used last.
  return widgetStatusSnapshot(requireShell().status(), {
    muted: state.muted,
    sessionId: state.event?.sessionId ?? null,
  });
}
function shellSnapshot() {
  const state = coordinator.getState();
  return {
    status: widgetStatus(),
    hotkeys: {
      registered: requireShell().hotkeys.registered.map(hotkey => hotkey.accelerator),
      conflicts: requireShell().hotkeys.conflicts.map(conflict => ({
        action: conflict.action,
        accelerator: conflict.accelerator,
        reason: conflict.reason,
      })),
    },
    controls: WIDGET_FALLBACK_CONTROLS,
    coordinator: { muted: state.muted, eventId: state.event?.id ?? null },
  };
}
function openWidget() {
  // Survives Mission Control closure, Cmd-W, and Space changes: a live window is re-revealed
  // without activation, a closed/destroyed one is recreated.
  if (widget && widgetWindowAction(widget) === 'reveal') { revealWidgetWindow(widget); return; }
  widget = createWindow('widget');
  widget.on('closed', () => { widget = null; });
}
function toggleWidget() {
  if (widget && !widget.isDestroyed() && widget.isVisible()) widget.hide();
  else openWidget();
}
function createWindow(view: 'widget' | 'dashboard') {
  const isWidget = view === 'widget';
  const window = new BrowserWindow({
    width:isWidget ? 390 : 1040, height:isWidget ? 420 : 780, minWidth:isWidget ? 360 : 760,
    minHeight:isWidget ? 360 : 600, show:false,
    // Foreground-safe widget options live in `window-policy.ts` so the focus/Space matrix is
    // covered by a deterministic test instead of only by the manual signed-app run.
    ...windowBehavior(view),
    title:isWidget ? 'EchoPilot' : 'EchoPilot · Mission Control', backgroundColor:'#10171d',
    webPreferences:{preload:resolve(__dirname,'../preload/index.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false},
  });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  if (isWidget) applyForegroundSafeWindowBehavior(window);
  window.once('ready-to-show', () => {
    if (smoke) return;
    if (isWidget) revealWidgetWindow(window);
    else window.show();
  });
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
    events = parseJournal(await readFile(fixtureJournalPath, 'utf8'));
    await writeFile(`${path}.tmp`, serializeJournal(events),{mode:0o600});
    await rename(`${path}.tmp`,path);
  }
  for (const event of events) coordinator.ingest(event);
}
async function ready() {
  shell = createShell({
    token: helperToken,
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    onRecoverable: reason => { console.warn(`EchoPilot recoverable: ${reason}`); },
    onAction: action => {
      switch (action) {
        // Mute and stop arrive from hotkeys, the tray, and the widget; drive the real coordinator
        // so the session state — not just the widget chrome — is what the user sees change.
        case 'mute-microphone': coordinator.setMuted(!coordinator.getState().muted); publish(); break;
        case 'replay': coordinator.replay(); publish(); break;
        case 'toggle-conversation': toggleWidget(); break;
        case 'open-mission-control': openDashboard(); break;
        case 'hold-dictation': console.info('EchoPilot: dictation hold is not wired to capture yet.'); break;
        default: break;
      }
    },
  });
  nativeHost = createNativeHost({
    shell,
    token: helperToken,
    log: message => { console.info(`EchoPilot native host: ${message}`); },
  });
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('echo', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response(null,{status:403});
    // Renderers may only talk to their own origin; the preload is frozen in F02, so the widget
    // control plane is a same-origin route instead of a new IPC channel.
    const site = request.headers.get('sec-fetch-site');
    // 'none' is the top-level document load; same-origin fetches cover the widget control plane.
    if (site && site !== 'same-origin' && site !== 'none') return new Response(null,{status:403});
    const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Content-Security-Policy':policy}});
    const name = decodeURIComponent(url.pathname).replace(/^\//,'');
    if (name === 'shell-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json(shellSnapshot());
    }
    if (name === 'shell-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return new Response(null,{status:400});
      const control = (body as {control?: unknown}).control;
      if (Object.keys(body).length !== 1 || (control !== 'mute' && control !== 'stop')) return new Response(null,{status:400});
      requireShell().activate(control);
      return json(shellSnapshot());
    }
    if (request.method !== 'GET') return new Response(null,{status:403});
    if (name !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(name)) return new Response(null,{status:404});
    try {
      const data = await readFile(join(rendererRoot,name));
      const mime = extname(name) === '.js' ? 'text/javascript' : extname(name) === '.css' ? 'text/css' : 'text/html';
      return new Response(data,{headers:{'Content-Type':mime,'Content-Security-Policy':policy}});
    } catch { return new Response(null,{status:404}); }
  });
  await bootstrapJournal();
  ipcMain.handle('echo:command', (event, payload: unknown) => {
    if (![widget,dashboard].some(window => window?.webContents === event.sender) || event.senderFrame !== event.sender.mainFrame || !event.senderFrame?.url.startsWith('echo://app/index.html?view=')) throw new Error('Untrusted IPC sender');
    if (typeof payload === 'object' && payload !== null && ('secret' in payload || 'apiKey' in payload)) throw new Error('Secrets must be submitted over the dedicated key-entry channel');
    const command = parseCommand(payload);
    switch(command.type) {
      case 'get-state': return coordinator.getState();
      case 'set-muted': coordinator.setMuted(command.muted); break;
      case 'replay': coordinator.replay(); break;
      case 'open-dashboard': openDashboard(); break;
    }
    return publish();
  });
  // Dedicated key-entry channel: the key is validated, stored in the Keychain through the native
  // helper, and the renderer gets a redacted reference back. It is never logged or echoed.
  ipcMain.handle(KEY_ENTRY_CHANNEL, async (event, payload: unknown) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted IPC sender');
    const request = parseKeyEntryRequest(payload);
    return parseKeyEntryResult(await getSecurityKernel().submitProviderKey(request), request.secret);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'EchoPilot',submenu:[{label:'Mission Control',click:openDashboard},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
  widget = createWindow('widget');
  widget.on('closed', () => { widget = null; });
  tray = createShellTray({shell:requireShell(),status:widgetStatus,onShowWidget:openWidget,onOpenDashboard:openDashboard,onQuit:() => app.quit()});
  nativeHost?.start();
  // Closing the widget (Mission Control, Cmd-W, a Space change) must keep the session reachable
  // through the menu bar instead of ending the app.
  app.on('window-all-closed', () => { if (shouldQuitWhenAllWindowsClosed()) app.quit(); });
  app.on('will-quit', () => { nativeHost?.dispose(); tray?.dispose(); tray = null; globalShortcut.unregisterAll(); });
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
app.on('will-quit', () => { secretHelperBridge?.dispose(); secretHelperBridge = null; securityKernel = null; });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',openDashboard);
  void app.whenReady().then(ready).catch(error => {console.error('EchoPilot startup failed:',error);app.exit(1);});
}
