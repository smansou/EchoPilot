/**
 * Bounded byte readers for the M03 cold-start importer.
 *
 * Every read request stays inside the §5.8 64 KiB buffer, and neither helper ever materializes the
 * whole source: the forward reader fills a fixed-size span (a repair window of at most one batch),
 * the tail reader walks backwards in 64 KiB steps until it has the newest `limit` records.
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
 * Reads exactly `[from, to)` with bounded positional reads. Returns `undefined` when the source
 * ends early, so callers can refuse instead of parsing a half-recovered span.
 */
export async function readSpan(
  source: GenericLogSource,
  from: number,
  to: number,
): Promise<Uint8Array | undefined> {
  if (to <= from) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let offset = from;
  while (offset < to) {
    const wanted = Math.min(to - offset, READ_CHUNK_BYTES);
    const chunk = await source.read(offset, wanted);
    if (chunk.byteLength === 0) return undefined;
    const bounded = chunk.byteLength > wanted ? chunk.subarray(0, wanted) : chunk;
    chunks.push(bounded);
    offset += bounded.byteLength;
  }
  return concatChunks(chunks);
}

/** Splits a byte buffer into newline-terminated lines; the unterminated tail is dropped. */
export function splitCompleteLines(bytes: Uint8Array, base: number): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== NEWLINE) continue;
    lines.push({
      start: base + start,
      end: base + index + 1,
      bytes: bytes.subarray(start, index),
    });
    start = index + 1;
  }
  return lines;
}

/** True when the span ends on a line boundary (its last byte terminates a line). */
export function endsWithNewline(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === NEWLINE;
}

/**
 * Tail-first line reader: walks backwards from the end of the source in 64 KiB steps and returns
 * the newest `limit` non-blank complete lines, oldest first. A trailing unterminated line is never a
 * record (the forward scanner treats it as `partial` too), and the leading bytes of the file are
 * only a record when they are newline-terminated.
 */
export async function readTailLines(
  source: GenericLogSource,
  totalBytes: number,
  limit: number,
): Promise<LineSpan[]> {
  if (limit <= 0 || totalBytes <= 0) return [];
  // Newline positions of the newest `limit + 1` line ends, descending. The extra position bounds
  // the start of the oldest returned record; without it the oldest start is the file start (0).
  // The read windows are kept (newest first) so a selected line's bytes need no second read.
  const windows: Array<{ base: number; bytes: Uint8Array }> = [];
  const newlines: number[] = [];
  let regionEnd = totalBytes;
  let scanned = 0;

  while (regionEnd > 0 && newlines.length <= limit && scanned < MAX_TAIL_SCAN_BYTES) {
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
  }
  if (newlines.length > limit) newlines.length = limit + 1;

  const lines: LineSpan[] = [];
  const count = Math.min(limit, newlines.length);
  for (let index = 0; index < count; index += 1) {
    const newline = newlines[index];
    if (newline === undefined) break;
    const next = newlines[index + 1];
    const start = next === undefined ? 0 : next + 1;
    const end = newline + 1;
    const bytes = sliceWindowBytes(windows, start, end - 1);
    if (bytes === undefined || isBlankLine(bytes)) continue;
    lines.push({ start, end, bytes });
  }
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
