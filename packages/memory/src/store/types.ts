import type { MemoryDeletion } from '../deletion/index.js';
import type { NormalizedEvent } from '../reducers/index.js';

export type { EventScope, NormalizedEvent, Sensitivity, SourceCapsule, TaskStatus } from '../reducers/index.js';

export interface NormalizedBatch {
  events: readonly NormalizedEvent[];
  payloads: Readonly<Record<string, unknown>>;
}

export interface IngestOptions {
  /** Process-private capture scope, separate from the source's real session identity. */
  privateSessionId?: string | null;
  /** Fault-injection seam: throwing here simulates a crash immediately before COMMIT. */
  onBeforeCommit?: () => void;
}

export interface IngestResult {
  durableCursor: string;
  inserted: number;
  duplicates: number;
}

export interface TimelineItem {
  id: string;
  kind: string;
  summary: string;
  sourceEventIds: readonly string[];
  occurredAt: string;
  trust?: string;
  status?: string;
}

export interface TimelineQuery {
  projectId: string;
  text?: string;
}

export type StoredDialogue = Readonly<{ eventId: string; projectId: string; occurredAt: string; question: string; answer: string }>;
export interface MemoryStore {
  readDialogue?(projectId: string, options: { limit: number; maxQuestionChars: number; maxAnswerChars: number }): Promise<StoredDialogue[]>;
  ingest(batch: NormalizedBatch, options?: IngestOptions): Promise<IngestResult>;
  timeline(query: TimelineQuery): Promise<TimelineItem[]>;
  durableCursor(): Promise<string>;
  close(): Promise<void>;
  /**
   * The profile's privacy handle, present on every store produced by `createMemoryStore`: the
   * durable forget ledger this store enforces at ingest and the private-session registry its
   * storage boundary honors. A consumer that needs to forget, to begin a private session or to
   * know whether an identity is suppressed reads it from here instead of opening a second handle.
   */
  readonly privacy?: MemoryDeletion;
}

export interface CreateMemoryStoreOptions {
  /** Root directory holding the profile database and one encrypted database per project. */
  directory: string;
  /** Key material for the encrypted databases; never written to disk in plaintext. */
  key: string;
  /** Profile registry identity for the store. */
  profileId: string;
  /**
   * An existing deletion handle for this profile. Supplying the handle the profile layer already
   * owns shares one forget ledger *and one private-session registry* with the store, which is what
   * makes a private session opened elsewhere apply at this storage boundary.
   */
  privacy?: MemoryDeletion;
}
