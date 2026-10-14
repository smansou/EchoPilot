/**
 * Focused reliability tests for managed Work sessions. They drive `createManagedWork` through the
 * injectable adapter factory, so no app-server child is spawned, no network is touched, and no real
 * Codex credentials or auth are read: every adapter and event envelope here is deterministic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  EventEnvelope,
  HarnessCapability,
  HarnessDeliveryReceipt,
} from '../../../../packages/contracts/src/index';
import type { CodexHarnessAdapter, CodexHarnessInfo, CodexHarnessOptions } from '../../../../packages/harness-codex/src/index';
import { createManagedWork } from './managed-work';

function tempDir(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), 'managed-work-test-'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(5);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

class FakeAdapter implements CodexHarnessAdapter {
  compatible = true;
  authenticated = true;
  authMode: string | null = null;
  serverVersion = '0.154.0';
  startGate: Promise<void> | null = null;
  startError: Error | null = null;
  infoError: Error | null = null;
  accountError: Error | null = null;
  closeGate: Promise<void> | null = null;
  sendError: Error | null = null;
  sendGate: Promise<HarnessDeliveryReceipt> | null = null;
  sendResult: HarnessDeliveryReceipt | null = null;
  interruptError: Error | null = null;
  approvalError: Error | null = null;
  closeError: Error | null = null;
  agentText = '';
  diagnosticText: string | null = null;
  readonly sendCalls: Array<{ instruction: string; deliveryId: string }> = [];
  readonly interruptCalls: string[] = [];
  readonly respondCalls: Array<{ requestId: string; decision: 'approve' | 'deny' }> = [];
  closeCalls = 0;
  started = false;
  private closed = false;
  private readonly queued: EventEnvelope[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly options: CodexHarnessOptions) {}

  push(event: EventEnvelope): void {
    this.queued.push(event);
    this.wake();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter();
    }
  }

  observe(): AsyncIterable<EventEnvelope> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<EventEnvelope> => {
        let cursor = 0;
        return {
          next: async (): Promise<IteratorResult<EventEnvelope>> => {
            for (;;) {
              const event = this.queued[cursor];
              if (event !== undefined) {
                cursor += 1;
                return { value: event, done: false };
              }
              if (this.closed) return { value: undefined, done: true };
              await new Promise<void>((resolve) => { this.waiters.add(resolve); });
            }
          },
        };
      },
    };
  }

  async capabilities(): Promise<ReadonlySet<HarnessCapability>> {
    return new Set<HarnessCapability>(['observe', 'send', 'interrupt', 'approval', 'resume']);
  }

  async start(): Promise<void> {
    if (this.startGate !== null) await this.startGate;
    if (this.startError !== null) throw this.startError;
    this.started = true;
  }

  async info(): Promise<CodexHarnessInfo> {
    if (this.infoError !== null) throw this.infoError;
    return {
      adapter: 'codex-app-server',
      supportedVersion: '0.154.0',
      serverVersion: this.serverVersion,
      compatible: this.compatible,
      capabilities: [...(await this.capabilities())],
    };
  }

  async accountStatus(): Promise<Readonly<{ authenticated: boolean; mode: string | null }>> {
    if (this.accountError) throw this.accountError;
    return { authenticated: this.authenticated, mode: this.authMode };
  }

  async beginChatGPTLogin(): Promise<Readonly<{ loginId: string; authUrl: string }>> {
    return { loginId: 'login-1', authUrl: 'https://chatgpt.com/authorize/test' };
  }

  async send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
    this.sendCalls.push({ instruction, deliveryId });
    if (this.sendError !== null) throw this.sendError;
    if (this.sendGate !== null) return await this.sendGate;
    return this.sendResult ?? { deliveryId, status: 'acknowledged' };
  }

  async interrupt(turnId: string): Promise<void> {
    this.interruptCalls.push(turnId);
    if (this.interruptError !== null) throw this.interruptError;
  }

  async respondApproval(requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    this.respondCalls.push({ requestId, decision });
    if (this.approvalError !== null) throw this.approvalError;
  }

  async resume(): Promise<void> {
    // Never exercised: managed-work has no resume surface.
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeGate !== null) await this.closeGate;
    this.closed = true;
    this.wake();
    if (this.closeError !== null) throw this.closeError;
  }

  readAgentMessage(): string | null {
    return this.agentText === '' ? null : this.agentText;
  }

  readDiagnosticMessage(): string | null {
    return this.diagnosticText;
  }
}

function harness(setup?: (adapter: FakeAdapter, index: number) => void): {
  created: FakeAdapter[];
  createAdapter: (options: CodexHarnessOptions) => CodexHarnessAdapter;
} {
  const created: FakeAdapter[] = [];
  return {
    created,
    createAdapter: (options: CodexHarnessOptions): CodexHarnessAdapter => {
      const adapter = new FakeAdapter(options);
      setup?.(adapter, created.length);
      created.push(adapter);
      return adapter;
    },
  };
}

let eventSequence = 0;
function envelope(kind: EventEnvelope['kind'], payloadRef: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  eventSequence += 1;
  const at = new Date(1_760_000_000_000 + eventSequence).toISOString();
  return {
    schemaVersion: 1,
    eventId: `event-${eventSequence}`,
    sourceId: 'managed-work-test',
    sourceEventId: `source-${eventSequence}`,
    sourceSequence: eventSequence,
    ingestSequence: eventSequence,
    occurredAt: at,
    observedAt: at,
    scope: { profileId: 'local', sensitivity: 'normal' },
    kind,
    payloadRef,
    contentHash: 'test-content-hash',
    trust: 'tool_observed',
    ...extra,
  };
}

function sessionState(turnId: string, phase: 'started' | 'completed'): EventEnvelope {
  return envelope('session_state', `codex-app-server://test/thread/thread-1/turn/${turnId}/${phase}`, { turnId });
}

function approvalRequest(requestId: string, turnId: string): EventEnvelope {
  return envelope('approval_requested', `codex-app-server://test/thread/thread-1/approval/${requestId}`, {
    turnId,
    sourceEventId: requestId,
  });
}

test('concurrent starts reserve capacity before connecting and never exceed the limit', async () => {
  const root = tempDir();
  const gate = deferred<void>();
  const { created, createAdapter } = harness((adapter) => { adapter.startGate = gate.promise; });
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  const dirs = Array.from({ length: 5 }, () => tempDir());
  try {
    const starts = dirs.map((dir) => work.start(dir));
    await waitFor(() => created.length === 4, 'four adapters to be created');
    const fifth = await Promise.race([
      starts[4]!.then(() => 'resolved' as const, () => 'rejected' as const),
      delay(1_000).then(() => 'pending' as const),
    ]);
    assert.equal(fifth, 'rejected');
    await assert.rejects(starts[4]!, /At most 4 managed sessions can run at once/);

    gate.resolve();
    const sessions = await Promise.all(starts.slice(0, 4));
    assert.equal(sessions.length, 4);
    assert.equal(work.list().filter((session) => session.active).length, 4);
    assert.equal(created.length, 4);

    await work.close(sessions[0]!.id);
    assert.equal(work.list().filter((session) => session.active).length, 3);
    const replacement = await work.start(tempDir());
    assert.equal(replacement.active, true);
    assert.equal(work.list().filter((session) => session.active).length, 4);
    await work.dispose();
  } finally {
    gate.resolve();
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed launch or handshake closes the child and releases its reserved slot', async () => {
  const root = tempDir();
  const dir = tempDir();
  let attempt = 0;
  const { created, createAdapter } = harness((adapter) => {
    if (attempt === 0) adapter.startError = new Error('spawn failed');
    else if (attempt === 1) adapter.infoError = new Error('handshake failed');
  });
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  try {
    attempt = 0;
    await assert.rejects(work.start(dir), /spawn failed/);
    attempt = 1;
    await assert.rejects(work.start(dir), /handshake failed/);
    // Four failures in a row would exhaust the limit if any reservation leaked; the good start
    // below proves every failed attempt released its slot.
    attempt = 0;
    await assert.rejects(work.start(dir), /spawn failed/);
    attempt = 1;
    await assert.rejects(work.start(dir), /handshake failed/);
    assert.equal(work.list().length, 0);
    assert.equal(created.length, 4);
    assert.ok(created.every((adapter) => adapter.closeCalls === 1), 'every failed child is closed exactly once');

    attempt = 2;
    const session = await work.start(dir);
    assert.equal(session.active, true);
    assert.equal(session.authenticated, true);
    await work.dispose();
  } finally {
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start canonicalizes cwd, rejects unusable paths, and isolates duplicate projects', async () => {
  const root = tempDir();
  const project = tempDir();
  const linkParent = tempDir();
  const linked = join(linkParent, 'linked-project');
  symlinkSync(project, linked, 'dir');
  const { created, createAdapter } = harness();
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  try {
    await assert.rejects(work.start('   '), /Choose a project directory/);
    await assert.rejects(work.start('relative/project'), /not available/);
    await assert.rejects(work.start(join(root, 'missing')), /not available/);

    const throughLink = await work.start(linked);
    const direct = await work.start(project);
    assert.equal(throughLink.cwd, realpathSync(project));
    assert.equal(throughLink.projectId, direct.projectId);
    const firstHome = created[0]!.options.codexHome ?? '';
    const secondHome = created[1]!.options.codexHome ?? '';
    assert.ok(firstHome.startsWith(join(root, 'managed-codex')), 'the managed home stays under userData');
    assert.notEqual(firstHome, secondHome, 'duplicate projects never share a managed codex home');
    assert.equal(work.list().filter((session) => session.active).length, 2);
    await work.dispose();
  } finally {
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test('send requires an authenticated compatible session and never overlaps or overclaims', async () => {
  const root = tempDir();
  const dir = tempDir();
  const gate = deferred<HarnessDeliveryReceipt>();
  const { created, createAdapter } = harness((adapter, index) => {
    if (index === 0) adapter.authenticated = false;
    if (index === 1) adapter.compatible = false;
    if (index === 2) adapter.sendGate = gate.promise;
  });
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  try {
    const signedOut = await work.start(dir);
    await assert.rejects(work.send(signedOut.id, 'hello'), /Connect your Codex account/);
    assert.equal(created[0]!.sendCalls.length, 0);

    const incompatible = await work.start(dir);
    await assert.rejects(work.send(incompatible.id, 'hello'), /observe-only/);
    assert.equal(created[1]!.sendCalls.length, 0);

    const active = await work.start(dir);
    const first = work.send(active.id, 'first request');
    await waitFor(() => created[2]!.sendCalls.length === 1, 'the first send to reach the adapter');
    await assert.rejects(work.send(active.id, 'second request'), /already working on a request/);
    assert.equal(created[2]!.sendCalls.length, 1, 'a second overlapping send never reaches the adapter');
    gate.resolve({ deliveryId: 'delivery-1', status: 'acknowledged' });
    const settled = await first;
    assert.equal(settled.lastReceipt, 'acknowledged');
    assert.equal(settled.error, null);

    created[2]!.push(sessionState('still-running', 'started'));
    await waitFor(() => work.list().find(session => session.id === active.id)?.currentTurnId === 'still-running', 'running turn after acknowledgement');
    await assert.rejects(work.send(active.id, 'overlap after receipt'), /already working on a request/);
    assert.equal(created[2]!.sendCalls.length, 1);
    created[2]!.push(sessionState('still-running', 'completed'));
    await waitFor(() => work.list().find(session => session.id === active.id)?.currentTurnId === null, 'turn completion permits next request');

    created[2]!.sendGate = null;
    created[2]!.sendResult = { deliveryId: 'delivery-2', status: 'unsupported' };
    await assert.rejects(work.send(active.id, 'third request'), /did not acknowledge/);
    assert.equal(work.list().find((session) => session.id === active.id)!.lastReceipt, 'acknowledged');

    await work.close(active.id);
    assert.equal(work.list().find((session) => session.id === active.id)!.active, false);
    await assert.rejects(work.send(active.id, 'after close'), /not active/);
    await assert.rejects(work.send('missing-session', 'hello'), /not active/);
    await work.dispose();
  } finally {
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth refresh failure revokes stale send authority and keeps the session observable', async () => {
  const root = tempDir(); const dir = tempDir(); const { created, createAdapter } = harness();
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  try {
    const session = await work.start(dir); created[0]!.accountError = new Error('offline auth');
    const refreshed = await work.refreshAuth();
    assert.equal(refreshed[0]!.authenticated, false); assert.equal(refreshed[0]!.active, true);
    await assert.rejects(work.send(session.id, 'hello'), /Connect your Codex account/);
    assert.equal(created[0]!.sendCalls.length, 0);
    created[0]!.accountError = null; assert.equal((await work.refreshAuth())[0]!.authenticated, true);
  } finally { await work.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('turn completion clears running state and approvals only answer the exact live request', async () => {
  const root = tempDir();
  const dir = tempDir();
  const { created, createAdapter } = harness();
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  try {
    const session = await work.start(dir);
    const adapter = created[0]!;
    const state = (id: string) => work.list().find((entry) => entry.id === id)!;

    adapter.push(sessionState('turn-1', 'started'));
    await waitFor(() => state(session.id).currentTurnId === 'turn-1', 'the running turn');
    adapter.push(approvalRequest('request-1', 'turn-1'));
    await waitFor(() => state(session.id).pendingApproval === 'request-1', 'the pending approval');
    adapter.push(sessionState('turn-1', 'completed'));
    await waitFor(() => state(session.id).currentTurnId === null && state(session.id).pendingApproval === null, 'the completed turn');

    const completed = state(session.id);
    assert.deepEqual(completed.events.map((event) => event.kind), ['session_state', 'approval_requested', 'session_state']);
    assert.equal(completed.events[1]!.requestId, 'request-1');
    assert.equal(completed.events[2]!.turnId, 'turn-1');
    await assert.rejects(work.respond(session.id, 'request-1', 'approve'), /no longer pending/);
    assert.equal(adapter.respondCalls.length, 0);
    await assert.rejects(work.interrupt(session.id), /No running turn/);

    // A new turn clears an approval left over from the previous one.
    adapter.push(sessionState('turn-2', 'started'));
    await waitFor(() => state(session.id).currentTurnId === 'turn-2', 'the second turn');
    adapter.push(approvalRequest('request-2', 'turn-2'));
    await waitFor(() => state(session.id).pendingApproval === 'request-2', 'the second approval');
    adapter.push(sessionState('turn-3', 'started'));
    await waitFor(() => state(session.id).pendingApproval === null, 'the stale approval to clear');

    // Exact-request matching, then a truthful denial receipt.
    adapter.push(approvalRequest('request-3', 'turn-3'));
    await waitFor(() => state(session.id).pendingApproval === 'request-3', 'the third approval');
    await assert.rejects(work.respond(session.id, 'request-other', 'approve'), /no longer pending/);
    assert.equal(adapter.respondCalls.length, 0);
    const denied = await work.respond(session.id, 'request-3', 'deny');
    assert.deepEqual(adapter.respondCalls, [{ requestId: 'request-3', decision: 'deny' }]);
    assert.equal(denied.pendingApproval, null);
    assert.equal(denied.lastReceipt, 'denied');

    const interrupted = await work.interrupt(session.id);
    assert.deepEqual(adapter.interruptCalls, ['turn-3']);
    assert.equal(interrupted.lastReceipt, 'interrupted');
    adapter.push(sessionState('turn-3', 'completed'));
    await waitFor(() => state(session.id).currentTurnId === null, 'the interrupted turn to end');

    // A failed answer clears the offer and claims no receipt for what the adapter refused.
    adapter.push(sessionState('turn-4', 'started'));
    await waitFor(() => state(session.id).currentTurnId === 'turn-4', 'the fourth turn');
    adapter.push(approvalRequest('request-4', 'turn-4'));
    await waitFor(() => state(session.id).pendingApproval === 'request-4', 'the fourth approval');
    adapter.approvalError = new Error('approval wire failed');
    await assert.rejects(work.respond(session.id, 'request-4', 'approve'), /approval wire failed/);
    assert.equal(state(session.id).pendingApproval, null);
    assert.equal(state(session.id).lastReceipt, 'interrupted');

    // Approvals never act across sessions.
    const otherDir = tempDir();
    try {
      const other = await work.start(otherDir);
      const otherAdapter = created[1]!;
      otherAdapter.push(sessionState('turn-9', 'started'));
      await waitFor(() => state(other.id).currentTurnId === 'turn-9', 'the other turn');
      otherAdapter.push(approvalRequest('request-9', 'turn-9'));
      await waitFor(() => state(other.id).pendingApproval === 'request-9', 'the other approval');
      await assert.rejects(work.respond(session.id, 'request-9', 'approve'), /no longer pending/);
      assert.equal(otherAdapter.respondCalls.length, 0, 'a cross-session approval is never answered');
      const otherAnswered = await work.respond(other.id, 'request-9', 'approve');
      assert.equal(otherAnswered.lastReceipt, 'approved');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
    await work.dispose();
  } finally {
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close failures end the session locally and dispose cleans every session best-effort', async () => {
  const root = tempDir();
  const dir = tempDir();
  const { created, createAdapter } = harness((adapter, index) => {
    if (index === 1) adapter.closeError = new Error('kill failed');
  });
  const work = createManagedWork(root, 'codex', undefined, { createAdapter });
  try {
    const first = await work.start(dir);
    const second = await work.start(dir);
    created[0]!.push(approvalRequest('request-close', 'turn-close'));
    created[0]!.push(sessionState('turn-close', 'started'));
    await waitFor(() => work.list().find((entry) => entry.id === first.id)!.pendingApproval === 'request-close', 'the pre-close approval');

    await assert.rejects(work.close(second.id), /kill failed/);
    const closed = work.list().find((entry) => entry.id === second.id)!;
    assert.equal(closed.active, false);
    assert.match(closed.error ?? '', /could not close cleanly: kill failed/);
    assert.equal(created[1]!.closeCalls, 1);
    await assert.rejects(work.send(second.id, 'hello'), /not active/);

    const closeGate = deferred<void>();
    created[0]!.closeGate = closeGate.promise;
    const closingFirst = work.close(first.id);
    // Approvals are refused the moment closing starts, before the wire teardown finishes.
    await assert.rejects(work.respond(first.id, 'request-close', 'deny'), /not active/);
    assert.equal(created[0]!.respondCalls.length, 0, 'a closing session never answers an approval');
    closeGate.resolve();
    await closingFirst;
    assert.equal(work.list().find((entry) => entry.id === first.id)!.pendingApproval, null, 'close clears pending approvals');
    assert.equal(created[0]!.closeCalls, 1);

    await work.dispose(); // the still-failing close must not reject dispose or skip the other child
    assert.equal(created[1]!.closeCalls, 2);
    assert.throws(() => work.list(), /shut down/);
    await assert.rejects(work.start(dir), /shut down/);
    await assert.rejects(work.send(first.id, 'hello'), /shut down/);
  } finally {
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostics are bounded, event readback is capped, and memory warnings are not agent failures', async () => {
  const root = tempDir();
  const dir = tempDir();
  let memoryFails = true;
  const onEvent = async (): Promise<void> => {
    if (memoryFails) throw new Error('memory disk full');
  };
  const { created, createAdapter } = harness();
  const work = createManagedWork(root, 'codex', onEvent, { createAdapter });
  try {
    const session = await work.start(dir);
    const adapter = created[0]!;
    const state = () => work.list().find((entry) => entry.id === session.id)!;

    adapter.agentText = 'y'.repeat(10_000);
    adapter.push(envelope('agent_message', 'codex-app-server://test/message-1'));
    await waitFor(() => state().diagnostic !== null, 'the memory warning');
    assert.equal(state().error, null, 'a memory failure never reports the agent as failed');
    assert.equal(state().active, true);
    assert.match(state().diagnostic ?? '', /^Memory could not save this event: memory disk full/);
    assert.ok((state().diagnostic ?? '').length <= 500);
    const message = state().events.find((event) => event.kind === 'agent_message')!;
    assert.ok((message.text ?? '').length <= 2_000, 'event readback is capped');
    assert.ok((message.text ?? '').length > 1_000, 'the cap still carries the readable prefix');

    adapter.diagnosticText = 'x'.repeat(4_000);
    adapter.push(envelope('unsupported', 'codex-app-server://test/diagnostics/error', { unsupportedKind: 'error' }));
    await waitFor(() => state().error !== null, 'the bounded wire error');
    assert.ok((state().error ?? '').length <= 500);
    assert.notEqual(state().error, state().diagnostic);

    memoryFails = false;
    let lastId = '';
    for (let index = 0; index < 100; index += 1) {
      const event = envelope('tool_started', `codex-app-server://test/tool/${index}`);
      lastId = event.eventId;
      adapter.push(event);
    }
    await waitFor(() => state().events.length === 80, 'the capped event feed');
    assert.equal(state().events.length, 80);
    assert.equal(state().events[79]!.id, lastId, 'the newest events stay and the oldest are dropped');
    await work.dispose();
  } finally {
    await work.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
