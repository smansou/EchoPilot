/**
 * Widget-side shell status reader.
 *
 * The preload bridge is frozen for F02, so the widget reads the main process snapshot over the
 * same-origin `echo://app/shell-status` route and posts the two foreground-safe controls to
 * `echo://app/shell-action`. Both routes are served by the main process (see `main/index.ts`).
 */
import { useEffect, useState } from 'react';

export type WidgetStatus = Readonly<{
  microphone: string;
  capture: string;
  output: string;
  targetSession: string | null;
  provider: string;
  helper: 'connected' | 'disconnected';
}>;

export type ShortcutConflict = Readonly<{ action: string; accelerator: string; reason: string }>;

export type ShellSnapshot = Readonly<{
  status: WidgetStatus;
  hotkeys: Readonly<{ registered: ReadonlyArray<string>; conflicts: ReadonlyArray<ShortcutConflict> }>;
  controls: ReadonlyArray<'mute' | 'stop'>;
  coordinator: Readonly<{ muted: boolean; eventId: string | null }>;
}>;

export type WidgetControl = 'mute' | 'stop';

const HELPER_STATES = new Set(['connected', 'disconnected']);
/** Mirrors `shell.ts`: the widget renders only states the main process can actually produce. */
const ENUM_STATES: Record<'microphone' | 'capture' | 'output' | 'provider', ReadonlySet<string>> = {
  microphone: new Set(['granted', 'denied', 'unknown', 'muted']),
  capture: new Set(['granted', 'denied', 'unknown']),
  output: new Set(['ready', 'speaking', 'stopped', 'unknown']),
  provider: new Set(['local', 'cloud', 'unknown']),
};

function enumerated(value: unknown, field: 'microphone' | 'capture' | 'output' | 'provider'): string {
  if (typeof value !== 'string' || !ENUM_STATES[field].has(value)) {
    throw new TypeError(`Invalid ${field} in shell snapshot`);
  }
  return value;
}

function shortString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`Invalid ${field} in shell snapshot`);
  }
  return value;
}

function conflict(value: unknown): ShortcutConflict {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid shortcut conflict');
  const input = value as Record<string, unknown>;
  return {
    action: shortString(input.action, 'action'),
    accelerator: shortString(input.accelerator, 'accelerator'),
    reason: shortString(input.reason, 'reason'),
  };
}

/** Strict parse so a compromised or stale route can never inject extra fields into the widget. */
export function parseShellSnapshot(value: unknown): ShellSnapshot {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid shell snapshot');
  const input = value as Record<string, unknown>;
  const status = input.status;
  const hotkeys = input.hotkeys;
  if (typeof status !== 'object' || status === null) throw new TypeError('Invalid shell status');
  if (typeof hotkeys !== 'object' || hotkeys === null) throw new TypeError('Invalid hotkey report');
  const statusInput = status as Record<string, unknown>;
  const helper = statusInput.helper;
  if (typeof helper !== 'string' || !HELPER_STATES.has(helper)) throw new TypeError('Invalid helper state');
  const hotkeyInput = hotkeys as Record<string, unknown>;
  if (!Array.isArray(hotkeyInput.registered) || !Array.isArray(hotkeyInput.conflicts)) {
    throw new TypeError('Invalid hotkey report');
  }
  const targetSession = statusInput.targetSession;
  if (targetSession !== null && typeof targetSession !== 'string') throw new TypeError('Invalid target session');
  return {
    status: {
      microphone: enumerated(statusInput.microphone, 'microphone'),
      capture: enumerated(statusInput.capture, 'capture'),
      output: enumerated(statusInput.output, 'output'),
      targetSession: targetSession === null ? null : targetSession.slice(0, 128),
      provider: enumerated(statusInput.provider, 'provider'),
      helper: helper as WidgetStatus['helper'],
    },
    hotkeys: {
      registered: hotkeyInput.registered.map((accelerator) => shortString(accelerator, 'accelerator')),
      conflicts: hotkeyInput.conflicts.map(conflict),
    },
    controls: Array.isArray(input.controls)
      ? input.controls.filter((control): control is WidgetControl => control === 'mute' || control === 'stop')
      : ['mute', 'stop'],
    coordinator: {
      muted: (input.coordinator as Record<string, unknown> | undefined)?.muted === true,
      eventId: typeof (input.coordinator as Record<string, unknown> | undefined)?.eventId === 'string'
        ? String((input.coordinator as Record<string, unknown>).eventId)
        : null,
    },
  };
}

export async function fetchShellSnapshot(): Promise<ShellSnapshot> {
  const response = await fetch(new URL('shell-status', window.location.href), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Shell status route returned ${response.status}`);
  return parseShellSnapshot(await response.json());
}

export async function sendShellControl(control: WidgetControl): Promise<ShellSnapshot> {
  const response = await fetch(new URL('shell-action', window.location.href), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ control }),
  });
  if (!response.ok) throw new Error(`Shell action route returned ${response.status}`);
  return parseShellSnapshot(await response.json());
}

/** Poll the shell snapshot; the widget never blocks on a missing or reconnecting helper. */
export function useShellSnapshot(intervalMs = 1_500): ShellSnapshot | null {
  const [snapshot, setSnapshot] = useState<ShellSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchShellSnapshot();
        if (active) setSnapshot(next);
      } catch {
        // Keep the last good snapshot; a disconnected helper already renders as recoverable.
      } finally {
        if (active) timer = window.setTimeout(() => { void tick(); }, intervalMs);
      }
    };
    void tick();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [intervalMs]);
  return snapshot;
}
