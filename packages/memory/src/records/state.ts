/**
 * Records-owned durable state (M04).
 *
 * The M01 store owns the raw events — including the correction events this layer ingests — and this
 * module owns the *records* bookkeeping that makes history answerable after a restart: which record
 * a user correction replaced, which corrections a later one superseded, and the display anchor for a
 * record whose raw source no longer exists. Nothing here rewrites the M01 schema or its events: a
 * reversal is always a new explicit event, never an in-place edit.
 *
 * The file is written atomically (temp file + rename, mode 0600) under the store directory, exactly
 * like the M02 consolidation state, so a crash mid-save can never leave a half-written history.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface CorrectionRecord {
  /** Records-owned id of the correction's displayed row. */
  recordId: string;
  /** The record id the user asked to revise. */
  decisionId: string;
  question: string;
  choice: string;
  rationale?: string;
  actor: 'user';
  /** Validity start of the correction, i.e. when the user made the reversal. */
  occurredAt: string;
  /** New explicit user_explicit decision event stored in the M01 store. */
  eventId: string;
  /** Most recent record this correction replaced, when one was still current. */
  supersedesId?: string;
  /** Every record that was current when the correction was made. */
  supersededIds: string[];
  /** Set when a later correction replaced this one. */
  supersededBy?: string;
}

export interface DurableRecordsState {
  version: 1;
  projectId: string;
  /** Extractor label recorded with the corrections for audit; displays use the configured label. */
  extractionVersion: string;
  corrections: CorrectionRecord[];
  /** Display anchor per record id, used only when no source event time is recoverable. */
  firstSeenAt: Record<string, string>;
}

/** Read-only view handed to the display builder; mutations only happen inside `mutate`. */
export interface RecordsStateView {
  readonly version: 1;
  readonly projectId: string;
  readonly extractionVersion: string;
  readonly corrections: readonly CorrectionRecord[];
  readonly firstSeenAt: Readonly<Record<string, string>>;
}

export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function recordsStatePath(directory: string, projectId: string): string {
  return join(directory, 'records', `${encodeURIComponent(projectId)}.m04.json`);
}

export function emptyRecordsState(projectId: string, extractionVersion: string): DurableRecordsState {
  return { version: 1, projectId, extractionVersion, corrections: [], firstSeenAt: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeCorrection(value: unknown): CorrectionRecord | null {
  if (!isRecord(value)) return null;
  const recordId = optionalText(value.recordId);
  const decisionId = optionalText(value.decisionId);
  const choice = optionalText(value.choice);
  const occurredAt = optionalText(value.occurredAt);
  const eventId = optionalText(value.eventId);
  if (recordId === undefined || decisionId === undefined || choice === undefined || occurredAt === undefined || eventId === undefined) {
    return null;
  }
  const supersededIds = Array.isArray(value.supersededIds)
    ? value.supersededIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return {
    recordId,
    decisionId,
    question: optionalText(value.question) ?? '',
    choice,
    ...(optionalText(value.rationale) === undefined ? {} : { rationale: String(value.rationale) }),
    actor: 'user',
    occurredAt,
    eventId,
    ...(optionalText(value.supersedesId) === undefined ? {} : { supersedesId: String(value.supersedesId) }),
    supersededIds,
    ...(optionalText(value.supersededBy) === undefined ? {} : { supersededBy: String(value.supersededBy) }),
  };
}

function normalizeState(value: unknown, projectId: string, extractionVersion: string): DurableRecordsState {
  if (!isRecord(value) || value.version !== 1 || value.projectId !== projectId) {
    throw new Error(`memory records state for ${projectId} is not a supported v1 state file`);
  }
  const state = emptyRecordsState(projectId, extractionVersion);
  state.extractionVersion = optionalText(value.extractionVersion) ?? extractionVersion;
  state.corrections = Array.isArray(value.corrections)
    ? value.corrections.map(normalizeCorrection).filter((entry): entry is CorrectionRecord => entry !== null)
    : [];
  state.firstSeenAt = isRecord(value.firstSeenAt)
    ? Object.fromEntries(
      Object.entries(value.firstSeenAt)
        .filter(([, at]) => typeof at === 'string' && at.length > 0)
        .map(([id, at]) => [id, String(at)]),
    )
    : {};
  return state;
}

export async function loadRecordsState(
  directory: string,
  projectId: string,
  extractionVersion: string,
): Promise<DurableRecordsState> {
  const path = recordsStatePath(directory, projectId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return emptyRecordsState(projectId, extractionVersion);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`memory records state for ${projectId} is corrupt (invalid JSON)`);
  }
  return normalizeState(parsed, projectId, extractionVersion);
}

export async function saveRecordsState(directory: string, state: DurableRecordsState): Promise<void> {
  const path = recordsStatePath(directory, state.projectId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Serialized durable state: reads see the latest committed state, and a read-modify-write (a user
 * correction, or the first-seen anchor for a record whose raw source is gone) never interleaves with
 * another one. A failed mutation is not persisted; later mutations still run.
 */
export class RecordsStateStore {
  private readonly directory: string;
  private readonly projectId: string;
  private readonly extractionVersion: string;
  private state: DurableRecordsState | null = null;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(directory: string, projectId: string, extractionVersion: string) {
    this.directory = directory;
    this.projectId = projectId;
    this.extractionVersion = extractionVersion;
  }

  async snapshot(): Promise<RecordsStateView> {
    await this.settled();
    if (this.state === null) {
      this.state = await loadRecordsState(this.directory, this.projectId, this.extractionVersion);
    }
    return this.state;
  }

  async mutate<T>(job: (state: DurableRecordsState) => T | Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      if (this.state === null) {
        this.state = await loadRecordsState(this.directory, this.projectId, this.extractionVersion);
      }
      const result = await job(this.state);
      await saveRecordsState(this.directory, this.state);
      return result;
    });
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Waits for every accepted mutation to reach disk. */
  async settled(): Promise<void> {
    await this.pending;
  }
}
