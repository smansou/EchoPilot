import React, { useEffect, useState } from 'react';
import type { Attachment } from '../main/managed-attachments';
import type { HistoryPreview } from '../main/history-import';

export function HistoryAndAttachmentsPanel({ projectId }: { projectId: string | null }) {
  const [sessions, setSessions] = useState<Attachment[]>([]); const [preview, setPreview] = useState<HistoryPreview | null>(null);
  const [instruction, setInstruction] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function request(route: string, body: Record<string, unknown>) {
    if (!projectId) return null;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`echo://app/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, projectId }) });
      const value = await response.json(); if (!response.ok) throw Error(value.error ?? 'Project action failed.'); return value;
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Project action failed.'); return null; }
    finally { setBusy(false); }
  }
  useEffect(() => {
    setPreview(null); setSessions([]); setMessage(''); let live = true;
    async function refresh() {
      if (!projectId) return;
      try { const response = await fetch(`echo://app/attachments-status?projectId=${encodeURIComponent(projectId)}`); const value = await response.json(); if (live && response.ok) setSessions(value.sessions); }
      catch { /* explicit action reports errors; keep polling quiet */ }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 2_000); return () => { live = false; clearInterval(timer); };
  }, [projectId]);
  return <section aria-label="Claude attachments and history import">
    <h3>Claude sessions and project history</h3>
    <p>Use the selected signed-in Work project. Claude sessions have their own isolated sign-in; observed hooks can never send instructions.</p>
    <button disabled={!projectId || busy} onClick={() => void request('attachments-action', { action: 'add', mode: 'managed' })}>Add managed Claude session</button>
    <button disabled={!projectId || busy} onClick={() => void request('attachments-action', { action: 'add', mode: 'observe' })}>Add Claude observation</button>
    <label>Request for managed Claude<textarea value={instruction} maxLength={16_000} onChange={event => setInstruction(event.target.value)} /></label>
    {sessions.map(session => <article key={session.id} aria-label={session.label}>
      <h4>{session.label} · {session.mode}</h4>
      {!session.authenticated && session.loginCommand && <><p>Sign in from your terminal using this session’s isolated configuration, then refresh:</p><code>{session.loginCommand}</code></>}
      <p>{session.active ? session.authenticated ? 'Signed in' : session.mode === 'observe' ? 'Observation only' : 'Sign-in required' : 'Closed'} · {session.receipt ?? 'No request sent'}</p>
      {session.active && session.mode === 'managed' && <>
        <button disabled={busy} onClick={() => void request('attachments-action', { action: 'refresh', id: session.id })}>Refresh sign-in</button>
        <button disabled={busy || !session.authenticated || !!session.currentTurnId || !instruction.trim()} onClick={() => void request('attachments-action', { action: 'send', id: session.id, instruction, confirmed: true })}>Confirm and send to Claude</button>
        <button disabled={busy || !session.currentTurnId} onClick={() => void request('attachments-action', { action: 'interrupt', id: session.id })}>Interrupt Claude</button>
      </>}
      {session.active && session.mode === 'observe' && <>
        <p>Install changes this project’s .claude/settings.local.json. Hooks retain lifecycle metadata only, preserving other settings.</p>
        <button disabled={busy} onClick={() => void request('attachments-action', { action: 'hooks', id: session.id, install: true, confirmed: true })}>Confirm install observation hooks</button>
        <button disabled={busy} onClick={() => void request('attachments-action', { action: 'hooks', id: session.id, install: false, confirmed: true })}>Remove these hooks</button>
      </>}
      {session.pendingApproval && <><p>Claude requires approval for its current turn.</p><pre>{session.approvalText}</pre>
        <button disabled={busy} onClick={() => void request('attachments-action', { action: 'respond', id: session.id, requestId: session.pendingApproval, decision: 'approve' })}>Approve current request</button>
        <button disabled={busy} onClick={() => void request('attachments-action', { action: 'respond', id: session.id, requestId: session.pendingApproval, decision: 'deny' })}>Deny current request</button></>}
      {session.active && <button disabled={busy} onClick={() => void request('attachments-action', { action: 'close', id: session.id })}>Close attachment</button>}
      {session.error && <p role="alert">{session.error}</p>}
      {session.events.slice(-6).map(event => <p key={event.id}>{event.kind}{event.text ? `: ${event.text}` : ''}</p>)}
    </article>)}
    <h4>Import history as evidence</h4>
    <p>Preview a JSONL, TXT or LOG file under 64 MiB. Import writes to encrypted project memory; its content cannot authorize actions. Semantic coverage remains partial.</p>
    <button disabled={!projectId || busy} onClick={() => void request('history-action', { action: 'choose' }).then(value => { if (value?.preview) setPreview(value.preview); })}>Choose history file</button>
    {preview && <div><p>{preview.name} · {preview.bytes.toLocaleString()} bytes · {preview.format}</p>
      {preview.events.map((event, index) => <p key={index}>{event.kind}: {event.text}</p>)}
      <button disabled={busy} onClick={() => void request('history-action', { action: 'confirm', id: preview.id, confirmed: true }).then(value => { if (value?.imported) { setPreview(null); setMessage(`Imported ${value.imported.coverage.importedEvents} events. Semantic coverage: partial.`); } })}>Confirm import to encrypted memory</button>
      <button disabled={busy} onClick={() => void request('history-action', { action: 'cancel', id: preview.id }).then(value => { if (value) setPreview(null); })}>Cancel import</button>
    </div>}
    <p role="status">{message}</p>
  </section>;
}
