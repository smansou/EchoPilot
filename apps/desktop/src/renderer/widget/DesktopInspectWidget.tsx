/**
 * The widget's one-click "Inspect window" surface (C05).
 *
 * The affordance is a plain button, so it works even though the widget window never takes keyboard
 * focus. One click resolves the explicit active Work project (persisted Mission Control selection
 * first, otherwise the only active project) and issues exactly one same-origin
 * `POST desktop-observe`. The result is the bounded local Accessibility preview — never a spoken
 * answer, never a screenshot, never a background capture.
 *
 * The widget polls `work-status` so the scope line stays current; it never polls foreground
 * content. While no valid active project exists, the button stays disabled and the instruction to
 * choose one in Work is visible.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  createDesktopInspectClient,
  DESKTOP_FAILURE_COPY,
  type DesktopInspectClient,
  type DesktopInspectState,
  type DesktopScopeState,
} from './desktop-inspect';
import { DesktopInspectResultPanel } from './DesktopInspectResultPanel';

/** Exported for tests: the one-line scope status under the inspect button. */
export function desktopInspectScopeLine(scope: DesktopScopeState): string {
  switch (scope.kind) {
    case 'checking':
      return 'Checking Work sessions…';
    case 'ready':
      return `Project: ${scope.label}${scope.source === 'selection' ? ' (selected in Work)' : ' (only active project)'}`;
    case 'blocked':
      return scope.activeProjects === 0
        ? 'No active Work project — connect one in Mission Control.'
        : `${scope.activeProjects} active projects — choose one in Mission Control → Work.`;
    case 'unavailable':
      return DESKTOP_FAILURE_COPY.work_status_unavailable;
  }
}

export function DesktopInspectWidget({ client }: { client?: DesktopInspectClient } = {}) {
  const captionId = useId();
  const clientRef = useRef<DesktopInspectClient | null>(null);
  if (clientRef.current === null) clientRef.current = client ?? createDesktopInspectClient();
  const resolvedClient = clientRef.current;
  const [scope, setScope] = useState<DesktopScopeState>({ kind: 'checking' });
  const [state, setState] = useState<DesktopInspectState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const next = await resolvedClient.loadScope();
      if (active) setScope(next);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [resolvedClient]);

  async function inspect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const next = await resolvedClient.inspect();
      // null means an observation was already in flight; one click still means one request.
      if (next !== null) setState(next);
    } catch {
      setState({ kind: 'error', reason: 'transport', message: DESKTOP_FAILURE_COPY.transport, projectLabel: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="desktop-inspect-widget" aria-label="Inspect the focused window" aria-busy={busy}>
      <div className="desktop-inspect-head">
        <div>
          <h2>Inspect window</h2>
          <p className="desktop-inspect-subtitle">
            Reads the focused window's Accessibility labels and values once, on demand. Nothing runs in the background.
          </p>
        </div>
      </div>
      <div className="desktop-inspect-controls">
        <button
          type="button"
          className="desktop-inspect-action"
          aria-describedby={captionId}
          disabled={busy || scope.kind !== 'ready'}
          onClick={() => void inspect()}
        >
          {busy ? 'Inspecting…' : 'Inspect window'}
        </button>
        <span className="desktop-inspect-scope" role="status">{desktopInspectScopeLine(scope)}</span>
      </div>
      <p id={captionId} className="desktop-inspect-caption">
        This is a local Accessibility preview — no AI answer or screenshot. Output speech stays off.
      </p>
      <div className="desktop-inspect-result" aria-live="polite">
        {busy
          ? <p className="desktop-inspect-busy">Reading the focused window once…</p>
          : <DesktopInspectResultPanel state={state} />}
      </div>
    </section>
  );
}
