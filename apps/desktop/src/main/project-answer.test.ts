/**
 * Focused tests for the user-confirmed Memory question path. They run the real security kernel
 * with in-memory storage and a real OpenAI text provider whose fetch transport is faked, so the
 * grant lifecycle, targeted dispatch, prompt contents and unknown-usage handling are exercised
 * end to end without a network call or a real key.
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
import { createOpenAITextProvider, type OpenAITextProvider } from '../../../../packages/providers/src/openai-text/index.js';
import type { TimelineItem } from '../../../../packages/memory/src/store/types.js';
import { answerProjectFromEvidence } from './project-answer.js';

const PROJECT_ID = 'project-atlas';
const QUESTION = 'What did we decide about Atlas retries?';
/** A marker that exists only in an unselected memory; it must never reach the provider. */
const UNSELECTED_MARKER = 'ZXQ-77';
const SELECTED_IDS = ['memory-retry', 'memory-backoff'] as const;

function memory(id: string, summary: string): TimelineItem {
  return { id, kind: 'task', summary, sourceEventIds: [`event-${id}`], occurredAt: '2026-09-28T09:00:00.000Z' };
}

const TIMELINE: readonly TimelineItem[] = [
  memory('memory-retry', 'Raise the Atlas ingest retry budget from 3 to 5 attempts.'),
  memory('memory-backoff', 'Atlas moved to exponential backoff for failed ingest batches.'),
  memory('memory-unselected', `Unselected Atlas memory mentioning ${UNSELECTED_MARKER} and payroll approvals.`),
];

type Harness = {
  kernel: SecurityKernel;
  provider: OpenAITextProvider;
  /** Every provider transport call, with the parsed request body. */
  transport: Array<{ url: string; body: Record<string, unknown> }>;
  captureCalls: CaptureRequest[];
  restartKernel(): SecurityKernel;
};

function createHarness(fetcher: (url: string, init: RequestInit) => Promise<Response>): Harness {
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
    model: () => 'gpt-6-luna',
    fetcher: async (url, init) => {
      transport.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return fetcher(url, init);
    },
  });
  const start = (): SecurityKernel => createSecurityKernel({
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
  const kernel = start();
  return { kernel, provider, transport, captureCalls, restartKernel: start };
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

function captureTuple(): GrantTuple {
  return {
    subject: 'user', capability: 'screen_capture', resource: { kind: 'app', bundleId: 'com.example.editor' },
    dataCategory: 'screenshot', destination: 'local', effect: 'read', lifetime: 'session',
  };
}

function unrelatedCaptureOperation(requestId: string): Operation {
  return {
    requestId, capability: 'screen_capture', resource: { kind: 'app', bundleId: 'com.example.editor' },
    dataCategory: 'screenshot', destination: 'local', effect: 'read',
    arguments: {}, idempotencyKey: requestId,
  };
}

test('a confirmed question sends only selected evidence behind a one-time grant and leaves no active egress', async () => {
  const harness = createHarness(async () => answeredResponse(
    'Raise retries to five [1] and keep exponential backoff [2].',
    { input_tokens: 100, output_tokens: 50 },
  ));

  const result = await answerProjectFromEvidence(
    { projectId: PROJECT_ID, question: QUESTION, itemIds: [...SELECTED_IDS] },
    { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
  );

  assert.equal(result.answer, 'Raise retries to five [1] and keep exponential backoff [2].');
  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.estimatedUsd, (100 * 0.10 + 50 * 0.50) / 1_000_000);
  assert.deepEqual(result.evidence.map((entry) => entry.id), [...SELECTED_IDS]);
  assert.deepEqual(result.evidence.map((entry) => entry.number), [1, 2]);

  // Exactly one transport call, carrying the question and only the selected summaries.
  assert.equal(harness.transport.length, 1);
  const call = harness.transport[0]!;
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.body.store, false);
  assert.equal(call.body.model, 'gpt-6-luna');
  const prompt = String(call.body.input);
  assert.ok(prompt.includes(QUESTION));
  assert.ok(prompt.includes('Raise the Atlas ingest retry budget'));
  assert.ok(prompt.includes('exponential backoff'));
  assert.ok(!prompt.includes(UNSELECTED_MARKER), 'unselected evidence must never be sent');

  // The one-time provider grant is finished: consumed by the kernel, then explicitly revoked.
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});

  const completions = harness.kernel.getAuditReceipts()
    .filter((receipt) => receipt.status === 'completed' && receipt.capability === 'provider_egress');
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.idempotencyKey, completions[0]?.requestId);
});

