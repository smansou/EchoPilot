import { useEffect, useState } from 'react';
import type { DesktopActionResult } from '../../../main/desktop-actions';

export function DesktopActionWidget({projectId, request}: {projectId: string | null; request(payload: Record<string, unknown>): Promise<DesktopActionResult>}) {
  const [state, setState] = useState<DesktopActionResult>({ok: true});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    async function refresh() {if (!projectId) return; try {const result = await request({command: 'status', projectId}); if (!disposed && result.ok) setState(result);} catch {}}
    void refresh(); const timer = setInterval(() => void refresh(), 2_000);
    return () => {disposed = true; clearInterval(timer);};
  }, [projectId, request]);
  async function run(payload: Record<string, unknown>) {
    setBusy(true); try {setState(await request({...payload, projectId}));} catch {setState({ok: false, error: 'native_unavailable'});} finally {setBusy(false);}
  }
  const preview = state.preview;
  return <div className="widget-desktop-action" onMouseDown={(event) => event.preventDefault()}>
    {preview ? <>
      <span title={`${preview.targetRef} · ${preview.role}`}>{preview.operation} {preview.direction} · {preview.app} · {preview.label || preview.role}</span>
      <button tabIndex={-1} disabled={busy || preview.projectId !== projectId || Date.now() > preview.expiresAt} onClick={() => void run({command: 'confirm', previewId: preview.previewId, confirmed: true})}>Confirm {preview.operation}</button>
      <button tabIndex={-1} disabled={busy} onClick={() => void run({command: 'cancel'})}>Cancel</button>
    </> : <button tabIndex={-1} disabled={busy || !projectId || !state.prepared} onClick={() => void run({command: 'previewPrepared'})}>Preview prepared action</button>}
    {!state.ok && <span role="status">{state.error}</span>}
  </div>;
}
