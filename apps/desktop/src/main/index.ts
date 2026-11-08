import {configureEdgeWindow} from './native-window';
import { createDesktopExperience } from './desktop-experience';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, protocol, session, Menu, screen, shell as externalShell, type IpcMainInvokeEvent } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { createVoiceActivationService, type VoiceActivationService, type VoiceStatus } from './voice-activation';
import { createShellTray, type ShellTray } from './tray';
import { createProductRuntime, type ProductRuntime } from './product-runtime';
import { createManagedWork, type ManagedWork } from './managed-work';
import { createVoiceRouting } from './voice-routing';
import { createVoiceCaptureScope } from './voice-capture-scope';
import { createDesktopDictationService } from './desktop-dictation';
import { createHistoryImportService } from './history-import';
import { createManagedAttachments } from './managed-attachments';
import { createGazeHost } from './gaze-host';
import { createWebGazerHost } from './webgazer-host';
import { createProjectAssociations } from './project-associations';
import { createMemoryRecordsHost, describeMemoryRecords } from './memory-records-host';
import { createCompanionAnswers } from './companion-answers';
import { createStructuredContext } from './structured-context';
import { createProcessPrivacyScope } from './privacy-scope';
import { createDesktopActions } from './desktop-actions';
import { createScopedCommands } from './scoped-commands';
import { createDesktopObserveHost, desktopObserveDiagnostics, type DesktopObserveHost } from './desktop-observe';
import { createDesktopAnswerService, desktopAnswerErrorStatus, type DesktopAnswerService } from './desktop-answer';
import { createSystemNarration, type SystemNarration, type SystemSpeech } from './system-narration';
import { createDictationCapture, createDictationScreenContext } from './dictation-capture';
import { createCompanionSession } from './companion-session';
import { createDialogueMemory } from './dialogue-memory';
import { createDictationContextService, resolveScopedVoiceTranscript, type RetainedVoiceTranscript } from './dictation-context';
import type { AttentionPreset } from '../../../../packages/attention/src/index';
import { createOpenAITextProvider, type OpenAITextProvider, type TextModel } from '../../../../packages/providers/src/openai-text/index';
import { answerProjectFromEvidence } from './project-answer';
import { createProfilePrivacyHost, type ProfilePrivacyHost } from '../renderer/control/privacy/profile-host';
import { exportProfile, importProfile } from '../../../../packages/security/src/privacy/index';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';
import {
  KEY_ENTRY_CHANNEL,
  createFileKernelStorage,
  createKeychainSecretStore,
  createNativeCaptureOperation,
  createNativeHelperBridge,
  createSecurityKernel,
  parseKeyEntryRequest,
  parseKeyEntryResult,
  resolveNativeHelperPath,
  type NativeHelperBridge,
  type SecurityKernel,
} from '../../../../packages/security/src/index';

