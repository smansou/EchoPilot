import type { NormalizedEvent } from '../reducers/index.js';

export type { EventScope, NormalizedEvent, Sensitivity, SourceCapsule, TaskStatus } from '../reducers/index.js';

export interface NormalizedBatch {
  events: readonly NormalizedEvent[];
  payloads: Readonly<Record<string, unknown>>;
}

export interface IngestOptions {
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

export interface MemoryStore {
  ingest(batch: NormalizedBatch, options?: IngestOptions): Promise<IngestResult>;
  timeline(query: TimelineQuery): Promise<TimelineItem[]>;
  durableCursor(): Promise<string>;
  close(): Promise<void>;
}

export interface CreateMemoryStoreOptions {
  /** Root directory holding the profile database and one encrypted database per project. */
  directory: string;
  /** Key material for the encrypted databases; never written to disk in plaintext. */
  key: string;
  /** Profile registry identity for the store. */
  profileId: string;
}
