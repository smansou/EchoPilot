import React, { useEffect, useState } from 'react';
import type { VoiceRoutingSnapshot } from '../main/voice-routing';

/** Mount in Dashboard/Work with the currently selected exact session and visible session list. */
export function HandsFreePanel({ sessionId, sessions }: {
  sessionId: string | null;
  sessions: readonly { id: string; label: string; active: boolean; authenticated: boolean; compatible: boolean }[];
}) {
  const [state, setState] = useState<VoiceRoutingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const eligible = sessions.find(s => s.id === sessionId && s.active && s.authenticated && s.compatible);
  async function action(body: Record<string, unknown>) {
    setBusy(true); setError('');
    try {
      const response = await fetch('echo://app/voice-routing-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Voice review failed.');
      setState(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Voice review failed.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let live = true;
    async function refresh() {
      try {
        const response = await fetch('echo://app/voice-routing-status');
        if (!response.ok) throw new Error('Voice review is unavailable.');
        const value = await response.json(); if (live) setState(value);
      } catch (failure) { if (live) setError(failure instanceof Error ? failure.message : 'Voice review is unavailable.'); }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 700);
    return () => { live = false; clearInterval(timer); };
  }, []);
  // Changing the selected project/session always turns review off and discards prior pending speech.
  useEffect(() => { void action({ action: 'configure', sessionId: eligible?.id ?? null, enabled: false }); }, [sessionId]);
  const pending = state?.pending;
  return <section aria-label="Hands-free voice review" className="hands-free-panel">
    <h3>Hands-free voice review</h3>
    <p>Scope: {eligible?.label ?? 'Choose an active signed-in Work session'}</p>
    <p>Enable listening with the microphone control. Voice review sends nothing until you confirm the request below.</p>
    <button disabled={busy || !eligible} onClick={() => void action({ action: 'configure', sessionId, enabled: !state?.enabled })} aria-pressed={state?.enabled ?? false}>
      {state?.enabled ? 'Turn voice review off' : 'Enable voice review'}
    </button>
    <p role="status">{state?.message}</p>
    {pending && <div aria-label="Pending spoken request">
      <p>{pending.sessionId ? `Send to ${sessions.find(s => s.id === pending.sessionId)?.label ?? pending.sessionId}` : 'Confirm that this request belongs to the selected session.'}</p>
      <blockquote>{pending.instruction}</blockquote>
      <p>This sends the text to your managed Codex session. Its tool approval requirements still apply.</p>
      <p>You can also say “confirm send request” while this review is pending. “Yes” alone sends nothing.</p>
      <button disabled={busy || state?.dispatching || !sessionId || !pending.candidates.includes(sessionId)} onClick={() => void action({ action: 'confirm', id: pending.id, sessionId })}>Confirm and send</button>
      <button disabled={busy} onClick={() => void action({ action: 'cancel', id: pending.id })}>Cancel request</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
