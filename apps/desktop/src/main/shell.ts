/**
 * F02 shell core — the shared tracer bullet from global shortcut to widget state to native
 * permission status.
 *
 * This module is intentionally free of `electron` imports so the deterministic acceptance test
 * (`shell.test.ts`) can drive it under plain Node. `index.ts` owns the Electron seams:
 * `globalShortcut.register`, the `Tray`, and the child-process native host.
 */

import type { ActivationSnapshot } from '../../../../packages/voice/src/activation';

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
  | { ok: true; ack: VoiceWireAck }
  | { ok: true; observation: VoiceWireObservation }
  | { ok: false; reason: string };

export type Shell = Readonly<{
  /** Every Section 4.3 default, split into the ones Electron accepted and the ones it refused. */
  hotkeys: Readonly<{
    registered: ReadonlyArray<Hotkey>;
    conflicts: ReadonlyArray<HotkeyConflict>;
  }>;
  status(): WidgetStatus;
  /**
   * Parse one raw wire message from the signed helper; rejects malformed or unauthenticated input.
   * Voice frames (`voice-ack`, `voice-observation`) authenticate the same way and are returned as
   * `ack` / `observation` results, so the token check stays the single gateway to helper input.
   */
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
  /**
   * Send one voice command to the signed helper and await its authenticated `voice-ack`. Resolves —
   * never rejects — so a lifecycle step can always decide what to do about a missing helper.
   */
  sendVoiceCommand(name: VoiceWireCommandName, params?: { mode?: 'conversation' | 'standby' }): Promise<VoiceCommandOutcome>;
  /** Mirror of the activation lifecycle; publishing it never mutates widget status. */
  publishVoice(snapshot: VoiceSnapshot): VoiceSnapshot;
  voiceSnapshot(): VoiceSnapshot;
  /** Observe lifecycle changes (tray label, widget indicator); never a wake-candidate channel. */
  subscribeVoice(listener: (snapshot: VoiceSnapshot) => void): () => void;
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
  'hold-dictation': 'Toggle dictation capture',
  'mute-microphone': 'Mute microphone',
  'stop-speech': 'Stop speech',
  replay: 'Replay latest',
  'open-mission-control': 'Open Cleo',
});

/** Human-readable name shared by the tray menu and the widget conflict list. */
export function hotkeyActionLabel(action: HotkeyAction): string {
  return HOTKEY_ACTION_LABELS[action] ?? action;
}

/** Wire protocol revision the signed helper must echo alongside the per-launch token. */
export const NATIVE_PROTOCOL_VERSION = 1 as const;

/**
 * V05 voice activation frames.
 *
 * The lifecycle itself lives in `packages/voice/src/activation`; this is only the wire half of it.
 * `voice-command` travels to the helper on its private stdin, and the helper answers with a
 * `voice-ack` plus `voice-observation` frames (standby energy samples and acoustic windows) that
 * always echo the per-launch token. An observation never carries a wall-clock timestamp: the app's
 * own clock stamps activity and idle leases, so a helper with a different monotonic clock cannot
 * shift them.
 */
export type VoiceAcousticEnvironment = 'quiet' | 'background_speech' | 'tv' | 'other';

export const VOICE_ACOUSTIC_ENVIRONMENTS: ReadonlyArray<VoiceAcousticEnvironment> = Object.freeze([
  'quiet',
  'background_speech',
  'tv',
  'other',
]);

export type VoiceWireCommandName =
  | 'open-microphone'
  | 'close-microphone'
  | 'load-wake-model'
  | 'unload-wake-model';

export type VoiceWireCommand = Readonly<{
  id: string;
  name: VoiceWireCommandName;
  mode?: 'conversation' | 'standby';
}>;

/** One measured standby reading from the helper's sampler. */
export type VoiceWireSample = Readonly<{
  durationMs: number;
  cpuPercent: number;
  wakeups: number;
  residentMemoryMb: number | null;
}>;

/** The helper's own duration-weighted gate, structurally identical to `StandbyEnergyReport`. */
export type VoiceWireEnergyReport = Readonly<{
  durationMs: number;
  averageCpuPercent: number;
  wakeupsPerMinute: number;
  peakResidentMemoryMb: number;
  sampleCount: number;
  passed: boolean;
  violations: ReadonlyArray<string>;
}>;

