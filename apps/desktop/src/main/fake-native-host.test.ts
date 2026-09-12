/**
 * F02 evidence that TypeScript developers can work the whole shell without Xcode: this drives the
 * real supervisor (`native-host.ts`) against the real fake host (`fake-native-host.ts`, spawned
 * through tsx) over the newline-delimited JSON wire protocol, including the deliberate crash.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNativeHost, type NativeHost } from './native-host';
import { createShell, type Shell, type WidgetStatus } from './shell';

const TOKEN = 'f02-fake-native-host-token-000001';
const FAKE_HOST = fileURLToPath(new URL('./fake-native-host.ts', import.meta.url));

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.fail(`timed out waiting for ${description}`);
}

type Fixture = Readonly<{
  shell: Shell;
  host: NativeHost;
  logs: string[];
  statuses: WidgetStatus[];
}>;

function fixture(env: NodeJS.ProcessEnv): Fixture {
  const shell = createShell({ token: TOKEN, register: () => true });
  const logs: string[] = [];
  const statuses: WidgetStatus[] = [];
  shell.subscribe((status) => { statuses.push(status); });
  const host = createNativeHost({
    shell,
    token: TOKEN,
    env: { ...process.env, ECHOPILOT_NATIVE_HOST: FAKE_HOST, ...env },
    restartDelayMs: 150,
    maxRestartDelayMs: 600,
    log: (message) => { logs.push(message); },
  });
  return { shell, host, logs, statuses };
}

test('the Node fake host completes the authenticated hello without Xcode', async () => {
  const run = fixture({ ECHOPILOT_FAKE_SESSION: 'session-fake', ECHOPILOT_FAKE_PROVIDER: 'cloud' });
  try {
    assert.equal(run.host.mode, 'helper', 'the fake host must be spawned, not simulated');
    run.host.start();
    await waitFor(() => run.shell.status().helper === 'connected', 'the fake-host hello');
    const status = run.shell.status();
    assert.equal(status.targetSession, 'session-fake');
    assert.equal(status.provider, 'cloud');
    assert.equal(status.microphone, 'granted');
    assert.equal(status.capture, 'denied');
    // The per-launch token is the only credential, so it must never reach the app log.
    assert.ok(
      !run.logs.some((message) => message.includes(TOKEN)),
      `token leaked into the app log: ${run.logs.join(' | ')}`,
    );
  } finally {
    run.host.dispose();
  }
});

test('a fake-host crash produces the recoverable disconnected state and reconnects', async () => {
  const run = fixture({ ECHOPILOT_FAKE_DROP_AFTER_MS: '250' });
  try {
    run.host.start();
    await waitFor(() => run.shell.status().helper === 'connected', 'the first hello');
    await waitFor(
      () => run.statuses.some((status) => status.helper === 'disconnected'),
      'the recoverable disconnected state',
    );
    await waitFor(() => run.shell.status().helper === 'connected', 'the automatic reconnect');
  } finally {
    run.host.dispose();
  }
});
