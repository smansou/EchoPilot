/**
 * Domain model for the memory reducers (IMPLEMENTATION_PLAN 5.3 envelopes, 5.8 derived records).
 *
 * The types are structural on purpose: the store accepts synthetic normalized envelopes without
 * importing the contracts package, and the reducers stay pure so that a restarted store reduces
 * the same records it reduced before the restart.
 */

export type Sensitivity = 'normal' | 'private' | 'secret';

export interface EventScope {
  profileId: string;
  projectId?: string;
  worktreeId?: string;
  sessionId?: string;
  sensitivity: Sensitivity;
}

export interface NormalizedEvent {
  schemaVersion: number;
  eventId: string;
  sourceId: string;
  sourceEventId: string;
  sourceSequence: number;
  ingestSequence: number;
  occurredAt: string;
  observedAt: string;
  scope: EventScope;
  kind: string;
  payloadRef: string;
  contentHash: string;
  trust: string;
}

/** Exactly one capsule per stored event: the provenance anchor every derived record links back to. */
export interface SourceCapsule {
  id: string;
  kind: string;
  summary: string;
  occurredAt: string;
  trust: string;
  sourceEventIds: readonly string[];
  /** Lowercased lexical text (summary plus the payload fields it was reduced from). */
  searchText: string;
}

export type TaskStatus = 'running' | 'passed' | 'failed' | 'unknown';
export type TaskPhase = 'started' | 'completed';

/** A deterministic tool handle/receipt observed from one normalized event. */
export interface TaskObservation {
  observationId: string;
  taskId: string;
  eventId: string;
  phase: TaskPhase;
  occurredAt: string;
  ingestSequence: number;
  tool?: string;
  command?: string;
  title?: string;
  exitCode?: number;
  receiptId?: string;
}

/** A deterministic task record derived from tool receipts only (section 5.8 evidence hierarchy). */
export interface TaskRecord {
  id: string;
  kind: 'task';
  status: TaskStatus;
  summary: string;
  occurredAt: string;
  sourceEventIds: readonly string[];
  searchText: string;
  latestReceiptId?: string;
}
