/**
 * Bounded, forward-only line scanner for imported logs (H03).
 *
 * Invariants:
 *  - one read request never exceeds READ_CHUNK_BYTES and the pending buffer never exceeds
 *    MAX_LINE_BYTES + READ_CHUNK_BYTES, so a 10 GiB source streams through a small working set
 *    instead of being materialized or scanned as a whole;
 *  - offsets are absolute byte positions inside the current source generation;
 *  - 'partial' (an unterminated trailing line) does not consume its bytes: the buffer is kept so the
 *    line can be completed later, and the committed cursor stays at its first byte.
 */
import { EMPTY_BYTES, concatBytes } from './bytes.js';

export const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export type ReadOnlyByteSource = {
  read(offset: number, maxBytes: number): Promise<Uint8Array>;
};

export type LineScan =
  | { type: 'line'; start: number; end: number; bytes: Uint8Array }
  | { type: 'oversized'; start: number; end: number }
  | { type: 'partial'; start: number; bytes: Uint8Array }
  | { type: 'eof' };

export class BoundedLineScanner {
  private buffer: Uint8Array = EMPTY_BYTES;
  private start: number;
  private atEnd = false;
  private oversizeStart: number | undefined;

  constructor(private readonly source: ReadOnlyByteSource, startOffset: number) {
    this.start = Math.max(0, Math.trunc(startOffset));
  }

  /** Absolute offset of the first byte that has not been consumed yet. */
  get offset(): number {
    return this.start;
  }

  /** Drops a cached end-of-source so a later call re-checks the source (logs can grow). */
  refresh(): void {
    this.atEnd = false;
  }

  async next(): Promise<LineScan> {
    for (;;) {
      const newline = this.buffer.indexOf(NEWLINE);
      if (newline !== -1) {
        const oversized = this.oversizeStart !== undefined;
        const start = this.oversizeStart ?? this.start;
        const end = this.start + newline + 1;
        const bytes = this.buffer.subarray(0, newline);
        this.oversizeStart = undefined;
        this.buffer = this.buffer.subarray(newline + 1);
        this.start = end;
        return oversized ? { type: 'oversized', start, end } : { type: 'line', start, end, bytes };
      }

      if (this.oversizeStart !== undefined) {
        if (this.atEnd) {
          const start = this.oversizeStart;
          this.oversizeStart = undefined;
          const end = this.start + this.buffer.byteLength;
          this.buffer = EMPTY_BYTES;
          this.start = end;
          return { type: 'oversized', start, end };
        }
        this.start += this.buffer.byteLength;
        this.buffer = EMPTY_BYTES;
        await this.fill();
        continue;
      }

      if (this.buffer.byteLength > MAX_LINE_BYTES) {
        // Memory guard: stop buffering an over-long line and discard up to the next newline.
        this.oversizeStart = this.start;
        continue;
      }

      if (this.atEnd) {
        if (this.buffer.byteLength === 0) return { type: 'eof' };
        return { type: 'partial', start: this.start, bytes: this.buffer };
      }

      await this.fill();
    }
  }

  private async fill(): Promise<void> {
    const chunk = await this.source.read(this.start + this.buffer.byteLength, READ_CHUNK_BYTES);
    if (chunk.byteLength === 0) {
      this.atEnd = true;
      return;
    }
    this.atEnd = false;
    this.buffer = concatBytes(this.buffer, chunk);
  }
}
