/**
 * S01 security tracer bullet (IMPLEMENTATION_PLAN.md §5.9).
 *
 * Path: enable one capability/key → authorized operation → revoke → operation denied, including
 * after a restart. The kernel is provider-agnostic: it authorizes grant tuples, writes audit
 * receipts and only then hands work to a capture capability or a provider client.
 *
 * Invariants exercised by packages/security/test/acceptance.test.ts:
 *  - a raw key only ever lands in the SecretStore (Keychain): never in kernel state, renderer
 *    state, exported settings, audit receipts, logs, argv, or model prompts;
 *  - provider egress is granted per provider *and* per data category;
 *  - revocations are versioned and survive a restart;
 *  - the grant version is re-read immediately before execution, so a revocation that lands while
 *    a request is queued still denies it.
 */
import { createHash, randomUUID } from 'node:crypto';

import { KEY_ENTRY_CHANNEL, maskSecretSuffix } from './channels';
import type {
  CaptureOperation,
  CaptureRequest,
  GrantLifetime,
  GrantTuple,
  KernelStorage,
  MockProvider,
  Operation,
  OperationOutcome,
  PermissionProposal,
  ResourceSelector,
  SecretStore,
  SecurityKernel,
} from './types';

export { KEY_ENTRY_CHANNEL, maskSecretSuffix, parseKeyEntryRequest, parseKeyEntryResult } from './channels';
export type { KeyEntryRequest, KeyEntryResult } from './channels';
export { createKeychainSecretStore } from './keychain';
export type { KeychainOptions } from './keychain';
export { createNativeCaptureOperation, createNativeHelperBridge } from './native-helper';
export type { NativeHelperBridge, NativeHelperCapability, NativeHelperOptions } from './native-helper';
export { createFileKernelStorage } from './storage';
export type {
  CaptureOperation,
  CaptureRequest,
  GrantLifetime,
  GrantTuple,
  KernelStorage,
  MockProvider,
  Operation,
  OperationOutcome,
  PermissionProposal,
  ProviderRequest,
  ResourceSelector,
  SecretStore,
  SecurityKernel,
} from './types';

const DEFAULT_SUBJECT = 'user';
const DEFAULT_SCOPE = 'local-only';
const PROJECT_PARTNER_SCOPES = ['project'];
const PROVIDER_EGRESS_CAPABILITY = 'provider_egress';
const LOCAL_DESTINATION = 'local';
const PROVIDER_DESTINATION = 'provider';

type GrantStatus = 'active' | 'revoked' | 'consumed';

type GrantRecord = GrantTuple & {
  grantId: string;
  version: number;
  status: GrantStatus;
  createdAt: string;
  revokedAt?: string;
  revokeReason?: string;
};

type ProviderRecord = {
  provider: string;
  keyRef: string;
  maskedSuffix: string;
  submittedAt: string;
};

type KernelState = {
  schema: 1;
  providers: Record<string, ProviderRecord>;
  grants: GrantRecord[];
  versionCounters: Record<string, number>;
  receipts: Array<Record<string, unknown>>;
  queue: Operation[];
};

type KernelDependencies = {
  secrets: SecretStore;
  storage: KernelStorage;
  capture: CaptureOperation;
  provider: MockProvider;
};

export type CreateSecurityKernelOptions = KernelDependencies;

export function createSecurityKernel(options: CreateSecurityKernelOptions): SecurityKernel {
  if (!isRecord(options)) throw new Error('createSecurityKernel requires { secrets, storage, capture, provider }');
  requireDependency(options.secrets, 'secrets');
  requireDependency(options.storage, 'storage');
  requireDependency(options.capture, 'capture');
  requireDependency(options.provider, 'provider');
  return new Kernel(options);
}

/**
 * Provider client used when no Project Partner endpoint is configured. Local-only is the default,
 * so a queued egress request fails closed instead of silently reaching a cloud service.
 */
export function createDisabledProvider(
  reason = 'cloud egress is not configured; EchoPilot stays local-only until a Project Partner endpoint is set',
): MockProvider {
  return {
    async complete(): Promise<{ text: string }> {
      throw new Error(reason);
    },
  };
}

