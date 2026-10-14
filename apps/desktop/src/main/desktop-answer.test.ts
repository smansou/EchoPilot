/**
 * Focused tests for the grounded desktop-answer seam. They run the real security kernel with
 * in-memory storage and the real OpenAI text provider whose fetch transport is faked, so the
 * one-time grant lifecycle, targeted dispatch, exact prompt binding, capsule caps, and the
 * preview/confirm/cancel consent states are exercised end to end without a network call, a real
 * key, or a live Accessibility capture.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSecurityKernel,
  type CaptureRequest,
  type GrantTuple,
  type KernelStorage,
  type Operation,
  type SecretStore,
  type SecurityKernel,
} from '../../../../packages/security/src/index.js';
import { createOpenAITextProvider, type OpenAITextProvider, type TextModel } from '../../../../packages/providers/src/openai-text/index.js';
import type { ForegroundEvidence, ForegroundEvidenceNode } from './desktop-observe.js';
import {
  createDesktopAnswerService,
  DESKTOP_ANSWER_MAX_PROMPT_CHARS,
  DESKTOP_ANSWER_SNAPSHOT_TTL_MS,
  type DesktopAnswerResult,
  type DesktopAnswerService,
} from './desktop-answer.js';

const PROJECT_ID = 'project-atlas';
const OTHER_PROJECT = 'project-borealis';
const QUESTION = 'What does the retry setting currently say?';

function axNode(overrides: Partial<ForegroundEvidenceNode> = {}): ForegroundEvidenceNode {
  return {
    depth: 1,
    role: 'AXStaticText',
    subrole: null,
    label: null,
    value: null,
    labelTruncated: false,
    valueTruncated: false,
    redacted: false,
    roleTruncated: false,
    subroleTruncated: false,
    ...overrides,
  };
}

function buildEvidence(nodes: readonly ForegroundEvidenceNode[]): ForegroundEvidence {
  return {
    kind: 'desktop_observe',
    observedAtMs: 1_759_000_000_000,
    projectId: PROJECT_ID,
    application: { pid: 501, bundleId: 'com.apple.TextEdit', name: 'TextEdit', bundleIdTruncated: false, nameTruncated: false },
    window: { role: 'AXWindow', roleTruncated: false, title: 'Untitled', titleTruncated: false },
    nodes,
    quality: 'full',
    truncated: false,
    truncations: [],
    stats: { visitedNodes: nodes.length, emittedNodes: nodes.length, maxDepthReached: 1, estimatedBytes: 512 },
  };
}

function expectOk<T>(result: DesktopAnswerResult<T>): T {
  if (!result.ok) throw new Error(`expected success but got ${result.code}: ${result.message}`);
  return result.value;
}

function answeredResponse(text: string, usage?: Record<string, number>): Response {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    ...(usage ? { usage } : {}),
  }), { status: 200 });
}

function providerActiveGrants(kernel: SecurityKernel): number {
  return (kernel.getRendererState() as { activeGrants: number }).activeGrants;
}

function pendingRequests(kernel: SecurityKernel): number {
  return (kernel.getRendererState() as { pendingRequests: number }).pendingRequests;
}

type Harness = {
  service: DesktopAnswerService;
  kernel: SecurityKernel;
  provider: OpenAITextProvider;
  transport: Array<{ url: string; body: Record<string, unknown> }>;
  captureCalls: CaptureRequest[];
  setNow(value: number): void;
  advance(ms: number): void;
};

/**
 * Interleaving hook: `Kernel` methods live on the prototype, so tests cannot spread a copy. A
 * proxy awaits the hook (a gate the test controls) before delegating to the real method, which
 * lets a test change the active project or model while the service is mid-await.
 */
function hookKernel(
  kernel: SecurityKernel,
  hooks: Readonly<{ grantCapability?: () => Promise<void>; enqueue?: () => Promise<void> }>,
): SecurityKernel {
  return new Proxy(kernel, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      const hook = property === 'grantCapability' ? hooks.grantCapability
        : property === 'enqueue' ? hooks.enqueue
        : undefined;
      if (hook) return async (...args: unknown[]) => { await hook(); return method.apply(target, args); };
      return method.bind(target);
    },
  });
}

