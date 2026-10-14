/**
 * Regression tests for the C05 desktop observation seam. Every case runs through the real
 * `createDesktopObserveHost` with a fake child (or a real Node fixture) so no Xcode, no AX
 * permission, and no live frontmost application is needed:
 *
 *  - one validated observe request per spawn, one bounded response, one termination;
 *  - an invalid scope is refused before any helper is spawned;
 *  - denied / excluded / no-window / empty failures keep their precise native code;
 *  - malformed, oversized, crashed, and hung helpers collapse to stable categories;
 *  - the packaged helper location and diagnostics are derived from the bundle, not the cwd.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createDesktopObserveHost,
  desktopObserveDiagnostics,
  type DesktopObserveChild,
} from './desktop-observe';

const PROJECT = 'project-0123456789abcdef';
const HELPER = '/app/dist/native/echopilot-desktop';

class TestChild implements DesktopObserveChild {
  readonly writes: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly stdin = {
    write: (data: string): boolean => {
      this.writes.push(data);
      this.onWrite?.(data);
      return true;
    },
  };
  readonly stdout = {
    setEncoding: (): undefined => undefined,
    on: (event: 'data', listener: (chunk: string | Buffer) => void): undefined => {
      assert.equal(event, 'data');
      this.dataListeners.push(listener);
      return undefined;
    },
  };
  readonly stderr = null;
  onWrite: ((data: string) => void) | null = null;
  private readonly dataListeners: Array<(chunk: string | Buffer) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error' | 'exit', listener: unknown): this {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    return this;
  }

  send(chunk: string): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'desktop_observe',
    observedAtMs: 1_759_000_000_000,
    projectId: PROJECT,
    application: { pid: 501, bundleId: 'com.apple.TextEdit', name: 'TextEdit', bundleIdTruncated: false, nameTruncated: false },
    window: { role: 'AXWindow', roleTruncated: false, title: 'Untitled', titleTruncated: false },
    nodes: [{
      depth: 1, role: 'AXStaticText', label: 'Hello', labelTruncated: false,
      valueTruncated: false, redacted: false, roleTruncated: false, subroleTruncated: false,
    }],
    quality: 'full',
    truncated: false,
    truncations: [],
    stats: { visitedNodes: 1, emittedNodes: 1, maxDepthReached: 1, estimatedBytes: 180 },
    ...overrides,
  };
}

function successLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, result: { type: 'json', payload: JSON.stringify(evidence(overrides)) } });
}

function refusalLine(code: string): string {
  return JSON.stringify({ ok: false, error: `observe:${code}` });
}

function harness(): Readonly<{
  host: ReturnType<typeof createDesktopObserveHost>;
  child: TestChild;
  spawns: Array<{ command: string; args: readonly string[] }>;
}> {
  const child = new TestChild();
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const host = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    helperPath: HELPER,
    exists: () => true,
    spawn: (command, args) => {
      spawns.push({ command, args });
      return child;
    },
    timeoutMs: 250,
  });
  return { host, child, spawns };
}

test('one observation spawns one helper, sends one observe request, and returns validated evidence', async () => {
  const { host, child, spawns } = harness();
  child.onWrite = () => child.send(`${successLine()}\n`);
  const result = await host.observe({ projectId: PROJECT });
  assert.equal(result.outcome, 'observed');
  if (result.outcome !== 'observed') return;
  assert.equal(result.evidence.kind, 'desktop_observe');
  assert.equal(result.evidence.projectId, PROJECT);
  assert.equal(result.evidence.application.bundleId, 'com.apple.TextEdit');
  assert.equal(result.evidence.nodes.length, 1);
  assert.equal(result.evidence.nodes[0]?.label, 'Hello');
  assert.equal(result.evidence.nodes[0]?.subrole, null);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.command, HELPER);
  assert.deepEqual(spawns[0]?.args, []);
  assert.equal(child.writes.length, 1);
  assert.deepEqual(JSON.parse(child.writes[0]!), {
    operation: 'observe',
    scope: { profileId: 'local', projectId: PROJECT, sensitivity: 'normal' },
  });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('an invalid project scope is refused before any helper is spawned', async () => {
  const { host, child, spawns } = harness();
  for (const projectId of ['', '   ', 'x'.repeat(257), 42, null]) {
    const result = await host.observe({ projectId });
    assert.equal(result.outcome, 'invalid_scope', `expected invalid_scope for ${JSON.stringify(projectId)}`);
  }
  assert.equal(spawns.length, 0);
  assert.equal(child.writes.length, 0);
});

test('a whitespace-padded project id is normalized before it reaches the helper', async () => {
  const { host, child } = harness();
  child.onWrite = () => child.send(`${successLine()}\n`);
  const result = await host.observe({ projectId: `  ${PROJECT}  ` });
  assert.equal(result.outcome, 'observed');
  assert.deepEqual(JSON.parse(child.writes[0]!).scope.projectId, PROJECT);
});

test('accessibility denial keeps its precise native code', async () => {
  const { host, child } = harness();
  child.onWrite = () => child.send(`${refusalLine('accessibility_denied')}\n`);
  const result = await host.observe({ projectId: PROJECT });
  assert.deepEqual(result, { outcome: 'denied', code: 'accessibility_denied', detail: null });
});

test('excluded, no-window, and empty-evidence failures keep their codes and bounded detail', async () => {
  const cases: ReadonlyArray<{ line: string; code: string; detail: string | null }> = [
    { line: refusalLine('excluded_application:com.apple.Safari'), code: 'excluded_application', detail: 'com.apple.Safari' },
    { line: refusalLine('no_window:no_focused_or_main_window'), code: 'no_window', detail: 'no_focused_or_main_window' },
    { line: refusalLine('empty_evidence:com.apple.Safari'), code: 'empty_evidence', detail: 'com.apple.Safari' },
    { line: refusalLine(`empty_evidence:${'b'.repeat(400)}`), code: 'empty_evidence', detail: 'b'.repeat(256) },
  ];
  for (const expected of cases) {
    const { host, child } = harness();
    child.onWrite = () => child.send(`${expected.line}\n`);
    const result = await host.observe({ projectId: PROJECT });
    assert.equal(result.outcome, 'denied');
    if (result.outcome !== 'denied') continue;
    assert.equal(result.code, expected.code);
    assert.equal(result.detail, expected.detail);
  }
});

test('an unknown native failure never echoes helper text and stays a stable category', async () => {
  const { host, child } = harness();
  child.onWrite = () => child.send(`${JSON.stringify({ ok: false, error: 'observe:something_else:raw detail' })}\n`);
  const result = await host.observe({ projectId: PROJECT });
  assert.deepEqual(result, { outcome: 'native_error' });
});

test('payloads that are not exactly the evidence shape are rejected', async () => {
  const payloads = [
    'not json',
    JSON.stringify({ kind: 'other_observation' }),
    JSON.stringify(evidence({ projectId: 'someone-elses-project' })),
    JSON.stringify(evidence({ truncations: ['not_a_bound'] })),
    JSON.stringify(evidence({ stats: { visitedNodes: 1, emittedNodes: 2, maxDepthReached: 1, estimatedBytes: 180 } })),
    JSON.stringify(evidence({ nodes: [{ depth: 1, role: 'AXStaticText' }] })),
  ];
  for (const payload of payloads) {
    const { host, child } = harness();
    child.onWrite = () => child.send(`${JSON.stringify({ ok: true, result: { type: 'json', payload } })}\n`);
    const result = await host.observe({ projectId: PROJECT });
    assert.equal(result.outcome, 'malformed_response', `payload should be malformed: ${payload.slice(0, 60)}`);
  }
  const { host, child } = harness();
  child.onWrite = () => child.send(`${JSON.stringify({ ok: true, result: { type: 'text', payload: successLine() } })}\n`);
  assert.equal((await host.observe({ projectId: PROJECT })).outcome, 'malformed_response');
});

test('oversized output is cut off and the child is terminated', async () => {
  const child = new TestChild();
  const host = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    helperPath: HELPER,
    exists: () => true,
    spawn: () => child,
    maxResponseBytes: 256,
  });
  child.onWrite = () => child.send(`{"ok":true,"result":{"type":"json","payload":"${'x'.repeat(512)}`);
  const result = await host.observe({ projectId: PROJECT });
  assert.deepEqual(result, { outcome: 'response_too_large' });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a helper that exits before answering is a crash', async () => {
  const { host, child } = harness();
  child.onWrite = () => child.exit(1);
  const result = await host.observe({ projectId: PROJECT });
  assert.deepEqual(result, { outcome: 'crashed' });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a spawn error is a crash, and an ENOENT is an explicit missing helper', async () => {
  const crashed = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    helperPath: HELPER,
    exists: () => true,
    spawn: () => {
      throw new Error('spawn failed');
    },
  });
  assert.deepEqual(await crashed.observe({ projectId: PROJECT }), { outcome: 'crashed' });

  const missing = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    helperPath: HELPER,
    exists: () => true,
    spawn: () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(await missing.observe({ projectId: PROJECT }), { outcome: 'helper_missing', searched: [HELPER] });
});

test('a hung helper times out and is killed', async () => {
  const child = new TestChild();
  const host = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    helperPath: HELPER,
    exists: () => true,
    spawn: () => child,
    timeoutMs: 30,
  });
  const started = performance.now();
  const result = await host.observe({ projectId: PROJECT });
  assert.deepEqual(result, { outcome: 'timeout' });
  assert.ok(performance.now() - started < 1_000, 'the timeout must fire on the finite budget, not hang');
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a missing packaged helper is reported explicitly without spawning', async () => {
  const spawns: string[] = [];
  const host = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    exists: () => false,
    spawn: (command) => {
      spawns.push(command);
      return new TestChild();
    },
  });
  const result = await host.observe({ projectId: PROJECT });
  assert.equal(result.outcome, 'helper_missing');
  if (result.outcome !== 'helper_missing') return;
  assert.deepEqual(result.searched, ['/app/dist/native/echopilot-desktop']);
  assert.deepEqual(spawns, []);
});

test('diagnostics report the packaged helper from the bundle directory, not the cwd', () => {
  const found = desktopObserveDiagnostics({ bundleDir: '/app/dist/main', exists: (candidate) => candidate === '/app/dist/native/echopilot-desktop' });
  assert.deepEqual(found, {
    helperFound: true,
    helperPath: '/app/dist/native/echopilot-desktop',
    searched: ['/app/dist/native/echopilot-desktop'],
  });
  const missing = desktopObserveDiagnostics({ bundleDir: '/app/dist/main', exists: () => false });
  assert.equal(missing.helperFound, false);
  assert.equal(missing.helperPath, null);
  const overridden = desktopObserveDiagnostics({ bundleDir: '/app/dist/main', helperPath: 'local/helper', exists: () => true });
  assert.equal(overridden.helperPath, join('/app/dist/main', 'local/helper'));
});

test('one real helper process answers over private stdio and is terminated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'c05-desktop-observe-'));
  const fixture = join(directory, 'helper.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.operation !== 'observe' || typeof request.scope?.projectId !== 'string') {
    send({ ok: false, error: 'unexpected request' });
    return;
  }
  const payload = JSON.stringify({
    kind: 'desktop_observe',
    observedAtMs: 1,
    projectId: request.scope.projectId,
    application: { pid: 42, bundleId: 'com.apple.fixture', name: 'Fixture', bundleIdTruncated: false, nameTruncated: false },
    window: { role: 'AXWindow', roleTruncated: false, title: 'Fixture window', titleTruncated: false },
    nodes: [],
    quality: 'full',
    truncated: false,
    truncations: [],
    stats: { visitedNodes: 0, emittedNodes: 0, maxDepthReached: 0, estimatedBytes: 0 },
  });
  send({ ok: true, result: { type: 'json', payload } });
});
`, 'utf8');
  const state: { child: ReturnType<typeof spawn> | null } = { child: null };
  const host = createDesktopObserveHost({
    bundleDir: '/app/dist/main',
    helperPath: fixture,
    exists: () => true,
    timeoutMs: 5_000,
    spawn: (command, args) => {
      assert.equal(command, fixture);
      assert.deepEqual(args, []);
      state.child = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] });
      return state.child as unknown as DesktopObserveChild;
    },
  });
  try {
    const result = await host.observe({ projectId: PROJECT });
    assert.equal(result.outcome, 'observed');
    if (result.outcome !== 'observed') return;
    assert.equal(result.evidence.application.bundleId, 'com.apple.fixture');
    assert.equal(result.evidence.projectId, PROJECT);
    await new Promise<void>((resolve) => {
      if (!state.child || state.child.exitCode !== null) return resolve();
      state.child.once('exit', () => resolve());
      setTimeout(resolve, 2_000).unref?.();
    });
    const finished = state.child;
    assert.ok(finished, 'the fixture helper must have spawned');
    assert.ok(finished.exitCode !== null || finished.signalCode !== null, 'the helper must be terminated after one response');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
