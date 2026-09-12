/**
 * Regression tests for the F02 native-host repairs, driven through the real supervisor and real
 * child processes (a TypeScript fake helper, so no Xcode is involved):
 *
 * 1. Restart backoff must actually grow for a helper that crashes before its authenticated hello.
 * 2. Backoff must reset once a helper completes the hello handshake (otherwise a healthy helper
 *    keeps inheriting a previous crash's delay).
 * 3. The per-launch token must never reach the app log, not even through a raw helper log frame.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeHost, type NativeHost } from './native-host';
import { createShell } from './shell';

const TOKEN = 'f02-native-host-regression-token-0001';

const CRASH_BEFORE_HELLO = 'process.exit(1);\n';

const HELLO_THEN_DIE = `
const token = process.env.ECHOPILOT_NATIVE_TOKEN ?? '';
const status = { microphone: 'granted', capture: 'denied', output: 'ready', targetSession: 'hello-session', provider: 'local' };
process.stdout.write(JSON.stringify({ type: 'hello', protocolVersion: 1, token, status }) + '\\n');
setTimeout(() => process.exit(1), 40);
`;

const CHATTY_HELPER = `
const token = process.env.ECHOPILOT_NATIVE_TOKEN ?? '';
const status = { microphone: 'granted', capture: 'denied', output: 'ready', targetSession: 'chatty-session', provider: 'local' };
process.stdout.write(JSON.stringify({ type: 'log', protocolVersion: 1, token, message: 'helper says hi' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'hello', protocolVersion: 1, token, status }) + '\\n');
setInterval(() => {}, 1000);
`;

type Harness = Readonly<{
  host: NativeHost;
  starts: number[];
  disconnects: number[];
  logs: string[];
  directory: string;
}>;

async function harness(script: string, options: Readonly<{ restartDelayMs: number; maxRestartDelayMs: number }>): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'f02-native-host-'));
  const helperPath = join(directory, 'helper.ts');
  await writeFile(helperPath, script, 'utf8');
  const shell = createShell({ token: TOKEN, register: () => true });
  const starts: number[] = [];
  const disconnects: number[] = [];
  const logs: string[] = [];
  shell.subscribe((status) => {
    if (status.helper === 'disconnected') disconnects.push(performance.now());
  });
  const host = createNativeHost({
    shell,
    token: TOKEN,
    env: { ...process.env, ECHOPILOT_NATIVE_HOST: helperPath },
    restartDelayMs: options.restartDelayMs,
    maxRestartDelayMs: options.maxRestartDelayMs,
    log: (message) => {
      logs.push(message);
      if (message.includes('native helper started')) starts.push(performance.now());
    },
  });
  return { host, starts, disconnects, logs, directory };
}

/** Timer delays measured from each disconnect to the next spawn. */
function restartGaps(starts: ReadonlyArray<number>, disconnects: ReadonlyArray<number>): number[] {
  return disconnects
    .map((at, index) => (starts[index + 1] ?? Number.NaN) - at)
    .filter((gap) => Number.isFinite(gap));
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

test('backoff grows when a helper crashes before its hello', async () => {
  const run = await harness(CRASH_BEFORE_HELLO, { restartDelayMs: 200, maxRestartDelayMs: 800 });
  try {
    run.host.start();
    await sleep(4_200);
    const gaps = restartGaps(run.starts, run.disconnects);
    assert.ok(gaps.length >= 3, `expected at least 3 restarts, saw ${gaps.length}: ${gaps.join(', ')}`);
    const [first, second, third] = gaps as [number, number, number];
    assert.ok(first >= 150 && first <= 320, `first restart should use the 200 ms base delay, got ${first.toFixed(0)} ms`);
    assert.ok(second >= first * 1.6 && second <= first * 2.4, `backoff did not double: ${first.toFixed(0)} -> ${second.toFixed(0)} ms`);
    assert.ok(third >= second * 1.3, `backoff did not keep growing: ${second.toFixed(0)} -> ${third.toFixed(0)} ms`);
    assert.ok(Math.max(...gaps) <= 800 * 1.3, `restart delay exceeded maxRestartDelayMs: ${Math.max(...gaps).toFixed(0)} ms`);
  } finally {
    run.host.dispose();
    await rm(run.directory, { recursive: true, force: true });
  }
});

test('backoff resets after a helper completes its hello', async () => {
  const run = await harness(HELLO_THEN_DIE, { restartDelayMs: 200, maxRestartDelayMs: 5_000 });
  try {
    run.host.start();
    await sleep(4_200);
    const gaps = restartGaps(run.starts, run.disconnects);
    assert.ok(gaps.length >= 4, `expected at least 4 healthy restarts, saw ${gaps.length}: ${gaps.join(', ')}`);
    for (const gap of gaps) {
      assert.ok(gap >= 150 && gap <= 360, `a healthy helper must restart at the 200 ms base delay, got ${gap.toFixed(0)} ms`);
    }
  } finally {
    run.host.dispose();
    await rm(run.directory, { recursive: true, force: true });
  }
});

test('the per-launch token never reaches the app log', async () => {
  const run = await harness(CHATTY_HELPER, { restartDelayMs: 200, maxRestartDelayMs: 5_000 });
  try {
    run.host.start();
    await sleep(1_500);
    assert.ok(run.logs.some((message) => message.includes('helper says hi')), `helper log was dropped: ${run.logs.join(' | ')}`);
    assert.ok(!run.logs.some((message) => message.includes(TOKEN)), `token leaked into app log: ${run.logs.join(' | ')}`);
    assert.ok(!run.logs.some((message) => message.includes('"token"')), `raw helper frame reached app log: ${run.logs.join(' | ')}`);
  } finally {
    run.host.dispose();
    await rm(run.directory, { recursive: true, force: true });
  }
});