function createHarness(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  options: Readonly<{
    activeProjects?: ReadonlySet<string>;
    /** Awaited before the one-time grant is persisted, so a test can close the project mid-await. */
    beforeGrant?: () => Promise<void>;
    /** Awaited before the request is enqueued, so a test can close the project mid-await. */
    beforeEnqueue?: () => Promise<void>;
    /** Mutable model identity so a test can change it while a confirmation is awaiting. */
    model?: () => TextModel;
  }> = {},
): Harness {
  const active = options.activeProjects ?? new Set([PROJECT_ID]);
  let clock = 1_759_000_000_000;
  const secrets = new Map<string, string>([['openai', 'fixture-test-key']]);
  const secretStore: SecretStore = {
    put: async (provider, secret) => { secrets.set(provider, secret); },
    get: async (provider) => secrets.get(provider) ?? null,
    delete: async (provider) => { secrets.delete(provider); },
  };
  let durable: string | null = null;
  const storage: KernelStorage = {
    read: async () => durable,
    write: async (serialized) => { durable = serialized; },
  };
  const captureCalls: CaptureRequest[] = [];
  const transport: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = createOpenAITextProvider({
    secrets: secretStore,
    model: options.model ?? (() => 'gpt-6-luna'),
    fetcher: async (url, init) => {
      transport.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return fetcher(url, init);
    },
  });
  const kernel = createSecurityKernel({
    secrets: secretStore,
    storage,
    capture: {
      invoke: async (request) => {
        captureCalls.push(request);
        return { artifactRef: `fixture://${request.requestId}` };
      },
    },
    provider,
  });
  const serviceKernel = options.beforeGrant || options.beforeEnqueue
    ? hookKernel(kernel, { ...(options.beforeGrant ? { grantCapability: options.beforeGrant } : {}), ...(options.beforeEnqueue ? { enqueue: options.beforeEnqueue } : {}) })
    : kernel;
  const service = createDesktopAnswerService({
    kernel: () => serviceKernel,
    provider: () => provider,
    isProjectActive: (projectId) => active.has(projectId),
    now: () => clock,
  });
  return {
    service,
    kernel,
    provider,
    transport,
    captureCalls,
    setNow: (value) => { clock = value; },
    advance: (ms) => { clock += ms; },
  };
}

test('observing, previewing, and canceling never grant, queue, dispatch, or reach the provider', async () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([
    axNode({ label: 'Retry budget', value: '5' }),
    axNode({ label: 'Backoff', value: 'exponential' }),
  ]));
  assert.ok(snapshotId.length > 0);

  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  assert.equal(preview.destination.providerId, 'openai');
  assert.equal(preview.destination.model, 'gpt-6-luna');
  assert.equal(preview.evidence.rows.length, 2);
  assert.equal(preview.evidence.rows[0]?.number, 1);
  assert.equal(preview.evidence.rows[0]?.label, 'Retry budget');
  assert.equal(preview.evidence.rows[0]?.evidenceId, 'desk:ax:0');
  assert.equal(preview.evidence.application.name, 'TextEdit');
  assert.equal(preview.evidence.window.title, 'Untitled');
  assert.equal(preview.expiresAtMs, 1_759_000_000_000 + DESKTOP_ANSWER_SNAPSHOT_TTL_MS);

  // Preview disclosed the exact prompt without any grant, queue entry, or transport call.
  assert.ok(preview.prompt.includes('[1] Retry budget — 5'));
  assert.equal(harness.transport.length, 0);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.equal(pendingRequests(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});

  const canceled = harness.service.cancel({ projectId: PROJECT_ID, confirmationId: preview.confirmationId });
  assert.equal(expectOk(canceled).canceled, true);

  assert.equal(harness.transport.length, 0);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.equal(pendingRequests(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
  // No raw evidence leaked into audit receipts (there are none yet).
  assert.equal(harness.kernel.getAuditReceipts().length, 0);

  // Canceling discarded the pending snapshot, so neither token can be replayed.
  const replayedPreview = harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION });
  assert.equal(replayedPreview.ok, false);
  if (!replayedPreview.ok) assert.equal(replayedPreview.code, 'snapshot_unknown');
  const replayedCancel = harness.service.cancel({ projectId: PROJECT_ID, confirmationId: preview.confirmationId });
  assert.equal(replayedCancel.ok, false);
  if (!replayedCancel.ok) assert.equal(replayedCancel.code, 'confirmation_unknown');
});

