/**
 * Bounded byte readers for the M03 cold-start importer.
 *
 * Every read request stays inside the §5.8 64 KiB buffer and no helper ever materializes a whole
 * source or a whole span: the tail reader walks backwards in 64 KiB steps until it has the newest
 * `limit` records. Forward scanning — including the pending-span repair — goes through the H03
 * `BoundedLineScanner`, which classifies an over-long line as a display-only gap without ever
 * buffering it past `MAX_LINE_BYTES`.
 */
import { concatChunks } from '../../../harness-generic/src/bytes.js';
import { READ_CHUNK_BYTES } from '../../../harness-generic/src/scanner.js';
import type { GenericLogSource } from '../../../harness-generic/src/types.js';
import type { LineSpan } from './records.js';

const NEWLINE = 0x0a;
/**
 * Safety valve for the backward walk: a source with no newline in its last 16 MiB has no previewable
 * records, and the walk stops instead of materializing a whole giant line.
 */
const MAX_TAIL_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * Tail-first line reader: walks backwards from the end of the source in 64 KiB steps and returns
 * the newest `limit` non-blank complete lines, oldest first. A trailing unterminated line is never a
 * record (the forward scanner treats it as `partial` too), and the leading bytes of the file are
 * only a record when they are newline-terminated.
 *
 * Blank lines are not records, so the backward walk keeps reading older windows until `limit`
 * non-blank lines are reconstructed (or the source, the file start, or the scan cap is reached): a
 * blank line among the newest lines never shrinks the preview below the requested record count.
 */
export async function readTailLines(
  source: GenericLogSource,
  totalBytes: number,
  limit: number,
): Promise<LineSpan[]> {
  if (limit <= 0 || totalBytes <= 0) return [];
  // Newline positions of the complete line ends read so far, descending. A line is only
  // reconstructible once both its own terminator and the terminator before it (or the file start)
  // have been read: the oldest newline collected so far only bounds the start of the next line and
  // is never returned by itself. The read windows are kept (newest first) so a selected line's bytes
  // need no second read.
  const windows: Array<{ base: number; bytes: Uint8Array }> = [];
  const newlines: number[] = [];
  const lines: LineSpan[] = [];
  let regionEnd = totalBytes;
  let scanned = 0;
  /** True once the walk has read the whole prefix of the source (byte 0 included). */
  let reachedStart = false;
  /** Index of the newest newline that has not been turned into a candidate line yet. */
  let next = 0;

  /** Resolves the newest candidate lines, skipping blank ones, until `limit` records are collected. */
  const collect = (): void => {
    while (lines.length < limit && next < newlines.length) {
      const end = newlines[next];
      if (end === undefined) break;
      const previous = newlines[next + 1];
      const start = previous !== undefined ? previous + 1 : reachedStart ? 0 : undefined;
      if (start === undefined) break; // this line's first byte has not been read yet
      next += 1;
      const bytes = sliceWindowBytes(windows, start, end);
      if (bytes === undefined) continue;
      if (isBlankLine(bytes)) continue; // blank lines are not records: keep walking for older ones
      lines.push({ start, end: end + 1, bytes });
    }
  };

  while (lines.length < limit && regionEnd > 0 && scanned < MAX_TAIL_SCAN_BYTES) {
    const start = Math.max(0, regionEnd - READ_CHUNK_BYTES);
    const wanted = regionEnd - start;
    const chunk = await source.read(start, wanted);
    if (chunk.byteLength === 0) break;
    const bounded = chunk.byteLength > wanted ? chunk.subarray(0, wanted) : chunk;
    windows.push({ base: start, bytes: bounded });
    scanned += bounded.byteLength;
    for (let index = bounded.byteLength - 1; index >= 0; index -= 1) {
      if (bounded[index] === NEWLINE) newlines.push(start + index);
    }
    if (bounded.byteLength < wanted) break; // the source ended; only whole records are returned below
    regionEnd = start;
    if (regionEnd === 0) reachedStart = true;
    collect();
  }
  collect();
  lines.reverse();
  return lines;
}

/** Slices `[start, end)` (line content, terminator excluded) out of the read windows. */
function sliceWindowBytes(
  windows: ReadonlyArray<{ base: number; bytes: Uint8Array }>,
  start: number,
  end: number,
): Uint8Array | undefined {
  if (end <= start) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let cursor = start;
  // Oldest window first so the slices concatenate in source order.
  for (const window of [...windows].sort((left, right) => left.base - right.base)) {
    const windowStart = window.base;
    const windowEnd = window.base + window.bytes.byteLength;
    if (windowEnd <= start || windowStart >= end) continue;
    const from = Math.max(start, windowStart) - windowStart;
    const to = Math.min(end, windowEnd) - windowStart;
    if (to <= from) continue;
    parts.push(window.bytes.subarray(from, to));
    cursor = windowStart + to;
    if (cursor >= end) break;
  }
  if (parts.length === 0) return undefined;
  return concatChunks(parts);
}

function isBlankLine(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0b && byte !== 0x0c) return false;
  }
  return true;
}