export type VoiceWireObservation =
  | Readonly<{ kind: 'standby-energy'; sample: VoiceWireSample; report: VoiceWireEnergyReport }>
  | Readonly<{
    kind: 'standby-window';
    environment: VoiceAcousticEnvironment;
    durationMs: number;
    detected: boolean;
    confidence: number;
    threshold: number;
  }>;

export type VoiceWireAck = Readonly<{ id: string; ok: boolean; error?: string }>;

/**
 * The widget-facing mirror of the activation lifecycle. It is deliberately a plain snapshot: the
 * renderer never sees a host handle, a wake candidate, or anything that could authorize an action.
 */
export type VoiceSnapshot = Readonly<{
  state: 'disabled' | 'active' | 'standby' | 'idle' | 'failed';
  enabled: boolean;
  microphoneOpen: boolean;
  conversationModelsLoaded: boolean;
  wakeModelLoaded: boolean;
  standbyEnabled: boolean;
  lastActivityAt: number | null;
  failure: string | null;
}>;

export const VOICE_DISABLED_SNAPSHOT: VoiceSnapshot = Object.freeze({
  state: 'disabled',
  enabled: false,
  microphoneOpen: false,
  conversationModelsLoaded: false,
  wakeModelLoaded: false,
  standbyEnabled: false,
  lastActivityAt: null,
  failure: null,
});

export type VoiceCommandOutcome = Readonly<{ ok: boolean; reason?: string }>;

/**
 * A command the helper never acknowledged must not keep a lifecycle step hanging: the activation
 * controller awaits these, and a stalled await would leave the microphone in an unknown state.
 */
export const VOICE_COMMAND_TIMEOUT_MS = 5_000;

/** Projects the activation package's snapshot onto the wire/renderer shape. */
export function voiceSnapshotFrom(snapshot: ActivationSnapshot): VoiceSnapshot {
  return {
    state: snapshot.state,
    enabled: snapshot.enabled,
    microphoneOpen: snapshot.microphoneOpen,
    conversationModelsLoaded: snapshot.conversationModelsLoaded,
    wakeModelLoaded: snapshot.wakeModelLoaded,
    standbyEnabled: snapshot.standbyEnabled,
    lastActivityAt: snapshot.lastActivityAt,
    failure: snapshot.failure ?? null,
  };
}

/** Serializes one command for the helper's stdin; the id pairs it with the helper's `voice-ack`. */
export function serializeVoiceCommand(command: VoiceWireCommand): string {
  return JSON.stringify({
    type: 'voice-command',
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    id: command.id,
    name: command.name,
    ...(command.mode === undefined ? {} : { mode: command.mode }),
  });
}

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
  /**
   * Writes one serialized protocol line to the helper's private stdin. Returns false when no
   * helper is attached, so a voice command fails fast instead of waiting out the ack timeout.
   */
  writeToHelper?(line: string): boolean;
}>;

