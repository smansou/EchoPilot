/**
 * F02 acceptance test — initial shared shell tracer bullet:
 * Global shortcut → widget state → native permission status.
 *
 * Electron itself cannot be launched in the deterministic check environment, so this test drives
 * the main-process shell contract directly. `apps/desktop/src/main/shell.ts` must export:
 *
 *   HOTKEY_DEFAULTS
 *     The Section 4.3 defaults: Option-Space toggles conversation; Control-Option-Space holds
 *     dictation; Command-Option-M mutes the microphone; Command-Option-period stops speech;
 *     Command-Option-R replays; Command-Option-E opens Mission Control.
 *
 *   WIDGET_FALLBACK_CONTROLS
 *     Foreground-safe widget controls that stay reachable when a global shortcut conflicts.
 *     Must include `mute` and `stop`.
 *
 *   createShell({ token, register, onRecoverable }) → Shell
 *     register(accelerator, callback) is the Electron globalShortcut seam. It returns false when
 *     registration conflicts. createShell must call it once per default and account for every
 *     default as either `registered` or a `conflicts` entry with a non-empty reason.
 *     token is the per-launch secret the signed native helper must echo in every message.
 *     Shell.status() surfaces microphone, capture, output, targetSession, provider, and helper
 *     (widget status). Shell.ingestNativeMessage(raw) parses one raw wire message and rejects
 *     malformed JSON and wrong-token messages without mutating widget status.
 *     Shell.nativeHostDisconnected() produces the recoverable disconnected state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const TOKEN = 'f02-synthetic-native-helper-token';

type HotkeyAction =
  | 'toggle-conversation'
  | 'hold-dictation'
  | 'mute-microphone'
  | 'stop-speech'
  | 'replay'
  | 'open-mission-control';

type Hotkey = Readonly<{ action: HotkeyAction; accelerator: string }>;

type WidgetStatus = Readonly<{
  microphone: string;
  capture: string;
  output: string;
  targetSession: string | null;
  provider: string;
  helper: 'connected' | 'disconnected';
}>;

type NativeResult = { ok: true; status: WidgetStatus } | { ok: false; reason: string };

type Shell = Readonly<{
  hotkeys: Readonly<{
    registered: ReadonlyArray<Hotkey>;
    conflicts: ReadonlyArray<Hotkey & { reason: string }>;
  }>;
  status(): WidgetStatus;
  ingestNativeMessage(raw: string): NativeResult;
  nativeHostDisconnected(): WidgetStatus;
}>;

type ShellModule = Readonly<{
  HOTKEY_DEFAULTS: ReadonlyArray<Hotkey>;
  WIDGET_FALLBACK_CONTROLS: ReadonlyArray<'mute' | 'stop'>;
  createShell(options: {
    token: string;
    register(accelerator: string, callback: () => void): boolean;
    onRecoverable?(reason: string): void;
  }): Shell;
}>;

const EXPECTED_HOTKEYS: ReadonlyArray<Hotkey> = [
  { action: 'toggle-conversation', accelerator: 'Option+Space' },
  { action: 'hold-dictation', accelerator: 'Control+Option+Space' },
  { action: 'mute-microphone', accelerator: 'Command+Option+M' },
  { action: 'stop-speech', accelerator: 'Command+Option+Period' },
  { action: 'replay', accelerator: 'Command+Option+R' },
  { action: 'open-mission-control', accelerator: 'Command+Option+E' },
];

let shellModulePromise: Promise<ShellModule> | undefined;

function loadShellModule(): Promise<ShellModule> {
  shellModulePromise ??= (async () => {
    const fail = (detail: string): never => assert.fail(
      'F02 required shell behavior is not implemented yet: apps/desktop/src/main/shell.ts '
      + `must export HOTKEY_DEFAULTS, WIDGET_FALLBACK_CONTROLS, and createShell(...). ${detail}`,
    );
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import('./shell.js')) as unknown as Record<string, unknown>;
    } catch (error) {
      return fail(`Shell module could not be loaded: ${(error as Error).message}`);
    }
    if (!Array.isArray(loaded.HOTKEY_DEFAULTS)) return fail('HOTKEY_DEFAULTS is not exported');
    if (!Array.isArray(loaded.WIDGET_FALLBACK_CONTROLS)) return fail('WIDGET_FALLBACK_CONTROLS is not exported');
    if (typeof loaded.createShell !== 'function') return fail('createShell({ token, register, onRecoverable }) is not exported');
    return loaded as unknown as ShellModule;
  })();
  return shellModulePromise;
}

function createFixture(conflictAccelerator?: string) {
  const callbacks = new Map<string, () => void>();
  const recoveries: string[] = [];
  const shell = shellModule.createShell({
    token: TOKEN,
    register(accelerator, callback) {
      if (accelerator === conflictAccelerator) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    onRecoverable: (reason) => { recoveries.push(reason); },
  });
  return { shell, callbacks, recoveries };
}

let shellModule: ShellModule;

test('Section 4.3 hotkeys register or report a conflict, and mute/stop stay reachable', async () => {
  shellModule = await loadShellModule();
  const sortedDefaults = [...shellModule.HOTKEY_DEFAULTS]
    .map(({ action, accelerator }) => `${action}=${accelerator}`)
    .sort();
  const sortedExpected = EXPECTED_HOTKEYS.map(({ action, accelerator }) => `${action}=${accelerator}`).sort();
  assert.deepEqual(sortedDefaults, sortedExpected);
  assert.deepEqual([...shellModule.WIDGET_FALLBACK_CONTROLS].sort(), ['mute', 'stop']);

  const clean = createFixture();
  assert.equal(clean.shell.hotkeys.conflicts.length, 0);
  assert.equal(clean.shell.hotkeys.registered.length, EXPECTED_HOTKEYS.length);

  const muted = clean.callbacks.get('Command+Option+M');
  assert.equal(typeof muted, 'function');
  muted!();
  assert.equal(clean.shell.status().microphone, 'muted');

  const stopped = clean.callbacks.get('Command+Option+Period');
  assert.equal(typeof stopped, 'function');
  stopped!();
  assert.equal(clean.shell.status().output, 'stopped');

  const conflicted = createFixture('Command+Option+M');
  assert.equal(conflicted.shell.hotkeys.conflicts.length, 1);
  const conflict = conflicted.shell.hotkeys.conflicts[0]!;
  assert.equal(conflict.action, 'mute-microphone');
  assert.equal(conflict.accelerator, 'Command+Option+M');
  assert.ok(conflict.reason.trim().length > 0, 'a conflict must explain why registration failed');
  assert.equal(conflicted.shell.hotkeys.registered.length + conflicted.shell.hotkeys.conflicts.length, EXPECTED_HOTKEYS.length);
  assert.ok(
    conflicted.shell.hotkeys.registered.some(({ action }) => action === 'stop-speech'),
    'an unrelated shortcut must still register when another shortcut conflicts',
  );
});

test('native helper hello/status is authenticated, rejects malformed input, and reconnects after disconnect', async () => {
  shellModule = await loadShellModule();
  const { shell, recoveries } = createFixture();
  const before = shell.status();
  assert.equal(before.helper, 'disconnected');

  const unauthenticated = shell.ingestNativeMessage(nativeMessage({ token: 'wrong-token' }));
  assert.equal(unauthenticated.ok, false);
  assert.ok(!unauthenticated.ok && unauthenticated.reason.trim().length > 0);

  const malformed = shell.ingestNativeMessage('{ definitely not json');
  assert.equal(malformed.ok, false);
  assert.deepEqual(shell.status(), before, 'rejected helper messages must not change widget state');

  const hello = shell.ingestNativeMessage(nativeMessage());
  assert.equal(hello.ok, true);
  assert.deepEqual(shell.status(), {
    microphone: 'granted',
    capture: 'denied',
    output: 'ready',
    targetSession: 'session-42',
    provider: 'local',
    helper: 'connected',
  });

  const disconnected = shell.nativeHostDisconnected();
  assert.equal(disconnected.helper, 'disconnected');
  assert.ok(recoveries.length > 0, 'disconnect must report a recoverable state');

  const reconnect = shell.ingestNativeMessage(nativeMessage({
    status: {
      microphone: 'denied',
      capture: 'granted',
      output: 'ready',
      targetSession: 'session-43',
      provider: 'cloud',
    },
  }));
  assert.equal(reconnect.ok, true);
  assert.equal(shell.status().helper, 'connected');
  assert.equal(shell.status().targetSession, 'session-43');
  assert.equal(shell.status().provider, 'cloud');
});

function nativeMessage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    token: TOKEN,
    status: {
      microphone: 'granted',
      capture: 'denied',
      output: 'ready',
      targetSession: 'session-42',
      provider: 'local',
    },
    ...overrides,
  });
}
