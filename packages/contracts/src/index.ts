/** The narrow, version-one renderer boundary. No arbitrary channel or tool execution. */
export type Command =
  | { type: 'get-state' }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'replay' }
  | { type: 'open-dashboard' };

export type FixtureEvent = {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
};

export type State = { muted: boolean; event: FixtureEvent | null };

export const IPC_CHANNEL = 'echo:command';
export const STATE_CHANNEL = 'echo:state';
/** Every cross-process/domain record in the bootstrap uses this frozen contract revision. */
export const CONTRACT_VERSION = 1 as const;

export interface CompanionAPI {
  command(command: Command): Promise<State>;
  onState(listener: (state: State) => void): () => void;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Unexpected property');
  }
}

function string(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

export function parseCommand(value: unknown): Command {
  const input = object(value);
  switch (input.type) {
    case 'get-state':
    case 'replay':
    case 'open-dashboard':
      keys(input, ['type']);
      return { type: input.type };
    case 'set-muted':
      keys(input, ['type', 'muted']);
      if (typeof input.muted !== 'boolean') throw new TypeError('Invalid muted flag');
      return { type: input.type, muted: input.muted };
    default:
      throw new TypeError('Unsupported command');
  }
}

export function parseFixtureEvent(value: unknown): FixtureEvent {
  const input = object(value);
  keys(input, ['id', 'sessionId', 'text', 'createdAt']);
  const createdAt = string(input.createdAt, 'createdAt', 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) {
    throw new TypeError('Expected a valid UTC ISO timestamp');
  }
  return {
    id: string(input.id, 'id', 128),
    sessionId: string(input.sessionId, 'sessionId', 128),
    text: string(input.text, 'text', 8_192),
    createdAt,
  };
}

export function parseState(value: unknown): State {
  const input = object(value);
  keys(input, ['muted', 'event']);
  if (typeof input.muted !== 'boolean') throw new TypeError('Invalid muted flag');
  return { muted: input.muted, event: input.event === null ? null : parseFixtureEvent(input.event) };
}

export type Sensitivity = 'normal' | 'private' | 'secret';
export type Scope = Readonly<{
  profileId: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  sensitivity: Sensitivity;
}>;

export type KnownEventKind =
  | 'user_utterance' | 'agent_message' | 'tool_started' | 'tool_completed'
  | 'approval_requested' | 'decision' | 'artifact_changed' | 'session_state'
  | 'capture' | 'delivery_receipt' | 'gap' | 'permission_changed';
export type EventKind = KnownEventKind | 'unsupported';
export type EventEnvelope = Readonly<{
  schemaVersion: 1;
  eventId: string;
  sourceId: string;
  sourceEventId: string;
  sourceSequence: number;
  ingestSequence: number;
  occurredAt: string;
  observedAt: string;
  monotonicNs?: string;
  scope: Scope;
  turnId?: string;
  parentEventId?: string;
  kind: EventKind;
  /** Preserved only as data when a newer producer sends an unknown discriminant. */
  unsupportedKind?: string;
  payloadRef: string;
  contentHash: string;
  trust: 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
}>;

export type SpeechPlan = Readonly<{
  planId: string;
  sessionId?: string;
  epoch: number;
  priority: 'critical' | 'blocking' | 'completion' | 'progress';
  expiresAt: string;
  dedupeKey: string;
  segments: ReadonlyArray<Readonly<{
    id: string;
    text: string;
    evidenceIds: ReadonlyArray<string>;
    exact: boolean;
    maxSeconds: number;
  }>>;
  resume: 'automatic' | 'offer' | 'discard';
}>;

export type RouteDecision = Readonly<{
  utteranceId: string;
  destination: 'companion' | 'harness' | 'dictation' | 'desktop' | 'control';
  targetSessionId?: string;
  confidence: number;
  basis: 'explicit_prefix' | 'active_mode' | 'classified' | 'clarified';
  requiresClarification: boolean;
}>;

export type ActionRequest = Readonly<{
  actionId: string;
  idempotencyKey: string;
  scope: Scope;
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  evidenceIds: ReadonlyArray<string>;
  targetFingerprint?: string;
  effect: 'read' | 'local_write' | 'external' | 'destructive';
  targetFromGaze: boolean;
  grantId?: string;
  confirmationId?: string;
}>;

export type ContextSnapshot = Readonly<{
  snapshotId: string;
  scope: Scope;
  capturedAt: string;
  source: 'synthetic';
  artifactRef?: string;
}>;
export type InsertReceipt = Readonly<{ transactionId: string; inserted: boolean }>;
export type ActionReceipt = Readonly<{ actionId: string; status: 'completed' | 'denied' | 'unsupported' }>;
export type DurableCursor = Readonly<{ value: string }>;
export type EvidenceBundle = Readonly<{ evidenceIds: ReadonlyArray<string>; summary: string }>;
export type DeletionReceipt = Readonly<{ deleted: number }>;
export type HarnessCapability = 'observe' | 'send' | 'interrupt' | 'approval' | 'resume';
export type HarnessDeliveryReceipt = Readonly<{ deliveryId: string; status: 'acknowledged' | 'unsupported' }>;
export type VoiceOutputEvent = Readonly<{ planId: string; segmentId: string; positionMs: number; status: 'started' | 'completed' | 'cancelled' }>;
export type ReasoningTask = Readonly<{ taskId: string; instruction: string }>;
export type BoundedContext = Readonly<{ evidenceIds: ReadonlyArray<string>; maxTokens: number }>;

/**
 * Version-one subsystem seams. Production implementations arrive in later tickets;
 * F01 supplies deterministic fakes behind these exact shapes.
 */
export interface NativeHost {
  capture(request: Readonly<{ scope: Scope }>): Promise<ContextSnapshot>;
  observeForeground(): AsyncIterable<EventEnvelope>;
  insertText(transaction: Readonly<{ transactionId: string; text: string }>): Promise<InsertReceipt>;
  audio: Readonly<{ start(): Promise<void>; stop(): Promise<void>; duck(): Promise<void>; flush(): Promise<void> }>;
  gaze: Readonly<{ start(): Promise<void>; stop(): Promise<void> }>;
  execute(capability: string, action: ActionRequest): Promise<ActionReceipt>;
}

export interface Memory {
  ingest(batch: ReadonlyArray<EventEnvelope>): Promise<DurableCursor>;
  query(query: string, scope: Scope, budget: number): Promise<EvidenceBundle>;
  consolidate(cursor: DurableCursor): Promise<Readonly<{ checkpoint: string }>>;
  forget(selector: Readonly<{ scope: Scope }>): Promise<DeletionReceipt>;
}

export interface HarnessAdapter {
  capabilities(): Promise<ReadonlySet<HarnessCapability>>;
  start(): Promise<void>;
  observe(): AsyncIterable<EventEnvelope>;
  send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  resume(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceSession {
  start(): Promise<void>;
  pushInput(frame: Readonly<{ sequence: number; sampleRate: number; channels: number; monotonicNs: string; pcm: Uint8Array }>): Promise<void>;
  /** A lease is mandatory: no producer has a direct speak-now capability. */
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
  interrupt(reason: string): Promise<void>;
  mute(): Promise<void>;
  replay(segmentId: string): Promise<void>;
  close(): Promise<void>;
}

export interface Attention {
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
  canSpeak(lease: SpeechLease): boolean;
  revokeSpeech(reason: string): void;
}

export interface Reasoner {
  run(task: ReasoningTask, boundedContext: BoundedContext, outputSchema: Readonly<Record<string, unknown>>, abortSignal: AbortSignal): Promise<unknown>;
}

/** Opaque-to-producers baseline authority issued only by Attention. */
export type SpeechLease = Readonly<{ eventId: string; epoch: number; expiresAt: string }>;

const knownKinds = new Set<KnownEventKind>([
  'user_utterance', 'agent_message', 'tool_started', 'tool_completed', 'approval_requested',
  'decision', 'artifact_changed', 'session_state', 'capture', 'delivery_receipt', 'gap', 'permission_changed',
]);
const sensitivities = new Set<Sensitivity>(['normal', 'private', 'secret']);
const trusts = new Set<EventEnvelope['trust']>(['user_explicit', 'tool_observed', 'agent_reported', 'imported']);

function optionalString(input: Record<string, unknown>, field: string, limit = 512): string | undefined {
  if (!(field in input)) return undefined;
  return string(input[field], field, limit);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Invalid ${field}`);
  return value as number;
}

function utcTimestamp(value: unknown, field: string): string {
  const timestamp = string(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new TypeError(`Expected a valid UTC ISO ${field}`);
  }
  return timestamp;
}

export function parseScope(value: unknown): Scope {
  const input = object(value);
  // Event producers evolve additively; known scope fields are normalized and the rest are ignored.
  const sensitivity = string(input.sensitivity, 'sensitivity', 16) as Sensitivity;
  if (!sensitivities.has(sensitivity)) throw new TypeError('Invalid sensitivity');
  const scope: Scope = { profileId: string(input.profileId, 'profileId', 128), sensitivity };
  const projectId = optionalString(input, 'projectId');
  const worktreeId = optionalString(input, 'worktreeId');
  const sessionId = optionalString(input, 'sessionId');
  return {
    ...scope,
    ...(projectId === undefined ? {} : { projectId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

/** Normalize an envelope from an additive producer. Unknown kinds become display-only unsupported records. */
export function parseEventEnvelope(value: unknown): EventEnvelope {
  const input = object(value);
  if (input.schemaVersion !== CONTRACT_VERSION) throw new TypeError('Unsupported event schema version');
  const rawKind = string(input.kind, 'kind', 64);
  const kind: EventKind = knownKinds.has(rawKind as KnownEventKind) ? rawKind as KnownEventKind : 'unsupported';
  const envelope: EventEnvelope = {
    schemaVersion: CONTRACT_VERSION,
    eventId: string(input.eventId, 'eventId', 128),
    sourceId: string(input.sourceId, 'sourceId', 128),
    sourceEventId: string(input.sourceEventId, 'sourceEventId', 128),
    sourceSequence: nonNegativeInteger(input.sourceSequence, 'sourceSequence'),
    ingestSequence: nonNegativeInteger(input.ingestSequence, 'ingestSequence'),
    occurredAt: utcTimestamp(input.occurredAt, 'occurredAt'),
    observedAt: utcTimestamp(input.observedAt, 'observedAt'),
    scope: parseScope(input.scope),
    kind,
    payloadRef: string(input.payloadRef, 'payloadRef', 2048),
    contentHash: string(input.contentHash, 'contentHash', 256),
    trust: string(input.trust, 'trust', 32) as EventEnvelope['trust'],
  };
  if (!trusts.has(envelope.trust)) throw new TypeError('Invalid trust');
  const monotonicNs = optionalString(input, 'monotonicNs', 32);
  const turnId = optionalString(input, 'turnId');
  const parentEventId = optionalString(input, 'parentEventId');
  return {
    ...envelope,
    ...(monotonicNs === undefined ? {} : { monotonicNs }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(parentEventId === undefined ? {} : { parentEventId }),
    ...(kind === 'unsupported' ? { unsupportedKind: rawKind } : {}),
  };
}
