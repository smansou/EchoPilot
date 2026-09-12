/**
 * F02 shell core — the shared tracer bullet from global shortcut to widget state to native
 * permission status.
 *
 * This module is intentionally free of `electron` imports so the deterministic acceptance test
 * (`shell.test.ts`) can drive it under plain Node. `index.ts` owns the Electron seams:
 * `globalShortcut.register`, the `Tray`, and the child-process native host.
 */

export type HotkeyAction =
  | 'toggle-conversation'
  | 'hold-dictation'
  | 'mute-microphone'
  | 'stop-speech'
  | 'replay'
  | 'open-mission-control';

export type Hotkey = Readonly<{ action: HotkeyAction; accelerator: string }>;
export type HotkeyConflict = Readonly<{ action: HotkeyAction; accelerator: string; reason: string }>;

export type HelperState = 'connected' | 'disconnected';

/** Widget status surfaced to the renderer; mirrors the fields the ticket requires on screen. */
export type WidgetStatus = Readonly<{
  microphone: string;
  capture: string;
  output: string;
  targetSession: string | null;
  provider: string;
  helper: HelperState;
}>;

/** Foreground-safe widget controls that stay reachable when a global shortcut conflicts. */
export type WidgetControl = 'mute' | 'stop';

export type NativeResult =
  | { ok: true; status: WidgetStatus }
  | { ok: false; reason: string };

export type Shell = Readonly<{
  /** Every Section 4.3 default, split into the ones Electron accepted and the ones it refused. */
  hotkeys: Readonly<{
    registered: ReadonlyArray<Hotkey>;
    conflicts: ReadonlyArray<HotkeyConflict>;
  }>;
  status(): WidgetStatus;
  /** Parse one raw wire message from the signed helper; rejects malformed or unauthenticated input. */
  ingestNativeMessage(raw: string): NativeResult;
  /** The helper went away: mark the widget disconnected and report a recoverable state. */
  nativeHostDisconnected(reason?: string): WidgetStatus;
  /** Fire a hotkey action from any surface (global shortcut, tray item, widget control). */
  invoke(action: HotkeyAction): WidgetStatus;
  /** Fire a foreground-safe widget control. */
  activate(control: WidgetControl): WidgetStatus;
  /** Observe widget status changes (tray refresh, renderer push). */
  subscribe(listener: (status: WidgetStatus) => void): () => void;
  /** The accelerator actually registered for an action, or null when it conflicted. */
  registeredAccelerator(action: HotkeyAction): string | null;
}>;

/** Section 4.3 defaults. Order is the registration order and matches the documented table. */
export const HOTKEY_DEFAULTS: ReadonlyArray<Hotkey> = Object.freeze([
  Object.freeze({ action: 'toggle-conversation', accelerator: 'Option+Space' }),
  Object.freeze({ action: 'hold-dictation', accelerator: 'Control+Option+Space' }),
  Object.freeze({ action: 'mute-microphone', accelerator: 'Command+Option+M' }),
  Object.freeze({ action: 'stop-speech', accelerator: 'Command+Option+Period' }),
  Object.freeze({ action: 'replay', accelerator: 'Command+Option+R' }),
  Object.freeze({ action: 'open-mission-control', accelerator: 'Command+Option+E' }),
] satisfies ReadonlyArray<Hotkey>);

export const WIDGET_FALLBACK_CONTROLS: ReadonlyArray<WidgetControl> = Object.freeze(['mute', 'stop']);

const HOTKEY_ACTION_LABELS: Record<HotkeyAction, string> = Object.freeze({
  'toggle-conversation': 'Toggle conversation',
  'hold-dictation': 'Hold to dictate',
  'mute-microphone': 'Mute microphone',
  'stop-speech': 'Stop speech',
  replay: 'Replay latest',
  'open-mission-control': 'Open Mission Control',
});

/** Human-readable name shared by the tray menu and the widget conflict list. */
export function hotkeyActionLabel(action: HotkeyAction): string {
  return HOTKEY_ACTION_LABELS[action] ?? action;
}

/** Wire protocol revision the signed helper must echo alongside the per-launch token. */
export const NATIVE_PROTOCOL_VERSION = 1 as const;

const MICROPHONE_STATES = new Set(['granted', 'denied', 'unknown', 'muted']);
const CAPTURE_STATES = new Set(['granted', 'denied', 'unknown']);
const OUTPUT_STATES = new Set(['ready', 'speaking', 'stopped', 'unknown']);
const PROVIDER_STATES = new Set(['local', 'cloud', 'unknown']);

const DEFAULT_STATUS: WidgetStatus = Object.freeze({
  microphone: 'unknown',
  capture: 'unknown',
  output: 'ready',
  targetSession: null,
  provider: 'local',
  helper: 'disconnected',
});

export type CreateShellOptions = Readonly<{
  /** Per-launch secret the signed helper must echo in every message. */
  token: string;
  /** Electron globalShortcut seam; returns false when the accelerator is taken. */
  register(accelerator: string, callback: () => void): boolean;
  onRecoverable?(reason: string): void;
  /** Optional hook so the host app can react to actions that change nothing locally. */
  onAction?(action: HotkeyAction): void;
}>;

