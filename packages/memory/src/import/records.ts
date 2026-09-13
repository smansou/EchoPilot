/**
 * One JSONL / plain-text line → one H03 imported emission (M03).
 *
 * The mapping is the H03 generic-adapter contract, reused verbatim so live tailing and the
 * historical import produce the same envelopes for the same bytes:
 *  - the record keeps its own fields as the payload, so the M01 capsule reduction is the same one
 *    a live event with those fields produces;
 *  - `sourceEventId` comes from the record id, `sourceSequence` from the record seq, and
 *    `occurredAt` from the record timestamp;
 *  - an authorization-shaped kind (`approval*`, `authorization*`, `permission*`) is kept as
 *    display-only `unsupported` evidence with its original kind in `unsupportedKind`: imported
 *    content can never become an approval, an instruction, a task, a decision or a grant;
 *  - malformed and oversized lines become display-only `gap` diagnostics and never abort the scan.
 */
import { normalizeDisplayText } from '../../../harness-generic/src/ansi.js';
import { decodeUtf8, stripTrailingCr } from '../../../harness-generic/src/bytes.js';
import { buildImportedEvent } from '../../../harness-generic/src/envelope.js';
import type {
  GenericDiagnostic,
  GenericFormat,
  GenericPreviewEvent,
  GenericScope,
} from '../../../harness-generic/src/types.js';

/** Kinds that look like an authorization request must stay display-only. */
export const AUTHORIZATION_SHAPED = /^(approval|authorization|permission)/i;

/** One physical line of the source: absolute byte span plus the raw bytes (no terminator). */
export type LineSpan = {
  start: number;
  end: number;
  bytes: Uint8Array;
};

/** The store payload and envelope fields one line reduces to. */
export type ParsedRecord = {
  kind: string;
  unsupportedKind?: string | undefined;
  text: string;
  confidence: 'low' | 'high';
  sourceSequence: number;
  sourceEventId?: string | undefined;
  occurredAt?: string | undefined;
  diagnostic?: GenericDiagnostic | undefined;
  /** The record's own fields; empty for a display-only gap. */
  payload: Record<string, unknown>;
};

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A line the bounded scanner dropped as over-long: display-only, never parsed. */
export function oversizedRecord(format: GenericFormat, lineOrdinal: number): ParsedRecord {
  return {
    kind: 'gap',
    text: '',
    confidence: 'low',
    sourceSequence: lineOrdinal,
    diagnostic: format === 'jsonl' ? 'malformed_json' : 'incomplete_line',
    payload: {},
  };
}

/**
 * Parses one complete line. Returns `undefined` for a line that produces no event at all (a blank
 * line), so byte coverage still advances past it without inventing an observation.
 */
export function parseLine(span: LineSpan, format: GenericFormat, lineOrdinal: number): ParsedRecord | undefined {
  const line = decodeUtf8(stripTrailingCr(span.bytes));

  if (format === 'text') {
    const text = normalizeDisplayText(line);
    if (text.trim().length === 0) return undefined;
    return {
      kind: 'log_line',
      text,
      confidence: 'low',
      sourceSequence: lineOrdinal,
      payload: { text },
    };
  }

  const json = line.trim();
  if (json.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A malformed JSON line becomes a display-only gap; adjacent lines keep their own events.
    return {
      kind: 'gap',
      text: '',
      confidence: 'low',
      sourceSequence: lineOrdinal,
      diagnostic: 'malformed_json',
      payload: {},
    };
  }

  if (!isRecord(parsed)) {
    return {
      kind: 'unsupported',
      unsupportedKind: 'non_object_record',
      text: normalizeDisplayText(json),
      confidence: 'low',
      sourceSequence: lineOrdinal,
      payload: {},
    };
  }

  const declared = typeof parsed['kind'] === 'string' ? parsed['kind'] : undefined;
  let kind = declared ?? 'unsupported';
  let unsupportedKind: string | undefined = declared === undefined ? 'missing_kind' : undefined;
  if (AUTHORIZATION_SHAPED.test(kind)) {
    unsupportedKind = kind;
    kind = 'unsupported';
  }

  const rawText = typeof parsed['text'] === 'string'
    ? parsed['text']
    : typeof parsed['message'] === 'string'
      ? parsed['message']
      : '';
  const seq = parsed['seq'];
  const sourceSequence = typeof seq === 'number' && Number.isFinite(seq) ? seq : lineOrdinal;
  const sourceEventId = firstString(parsed['id'], parsed['eventId'], parsed['sourceEventId']);
  const occurredAt = firstString(parsed['occurredAt'], parsed['timestamp']);

  return {
    kind,
    ...(unsupportedKind === undefined ? {} : { unsupportedKind }),
    text: normalizeDisplayText(rawText),
    confidence: declared === undefined ? 'low' : 'high',
    sourceSequence,
    ...(sourceEventId === undefined ? {} : { sourceEventId }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    payload: parsed,
  };
}

export type EmissionContext = {
  sourceId: string;
  generation: number;
  ingestSequence: number;
  scope: GenericScope;
  span: LineSpan;
};

/** Builds the H03 envelope/preview event for one parsed record. */
export function buildEmission(record: ParsedRecord, context: EmissionContext): GenericPreviewEvent {
  return buildImportedEvent({
    sourceId: context.sourceId,
    generation: context.generation,
    ingestSequence: context.ingestSequence,
    scope: context.scope,
    startOffset: context.span.start,
    endOffset: context.span.end,
    raw: context.span.bytes,
    kind: record.kind,
    text: record.text,
    confidence: record.confidence,
    sourceSequence: record.sourceSequence,
    sourceEventId: record.sourceEventId,
    unsupportedKind: record.unsupportedKind,
    occurredAt: record.occurredAt,
    diagnostic: record.diagnostic,
  });
}
