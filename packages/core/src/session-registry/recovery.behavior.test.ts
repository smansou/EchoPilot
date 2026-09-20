/**
 * H04 focused behavior tests — the registry/recovery seams exercised in-process.
 *
 * `h04.acceptance.test.ts` drives the same seams end-to-end through real stdio children
 * (`fixtures/harness/recovery/fake-recovery-app-server.mjs`). This file complements it with
 * deterministic, in-process doubles for the cases the H04 scope enumerates explicitly but the
 * end-to-end oracle can only reach slowly: a concurrent replay of one idempotency key, a lost
 * acknowledgment reconciled after a worktree (cwd) change, a completed versus merely accepted
 * observed turn, and the capability gate the registry applies to every adopted adapter.
 *
 * Nothing here reaches the network or a Codex/Claude account, so the evidence stays reproducible
 * after a provider outage (the H04 oracle finding `f-dc66fa9f90c6` is a provider failure, not a
 * behavior failure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EventEnvelope,
  HarnessAdapter,
  HarnessCapability,
  HarnessDeliveryReceipt,
} from '../../../contracts/src/index.js';
import {createRecoveringCodexSession} from '../../../harness-codex/src/recovery/index.js';
import {
  HARNESS_CONFORMANCE_CHECKS,
  UnsupportedHarnessOperationError,
  createConformantHarnessAdapter,
  createSessionRegistry,
  runHarnessConformance,
} from './index.js';

const PROBE_DELAY_MS = 20;

type SendMode = 'acknowledge' | 'lost-acknowledgment' | 'unsupported';

/** A live adapter double whose send() behavior is chosen per scenario. */
class ProbeAdapter implements HarnessAdapter {
  readonly sent: Array<{instruction: string; deliveryId: string}> = [];
  started = false;
  closed = false;

  constructor(private readonly mode: SendMode = 'acknowledge') {}

  async capabilities(): Promise<ReadonlySet<HarnessCapability>> {
    return new Set<HarnessCapability>(['observe', 'send', 'interrupt', 'approval', 'resume']);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  observe(): AsyncIterable<EventEnvelope> {
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<EventEnvelope> {
        // A managed session with nothing to report yet.
      },
    };
  }

  async send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
    this.sent.push({instruction, deliveryId});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PROBE_DELAY_MS);
    });
    if (this.mode === 'lost-acknowledgment') {
      throw new Error('codex app-server exited with code 1 before acknowledging the turn');
    }
    if (this.mode === 'unsupported') return {deliveryId, status: 'unsupported'};
    return {deliveryId, status: 'acknowledged'};
  }

  async interrupt(): Promise<void> {}
  async respondApproval(): Promise<void> {}
  async resume(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** An observation-only adapter that refuses every mutating operation. */
class ObserveOnlyAdapter implements HarnessAdapter {
  readonly refused: string[] = [];

  async capabilities(): Promise<ReadonlySet<HarnessCapability>> {
    return new Set<HarnessCapability>(['observe']);
  }

  async start(): Promise<void> {}

  observe(): AsyncIterable<EventEnvelope> {
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<EventEnvelope> {
        // Nothing to report.
      },
    };
  }

  private refuse(operation: string): never {
    this.refused.push(operation);
    throw new Error(`the capability gate must not reach the adapter for ${operation}`);
  }

  async send(): Promise<HarnessDeliveryReceipt> {
    return this.refuse('send');
  }

  async interrupt(): Promise<void> {
    this.refuse('interrupt');
  }

  async respondApproval(): Promise<void> {
    this.refuse('respondApproval');
  }

  async resume(): Promise<void> {
    this.refuse('resume');
  }

  async close(): Promise<void> {}
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 0, 0, tick++));
}

