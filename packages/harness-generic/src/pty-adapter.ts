import { normalizeDisplayText } from './ansi.js';
import { EMPTY_BYTES, concatChunks, decodeUtf8, stripTrailingCr } from './bytes.js';
import { GENERIC_FORMAT_VERSION, buildImportedEvent } from './envelope.js';
import { normalizePreviewLimit } from './limits.js';
import type {
  GenericCapabilityDescriptor,
  GenericCursor,
  GenericDeliveryReceipt,
  GenericLogAdapter,
  GenericPreview,
  GenericPreviewEvent,
  GenericPreviewOptions,
  GenericScope,
  ManagedPtyAdapterOptions,
  ManagedPtyChild,
} from './types.js';

/**
 * Opt-in wrapper for the PTY of a child this application started because the user selected it.
 *
 * Observation is unconditional; sending is available only through this factory, only to that child,
 * and only when the caller explicitly calls send(). Output is never auto-classified: a line that
 * looks like an approval request stays low-confidence display text and approvalResponse is false.
 * Existing arbitrary terminals are never wrapped by this factory, and files/logs stay
 * observation-only through the import adapter.
 */
export class ManagedPtyAdapter implements GenericLogAdapter {
  private readonly child: ManagedPtyChild;
  private readonly scope: GenericScope;
  private readonly sourceId: string;

  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private consumedBytes = 0;
  private ingestSequence = 0;
  private lineOrdinal = 0;
  private lastPartialStart: number | undefined;
  private readonly delivered = new Set<string>();
  private unsubscribe: (() => void) | undefined;

  constructor(options: ManagedPtyAdapterOptions) {
    this.child = options.child;
    this.scope = options.scope;
    this.sourceId = `pty:${options.sessionId}`;
    this.unsubscribe = this.child.onData((chunk: Uint8Array) => {
      this.ingest(chunk);
    });
  }

  /** Detaches from the managed child; no further output is observed. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async capabilities(): Promise<GenericCapabilityDescriptor> {
    return {
      observe: true,
      send: true,
      interrupt: false,
      resume: false,
      approvalResponse: false,
      toolResults: false,
      artifactDiffs: false,
      format: 'text',
      formatVersion: GENERIC_FORMAT_VERSION,
    };
  }

  /** Delivers one instruction to the selected child, newline-terminated and deduplicated by id. */
  async send(instruction: string, deliveryId: string): Promise<GenericDeliveryReceipt> {
    if (!this.delivered.has(deliveryId)) {
      this.delivered.add(deliveryId);
      this.child.write(instruction.endsWith('\n') ? instruction : `${instruction}\n`);
    }
    return { deliveryId, status: 'acknowledged' };
  }

  /** Flushes everything received before the call; a trailing partial line stays buffered. */
  async preview(options: GenericPreviewOptions = {}): Promise<GenericPreview> {
    const limit = normalizePreviewLimit(options.limit);
    const events: GenericPreviewEvent[] = [];
    const pending = concatChunks(this.chunks);
    let cursor = 0;

    while (events.length < limit) {
      const newline = pending.indexOf(0x0a, cursor);
      if (newline === -1) break;
      const lineBytes = stripTrailingCr(pending.subarray(cursor, newline));
      const start = this.consumedBytes + cursor;
      const end = this.consumedBytes + newline + 1;
      cursor = newline + 1;
      this.lineOrdinal += 1;
      this.lastPartialStart = undefined;

      const text = normalizeDisplayText(decodeUtf8(lineBytes));
      if (text.trim().length === 0) continue;
      this.ingestSequence += 1;
      events.push(buildImportedEvent({
        sourceId: this.sourceId,
        generation: 1,
        ingestSequence: this.ingestSequence,
        scope: this.scope,
        startOffset: start,
        endOffset: end,
        raw: lineBytes,
        kind: 'log_line',
        text,
        confidence: 'low',
        sourceSequence: this.lineOrdinal,
      }));
    }

    this.drop(cursor);

    if (events.length < limit && this.bufferedBytes > 0 && this.lastPartialStart !== this.consumedBytes) {
      this.lastPartialStart = this.consumedBytes;
      this.ingestSequence += 1;
      events.push(buildImportedEvent({
        sourceId: this.sourceId,
        generation: 1,
        ingestSequence: this.ingestSequence,
        scope: this.scope,
        startOffset: this.consumedBytes,
        endOffset: this.consumedBytes,
        raw: EMPTY_BYTES,
        kind: 'gap',
        text: '',
        confidence: 'low',
        sourceSequence: this.lineOrdinal + 1,
        diagnostic: 'incomplete_line',
      }));
    }

    const last = events[events.length - 1];
    return { events, cursor: last === undefined ? this.currentCursor() : last.cursor };
  }

  private ingest(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    // Defensive copy: the child owns (and may reuse) its output buffer.
    const copy = new Uint8Array(chunk);
    this.chunks.push(copy);
    this.bufferedBytes += copy.byteLength;
  }

  private drop(count: number): void {
    this.consumedBytes += count;
    let remaining = count;
    while (remaining > 0) {
      const head = this.chunks[0];
      if (head === undefined) break;
      if (head.byteLength <= remaining) {
        remaining -= head.byteLength;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.bufferedBytes = Math.max(0, this.bufferedBytes - count);
  }

  private currentCursor(): GenericCursor {
    return { sourceId: this.sourceId, generation: 1, offset: this.consumedBytes };
  }
}
