import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { State as CompanionState, Command, CompanionAPI as Bridge } from '../../../../packages/contracts/src/index';
import { createPrivacyControl, type PrivacyControl, type PrivacyControlState } from './control/privacy/index';
import { resolvePrivacyOperations } from './control/privacy/host';
import { sendShellControl, useShellSnapshot, type ShellSnapshot, type WidgetControl } from './widget/shell-status';
import { WidgetStatusPanel } from './widget/WidgetStatusPanel';
import { DesktopQuestionWidget } from './widget/DesktopQuestionWidget';
import {
  connectVoiceControl,
  type ConnectedVoiceControl,
  type VoiceControlStatus,
  type VoiceIndicator,
} from './control/voice';
import './styles.css';
import './widget/widget.css';

const bridge = (window as unknown as { echo?: Bridge }).echo;
const isDashboard = new URLSearchParams(window.location.search).get('view') === 'dashboard';
// The profile service is bound by the desktop host (see control/privacy/profile-host.ts); an
// unbound window says so instead of rendering choices nothing can store.
const privacyHost = resolvePrivacyOperations();

/**
 * The voice surface's own styles. Standby is deliberately not the "listening" look: a filled
 * steady badge instead of the pulsing active one, so a low-power wake listener can never be
 * mistaken for a live microphone, and it stays on screen for as long as standby does.
 */
const VOICE_STYLES = `
.voice-control { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.voice-indicator { display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 999px; font-size: 12px; letter-spacing: 0.01em; border: 1px solid transparent; }
.voice-indicator .voice-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.voice-indicator.tone-neutral { color: #8b98a5; border-color: #2a333c; }
.voice-indicator.tone-active { color: #6ee7a8; border-color: #1f5136; background: rgba(110, 231, 168, 0.08); }
.voice-indicator.tone-active .voice-dot { animation: voice-pulse 1.6s ease-in-out infinite; }
.voice-indicator.tone-standby { color: #ffd479; border-color: #5c4a1f; background: rgba(255, 212, 121, 0.10); }
.voice-indicator.tone-danger { color: #ff9a8a; border-color: #5c2a24; background: rgba(255, 154, 138, 0.10); }
.voice-detail { color: #9fb0bd; font-size: 11px; }
.voice-control button { font: inherit; }
@keyframes voice-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`;

/**
 * The one place the user enables the hands-free session. After that the session renews itself from
 * speech activity: idle teardown (or standby) happens without any further UI interaction.
 */
function VoiceSessionControl() {
  const control = useRef<ConnectedVoiceControl | null>(null);
  if (!control.current) control.current = connectVoiceControl();
  const [status, setStatus] = useState<VoiceControlStatus>(() => control.current!.model.status());
  const [indicator, setIndicator] = useState<VoiceIndicator>(() => control.current!.model.indicator());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const current = control.current!;
    const unsubscribe = current.model.subscribe((nextStatus, nextIndicator) => {
      setStatus(nextStatus);
      setIndicator(nextIndicator);
    });
    const stopPolling = current.startPolling();
    return () => { unsubscribe(); stopPolling(); };
  }, []);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (status.snapshot.enabled) await control.current!.model.disable();
      else await control.current!.model.enable();
    } catch {
      setError('The voice session did not change. Check that the signed helper is running.');
    } finally {
      setBusy(false);
    }
  }

  const energy = status.gates.standbyEnergy;
  const wake = status.gates.wake;
  return (
    <div className="voice-control">
      <style>{VOICE_STYLES}</style>
      <span
        className={`voice-indicator tone-${indicator.tone}`}
        data-kind={indicator.kind}
        data-persistent={indicator.persistent}
        role="status"
        aria-live="polite"
        aria-label={indicator.ariaLabel}
        title={indicator.ariaLabel}
      >
        <span className="voice-dot" aria-hidden="true" />
        {indicator.label}
      </span>
      <button
        className="control"
        type="button"
        disabled={busy}
        aria-pressed={status.snapshot.enabled}
        aria-label={status.snapshot.enabled ? 'Disable hands-free conversation' : 'Enable hands-free conversation'}
        onClick={() => void toggle()}
      >
        {status.snapshot.enabled ? 'Disable conversation' : 'Enable conversation'}
      </button>
      {energy && energy.sampleCount > 0 && (
        <span className="voice-detail">
          Standby energy {energy.passed ? 'within budget' : `over budget (${energy.violations.join(', ')})`}
          {` · ${energy.averageCpuPercent.toFixed(2)}% CPU · ${energy.wakeupsPerMinute.toFixed(1)} wakeups/min`}
        </span>
      )}
      {wake && wake.exposureMs > 0 && (
        <span className="voice-detail">
          {`Wake false triggers ${wake.falseTriggersPerHour.toFixed(1)}/h total`}
          {` · TV ${wake.tvFalseTriggersPerHour.toFixed(1)}/h`}
          {` · background speech ${wake.backgroundSpeechFalseTriggersPerHour.toFixed(1)}/h`}
        </span>
      )}
      {error && <span className="voice-detail" role="alert">{error}</span>}
    </div>
  );
}