test('confirm sends exactly the previewed prompt once, behind a one-time grant, and returns a model-generated answer', async () => {
  const harness = createHarness(async () => answeredResponse(
    'The retry budget is five [1].',
    { input_tokens: 120, output_tokens: 18 },
  ));

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([
    axNode({ label: 'Retry budget', value: '5' }),
    axNode({ label: 'Backoff', value: 'exponential' }),
  ]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  const outcome = expectOk(await harness.service.confirm({
    projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true,
  }));

  assert.equal(outcome.answer, 'The retry budget is five [1].');
  assert.equal(outcome.answerKind, 'model_generated');
  assert.equal(outcome.citationsVerified, false);
  assert.equal(outcome.model, 'gpt-6-luna');
  assert.equal(outcome.inputTokens, 120);
  assert.equal(outcome.outputTokens, 18);
  assert.equal(outcome.estimatedUsd, null);
  assert.equal(outcome.snapshotId, snapshotId);
  assert.equal(outcome.evidence.rows.length, 2);

  // One transport call, carrying exactly the previewed prompt and the desktop category.
  assert.equal(harness.transport.length, 1);
  const call = harness.transport[0]!;
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.body.model, 'gpt-6-luna');
  assert.equal(call.body.store, false);
  assert.equal(call.body.input, preview.prompt, 'the provider must receive exactly the previewed prompt');
  assert.match(String(call.body.instructions), /Accessibility evidence/);
  assert.match(String(call.body.instructions), /never claim a screenshot/);

  // The one-time grant is finished: consumed by the kernel, then explicitly revoked.
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
  const completions = harness.kernel.getAuditReceipts()
    .filter((receipt) => receipt.status === 'completed' && receipt.capability === 'provider_egress');
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.dataCategory, 'desktop_ax_evidence');
  assert.equal(completions[0]?.idempotencyKey, completions[0]?.requestId);

  // The confirmation can never be replayed, and the snapshot carries no raw rows into receipts.
  const replay = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.code, 'confirmation_unknown');
  assert.equal(harness.transport.length, 1);
  assert.ok(!JSON.stringify(harness.kernel.getAuditReceipts()).includes('Retry budget'));
});

test('secure and redacted nodes are omitted regardless of value; an unusable snapshot cannot be previewed', () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([
    axNode({ redacted: true, label: 'REDACTED-MARKER-1', value: 'REDACTED-MARKER-2' }),
    axNode({ role: 'AXSecureTextField', label: 'Password SECURE-MARKER-3', value: 'SECURE-MARKER-4' }),
    axNode({ subrole: 'AXSecureTextArea', label: 'SECURE-MARKER-5' }),
    axNode({ label: 'Retry budget', value: '5' }),
    axNode({ label: '   ', value: '   ' }),
  ]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  assert.equal(preview.evidence.rows.length, 1);
  assert.equal(preview.evidence.rows[0]?.label, 'Retry budget');
  assert.equal(preview.evidence.rows[0]?.evidenceId, 'desk:ax:3');
  assert.equal(preview.evidence.omittedRows, 0);
  assert.ok(!preview.prompt.includes('REDACTED-MARKER'));
  assert.ok(!preview.prompt.includes('SECURE-MARKER'));

  const unusable = harness.service.capture(PROJECT_ID, buildEvidence([
    axNode({ redacted: true, label: 'hidden', value: 'HIDDEN' }),
    axNode({ role: 'AXSecureTextField', value: 'hidden' }),
    axNode({ label: '  ', value: '' }),
  ]));
  const refused = harness.service.preview({ projectId: PROJECT_ID, snapshotId: unusable, question: QUESTION });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'evidence_empty');
});

