/**
 * S01 acceptance test — initial security tracer bullet (IMPLEMENTATION_PLAN.md §5.9).
 *
 * Path under test: enable one capability/key → authorized operation → revoke → operation denied.
 *
 * `packages/security/src/index.ts` must export (these names are the frozen contract):
 *
 *   KEY_ENTRY_CHANNEL = 'echo:key-entry'
 *     — the dedicated key-entry IPC channel; a key never travels over `echo:command`.
 *
 *   createSecurityKernel({ secrets, storage, capture, provider }) → SecurityKernel
 *     secrets  SecretStore      — Keychain stand-in: put(provider, secret), get(provider), delete(provider)
 *     storage  KernelStorage    — durable kernel state that survives a restart: read(), write(text)
 *     capture  CaptureOperation — fake native capture capability: invoke(request) → { artifactRef }
 *     provider MockProvider     — mock model provider: complete({ requestId, destination, dataCategory, prompt })
 *
 *   kernel.submitProviderKey({ provider, secret }) → { provider, keyRef, maskedSuffix }
 *     — the function behind the key-entry IPC; it returns a redacted reference only.
 *   kernel.grantCapability({ subject, capability, resource, dataCategory, destination, effect, lifetime })
 *     → { grantId, version }                                            — §5.9 permission tuple.
 *   kernel.revokeCapability({ grantId, reason }) → { grantId, grantVersion }
 *     — versioned revocation that must survive a restart.
 *   kernel.enqueue(operation) → Promise<requestId>
 *     — accepts a request without executing it (durable state must be loaded first).
 *   kernel.runQueued() → OperationOutcome[]
 *     — drains the queue, re-checking the current grant version immediately before execution.
 *       OperationOutcome = { requestId, status: 'completed' | 'denied', receiptId?, reason?, proposal? }
 *       proposal = { capability, resource, dataCategory, destination, effect, summary } on denial,
 *       where `summary` names the requested capability and destination.
 *   kernel.getRendererState(), kernel.exportSettings(), kernel.getAuditReceipts()
 *     — surfaces that must never contain a raw key.
 *
 * The preload/main `echo:key-entry` handler is expected to call submitProviderKey and hand the
 * renderer only the redacted reference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Synthetic fixture value. It must never leave the Keychain stand-in. */
const RAW_KEY = 'echopilot-s01-synthetic-key-4f8c2d01';
const KEY_ENTRY_CHANNEL = 'echo:key-entry';

type SecretStore = {
  put(provider: string, secret: string): Promise<void>;
  get(provider: string): Promise<string | null>;
  delete(provider: string): Promise<void>;
};

type KernelStorage = {
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
};

type ResourceSelector = Record<string, string>;

type Operation = {
  requestId: string;
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
  effect: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string;
};

type GrantTuple = {
  subject: string;
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
  effect: string;
  lifetime: 'once' | 'session' | 'project' | 'durable';
};

type OperationOutcome = {
  requestId: string;
  status: 'completed' | 'denied';
  receiptId?: string;
  reason?: string;
  proposal?: {
    capability: string;
    resource: ResourceSelector;
    dataCategory: string;
    destination: string;
    effect: string;
    summary: string;
  };
};

type CaptureRequest = {
  requestId: string;
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
};

type CaptureOperation = {
  invoke(request: CaptureRequest): Promise<{ artifactRef: string }>;
};

type ProviderRequest = {
  requestId: string;
  destination: string;
  dataCategory: string;
  prompt: string;
};

type MockProvider = {
  complete(request: ProviderRequest): Promise<{ text: string }>;
};

type SecurityKernel = {
  submitProviderKey(input: { provider: string; secret: string }): Promise<{ provider: string; keyRef: string; maskedSuffix: string }>;
  grantCapability(grant: GrantTuple): Promise<{ grantId: string; version: number }>;
  revokeCapability(input: { grantId: string; reason: string }): Promise<{ grantId: string; grantVersion: number }>;
  enqueue(operation: Operation): Promise<string>;
  runQueued(): Promise<OperationOutcome[]>;
  getRendererState(): unknown;
  exportSettings(): unknown;
  getAuditReceipts(): ReadonlyArray<Record<string, unknown>>;
};

type SecurityModule = {
  KEY_ENTRY_CHANNEL: string;
  createSecurityKernel(options: {
    secrets: SecretStore;
    storage: KernelStorage;
    capture: CaptureOperation;
    provider: MockProvider;
  }): SecurityKernel;
};