test('H04-R1: a concurrent replay of one deliveryId opens exactly one wire write', async () => {
  const adapter = new ProbeAdapter();
  const session = createRecoveringCodexSession({
    sessionId: 'probe-session',
    projectId: 'probe-project',
    now: fixedClock(),
    connect: async () => adapter,
  });
  await session.start();

  const [first, second] = await Promise.all([
    session.deliver('add a parser regression test', 'delivery-concurrent'),
    session.deliver('add a parser regression test', 'delivery-concurrent'),
  ]);

  assert.equal(adapter.sent.length, 1, 'a racing replay of one idempotency key must not write twice');
  assert.equal(adapter.sent[0]?.deliveryId, 'delivery-concurrent');
  assert.deepEqual([...new Set([first.state, second.state])], ['acknowledged']);
  assert.equal(first.attempts, 1, 'the joined attempt must report a single wire attempt');
  assert.equal(second.attempts, 1);
  assert.deepEqual(session.outbox().map((record) => record.deliveryId), ['delivery-concurrent']);
  assert.deepEqual(session.unknown(), []);
  await session.close();
  assert.equal(adapter.closed, true, 'close() must release the adapter');
});

test('H04-R2: a lost acknowledgment survives reconnect, never repeats, and reconciles from observed state', async () => {
  const first = new ProbeAdapter('lost-acknowledgment');
  const second = new ProbeAdapter();
  let connections = 0;
  const session = createRecoveringCodexSession({
    sessionId: 'probe-session',
    projectId: 'probe-project',
    now: fixedClock(),
    connect: async () => (++connections === 1 ? first : second),
  });
  await session.start();

  const attempt = await session.deliver('run the focused suite', 'delivery-lost');
  assert.equal(attempt.state, 'unknown', 'a send that may have reached the wire must stay unknown');
  assert.equal(attempt.attempts, 1);
  assert.equal(session.unknown().length, 1, 'unknown() must expose the unresolved delivery');

  await session.reconnect();
  assert.equal(first.closed, true, 'reconnect() must release the dead connection');
  assert.equal(second.started, true, 'reconnect() must start the fresh connection');

  const replay = await session.deliver('run the focused suite', 'delivery-lost');
  assert.equal(replay.state, 'unknown', 'the unknown outcome must survive the reconnect');
  assert.equal(replay.attempts, 1, 'a replayed deliveryId must not add a wire attempt');
  assert.equal(second.sent.length, 0, 'no duplicate send may follow a reconnect');

  const foreign = await session.reconcile(async () => ({
    sessionId: 'probe-session',
    projectId: 'another-project',
    cwd: '/tmp/another-worktree',
    turns: [{turnId: 'foreign-turn', instruction: 'run the focused suite', status: 'completed'}],
  }));
  assert.equal(foreign[0]?.state, 'unknown', 'observed state from another project must not reconcile');
  assert.equal(second.sent.length, 0, 'reconciliation must never send');

  const accepted = await session.reconcile(async () => ({
    sessionId: 'probe-session',
    projectId: 'probe-project',
    cwd: '/tmp/moved-worktree',
    turns: [{turnId: 'turn-accepted', instruction: 'run the focused suite', status: 'in_progress'}],
  }));
  assert.equal(accepted[0]?.state, 'acknowledged', 'an accepted but unfinished turn is acknowledged, not completed');
  assert.equal(accepted[0]?.observedTurnId, 'turn-accepted');
  assert.equal(accepted[0]?.projectId, 'probe-project');
  assert.equal(session.unknown().length, 0, 'a reconciled delivery leaves unknown()');

  const retried = await session.deliver('run the focused suite', 'delivery-lost');
  assert.equal(retried.state, 'acknowledged', 'the reconciled outcome is retained');
  assert.equal(retried.attempts, 1);
  assert.equal(second.sent.length, 0, 'the retained outcome must never be re-sent');

  const next = await session.deliver('ship the worktree', 'delivery-next');
  assert.equal(next.state, 'acknowledged');
  assert.deepEqual(second.sent.map((entry) => entry.instruction), ['ship the worktree']);
  assert.deepEqual(session.outbox().map((record) => record.deliveryId), ['delivery-lost', 'delivery-next']);
  await session.close();
});