test('rows, question, prompt, and stored state stay inside their caps', () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });

  const long = 'x'.repeat(500);
  const nodes = Array.from({ length: 40 }, (_, index) => axNode({ label: `Label ${index} ${long}`, value: `Value ${index} ${long}` }));
  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence(nodes));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  assert.equal(preview.evidence.rows.length, 24);
  assert.equal(preview.evidence.omittedRows, 16);
  for (const row of preview.evidence.rows) {
    assert.ok((row.label?.length ?? 0) <= 200);
    assert.ok((row.value?.length ?? 0) <= 200);
    assert.ok((row.role.length ?? 0) <= 200);
    assert.equal(row.truncated, true);
  }
  assert.ok(preview.prompt.length <= DESKTOP_ANSWER_MAX_PROMPT_CHARS);
  for (const line of preview.prompt.split('\n')) {
    if (/^\[\d+\]/.test(line)) assert.ok(line.length <= 200, `row line exceeds 200 chars: ${line.length}`);
  }

  const longQuestion = harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: 'q'.repeat(1_001) });
  assert.equal(longQuestion.ok, false);
  if (!longQuestion.ok) assert.equal(longQuestion.code, 'invalid_question');
  const emptyQuestion = harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: '   ' });
  assert.equal(emptyQuestion.ok, false);
  if (!emptyQuestion.ok) assert.equal(emptyQuestion.code, 'invalid_question');

  // Bounded confirmations: a ninth preview evicts the oldest confirmation.
  const confirmations = Array.from({ length: 9 }, () =>
    expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION })));
  const oldest = harness.service.cancel({
    projectId: PROJECT_ID, confirmationId: confirmations[0]!.confirmationId,
  });
  assert.equal(oldest.ok, false);
  if (!oldest.ok) assert.equal(oldest.code, 'confirmation_unknown');

  // Bounded snapshots: a ninth observation evicts the oldest (checked last: it discards the
  // long-evidence snapshot below, which the confirmation checks above still needed).
  const first = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'first', value: '1' })]));
  for (let index = 0; index < 8; index += 1) {
    harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: `later ${index}`, value: `${index}` })]));
  }
  const evicted = harness.service.preview({ projectId: PROJECT_ID, snapshotId: first, question: QUESTION });
  assert.equal(evicted.ok, false);
  if (!evicted.ok) assert.equal(evicted.code, 'snapshot_unknown');
});

test('unconfirmed, foreign, stale, and expired attempts fail before any provider call', async () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  // An unconfirmed attempt is refused without consuming the confirmation.
  const unconfirmed = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: false });
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.code, 'not_confirmed');

  // Cross-project preview and confirm are distinct typed refusals, and a foreign confirm does not
  // consume the owner's confirmation.
  const foreignPreview = harness.service.preview({ projectId: OTHER_PROJECT, snapshotId, question: QUESTION });
  assert.equal(foreignPreview.ok, false);
  if (!foreignPreview.ok) assert.equal(foreignPreview.code, 'snapshot_foreign');
  const foreignConfirm = await harness.service.confirm({ projectId: OTHER_PROJECT, confirmationId: preview.confirmationId, confirmed: true });
  assert.equal(foreignConfirm.ok, false);
  if (!foreignConfirm.ok) assert.equal(foreignConfirm.code, 'confirmation_foreign');
  const foreignCancel = harness.service.cancel({ projectId: OTHER_PROJECT, confirmationId: preview.confirmationId });
  assert.equal(foreignCancel.ok, false);
  if (!foreignCancel.ok) assert.equal(foreignCancel.code, 'confirmation_foreign');

  // Unknown references stay distinct from expired ones.
  const unknownSnapshot = harness.service.preview({ projectId: PROJECT_ID, snapshotId: 'no-such-snapshot', question: QUESTION });
  assert.equal(unknownSnapshot.ok, false);
  if (!unknownSnapshot.ok) assert.equal(unknownSnapshot.code, 'snapshot_unknown');
  const unknownConfirmation = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: 'no-such-preview', confirmed: true });
  assert.equal(unknownConfirmation.ok, false);
  if (!unknownConfirmation.ok) assert.equal(unknownConfirmation.code, 'confirmation_unknown');

  // After the five-minute TTL both the confirmation and the snapshot are expired.
  harness.advance(DESKTOP_ANSWER_SNAPSHOT_TTL_MS);
  const expiredConfirm = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  assert.equal(expiredConfirm.ok, false);
  if (!expiredConfirm.ok) assert.equal(expiredConfirm.code, 'confirmation_expired');
  const expiredSnapshot = harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION });
  assert.equal(expiredSnapshot.ok, false);
  if (!expiredSnapshot.ok) assert.equal(expiredSnapshot.code, 'snapshot_expired');

  assert.equal(harness.transport.length, 0, 'no stale reference may reach the provider');
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
});