class Kernel implements SecurityKernel {
  private state: KernelState = emptyState();
  private loaded: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: KernelDependencies) {}

  async submitProviderKey(input: { provider: string; secret: string }): Promise<{ provider: string; keyRef: string; maskedSuffix: string }> {
    await this.ensureLoaded();
    const provider = requireText(input?.provider, 'provider');
    const secret = requireText(input?.secret, 'secret');

    // The raw key lands in the Keychain stand-in and nowhere else. No provider call happens here:
    // entering a key must never create cloud egress.
    await this.dependencies.secrets.put(provider, secret);

    const keyRef = `keychain://${provider}#${fingerprint(secret)}`;
    const maskedSuffix = maskSecretSuffix(secret);
    this.state.providers[provider] = { provider, keyRef, maskedSuffix, submittedAt: nowIso() };
    this.state.receipts.push({
      receiptId: newId('receipt'),
      requestId: `key-entry:${provider}`,
      status: 'key-stored',
      provider,
      keyRef,
      maskedSuffix,
      scope: DEFAULT_SCOPE,
      recordedAt: nowIso(),
    });
    await this.persist();
    return Object.freeze({ provider, keyRef, maskedSuffix });
  }

  async grantCapability(grant: GrantTuple): Promise<{ grantId: string; version: number }> {
    await this.ensureLoaded();
    const tuple = normalizeGrantTuple(grant);
    const key = tupleKey(tuple);
    const version = (this.state.versionCounters[key] ?? 0) + 1;
    this.state.versionCounters[key] = version;

    // A new grant supersedes any older live grant for the same tuple.
    for (const existing of this.state.grants) {
      if (existing.status === 'active' && tupleKey(existing) === key) existing.status = 'consumed';
    }

    const record: GrantRecord = {
      ...tuple,
      grantId: newId('grant'),
      version,
      status: 'active',
      createdAt: nowIso(),
    };
    this.state.grants.push(record);
    this.state.receipts.push({
      receiptId: newId('receipt'),
      requestId: `grant:${record.grantId}`,
      status: 'granted',
      grantId: record.grantId,
      grantVersion: version,
      capability: tuple.capability,
      resource: { ...tuple.resource },
      dataCategory: tuple.dataCategory,
      destination: tuple.destination,
      effect: tuple.effect,
      lifetime: tuple.lifetime,
      recordedAt: nowIso(),
    });
    await this.persist();
    return { grantId: record.grantId, version };
  }

  async revokeCapability(input: { grantId: string; reason: string }): Promise<{ grantId: string; grantVersion: number }> {
    await this.ensureLoaded();
    const grantId = requireText(input?.grantId, 'grantId');
    const reason = typeof input?.reason === 'string' && input.reason.length > 0 ? input.reason : 'revoked';
    const grant = this.state.grants.find((candidate) => candidate.grantId === grantId);
    if (!grant) throw new Error(`Unknown grant '${grantId}'`);

    // Revocation bumps the tuple's version counter, so every token/decision minted at the old
    // version is invalid from here on — and that counter is part of the durable state.
    const grantVersion = this.bumpVersion(grant);
    if (grant.status === 'active') {
      grant.status = 'revoked';
      grant.revokedAt = nowIso();
      grant.revokeReason = reason;
    }
    this.state.receipts.push({
      receiptId: newId('receipt'),
      requestId: `revoke:${grantId}`,
      status: 'revoked',
      grantId,
      grantVersion,
      capability: grant.capability,
      resource: { ...grant.resource },
      dataCategory: grant.dataCategory,
      destination: grant.destination,
      effect: grant.effect,
      reason,
      recordedAt: nowIso(),
    });
    await this.persist();
    return { grantId, grantVersion };
  }

  async enqueue(operation: Operation): Promise<string> {
    await this.ensureLoaded();
    const queued = normalizeOperation(operation);
    if (!this.state.queue.some((candidate) => candidate.requestId === queued.requestId)) {
      this.state.queue.push(queued);
      await this.persist();
    }
    return queued.requestId;
  }

  async runQueued(): Promise<OperationOutcome[]> {
    await this.ensureLoaded();
    const queued = this.state.queue;
    this.state.queue = [];
    const outcomes: OperationOutcome[] = [];
    for (const operation of queued) outcomes.push(await this.execute(operation));
    await this.persist();
    return outcomes;
  }

  getRendererState(): unknown {
    return {
      keyEntryChannel: KEY_ENTRY_CHANNEL,
      scope: { default: DEFAULT_SCOPE, localOnly: true, projectPartner: PROJECT_PARTNER_SCOPES, cloudEgress: 'grant-required' },
      providers: this.providerViews(),
      egressCategories: this.getEgressCategories(),
      activeGrants: this.state.grants.filter((grant) => grant.status === 'active').length,
      pendingRequests: this.state.queue.length,
    };
  }

  exportSettings(): unknown {
    return {
      keyEntryChannel: KEY_ENTRY_CHANNEL,
      scope: { default: DEFAULT_SCOPE, localOnly: true, projectPartner: PROJECT_PARTNER_SCOPES, cloudEgress: 'grant-required' },
      providers: this.providerViews(),
      egressCategories: this.getEgressCategories(),
      revocation: { versioned: true, survivesRestart: true },
      audit: { receipts: this.state.receipts.length },
    };
  }

  getAuditReceipts(): ReadonlyArray<Record<string, unknown>> {
    return this.state.receipts;
  }

  getEgressCategories(): Record<string, string[]> {
    const categories: Record<string, string[]> = {};
    for (const grant of this.state.grants) {
      if (grant.status !== 'active' || grant.capability !== PROVIDER_EGRESS_CAPABILITY) continue;
      const providerId = grant.resource.providerId ?? grant.resource.kind ?? 'unknown';
      const allowed = categories[providerId] ?? (categories[providerId] = []);
      if (!allowed.includes(grant.dataCategory)) allowed.push(grant.dataCategory);
    }
    return categories;
  }

  private providerViews(): Array<{ provider: string; keyRef: string; maskedSuffix: string }> {
    return Object.values(this.state.providers).map((record) => ({
      provider: record.provider,
      keyRef: record.keyRef,
      maskedSuffix: record.maskedSuffix,
    }));
  }

  private async execute(operation: Operation): Promise<OperationOutcome> {
    const live = this.selectLiveGrant(operation);
    if (!live) return this.deny(operation, this.denialReason(operation));

    // Re-read the version at the last instant before side effects: a revocation (or a re-grant
    // that superseded this version) must stop a request that was queued while the grant was live.
    const currentVersion = this.state.versionCounters[tupleKey(live)] ?? live.version;
    if (live.status !== 'active' || live.version !== currentVersion) {
      return this.deny(
        operation,
        `Grant ${live.grantId} version ${live.version} is no longer current (version ${currentVersion}); the request was denied.`,
      );
    }

    try {
      const artifacts = await this.invokeCapability(operation);
      const receiptId = newId('receipt');
      this.state.receipts.push({
        receiptId,
        requestId: operation.requestId,
        status: 'completed',
        grantId: live.grantId,
        grantVersion: live.version,
        subject: live.subject,
        capability: operation.capability,
        resource: { ...operation.resource },
        dataCategory: operation.dataCategory,
        destination: operation.destination,
        effect: operation.effect,
        idempotencyKey: operation.idempotencyKey,
        ...artifacts,
        recordedAt: nowIso(),
      });
      if (live.lifetime === 'once') {
        live.status = 'consumed';
        this.bumpVersion(live);
      }
      await this.persist();
      return { requestId: operation.requestId, status: 'completed', receiptId };
    } catch (error) {
      const reason = `Capability '${operation.capability}' to '${operation.destination}' failed: ${errorMessage(error)}`;
      const receiptId = newId('receipt');
      this.state.receipts.push({
        receiptId,
        requestId: operation.requestId,
        status: 'failed',
        capability: operation.capability,
        resource: { ...operation.resource },
        dataCategory: operation.dataCategory,
        destination: operation.destination,
        effect: operation.effect,
        reason,
        recordedAt: nowIso(),
      });
      await this.persist();
      return { requestId: operation.requestId, status: 'denied', reason, receiptId };
    }
  }

  private async invokeCapability(operation: Operation): Promise<Record<string, unknown>> {
    if (operation.destination === LOCAL_DESTINATION) {
      const request: CaptureRequest = {
        requestId: operation.requestId,
        capability: operation.capability,
        resource: { ...operation.resource },
        dataCategory: operation.dataCategory,
        destination: operation.destination,
      };
      const artifact = await this.dependencies.capture.invoke(request);
      return { artifactRef: artifact.artifactRef };
    }
    if (operation.destination === PROVIDER_DESTINATION) {
      const prompt = typeof operation.arguments.prompt === 'string' ? operation.arguments.prompt : '';
      // The raw key never reaches this call: the provider client resolves the Keychain credential
      // at its own transport boundary, and the prompt is exactly what the caller queued.
      const completion = await this.dependencies.provider.complete({
        requestId: operation.requestId,
        destination: operation.destination,
        dataCategory: operation.dataCategory,
        prompt,
      });
      return { completionLength: completion.text.length };
    }
    throw new Error(`no capability handler is registered for destination '${operation.destination}'`);
  }

  private selectLiveGrant(operation: Operation): GrantRecord | null {
    const candidates = this.state.grants.filter(
      (grant) =>
        grant.status === 'active' &&
        grant.subject === DEFAULT_SUBJECT &&
        grant.capability === operation.capability &&
        grant.dataCategory === operation.dataCategory &&
        grant.destination === operation.destination &&
        grant.effect === operation.effect &&
        resourceMatches(grant.resource, operation.resource) &&
        grant.version === (this.state.versionCounters[tupleKey(grant)] ?? grant.version),
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((best, candidate) => (candidate.version > best.version ? candidate : best));
  }

  private denialReason(operation: Operation): string {
    const related = this.state.grants.filter(
      (grant) => grant.capability === operation.capability && grant.destination === operation.destination,
    );
    const revoked = related
      .filter((grant) => grant.status === 'revoked')
      .sort((left, right) => right.version - left.version)[0];
    if (revoked) {
      return `Grant ${revoked.grantId} for capability '${operation.capability}' to '${operation.destination}' was revoked: ${revoked.revokeReason ?? 'no reason recorded'}.`;
    }
    if (!this.state.grants.some((grant) => grant.capability === operation.capability)) {
      return `Capability '${operation.capability}' is not recognized, so destination '${operation.destination}' is denied.`;
    }
    if (!this.state.grants.some((grant) => grant.destination === operation.destination)) {
      return `Destination '${operation.destination}' is not permitted for capability '${operation.capability}'.`;
    }
    return `No grant permits capability '${operation.capability}' to reach destination '${operation.destination}' with data category '${operation.dataCategory}'.`;
  }

  private async deny(operation: Operation, reason: string): Promise<OperationOutcome> {
    const proposal: PermissionProposal = {
      capability: operation.capability,
      resource: { ...operation.resource },
      dataCategory: operation.dataCategory,
      destination: operation.destination,
      effect: operation.effect,
      summary: `Allow capability '${operation.capability}' to reach destination '${operation.destination}' with data category '${operation.dataCategory}'?`,
    };
    const receiptId = newId('receipt');
    this.state.receipts.push({
      receiptId,
      requestId: operation.requestId,
      status: 'denied',
      capability: operation.capability,
      resource: { ...operation.resource },
      dataCategory: operation.dataCategory,
      destination: operation.destination,
      effect: operation.effect,
      reason,
      proposal,
      recordedAt: nowIso(),
    });
    await this.persist();
    return { requestId: operation.requestId, status: 'denied', reason, receiptId, proposal };
  }

  private bumpVersion(grant: GrantRecord): number {
    const key = tupleKey(grant);
    const next = Math.max(this.state.versionCounters[key] ?? grant.version, grant.version) + 1;
    this.state.versionCounters[key] = next;
    return next;
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.dependencies.storage.read();
    } catch (error) {
      throw new Error(`security kernel state could not be read: ${errorMessage(error)}`);
    }
    if (raw === null || raw.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Corrupt state fails closed: nothing is granted.
    }
    const restored = normalizeState(parsed);
    // Session and one-shot grants belong to the process that minted them; durable grants and the
    // revocation tombstones (with their version counters) are what survive a restart.
    restored.grants = restored.grants.filter(
      (grant) => grant.status !== 'active' || grant.lifetime === 'durable' || grant.lifetime === 'project',
    );
    this.state = restored;
  }

  private persist(): Promise<void> {
    const serialized = JSON.stringify(this.state);
    const write = this.writes.then(() => this.dependencies.storage.write(serialized));
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}

