import { useEffect, useRef, useState } from 'react';
import type { CompanionSnapshot } from '../main/companion-answers';

type CompanionSession = {enabled: boolean; projectId: string | null; expiresAt: number | null; remainingRequests: number};

/** Visual counterpart of the same main-owned spoken question review, never an agent send. */
export function CompanionAnswersPanel({ projectId }: { projectId: string | null }) {
  const [state, setState] = useState<CompanionSnapshot | null>(null);
  const [session, setSession] = useState<CompanionSession | null>(null);
  const [includeScreen, setIncludeScreen] = useState(false);
  const [question, setQuestion] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    revision.current++; setState(null); setSession(null); setQuestion(''); setIncludeScreen(false); setError(''); setBusy(false);
    let live = true;
    const refresh = async () => {
      const epoch = revision.current;
      try {
        const response = await fetch('echo://app/companion-status', { cache: 'no-store' });
        if (!response.ok) return;
        const snapshot = await response.json() as CompanionSnapshot;
        if (live && epoch === revision.current) setState(snapshot);
        const sessionResponse = await fetch('echo://app/companion-session-status', {cache: 'no-store'});
        if (sessionResponse.ok) { const sessionState = await sessionResponse.json() as CompanionSession; if (live && epoch === revision.current) setSession(sessionState); }
      } catch { /* keep the last local view during a transient route failure */ }
    };
    const echo = (window as unknown as { echo?: { onPrivacyCleared?(listener: () => void): () => void } }).echo;
    const unsubscribe = echo?.onPrivacyCleared?.(() => { revision.current++; setState(null); setSession(null); setQuestion(''); setIncludeScreen(false); setError(''); setBusy(false); });
    void refresh(); const timer = setInterval(() => void refresh(), 700);
    return () => { live = false; revision.current++; clearInterval(timer); unsubscribe?.(); };
  }, [projectId]);
  async function action(body: Record<string, unknown>) {
    const epoch = ++revision.current; setBusy(true); setError('');
    try {
      const response = await fetch('echo://app/companion-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (epoch !== revision.current) return;
      if (!response.ok) throw Error(payload.error ?? 'The companion answer request failed.');
      setState(payload as CompanionSnapshot);
    } catch (failure) { if (epoch === revision.current) setError(failure instanceof Error ? failure.message : 'The companion answer request failed.'); }
    finally { if (epoch === revision.current) setBusy(false); }
  }
  async function sessionAction(enable: boolean) {
    const epoch = ++revision.current; setBusy(true); setError('');
    try {
      const response = await fetch('echo://app/companion-session-action', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(enable ? {action: 'enable', consent: true, projectId} : {action: 'disable'})});
      const payload = await response.json();
      if (epoch !== revision.current) return;
      if (!response.ok) throw Error(payload.error ?? 'Companion session unavailable.');
      setSession(payload as CompanionSession);
    } catch (failure) { if (epoch === revision.current) setError(failure instanceof Error ? failure.message : 'Companion session unavailable.'); }
    finally { if (epoch === revision.current) setBusy(false); }
  }
  const sessionEnabled = session?.enabled === true && session.projectId === projectId;
  const pending = state?.pending?.projectId === projectId ? state.pending : null;
  const answer = state?.answer?.projectId === projectId ? state.answer : null;
  return <section aria-label="Companion memory answers" className="hands-free-panel">
    <h3>Ask your project memory</h3>
    <p>Speak a question while listening is enabled, or type it here. No agent sign-in is needed. Evidence review stays local.</p>
    <p>Hands-free answers send recognized question text and bounded project memory and conversation history to OpenAI for up to 5 minutes or 10 questions. Microphone audio stays local. Screen text is included only when you explicitly ask about your screen.</p>
    <button disabled={busy || !projectId} onClick={() => void sessionAction(!sessionEnabled)}>{sessionEnabled ? 'Disable hands-free answers' : 'Enable hands-free answers for 5 minutes'}</button>
    {sessionEnabled && <p role="status">{session.remainingRequests} answers remaining · expires {session.expiresAt ? new Date(session.expiresAt).toLocaleTimeString() : 'soon'}</p>}
    <form onSubmit={event => { event.preventDefault(); void action({ action: 'preview', question, includeScreen }); }}>
      <label>Memory question <input aria-label="Memory question" maxLength={1_000} value={question} onChange={event => setQuestion(event.target.value)} disabled={busy || !projectId} /></label>
      <label><input type="checkbox" checked={includeScreen} onChange={event => setIncludeScreen(event.target.checked)} disabled={busy || !projectId} /> Include current screen text</label>
      <button disabled={busy || !projectId || !question.trim() || state?.answering}>Review evidence</button>
    </form>
    <p role="status">{state?.message ?? (projectId ? 'Ask about a concrete topic in this project.' : 'Select a project to ask its memory.')}</p>
    {pending && <div aria-label="Companion answer review">
      <blockquote>{pending.question}</blockquote>
      <p>Confirming sends this question and these summaries to OpenAI ({pending.model}). The answer may be spoken when output is enabled.</p>
      <ol>{pending.evidence.map(item => <li key={item.id}><p>{item.promptSummary ?? item.summary}</p><small>{item.provenance ?? 'memory'} · {item.trust} · {item.occurredAt} · Source: {item.sourceEventIds.join(', ')}{item.revisionOf ? ` · Corrects ${item.revisionOf}` : ''}{item.supersededBy ? ` · Superseded by ${item.supersededBy}` : ''}</small></li>)}</ol>
      <p>Say “confirm answer request” for this review. “Yes” and “confirm send request” do not authorize it.</p>
      <button disabled={busy || state?.answering} onClick={() => void action({ action: 'confirm', id: pending.id, confirmed: true })}>Confirm answer request</button>
      <button disabled={busy} onClick={() => void action({ action: 'cancel', id: pending.id })}>Cancel answer review</button>
    </div>}
    {answer && <div aria-label="Companion memory answer"><p>{answer.text}</p>
      {answer.citedSourceIds.length > 0 && <p>Cited sources: {answer.citedSourceIds.join(', ')}</p>}
      {answer.supported && <p>References identify reviewed evidence; claims are not automatically verified.</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