export function createShell(options: CreateShellOptions): Shell {
  const token = options.token;
  if (typeof token !== 'string' || token.length < 16) {
    throw new TypeError('createShell requires a per-launch helper token of at least 16 characters');
  }

  let current: WidgetStatus = DEFAULT_STATUS;
  let listeners: Array<(status: WidgetStatus) => void> = [];
  let voice: VoiceSnapshot = VOICE_DISABLED_SNAPSHOT;
  let voiceListeners: Array<(snapshot: VoiceSnapshot) => void> = [];
  const pendingVoiceCommands = new Map<string, { resolve(outcome: VoiceCommandOutcome): void; timer: NodeJS.Timeout }>();
  let voiceCommandCounter = 0;
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

  function publishVoice(next: VoiceSnapshot): VoiceSnapshot {
    voice = { ...next };
    for (const listener of voiceListeners) {
      try {
        listener(voice);
      } catch {
        // A misbehaving indicator observer must never break the lifecycle mirror.
      }
    }
    return voice;
  }

  function settleVoiceCommand(id: string, outcome: VoiceCommandOutcome): boolean {
    const pending = pendingVoiceCommands.get(id);
    if (!pending) return false;
    pendingVoiceCommands.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
    return true;
  }

  /** Fails every in-flight command; used when the helper goes away mid-command. */
  function failPendingVoiceCommands(reason: string): void {
    for (const id of [...pendingVoiceCommands.keys()]) settleVoiceCommand(id, { ok: false, reason });
  }

  function sendVoiceCommand(
    name: VoiceWireCommandName,
    params?: { mode?: 'conversation' | 'standby' },
  ): Promise<VoiceCommandOutcome> {
    voiceCommandCounter += 1;
    const command: VoiceWireCommand = {
      id: `voice-${voiceCommandCounter}`,
      name,
      ...(params?.mode === undefined ? {} : { mode: params.mode }),
    };
    let written = false;
    try {
      written = options.writeToHelper?.(serializeVoiceCommand(command)) === true;
    } catch {
      written = false;
    }
    if (!written) {
      return Promise.resolve({ ok: false, reason: 'The signed voice helper is not connected.' });
    }
    return new Promise<VoiceCommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        pendingVoiceCommands.delete(command.id);
        reportRecoverable(`The signed voice helper did not acknowledge '${name}' in time.`);
        resolve({ ok: false, reason: `The signed voice helper did not acknowledge '${name}' in time.` });
      }, VOICE_COMMAND_TIMEOUT_MS);
      timer.unref?.();
      pendingVoiceCommands.set(command.id, { resolve, timer });
    });
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
    const type = message.type;
    if (type !== 'hello' && type !== 'status' && type !== 'voice-ack' && type !== 'voice-observation') {
      return reject('Unsupported helper message type.');
    }
    if (message.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      return reject(`Unsupported native protocol version: ${String(message.protocolVersion)}.`);
    }
    if (typeof message.token !== 'string' || !timingSafeEqual(message.token, token)) {
      return reject('Helper message failed token authentication.');
    }
    if (type === 'voice-ack') {
      const ack = parseVoiceAck(message);
      if (!ack.ok) return reject(ack.reason);
      // A late or repeated ack is still a valid frame: it settles nothing, but it is not a
      // protocol error either, so widget status and the lifecycle mirror both stay untouched.
      settleVoiceCommand(ack.ack.id, ack.ack.ok
        ? { ok: true }
        : { ok: false, reason: ack.ack.error ?? 'The signed voice helper rejected the command.' });
      return { ok: true, ack: ack.ack };
    }
    if (type === 'voice-observation') {
      const observation = parseVoiceObservation(message.observation);
      return observation.ok ? { ok: true, observation: observation.observation } : reject(observation.reason);
    }
    const status = parseStatus(message.status);
    if (!status.ok) return reject(status.reason);
    return { ok: true, status: publish({ ...status.status, helper: 'connected' }) };
  }

  function reject(reason: string): NativeResult {
    return { ok: false, reason };
  }

  function nativeHostDisconnected(reason = 'Native helper disconnected; waiting to reconnect.'): WidgetStatus {
    failPendingVoiceCommands(reason);
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
    sendVoiceCommand,
    publishVoice,
    voiceSnapshot: () => voice,
    subscribeVoice: (listener: (snapshot: VoiceSnapshot) => void) => {
      voiceListeners.push(listener);
      return () => {
        voiceListeners = voiceListeners.filter((candidate) => candidate !== listener);
      };
    },
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

type ParsedVoiceAck = { ok: true; ack: VoiceWireAck } | { ok: false; reason: string };

function parseVoiceAck(message: Record<string, unknown>): ParsedVoiceAck {
  const id = message.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    return { ok: false, reason: 'Malformed voice ack: invalid command id.' };
  }
  if (typeof message.ok !== 'boolean') {
    return { ok: false, reason: 'Malformed voice ack: missing ok flag.' };
  }
  if (message.ok === false && message.error !== undefined && typeof message.error !== 'string') {
    return { ok: false, reason: 'Malformed voice ack: invalid error text.' };
  }
  const error = typeof message.error === 'string' ? message.error.slice(0, 200) : undefined;
  return { ok: true, ack: { id, ok: message.ok, ...(error === undefined ? {} : { error }) } };
}

type ParsedObservation = { ok: true; observation: VoiceWireObservation } | { ok: false; reason: string };