export function createShell(options: CreateShellOptions): Shell {
  const token = options.token;
  if (typeof token !== 'string' || token.length < 16) {
    throw new TypeError('createShell requires a per-launch helper token of at least 16 characters');
  }

  let current: WidgetStatus = DEFAULT_STATUS;
  let listeners: Array<(status: WidgetStatus) => void> = [];
  const acceleratorByAction = new Map<HotkeyAction, string>();
  const registered: Hotkey[] = [];
  const conflicts: HotkeyConflict[] = [];

  function publish(next: WidgetStatus, reason?: string): WidgetStatus {
    current = next;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // A misbehaving observer must never take down the shortcut path.
      }
    }
    if (reason) reportRecoverable(reason);
    return current;
  }

  function reportRecoverable(reason: string): void {
    if (!reason) return;
    try {
      options.onRecoverable?.(reason);
    } catch {
      // Recovery signalling is best-effort.
    }
  }

  function invoke(action: HotkeyAction): WidgetStatus {
    // Every surface (global shortcut, tray item, widget control) runs this one path, so the host
    // app can drive the real coordinator — not just widget chrome — from a single place.
    try {
      options.onAction?.(action);
    } catch {
      // The host app handles UI-affecting actions; failures stay local to that surface.
    }
    switch (action) {
      case 'mute-microphone':
        return publish({ ...current, microphone: current.microphone === 'muted' ? 'granted' : 'muted' });
      case 'stop-speech':
        return publish({ ...current, output: current.output === 'stopped' ? 'ready' : 'stopped' });
      default:
        return current;
    }
  }

  function activate(control: WidgetControl): WidgetStatus {
    return invoke(control === 'mute' ? 'mute-microphone' : 'stop-speech');
  }

  // Register every default exactly once and account for each as registered or conflicted.
  for (const hotkey of HOTKEY_DEFAULTS) {
    let accepted = false;
    try {
      accepted = options.register(hotkey.accelerator, () => { invoke(hotkey.action); }) === true;
    } catch {
      accepted = false;
    }
    if (accepted) {
      registered.push(hotkey);
      acceleratorByAction.set(hotkey.action, hotkey.accelerator);
      continue;
    }
    // The reason is shown verbatim by the tray and the widget, so it must stand alone and must
    // only point at controls that actually replace this shortcut.
    const fallback = hotkey.action === 'mute-microphone'
      ? 'use the widget Mute control or the menu-bar menu instead'
      : hotkey.action === 'stop-speech'
        ? 'use the widget Stop control or the menu-bar menu instead'
        : 'use the menu-bar menu instead';
    conflicts.push({
      ...hotkey,
      reason: `${hotkeyActionLabel(hotkey.action)} (${hotkey.accelerator}) is already claimed by `
        + `macOS or another app; ${fallback}.`,
    });
  }

  function ingestNativeMessage(raw: string): NativeResult {
    if (typeof raw !== 'string') return reject('Helper message must be a string.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return reject('Malformed helper message: not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return reject('Malformed helper message: expected a JSON object.');
    }
    const message = parsed as Record<string, unknown>;
    if (message.type !== 'hello' && message.type !== 'status') {
      return reject('Unsupported helper message type.');
    }
    if (message.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      return reject(`Unsupported native protocol version: ${String(message.protocolVersion)}.`);
    }
    if (typeof message.token !== 'string' || !timingSafeEqual(message.token, token)) {
      return reject('Helper message failed token authentication.');
    }
    const status = parseStatus(message.status);
    if (!status.ok) return reject(status.reason);
    return { ok: true, status: publish({ ...status.status, helper: 'connected' }) };
  }

  function reject(reason: string): NativeResult {
    return { ok: false, reason };
  }

  function nativeHostDisconnected(reason = 'Native helper disconnected; waiting to reconnect.'): WidgetStatus {
    return publish({ ...current, helper: 'disconnected' }, reason);
  }

  function subscribe(listener: (status: WidgetStatus) => void): () => void {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((candidate) => candidate !== listener);
    };
  }

  return Object.freeze({
    hotkeys: Object.freeze({
      registered: Object.freeze(registered.slice()),
      conflicts: Object.freeze(conflicts.slice()),
    }),
    status: () => current,
    ingestNativeMessage,
    nativeHostDisconnected,
    invoke,
    activate,
    subscribe,
    registeredAccelerator: (action: HotkeyAction) => acceleratorByAction.get(action) ?? null,
  });
}

type ParsedStatus = { ok: true; status: Omit<WidgetStatus, 'helper'> } | { ok: false; reason: string };

function parseStatus(value: unknown): ParsedStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'Malformed helper message: missing status object.' };
  }
  const status = value as Record<string, unknown>;
  const microphone = enumerate(status.microphone, MICROPHONE_STATES, 'microphone');
  if (!microphone.ok) return microphone;
  const capture = enumerate(status.capture, CAPTURE_STATES, 'capture');
  if (!capture.ok) return capture;
  const output = enumerate(status.output, OUTPUT_STATES, 'output');
  if (!output.ok) return output;
  const provider = enumerate(status.provider, PROVIDER_STATES, 'provider');
  if (!provider.ok) return provider;

  let targetSession: string | null;
  if (status.targetSession === null) {
    targetSession = null;
  } else if (typeof status.targetSession === 'string'
    && status.targetSession.trim().length > 0
    && status.targetSession.length <= 128) {
    targetSession = status.targetSession;
  } else {
    return { ok: false, reason: 'Malformed helper message: invalid targetSession.' };
  }

  return {
    ok: true,
    status: { microphone: microphone.value, capture: capture.value, output: output.value, targetSession, provider: provider.value },
  };
}

type Enumerated = { ok: true; value: string } | { ok: false; reason: string };

function enumerate(value: unknown, allowed: Set<string>, field: string): Enumerated {
  if (typeof value !== 'string' || !allowed.has(value)) {
    return { ok: false, reason: `Malformed helper message: invalid ${field}.` };
  }
  return { ok: true, value };
}

/** Constant-time token comparison so a bad helper cannot probe the secret byte by byte. */
function timingSafeEqual(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