async function loadSecurityModule(): Promise<SecurityModule> {
  const fail = (detail: string): never => assert.fail(`S01 acceptance test needs packages/security: ${detail}`);
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('../src/index.js')) as unknown as Record<string, unknown>;
  } catch (error) {
    return fail(`import '../src/index.js' failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createSecurityKernel !== 'function') {
    return fail('createSecurityKernel({ secrets, storage, capture, provider }) is not exported');
  }
  if (typeof loaded.KEY_ENTRY_CHANNEL !== 'string') return fail('KEY_ENTRY_CHANNEL is not exported');
  return loaded as unknown as SecurityModule;
}

const security = await loadSecurityModule();

function createFixture() {
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
    invoke: async (request) => { captureCalls.push(request); return { artifactRef: `fixture://capture/${request.requestId}` }; },
  };
  const providerCalls: ProviderRequest[] = [];
  const provider: MockProvider = {
    complete: async (request) => { providerCalls.push(request); return { text: 'mock completion' }; },
  };
  return {
    secrets,
    secretStore,
    storage,
    capture,
    provider,
    captureCalls,
    providerCalls,
    start: (): SecurityKernel => security.createSecurityKernel({ secrets: secretStore, storage, capture, provider }),
  };
}

function captureRequest(requestId: string, bundleId = 'com.example.editor'): Operation {
  return {
    requestId,
    capability: 'screen_capture',
    resource: { kind: 'app', bundleId },
    dataCategory: 'screenshot',
    destination: 'local',
    effect: 'read',
    arguments: { reason: 'S01 synthetic acceptance fixture' },
    idempotencyKey: 'idempotency-s01-capture',
  };
}

function egressRequest(requestId: string, dataCategory: string): Operation {
  return {
    requestId,
    capability: 'provider_egress',
    resource: { kind: 'provider', providerId: 'mock-provider' },
    dataCategory,
    destination: 'provider',
    effect: 'send',
    arguments: { prompt: 'Synthetic S01 acceptance prompt.' },
    idempotencyKey: `idempotency-s01-egress-${dataCategory}`,
  };
}

function captureGrant(bundleId = 'com.example.editor', lifetime: GrantTuple['lifetime'] = 'session'): GrantTuple {
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

function egressGrant(dataCategory: string): GrantTuple {
  return {
    subject: 'user',
    capability: 'provider_egress',
    resource: { kind: 'provider', providerId: 'mock-provider' },
    dataCategory,
    destination: 'provider',
    effect: 'send',
    lifetime: 'project',
  };
}

function outcomeFor(outcomes: ReadonlyArray<OperationOutcome>, requestId: string): OperationOutcome {
  const found = outcomes.find((outcome) => outcome.requestId === requestId);
  assert.ok(found, `no outcome was produced for queued request ${requestId}`);
  return found;
}

function captureConsole(sink: unknown[][]): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  const patched = console as unknown as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  for (const method of methods) patched[method] = (...args: unknown[]): void => { sink.push(args); };
  return () => { for (const [method, original] of originals) patched[method] = original; };
}

test('a granted operation succeeds, and the same queued request is denied after revocation and after restart', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();

  const key = await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });
  assert.equal(key.maskedSuffix, RAW_KEY.slice(-4));
  const grant = await kernel.grantCapability(captureGrant());
  assert.ok(grant.grantId.length > 0, 'a grant must be identifiable');
  // A second, durable grant stays live across the restart to prove persisted state is real.
  await kernel.grantCapability(captureGrant('com.example.notes', 'durable'));

  const queued = captureRequest('request-granted-001');
  assert.equal(await kernel.enqueue(queued), queued.requestId);
  const [completed] = await kernel.runQueued();
  assert.ok(completed, 'the queued request must produce one outcome');
  assert.equal(completed.status, 'completed');
  assert.ok(completed.receiptId, 'a completed authorized operation must carry an audit receipt id');
  assert.equal(fixture.captureCalls.length, 1, 'the granted capture operation must run once');
  assert.ok(
    JSON.stringify(await kernel.getAuditReceipts()).includes(completed.receiptId),
    'the audit receipts must record the completed operation',
  );

  // The next request is queued while the grant is live; revocation lands before it executes.
  assert.equal(await kernel.enqueue(captureRequest('request-revoked-002')), 'request-revoked-002');
  await kernel.revokeCapability({ grantId: grant.grantId, reason: 'S01 acceptance revocation' });
  const [denied] = await kernel.runQueued();
  assert.ok(denied, 'the revoked request must still produce an outcome');
  assert.equal(denied.status, 'denied');
  assert.ok((denied.reason ?? '').length > 0, 'a revoked operation must explain the denial');
  assert.equal(fixture.captureCalls.length, 1, 'a revoked queued request must not run the capture capability');

  // Restart: a fresh kernel over the same durable storage and Keychain keeps the live durable
  // grant and the revocation alike.
  const restarted = fixture.start();
  assert.equal(await restarted.enqueue(captureRequest('request-restart-003', 'com.example.notes')), 'request-restart-003');
  const [stillGranted] = await restarted.runQueued();
  assert.ok(stillGranted, 'the restarted kernel must still produce an outcome');
  assert.equal(stillGranted.status, 'completed', 'a live durable grant must survive a restart');
  assert.equal(fixture.captureCalls.length, 2);

  assert.equal(await restarted.enqueue(captureRequest('request-restart-004')), 'request-restart-004');
  const [afterRestart] = await restarted.runQueued();
  assert.ok(afterRestart, 'the revoked request must still produce an outcome after restart');
  assert.equal(afterRestart.status, 'denied');
  assert.ok((afterRestart.reason ?? '').length > 0, 'the restarted denial must explain itself');
  assert.equal(fixture.captureCalls.length, 2, 'revocation must not be undone by a restart');
});

