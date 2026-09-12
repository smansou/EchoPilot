import { normalizeDisplayText } from './ansi.js';
import { EMPTY_BYTES, decodeUtf8, stripTrailingCr } from './bytes.js';
import { GENERIC_FORMAT_VERSION, buildImportedEvent } from './envelope.js';
import { normalizePreviewLimit } from './limits.js';
import { BoundedLineScanner, type LineScan } from './scanner.js';
import type {
  GenericCapabilityDescriptor,
  GenericCursor,
  GenericDeliveryReceipt,
  GenericDiagnostic,
  GenericFormat,
  GenericLogAdapter,
  GenericLogAdapterOptions,
  GenericLogSource,
  GenericPreview,
  GenericPreviewEvent,
  GenericPreviewOptions,
  GenericScope,
} from './types.js';

/** Kinds that look like an authorization request must stay display-only. */
const AUTHORIZATION_SHAPED = /^(approval|authorization|permission)/i;

type LineEmission = {
  start: number;
  end: number;
  raw: Uint8Array;
  kind: string;
  text: string;
  confidence: 'low' | 'high';
  sourceSequence: number;
  sourceEventId?: string | undefined;
  unsupportedKind?: string | undefined;
  occurredAt?: string | undefined;
  diagnostic?: GenericDiagnostic | undefined;
};

/**
 * Read-only import adapter over one generation of one file.
 *
 * The adapter streams through a bounded scanner, tracks (sourceId, generation, offset), and treats
 * every record as data: `send()` is always unsupported and no imported record can become an
 * approval or an executable instruction.
 */
export class ImportLogAdapter implements GenericLogAdapter {
  private readonly format: GenericFormat;
  private readonly source: GenericLogSource;
  private readonly scope: GenericScope;

  private sourceId = '';
  private generation = 0;
  private scanner: BoundedLineScanner | undefined;
  private lineOrdinal = 0;
  private ingestSequence = 0;
  private lastPartialStart: number | undefined;

  constructor(options: GenericLogAdapterOptions) {
    this.format = options.format;
    this.source = options.source;
    this.scope = options.scope;
  }

  async capabilities(): Promise<GenericCapabilityDescriptor> {
    return {
      observe: true,
      send: false,
      interrupt: false,
      resume: true,
      approvalResponse: false,
      toolResults: false,
      artifactDiffs: false,
      format: this.format,
      formatVersion: GENERIC_FORMAT_VERSION,
    };
  }

  /** Imported content is never an instruction path: there is nothing to deliver to. */
  async send(_instruction: string, deliveryId: string): Promise<GenericDeliveryReceipt> {
    return { deliveryId, status: 'unsupported' };
  }

  async preview(options: GenericPreviewOptions = {}): Promise<GenericPreview> {
    const limit = normalizePreviewLimit(options.limit);
    const events: GenericPreviewEvent[] = [];

    const rotation = await this.bind(options.from);
    if (rotation !== undefined && limit > 0) events.push(rotation);

    while (events.length < limit) {
      const scanner = this.scanner;
      if (scanner === undefined) break;
      const scan = await scanner.next();
      if (scan.type === 'eof') break;
      if (scan.type === 'partial') {
        // Unterminated trailing line: reported once, not parsed, not consumed.
        if (this.lastPartialStart !== scan.start) {
          this.lastPartialStart = scan.start;
          events.push(this.partialEvent(scan));
        }
        break;
      }
      if (scan.type === 'oversized') {
        this.lineOrdinal += 1;
        this.lastPartialStart = undefined;
        events.push(this.emit({
          start: scan.start,
          end: scan.end,
          raw: EMPTY_BYTES,
          kind: 'gap',
          text: '',
          confidence: 'low',
          sourceSequence: this.lineOrdinal,
          diagnostic: this.format === 'jsonl' ? 'malformed_json' : 'incomplete_line',
        }));
        continue;
      }
      this.lastPartialStart = undefined;
      const event = this.consumeLine(scan);
      if (event !== undefined) events.push(event);
    }

    const last = events[events.length - 1];
    return { events, cursor: last === undefined ? this.currentCursor() : last.cursor };
  }

