/**
 * Focused regressions for the S01 reviewer findings (kept separate from the frozen acceptance
 * test): revocation must invalidate exactly the targeted grant, and the key reference must be an
 * opaque handle rather than a digest of the secret.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createSecurityKernel,
  type CaptureOperation,
  type CaptureRequest,
  type GrantTuple,
  type KernelStorage,
  type MockProvider,
  type Operation,
  type OperationOutcome,
  type SecretStore,
  type SecurityKernel,
} from '../src/index.js';

const RAW_KEY = 'echopilot-s01-synthetic-key-9b31f7aa';

type Fixture = {
  secretStore: SecretStore;
  storage: KernelStorage;
  captureCalls: CaptureRequest[];
  providerCalls: unknown[];
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
  const providerCalls: unknown[] = [];
  const provider: MockProvider = {
    complete: async (request) => { providerCalls.push(request); return { text: 'mock' }; },
  };
  return { secretStore, storage, captureCalls, providerCalls, start: () => createSecurityKernel({ secrets: secretStore, storage, capture, provider }) };
}

function captureTuple(bundleId = 'com.example.editor', lifetime: GrantTuple['lifetime'] = 'session'): GrantTuple {
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

function outcomeFor(outcomes: ReadonlyArray<OperationOutcome>, requestId: string): OperationOutcome {
  const found = outcomes.find((outcome) => outcome.requestId === requestId);
  assert.ok(found, `no outcome for ${requestId}`);
  return found;
}

function receiptStatuses(kernel: SecurityKernel): string[] {
  return kernel.getAuditReceipts().map((receipt) => String(receipt.status));
}

test('revoking a superseded grant is a no-op and leaves the newer live grant working', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });

  // Same tuple twice: the durable grant supersedes the session grant, so only the durable grant
  // holds live authority.
  const superseded = await kernel.grantCapability(captureTuple('com.example.editor', 'session'));
  const live = await kernel.grantCapability(captureTuple('com.example.editor', 'durable'));
  assert.notEqual(superseded.grantId, live.grantId);

  // Reviewer repro: a request is queued while the durable grant is live, then the superseded grant
  // is revoked before the queue drains.
  await kernel.enqueue(captureOperation('request-superseded-001'));
  const revocation = await kernel.revokeCapability({ grantId: superseded.grantId, reason: 'stale grant cleanup' });
  assert.equal(revocation.grantId, superseded.grantId);
  assert.ok(
    receiptStatuses(kernel).includes('revocation-no-op'),
    'revoking an already-consumed/superseded grant must record an explicit no-op receipt',
  );

  const [completed] = await kernel.runQueued();
  assert.ok(completed);
  assert.equal(completed.status, 'completed', 'the live grant must still authorize the queued request');
  assert.equal(fixture.captureCalls.length, 1);

  // The live grant keeps working after the no-op revocation, across a restart as well.
  await kernel.enqueue(captureOperation('request-superseded-002'));
  assert.equal(outcomeFor(await kernel.runQueued(), 'request-superseded-002').status, 'completed');

  const restarted = fixture.start();
  await restarted.enqueue(captureOperation('request-superseded-003'));
  assert.equal(outcomeFor(await restarted.runQueued(), 'request-superseded-003').status, 'completed');
  assert.equal(fixture.captureCalls.length, 3, 'only the grants revoked by id lose authority');
});

test('revoking a consumed one-shot grant is a no-op; revoking a live grant denies its queued request', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });

  const once = await kernel.grantCapability(captureTuple('com.example.once', 'once'));
  await kernel.enqueue(captureOperation('request-once-001', 'com.example.once'));
  assert.equal(outcomeFor(await kernel.runQueued(), 'request-once-001').status, 'completed');

  const consumedRevocation = await kernel.revokeCapability({ grantId: once.grantId, reason: 'already consumed' });
  assert.equal(consumedRevocation.grantId, once.grantId);
  assert.ok(receiptStatuses(kernel).includes('revocation-no-op'), 'consuming a one-shot grant already ended its authority');

  // A fresh one-shot grant of the same tuple still works after the no-op revocation.
  const regranted = await kernel.grantCapability(captureTuple('com.example.once', 'once'));
  await kernel.enqueue(captureOperation('request-once-002', 'com.example.once'));
  assert.equal(outcomeFor(await kernel.runQueued(), 'request-once-002').status, 'completed');
  assert.equal(fixture.captureCalls.length, 2);

  // Revoking the live grant invalidates that grant only; a sibling tuple stays live.
  const liveAgain = await kernel.grantCapability(captureTuple('com.example.once', 'durable'));
  const sibling = await kernel.grantCapability(captureTuple('com.example.other', 'durable'));
  await kernel.enqueue(captureOperation('request-live-revoke', 'com.example.once'));
  await kernel.revokeCapability({ grantId: liveAgain.grantId, reason: 'S01 focused revocation' });
  const [denied] = await kernel.runQueued();
  assert.ok(denied);
  assert.equal(denied.status, 'denied');
  assert.match(denied.reason ?? '', /revoked/i);
  assert.equal(fixture.captureCalls.length, 2, 'a revoked queued request must not reach the capability');
  assert.notEqual(regranted.grantId, liveAgain.grantId);

  await kernel.enqueue(captureOperation('request-sibling', 'com.example.other'));
  assert.equal(outcomeFor(await kernel.runQueued(), 'request-sibling').status, 'completed');
  assert.equal(fixture.captureCalls.length, 3);
  assert.ok(sibling.grantId.length > 0);
});

test('the key reference is an opaque handle, never a digest of the secret', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();

  const first = await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });
  const second = await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });

  assert.notEqual(first.keyRef, second.keyRef, 'a stable digest would let observers correlate and confirm keys');
  assert.match(first.keyRef, /^keychain:\/\/mock-provider#[0-9a-f-]{36}$/);
  const digest = createHash('sha256').update(RAW_KEY, 'utf8').digest('hex');
  for (const surface of [JSON.stringify(first), JSON.stringify(kernel.getRendererState()), JSON.stringify(kernel.exportSettings())]) {
    assert.equal(surface.includes(RAW_KEY), false, 'the raw key leaked into a kernel surface');
    assert.equal(surface.includes(digest.slice(0, 16)), false, 'a deterministic key digest leaked into a kernel surface');
  }
  assert.equal(await fixture.secretStore.get('mock-provider'), RAW_KEY, 'the key belongs in the Keychain only');
});