test('a question never dispatches unrelated queued work and its own outcome is the only one read', async () => {
  const harness = createHarness(async () => answeredResponse('Bounded answer [1].', { input_tokens: 10, output_tokens: 5 }));
  await harness.kernel.grantCapability(captureTuple());
  await harness.kernel.enqueue(unrelatedCaptureOperation('unrelated-capture-1'));

  const result = await answerProjectFromEvidence(
    { projectId: PROJECT_ID, question: QUESTION, itemIds: [SELECTED_IDS[0]] },
    { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
  );
  assert.equal(result.answer, 'Bounded answer [1].');

  // The unrelated capture stayed queued and untouched while the question ran.
  assert.equal(harness.captureCalls.length, 0, 'the question must not execute unrelated queued work');
  assert.equal(pendingRequests(harness.kernel), 1);
  const requestIds = harness.kernel.getAuditReceipts().map((receipt) => receipt.requestId);
  assert.ok(!requestIds.includes('unrelated-capture-1'), 'no receipt may exist for the unrelated request yet');

  // runQueued() keeps its drain-everything contract for callers that ask for it.
  const drained = await harness.kernel.runQueued();
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.requestId, 'unrelated-capture-1');
  assert.equal(drained[0]?.status, 'completed');
  assert.equal(harness.captureCalls.length, 1);
});

test('invalid and stale selections fail before any grant, transport, or dispatch', async () => {
  const harness = createHarness(async () => { throw new Error('transport must not be reached'); });

  await assert.rejects(
    () => answerProjectFromEvidence(
      { projectId: PROJECT_ID, question: QUESTION, itemIds: ['memory-retry', 'memory-missing'] },
      { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
    ),
    /changed; review the evidence again/,
  );
  await assert.rejects(
    () => answerProjectFromEvidence(
      { projectId: PROJECT_ID, question: QUESTION, itemIds: ['memory-retry', 'memory-retry'] },
      { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
    ),
    TypeError,
  );
  await assert.rejects(
    () => answerProjectFromEvidence(
      { projectId: PROJECT_ID, question: QUESTION, itemIds: [] },
      { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
    ),
    TypeError,
  );
  await assert.rejects(
    () => answerProjectFromEvidence(
      { projectId: PROJECT_ID, question: 'q'.repeat(1_001), itemIds: [SELECTED_IDS[0]] },
      { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
    ),
    TypeError,
  );

  assert.equal(harness.transport.length, 0);
  assert.equal(pendingRequests(harness.kernel), 0);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
});

test('a provider failure revokes the grant, sends no unselected data, and leaves nothing active across restart', async () => {
  const harness = createHarness(async () => new Response('upstream is boring', { status: 500 }));

  await assert.rejects(
    () => answerProjectFromEvidence(
      { projectId: PROJECT_ID, question: QUESTION, itemIds: [...SELECTED_IDS] },
      { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
    ),
    /OpenAI request failed \(500\)/,
  );

  // The single attempted transport call still carried only the selected evidence.
  assert.equal(harness.transport.length, 1);
  assert.ok(!String(harness.transport[0]!.body.input).includes(UNSELECTED_MARKER));
  assert.equal(harness.captureCalls.length, 0);

  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
  assert.equal(pendingRequests(harness.kernel), 0);
  assert.ok(
    harness.kernel.getAuditReceipts().some((receipt) => receipt.status === 'revoked' && receipt.capability === 'provider_egress'),
    'the failed request must revoke its still-live one-time grant',
  );

  const restarted = harness.restartKernel();
  await restarted.ready();
  assert.equal(providerActiveGrants(restarted), 0);
  assert.deepEqual(restarted.getEgressCategories(), {});
});

test('missing usage yields an unknown cost instead of a zero-dollar estimate', async () => {
  const harness = createHarness(async () => answeredResponse('Grounded answer [1].'));

  const result = await answerProjectFromEvidence(
    { projectId: PROJECT_ID, question: QUESTION, itemIds: [SELECTED_IDS[0]] },
    { timeline: TIMELINE, kernel: harness.kernel, provider: harness.provider },
  );

  assert.equal(result.answer, 'Grounded answer [1].');
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.estimatedUsd, null, 'an unreported cost is unknown, never $0.0000');
  assert.notEqual(result.estimatedUsd, 0);
  assert.equal(providerActiveGrants(harness.kernel), 0);
  assert.deepEqual(harness.kernel.getEgressCategories(), {});
});