test('a closed project prevents execution before any grant or provider call', async () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); }, { activeProjects: new Set() });
  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  const inactive = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  assert.equal(inactive.ok, false);
  if (!inactive.ok) assert.equal(inactive.code, 'project_inactive');
  assert.equal(harness.transport.length, 0);
  assert.equal(providerActiveGrants(harness.kernel), 0);
});

test('a provider failure revokes the grant and the confirmation cannot be reused', async () => {
  const harness = createHarness(async () => new Response('upstream is boring', { status: 500 }));

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  const failed = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, 'kernel_denied');

  assert.equal(harness.transport.length, 1);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
  assert.equal(pendingRequests(harness.kernel), 0);
  assert.ok(
    harness.kernel.getAuditReceipts().some((receipt) => receipt.status === 'revoked' && receipt.capability === 'provider_egress'),
    'the failed request must revoke its still-live one-time grant',
  );

  const replay = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.code, 'confirmation_unknown');
  assert.equal(harness.transport.length, 1, 'a failed confirmation can never be dispatched again');
});

test('a desktop answer never dispatches unrelated queued work', async () => {
  const harness = createHarness(async () => answeredResponse('Grounded answer [1].', { input_tokens: 10, output_tokens: 5 }));
  await harness.kernel.grantCapability({
    subject: 'user', capability: 'screen_capture', resource: { kind: 'app', bundleId: 'com.example.editor' },
    dataCategory: 'screenshot', destination: 'local', effect: 'read', lifetime: 'session',
  } satisfies GrantTuple);
  await harness.kernel.enqueue({
    requestId: 'unrelated-capture-1', capability: 'screen_capture', resource: { kind: 'app', bundleId: 'com.example.editor' },
    dataCategory: 'screenshot', destination: 'local', effect: 'read',
    arguments: {}, idempotencyKey: 'unrelated-capture-1',
  } satisfies Operation);

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  const outcome = expectOk(await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true }));
  assert.equal(outcome.answer, 'Grounded answer [1].');

  assert.equal(harness.captureCalls.length, 0, 'the desktop answer must not execute unrelated queued work');
  assert.equal(pendingRequests(harness.kernel), 1);
  const requestIds = harness.kernel.getAuditReceipts().map((receipt) => receipt.requestId);
  assert.ok(!requestIds.includes('unrelated-capture-1'));

  const drained = await harness.kernel.runQueued();
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.requestId, 'unrelated-capture-1');
  assert.equal(harness.captureCalls.length, 1);
});

test('concurrent confirmations cannot dispatch the same work twice', async () => {
  let startFetch!: () => void;
  const started = new Promise<void>((resolve) => { startFetch = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = createHarness(async () => {
    startFetch();
    await gate;
    return answeredResponse('Slow but grounded [1].');
  });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const first = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  const second = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  assert.notEqual(first.confirmationId, second.confirmationId);

  const running = harness.service.confirm({ projectId: PROJECT_ID, confirmationId: first.confirmationId, confirmed: true });
  await started;

  const busy = await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: second.confirmationId, confirmed: true });
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.code, 'busy');
  assert.equal(harness.transport.length, 1);

  release();
  const outcome = expectOk(await running);
  assert.equal(outcome.answer, 'Slow but grounded [1].');
  assert.equal(harness.transport.length, 1);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
});

