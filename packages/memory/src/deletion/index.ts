/**
 * S03 deletion seam — a forget is a durable decision, not a UI filter.
 *
 * "Forget this" has to mean the same thing to every reader that follows: the raw lineage rows are
 * removed from the encrypted store, the derived state that cited them (M02 facts/decisions/cards
 * and the M04 correction history) is condensed, and a *tombstone* records what the user chose so
 * that re-importing the same source cannot quietly put it back. Nothing here decrypts record
 * content: identity columns (`event_id`, `source_id`, `source_event_id`, `payload_ref`) are
 * routing metadata, so a forget works on a closed store and never needs the key.
 *
 * Three rules make the choice stick:
 *
 *  - **Lineage first.** Deleting a displayed fact is not enough; the envelope, payload, capsule,
 *    decision and task rows of the events behind it are removed in the same pass, so a later
 *    consolidation cannot re-derive the claim from surviving raw evidence.
 *  - **Derived state condensed.** The M02 state file and the M04 correction file are rewritten
 *    without the forgotten claims and with the card cache dropped, because a restart rebuilds the
 *    readers from those files and never from the deleted rows.
 *  - **Tombstones, not global content blocks.** A forget suppresses the exact identities the user
 *    chose — a selected record, or every record of one source — and nothing else; a different
 *    source, a different project, or even a byte-identical copy of the file at another path still
 *    imports in full.
 *
 * `guard(store)` is the production hook for rule three: the M03 importer is a `MemoryStore`
 * consumer, so wrapping the store with the guard is what makes "re-import cannot resurrect this"
 * true without teaching the importer about privacy.
 *
 * Ordering contract: `forget()` condenses derived state on disk, so derived readers built over the
 * same directory must be closed first (or rebuilt afterwards); the returned receipt also reports
 * how many durable rows and state entries went away, so the caller never claims more than happened.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadState, saveState } from '../consolidation/state.js';
import { loadRecordsState, saveRecordsState } from '../records/state.js';
import { PROFILE_DB_FILE, PROJECTS_DIR } from '../store/schema.js';
import type { IngestOptions, IngestResult, MemoryStore, NormalizedBatch, TimelineItem, TimelineQuery } from '../store/types.js';

const TOMBSTONE_VERSION = 1;
const TOMBSTONES_FILE = 'tombstones.json';
const DELETION_DIR = 'deletion';

export type ForgottenIdentity = Readonly<{ sourceId: string; sourceEventIds: readonly string[] }>;

export type ForgetRequest = Readonly<{
  /** Raw event ids to forget, as the readers expose them (`sourceEventIds`). */
  eventIds?: readonly string[];
  /** Whole-source choices: an empty `sourceEventIds` forgets every record of that source. */
  sources?: readonly ForgottenIdentity[];
}>;

export type ForgetReceipt = Readonly<{
  /** Durable rows removed from the store databases. */
  deleted: number;
  /** Derived-state entries (claims, watermarks, corrections) condensed out. */
  condensed: number;
  /** The lineage identities this forget now suppresses, exactly as recorded. */
  forgotten: readonly ForgottenIdentity[];
  /** Project ids whose M02/M04 state files were rewritten. */
  projects: readonly string[];
}>;

export interface MemoryDeletion {
  /** Removes the chosen lineage, condenses derived state and records the tombstones. */
  forget(request: ForgetRequest): Promise<ForgetReceipt>;
  /** Every identity this profile suppresses, newest last. */
  tombstones(): Promise<readonly ForgottenIdentity[]>;
  /** True when this exact (sourceId, sourceEventId) may never be stored again. */
  isSuppressed(identity: Readonly<{ sourceId: string; sourceEventId: string }>): Promise<boolean>;
  /** A `MemoryStore` view whose ingest drops suppressed identities; it never closes the store. */
  guard(store: MemoryStore): MemoryStore;
  close(): Promise<void>;
}

export type CreateMemoryDeletionOptions = Readonly<{
  /** The profile directory holding `profile.db`, `projects/` and the derivation sidecars. */
  directory: string;
  /** Wall clock seam; the tombstone timestamps are the only thing it feeds. */
  now?: () => Date;
}>;

type Row = Record<string, unknown>;

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function changeCount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

