/** Shared public types for the S01 security tracer bullet (IMPLEMENTATION_PLAN.md §5.9). */

export type ResourceSelector = Record<string, string>;

export type GrantLifetime = 'once' | 'session' | 'project' | 'durable';

export type SecretStore = {
  put(provider: string, secret: string): Promise<void>;
  get(provider: string): Promise<string | null>;
  delete(provider: string): Promise<void>;
};

export type KernelStorage = {
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
};

export type CaptureRequest = {
  requestId: string;
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
};

export type CaptureOperation = {
  invoke(request: CaptureRequest): Promise<{ artifactRef: string }>;
};

export type ProviderRequest = {
  requestId: string;
  destination: string;
  dataCategory: string;
  prompt: string;
};

export type MockProvider = {
  complete(request: ProviderRequest): Promise<{ text: string }>;
};

export type Operation = {
  requestId: string;
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
  effect: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string;
};

export type GrantTuple = {
  subject: string;
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
  effect: string;
  lifetime: GrantLifetime;
};

export type PermissionProposal = {
  capability: string;
  resource: ResourceSelector;
  dataCategory: string;
  destination: string;
  effect: string;
  summary: string;
};

export type OperationOutcome = {
  requestId: string;
  status: 'completed' | 'denied';
  receiptId?: string;
  reason?: string;
  proposal?: PermissionProposal;
};

export type SecurityKernel = {
  submitProviderKey(input: { provider: string; secret: string }): Promise<{ provider: string; keyRef: string; maskedSuffix: string }>;
  grantCapability(grant: GrantTuple): Promise<{ grantId: string; version: number }>;
  revokeCapability(input: { grantId: string; reason: string }): Promise<{ grantId: string; grantVersion: number }>;
  enqueue(operation: Operation): Promise<string>;
  runQueued(): Promise<OperationOutcome[]>;
  getRendererState(): unknown;
  exportSettings(): unknown;
  getAuditReceipts(): ReadonlyArray<Record<string, unknown>>;
  getEgressCategories(): Record<string, string[]>;
};
