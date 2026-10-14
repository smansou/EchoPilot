import React, { useEffect, useState } from 'react';
import type { MemoryNotePreview, MemoryRecordView } from '../main/memory-records-host';

export function MemoryRecordsControls({ projectId }: { projectId: string | null }) {
  const [records, setRecords] = useState<MemoryRecordView[]>([]); const [text, setText] = useState(''); const [sourceId, setSourceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MemoryNotePreview | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0);
  useEffect(() => {
    setRecords([]); setPreview(null); setSourceId(null); let live = true;
    if (projectId) void fetch(`echo://app/memory-records-status?projectId=${encodeURIComponent(projectId)}`).then(async response => { const value = await response.json(); if (!response.ok) throw Error(value.error); if (live) setRecords(value.records); }).catch(error => { if (live) setError(error.message ?? 'Memory unavailable.'); });
    return () => { live = false; };
  }, [projectId, revision]);
  async function action(body: Record<string, unknown>) {
    if (!projectId) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('echo://app/memory-records-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, projectId }) });
      const value = await response.json(); if (!response.ok) throw Error(value.error ?? 'Memory action failed.');
      if (value.preview) setPreview(value.preview);
      if (value.eventId || value.canceled) { setPreview(null); if (value.eventId) { setText(''); setRevision(r => r + 1); } }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Memory action failed.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="User memory notes and corrections">
    <h3>Notes and source corrections</h3>
    <p>Your confirmed note becomes a durable user decision. Corrections preserve the original source and its history. Semantic extraction remains partial.</p>
    <label>Source to correct<select value={sourceId ?? ''} onChange={event => { setSourceId(event.target.value || null); setPreview(null); }}>
      <option value="">New user note</option>
      {records.filter(record => record.id.length <= 128).map(record => <option key={record.id} value={record.id}>{record.supersededBy ? 'Historical · ' : ''}{record.summary.slice(0, 95)}</option>)}
    </select></label>
    <label>Note or correction<textarea maxLength={180} value={text} onChange={event => { setText(event.target.value); setPreview(null); }} /></label>
    <button disabled={!projectId || busy || !text.trim()} onClick={() => void action({ action: 'preview', text, sourceId })}>Review memory change</button>
    {preview && <div><p>{preview.sourceId ? 'Correction to selected source' : 'New note'}: {preview.text}</p><p>Source evidence: {preview.sourceEventIds.join(', ') || 'Your explicit confirmation'}</p>
      <button disabled={busy} onClick={() => void action({ action: 'confirm', id: preview.id, confirmed: true })}>Confirm save to encrypted memory</button>
      <button disabled={busy} onClick={() => void action({ action: 'cancel', id: preview.id })}>Cancel memory change</button>
    </div>}
    {records.slice(-20).reverse().map(record => <article key={record.id}><p>{record.summary}</p><small>{record.trust ?? 'unknown'} · {record.occurredAt}{record.revisionOf ? ` · Revision of ${record.revisionOf}` : ''}{record.supersededBy ? ' · Historical source with a later correction' : ''}</small></article>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
