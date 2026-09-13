/**
 * Read-only, fs-backed `GenericLogSource` for an *existing* JSONL / plain-text log (H03).
 *
 * The adapter never materializes a log: `read()` opens the path, reads at most `readCapBytes`
 * (64 KiB by default) at the requested offset, and closes the handle again. `identity()` is the
 * file's (device, inode) pair, so:
 *   - appends to the same file keep the same identity and stream on from the committed offset;
 *   - rotation (rename away + recreate) changes the identity and advances the generation;
 *   - in-place truncation keeps the identity, which the adapter resolves by comparing `size()`
 *     against the committed offset (a committed offset that no longer exists is a new generation).
 */
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { EMPTY_BYTES } from './bytes.js';
import { READ_CHUNK_BYTES } from './scanner.js';
import type { GenericLogSource } from './types.js';

export const DEFAULT_FILE_READ_CAP_BYTES = READ_CHUNK_BYTES;

export type FileLogSourceOptions = {
  path: string;
  /** Upper bound for a single read; defaults to the adapter's 64 KiB streaming chunk. */
  readCapBytes?: number;
};

function bounded(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

export class FileLogSource implements GenericLogSource {
  private readonly path: string;
  private readonly readCapBytes: number;

  constructor(options: string | FileLogSourceOptions) {
    const resolved = typeof options === 'string' ? { path: options } : options;
    this.path = resolved.path;
    this.readCapBytes = Math.max(1, bounded(resolved.readCapBytes ?? DEFAULT_FILE_READ_CAP_BYTES, DEFAULT_FILE_READ_CAP_BYTES));
  }

  /** Stable identity of the current file generation; rename + recreate changes it. */
  async identity(): Promise<string> {
    const info = await stat(this.path);
    return `file:${basename(this.path)}:${info.dev}:${info.ino}`;
  }

  async size(): Promise<number> {
    return (await stat(this.path)).size;
  }

  /** One bounded positional read. Only an EOF read returns fewer bytes than requested. */
  async read(offset: number, maxBytes: number): Promise<Uint8Array> {
    const start = bounded(offset, 0);
    const wanted = Math.min(bounded(maxBytes, 0), this.readCapBytes);
    if (wanted === 0) return EMPTY_BYTES;
    const handle = await open(this.path, 'r');
    try {
      const buffer = new Uint8Array(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, start);
      return bytesRead === wanted ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

/** Opens an existing log file read-only as a bounded `GenericLogSource`. */
export function createFileLogSource(options: string | FileLogSourceOptions): GenericLogSource {
  return new FileLogSource(options);
}