test('the snapshot owns a frozen copy of the evidence; later mutation cannot change what is sent', async () => {
  const harness = createHarness(async () => answeredResponse('Answer [1].'));

  const captured = buildEvidence([axNode({ label: 'Original label', value: '1' })]);
  const snapshotId = harness.service.capture(PROJECT_ID, captured);
  const mutable = captured as unknown as {
    application: { name: string };
    nodes: Array<{ label: string | null; value: string | null }>;
  };
  mutable.application.name = 'MUTATED-MARKER-1';
  mutable.nodes[0]!.label = 'MUTATED-MARKER-2';
  mutable.nodes[0]!.value = 'MUTATED-MARKER-3';

  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  assert.equal(preview.evidence.application.name, 'TextEdit');
  assert.equal(preview.evidence.rows[0]?.label, 'Original label');
  assert.ok(!preview.prompt.includes('MUTATED-MARKER'));

  const outcome = expectOk(await harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true }));
  assert.equal(outcome.answer, 'Answer [1].');
  assert.equal(harness.transport[0]!.body.input, preview.prompt);
  assert.ok(!String(harness.transport[0]!.body.input).includes('MUTATED-MARKER'));
});

test('latest returns the newest live snapshot for the exact project without capturing or granting', () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });

  // No snapshot at all is an honest null, not an error and not a capture.
  assert.equal(expectOk(harness.service.latest(PROJECT_ID)), null);

  const firstId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'First', value: '1' })]));
  const otherId = harness.service.capture(OTHER_PROJECT, buildEvidence([axNode({ label: 'Foreign', value: '2' })]));
  const secondId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Second', value: '2' })]));

  const context = expectOk(harness.service.latest(PROJECT_ID));
  assert.ok(context !== null);
  assert.equal(context.snapshotId, secondId, 'the newest snapshot for the exact project wins');
  assert.equal(context.observedAtMs, 1_759_000_000_000);
  assert.equal(context.expiresAtMs, 1_759_000_000_000 + DESKTOP_ANSWER_SNAPSHOT_TTL_MS);
  assert.notEqual(context.snapshotId, firstId);

  // The exact project only: a newer foreign snapshot is never offered as this project's evidence.
  const foreign = expectOk(harness.service.latest(OTHER_PROJECT));
  assert.equal(foreign?.snapshotId, otherId);

  // Reading the pointer never observed, captured, granted, queued, or reached the provider.
  assert.equal(harness.captureCalls.length, 0);
  assert.equal(harness.transport.length, 0);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.equal(pendingRequests(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});

  // TTL is honored: after it elapses the snapshot is expired and the answer is an honest null.
  harness.advance(DESKTOP_ANSWER_SNAPSHOT_TTL_MS);
  assert.equal(expectOk(harness.service.latest(PROJECT_ID)), null);

  const invalid = harness.service.latest('');
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'invalid_request');
});

test('latest never offers a snapshot the user canceled', () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });
  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));
  assert.equal(expectOk(harness.service.latest(PROJECT_ID))?.snapshotId, snapshotId);

  expectOk(harness.service.cancel({ projectId: PROJECT_ID, confirmationId: preview.confirmationId }));
  assert.equal(expectOk(harness.service.latest(PROJECT_ID)), null, 'canceled evidence is discarded, not offered again');
  assert.equal(harness.transport.length, 0);
});

test('a project that closes while the grant is being persisted cannot reach the provider', async () => {
  const active = new Set([PROJECT_ID]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let grantStarted!: () => void;
  const started = new Promise<void>((resolve) => { grantStarted = resolve; });
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); }, {
    activeProjects: active,
    beforeGrant: async () => { grantStarted(); await gate; },
  });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  const pending = harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  await started;
  active.delete(PROJECT_ID);
  release();

  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'project_inactive');
  assert.equal(harness.transport.length, 0, 'a project that closed during the grant await is never sent');
  assert.equal(providerActiveGrants(harness.kernel), 0, 'the grant created during the await is revoked');
  assert.equal(pendingRequests(harness.kernel), 0, 'no request may be enqueued for a closed project');
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
});