function emptyState(): KernelState {
  return { schema: 1, providers: {}, grants: [], versionCounters: {}, receipts: [], queue: [] };
}

function tupleKey(tuple: GrantTuple): string {
  const resource = sortedResource(tuple.resource);
  return JSON.stringify([tuple.subject, tuple.capability, resource, tuple.dataCategory, tuple.destination, tuple.effect]);
}

function sortedResource(resource: ResourceSelector): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(resource).sort()) {
    const value = resource[name];
    if (value !== undefined) sorted[name] = value;
  }
  return sorted;
}

function resourceMatches(selector: ResourceSelector, resource: ResourceSelector): boolean {
  return Object.entries(selector).every(([name, value]) => resource[name] === value);
}

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireDependency(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null) throw new Error(`createSecurityKernel requires a '${name}' implementation`);
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`'${name}' must be a non-empty string`);
  return value;
}

function normalizeOperation(value: Operation): Operation {
  if (!isRecord(value)) throw new Error('operation must be an object');
  const resource = isRecord(value.resource) ? normalizeResource(value.resource) : null;
  if (resource === null) throw new Error("operation 'resource' must be a string map");
  return {
    requestId: requireText(value.requestId, 'requestId'),
    capability: requireText(value.capability, 'capability'),
    resource,
    dataCategory: requireText(value.dataCategory, 'dataCategory'),
    destination: requireText(value.destination, 'destination'),
    effect: requireText(value.effect, 'effect'),
    arguments: isRecord(value.arguments) ? { ...value.arguments } : {},
    idempotencyKey: requireText(value.idempotencyKey, 'idempotencyKey'),
  };
}

