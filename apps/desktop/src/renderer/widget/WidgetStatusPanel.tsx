import type { ShellSnapshot, WidgetControl } from './shell-status';

const LABELS: Record<string, Record<string, string>> = {
  microphone: { granted: 'Granted', denied: 'Denied', muted: 'Muted', unknown: 'Not reported' },
  capture: { granted: 'Granted', denied: 'Denied', unknown: 'Not reported' },
  output: { ready: 'Ready', speaking: 'Speaking', stopped: 'Stopped', unknown: 'Not reported' },
  provider: { local: 'Local', cloud: 'Cloud', unknown: 'Unknown' },
};

function label(field: 'microphone' | 'capture' | 'output' | 'provider', value: string): string {
  return LABELS[field]?.[value] ?? value;
}

export function WidgetStatusPanel({ snapshot, busy, onControl }: {
  snapshot: ShellSnapshot | null;
  busy: boolean;
  onControl(control: WidgetControl): void;
}) {
  const status = snapshot?.status;
  const conflicts = snapshot?.hotkeys.conflicts ?? [];
  const helperConnected = status?.helper === 'connected';
  return (
    <section className="shell-panel" aria-label="Capture and permission status">
      <dl className="shell-grid">
        <div><dt>Microphone</dt><dd data-state={status?.microphone ?? 'unknown'}>{status ? label('microphone', status.microphone) : 'Checking…'}</dd></div>
        <div><dt>Capture</dt><dd data-state={status?.capture ?? 'unknown'}>{status ? label('capture', status.capture) : 'Checking…'}</dd></div>
        <div><dt>Output</dt><dd data-state={status?.output ?? 'unknown'}>{status ? label('output', status.output) : 'Checking…'}</dd></div>
        <div><dt>Target session</dt><dd>{status?.targetSession ?? 'No active session'}</dd></div>
        <div><dt>Provider</dt><dd>{status ? label('provider', status.provider) : 'Checking…'}</dd></div>
        <div><dt>Helper</dt><dd data-state={status?.helper ?? 'disconnected'}>{helperConnected ? 'Connected' : 'Disconnected'}</dd></div>
      </dl>
      {status && !helperConnected && (
        <p className="shell-note" role="status">
          Native helper disconnected. The widget stays usable and reconnects automatically.
        </p>
      )}
      {conflicts.length > 0 && (
        <ul className="shell-conflicts">
          {conflicts.map((conflict) => (
            <li key={conflict.accelerator}>
              <strong>{conflict.accelerator}</strong> is unavailable — use the {conflict.action === 'mute-microphone' ? 'Mute' : 'Stop'} control below.
            </li>
          ))}
        </ul>
      )}
      {/* Foreground-safe controls: always reachable, even when every global shortcut conflicts. */}
      <div className="shell-controls" aria-label="Foreground-safe controls">
        <button type="button" disabled={busy} onClick={() => onControl('mute')}>
          {status?.microphone === 'muted' ? 'Unmute microphone' : 'Mute microphone'}
        </button>
        <button type="button" disabled={busy} onClick={() => onControl('stop')}>Stop speech</button>
      </div>
    </section>
  );
}