/** Opens a store database read/write; the caller closes it. */
function openDatabase(file: string): DatabaseSync {
  return new DatabaseSync(file);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

/** One stored lineage row, read from plaintext routing columns only. */
type LineageRow = Readonly<{ eventId: string; sourceId: string; sourceEventId: string; payloadRef: string }>;

function readLineage(db: DatabaseSync): LineageRow[] {
  const rows = db.prepare('SELECT event_id, source_id, source_event_id, payload_ref FROM events').all() as Row[];
  const lineage: LineageRow[] = [];
  for (const row of rows) {
    const eventId = asText(row.event_id);
    const sourceId = asText(row.source_id);
    const sourceEventId = asText(row.source_event_id);
    const payloadRef = asText(row.payload_ref);
    if (eventId === undefined || sourceId === undefined || sourceEventId === undefined || payloadRef === undefined) continue;
    lineage.push({ eventId, sourceId, sourceEventId, payloadRef });
  }
  return lineage;
}

/** True when the file carries the store's lineage tables; anything else in `projects/` is skipped. */
function isStoreDatabase(db: DatabaseSync): boolean {
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'payloads')").all() as Row[];
    return rows.length === 2;
  } catch {
    return false;
  }
}

function isSelected(row: LineageRow, eventIds: ReadonlySet<string>, sources: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (eventIds.has(row.eventId)) return true;
  const chosen = sources.get(row.sourceId);
  if (chosen === undefined) return false;
  return chosen.size === 0 || chosen.has(row.sourceEventId);
}

/** Removes one event's rows (payload, capsule, decision, task provenance, envelope) and counts them. */
function purgeEvent(db: DatabaseSync, row: LineageRow): number {
  let removed = 0;
  removed += changeCount(db.prepare('DELETE FROM payloads WHERE payload_ref = ? OR event_id = ?').run(row.payloadRef, row.eventId).changes);
  const tasks = db.prepare('SELECT task_key FROM task_observations WHERE event_id = ?').all(row.eventId) as Row[];
  for (const task of tasks) {
    const taskKey = asText(task.task_key);
    if (taskKey === undefined) continue;
    removed += changeCount(db.prepare('DELETE FROM task_records WHERE task_key = ?').run(taskKey).changes);
  }
  for (const table of ['source_capsules', 'decisions', 'task_observations', 'events'] as const) {
    removed += changeCount(db.prepare(`DELETE FROM ${table} WHERE event_id = ?`).run(row.eventId).changes);
  }
  return removed;
}

type DatabaseOutcome = Readonly<{ removed: number; forgotten: readonly LineageRow[] }>;

