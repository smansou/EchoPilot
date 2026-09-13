/**
 * Durable checkpoint of one resumable import job (M03).
 *
 * The byte offset is the job's commit point: `committedOffset` is the offset after the last record
 * whose observations are durably in the M01 store, so a killed run resumes exactly where the
 * committed events end — no observation is duplicated and none is skipped.
 *
 * A batch is handed to the store in two durable steps so a kill at any instant leaves a repairable
 * state:
 *   1. `pendingOffset` is written first (still keeping `committedOffset`), covering the span
 *      `[committedOffset, pendingOffset)`;
 *   2. the store ingest commits;
 *   3. `pendingOffset` is cleared and `committedOffset` is promoted to it.
 *
 * A kill between 1 and 2 leaves the store behind the pending span (repair re-ingests it), a kill
 * between 2 and 3 leaves the store ahead of `committedOffset` (repair re-ingests the same span and
 * the store's `(sourceId, sourceEventId)` deduplication counts the already-stored records), and a
 * kill outside the window leaves nothing to repair. Every write is atomic (temporary file +
 * rename), so a half-written checkpoint is never observed.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const IMPORT_CHECKPOINT_VERSION = 1;
export const IMPORT_CHECKPOINT_FILE = 'import-checkpoint.json';

export interface ImportCheckpoint {
  version: typeof IMPORT_CHECKPOINT_VERSION;
  /** Identity of the source generation the offsets belong to. */
  sourceId: string;
  /** Starts at 1 and advances when the source identity changes (rotation/truncation). */
  generation: number;
  /** Offset after the last record whose observations are committed to the store. */
  committedOffset: number;
  /** Offset after the last record handed to the store but not yet promoted; null when idle. */
  pendingOffset: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function offset(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`import checkpoint is corrupt: ${label} is not a non-negative integer`);
  }
  return value;
}

/**
 * Reads and writes one import checkpoint. A corrupt checkpoint is refused instead of reset: a
 * discarded offset would re-import an unknown span and could double-store observations.
 */
export class ImportCheckpointStore {
  readonly directory: string;
  readonly path: string;

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, IMPORT_CHECKPOINT_FILE);
  }

  async load(): Promise<ImportCheckpoint | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`import checkpoint at ${this.path} is corrupt (invalid JSON)`);
    }
    if (!isRecord(parsed) || parsed.version !== IMPORT_CHECKPOINT_VERSION) {
      throw new Error(`import checkpoint at ${this.path} is not a supported v${String(IMPORT_CHECKPOINT_VERSION)} checkpoint`);
    }
    const sourceId = parsed.sourceId;
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new Error(`import checkpoint at ${this.path} is corrupt: sourceId is missing`);
    }
    const generation = offset(parsed.generation, 'generation');
    if (generation < 1) throw new Error(`import checkpoint at ${this.path} is corrupt: generation must start at 1`);
    const committedOffset = offset(parsed.committedOffset, 'committedOffset');
    const pending = parsed.pendingOffset;
    let pendingOffset: number | null = null;
    if (pending !== null && pending !== undefined) {
      pendingOffset = offset(pending, 'pendingOffset');
      if (pendingOffset < committedOffset) {
        throw new Error(`import checkpoint at ${this.path} is corrupt: pendingOffset is behind committedOffset`);
      }
    }
    return { version: IMPORT_CHECKPOINT_VERSION, sourceId, generation, committedOffset, pendingOffset };
  }

  /** Atomic write: a crash mid-save can never leave a half-written checkpoint behind. */
  async save(checkpoint: ImportCheckpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}