protocol.registerSchemesAsPrivileged([{scheme:'echo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const smoke = process.argv.includes('--smoke');
const voiceSmoke = process.argv.includes('--voice-smoke');
const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
if (profileArg) app.setPath('userData', resolve(profileArg.slice('--profile='.length)));
app.setName('EchoPilot');
const coordinator = createCoordinator();
/** Per-launch secret the signed native helper must echo in every message it sends. */
const helperToken = randomUUID();
// globalShortcut is only usable after `app.whenReady()`, so the shell is created inside ready().
let shell: Shell | undefined;
let experience: ReturnType<typeof createDesktopExperience> | undefined;
let widget: BrowserWindow | null = null;
let dashboard: BrowserWindow | null = null;
let tray: ShellTray | null = null;
let nativeHost: NativeHost | undefined;
/** The production V05 lifecycle: enable once, then hands-free until idle/standby teardown. */
let voice: VoiceActivationService | undefined;
let latestVoiceTranscript: RetainedVoiceTranscript | null = null;
let microphoneMuted = false;
let resumeConversationAfterUnmute = false;
let product: ProductRuntime | undefined;
let managedWork: ManagedWork | undefined;
let voiceRouting: ReturnType<typeof createVoiceRouting> | undefined;
let companionAnswers: ReturnType<typeof createCompanionAnswers> | undefined;
let structuredContext: ReturnType<typeof createStructuredContext> | undefined;
let desktopDictation: ReturnType<typeof createDesktopDictationService> | undefined;
let historyImport: ReturnType<typeof createHistoryImportService> | undefined;
let attachments: ReturnType<typeof createManagedAttachments> | undefined;
let gazeHost: ReturnType<typeof createGazeHost> | undefined;
let projects: Awaited<ReturnType<typeof createProjectAssociations>> | undefined;
let memoryRecords: ReturnType<typeof createMemoryRecordsHost> | undefined;
let desktopActions: ReturnType<typeof createDesktopActions> | undefined;
let scopedCommands: ReturnType<typeof createScopedCommands> | undefined;
let desktopObserveHost: DesktopObserveHost | undefined;
let desktopAnswerService: DesktopAnswerService | undefined;
/** Single-flight guard: one user-initiated observation at a time, never overlapping helpers. */
let desktopObservationRunning = false;
let narration: SystemNarration | undefined;
let speechGeneration = 0;
let dictationCapture: ReturnType<typeof createDictationCapture> | undefined;
let dictationContext: ReturnType<typeof createDictationContextService> | undefined;
let dictationScreenContext: ReturnType<typeof createDictationScreenContext> | undefined;
let companionSession: ReturnType<typeof createCompanionSession> | undefined;
let profileMemory: Promise<ProfilePrivacyHost> | undefined;
const processPrivacy = createProcessPrivacyScope();
const voiceCaptureScope = createVoiceCaptureScope();

function getProfileMemory(): Promise<ProfilePrivacyHost> {
  if (profileMemory) return profileMemory;
  profileMemory = (async () => {
    let key: string;
    if (smoke) {
      // The disposable two-launch smoke profile needs a stable key without touching the user's
      // Keychain. Production profiles always take the native Keychain path below.
      key = createHash('sha256').update(`smoke:${app.getPath('userData')}`).digest('hex');
    } else {
      getSecurityKernel();
      if (!secretHelperBridge) throw new Error('The native Keychain helper is unavailable.');
      const secrets = createKeychainSecretStore(secretHelperBridge, { service: 'com.echopilot.memory' });
      const account = `local-${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 24)}`;
      const stored = await secrets.get(account);
      key = stored ?? randomBytes(32).toString('hex');
      if (stored === null) await secrets.put(account, key);
    }
    const host = await createProfilePrivacyHost({
      directory: join(app.getPath('userData'), 'memory', 'local'),
      key,
      profileId: 'local',
      archivePath: join(app.getPath('userData'), 'exports', 'profile.echopilot'),
      restoreDirectory: join(app.getPath('userData'), 'restores', randomUUID()),
    });
    processPrivacy.bind(host.store);
    return host;
  })().catch((error) => { profileMemory = undefined; throw error; });
  return profileMemory;
}

async function rememberManagedEvent(event: EventEnvelope, payload: Record<string, unknown>): Promise<void> {
  const privateSessionId = processPrivacy.capture();
  const generation = processPrivacy.generation();
  const profile = await getProfileMemory();
  await profile.store.ingest({ events: [event], payloads: { [event.payloadRef]: payload } }, { privateSessionId });
  if (generation !== processPrivacy.generation()) return;
  narration?.ingest(event, payload);
  if (event.kind === 'agent_message' && typeof payload.text === 'string' && payload.text.trim()) {
    coordinator.ingest({
      id: event.eventId,
      sessionId: event.scope.sessionId ?? 'managed-codex',
      text: payload.text.slice(0, 8_192),
      createdAt: event.observedAt,
    });
    publish();
  }
}
function requireShell(): Shell {
  if (!shell) throw new Error('EchoPilot shell is not ready yet');
  return shell;
}
function companionSessionStatus() {
  return companionSession?.status() ?? { enabled: false, projectId: null, expiresAt: null, remainingRequests: 0 };
}
async function observeAssociatedContext(projectId: string) {
  if (projects?.current()?.projectId !== projectId) throw Error('Choose this associated project first.');
  if (desktopObservationRunning) throw Error('A desktop observation is already running.');
  const privacy = processPrivacy.generation();
  desktopObservationRunning = true;
  try {
    const result = await getDesktopObserveHost().observe({ projectId });
    if (privacy !== processPrivacy.generation() || projects?.current()?.projectId !== projectId) throw Error('The project or privacy scope changed.');
    return result;
  } finally { desktopObservationRunning = false; }
}
async function boundedJsonBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw Error('Invalid JSON request.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32_768) { await reader.cancel(); throw new RangeError('Request exceeds its 32,768-byte bound.'); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
function selectedWorkProject(): { projectId: string; cwd: string; label: string } | null {
  const id = voiceRouting?.snapshot().sessionId;
  const selected = managedWork?.list().find(item => item.id === id && item.active);
  return selected ? { projectId: selected.projectId, cwd: selected.cwd, label: selected.label } : projects?.current() ?? null;
}
const rendererRoot = resolve(__dirname, '../renderer');
const fixtureJournalPath = resolve(__dirname, '../../fixtures/bootstrap/session.jsonl');
let secretHelperBridge: NativeHelperBridge | null = null;
let securityKernel: SecurityKernel | null = null;
let textProvider: OpenAITextProvider | null = null;
/**
 * The native helper is spawned with stdio pipes only: it is reachable from this parent process and
 * nowhere else. Candidates come from the running bundle (`dist/main`), so the lookup works from any
 * launch directory and can never pick up a stray binary from the process working directory.
 */
function resolveSecretHelperPath(): string {
  return resolveNativeHelperPath({ bundleDir: __dirname });
}
function getSecurityKernel(): SecurityKernel {
  if (securityKernel) return securityKernel;
  secretHelperBridge = createNativeHelperBridge({ helperPath: resolveSecretHelperPath() });
  const secrets = createKeychainSecretStore(secretHelperBridge);
  textProvider = createOpenAITextProvider({
    secrets,
    model: () => (product?.settings().find((setting) => setting.key === 'providers.textModel')?.value ?? 'gpt-6-sol') as TextModel,
  });
  securityKernel = createSecurityKernel({
    // Native capabilities are registered through the private parent channel; the helper advertises
    // keychain.* and capture.screen at handshake, and secrets travel on stdin rather than argv.
    secrets,
    storage: createFileKernelStorage(join(app.getPath('userData'), 'security', 'kernel-state.json')),
    capture: createNativeCaptureOperation(secretHelperBridge),
    // Each project question must receive a one-time provider grant before this adapter is invoked.
    provider: textProvider,
  });
  return securityKernel;
}
/**
 * The desktop observation host spawns the packaged, signed helper for one user-initiated request
 * and strictly parses its answer. The helper path is resolved from the main bundle directory, so a
 * binary next to the process working directory can never be picked up.
 */
function getDesktopObserveHost(): DesktopObserveHost {
  if (!desktopObserveHost) desktopObserveHost = createDesktopObserveHost({ bundleDir: __dirname });
  return desktopObserveHost;
}
/**
 * The grounded desktop-answer seam resolves its kernel and provider lazily: observing, previewing,
 * and canceling must never create a grant, read a key, or reach the network. Only the confirmed
 * step touches the kernel, and only for the one request it just enqueued.
 */
function getDesktopAnswer(): DesktopAnswerService {
  if (!desktopAnswerService) {
    desktopAnswerService = createDesktopAnswerService({
      kernel: () => getSecurityKernel(),
      provider: () => { if (!textProvider) getSecurityKernel(); return textProvider; },
      isProjectActive: (projectId) => selectedWorkProject()?.projectId === projectId,
    });
  }
  return desktopAnswerService;
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
function sendSystemSpeech(plan: SystemSpeech): void {
  
  const target = dashboard && !dashboard.isDestroyed() && dashboard.isVisible()
    ? dashboard : widget && !widget.isDestroyed() ? widget : null;
  silenceSystemSpeech();
  target?.webContents.send('echo:system-speech', plan);
}
function silenceSystemSpeech(): void {
  speechGeneration++;
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('echo:stop-speech');
}
function clearScopedAuthority(): void {
  processPrivacy.invalidate();
  latestVoiceTranscript = null;
  experience?.cancel();
  dictationScreenContext?.clear();
  companionSession?.disable();
  void dictationCapture?.cancel();
  dictationContext?.clear();
  
  textProvider?.cancelAll?.();
  securityKernel?.clearProviderRequests();
  narration?.stop();
  voiceRouting?.configure(null, false);
  companionAnswers?.clear();
  structuredContext?.clear();
  memoryRecords?.clear();
  historyImport?.clear();
  desktopDictation?.clear();
  desktopActions?.clear();
  scopedCommands?.clear();
  desktopAnswerService?.clear();
}
function clearPrivacyViews(): void {
  
  clearScopedAuthority();
  managedWork?.clearContent();
  attachments?.clearContent();
  latestVoiceTranscript = null;
  coordinator.clearEvent();
  publish();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('echo:privacy-cleared');
}
function syncNarrationSettings(): void {
  const effective = product?.settings() ?? [];
  const preset = effective.find((setting) => setting.key === 'attention.preset')?.value;
  if (preset) narration?.setPreset(preset as AttentionPreset);
  if (effective.find((setting) => setting.key === 'voice.systemNarration')?.value !== 'on') narration?.stop();
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
    muted: microphoneMuted,
    sessionId: state.event?.sessionId ?? null,
  });
}
/**
 * The widget-facing voice state. The renderer receives the lifecycle snapshot plus the measured
 * gates — never a host handle, and never a wake candidate that could be mistaken for an approval.
 */
function voiceStatusPayload(): { voice: VoiceStatus['voice']; standbyEnergy: VoiceStatus['standbyEnergy'] | null; wake: VoiceStatus['wake'] | null; worker: string } {
  if (!voice) {
    return {
      voice: { ...requireShell().voiceSnapshot(), standbyEnabled: false },
      standbyEnergy: null,
      wake: null,
      worker: 'starting',
    };
  }
  const status = voice.status();
  return {
    voice: status.voice,
    standbyEnergy: { ...status.standbyEnergy, violations: [...status.standbyEnergy.violations] },
    wake: status.wake,
    worker: status.worker,
  };
}
function shellSnapshot() {
  const state = coordinator.getState();
  return {
    status: widgetStatus(),
    dictationCapture: dictationCapture?.status() ?? null,
    voice: requireShell().voiceSnapshot(),
    hotkeys: {
      registered: requireShell().hotkeys.registered.map(hotkey => hotkey.accelerator),
      conflicts: requireShell().hotkeys.conflicts.map(conflict => ({
        action: conflict.action,
        accelerator: conflict.accelerator,
        reason: conflict.reason,
      })),
    },
    controls: WIDGET_FALLBACK_CONTROLS,
    coordinator: { muted: microphoneMuted, eventId: state.event?.id ?? null },
  };
}
/**
 * Drives the same lifecycle the widget's Enable/Disable control uses. Option-Space is therefore an
 * alternative to the UI rather than a second, divergent code path.
 */
function toggleConversation(): void {
  if (!voice) { requireShell().invoke('open-mission-control'); return; }
  if (microphoneMuted) return;
  const enabled = requireShell().voiceSnapshot().enabled;
  if (enabled) voiceRouting?.configure(voiceRouting.snapshot().sessionId, false);
  void (enabled ? voice.disable() : voice.enable()).catch(error => {
    console.warn(`EchoPilot voice lifecycle: ${error instanceof Error ? error.message : String(error)}`);
  });
}
function openWidget() {
  // Survives Mission Control closure, Cmd-W, and Space changes: a live window is re-revealed
  // without activation, a closed/destroyed one is recreated.
  if (widget && widgetWindowAction(widget) === 'reveal') { revealWidgetWindow(widget); configureEdgeWindow(widget,app.getAppPath()); return; }
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
    width:isWidget ? 440 : 1060, height:isWidget ? 100 : 760, minWidth:isWidget ? 440 : 800,
    minHeight:isWidget ? 80 : 600, show:false,
    ...(isWidget ? {frame:false,transparent:true,hasShadow:false,resizable:false,enableLargerThanScreen:true,type:'panel' as const,fullscreenable:false} : {titleBarStyle:'hiddenInset' as const}),
    // Foreground-safe widget options live in `window-policy.ts` so the focus/Space matrix is
    // covered by a deterministic test instead of only by the manual signed-app run.
    ...windowBehavior(view),
    title:'EchoPilot', backgroundColor:isWidget ? '#00000000' : '#f7f6f3',
    webPreferences:{preload:resolve(__dirname,'../preload/index.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,autoplayPolicy:'no-user-gesture-required'},
  });
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  if(isWidget){configureEdgeWindow(window,app.getAppPath());window.setIgnoreMouseEvents(true,{forward:true});}
  if(isWidget)window.webContents.on('render-process-gone',()=>experience?.cancel());
  if (isWidget) applyForegroundSafeWindowBehavior(window);
  window.once('ready-to-show', () => {
    if (smoke || voiceSmoke) return;
    if (!isWidget) window.show();
  });
  void window.loadURL(`echo://app/index.html?view=${view}`);
  return window;
}
function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) { if (!smoke) dashboard.show(); return; }
  dashboard = createWindow('dashboard');
  dashboard.on('closed', () => { dashboard = null; });
}
function openSettings(){
  openDashboard();const window=dashboard;if(!window||window.isDestroyed())return;
  const navigate=()=>{if(!window.isDestroyed())window.webContents.send('echo:navigate','general');};
  if(window.webContents.isLoading())window.webContents.once('did-finish-load',navigate);else navigate();
}
async function bootstrapJournal() {
  // The checked-in event is useful for smoke tests, but must never masquerade as live activity.
  if (!smoke && process.env.ECHOPILOT_DEMO !== '1') return;
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
  projects = await createProjectAssociations(join(app.getPath('userData'), 'project-associations.json'));
  product = createProductRuntime(app.getPath('userData'), app.getAppPath());
  narration = createSystemNarration({
    enabled: () => product?.settings().find((setting) => setting.key === 'voice.systemNarration')?.value === 'on',
    verbosity: () => product?.settings().find((setting) => setting.key === 'verbosity.level')?.value ?? 'balanced',
    persona: () => product?.settings().find((setting) => setting.key === 'persona.preset')?.value ?? 'balanced-partner',
    speak: sendSystemSpeech,
    silence: silenceSystemSpeech,
  });
  syncNarrationSettings();
  managedWork = createManagedWork(app.getPath('userData'), 'codex', rememberManagedEvent);
  companionSession = createCompanionSession({ projectId: () => projects?.current()?.projectId ?? null,
    privateActive: () => processPrivacy.capture() !== null, muted: () => coordinator.getState().muted || microphoneMuted,
    revoke: () => { companionAnswers?.clear(); narration?.stop(); silenceSystemSpeech(); } });
  const dialogueMemory = createDialogueMemory({ projectId: () => projects?.current()?.projectId ?? null, privateSessionId: processPrivacy.capture, privacyGeneration: processPrivacy.generation, store: async () => (await getProfileMemory()).store });
  companionAnswers = createCompanionAnswers({
    observeContext: async projectId => { const result = await observeAssociatedContext(projectId); return result.outcome === 'observed' ? result.evidence : null; },
    recentDialogue: dialogueMemory.recent,
    persistDialogue: dialogueMemory.persist,
    activeProjectId: () => projects?.current()?.projectId ?? null,
    privacyGeneration: processPrivacy.generation,
    model: () => (product?.settings().find(setting => setting.key === 'providers.textModel')?.value ?? 'gpt-6-sol') as TextModel,
    timeline: async projectId => describeMemoryRecords(await (await getProfileMemory()).store.timeline({ projectId })),
    provider: async () => { const kernel = getSecurityKernel(); await kernel.ready(); if (!textProvider) throw Error('The OpenAI text provider is unavailable.'); return { kernel, provider: textProvider }; },
    outputMuted: () => coordinator.getState().muted,
    speechGeneration: () => speechGeneration,
    onAnswer: (answer, speak) => {
      coordinator.ingest({ id: answer.id, sessionId: `companion:${answer.projectId}`, text: answer.text, createdAt: new Date().toISOString() });
      publish();
      if (speak) sendSystemSpeech({ id: `companion-answer:${answer.id}`, eventId: answer.id, text: answer.text.replace(/\[\d+(?:,\s*\d+)*\]/g, '').slice(0, 500) });
    },
  });
  structuredContext = createStructuredContext({ activeProject: () => projects?.current() ?? null });
  voiceRouting = createVoiceRouting({
    work: managedWork,
    companion: companionAnswers,
    autoAnswerAllowed: projectId => companionSession?.allowed(projectId) === true,
    consumeAutoAnswer: projectId => companionSession?.consume(projectId) === true,
    stopSpeech: () => { narration?.stop(); silenceSystemSpeech(); },
    stopListening: async () => { companionSession?.disable(); void dictationCapture?.cancel(); dictationContext?.clear(); microphoneMuted = true; resumeConversationAfterUnmute = false; await voice?.disable(); tray?.refresh(); },
  });
  desktopDictation = createDesktopDictationService({
    bundleDir: __dirname,
    glossaryDirectory: join(app.getPath('userData'), 'dictation'),
    isPrivate: () => processPrivacy.capture() !== null,
    activeProjectId: () => {
      return projects?.current()?.projectId ?? null;
    },
  });
  dictationScreenContext = createDictationScreenContext({ projectId: () => projects?.current()?.projectId ?? null,
    privacyGeneration: processPrivacy.generation, privateActive: () => processPrivacy.capture() !== null,
    observe: observeAssociatedContext });
  dictationContext = createDictationContextService({
    activeProjectId: () => projects?.current()?.projectId ?? null,
    privacyGeneration: processPrivacy.generation,
    model: () => (product?.settings().find(setting => setting.key === 'providers.textModel')?.value ?? 'gpt-6-sol') as TextModel,
    timeline: async projectId => (await (await getProfileMemory()).store.timeline({ projectId })).slice(-1_000),
    observeContext: async projectId => {
      const captured = dictationScreenContext?.get(projectId);
      return captured ? { outcome: 'observed' as const, evidence: captured } : observeAssociatedContext(projectId);
    },
    provider: () => { const kernel = getSecurityKernel(); return textProvider ? { kernel, provider: textProvider } : null; },
  });
  dictationCapture = createDictationCapture({
    projectId: () => projects?.current()?.projectId ?? null, privateActive: () => processPrivacy.capture() !== null,
    muted: () => microphoneMuted || coordinator.getState().muted, privacyGeneration: processPrivacy.generation,
    conversationEnabled: () => voice?.status().voice.enabled === true,
    enable: async () => { if (!voice) throw Error('Voice is unavailable.'); await voice.enable(); },
    disable: async () => { await voice?.disable(); },
    prepare: async (projectId, text) => {
      const privacy = processPrivacy.generation();
      const result = await desktopDictation!.handle({ command: 'prepare-draft', projectId, text });
      if (!result.ok) throw Error(result.error ?? 'Dictation draft unavailable.');
      if (privacy !== processPrivacy.generation() || projects?.current()?.projectId !== projectId || processPrivacy.capture() !== null) throw Error('The project or privacy scope changed.');
      const utteranceId = `dictation-draft-${randomUUID()}`; const observedAt = new Date().toISOString();
      latestVoiceTranscript = { phase: 'final', text, observedAt, projectId, privacy, privateActive: false };
      // The shared coordinator display contract is capped at 8,192 characters. The insertion draft retains all captured bytes.
      coordinator.ingest({ id: utteranceId, sessionId: 'local-voice', text: text.slice(0, 8_192), createdAt: observedAt });
      publish();
    },
    discardDraft: () => { desktopDictation?.clear(); dictationScreenContext?.clear(); },
    captureContext: projectId => { void dictationScreenContext?.capture(projectId); },
    changed: () => { publish(); },
  });
  historyImport = createHistoryImportService({ directory: join(app.getPath('userData'), 'history-import'), activeProjectId: () => selectedWorkProject()?.projectId ?? null, privateSessionId: processPrivacy.capture, store: async () => (await getProfileMemory()).store });
  attachments = createManagedAttachments({ directory: join(app.getPath('userData'), 'managed-claude'), activeProject: selectedWorkProject, isPrivate: () => processPrivacy.capture() !== null, onEvent: rememberManagedEvent });
  memoryRecords = createMemoryRecordsHost({ activeProjectId: () => selectedWorkProject()?.projectId ?? null, privateSessionId: processPrivacy.capture, store: async () => (await getProfileMemory()).store });
  desktopActions = createDesktopActions({ bundleDir: __dirname, activeProjectId: () => selectedWorkProject()?.projectId ?? null });
  scopedCommands = createScopedCommands({ activeProject: selectedWorkProject });
  gazeHost = createWebGazerHost({ bundleDir: __dirname, activeProjectId: () => 'desktop', displays: () => {
    const all = screen.getAllDisplays();
    const arrangementGeneration = Number.parseInt(createHash('sha256').update(JSON.stringify(all.map(d => [d.id, d.bounds, d.scaleFactor]))).digest('hex').slice(0, 8), 16);
    return all.map(d => ({ displayId: String(d.id), label: d.internal ? 'Built-in display' : d.label || 'External display', internal: d.internal, originX: d.bounds.x, originY: d.bounds.y, width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor, arrangementGeneration }));
  } });
  experience = createDesktopExperience({bundleDir:__dirname, gaze:gazeHost,
    secrets:{get:async provider => {getSecurityKernel();return createKeychainSecretStore(secretHelperBridge!).get(provider);}},
    setting:key => product?.settings().find(s=>s.key===key)?.value ?? '',
    allowed:()=>processPrivacy.capture()===null && !microphoneMuted && !coordinator.getState().muted,
    trusted:isTrustedRenderer, widget:()=>widget, reveal:openWidget});
  shell = createShell({
    token: helperToken,
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    onRecoverable: reason => { console.warn(`EchoPilot recoverable: ${reason}`); },
    // Voice commands travel on the helper's private stdin; the shell owns id allocation and the
    // authenticated ack correlation, so `index.ts` never hand-rolls a protocol frame.
    writeToHelper: line => nativeHost?.send(line) === true,
    onAction: action => {
      switch (action) {
        // Mute and stop arrive from hotkeys, the tray, and the widget; drive the real coordinator
        // so the session state — not just the widget chrome — is what the user sees change.
        case 'mute-microphone': {
          experience?.cancel();
          microphoneMuted = !microphoneMuted;
          if (microphoneMuted) {
            companionSession?.disable(); void dictationCapture?.cancel(); dictationContext?.clear(); desktopDictation?.clear();
            voiceRouting?.configure(voiceRouting.snapshot().sessionId, false);
            resumeConversationAfterUnmute = voice?.status().voice.enabled === true;
            void voice?.disable().catch((error) => console.warn(`EchoPilot microphone stop: ${String(error)}`));
          } else if (resumeConversationAfterUnmute) {
            resumeConversationAfterUnmute = false;
            void voice?.enable().catch((error) => console.warn(`EchoPilot microphone restart: ${String(error)}`));
          }
          tray?.refresh();
          break;
        }
        case 'replay': coordinator.replay(); publish(); break;
        case 'stop-speech': experience?.cancel(); narration?.stop(); silenceSystemSpeech(); break;
        // One explicit enable is what the user does; after that the session is hands-free, so this
        // shortcut toggles the lifecycle itself rather than any window chrome.
        case 'toggle-conversation': experience?.toggle('agent'); break;
        case 'open-mission-control': openDashboard(); break;
        case 'hold-dictation': experience?.toggle('dictation'); break;
        default: break;
      }
    },
  });
  nativeHost = createNativeHost({
    shell,
    token: helperToken,
    log: message => { console.info(`EchoPilot native host: ${message}`); },
  });
  voice = createVoiceActivationService({
    shell,
    telemetryPath: join(app.getPath('userData'), 'voice', 'activation.jsonl'),
    env: {
      ...process.env,
      ...(process.env.ECHOPILOT_ASR_MODEL_DIR || !existsSync(resolve(app.getAppPath(), 'models/asr/small.en'))
        ? {}
        : { ECHOPILOT_ASR_MODEL_DIR: resolve(app.getAppPath(), 'models/asr') }),
      ...(!app.isPackaged && !process.env.ECHOPILOT_SILERO_MODEL_DIR
        && !existsSync(resolve(app.getAppPath(), 'models/asr/silero_vad.mlmodelc'))
        ? { ECHOPILOT_VAD_FALLBACK: 'energy' }
        : {}),
    },
    log: message => { console.info(`EchoPilot voice: ${message}`); },
  });
  voice.worker.onTranscript((update) => {
    const privacy = processPrivacy.generation();
    if (!voiceCaptureScope.accept(update.utteranceId, privacy)) return;
    if (dictationCapture?.transcript(update)) return;
    latestVoiceTranscript = { phase: update.phase, text: update.text, observedAt: new Date().toISOString(), projectId: projects?.current()?.projectId ?? null, privacy, privateActive: processPrivacy.capture() !== null };
    if (update.phase === 'partial') narration?.userSpeechStarted();
    else narration?.userSpeechEnded();
    if (update.phase === 'final' && update.text.trim()) {
      void voiceRouting?.transcript(update).catch(error => console.warn(`EchoPilot voice routing: ${error instanceof Error ? error.message : 'failed'}`));
      coordinator.ingest({
        id: update.utteranceId,
        sessionId: 'local-voice',
        text: update.text,
        createdAt: latestVoiceTranscript.observedAt,
      });
      publish();
    }
  });
  // Every authenticated helper frame is already parsed by the shell; energy samples and acoustic
  // windows are the lifecycle's observation inputs.
  voice.attachNativeHost(nativeHost);
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details) => {
    const types='mediaTypes' in details?details.mediaTypes:undefined;
    const sameOrigin=contents?.getURL().startsWith('echo://app/index.html?view=')===true;
    callback(permission==='media'&&sameOrigin&&Array.isArray(types)&&types.length>0&&(
      contents===widget?.webContents&&experience!==undefined&&types.every(type=>type==='audio')||
      contents!==null&&experience?.overlay.owns(contents)===true&&types.every(type=>type==='video')));
  });
  session.defaultSession.setPermissionCheckHandler((contents,permission,origin,details) => permission==='media'&&origin.startsWith('echo://app')&&(
    contents===widget?.webContents&&details.mediaType==='audio'||contents!==null&&experience?.overlay.owns(contents)===true&&details.mediaType==='video'));
  protocol.handle('echo', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response(null,{status:403});
    // Renderers may only talk to their own origin; the preload is frozen in F02, so the widget
    // control plane is a same-origin route instead of a new IPC channel.
    const site = request.headers.get('sec-fetch-site');
    // 'none' is the top-level document load; same-origin fetches cover the widget control plane.
    if (site && site !== 'same-origin' && site !== 'none') return new Response(null,{status:403});
    const gazeDocument=url.pathname==='/index.html'&&url.searchParams.get('view')==='gaze';
    const policy = gazeDocument ? "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'" : "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Content-Security-Policy':policy}});
    const name = decodeURIComponent(url.pathname).replace(/^\//,'');
    if (name === 'shell-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json(shellSnapshot());
    }
    if (name === 'voice-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json(voiceStatusPayload());
    }
    if (name === 'voice-transcript') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      // Exact binding: an explicit foreign project is refused, and a call that names no project is
      // bound to the live active project. Either way the retained capture must match the live
      // project, privacy generation and non-private scope, so no stale or foreign transcript is
      // ever returned after a scope change.
      const activeProjectId = projects?.current()?.projectId ?? null;
      const requested = url.searchParams.get('projectId');
      if (!activeProjectId || (requested !== null && requested !== activeProjectId)) return json({ transcript: null });
      return json({ transcript: resolveScopedVoiceTranscript(latestVoiceTranscript, { projectId:activeProjectId, privacy:processPrivacy.generation(), privateActive:processPrivacy.capture() !== null }) });
    }
    if (name === 'product-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json({
        ...product!.diagnostics(),
        helper: { mode: nativeHost?.mode ?? 'unavailable', running: nativeHost?.isRunning() ?? false },
        desktopObserve: desktopObserveDiagnostics({ bundleDir: __dirname }),
        voice: voiceStatusPayload(),
      });
    }
    if (name === 'settings-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json({ effective: product!.settings() });
    }
    if (name === 'work-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json({ sessions: await managedWork!.refreshAuth(), projects: projects!.list(), selectedProject: selectedWorkProject(), associatedProject: projects!.current(), privateActive: processPrivacy.capture() !== null });
    }
    if (name === 'voice-routing-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      return json(voiceRouting!.snapshot());
    }
    if (name === 'structured-context') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const result = await structuredContext!.handle(await request.json().catch(() => null));
      return json(result, result.ok ? 200 : 400);
    }
    if (name === 'companion-status') {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      return json(companionAnswers!.snapshot());
    }
    if (name === 'companion-action') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid companion answer request.' }, 400);
      const input = body as Record<string, unknown>;
      try {
        if (input.action === 'preview' && typeof input.question === 'string' && (Object.keys(input).length === 2 || Object.keys(input).length === 3 && typeof input.includeScreen === 'boolean') && Object.keys(input).every(key => ['action', 'question', 'includeScreen'].includes(key))) return json(await companionAnswers!.preview(input.question, { includeScreen: input.includeScreen === true }));
        if (input.action === 'confirm' && typeof input.id === 'string' && input.confirmed === true && Object.keys(input).length === 3) return json(await companionAnswers!.confirm(input.id));
        if (input.action === 'cancel' && typeof input.id === 'string' && Object.keys(input).length === 2) return json(companionAnswers!.cancel(input.id));
        return json({ error: 'Unsupported companion answer request.' }, 400);
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'The companion answer failed.' }, 400); }
    }
    if (name === 'dictation-context-action' || name === 'companion-session-action') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      let body: unknown;
      try { body = await boundedJsonBody(request); }
      catch (error) { return json({ error: error instanceof RangeError ? error.message : 'Invalid JSON request.' }, error instanceof RangeError ? 413 : 400); }
      if (name === 'dictation-context-action') {
        if (processPrivacy.capture() !== null || coordinator.getState().muted) { dictationContext!.clear(); return json({ ok: false, error: 'Dictation context is unavailable while private or muted.' }, 403); }
        const result = await dictationContext!.handle(body); return json(result, result.ok ? 200 : 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid companion session action.' }, 400);
      const input = body as Record<string, unknown>;
      if (input.action === 'disable' && Object.keys(input).length === 1) { companionSession?.disable(); companionAnswers?.clear(); return json(companionSessionStatus()); }
      if (input.action !== 'enable' || input.consent !== true || typeof input.projectId !== 'string' || Object.keys(input).length !== 3
        || projects?.current()?.projectId !== input.projectId || processPrivacy.capture() !== null || coordinator.getState().muted || microphoneMuted) return json({ error: 'Choose the associated project and explicitly consent outside private or muted mode.' }, 400);
      companionSession!.enable(input.projectId, true);
      return json(companionSessionStatus());
    }
    if (name === 'companion-session-status') {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      return json(companionSessionStatus());
    }
    if (name === 'dictation-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      const result = await desktopDictation!.handle(body);
      return json(result, result.ok ? 200 : 400);
    }
    if (name === 'desktop-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const result = await desktopActions!.handle(await request.json().catch(() => null));
      return json(result, result.ok ? 200 : 400);
    }
    if (name === 'desktop-command') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const result = await scopedCommands!.handle(await request.json().catch(() => null));
      return json(result, result.ok ? 200 : 400);
    }
    if (name === 'gaze-status' || name === 'gaze-action') {
      if (request.method !== (name === 'gaze-status' ? 'GET' : 'POST')) return new Response(null,{status:405});
      const body: unknown = name === 'gaze-status' ? { command: 'status', projectId: url.searchParams.get('projectId') } : await request.json().catch(() => null);
      if(name==='gaze-action'){
        if(!body||typeof body!=='object'||(body as Record<string,unknown>).command!=='stop')return json({error:'Use gaze Settings to start calibration.'},400);
        await experience?.overlay.stop();
      }
      const result = await gazeHost!.handle({command:'status',projectId:'desktop'});
      return json(result, result.ok ? 200 : 400);
    }
    if (name === 'permission-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      try {
        const kernel = getSecurityKernel(); await kernel.ready();
        const fields = ['status', 'capability', 'dataCategory', 'destination', 'recordedAt', 'grantId'];
        const audit = kernel.getAuditReceipts().slice(-50).map(item => Object.fromEntries(fields.flatMap(key => typeof item[key] === 'string' ? [[key, (item[key] as string).slice(0, 256)]] : [])));
        return json({ state: kernel.getRendererState(), audit });
      } catch { return json({ error: 'Permissions are unavailable.' }, 503); }
    }
    if (name === 'permission-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid permission request.' }, 400);
      const input = body as Record<string, unknown>;
      if (input.action !== 'revoke' || typeof input.grantId !== 'string' || !input.grantId || input.grantId.length > 256 || Object.keys(input).length !== 2) return json({ error: 'Choose a capability grant to revoke.' }, 400);
      try { const kernel = getSecurityKernel(); await kernel.ready(); return json(await kernel.revokeCapability({ grantId: input.grantId, reason: 'User revoked from Permissions' })); }
      catch { return json({ error: 'That capability grant could not be revoked.' }, 400); }
    }
    if (name === 'memory-records-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return json({ error: 'Choose a project.' }, 400);
      try { return json({ records: await memoryRecords!.list(projectId) }); }
      catch (error) { return json({ error: error instanceof Error ? error.message : 'Memory records are unavailable.' }, 400); }
    }
    if (name === 'memory-records-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid memory review.' }, 400);
      const input = body as Record<string, unknown>;
      if (typeof input.projectId !== 'string') return json({ error: 'Choose a project.' }, 400);
      try {
        if (input.action === 'preview' && typeof input.text === 'string' && (typeof input.sourceId === 'string' || input.sourceId === null) && Object.keys(input).length === 4) return json({ preview: await memoryRecords!.preview(input.projectId, input.text, input.sourceId as string | null) });
        if (input.action === 'confirm' && typeof input.id === 'string' && input.confirmed === true && Object.keys(input).length === 4) return json(await memoryRecords!.confirm(input.projectId, input.id));
        if (input.action === 'cancel' && typeof input.id === 'string' && Object.keys(input).length === 3) return json(memoryRecords!.cancel(input.projectId, input.id));
        return json({ error: 'Unsupported memory review.' }, 400);
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Memory review failed.' }, 400); }
    }
    if (name === 'attachments-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      const projectId = url.searchParams.get('projectId');
      if (!projectId || selectedWorkProject()?.projectId !== projectId) return json({ error: 'Choose this active Work project first.' }, 403);
      for (const item of attachments!.list().filter(item => item.active && item.mode === 'observe' && item.projectId === projectId)) await attachments!.collect(projectId, item.id);
      return json({ sessions: attachments!.list().filter(item => item.projectId === projectId) });
    }
    if (name === 'attachments-action' || name === 'history-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid project action.' }, 400);
      const input = body as Record<string, unknown>;
      if (typeof input.projectId !== 'string' || selectedWorkProject()?.projectId !== input.projectId) return json({ error: 'Choose this active Work project first.' }, 403);
      const projectId = input.projectId;
      try {
        if (name === 'history-action') {
          if (input.action === 'choose' && Object.keys(input).length === 2) {
            const owner = dashboard && !dashboard.isDestroyed() ? dashboard : widget;
            if (!owner) throw new Error('No app window is available.');
            const selection = await dialog.showOpenDialog(owner, { title: 'Preview project history', properties: ['openFile'], filters: [{ name: 'History logs', extensions: ['jsonl', 'txt', 'log'] }] });
            if (selection.canceled || !selection.filePaths[0]) return json({ canceled: true });
            return json({ preview: await historyImport!.preview(projectId, selection.filePaths[0]) });
          }
          if (input.action === 'confirm' && typeof input.id === 'string' && input.confirmed === true && Object.keys(input).length === 4) return json({ imported: await historyImport!.confirm(projectId, input.id), semanticCoverage: 'partial' });
          if (input.action === 'cancel' && typeof input.id === 'string' && Object.keys(input).length === 3) return json(historyImport!.cancel(projectId, input.id));
        } else {
          if (input.action === 'add' && (input.mode === 'managed' || input.mode === 'observe') && Object.keys(input).length === 3) return json({ session: await attachments!.add(projectId, input.mode) });
          if (typeof input.id !== 'string') return json({ error: 'A Claude attachment is required.' }, 400);
          if (input.action === 'send' && typeof input.instruction === 'string' && input.confirmed === true && Object.keys(input).length === 5) return json({ session: await attachments!.send(projectId, input.id, input.instruction) });
          if (input.action === 'hooks' && typeof input.install === 'boolean' && input.confirmed === true && Object.keys(input).length === 5) return json(await attachments!.hooks(projectId, input.id, input.install));
          if (input.action === 'refresh' && Object.keys(input).length === 3) return json({ session: await attachments!.refresh(projectId, input.id) });
          if (input.action === 'interrupt' && Object.keys(input).length === 3) return json({ session: await attachments!.interrupt(projectId, input.id) });
          if (input.action === 'close' && Object.keys(input).length === 3) return json({ session: await attachments!.close(projectId, input.id) });
          if (input.action === 'respond' && typeof input.requestId === 'string' && (input.decision === 'approve' || input.decision === 'deny') && Object.keys(input).length === 5) return json({ session: await attachments!.respond(projectId, input.id, input.requestId, input.decision) });
        }
        return json({ error: 'Unsupported project action.' }, 400);
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'The project action failed.' }, 400); }
    }
    if (name === 'voice-routing-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid voice review request.' }, 400);
      const input = body as Record<string, unknown>;
      try {
        if (input.action === 'configure' && (input.sessionId === null || typeof input.sessionId === 'string')
          && typeof input.enabled === 'boolean' && Object.keys(input).length === 3) {
          return json(voiceRouting!.configure(input.sessionId as string | null, input.enabled));
        }
        if (input.action === 'confirm' && typeof input.id === 'string' && typeof input.sessionId === 'string' && Object.keys(input).length === 3) {
          return json(await voiceRouting!.confirm(input.id, input.sessionId));
        }
        if (input.action === 'cancel' && typeof input.id === 'string' && Object.keys(input).length === 2) return json(voiceRouting!.cancel(input.id));
        return json({ error: 'Unsupported voice review request.' }, 400);
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Voice review failed.' }, 400); }
    }
    if (name === 'memory-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      const projectId = url.searchParams.get('projectId');
      if (!projectId || selectedWorkProject()?.projectId !== projectId) {
        return json({ error: 'Choose a managed project before reading memory.' }, 400);
      }
      try { return json({ items: await memoryRecords!.list(projectId) }); }
      catch (error) { return json({ error: error instanceof Error ? error.message : 'Memory is unavailable.' }, 503); }
    }
    if (name === 'provider-status') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      try {
        const kernel = getSecurityKernel();
        await kernel.ready();
        const state = kernel.getRendererState();
        return json({ state, model: product!.settings().find((setting) => setting.key === 'providers.textModel')?.value ?? 'gpt-6-sol' });
      } catch (error) { return json({ error: error instanceof Error ? error.message : 'Provider setup is unavailable.' }, 503); }
    }
    if (name === 'project-answer') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'Invalid project question.' }, 400);
      const input = body as Record<string, unknown>;
      if (typeof input.projectId !== 'string' || typeof input.question !== 'string'
        || input.question.trim().length === 0 || input.question.length > 1_000
        || !Array.isArray(input.itemIds) || input.itemIds.length === 0 || input.itemIds.length > 8
        || !input.itemIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
        || input.confirmed !== true || Object.keys(input).length !== 4) {
        return json({ error: 'Choose one to eight visible memories and confirm the OpenAI request.' }, 400);
      }
      if (selectedWorkProject()?.projectId !== input.projectId) {
        return json({ error: 'That project is not connected to this app.' }, 403);
      }
      try {
        const projectId = input.projectId;
        const privacyGeneration = processPrivacy.generation();
        const timeline = (await memoryRecords!.list(projectId)).map(item => ({ ...item,
          summary: item.supersededBy ? `${item.summary} [Historical source; later user correction: ${item.supersededBy}]` : item.summary,
        }));
        if (selectedWorkProject()?.projectId !== projectId) throw new Error('The selected project changed before the answer request.');
        const kernel = getSecurityKernel();
        if (!textProvider) throw new Error('The OpenAI text provider is unavailable.');
        return json(await answerProjectFromEvidence({
          projectId, question: input.question, itemIds: input.itemIds as string[],
        }, { timeline, kernel, provider: textProvider, valid: () => selectedWorkProject()?.projectId === projectId && processPrivacy.generation() === privacyGeneration }));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'The scoped project question failed.' }, 503);
      }
    }
    if (name === 'desktop-observe') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)
        || typeof (body as Record<string, unknown>).projectId !== 'string'
        || Object.keys(body).length !== 1) {
        return json({ error: 'desktop-observe accepts exactly { projectId }.' }, 400);
      }
      const projectId = (body as Record<string, unknown>).projectId as string;
      // Only an active managed Work session for this exact project may be observed, so a closed or
      // different project never gets a capture and the route never guesses an attribution.
      if (selectedWorkProject()?.projectId !== projectId) {
        return json({ error: 'That project has no active managed Work session.' }, 403);
      }
      if (desktopObservationRunning) return json({ error: 'A desktop observation is already running.' }, 409);
      const privacyGeneration = processPrivacy.generation();
      desktopObservationRunning = true;
      try {
        const outcome = await getDesktopObserveHost().observe({ projectId });
        if (privacyGeneration !== processPrivacy.generation() || selectedWorkProject()?.projectId !== projectId) {
          return json({ error: 'The project or privacy scope changed. Observe again.' }, 409);
        }
        switch (outcome.outcome) {
          case 'observed':
            // Local observation itself never leaves the machine: it returns the existing evidence
            // plus an opaque id into the bounded main-memory snapshot store.
            return json({ ok: true, evidence: outcome.evidence, snapshotId: getDesktopAnswer().capture(projectId, outcome.evidence) });
          case 'denied':
            // Permission, exclusion, no-window, and empty-evidence are distinct, bounded outcomes;
            // the native detail is a category or bundle id, never AX content.
            return json({ ok: false, reason: outcome.code, detail: outcome.detail });
          case 'invalid_scope':
            return json({ ok: false, reason: 'invalid_scope', error: 'A non-empty project id of at most 256 bytes is required.' }, 400);
          case 'helper_missing':
            return json({ ok: false, reason: 'helper_missing', error: 'The packaged desktop observation helper is missing; run pnpm dev to build and sign dist/native/echopilot-desktop.', searched: outcome.searched }, 503);
          case 'timeout':
            return json({ ok: false, reason: 'timeout', error: 'The desktop observation timed out.' }, 504);
          case 'response_too_large':
            return json({ ok: false, reason: 'response_too_large', error: 'The desktop observation returned more data than the host accepts.' }, 502);
          case 'malformed_response':
            return json({ ok: false, reason: 'malformed_response', error: 'The desktop observation returned an unusable response.' }, 502);
          case 'crashed':
            return json({ ok: false, reason: 'crashed', error: 'The desktop observation helper exited before answering.' }, 502);
          default:
            return json({ ok: false, reason: 'native_error', error: 'The desktop observation failed.' }, 502);
        }
      } finally {
        desktopObservationRunning = false;
      }
    }
    if (name === 'desktop-answer-preview') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'Invalid desktop answer preview request.' }, 400);
      const input = body as Record<string, unknown>;
      const projectId = input.projectId;
      const snapshotId = input.snapshotId;
      const question = input.question;
      if (typeof projectId !== 'string' || typeof snapshotId !== 'string' || typeof question !== 'string'
        || Object.keys(input).length !== 3) {
        return json({ error: 'desktop-answer-preview accepts exactly { projectId, snapshotId, question }.' }, 400);
      }
      if (selectedWorkProject()?.projectId !== projectId) {
        return json({ error: 'That project has no active managed Work session.' }, 403);
      }
      try {
        // Disclosure only: no grant, no key read, no network.
        const result = getDesktopAnswer().preview({ projectId, snapshotId, question });
        return result.ok
          ? json(result.value)
          : json({ error: result.message, code: result.code }, desktopAnswerErrorStatus(result.code));
      } catch {
        return json({ error: 'The desktop answer service is unavailable.' }, 503);
      }
    }
    if (name === 'desktop-answer-context') {
      if (request.method !== 'GET') return new Response(null,{status:405});
      const projectIds = url.searchParams.getAll('projectId');
      const unexpected = [...url.searchParams.keys()].some((key) => key !== 'projectId');
      const projectId = projectIds.length === 1 ? projectIds[0]! : '';
      if (projectIds.length !== 1 || unexpected || !projectId.trim() || projectId.length > 256
        || /[\u0000-\u001f\u007f]/.test(projectId)) {
        return json({ error: 'desktop-answer-context accepts exactly ?projectId=...' }, 400);
      }
      // Only an active managed Work session for this exact project may be looked up, so the page
      // can never surface a snapshot attributed to a closed or different project.
      if (selectedWorkProject()?.projectId !== projectId) {
        return json({ error: 'That project has no active managed Work session.' }, 403);
      }
      try {
        // Read-only pointer to the newest live main-memory snapshot, or an honest null. Opening
        // the page never observes, never captures, and never creates a confirmation.
        const result = getDesktopAnswer().latest(projectId);
        return result.ok
          ? json({ snapshot: result.value })
          : json({ error: result.message, code: result.code }, desktopAnswerErrorStatus(result.code));
      } catch {
        return json({ error: 'The desktop answer service is unavailable.' }, 503);
      }
    }
    if (name === 'desktop-answer-confirm') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'Invalid desktop answer confirmation request.' }, 400);
      const input = body as Record<string, unknown>;
      const projectId = input.projectId;
      const confirmationId = input.confirmationId;
      const confirmed = input.confirmed;
      if (typeof projectId !== 'string' || typeof confirmationId !== 'string' || typeof confirmed !== 'boolean'
        || Object.keys(input).length !== 3) {
        return json({ error: 'desktop-answer-confirm accepts exactly { projectId, confirmationId, confirmed }.' }, 400);
      }
      if (selectedWorkProject()?.projectId !== projectId) {
        return json({ error: 'That project has no active managed Work session.' }, 403);
      }
      try {
        // The stored immutable preview is the only thing sent; an unconfirmed or stale reference is
        // refused before any grant or provider call.
        const result = await getDesktopAnswer().confirm({ projectId, confirmationId, confirmed });
        return result.ok
          ? json(result.value)
          : json({ error: result.message, code: result.code }, desktopAnswerErrorStatus(result.code));
      } catch {
        return json({ error: 'The desktop answer request failed.' }, 502);
      }
    }
    if (name === 'desktop-answer-cancel') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'Invalid desktop answer cancellation request.' }, 400);
      const input = body as Record<string, unknown>;
      const projectId = input.projectId;
      const confirmationId = input.confirmationId;
      if (typeof projectId !== 'string' || typeof confirmationId !== 'string' || Object.keys(input).length !== 2) {
        return json({ error: 'desktop-answer-cancel accepts exactly { projectId, confirmationId }.' }, 400);
      }
      if (selectedWorkProject()?.projectId !== projectId) {
        return json({ error: 'That project has no active managed Work session.' }, 403);
      }
      try {
        // Cancel revokes consent and discards the pending evidence; nothing was ever sent.
        const result = getDesktopAnswer().cancel({ projectId, confirmationId });
        return result.ok
          ? json(result.value)
          : json({ error: result.message, code: result.code }, desktopAnswerErrorStatus(result.code));
      } catch {
        return json({ error: 'The desktop answer service is unavailable.' }, 503);
      }
    }
    if (name === 'work-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'Invalid work request.' }, 400);
      const input = body as Record<string, unknown>;
      try {
        if (input.action === 'associate-project' && Object.keys(input).length === 1) {
          const owner = dashboard && !dashboard.isDestroyed() ? dashboard : widget;
          if (!owner) throw new Error('No app window is available.');
          const chosen = await dialog.showOpenDialog(owner, { title: 'Associate a project with EchoPilot', properties: ['openDirectory'] });
          if (chosen.canceled || !chosen.filePaths[0]) return json({ canceled: true });
          clearScopedAuthority();
          const project = await projects!.associate(chosen.filePaths[0]);
          clearScopedAuthority();
          return json({ project, projects: projects!.list(), sessions: managedWork!.list() });
        }
        if (input.action === 'select-project' && typeof input.projectId === 'string' && Object.keys(input).length === 2) {
          clearScopedAuthority();
          const project = await projects!.select(input.projectId); clearScopedAuthority(); return json({ project, projects: projects!.list() });
        }
        if (input.action === 'start-codex' && typeof input.projectId === 'string' && Object.keys(input).length === 2) {
          const selected = projects!.current(); if (!selected || selected.projectId !== input.projectId) throw new Error('Select this associated project first.');
          return json({ session: await managedWork!.start(selected.cwd), sessions: managedWork!.list(), projects: projects!.list() });
        }
        if (input.action === 'choose-project' && Object.keys(input).length === 1) {
          const owner = dashboard && !dashboard.isDestroyed() ? dashboard : widget;
          if (!owner) return json({ error: 'No app window is available.' }, 503);
          const selection = await dialog.showOpenDialog(owner, {
            title: 'Choose a project for a managed Codex session',
            buttonLabel: 'Use this project',
            properties: ['openDirectory'],
          });
          if (selection.canceled || !selection.filePaths[0]) return json({ canceled: true, sessions: managedWork!.list() });
          const started = await managedWork!.start(selection.filePaths[0]);
          return json({ session: started, sessions: managedWork!.list() });
        }
        if (typeof input.id !== 'string') return json({ error: 'A session is required.' }, 400);
        if (input.action === 'login' && Object.keys(input).length === 2) {
          const login = await managedWork!.beginLogin(input.id);
          await externalShell.openExternal(login.authUrl);
          return json({ session: login.session });
        }
        if (input.action === 'send' && typeof input.instruction === 'string' && Object.keys(input).length === 3) {
          return json({ session: await managedWork!.send(input.id, input.instruction) });
        }
        if (input.action === 'interrupt' && Object.keys(input).length === 2) {
          return json({ session: await managedWork!.interrupt(input.id) });
        }
        if (input.action === 'respond' && typeof input.requestId === 'string'
          && (input.decision === 'approve' || input.decision === 'deny') && Object.keys(input).length === 4) {
          return json({ session: await managedWork!.respond(input.id, input.requestId, input.decision) });
        }
        if (input.action === 'close' && Object.keys(input).length === 2) {
          return json({ session: await managedWork!.close(input.id) });
        }
        return json({ error: 'Unsupported work request.' }, 400);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Managed work failed.' }, 400);
      }
    }
    if (name === 'settings-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'Invalid settings request.' }, 400);
      const input = body as Record<string, unknown>;
      try {
        if (input.action === 'set' && typeof input.key === 'string' && typeof input.value === 'string'
          && Object.keys(input).length === 3) {
          const effective = product!.setSetting(input.key, input.value);
          syncNarrationSettings();
          return json({ effective });
        }
        if (input.action === 'reset' && typeof input.family === 'string' && Object.keys(input).length === 2) {
          const effective = product!.resetFamily(input.family);
          syncNarrationSettings();
          return json({ effective });
        }
        if (input.action === 'export' && Object.keys(input).length === 1) {
          return json({ document: product!.exportSettings() });
        }
        if (input.action === 'import' && typeof input.document === 'string' && Object.keys(input).length === 2) {
          const report = product!.importSettings(input.document);
          syncNarrationSettings();
          return json({ effective: product!.settings(), report });
        }
        return json({ error: 'Unsupported settings request.' }, 400);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Settings could not be changed.' }, 400);
      }
    }
    if (name === 'voice-action') {
      if (request.method !== 'POST') return new Response(null,{status:405});
      const body: unknown = await request.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return new Response(null,{status:400});
      const action = (body as {action?: unknown}).action;
      if (Object.keys(body).length !== 1 || (action !== 'enable' && action !== 'disable')) return new Response(null,{status:400});
      if (!voice) return json(voiceStatusPayload(), 503);
      try {
        if (action === 'enable' && microphoneMuted) return json({ error: 'Unmute the microphone before enabling conversation.' }, 409);
        if (action === 'enable') await voice.enable();
        else { voiceRouting?.configure(voiceRouting.snapshot().sessionId, false); await voice.disable(); }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`EchoPilot voice lifecycle: ${reason}`);
        return json({ error: reason }, 503);
      }
      return json(voiceStatusPayload());
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
    if (name !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(name) && !/^vendor\/webgazer\/(?:webgazer\.js|mediapipe\/face_mesh\/[a-zA-Z0-9_.-]+\.(?:js|wasm|data|binarypb))$/.test(name)) return new Response(null,{status:404});
    try {
      let data = await readFile(join(rendererRoot,name));
      if(gazeDocument)data=Buffer.from(data.toString().replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-eval'"));
      const mime = extname(name) === '.js' ? 'text/javascript' : extname(name) === '.css' ? 'text/css' : extname(name)==='.wasm'?'application/wasm':name==='index.html'?'text/html':'application/octet-stream';
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
      case 'set-muted': coordinator.setMuted(command.muted); narration?.setMuted(command.muted); if (command.muted) { companionSession?.disable(); void dictationCapture?.cancel(); dictationContext?.clear(); desktopDictation?.clear(); } break;
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
  ipcMain.handle('echo:claim-speech', (event, payload: unknown) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted IPC sender');
    if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0)) throw new TypeError('Speech claim accepts an empty request');
    if (coordinator.getState().muted) return false;
    
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents !== event.sender) window.webContents.send('echo:stop-speech');
    return true;
  });
  ipcMain.handle('echo:privacy', async (event, payload: unknown) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted IPC sender');
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('Invalid privacy request');
    const input = payload as Record<string, unknown>;
    const profile = await getProfileMemory();
    switch (input.action) {
      case 'begin': {
        if (Object.keys(input).length !== 2 || typeof input.sessionId !== 'string' || !/^private-session-[0-9a-f]{16}$/.test(input.sessionId)) throw new TypeError('Invalid private session');
        if (attachments?.list().some(attachment => attachment.currentTurnId !== null)) throw new Error('Stop the running Claude turn before entering private mode: this installed CLI cannot disable session history.');
        processPrivacy.begin(input.sessionId);
        await profile.operations.beginPrivateSession?.({ sessionId: input.sessionId });
        clearPrivacyViews();
        return { ok: true };
      }
      case 'end': {
        if (Object.keys(input).length !== 2 || typeof input.sessionId !== 'string' || !/^private-session-[0-9a-f]{16}$/.test(input.sessionId)) throw new TypeError('Invalid private session');
        if (processPrivacy.capture() !== input.sessionId) throw new TypeError('That private session is not active');
        const ended = await profile.operations.endPrivateSession?.({ sessionId: input.sessionId }) ?? [];
        processPrivacy.end(input.sessionId);
        clearPrivacyViews();
        return ended;
      }
      case 'forget': {
        const eventIds = input.eventIds;
        if (Object.keys(input).length !== 2 || !Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > 100
          || !eventIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
          throw new TypeError('Choose one to 100 memory entries to forget.');
        }
        const receipt = await profile.operations.forget({ eventIds: eventIds as string[] });
        clearPrivacyViews();
        return receipt;
      }
      case 'export': {
        if (Object.keys(input).length !== 2 || typeof input.passphrase !== 'string') throw new TypeError('An export passphrase is required.');
        const owner = dashboard && !dashboard.isDestroyed() ? dashboard : widget;
        if (!owner) throw new Error('No app window is available.');
        const selected = await dialog.showSaveDialog(owner, {
          title: 'Export encrypted EchoPilot profile',
          defaultPath: join(app.getPath('documents'), `EchoPilot-${new Date().toISOString().slice(0, 10)}.echopilot`),
          filters: [{ name: 'EchoPilot encrypted archive', extensions: ['echopilot'] }],
        });
        if (selected.canceled || !selected.filePath) throw new Error('Export canceled.');
        const receipt = await exportProfile({ directory: profile.directory, destination: selected.filePath, passphrase: input.passphrase });
        return { files: receipt.files, destination: receipt.destination };
      }
      case 'import': {
        if (typeof input.passphrase !== 'string' || Object.keys(input).some(key => !['action', 'archive', 'passphrase'].includes(key))
          || (input.archive !== undefined && typeof input.archive !== 'string')) throw new TypeError('A restore passphrase is required.');
        const owner = dashboard && !dashboard.isDestroyed() ? dashboard : widget;
        if (!owner) throw new Error('No app window is available.');
        const selected = typeof input.archive === 'string' && input.archive.length > 0
          ? input.archive
          : (await dialog.showOpenDialog(owner, {
            title: 'Choose an encrypted EchoPilot archive',
            properties: ['openFile'],
            filters: [{ name: 'EchoPilot encrypted archive', extensions: ['echopilot'] }],
          })).filePaths[0];
        if (!selected) throw new Error('Restore canceled.');
        const receipt = await importProfile({ archive: selected, directory: join(app.getPath('userData'), 'restores', randomUUID()), passphrase: input.passphrase });
        clearPrivacyViews();
        return receipt;
      }
      default: throw new TypeError('Unsupported privacy request');
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'EchoPilot',submenu:[{label:'Open EchoPilot',click:openDashboard},{label:'Settings…',accelerator:'CommandOrControl+,',click:openSettings},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
  widget = createWindow('widget');
  widget.on('closed', () => { widget = null; });
  tray = createShellTray({shell:requireShell(),status:widgetStatus,onShowWidget:openWidget,onOpenDashboard:openDashboard,onQuit:() => app.quit()});
  nativeHost?.start();
  if(!smoke && !voiceSmoke)openDashboard();
  // Closing the widget (Mission Control, Cmd-W, a Space change) must keep the session reachable
  // through the menu bar instead of ending the app.
  app.on('window-all-closed', () => { if (shouldQuitWhenAllWindowsClosed()) app.quit(); });
  app.on('will-quit', () => {
    // Standby listening and conversation models are released before the app goes away.
    companionSession?.disable(); void dictationCapture?.cancel(); dictationContext?.dispose();
    const pending = voice?.dispose();
    voice = undefined;
    void managedWork?.dispose();
    companionAnswers?.clear();
    void structuredContext?.dispose();
    desktopDictation?.dispose();
    desktopActions?.dispose();
    scopedCommands?.dispose();
    experience?.dispose();
    gazeHost?.dispose();
    historyImport?.dispose();
    void attachments?.dispose();
    desktopDictation = undefined;
    voiceRouting = undefined;
    managedWork = undefined;
    void profileMemory?.then((profile) => profile.close());
    profileMemory = undefined;
    void pending;
    nativeHost?.dispose();
    tray?.dispose();
    tray = null;
    globalShortcut.unregisterAll();
  });
  app.on('activate',openDashboard);
  if (smoke) {
    await new Promise<void>((resolve,reject) => {widget!.webContents.once('did-finish-load',() => resolve());widget!.webContents.once('did-fail-load',(_e,code,description) => reject(new Error(`${code}: ${description}`)));});
    const result = await widget.webContents.executeJavaScript(`(async () => {
      const first = await window.echo.command({type:'get-state'});
      await window.echo.command({type:'set-muted',muted:true});
      const muted = await window.echo.command({type:'get-state'});
      let rejected = false; try {await window.echo.command({type:'execute',command:'no'});} catch {rejected = true;}
      const changed = await fetch(new URL('settings-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'set',key:'voice.preset',value:'anna'})});
      const settings = await (await fetch(new URL('settings-status', location.href))).json();
      const settingsSaved = changed.ok && settings.effective.some(row => row.key === 'voice.preset' && row.value === 'anna');
      const desktopIdle = await window.echo.desktop({action:'status'});
      const blockedRealtime = await window.echo.desktop({action:'toggle',mode:'agent'});
      await window.echo.desktop({action:'cancel'});
      const realtimeWired = desktopIdle.phase === 'idle' && blockedRealtime.phase === 'error'
        && typeof RTCPeerConnection === 'function' && isSecureContext
        && settings.effective.some(row => row.key === 'setup.preset' && row.value === 'gemini');
      await fetch(new URL('shell-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({control:'mute'})});
      const micBlocked = (await fetch(new URL('voice-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'enable'})})).status === 409;
      await fetch(new URL('shell-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({control:'mute'})});
      let privacyCleared = 0;
      const stopPrivacy = window.echo.onPrivacyCleared(() => { privacyCleared++; });
      await window.echoPrivacy.beginPrivateSession({sessionId:'private-session-0000000000000001'});
      const privateEnd = await window.echoPrivacy.endPrivateSession({sessionId:'private-session-0000000000000001'});
      await new Promise(resolve => setTimeout(resolve, 50));
      stopPrivacy();
      const voiceReview = await (await fetch(new URL('voice-routing-status', location.href))).json();
      const voiceReviewOff = voiceReview.enabled === false && voiceReview.pending === null;
      const unscopedVoice = await fetch(new URL('voice-routing-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'configure',sessionId:null,enabled:true})});
      const staleVoice = await fetch(new URL('voice-routing-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'confirm',id:'stale',sessionId:'missing'})});
      const unscopedDictation = await fetch(new URL('dictation-action', location.href), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'preview',projectId:'missing',text:'must never insert'})});
      const voiceReviewGuards = unscopedVoice.status === 400 && staleVoice.status === 400 && unscopedDictation.status === 400;
      const companionSession = await (await fetch(new URL('companion-session-status', location.href))).json();
      const tooBig = JSON.stringify({action:'send',text:'x'.repeat(32768)});
      const contextBound = await fetch(new URL('dictation-context-action',location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:tooBig});
      const sessionGuard = await fetch(new URL('companion-session-action',location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'enable',projectId:'missing',consent:true})});
      const coreRouteGuards = companionSession.enabled === false && contextBound.status === 413 && sessionGuard.status === 400;
      await window.echo.command({type:'open-dashboard'});
      return {realtimeWired,coreRouteGuards,id:first.event?.id,muted:muted.muted,rejected,settingsSaved,micBlocked,voiceReviewOff,voiceReviewGuards,privacyCleared:privacyCleared===2,privateBound:Array.isArray(privateEnd),nodeExposed:typeof process !== 'undefined',rendered:(document.getElementById('root')?.childElementCount ?? 0)>0};
    })()`);
    const profile = await getProfileMemory();
    const companionProject = await projects!.associate(app.getPath('userData'));
    const noteReview = await memoryRecords!.preview(companionProject.projectId, 'SQLite smoke decision uses encrypted local storage.', null);
    const companionNote = await memoryRecords!.confirm(companionProject.projectId, noteReview.id);
    await voiceRouting!.transcript({ phase: 'final', text: 'What SQLite storage did we decide?', utteranceId: `smoke-companion-${randomUUID()}` });
    const companionReview = voiceRouting!.snapshot().companion?.pending;
    const companionReviewed = !!companionReview && companionReview.projectId === companionProject.projectId
      && companionReview.evidence.some(item => item.id === companionNote.eventId) && voiceRouting!.snapshot().pending === null;
    companionAnswers!.clear();
    await widget.webContents.executeJavaScript(`window.echoPrivacy.beginPrivateSession({sessionId:'private-session-0000000000000002'})`);
    const privateAt = new Date().toISOString();
    for (const sessionId of [randomUUID(), randomUUID()]) {
      const eventId = `smoke-private-${randomUUID()}`;
      await rememberManagedEvent({ schemaVersion: 1, eventId, sourceId: 'smoke-private', sourceEventId: eventId,
        sourceSequence: 1, ingestSequence: 1, occurredAt: privateAt, observedAt: privateAt,
        scope: { profileId: 'local', projectId: 'smoke-private-project', sessionId, sensitivity: 'normal' },
        kind: 'agent_message', payloadRef: `smoke-private://${eventId}`, contentHash: eventId, trust: 'agent_reported' }, { text: 'Private smoke capture' });
    }
    const privateEvents = await widget.webContents.executeJavaScript(`window.echoPrivacy.endPrivateSession({sessionId:'private-session-0000000000000002'})`);
    const globalPrivate = privateEvents.length === 2 && (await profile.store.timeline({ projectId: 'smoke-private-project' })).length === 0;
    const memoryId = `smoke-memory-${randomUUID()}`;
    const payloadRef = `smoke://${memoryId}`;
    const observedAt = new Date().toISOString();
    await profile.store.ingest({
      events: [{ schemaVersion: 1, eventId: memoryId, sourceId: 'smoke', sourceEventId: memoryId,
        sourceSequence: 1, ingestSequence: 1, occurredAt: observedAt, observedAt,
        scope: { profileId: 'local', projectId: 'smoke-project', sensitivity: 'normal' },
        kind: 'agent_message', payloadRef, contentHash: memoryId, trust: 'agent_reported' }],
      payloads: { [payloadRef]: { text: 'Disposable smoke memory' } },
    });
    const remembered = (await profile.store.timeline({ projectId: 'smoke-project' })).some((item) => item.sourceEventIds.includes(memoryId));
    await profile.operations.forget({ eventIds: [memoryId] });
    const forgotten = !(await profile.store.timeline({ projectId: 'smoke-project' })).some((item) => item.sourceEventIds.includes(memoryId));
    dashboard!.close();
    if (!result.realtimeWired || !result.id || !result.muted || !result.rejected || !result.settingsSaved || !result.micBlocked || !result.privateBound
      || !result.voiceReviewOff || !result.voiceReviewGuards || !result.privacyCleared || !result.coreRouteGuards
      || !companionReviewed || !globalPrivate || !remembered || !forgotten || result.nodeExposed || !result.rendered || widget.isDestroyed()) {
      throw new Error(`Smoke failed: ${JSON.stringify({ ...result, companionReviewed, globalPrivate, remembered, forgotten })}`);
    }
    console.log(`ECHOPILOT_SMOKE ${JSON.stringify({ ...result, companionReviewed, globalPrivate, remembered, forgotten })}`);
    app.quit();
  }
  if (voiceSmoke) {
    try {
      if (!voice) throw new Error('Voice service did not start.');
      await voice.enable();
      const active = voice.status();
      if (!active.voice.microphoneOpen || !active.voice.conversationModelsLoaded) {
        throw new Error(`Voice did not open capture: ${JSON.stringify(active.voice)}`);
      }
      await voice.disable();
      const closed = voice.status();
      if (closed.voice.microphoneOpen || closed.voice.conversationModelsLoaded) {
        throw new Error(`Voice did not release capture and models: ${JSON.stringify(closed.voice)}`);
      }
      console.log(`ECHOPILOT_VOICE_SMOKE ${JSON.stringify({ opened: true, released: true, worker: active.worker })}`);
      app.quit();
    } catch (error) {
      console.error(`ECHOPILOT_VOICE_SMOKE_FAIL ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    }
  }
}
app.on('will-quit', () => { secretHelperBridge?.dispose(); secretHelperBridge = null; securityKernel = null; });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',openDashboard);
  void app.whenReady().then(ready).catch(error => {console.error('EchoPilot startup failed:',error);app.exit(1);});
}