test('a model change while the grant is being persisted cannot reach the provider', async () => {
  let model: TextModel = 'gpt-6-luna';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let grantStarted!: () => void;
  const started = new Promise<void>((resolve) => { grantStarted = resolve; });
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); }, {
    model: () => model,
    beforeGrant: async () => { grantStarted(); await gate; },
  });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  const pending = harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  await started;
  model = 'gpt-6-sol';
  release();

  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'model_changed');
  assert.equal(harness.transport.length, 0, 'a model that changed during the grant await is never sent');
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.equal(pendingRequests(harness.kernel), 0);
});

test('a project that closes while the request is enqueued leaves a revoked grant and no egress', async () => {
  const active = new Set([PROJECT_ID]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let enqueueStarted!: () => void;
  const started = new Promise<void>((resolve) => { enqueueStarted = resolve; });
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); }, {
    activeProjects: active,
    beforeEnqueue: async () => { enqueueStarted(); await gate; },
  });

  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({ label: 'Retry budget', value: '5' })]));
  const preview = expectOk(harness.service.preview({ projectId: PROJECT_ID, snapshotId, question: QUESTION }));

  const pending = harness.service.confirm({ projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true });
  await started;
  active.delete(PROJECT_ID);
  release();

  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'project_inactive');
  assert.equal(harness.transport.length, 0, 'the recheck before dispatch blocks a closed project');
  assert.equal(providerActiveGrants(harness.kernel), 0, 'the one-time grant is revoked in finally');

  // The service itself never drains the queue; if the queued request survives, its revoked grant
  // must still deny it so no later egress is possible.
  const queued = pendingRequests(harness.kernel);
  if (queued > 0) {
    const drained = await harness.kernel.runQueued();
    assert.equal(drained.length, queued);
    for (const outcome of drained) assert.notEqual(outcome.status, 'completed');
  }
  assert.equal(harness.transport.length, 0, 'a revoked grant prevents any subsequent provider call');
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
});

test('clear during provider await aborts and suppresses the old answer and snapshot', async () => {
  let ready: (() => void) | undefined; let release: (() => void) | undefined;
  const started = new Promise<void>(resolve => {ready = resolve;});
  const blocked = new Promise<void>(resolve => {release = resolve;});
  let signal: AbortSignal | null = null;
  const harness = createHarness(async (_url, init) => {signal = init.signal as AbortSignal; ready!(); await blocked; return answeredResponse('old private answer');});
  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({label: 'Private fixture'})]));
  const preview = expectOk(harness.service.preview({projectId: PROJECT_ID, snapshotId, question: QUESTION}));
  const pending = harness.service.confirm({projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true});
  await started; harness.service.clear(); assert.equal((signal as AbortSignal | null)?.aborted, true); release!();
  assert.equal((await pending).ok, false); assert.equal(expectOk(harness.service.latest(PROJECT_ID)), null);
  assert.equal(providerActiveGrants(harness.kernel), 0);
});

test('clear while grant persists prevents enqueue and provider dispatch', async () => {
  let ready: (() => void) | undefined; let release: (() => void) | undefined;
  const started = new Promise<void>(resolve => {ready = resolve;});
  const blocked = new Promise<void>(resolve => {release = resolve;});
  const harness = createHarness(async () => answeredResponse('unexpected'), {beforeGrant: async () => {ready!(); await blocked;}});
  const snapshotId = harness.service.capture(PROJECT_ID, buildEvidence([axNode({label: 'Fixture'})]));
  const preview = expectOk(harness.service.preview({projectId: PROJECT_ID, snapshotId, question: QUESTION}));
  const pending = harness.service.confirm({projectId: PROJECT_ID, confirmationId: preview.confirmationId, confirmed: true});
  await started; harness.service.clear(); release!();
  assert.equal((await pending).ok, false); assert.equal(harness.transport.length, 0); assert.equal(pendingRequests(harness.kernel), 0);
});
