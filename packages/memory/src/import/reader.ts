/**
 * Bounded byte readers for the M03 cold-start importer.
 *
 * Every read request stays inside the §5.8 64 KiB buffer and no helper ever materializes a whole
 * source or a whole line: the tail reader walks backwards in 64 KiB windows only to locate line
 * boundaries, and reads back the bytes of one candidate line at a time (never more than
 * `MAX_LINE_BYTES` plus one read buffer). A line past `MAX_LINE_BYTES` is classified by re-scanning
 * it from its own first byte through the H03 `BoundedLineScanner` — the same classifier the forward
 * import and the pending-span repair use — so the tail-first preview reports it exactly as
 * `bootstrap` commits it (an `oversized` display-only gap with empty raw bytes) while its bytes
 * merely stream past in bounded reads instead of being assembled.
 */
import { EMPTY_BYTES, concatChunks } from '../../../harness-generic/src/bytes.js';
import { BoundedLineScanner, MAX_LINE_BYTES, READ_CHUNK_BYTES } from '../../../harness-generic/src/scanner.js';
import type { GenericLogSource } from '../../../harness-generic/src/types.js';
import type { LineSpan } from './records.js';

const NEWLINE = 0x0a;
/**
 * Safety valve for the backward walk: a source whose newest line start lies more than 16 MiB above
 * the scan point (one line longer than the cap, or megabytes of terminators in a row) has no
 * previewable record inside the §5.8 working set, and the walk stops instead of streaming the whole
 * source.
 */
const MAX_TAIL_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * True when the bytes of one complete line are a record the forward pass would commit. The importer
 * passes its own parser-backed predicate so the preview counts exactly the lines `bootstrap` emits;
 * on its own the reader treats every non-blank line as a record.
 */
export type TailLineFilter = (bytes: Uint8Array) => boolean;

const isNonBlankLine: TailLineFilter = (bytes) => !isBlankLine(bytes);

/**
 * One previewed tail line: the usual span of a complete line, or — when the forward scanner classifies
 * the line as `oversized` — a display-only span whose raw bytes are never materialized. The filter is
 * never asked about an oversized line: `bootstrap` always commits it as a gap.
 */
export type TailLineSpan = LineSpan & { oversized?: true };

/**
 * Tail-first line reader: walks backwards from the end of the source in 64 KiB windows and returns
 * the newest `limit` complete lines that `isRecord` accepts, oldest first. A trailing unterminated
 * line is never a record (the forward scanner treats it as `partial` too), and the leading bytes of
 * the file are only a record when they are newline-terminated.
 *
 * Skipped lines are not records, so the backward walk keeps reading older windows until `limit`
 * accepted lines are reconstructed (or the source, the file start, or the scan cap is reached): a
 * blank line among the newest lines never shrinks the preview below the requested record count.
 */
export async function readTailLines(
  source: GenericLogSource,
  totalBytes: number,
  limit: number,
  isRecord: TailLineFilter = isNonBlankLine,
): Promise<TailLineSpan[]> {
  if (limit <= 0 || totalBytes <= 0) return [];
  const lines: TailLineSpan[] = [];
  /**
   * End offset (after the terminator) of the newest complete line whose first byte has not been read
   * yet. The newest newline only bounds the next line's start and is never returned by itself.
   */
  let pendingEnd: number | undefined;
  let regionEnd = totalBytes;
  let scanned = 0;
  /** True once the walk has read the whole prefix of the source (byte 0 included). */
  let reachedStart = false;

  /**
   * Classifies one complete line `[start, end)` (terminator included in the span, excluded from the
   * bytes). A line the forward scanner would reject as over-long is never assembled from windows:
   * re-scanning it from its own first byte with the same bounded scanner yields the identical
   * classification (a display-only `oversized` gap) without buffering it past `MAX_LINE_BYTES`.
   */
  const classifyLine = async (start: number, end: number): Promise<TailLineSpan | undefined> => {
    const length = end - 1 - start;
    if (length > MAX_LINE_BYTES) {
      const scanner = new BoundedLineScanner(source, start);
      const scan = await scanner.next();
      if (scan.type === 'oversized') {
        return { start: scan.start, end: scan.end, bytes: EMPTY_BYTES, oversized: true };
      }
      // A source that still serves this line normally (the scanner's size guard depends on its read
      // granularity) keeps its bytes; anything else means the source changed under the preview.
      if (scan.type === 'line') return { start: scan.start, end: scan.end, bytes: scan.bytes };
      return undefined;
    }
    const bytes = await readRange(source, start, length);
    // A byte range the source does not serve in full (a truncated source) is not a record instead of
    // a silently short line.
    if (bytes === undefined || bytes.byteLength !== length) return undefined;
    if (!isRecord(bytes)) return undefined; // not a record: keep walking for older lines
    return { start, end, bytes };
  };

  while (lines.length < limit && regionEnd > 0 && scanned < MAX_TAIL_SCAN_BYTES) {
    const start = Math.max(0, regionEnd - READ_CHUNK_BYTES);
    const wanted = regionEnd - start;
    // A window is filled with repeated bounded reads: a source may serve fewer bytes than it was
    // asked for (a smaller read cap, a short read), and treating that as "the source ended" would
    // silently drop the newest records of the preview. Only a zero-byte read means end-of-source.
    const bytes = await readRange(source, start, wanted);
    if (bytes === undefined) break;
    scanned += bytes.byteLength;
    // Newlines are consumed newest first: the first one only ends the line above it, every older one
    // completes the line that ends there.
    for (let index = bytes.byteLength - 1; index >= 0 && lines.length < limit; index -= 1) {
      if (bytes[index] !== NEWLINE) continue;
      const end = start + index + 1;
      if (pendingEnd === undefined) {
        pendingEnd = end;
        continue;
      }
      const line = await classifyLine(end, pendingEnd);
      pendingEnd = end;
      if (line !== undefined) lines.push(line);
    }
    // A short window means the source ended before `regionEnd`; only whole records are returned.
    if (bytes.byteLength < wanted) break;
    regionEnd = start;
    if (regionEnd === 0) reachedStart = true;
  }
  // The oldest line of the file starts at byte 0, so it can only be classified once byte 0 was read.
  if (lines.length < limit && reachedStart && pendingEnd !== undefined && pendingEnd > 0) {
    const line = await classifyLine(0, pendingEnd);
    if (line !== undefined) lines.push(line);
  }
  lines.reverse();
  return lines;
}

/**
 * Reads `[start, start + length)` with one bounded request per 64 KiB. A partial read (the source no
 * longer serves the whole range) is returned as-is; the caller decides whether a short range is a
 * record. Only a zero-byte first read means the range is gone.
 */
async function readRange(source: GenericLogSource, start: number, length: number): Promise<Uint8Array | undefined> {
  if (length <= 0) return EMPTY_BYTES;
  const parts: Uint8Array[] = [];
  let filled = 0;
  while (filled < length) {
    const chunk = await source.read(start + filled, Math.min(READ_CHUNK_BYTES, length - filled));
    if (chunk.byteLength === 0) break;
    const remaining = length - filled;
    const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    parts.push(bounded);
    filled += bounded.byteLength;
  }
  if (filled === 0) return undefined;
  return parts.length === 1 ? parts[0] as Uint8Array : concatChunks(parts);
}

function isBlankLine(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0b && byte !== 0x0c) return false;
  }
  return true;
}
