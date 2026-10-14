import { useState } from 'react';
import type { DictationPreview, DictationResult } from '../../../main/desktop-dictation';

export type DesktopDictationControlsProps = {projectId: string | null; transcript?: string; request(payload: Record<string, unknown>): Promise<DictationResult>};

/** An explicit preview/confirmation flow; a committed voice transcript is never inserted by itself. */
export function DesktopDictationControls({projectId, transcript = '', request}: DesktopDictationControlsProps) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<DictationPreview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [spokenTerm, setSpokenTerm] = useState('');
  const [correctTerm, setCorrectTerm] = useState('');
  const [entries, setEntries] = useState<NonNullable<DictationResult['entries']>>([]);
  async function run(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await request({...payload, projectId});
      if (result.draftText !== undefined) setText(result.draftText);
      if (result.entries) setEntries(result.entries);
      setPreview(result.preview ?? null);
      setMessage(result.ok ? result.prepared ? 'Draft prepared. Return to the target field, then click Preview prepared draft on the floating widget.' : result.preview ? 'Review the target and text, then confirm on the floating widget.' : 'Cancelled.' : `Preview only: ${result.error ?? 'unavailable'}.`);
    } catch { setMessage('Desktop helper unavailable. Your transcript is preserved.'); }
    finally { setBusy(false); }
  }
  return <section className="signal-card dictation-card" aria-label="Safe desktop dictation">
    <h2>Desktop dictation</h2>
    <p>Append text to a focused editable field. Secure and unsupported fields stay preview only. No Return key is sent.</p>
    <textarea aria-label="Dictation text" value={text} onChange={(event) => {setText(event.target.value); setPreview(null);}} placeholder="Review or paste your transcript" rows={3}/>
    <div className="signal-actions">
      <button className="signal-secondary" disabled={busy || !transcript} onClick={() => {setText(transcript); setPreview(null);}}>Use latest transcript</button>
      <button className="signal-primary" disabled={busy || !projectId || !text.trim()} onClick={() => void run({command: 'prepare-draft', text})}>Prepare draft</button>
    </div>
    {preview && <div className="dictation-preview">
      <p>{preview.kind === 'undo' ? 'Restore field in' : 'Append to'} {preview.app}: {preview.label}</p>
      <pre>{preview.text}</pre>
      <p>Return to the target field and confirm on the floating widget.</p>
    </div>}
    <details><summary>Project vocabulary</summary>
      <label>Spoken term<input value={spokenTerm} onChange={(event) => setSpokenTerm(event.target.value)} maxLength={256}/></label>
      <label>Correct term<input value={correctTerm} onChange={(event) => setCorrectTerm(event.target.value)} maxLength={256}/></label>
      <div className="signal-actions">
        <button className="signal-primary" disabled={busy || !projectId || !spokenTerm.trim() || !correctTerm.trim()} onClick={() => void run({command: 'learnCorrection', raw: spokenTerm, corrected: correctTerm, confirmed: true})}>Save project correction</button>
        <button className="signal-secondary" disabled={busy || !projectId} onClick={() => void run({command: 'glossary'})}>Show vocabulary</button>
      </div>
      {entries.map((entry) => <p key={`${entry.scope}:${entry.term}`}>{entry.term} · {entry.scope}{entry.scope === 'project' && entry.ownerProjectId === projectId && <button disabled={busy} onClick={() => void run({command: 'promoteTerm', term: entry.term, confirmed: true})}>Share globally</button>}</p>)}
    </details>
    <p role="status">{message}</p>
  </section>;
}