function Icon({ name }: { name: 'mute' | 'replay' | 'expand' | 'lock' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'mute' && <><path d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Z" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M3 3l18 18" /></>}
      {name === 'replay' && <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /><path d="m10 8 6 4-6 4Z" /></>}
      {name === 'expand' && <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M9 3v18M9 9h12" /></>}
      {name === 'lock' && <><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>}
    </svg>
  );
}

function App() {
  const [state, setState] = useState<CompanionState>({ muted: false, event: null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replayCount, setReplayCount] = useState(0);
  const polledShell = useShellSnapshot();
  const [actionShell, setActionShell] = useState<ShellSnapshot | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const shell = actionShell ?? polledShell;
  // The privacy control is the only owner of these choices: the UI stages them and renders the
  // outcome; it never touches a store, a directory or a passphrase beyond the input it clears.
  const [privacyControl] = useState<PrivacyControl>(() => createPrivacyControl(privacyHost.operations));
  const [privacy, setPrivacy] = useState<PrivacyControlState>(() => privacyControl.state());
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const exportPassphrase = useRef<HTMLInputElement>(null);
  const restoreArchive = useRef<HTMLInputElement>(null);
  const restorePassphrase = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!bridge) {
      setError('Open EchoPilot in the desktop app to connect to the companion.');
      return;
    }
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = bridge.onState((next) => {
      receivedUpdate = true;
      if (active) { setState(next); setReady(true); }
    });
    void bridge.command({ type: 'get-state' }).then((next) => {
      if (active) {
        if (!receivedUpdate) setState(next);
        setReady(true);
      }
    }).catch(() => {
      if (active) setError('The companion could not connect. Close this window and reopen the app.');
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  async function command(next: Command) {
    if (!bridge || busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await bridge.command(next));
      if (next.type === 'replay') setReplayCount((count) => count + 1);
    }
    catch { setError('That action did not complete. Please try again.'); }
    finally { setBusy(false); }
  }

  // Foreground-safe shell controls travel over the same-origin shell-action route, so they work
  // even when the preload bridge or a conflicting global shortcut is unavailable.
  async function shellControl(control: WidgetControl) {
    if (shellBusy) return;
    setShellBusy(true);
    try {
      setActionShell(await sendShellControl(control));
      window.setTimeout(() => setActionShell(null), 2_000);
    }
    catch { setError('That control did not complete. Try again, or use the menu bar.'); }
    finally { setShellBusy(false); }
  }

  // Privacy actions only report what the control (and behind it, the profile service) confirmed;
  // a rejected choice leaves the previous outcome in place instead of reading like a success.
  async function runPrivacy(action: () => Promise<PrivacyControlState>) {
    if (privacyBusy) return;
    setPrivacyBusy(true);
    try { setPrivacy(await action()); }
    catch { setPrivacy(privacyControl.state()); }
    finally { setPrivacyBusy(false); }
  }

  async function togglePrivateSession() {
    await runPrivacy(() => privacy.private ? privacyControl.endPrivateSession() : privacyControl.beginPrivateSession());
  }

  function stageForget() {
    const event = state.event;
    if (!event) return;
    setPrivacy(privacyControl.requestForget({ eventIds: [event.id] }, `the latest event (${event.id})`));
  }

  function passphraseFrom(ref: React.RefObject<HTMLInputElement | null>): string {
    const input = ref.current;
    const value = input?.value ?? '';
    if (input) input.value = '';
    return value;
  }

  const privacyPanel = (
    <section className="event-card" aria-labelledby="privacy-heading">
      <div className="section-label"><h2 id="privacy-heading">Private session, forget, export</h2><span className="pill">{privacy.private ? 'Private' : 'Recall on'}</span></div>
      <p className="event-text" aria-live="polite">{privacy.privateLabel}</p>
      {!privacy.bound && <p className="widget-note">{privacyHost.reason}</p>}
      {privacy.privateError && <p className="error" role="alert">{privacy.privateError}</p>}
      <div className="controls" aria-label="Forget a memory">
        <button className="control" disabled={!privacy.bound || !state.event || privacy.pendingForget !== null} onClick={stageForget} title="Stage the latest event for deletion">Forget latest event</button>
        {privacy.pendingForget && <button className="control selected" disabled={privacyBusy} onClick={() => void runPrivacy(() => privacyControl.confirmForget())} title="Delete the staged selection">Confirm: {privacy.pendingForget.label}</button>}
        {privacy.pendingForget && <button className="control" disabled={privacyBusy} onClick={() => setPrivacy(privacyControl.cancelForget())}>Cancel</button>}
      </div>
      {privacy.forget.kind === 'succeeded' && <p className="widget-note" role="status">{privacy.forget.detail}</p>}
      {privacy.forget.kind === 'failed' && <p className="error" role="alert">{privacy.forget.reason}</p>}
      <div className="controls" aria-label="Encrypted export">
        <input ref={exportPassphrase} type="password" placeholder="Export passphrase" aria-label="Export passphrase" autoComplete="off" />
        <button className="control" disabled={!privacy.bound || privacyBusy} onClick={() => void runPrivacy(() => privacyControl.exportProfile({ passphrase: passphraseFrom(exportPassphrase) }))} title="Seal this profile into an encrypted archive">Export encrypted profile</button>
      </div>
      {privacy.export.kind === 'succeeded' && <p className="widget-note" role="status">{privacy.export.detail}</p>}
      {privacy.export.kind === 'failed' && <p className="error" role="alert">{privacy.export.reason}</p>}
      <div className="controls" aria-label="Restore into a new profile">
        <input ref={restoreArchive} type="text" placeholder="Archive path" aria-label="Archive path" autoComplete="off" />
        <input ref={restorePassphrase} type="password" placeholder="Restore passphrase" aria-label="Restore passphrase" autoComplete="off" />
        <button className="control" disabled={!privacy.bound || privacyBusy} onClick={() => void runPrivacy(() => privacyControl.importProfile({ archive: restoreArchive.current?.value ?? '', passphrase: passphraseFrom(restorePassphrase) }))} title="Restore the archive into the new profile directory the host configured">Restore into a new profile</button>
      </div>
      {privacy.import.kind === 'succeeded' && <p className="widget-note" role="status">{privacy.import.detail}</p>}
      {privacy.import.kind === 'failed' && <p className="error" role="alert">{privacy.import.reason}</p>}
      {privacy.privateTranscript.length > 0 && <p className="widget-note" role="status">Private session ended: {privacy.privateTranscript.length} entries were shown once and are gone.</p>}
    </section>
  );

  const controls = (
    <div className="controls" aria-label="Companion controls">
      <button className={`control ${state.muted ? 'selected' : ''}`} aria-label={state.muted ? 'Unmute companion output' : 'Mute companion output'} aria-pressed={state.muted} disabled={!ready || busy} onClick={() => void command({ type: 'set-muted', muted: !state.muted })} title={state.muted ? 'Unmute output' : 'Mute output'}><Icon name="mute" /><span>{state.muted ? 'Unmute' : 'Mute'}</span></button>
      <button className="control" disabled={!ready || busy || !state.event} onClick={() => void command({ type: 'replay' })} title="Replay the latest demo event"><Icon name="replay" /><span>Replay</span></button>
      <button className={`control ${privacy.private ? 'selected' : ''}`} aria-label={privacy.private ? 'End the private session' : 'Start a private session'} aria-pressed={privacy.private} disabled={!privacy.bound || privacyBusy} onClick={() => void togglePrivateSession()} title={privacy.privateLabel}><Icon name="lock" /><span>{privacy.private ? 'End private' : 'Private'}</span></button>
      {!isDashboard && <button className="control icon-only" aria-label="Open Mission Control" disabled={!ready || busy} onClick={() => void command({ type: 'open-dashboard' })} title="Open Mission Control"><Icon name="expand" /></button>}
    </div>
  );

  return (
    <main className={isDashboard ? 'dashboard' : 'widget'}>
      <header className="titlebar"><span className="wordmark">echo<span>pilot</span></span><span className="demo-badge">DEMO</span></header>
      {isDashboard ? <>
        <section className="dashboard-heading"><p className="eyebrow">YOUR COMPANION, AT A GLANCE</p><h1>Mission Control</h1><p>A small presence. A clearer view of your work.</p></section>
        <section className="status-card"><div className={`orb ${state.muted ? 'muted' : ''}`} aria-hidden="true"><span /></div><div><p className="eyebrow">COMPANION OUTPUT</p><h2>{!ready ? 'Connecting' : state.muted ? 'Muted' : 'Ready'}</h2><p>Local demo session · voice off until enabled</p></div>{controls}</section>
        <section className="event-card" aria-labelledby="latest-event"><div className="section-label"><h2 id="latest-event">Latest event</h2><span className="pill">Synthetic</span></div><p className="event-text" aria-live="polite">{state.event?.text ?? 'Waiting for the first demo event.'}</p>{state.event && <div className="event-meta"><span>Session · {state.event.sessionId}</span><time dateTime={state.event.createdAt}>{new Date(state.event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>}</section>
        {privacyPanel}
        <WidgetStatusPanel snapshot={shell} busy={shellBusy} onControl={(control) => void shellControl(control)} />
        <VoiceSessionControl />
        <aside className="demo-note"><span className="note-dot" /><div><strong>This is the first working slice.</strong><p>Events are simulated. The microphone and local voice models stay off until you enable conversation, and they are released again when the session goes idle.</p></div></aside>
        <footer>EchoPilot <span>·</span> Local desktop prototype</footer>
      </> : <>
        <section className="widget-status"><div className={`orb ${state.muted ? 'muted' : ''}`} aria-hidden="true"><span /></div><div><h1>{!ready ? 'Connecting…' : state.muted ? 'Output muted' : 'Alongside you'}</h1><p>Synthetic events · voice off until enabled</p></div></section>
        <p className="widget-event" aria-live="polite">{state.event?.text ?? 'Waiting for the first demo event.'}</p>
        {/* C01: "what is this?" is answered in the widget conversation itself — never by opening
            Mission Control. The shell connects the scoped desktop runtime; until then the panel
            stays at limited context instead of guessing about the screen. */}
        <DesktopQuestionWidget muted={state.muted} />
        <WidgetStatusPanel snapshot={shell} busy={shellBusy} onControl={(control) => void shellControl(control)} />
        <VoiceSessionControl />
        {controls}
        <p className="widget-note">Demo events only · replay re-delivers text</p>
      </>}
      <p className="widget-note" role="status">{replayCount > 0 ? `Latest demo event replayed (${replayCount})` : ''}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('EchoPilot renderer root is missing.');
createRoot(root).render(<App />);
