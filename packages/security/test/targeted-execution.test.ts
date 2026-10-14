/**
 * Focused regression for targeted execution: a caller that owns one queued request (a user
 * confirmed Memory question) must be able to run exactly that request. `runQueued()` keeps its
 * drain-everything contract for callers that explicitly want it, and the grant re-check, receipts
 * and idempotency semantics are shared by both entry points.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSecurityKernel,
  type CaptureOperation,
  type CaptureRequest,
  type GrantTuple,
  type KernelStorage,
  type MockProvider,
  type Operation,
  type SecretStore,
  type SecurityKernel,
} from '../src/index.js';

type Fixture = {
  captureCalls: CaptureRequest[];
  start(): SecurityKernel;
};

function createFixture(): Fixture {
  const secrets = new Map<string, string>();
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
  const capture: CaptureOperation = {
    invoke: async (request) => { captureCalls.push(request); return { artifactRef: `fixture://${request.requestId}` }; },
  };
  const provider: MockProvider = { complete: async () => ({ text: 'mock' }) };
  return { captureCalls, start: () => createSecurityKernel({ secrets: secretStore, storage, capture, provider }) };
}

function captureTuple(bundleId: string, lifetime: GrantTuple['lifetime'] = 'session'): GrantTuple {
  return {
    subject: 'user',
    capability: 'screen_capture',
    resource: { kind: 'app', bundleId },
    dataCategory: 'screenshot',
    destination: 'local',
    effect: 'read',
    lifetime,
  };
}

function captureOperation(requestId: string, bundleId = 'com.example.editor'): Operation {
  return {
    requestId,
    capability: 'screen_capture',
    resource: { kind: 'app', bundleId },
    dataCategory: 'screenshot',
    destination: 'local',
    effect: 'read',
    arguments: {},
    idempotencyKey: `idempotency-${requestId}`,
  };
}

function pending(kernel: SecurityKernel): number {
  return (kernel.getRendererState() as { pendingRequests: number }).pendingRequests;
}

test('runTargeted executes exactly the named request and leaves unrelated queued work untouched', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  const grant = await kernel.grantCapability(captureTuple('com.example.editor'));
  assert.ok(grant.grantId.length > 0);
  await kernel.enqueue(captureOperation('request-a'));
  await kernel.enqueue(captureOperation('request-b'));

  const outcome = await kernel.runTargeted('request-b');
  assert.equal(outcome?.requestId, 'request-b');
  assert.equal(outcome?.status, 'completed');
  assert.equal(fixture.captureCalls.length, 1, 'only the named request may execute');
  assert.equal(fixture.captureCalls[0]?.requestId, 'request-b');
  assert.equal(pending(kernel), 1, 'unrelated queued work must remain queued');

  // The drained request keeps the same receipt and idempotency shape as runQueued().
  const completedReceipt = kernel.getAuditReceipts()
    .find((receipt) => receipt.status === 'completed' && receipt.requestId === 'request-b');
  assert.ok(completedReceipt, 'the targeted run must write a completed receipt');
  assert.equal(completedReceipt?.idempotencyKey, 'idempotency-request-b');
  assert.equal(completedReceipt?.grantId, grant.grantId);

  // runQueued() still drains everything that is left.
  const remaining = await kernel.runQueued();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.requestId, 'request-a');
  assert.equal(remaining[0]?.status, 'completed');
  assert.equal(fixture.captureCalls.length, 2);
});

test('runTargeted re-checks the grant, denies a revoked request, and reports an absent request', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  const once = await kernel.grantCapability(captureTuple('com.example.once', 'once'));
  await kernel.enqueue(captureOperation('request-revoked', 'com.example.once'));
  await kernel.enqueue(captureOperation('request-sibling', 'com.example.once'));

  await kernel.revokeCapability({ grantId: once.grantId, reason: 'targeted revocation test' });
  const denied = await kernel.runTargeted('request-revoked');
  assert.equal(denied?.status, 'denied');
  assert.match(denied?.reason ?? '', /revoked/i);
  assert.equal(fixture.captureCalls.length, 0, 'a revoked targeted request must not reach the capability');

  // The sibling stays queued rather than being dragged along by the targeted run.
  assert.equal(pending(kernel), 1);
  assert.equal(await kernel.runTargeted('request-never-queued'), undefined);
  assert.equal(pending(kernel), 1, 'an absent request must not disturb the queue');

  // Re-granting lets the sibling complete, still with runQueued()'s drain-everything contract.
  await kernel.grantCapability(captureTuple('com.example.once', 'session'));
  const [sibling] = await kernel.runQueued();
  assert.equal(sibling?.requestId, 'request-sibling');
  assert.equal(sibling?.status, 'completed');
  assert.equal(fixture.captureCalls.length, 1);
});

test('a one-shot grant is consumed by a targeted run and leaves no active egress authority', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  const tuple: GrantTuple = {
    subject: 'user',
    capability: 'provider_egress',
    resource: { providerId: 'openai', projectId: 'project-atlas' },
    dataCategory: 'project_memory_summary',
    destination: 'provider',
    effect: 'external',
    lifetime: 'once',
  };
  await kernel.grantCapability(tuple);
  await kernel.enqueue({
    requestId: 'request-egress', capability: 'provider_egress',
    resource: { providerId: 'openai', projectId: 'project-atlas' },
    dataCategory: 'project_memory_summary', destination: 'provider', effect: 'external',
    arguments: { prompt: 'scoped prompt' }, idempotencyKey: 'request-egress',
  });

  const outcome = await kernel.runTargeted('request-egress');
  assert.equal(outcome?.status, 'completed');
  assert.equal((kernel.getRendererState() as { activeGrants: number }).activeGrants, 0);
  assert.deepEqual(kernel.getEgressCategories(), {}, 'the consumed one-time grant must not stay active');
});
