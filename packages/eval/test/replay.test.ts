/**
 * Q01 acceptance test — recorded scenario → deterministic app replay → scored outcome report.
 *
 * Red baseline: `packages/eval/src/index.ts` does not exist yet, so the driver cannot be
 * loaded. That is reported as an explicit assertion naming the missing behavior instead of a
 * bare module-resolution crash, and every other assertion below states required behavior that
 * the implementation must satisfy.
 *
 * The driver contract used here (implemented in `packages/eval/src/index.ts`):
 *   parseScenario(value) -> EvalScenario            // validates a recorded fixture, contractVersion 1
 *   replayScenario(scenario, options) -> EvalRun    // fake time, fake NativeHost, fake providers
 *   options: { now, nativeHost, providers, grants }
 *   providers: [{ providerId, kind, complete(request) }] — the only model work a replay may do.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FIXTURE_ROOT = new URL('../../../fixtures/q01/', import.meta.url);

type ScenarioEvent = {
  eventId: string;
  at: string;
  kind: string;
  trust: string;
  text: string;
  data?: Record<string, unknown>;
};
type Scenario = {
  contractVersion: number;
  scenarioId: string;
  seed: string;
  events: readonly ScenarioEvent[];
  expectations: readonly unknown[];
};
type Finding = {
  checkId: string;
  status: 'pass' | 'fail';
  sourceEventIds: readonly string[];
  detail: string;
};
type Report = {
  deterministic: {
    passed: boolean;
    findings: readonly Finding[];
    toolInvocations: number;
    grantChanges: number;
  };
  modelQuality: { providerIds: readonly string[] };
  humanRatings: { ratings: readonly unknown[] };
  costs: { paidCalls: number };
};
type Run = {
  scenarioId: string;
  seed: string;
  eventTrace: readonly Record<string, unknown>[];
  policyTrace: readonly Record<string, unknown>[];
  report: Report;
};
type ProviderRequest = { providerId?: string; purpose?: string; text?: string };
type FakeProvider = {
  providerId: string;
  kind: 'fake';
  calls: ProviderRequest[];
  complete(request: ProviderRequest): Promise<{ text: string }>;
};
type ReplayOptions = {
  now: () => Date;
  nativeHost: unknown;
  providers: readonly FakeProvider[];
  grants?: readonly Record<string, unknown>[];
};
type EvalDriver = {
  parseScenario(value: unknown): Scenario;
  replayScenario(scenario: Scenario, options: ReplayOptions): Promise<Run>;
};

const REQUIRED_CHECKS = [
  'dictation_edit',
  'factual_claim',
  'routing',
  'attention',
  'memory_evidence',
  'action_receipt',
];

/** Loads the yet-to-be-implemented driver, turning "module missing" into a named failure. */
async function loadDriver(): Promise<EvalDriver> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('../src/index.js')) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/eval/src/index.ts must export a fixture replay driver '
        + '(parseScenario + replayScenario) with fake time, fake NativeHost, and fake providers.',
      );
    }
    throw error;
  }
  assert.equal(typeof loaded.parseScenario, 'function', 'packages/eval must export parseScenario()');
  assert.equal(typeof loaded.replayScenario, 'function', 'packages/eval must export replayScenario()');
  return loaded as unknown as EvalDriver;
}

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  const text = await readFile(new URL(name, FIXTURE_ROOT), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Fake clock: identical sequences across runs so traces are comparable. */
function fakeClock(): () => Date {
  let step = 0;
  return () => new Date(Date.UTC(2026, 8, 12, 9, 0, 0) + step++ * 1000);
}

/**
 * Fake provider that replays the recorded responses and records every call, so the test can
 * prove that normal CI replay never reaches anything else.
 */
function fakeProvider(): FakeProvider {
  const recorded = new Map<string, string>([
    ['dictation_correction', 'Summarize what ticket Q01 must verify.'],
    ['answer_synthesis', 'Ticket Q01 replays a recorded scenario deterministically and scores the outcome.'],
  ]);
  const calls: ProviderRequest[] = [];
  return {
    providerId: 'fake-synthetic',
    kind: 'fake',
    calls,
    async complete(request: ProviderRequest): Promise<{ text: string }> {
      calls.push(request ?? {});
      const text = recorded.get(String(request?.purpose)) ?? recorded.get('dictation_correction')!;
      return { text };
    },
  };
}

/** Minimal fake NativeHost that records every tool execution attempt. */
function fakeNativeHost(toolCalls: unknown[]): Record<string, unknown> {
  const noop = async (): Promise<void> => undefined;
  const audio = { start: noop, stop: noop, duck: noop, flush: noop };
  const gaze = { start: noop, stop: noop };
  return {
    async capture({ scope }: { scope: unknown }) {
      return { snapshotId: 'synthetic-snapshot-q01', scope, capturedAt: '2026-09-12T09:00:00.000Z', source: 'synthetic' };
    },
    async *observeForeground(): AsyncIterable<never> { /* synthetic fixture supplies its own events */ },
    async insertText(transaction: { transactionId: string }) {
      return { transactionId: transaction.transactionId, inserted: true };
    },
    audio,
    gaze,
    async execute(_capability: string, action: { actionId: string }) {
      toolCalls.push(action);
      return { actionId: action.actionId, status: 'denied' };
    },
  };
}

test('the same seed and fixture replay to one event/policy trace and failures cite exact source events', async () => {
  const driver = await loadDriver();
  const raw = await loadFixture('dictation-to-result.json');
  const scenario = driver.parseScenario(raw);

  assert.equal(scenario.contractVersion, 1, 'recorded fixtures use the checked-in v1 contract');
  assert.equal(scenario.seed, raw.seed, 'fixture seed must survive contract validation');
  assert.ok(scenario.events.length > 0, 'a recorded scenario must contain events');

  // Contract validation: recorded fixtures are data, so a newer revision or a malformed event is rejected.
  assert.throws(() => driver.parseScenario({ ...raw, contractVersion: 2 }), 'a newer contract revision must be rejected');
  assert.throws(
    () => driver.parseScenario({
      ...raw,
      events: [{ eventId: 'evil-001', at: 'not-a-timestamp', kind: 'user_utterance', trust: 'user_explicit', text: 'x' }],
    }),
    'a malformed recorded event must be rejected',
  );

  const first = await driver.replayScenario(scenario, {
    now: fakeClock(),
    nativeHost: fakeNativeHost([]),
    providers: [fakeProvider()],
  });
  const second = await driver.replayScenario(scenario, {
    now: fakeClock(),
    nativeHost: fakeNativeHost([]),
    providers: [fakeProvider()],
  });

  assert.deepEqual(second.eventTrace, first.eventTrace, 'the same seed/fixture must replay the same event trace');
  assert.deepEqual(second.policyTrace, first.policyTrace, 'the same seed/fixture must replay the same policy trace');
  assert.ok(first.eventTrace.length > 0 && first.policyTrace.length > 0, 'replay must emit both traces');
  assert.equal(first.seed, scenario.seed);

  const findings = first.report.deterministic.findings;
  const checkIds = new Set(findings.map((finding) => finding.checkId));
  for (const required of REQUIRED_CHECKS) {
    assert.ok(checkIds.has(required), `scoring hooks must cover ${required}`);
  }

  const knownEventIds = new Set(scenario.events.map((event) => event.eventId));
  for (const finding of findings) {
    assert.ok(finding.sourceEventIds.length > 0, `finding ${finding.checkId} must cite source events`);
    for (const eventId of finding.sourceEventIds) {
      assert.ok(knownEventIds.has(eventId), `finding ${finding.checkId} cites unknown source event ${eventId}`);
    }
  }

  const failures = findings.filter((finding) => finding.status === 'fail');
  const claimFailure = failures.find((finding) => finding.checkId === 'factual_claim');
  assert.ok(claimFailure, 'the ungrounded claim must fail the factual_claim check');
  assert.ok(
    claimFailure.sourceEventIds.includes('claim-001'),
    'a failing check must link to the exact recorded source event',
  );
  assert.equal(
    first.report.deterministic.passed,
    failures.length === 0,
    'deterministic correctness must be derived from the checks, not asserted separately',
  );

  assert.equal(first.report.deterministic.toolInvocations, 1, 'the dictation edit is one local insert');
  assert.equal(first.report.deterministic.grantChanges, 0, 'replay must not invent grants');
  assert.equal(first.report.costs.paidCalls, 0, 'a replay must not make paid calls');
});

test('a malicious screenshot or log fixture cannot call a tool or alter a grant', async () => {
  const driver = await loadDriver();
  const scenario = driver.parseScenario(await loadFixture('malicious-injection.json'));

  const toolCalls: unknown[] = [];
  const provider = fakeProvider();
  const grants = Object.freeze([
    Object.freeze({ grantId: 'grant-001', capability: 'insert_text', effect: 'local_write' }),
  ]);
  const grantsBefore = structuredClone(grants);

  const run = await driver.replayScenario(scenario, {
    now: fakeClock(),
    nativeHost: fakeNativeHost(toolCalls),
    providers: [provider],
    grants,
  });

  assert.equal(toolCalls.length, 0, 'untrusted screenshot/log content must never reach NativeHost.execute');
  assert.equal(run.report.deterministic.toolInvocations, 0, 'the malicious fixture must invoke no tool');
  assert.equal(run.report.deterministic.grantChanges, 0, 'untrusted content must not alter a grant');
  assert.deepEqual(grants, grantsBefore, 'the grant set must be unchanged after replay');

  for (const untrustedEventId of ['shot-101', 'log-101']) {
    const scored = run.report.deterministic.findings.filter((finding) => finding.sourceEventIds.includes(untrustedEventId));
    assert.ok(scored.length > 0, `the evaluator must score untrusted event ${untrustedEventId}`);
    assert.ok(
      scored.every((finding) => finding.status === 'pass'),
      `untrusted event ${untrustedEventId} must be ignored as data`,
    );
  }
});

test('reports separate deterministic correctness, model quality, and human ratings with no hidden paid calls', async () => {
  const driver = await loadDriver();
  const scenario = driver.parseScenario(await loadFixture('dictation-to-result.json'));
  const provider = fakeProvider();

  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('normal CI replay must not touch the network');
  }) as typeof fetch;

  try {
    const run = await driver.replayScenario(scenario, {
      now: fakeClock(),
      nativeHost: fakeNativeHost([]),
      providers: [provider],
    });
    const report = run.report;

    assert.equal(typeof report.deterministic, 'object', 'report must contain deterministic correctness');
    assert.equal(typeof report.modelQuality, 'object', 'report must contain model quality');
    assert.equal(typeof report.humanRatings, 'object', 'report must contain human ratings');
    assert.ok(
      report.deterministic !== report.modelQuality
      && report.deterministic !== report.humanRatings
      && report.modelQuality !== report.humanRatings,
      'deterministic correctness, model quality, and human ratings must stay separate sections',
    );
    assert.ok(Array.isArray(report.humanRatings.ratings), 'human ratings stay an explicit, separate collection');
    assert.ok(
      Array.isArray(report.deterministic.findings),
      'deterministic correctness is reported per scored check, not as a single model opinion',
    );

    assert.ok(provider.calls.length > 0, 'replay must route model work through the injected fake providers');
    assert.ok(
      provider.calls.every((call) => call.providerId === undefined || call.providerId === 'fake-synthetic'),
      'no provider other than the injected fake may be called',
    );
    assert.ok(
      report.modelQuality.providerIds.every((providerId) => providerId.startsWith('fake')),
      'model quality must be attributed to fake providers only',
    );
    assert.equal(fetchCalls.length, 0, 'no network access may occur during normal CI replay');
    assert.equal(report.costs.paidCalls, 0, 'no hidden paid calls may occur during normal CI replay');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