  /** Resolves the start cursor, detecting rotation and explicit resume; returns a rotation gap. */
  private async bind(from: GenericCursor | undefined): Promise<GenericPreviewEvent | undefined> {
    const identity = await this.source.identity();

    if (this.scanner === undefined) {
      this.sourceId = identity;
      this.lineOrdinal = 0;
      if (from === undefined) {
        this.generation = 1;
        this.scanner = new BoundedLineScanner(this.source, 0);
        return undefined;
      }
      if (from.sourceId === identity) {
        this.generation = Math.max(1, Math.trunc(from.generation));
        this.scanner = new BoundedLineScanner(this.source, Math.max(0, Math.trunc(from.offset)));
        return undefined;
      }
      this.generation = Math.max(1, Math.trunc(from.generation) + 1);
      this.scanner = new BoundedLineScanner(this.source, 0);
      return this.rotationEvent();
    }

    if (identity !== this.sourceId) {
      const next = from === undefined
        ? this.generation + 1
        : Math.max(this.generation + 1, Math.trunc(from.generation) + 1);
      this.generation = next;
      this.sourceId = identity;
      this.lineOrdinal = 0;
      this.lastPartialStart = undefined;
      this.scanner = new BoundedLineScanner(this.source, 0);
      return this.rotationEvent();
    }

    if (from !== undefined && from.sourceId === identity && Math.trunc(from.generation) === this.generation) {
      const offset = Math.max(0, Math.trunc(from.offset));
      if (offset !== this.scanner.offset) this.scanner = new BoundedLineScanner(this.source, offset);
    }
    this.scanner.refresh();
    return undefined;
  }

  private consumeLine(scan: Extract<LineScan, { type: 'line' }>): GenericPreviewEvent | undefined {
    this.lineOrdinal += 1;
    const line = decodeUtf8(stripTrailingCr(scan.bytes));

    if (this.format === 'text') {
      const text = normalizeDisplayText(line);
      if (text.trim().length === 0) return undefined;
      return this.emit({
        start: scan.start,
        end: scan.end,
        raw: scan.bytes,
        kind: 'log_line',
        text,
        confidence: 'low',
        sourceSequence: this.lineOrdinal,
      });
    }

    const json = line.trim();
    if (json.length === 0) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // A malformed JSON line becomes a display-only gap; adjacent lines keep their own events.
      return this.emit({
        start: scan.start,
        end: scan.end,
        raw: scan.bytes,
        kind: 'gap',
        text: '',
        confidence: 'low',
        sourceSequence: this.lineOrdinal,
        diagnostic: 'malformed_json',
      });
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.emit({
        start: scan.start,
        end: scan.end,
        raw: scan.bytes,
        kind: 'unsupported',
        unsupportedKind: 'non_object_record',
        text: normalizeDisplayText(json),
        confidence: 'low',
        sourceSequence: this.lineOrdinal,
      });
    }

    const record = parsed as Record<string, unknown>;
    const declared = typeof record['kind'] === 'string' ? record['kind'] : undefined;
    let kind = declared ?? 'unsupported';
    let unsupportedKind: string | undefined = declared === undefined ? 'missing_kind' : undefined;
    if (AUTHORIZATION_SHAPED.test(kind)) {
      // An approval-shaped record is preserved for display, never as an actionable request.
      unsupportedKind = kind;
      kind = 'unsupported';
    }

    const rawText = typeof record['text'] === 'string'
      ? record['text']
      : typeof record['message'] === 'string'
        ? record['message']
        : '';
    const seq = record['seq'];
    const sourceSequence = typeof seq === 'number' && Number.isFinite(seq) ? seq : this.lineOrdinal;

    return this.emit({
      start: scan.start,
      end: scan.end,
      raw: scan.bytes,
      kind,
      text: normalizeDisplayText(rawText),
      confidence: declared === undefined ? 'low' : 'high',
      sourceSequence,
      sourceEventId: firstString(record['id'], record['eventId'], record['sourceEventId']),
      unsupportedKind,
      occurredAt: firstString(record['occurredAt'], record['timestamp']),
    });
  }

  private partialEvent(scan: Extract<LineScan, { type: 'partial' }>): GenericPreviewEvent {
    return this.emit({
      start: scan.start,
      end: scan.start,
      raw: scan.bytes,
      kind: 'gap',
      text: '',
      confidence: 'low',
      sourceSequence: this.lineOrdinal + 1,
      diagnostic: 'incomplete_line',
    });
  }

  private rotationEvent(): GenericPreviewEvent {
    return this.emit({
      start: 0,
      end: 0,
      raw: EMPTY_BYTES,
      kind: 'gap',
      text: '',
      confidence: 'low',
      sourceSequence: 0,
      diagnostic: 'source_rotated',
    });
  }

  private emit(emission: LineEmission): GenericPreviewEvent {
    this.ingestSequence += 1;
    return buildImportedEvent({
      sourceId: this.sourceId,
      generation: this.generation,
      ingestSequence: this.ingestSequence,
      scope: this.scope,
      startOffset: emission.start,
      endOffset: emission.end,
      raw: emission.raw,
      kind: emission.kind,
      text: emission.text,
      confidence: emission.confidence,
      sourceSequence: emission.sourceSequence,
      sourceEventId: emission.sourceEventId,
      unsupportedKind: emission.unsupportedKind,
      occurredAt: emission.occurredAt,
      diagnostic: emission.diagnostic,
    });
  }

  private currentCursor(): GenericCursor {
    return {
      sourceId: this.sourceId,
      generation: this.generation,
      offset: this.scanner === undefined ? 0 : this.scanner.offset,
    };
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
