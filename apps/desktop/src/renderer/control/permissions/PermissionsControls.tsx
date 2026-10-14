import { useCallback, useEffect, useState } from 'react';

type GrantView = { grantId: string; capability: string; dataCategory: string; destination: string; effect: string; lifetime: string; projectId: string | null };
type ReceiptView = { status: string; capability?: string; dataCategory?: string; destination?: string; recordedAt?: string };
type PermissionsView = { state: { activeGrants: number; pendingRequests: number; grants: readonly GrantView[] }; audit: readonly ReceiptView[] };

export function PermissionsControls() {
  const [view, setView] = useState<PermissionsView | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(new URL('permission-status', location.href), { cache: 'no-store' });
    const raw: unknown = await response.json();
    if (!response.ok || typeof raw !== 'object' || raw === null || !('state' in raw) || !('audit' in raw)) throw new Error('Permission history is unavailable.');
    const next = raw as PermissionsView;
    if (!Array.isArray(next.state?.grants) || !Array.isArray(next.audit) || next.state.grants.length > 50 || next.audit.length > 50) throw new Error('Permission history returned an invalid response.');
    return next;
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => void load().then((next) => { if (active) setView(next); })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Permission history unavailable.'); });
    refresh(); const timer = setInterval(refresh, 3_000);
    return () => { active = false; clearInterval(timer); };
  }, [load]);
  async function revoke(grantId: string) {
    if (busy) return;
    setBusy(grantId); setMessage('');
    try {
      const response = await fetch(new URL('permission-action', location.href), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke', grantId }),
      });
      if (!response.ok) throw new Error('The grant could not be revoked.');
      setView(await load()); setMessage('Authority revoked. Any queued work needs fresh permission.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Revocation failed.'); }
    finally { setBusy(null); }
  }
  return <>
    <section className="signal-card"><h2>Authority, not assumptions</h2>
      <p className="signal-muted">Provider sharing and desktop actions require scoped permission. A one-time grant is consumed by its matching operation; revocation does not run queued work.</p>
      <p>{view ? `${view.state.activeGrants} active grants · ${view.state.pendingRequests} queued requests` : 'Checking local permissions…'}</p>
      {view?.state.grants.length === 0 && <p className="signal-muted">No live authority is retained.</p>}
      {view?.state.grants.map((grant) => <div className="diagnostic-row" key={grant.grantId}>
        <div><strong>{grant.capability}</strong><p className="signal-muted">{grant.dataCategory} → {grant.destination} · {grant.lifetime}{grant.projectId ? ` · project ${grant.projectId}` : ''}</p></div>
        <button className="signal-secondary" disabled={busy !== null} onClick={() => void revoke(grant.grantId)}>Revoke</button>
      </div>)}
      {message && <p className="signal-feedback" role="status">{message}</p>}
    </section>
    <section className="signal-card"><h2>Recent authorization receipts</h2>
      <p className="signal-muted">Metadata only. Prompts, keys, camera frames, and captured text are not displayed here.</p>
      {view?.audit.length === 0 && <p className="signal-muted">No permission receipts yet.</p>}
      {view?.audit.slice().reverse().map((receipt, index) => <div className="diagnostic-row" key={`${receipt.recordedAt ?? ''}:${index}`}>
        <span>{receipt.status} · {receipt.capability ?? 'permission'} · {receipt.dataCategory ?? 'local'}</span>
        <time>{receipt.recordedAt ? new Date(receipt.recordedAt).toLocaleString() : 'Time unavailable'}</time>
      </div>)}
    </section>
  </>;
}