test('a submitted key stays in the Keychain stand-in and never reaches renderer state, logs, argv, settings, or mock prompts', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  assert.equal(security.KEY_ENTRY_CHANNEL, KEY_ENTRY_CHANNEL, 'keys must use the dedicated key-entry channel');

  const logs: unknown[][] = [];
  const restoreConsole = captureConsole(logs);
  try {
    const key = await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });
    assert.equal(await fixture.secretStore.get('mock-provider'), RAW_KEY, 'the raw key belongs in the Keychain');
    assert.equal(key.maskedSuffix, RAW_KEY.slice(-4), 'the key result may show a masked suffix only');
    assert.equal(JSON.stringify(key).includes(RAW_KEY), false, 'the key-entry result must be redacted');
    assert.equal(fixture.providerCalls.length, 0, 'entering a key must not create a cloud request');

    await kernel.grantCapability(captureGrant());
    assert.equal(await kernel.enqueue(captureRequest('request-leak-001')), 'request-leak-001');
    const [outcome] = await kernel.runQueued();
    assert.ok(outcome, 'the local capture must produce one outcome');
    assert.equal(outcome.status, 'completed');
    assert.equal(fixture.providerCalls.length, 0, 'a local-only capture must not reach the provider');
  } finally {
    restoreConsole();
  }

  const rendererState = JSON.stringify(kernel.getRendererState());
  assert.ok(rendererState.includes('mock-provider'), 'renderer state must show the configured provider');
  assert.ok(rendererState.includes(RAW_KEY.slice(-4)), 'renderer state must show the masked suffix only');

  const surfaces: Record<string, string> = {
    'renderer state': rendererState,
    logs: JSON.stringify(logs),
    argv: process.argv.join(' '),
    'exported settings': JSON.stringify(kernel.exportSettings()),
    'audit receipts': JSON.stringify(await kernel.getAuditReceipts()),
    'capture requests': JSON.stringify(fixture.captureCalls),
    'mock model prompts': JSON.stringify(fixture.providerCalls),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.equal(text.includes(RAW_KEY), false, `the raw key leaked into ${name}`);
  }
});

test('unknown capability, resource, and destination combinations are denied with a clear permission proposal', async () => {
  const fixture = createFixture();
  const kernel = fixture.start();
  await kernel.submitProviderKey({ provider: 'mock-provider', secret: RAW_KEY });
  await kernel.grantCapability(captureGrant());

  const unknownCapability = { ...captureRequest('request-unknown-capability'), capability: 'teleport_window' };
  const unknownResource = { ...captureRequest('request-unknown-resource'), resource: { kind: 'app', bundleId: 'com.example.other' } };
  const ungrantedEgress = egressRequest('request-ungranted-egress', 'screenshot');
  const requests = [unknownCapability, unknownResource, ungrantedEgress];
  for (const request of requests) await kernel.enqueue(request);

  const outcomes = await kernel.runQueued();
  for (const request of requests) {
    const outcome = outcomeFor(outcomes, request.requestId);
    assert.equal(outcome.status, 'denied');
    const proposal = outcome.proposal;
    assert.ok(proposal, `${request.capability} must come back with a permission proposal`);
    assert.equal(proposal.capability, request.capability);
    assert.equal(proposal.destination, request.destination);
    assert.equal(proposal.dataCategory, request.dataCategory);
    assert.match(proposal.summary, new RegExp(request.capability), 'the proposal must name the requested capability');
    assert.match(proposal.summary, new RegExp(request.destination), 'the proposal must name the requested destination');
  }
  assert.equal(fixture.captureCalls.length, 0, 'an unknown combination must not run the capture capability');
  assert.equal(fixture.providerCalls.length, 0, 'an ungranted destination must not reach the provider');

  // Provider egress is granted per provider and per data category: text is allowed, image is not.
  await kernel.grantCapability(egressGrant('text'));
  await kernel.enqueue(egressRequest('request-egress-text', 'text'));
  await kernel.enqueue(egressRequest('request-egress-image', 'image'));
  const egressOutcomes = await kernel.runQueued();
  assert.equal(outcomeFor(egressOutcomes, 'request-egress-text').status, 'completed');
  assert.equal(fixture.providerCalls.length, 1, 'exactly one granted provider egress may reach the provider');
  assert.equal(fixture.providerCalls[0]?.dataCategory, 'text');
  const deniedCategory = outcomeFor(egressOutcomes, 'request-egress-image');
  assert.equal(deniedCategory.status, 'denied');
  assert.equal(deniedCategory.proposal?.dataCategory, 'image');
  assert.equal(fixture.providerCalls.length, 1, 'an ungranted data category must not reach the provider');
  assert.equal(JSON.stringify(fixture.providerCalls).includes(RAW_KEY), false, 'the raw key leaked into a mock model prompt');
});
