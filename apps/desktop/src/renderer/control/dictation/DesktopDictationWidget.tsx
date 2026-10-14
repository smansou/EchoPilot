import { useEffect, useState } from 'react';
import type { DictationResult } from '../../../main/desktop-dictation';

/** Mouse-only controls in the nonactivating widget keep the approved external field focused. */
export function DesktopDictationWidget({projectId, request}: {projectId: string | null; request(payload: Record<string, unknown>): Promise<DictationResult>}) {
  const [state, setState] = useState<DictationResult>({ok: true});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      if (!projectId) { setState({ok: true}); return; }
      try { const result = await request({command: 'status', projectId}); if (!disposed && result.ok) setState(result); } catch {}
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {disposed = true; clearInterval(timer);};
  }, [projectId, request]);
  async function run(payload: Record<string, unknown>) {
    setBusy(true);
    try { setState(await request({...payload, projectId})); } catch {setState({ok: false, error: 'helper_unavailable'});}
    finally {setBusy(false);}
  }
  const preview = state.preview;
  return <div className="widget-dictation" onMouseDown={(event) => event.preventDefault()}>
    {preview ? <>
      <span title={preview.text}>{preview.kind === 'undo' ? 'Restore' : 'Append'} · {preview.app} · {preview.label} · {preview.text.slice(0, 120)}</span>
      <button tabIndex={-1} disabled={busy || !projectId || Date.now() > preview.expiresAt} onClick={() => void run({command: 'confirm', previewId: preview.previewId, confirmed: true})}>{preview.kind === 'undo' ? 'Confirm restore' : 'Confirm insertion'}</button>
      <button tabIndex={-1} disabled={busy} onClick={() => void run({command: 'cancel', previewId: preview.previewId})}>Cancel</button>
    </> : <>
      <button tabIndex={-1} disabled={busy || !state.prepared || !projectId} onClick={() => void run({command: 'previewPrepared'})}>Preview prepared draft</button>
      <button tabIndex={-1} disabled={busy || !state.undoAvailable || !projectId} onClick={() => void run({command: 'undoPreview'})}>Undo preview</button>
    </>}
    {!state.ok && <span role="status">{state.error}</span>}
  </div>;
}