test('H04-R3: deterministic refusals are failed deliveries, never fabricated unknown outcomes', async () => {
  const adapter = new ProbeAdapter('unsupported');
  const session = createRecoveringCodexSession({
    sessionId: 'probe-session',
    projectId: 'probe-project',
    now: fixedClock(),
    connect: async () => adapter,
  });
  await session.start();

  const refused = await session.deliver('probe an unsupported harness', 'delivery-unsupported');
  assert.equal(refused.state, 'failed', 'an unsupported receipt is a definite failure, not an unknown outcome');
  assert.equal(session.unknown().length, 0);
  assert.equal(session.outbox().length, 1);
  await session.close();
});

test('H04-R4: the registry keeps distinct project/turn/cwd identities and gates unsupported operations', async () => {
  const registry = createSessionRegistry();
  const codexParser = new ProbeAdapter();
  const codexTests = new ProbeAdapter();
  const claudeReviewer = new ObserveOnlyAdapter();
  registry.adopt({sessionId: 'codex-parser', harness: 'codex', projectId: 'project-parser', label: 'Codex parser', cwd: '/tmp/parser', adapter: codexParser});
  registry.adopt({sessionId: 'codex-tests', harness: 'codex', projectId: 'project-tests', label: 'Codex tests', cwd: '/tmp/tests', adapter: codexTests});
  registry.adopt({sessionId: 'claude-reviewer', harness: 'claude', projectId: 'project-review', label: 'Claude reviewer', cwd: '/tmp/review', adapter: claudeReviewer});

  assert.deepEqual(
    registry.list().map((record) => [record.sessionId, record.harness, record.projectId, record.cwd]),
    [
      ['codex-parser', 'codex', 'project-parser', '/tmp/parser'],
      ['codex-tests', 'codex', 'project-tests', '/tmp/tests'],
      ['claude-reviewer', 'claude', 'project-review', '/tmp/review'],
    ],
    'each adopted session keeps its own project and worktree',
  );

  registry.recordTurn('codex-parser', 'parser-turn-1');
  registry.recordTurn('claude-reviewer', 'reviewer-turn-1');
  assert.equal(registry.get('codex-parser')?.turnId, 'parser-turn-1');
  assert.equal(registry.get('claude-reviewer')?.turnId, 'reviewer-turn-1');
  assert.equal(registry.get('codex-tests')?.turnId, undefined, 'turn identities never leak between sessions');
  assert.throws(
    () => registry.recordTurn('codex-parser', '   '),
    (error: unknown) => error instanceof TypeError,
    'an empty turn identity is a TypeError',
  );

  const reviewerAdapter = registry.adapterFor('claude-reviewer');
  assert.ok(reviewerAdapter, 'adapterFor() must expose the adopted adapter');
  assert.deepEqual([...(await reviewerAdapter.capabilities())].sort(), ['observe']);
  assert.deepEqual(
    await reviewerAdapter.send('unauthorized probe', 'delivery-gated'),
    {deliveryId: 'delivery-gated', status: 'unsupported'},
    'the gate turns an unsupported send into a typed unsupported receipt',
  );
  const gated: ReadonlyArray<readonly [HarnessCapability, () => Promise<unknown>]> = [
    ['interrupt', () => reviewerAdapter.interrupt('parser-turn-1')],
    ['approval', () => reviewerAdapter.respondApproval('request-1', 'approve')],
    ['resume', () => reviewerAdapter.resume('codex-parser')],
  ];
  for (const [operation, invoke] of gated) {
    await assert.rejects(invoke, (error: unknown) => {
      assert.ok(error instanceof UnsupportedHarnessOperationError, `${operation} must reject with UnsupportedHarnessOperationError`);
      assert.equal(error.code, 'unsupported_operation');
      assert.equal(error.operation, operation);
      assert.equal(error.harness, 'claude');
      assert.equal(error.sessionId, 'claude-reviewer');
      return true;
    });
  }
  assert.deepEqual(claudeReviewer.refused, [], 'an unsupported operation must never reach the adapter');

  assert.deepEqual(registry.destinationFor('  codex TESTS '), {
    kind: 'resolved',
    sessionId: 'codex-tests',
    harness: 'codex',
    projectId: 'project-tests',
    label: 'Codex tests',
  });
  const renamed = registry.rename('codex-parser', 'Parser worktree');
  assert.equal(renamed.label, 'Parser worktree');
  assert.equal(renamed.sessionId, 'codex-parser');
  assert.equal(renamed.projectId, 'project-parser');
  assert.equal(renamed.cwd, '/tmp/parser');
  assert.equal(renamed.turnId, 'parser-turn-1');
  assert.equal(registry.destinationFor('Codex parser').kind, 'unmatched');
  assert.equal(registry.destinationFor('Parser worktree').kind, 'resolved');

  const retired = registry.end('codex-tests');
  assert.equal(retired.active, false);
  assert.equal(registry.get('codex-tests')?.active, false, 'end() keeps the record visible in the registry');
  assert.equal(registry.destinationFor('Codex tests').kind, 'unmatched');
  assert.equal(registry.destinationFor('Claude reviewer').kind, 'resolved');
});