function parseVoiceObservation(value: unknown): ParsedObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'Malformed voice observation: expected an object.' };
  }
  const observation = value as Record<string, unknown>;
  switch (observation.kind) {
    case 'standby-energy': {
      const sample = parseVoiceSample(observation.sample);
      if (!sample.ok) return sample;
      const report = parseVoiceEnergyReport(observation.report);
      if (!report.ok) return report;
      return { ok: true, observation: { kind: 'standby-energy', sample: sample.sample, report: report.report } };
    }
    case 'standby-window': {
      const environment = observation.environment;
      if (typeof environment !== 'string'
        || !VOICE_ACOUSTIC_ENVIRONMENTS.includes(environment as VoiceAcousticEnvironment)) {
        return { ok: false, reason: 'Malformed voice observation: invalid acoustic environment.' };
      }
      const durationMs = positiveNumber(observation.durationMs);
      if (durationMs === null) return { ok: false, reason: 'Malformed voice observation: invalid window duration.' };
      if (typeof observation.detected !== 'boolean') {
        return { ok: false, reason: 'Malformed voice observation: missing detection flag.' };
      }
      const confidence = unitInterval(observation.confidence);
      if (confidence === null) return { ok: false, reason: 'Malformed voice observation: invalid confidence.' };
      const threshold = unitInterval(observation.threshold);
      if (threshold === null) return { ok: false, reason: 'Malformed voice observation: invalid threshold.' };
      return {
        ok: true,
        observation: {
          kind: 'standby-window',
          environment: environment as VoiceAcousticEnvironment,
          durationMs,
          detected: observation.detected,
          confidence,
          threshold,
        },
      };
    }
    default:
      return { ok: false, reason: 'Malformed voice observation: unknown kind.' };
  }
}

type ParsedSample = { ok: true; sample: VoiceWireSample } | { ok: false; reason: string };

function parseVoiceSample(value: unknown): ParsedSample {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'Malformed standby sample: expected an object.' };
  }
  const sample = value as Record<string, unknown>;
  const durationMs = positiveNumber(sample.durationMs);
  if (durationMs === null) return { ok: false, reason: 'Malformed standby sample: invalid duration.' };
  const cpuPercent = nonNegativeNumber(sample.cpuPercent);
  if (cpuPercent === null) return { ok: false, reason: 'Malformed standby sample: invalid CPU reading.' };
  const wakeups = nonNegativeNumber(sample.wakeups);
  if (wakeups === null) return { ok: false, reason: 'Malformed standby sample: invalid wakeup count.' };
  const memory = sample.residentMemoryMb === null || sample.residentMemoryMb === undefined
    ? null
    : nonNegativeNumber(sample.residentMemoryMb);
  if (sample.residentMemoryMb !== null && sample.residentMemoryMb !== undefined && memory === null) {
    return { ok: false, reason: 'Malformed standby sample: invalid memory reading.' };
  }
  return { ok: true, sample: { durationMs, cpuPercent, wakeups: Math.round(wakeups), residentMemoryMb: memory } };
}

type ParsedEnergyReport = { ok: true; report: VoiceWireEnergyReport } | { ok: false; reason: string };

function parseVoiceEnergyReport(value: unknown): ParsedEnergyReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'Malformed standby report: expected an object.' };
  }
  const report = value as Record<string, unknown>;
  const durationMs = nonNegativeNumber(report.durationMs);
  const averageCpuPercent = nonNegativeNumber(report.averageCpuPercent);
  const wakeupsPerMinute = nonNegativeNumber(report.wakeupsPerMinute);
  const peakResidentMemoryMb = nonNegativeNumber(report.peakResidentMemoryMb);
  const sampleCount = nonNegativeNumber(report.sampleCount);
  if (durationMs === null || averageCpuPercent === null || wakeupsPerMinute === null
    || peakResidentMemoryMb === null || sampleCount === null || typeof report.passed !== 'boolean') {
    return { ok: false, reason: 'Malformed standby report: invalid gate reading.' };
  }
  const violations = Array.isArray(report.violations)
    ? report.violations.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
    : null;
  if (!violations || violations.length !== (report.violations as ReadonlyArray<unknown>).length) {
    return { ok: false, reason: 'Malformed standby report: invalid violations.' };
  }
  return {
    ok: true,
    report: {
      durationMs,
      averageCpuPercent,
      wakeupsPerMinute,
      peakResidentMemoryMb,
      sampleCount: Math.round(sampleCount),
      passed: report.passed,
      violations,
    },
  };
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function unitInterval(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
