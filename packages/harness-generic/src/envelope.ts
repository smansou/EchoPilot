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
 * Event id of one imported emission.
 *
 * The identity covers the whole emission — (sourceId, generation, byte span, kind, diagnostic) — not
 * just the line start: a `source_rotated` gap and an `incomplete_line` gap both start at offset 0 of
 * the bytes they precede (the first record of a new generation, a line completed later), so deriving
 * the id from the start offset alone made those distinct events share one id and let downstream
 * deduplication drop the real record. Every input is a property of the physical bytes, so the same
 * line keeps the same id across resume/commit round-trips while no two emissions in one generation
 * collide.
 */
function importedEventId(input: ImportedEventInput): string {
  const identity = [
    input.sourceId,
    input.generation,
    input.startOffset,
    input.endOffset,
    input.kind,
    input.diagnostic ?? '',
  ].join('\u0000');
  return `ge_${sha256Hex(identity).slice(0, 24)}`;
}

/**
 * Builds one imported event. Event ids are derived from the full emission identity, so the same
 * physical line keeps the same identity across resume/commit round-trips.
 */
export function buildImportedEvent(input: ImportedEventInput): GenericPreviewEvent {
  const observedAt = new Date().toISOString();
  const eventId = input.eventId ?? importedEventId(input);

  const event: GenericEnvelope = {
    schemaVersion: GENERIC_SCHEMA_VERSION,
    eventId,
    sourceId: input.sourceId,
    // The synthesized id carries the byte span as well: a gap and the record it precedes share a
    // sequence (a `source_rotated` gap is sequence 0, a record may declare `seq: 0`), so keying the
    // id on the sequence alone would let a (sourceId, sourceEventId) replay key drop the record.
    sourceEventId: input.sourceEventId
      ?? `${input.sourceId}:${input.generation}:${input.startOffset}-${input.endOffset}:${input.sourceSequence}`,
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