test('H04-R5: one shared conformance suite covers capable and observation-only adapters', async () => {
  const capable = new ProbeAdapter();
  const observeOnly = new ObserveOnlyAdapter();
  const reports = await runHarnessConformance([
    {
      harness: 'codex',
      sessionId: 'conformance-capable',
      adapter: capable,
      lifecycle: {
        async start(adapter: HarnessAdapter): Promise<void> {
          await adapter.start();
        },
        async send(adapter: HarnessAdapter, instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
          return adapter.send(instruction, deliveryId);
        },
        async interrupt(adapter: HarnessAdapter): Promise<void> {
          await adapter.interrupt('conformance-turn');
        },
        async approval(adapter: HarnessAdapter): Promise<void> {
          await adapter.respondApproval('conformance-request', 'approve');
        },
        async resume(adapter: HarnessAdapter): Promise<void> {
          await adapter.resume('conformance-capable');
        },
        async close(adapter: HarnessAdapter): Promise<void> {
          await adapter.close();
        },
      },
    },
    {
      harness: 'claude',
      sessionId: 'conformance-observe-only',
      adapter: observeOnly,
      lifecycle: {
        async start(adapter: HarnessAdapter): Promise<void> {
          await adapter.start();
        },
        async send(adapter: HarnessAdapter, instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
          return adapter.send(instruction, deliveryId);
        },
        async close(adapter: HarnessAdapter): Promise<void> {
          await adapter.close();
        },
      },
    },
  ]);

  assert.equal(reports.length, 2, 'every conformance case must be reported');
  for (const report of reports) {
    assert.deepEqual(
      report.checks.map((check) => check.id),
      [...HARNESS_CONFORMANCE_CHECKS],
      `${report.sessionId}: every adapter must run the same frozen checks in order`,
    );
    assert.equal(report.passed, true, `${report.sessionId} must pass the shared suite`);
  }
  const capableReport = reports[0];
  const observeOnlyReport = reports[1];
  assert.ok(capableReport !== undefined && observeOnlyReport !== undefined);
  for (const check of capableReport.checks) {
    assert.equal(check.outcome, 'executed', `conformance-capable ${check.id} must execute the lifecycle`);
  }
  assert.equal(
    observeOnlyReport.checks.find((check) => check.id === 'lifecycle:send')?.outcome,
    'unsupported_receipt',
    'an unsupported send stays a typed unsupported receipt',
  );
  for (const id of ['lifecycle:interrupt', 'lifecycle:approval', 'lifecycle:resume'] as const) {
    assert.equal(
      observeOnlyReport.checks.find((check) => check.id === id)?.outcome,
      'unsupported_typed_error',
      `${id} must stay a typed unsupported operation`,
    );
  }
  assert.deepEqual(observeOnly.refused, [], 'the gate must keep unsupported operations away from the adapter');

  const gated = createConformantHarnessAdapter(new ObserveOnlyAdapter(), {harness: 'claude', sessionId: 'gated-probe'});
  assert.deepEqual([...(await gated.capabilities())].sort(), ['observe']);
});
