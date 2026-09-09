import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { State as CompanionState, Command, CompanionAPI as Bridge } from '../../../../packages/contracts/src/index';
import './styles.css';

const bridge = (window as unknown as { echo?: Bridge }).echo;
const isDashboard = new URLSearchParams(window.location.search).get('view') === 'dashboard';

function Icon({ name }: { name: 'mute' | 'replay' | 'expand' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'mute' && <><path d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Z" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M3 3l18 18" /></>}
      {name === 'replay' && <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /><path d="m10 8 6 4-6 4Z" /></>}
      {name === 'expand' && <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M9 3v18M9 9h12" /></>}
    </svg>
  );
}

function App() {
  const [state, setState] = useState<CompanionState>({ muted: false, event: null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replayCount, setReplayCount] = useState(0);

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

  const controls = (
    <div className="controls" aria-label="Companion controls">
      <button className={`control ${state.muted ? 'selected' : ''}`} aria-label={state.muted ? 'Unmute companion output' : 'Mute companion output'} aria-pressed={state.muted} disabled={!ready || busy} onClick={() => void command({ type: 'set-muted', muted: !state.muted })} title={state.muted ? 'Unmute output' : 'Mute output'}><Icon name="mute" /><span>{state.muted ? 'Unmute' : 'Mute'}</span></button>
      <button className="control" disabled={!ready || busy || !state.event} onClick={() => void command({ type: 'replay' })} title="Replay the latest demo event"><Icon name="replay" /><span>Replay</span></button>
      {!isDashboard && <button className="control icon-only" aria-label="Open Mission Control" disabled={!ready || busy} onClick={() => void command({ type: 'open-dashboard' })} title="Open Mission Control"><Icon name="expand" /></button>}
    </div>
  );

  return (
    <main className={isDashboard ? 'dashboard' : 'widget'}>
      <header className="titlebar"><span className="wordmark">echo<span>pilot</span></span><span className="demo-badge">DEMO</span></header>
      {isDashboard ? <>
        <section className="dashboard-heading"><p className="eyebrow">YOUR COMPANION, AT A GLANCE</p><h1>Mission Control</h1><p>A small presence. A clearer view of your work.</p></section>
        <section className="status-card"><div className={`orb ${state.muted ? 'muted' : ''}`} aria-hidden="true"><span /></div><div><p className="eyebrow">COMPANION OUTPUT</p><h2>{!ready ? 'Connecting' : state.muted ? 'Muted' : 'Ready'}</h2><p>Local demo session</p></div>{controls}</section>
        <section className="event-card" aria-labelledby="latest-event"><div className="section-label"><h2 id="latest-event">Latest event</h2><span className="pill">Synthetic</span></div><p className="event-text" aria-live="polite">{state.event?.text ?? 'Waiting for the first demo event.'}</p>{state.event && <div className="event-meta"><span>Session · {state.event.sessionId}</span><time dateTime={state.event.createdAt}>{new Date(state.event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>}</section>
        <aside className="demo-note"><span className="note-dot" /><div><strong>This is the first working slice.</strong><p>Events are simulated. No microphone, screen capture, real agent connection, or synthesized voice is active. Replay re-delivers the latest event.</p></div></aside>
        <footer>EchoPilot <span>·</span> Local desktop prototype</footer>
      </> : <>
        <section className="widget-status"><div className={`orb ${state.muted ? 'muted' : ''}`} aria-hidden="true"><span /></div><div><h1>{!ready ? 'Connecting…' : state.muted ? 'Output muted' : 'Alongside you'}</h1><p>Synthetic session · no microphone</p></div></section>
        <p className="widget-event" aria-live="polite">{state.event?.text ?? 'Waiting for the first demo event.'}</p>
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