function normalizeResource(value: Record<string, unknown>): ResourceSelector {
  const resource: ResourceSelector = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') resource[name] = entry;
  }
  return resource;
}

function normalizeGrantTuple(value: GrantTuple): GrantTuple {
  if (!isRecord(value)) throw new Error('grant must be an object');
  const lifetime = value.lifetime;
  if (lifetime !== 'once' && lifetime !== 'session' && lifetime !== 'project' && lifetime !== 'durable') {
    throw new Error("grant 'lifetime' must be one of once, session, project, durable");
  }
  const resource = isRecord(value.resource) ? normalizeResource(value.resource) : null;
  if (resource === null) throw new Error("grant 'resource' must be a string map");
  return {
    subject: requireText(value.subject, 'subject'),
    capability: requireText(value.capability, 'capability'),
    resource,
    dataCategory: requireText(value.dataCategory, 'dataCategory'),
    destination: requireText(value.destination, 'destination'),
    effect: requireText(value.effect, 'effect'),
    lifetime: lifetime as GrantLifetime,
  };
}

function normalizeState(value: unknown): KernelState {
  const state = emptyState();
  if (!isRecord(value)) return state;

  if (isRecord(value.providers)) {
    for (const [id, record] of Object.entries(value.providers)) {
      if (!isRecord(record)) continue;
      const provider = typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : id;
      state.providers[provider] = {
        provider,
        keyRef: typeof record.keyRef === 'string' ? record.keyRef : `keychain://${provider}`,
        maskedSuffix: typeof record.maskedSuffix === 'string' ? record.maskedSuffix : '',
        submittedAt: typeof record.submittedAt === 'string' ? record.submittedAt : nowIso(),
      };
    }
  }

  if (isRecord(value.versionCounters)) {
    for (const [key, count] of Object.entries(value.versionCounters)) {
      if (typeof count === 'number' && Number.isFinite(count)) state.versionCounters[key] = count;
    }
  }

  if (Array.isArray(value.grants)) {
    for (const record of value.grants) {
      const grant = normalizeGrantRecord(record);
      if (grant) state.grants.push(grant);
    }
  }

  if (Array.isArray(value.receipts)) {
    for (const record of value.receipts) if (isRecord(record)) state.receipts.push(record);
  }

  if (Array.isArray(value.queue)) {
    for (const record of value.queue) {
      try {
        state.queue.push(normalizeOperation(record as Operation));
      } catch {
        // A malformed queued request is dropped rather than executed.
      }
    }
  }

  return state;
}

function normalizeGrantRecord(value: unknown): GrantRecord | null {
  if (!isRecord(value)) return null;
  try {
    const tuple = normalizeGrantTuple(value as unknown as GrantTuple);
    const version = typeof value.version === 'number' && Number.isFinite(value.version) ? value.version : 1;
    const status = value.status === 'revoked' || value.status === 'consumed' ? value.status : 'active';
    const record: GrantRecord = {
      ...tuple,
      grantId: requireText(value.grantId, 'grantId'),
      version,
      status,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso(),
    };
    if (typeof value.revokedAt === 'string') record.revokedAt = value.revokedAt;
    if (typeof value.revokeReason === 'string') record.revokeReason = value.revokeReason;
    return record;
  } catch {
    return null;
  }
}
