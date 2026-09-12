import { createHash } from 'node:crypto';
import type { GenericDiagnostic, GenericEnvelope, GenericPreviewEvent, GenericScope } from './types.js';

export const GENERIC_SCHEMA_VERSION = 1;
export const GENERIC_FORMAT_VERSION = 1;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export type ImportedEventInput = {
  sourceId: string;
  generation: number;
  ingestSequence: number;
  scope: GenericScope;
  /** Absolute byte offset where the consumed line starts. */
  startOffset: number;
  /** Commit point: byte offset after the consumed line (equals startOffset when nothing was consumed). */
  endOffset: number;
  /** Raw source bytes of the line; hashed, never interpreted. */
  raw: Uint8Array;
  kind: string;
  text: string;
  confidence: 'low' | 'high';
  sourceSequence: number;
  sourceEventId?: string | undefined;
  unsupportedKind?: string | undefined;
  occurredAt?: string | undefined;
  diagnostic?: GenericDiagnostic | undefined;
  eventId?: string | undefined;
};

/**
 * Builds one imported event. Event ids are derived from (sourceId, generation, start offset), so the
 * same physical line keeps the same identity across resume/commit round-trips.
 */
export function buildImportedEvent(input: ImportedEventInput): GenericPreviewEvent {
  const observedAt = new Date().toISOString();
  const eventId = input.eventId
    ?? `ge_${sha256Hex(`${input.sourceId}\u0000${input.generation}\u0000${input.startOffset}`).slice(0, 24)}`;

  const event: GenericEnvelope = {
    schemaVersion: GENERIC_SCHEMA_VERSION,
    eventId,
    sourceId: input.sourceId,
    sourceEventId: input.sourceEventId ?? `${input.sourceId}:${input.generation}:${input.sourceSequence}`,
    sourceSequence: input.sourceSequence,
    ingestSequence: input.ingestSequence,
    occurredAt: input.occurredAt ?? observedAt,
    observedAt,
    scope: input.scope,
    kind: input.kind,
    ...(input.unsupportedKind === undefined ? {} : { unsupportedKind: input.unsupportedKind }),
    payloadRef: `harness-generic:${input.sourceId}#g${input.generation}:${input.startOffset}-${input.endOffset}`,
    contentHash: `sha256:${sha256Hex(input.raw)}`,
    trust: 'imported',
  };

  return {
    event,
    text: input.text,
    confidence: input.confidence,
    ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
    cursor: { sourceId: input.sourceId, generation: input.generation, offset: input.endOffset },
  };
}