function purgeDatabase(file: string, eventIds: ReadonlySet<string>, sources: ReadonlyMap<string, ReadonlySet<string>>): DatabaseOutcome {
  const db = openDatabase(file);
  try {
    if (!isStoreDatabase(db)) return { removed: 0, forgotten: [] };
    const selected = readLineage(db).filter((row) => isSelected(row, eventIds, sources));
    if (selected.length === 0) return { removed: 0, forgotten: [] };
    db.exec('BEGIN IMMEDIATE');
    try {
      let removed = 0;
      for (const row of selected) removed += purgeEvent(db, row);
      db.exec('COMMIT');
      return { removed, forgotten: selected };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the transaction is already gone
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

async function storeDatabases(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  const profilePath = join(directory, PROFILE_DB_FILE);
  if (await exists(profilePath)) files.push(profilePath);
  const projectsDir = join(directory, PROJECTS_DIR);
  if (await exists(projectsDir)) {
    for (const entry of (await readdir(projectsDir)).sort()) {
      if (entry.endsWith('.db')) files.push(join(projectsDir, entry));
    }
  }
  return files;
}

type TombstoneLedger = Readonly<{ version: number; entries: readonly (ForgottenIdentity & { forgottenAt: string })[] }>;

type CondensedState = Readonly<{
  projects: readonly string[];
  condensed: number;
}>;

/**
 * Rewrites the M02 consolidation state and the M04 records state without the forgotten lineage.
 * Both are scanned by content (they cite raw event ids), so the profile-scope rows that live in the
 * profile database condense their own state files without any project mapping.
 */
async function condenseDerivedState(directory: string, forgotten: ReadonlySet<string>): Promise<CondensedState> {
  const projects = new Set<string>();
  let condensed = 0;

  const consolidationDir = join(directory, 'consolidation');
  if (await exists(consolidationDir)) {
    for (const entry of (await readdir(consolidationDir)).sort()) {
      if (!entry.endsWith('.m02.json')) continue;
      const projectId = decodeURIComponent(entry.slice(0, -'.m02.json'.length));
      const state = await loadState(directory, projectId);
      const cites = (ids: readonly string[]): boolean => ids.some((id) => forgotten.has(id));
      const facts = state.facts.filter((fact) => !cites(fact.sourceEventIds));
      const decisions = state.decisions.filter((decision) => !cites(decision.sourceEventIds));
      const segments = state.segments.filter((segment) => !cites(segment.eventIds));
      const processedEventIds = state.processedEventIds.filter((id) => !forgotten.has(id));
      const dropped = (state.facts.length - facts.length) + (state.decisions.length - decisions.length)
        + (state.segments.length - segments.length) + (state.processedEventIds.length - processedEventIds.length);
      // The cards are bounded prose derived from the claims, so they are always rebuilt rather than
      // filtered: a card can cite forgotten text without naming the event it came from.
      const hadCards = Object.keys(state.cards).length > 0;
      if (dropped === 0 && !hadCards) continue;
      await saveState(directory, { ...state, facts, decisions, segments, processedEventIds, cards: {} });
      condensed += dropped + (hadCards ? 1 : 0);
      projects.add(projectId);
    }
  }

  const recordsDir = join(directory, 'records');
  if (await exists(recordsDir)) {
    for (const entry of (await readdir(recordsDir)).sort()) {
      if (!entry.endsWith('.m04.json')) continue;
      const projectId = decodeURIComponent(entry.slice(0, -'.m04.json'.length));
      const state = await loadRecordsState(directory, projectId, 'unspecified');
      const corrections = state.corrections.filter((correction) => !forgotten.has(correction.eventId));
      if (corrections.length === state.corrections.length) continue;
      await saveRecordsState(directory, { ...state, corrections });
      condensed += state.corrections.length - corrections.length;
      projects.add(projectId);
    }
  }

  return { projects: [...projects].sort(), condensed };
}

class SqliteMemoryDeletion implements MemoryDeletion {
  private readonly directory: string;
  private readonly now: () => Date;
  private ledger: TombstoneLedger | null = null;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: CreateMemoryDeletionOptions) {
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
  }

  private tombstonePath(): string {
    return join(this.directory, DELETION_DIR, TOMBSTONES_FILE);
  }

  private async loadLedger(): Promise<TombstoneLedger> {
    if (this.ledger !== null) return this.ledger;
    const path = this.tombstonePath();
    if (!(await exists(path))) {
      this.ledger = { version: TOMBSTONE_VERSION, entries: [] };
      return this.ledger;
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; entries?: unknown };
    if (parsed.version !== TOMBSTONE_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error(`memory deletion tombstones in ${path} are not a supported v${TOMBSTONE_VERSION} ledger`);
    }
    const entries: (ForgottenIdentity & { forgottenAt: string })[] = [];
    for (const entry of parsed.entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as { sourceId?: unknown; sourceEventIds?: unknown; forgottenAt?: unknown };
      const sourceId = asText(candidate.sourceId);
      if (sourceId === undefined) continue;
      const sourceEventIds = Array.isArray(candidate.sourceEventIds)
        ? candidate.sourceEventIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      entries.push({ sourceId, sourceEventIds, forgottenAt: asText(candidate.forgottenAt) ?? '' });
    }
    this.ledger = { version: TOMBSTONE_VERSION, entries };
    return this.ledger;
  }

  private async saveLedger(entries: TombstoneLedger['entries']): Promise<void> {
    const path = this.tombstonePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: TOMBSTONE_VERSION, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    this.ledger = { version: TOMBSTONE_VERSION, entries };
  }

  /** Serializes mutations so two forgets cannot interleave their ledger read-modify-write. */
  private serialized<T>(job: () => Promise<T>): Promise<T> {
    const run = this.pending.then(job);
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  async forget(request: ForgetRequest): Promise<ForgetReceipt> {
    const eventIds = new Set<string>((request?.eventIds ?? []).filter((id) => typeof id === 'string' && id.length > 0));
    const sources = new Map<string, ReadonlySet<string>>();
    for (const source of request?.sources ?? []) {
      if (source === null || typeof source !== 'object') continue;
      const sourceId = asText(source.sourceId);
      if (sourceId === undefined || sourceId.length === 0) continue;
      sources.set(sourceId, new Set((source.sourceEventIds ?? []).filter((id) => typeof id === 'string' && id.length > 0)));
    }
    if (eventIds.size === 0 && sources.size === 0) {
      throw new TypeError('memory deletion forget requires at least one eventId or source');
    }

    return this.serialized(async () => {
      let deleted = 0;
      const forgotten = new Map<string, { sourceId: string; sourceEventIds: Set<string> }>();

      // Whole-source selectors may only know the source: resolve every stored record of it first,
      // so the derived state citing those records is condensed even though the caller never named
      // the individual event ids.
      for (const file of await storeDatabases(this.directory)) {
        const outcome = purgeDatabase(file, eventIds, sources);
        deleted += outcome.removed;
        for (const row of outcome.forgotten) {
          const entry = forgotten.get(row.sourceId) ?? { sourceId: row.sourceId, sourceEventIds: new Set<string>() };
          entry.sourceEventIds.add(row.sourceEventId);
          forgotten.set(row.sourceId, entry);
          eventIds.add(row.eventId);
        }
      }

      const condensed = await condenseDerivedState(this.directory, eventIds);

      const ledger = await this.loadLedger();
      const entries = [...ledger.entries];
      const forgottenAt = this.now().toISOString();
      /** Merges one choice into the ledger; a whole-source choice always wins for its source. */
      const recordSource = (sourceId: string, specific: ReadonlySet<string>, wholeSource: boolean): void => {
        const index = entries.findIndex((entry) => entry.sourceId === sourceId);
        const existing = index >= 0 ? entries[index]?.sourceEventIds ?? [] : [];
        // An existing whole-source entry keeps winning: a partial choice made later must never
        // narrow a choice the user already made.
        const whole = wholeSource || (index >= 0 && existing.length === 0);
        const chosen = whole ? [] : [...new Set([...existing, ...specific])].sort();
        const entry = { sourceId, sourceEventIds: chosen, forgottenAt };
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
      };
      // A requested source is recorded even when nothing matched: choosing "forget this source"
      // before its records are imported must still suppress them later.
      for (const [sourceId, requested] of sources) {
        const matched = forgotten.get(sourceId)?.sourceEventIds ?? new Set<string>();
        recordSource(sourceId, new Set([...requested, ...matched]), requested.size === 0);
      }
      for (const [sourceId, matched] of forgotten) {
        if (sources.has(sourceId)) continue;
        recordSource(sourceId, matched.sourceEventIds, false);
      }
      await this.saveLedger(entries);

      const touched = new Set([...sources.keys(), ...forgotten.keys()]);
      return {
        deleted,
        condensed: condensed.condensed,
        forgotten: entries
          .filter((entry) => touched.has(entry.sourceId))
          .map((entry) => ({ sourceId: entry.sourceId, sourceEventIds: [...entry.sourceEventIds].sort() })),
        projects: condensed.projects,
      };
    });
  }

  async tombstones(): Promise<readonly ForgottenIdentity[]> {
    const ledger = await this.loadLedger();
    return ledger.entries.map((entry) => ({ sourceId: entry.sourceId, sourceEventIds: entry.sourceEventIds }));
  }

  async isSuppressed(identity: { sourceId: string; sourceEventId: string }): Promise<boolean> {
    const sourceId = asText(identity?.sourceId);
    const sourceEventId = asText(identity?.sourceEventId);
    if (sourceId === undefined || sourceEventId === undefined) return false;
    const ledger = await this.loadLedger();
    return ledger.entries.some((entry) => entry.sourceId === sourceId
      && (entry.sourceEventIds.length === 0 || entry.sourceEventIds.includes(sourceEventId)));
  }

  guard(store: MemoryStore): MemoryStore {
    if (store === null || typeof store !== 'object' || typeof store.ingest !== 'function') {
      throw new TypeError('memory deletion guard requires a memory store');
    }
    const guard: MemoryStore = {
      ingest: async (batch: NormalizedBatch, options?: IngestOptions): Promise<IngestResult> => {
        // The ledger is read once per batch and matched by exact identity, never by content hash,
        // so suppressing one record can never block a different source (or a copy of it).
        const ledger = await this.loadLedger();
        const kept = batch.events.filter((event) => !ledger.entries.some((entry) => entry.sourceId === event.sourceId
          && (entry.sourceEventIds.length === 0 || entry.sourceEventIds.includes(event.sourceEventId))));
        if (kept.length === batch.events.length) return store.ingest(batch, options);
        const payloadRefs = new Set(kept.map((event) => event.payloadRef));
        const payloads = Object.fromEntries(Object.entries(batch.payloads).filter(([ref]) => payloadRefs.has(ref)));
        return store.ingest({ events: kept, payloads }, options);
      },
      timeline: (query: TimelineQuery): Promise<TimelineItem[]> => store.timeline(query),
      durableCursor: (): Promise<string> => store.durableCursor(),
      // The guard is a view over the owner's store: closing it must never close the store itself.
      close: async (): Promise<void> => undefined,
    };
    return guard;
  }

  async close(): Promise<void> {
    await this.pending;
    this.ledger = null;
  }
}

export async function createMemoryDeletion(options: CreateMemoryDeletionOptions): Promise<MemoryDeletion> {
  if (options === null || typeof options !== 'object') throw new TypeError('createMemoryDeletion requires { directory }');
  const directory = asText(options.directory);
  if (directory === undefined || directory.length === 0) throw new TypeError('createMemoryDeletion requires a directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new SqliteMemoryDeletion({ directory, ...(options.now === undefined ? {} : { now: options.now }) });
}
