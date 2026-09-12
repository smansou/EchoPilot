/**
 * M01 memory tracer bullet: normalized event -> encrypted store -> restart -> source-backed timeline.
 *
 * Encryption gate: this fork ships no SQLCipher native addon (there is no `better-sqlite3*`
 * dependency and no network access to build a Node-API one), so the encrypted SQLite wrapper is
 * implemented here: every record body (envelope, payload, capsule summary/search text, decision
 * text and actor, and the reduced task provenance including its tool/command/receipt/task
 * identifiers) is sealed with AES-256-GCM under HKDF-derived, domain-separated subkeys before it
 * reaches SQLite. Plaintext columns hold routing metadata only: normalized-envelope ids, kinds,
 * trust levels, timestamps, sequences, scope ids and numeric verdicts that the section 5.8 indexes
 * need. The profile database and each project database therefore hold ciphertext for record
 * content, and opening an existing store with the wrong key fails the stored key check instead of
 * resetting or silently re-initializing the store.
 *
 * Durability: the profile database and every project database are attached to one SQLite
 * connection and all ingest writes (events, payloads, capsules, derived records, source offsets,
 * durable cursor) happen in a single transaction. The default rollback journal is kept so
 * multi-database commit is atomic, and `onBeforeCommit` faults roll the whole batch back.
 *
 * Attach slots: SQLite caps each connection at ten attached databases, so a project database stays
 * attached only while an operation pins it; the least recently used unpinned databases are DETACHed
 * before a new one is attached, and an ingest batch that spans more project databases than one
 * connection can hold fails with a typed MemoryStoreCapacityError instead of a raw SQLite error.
 *
 * First run: init-vs-verify is chosen from the database contents, not from file existence, so a
 * crash between SQLite creating profile.db and the initialization transaction committing cannot
 * brick the directory; anything that holds data without a key check is refused, never reset.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  reduceSourceCapsule,
  reduceTaskObservation,
  reduceTaskRecord,
  type NormalizedEvent,
  type TaskObservation,
  type TaskRecord,
} from '../reducers/index.js';
import { deriveStoreKey, fingerprint, openJson, openText, profileDomain, projectDomain, sealJson, sealValue } from './crypto.js';
import {
  MEMORY_SCHEMA_VERSION,
  PROFILE_DB_FILE,
  PROJECTS_DIR,
  profileSchemaSql,
  profileScopeId,
  projectSchemaSql,
} from './schema.js';
import type {
  CreateMemoryStoreOptions,
  IngestOptions,
  IngestResult,
  MemoryStore,
  NormalizedBatch,
  TimelineItem,
  TimelineQuery,
} from './types.js';

const PROFILE_KEY_CHECK_KIND = 'echopilot-memory-key-check';
const PROJECT_KEY_CHECK_KIND = 'echopilot-memory-project-key-check';
const CURSOR_ID = 'store';
const CURSOR_PREFIX = 'mem-cursor-v1';
/** SQLite's default SQLITE_MAX_ATTACHED cap; the `main` schema occupies one of those slots. */
export const MAX_ATTACHED_DATABASES = 10;
export const MAX_ATTACHED_PROJECTS = MAX_ATTACHED_DATABASES - 1;

/** Raised when one operation needs more simultaneously attached project databases than SQLite holds. */
export class MemoryStoreCapacityError extends Error {
  readonly code = 'MEMORY_STORE_CAPACITY';

  constructor(message: string) {
    super(message);
    this.name = 'MemoryStoreCapacityError';
  }
}

/** Routing key for a task: a fingerprint, so the external task id itself never lands in plaintext. */
function taskRoutingKey(taskId: string): string {
  return fingerprint('task', taskId).slice(0, 32);
}

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;

export interface ProjectBinding {
  projectId: string;
  /** SQLite schema name: `main` for profile-scope records, otherwise an attached project alias. */
  ref: string;
  dbFile: string | null;
  key: Buffer;
  scope: 'profile' | 'project';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'utf8'));
  throw new Error('memory store found a corrupt encrypted value');
}

function tokenize(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
}

function matchesNeedles(text: string, needles: readonly string[]): boolean {
  return needles.every((needle) => text.includes(needle));
}

function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  const elapsed = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (Number.isFinite(elapsed) && elapsed !== 0) return elapsed;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  private readonly profileId: string;
  private readonly masterKey: string;
  private readonly profilePath: string;
  private readonly profileKey: Buffer;
  /** Project databases currently ATTACHed to the single connection, in least-recently-used order. */
  private readonly attached = new Map<string, ProjectBinding>();
  private attachCounter = 0;
  private cursor = '';
  private closed = false;

  constructor(options: CreateMemoryStoreOptions, db: DatabaseSync, profilePath: string, profileKey: Buffer) {
    this.db = db;
    this.directory = options.directory;
    this.profileId = options.profileId;
    this.masterKey = options.key;
    this.profilePath = profilePath;
    this.profileKey = profileKey;
  }

  /** Opens an existing encrypted store; a wrong key must fail here, before any write. */
  verifyExistingProfile(): void {
    this.classifySchema(
      'main',
      'profile_meta',
      this.profileKey,
      `at ${this.profilePath}`,
      (header) => header.kind === PROFILE_KEY_CHECK_KIND && header.profileId === this.profileId,
    );
    const row = this.queryOne('SELECT cursor FROM main.durable_cursor WHERE cursor_id = ?', CURSOR_ID);
    this.cursor = row === undefined ? '' : (asString(row.cursor) ?? '');
  }

  /**
   * Chooses init-vs-verify from the profile database contents instead of from file existence: a
   * first run that crashed after SQLite created profile.db but before the initialization
   * transaction committed leaves an empty database, which is safe to initialize again.
   */
  profileState(): 'fresh' | 'initialized' {
    return this.classifySchema(
      'main',
      'profile_meta',
      this.profileKey,
      `at ${this.profilePath}`,
      (header) => header.kind === PROFILE_KEY_CHECK_KIND && header.profileId === this.profileId,
    );
  }

  initializeProfile(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of profileSchemaSql()) this.db.exec(statement);
      this.writeProfileMeta('schema_version', sealValue(this.profileKey, String(MEMORY_SCHEMA_VERSION)));
      this.writeProfileMeta('profile_id', sealValue(this.profileKey, this.profileId));
      this.writeProfileMeta('key_check', sealJson(this.profileKey, {
        kind: PROFILE_KEY_CHECK_KIND,
        profileId: this.profileId,
        schemaVersion: MEMORY_SCHEMA_VERSION,
      }));
      this.run(
        'INSERT OR REPLACE INTO main.durable_cursor(cursor_id, epoch, cursor, updated_at) VALUES(?, ?, ?, ?)',
        CURSOR_ID,
        0,
        '',
        new Date().toISOString(),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the transaction is already gone
      }
      throw error;
    }
    this.cursor = '';
  }

  async ingest(batch: NormalizedBatch, options?: IngestOptions): Promise<IngestResult> {
    this.assertOpen();
    const events = this.normalizeBatch(batch);
    if (events.length === 0) {
      return { durableCursor: this.cursor, inserted: 0, duplicates: 0 };
    }
    const payloads = batch.payloads ?? {};
    const groups = new Map<string, NormalizedEvent[]>();
    for (const event of events) {
      const projectId = event.scope.projectId ?? profileScopeId(this.profileId);
      const group = groups.get(projectId);
      if (group === undefined) groups.set(projectId, [event]);
      else group.push(event);
    }
    const orderedGroups = [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    // ATTACH cannot run inside a transaction, and every touched project database must be part of
    // the same transaction so the batch commits (or rolls back) as one unit.
    const pinned = new Set(orderedGroups.map(([projectId]) => projectId));
    const projectIds = [...pinned].filter((projectId) => projectId !== profileScopeId(this.profileId));
    if (projectIds.length > MAX_ATTACHED_PROJECTS) {
      throw new MemoryStoreCapacityError(
        `memory store ingest batch spans ${projectIds.length} project databases but one connection can hold `
        + `${MAX_ATTACHED_PROJECTS}; split the batch into smaller per-project batches`,
      );
    }
    const bindings = new Map<string, ProjectBinding>();
    for (const [projectId] of orderedGroups) bindings.set(projectId, await this.ensureProject(projectId, pinned));

    const insertedEventIds: string[] = [];
    let inserted = 0;
    let duplicates = 0;
    let nextCursor: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [projectId, group] of orderedGroups) {
        const binding = bindings.get(projectId);
        if (binding === undefined) throw new Error(`memory store lost the binding for project ${projectId}`);
        const touchedTasks = new Set<string>();
        for (const event of group) {
          if (this.eventAlreadyStored(binding, event)) {
            duplicates += 1;
            continue;
          }
          const taskId = this.insertEvent(binding, event, payloads[event.payloadRef]);
          if (taskId !== null) touchedTasks.add(taskId);
          this.recordSourceOffset(binding, event);
          insertedEventIds.push(event.eventId);
          inserted += 1;
        }
        for (const taskId of touchedTasks) this.refreshTaskRecord(binding, taskId);
      }
      if (options?.onBeforeCommit !== undefined) options.onBeforeCommit();
      if (inserted > 0) nextCursor = this.writeCursor(insertedEventIds);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the transaction is already gone
      }
      throw error;
    }
    if (nextCursor !== null) this.cursor = nextCursor;
    return { durableCursor: this.cursor, inserted, duplicates };
  }

  async timeline(query: TimelineQuery): Promise<TimelineItem[]> {
    this.assertOpen();
    const projectId = asString(query?.projectId);
    if (projectId === undefined || projectId.length === 0) {
      throw new TypeError('timeline requires a projectId');
    }
    const binding = this.readProject(projectId);
    if (binding === null) return [];
    const needles = tokenize(query.text);
    const items: TimelineItem[] = [];

    const capsules = this.query(
      `SELECT capsule_id, event_id, kind, occurred_at, trust, summary, search_text
         FROM ${binding.ref}.source_capsules ORDER BY occurred_at, capsule_id`,
    );
    for (const row of capsules) {
      const summary = this.decryptText(binding, row.summary, 'source capsule');
      const searchText = this.decryptText(binding, row.search_text, 'source capsule search text');
      if (!matchesNeedles(searchText, needles)) continue;
      items.push({
        id: String(row.capsule_id),
        kind: String(row.kind),
        summary,
        sourceEventIds: [String(row.event_id)],
        occurredAt: String(row.occurred_at),
        trust: String(row.trust),
      });
    }

    const tasks = this.query(
      `SELECT task_key, status, occurred_at, record
         FROM ${binding.ref}.task_records ORDER BY occurred_at, task_key`,
    );
    for (const row of tasks) {
      const record = this.decryptJson<TaskRecord>(binding, row.record, 'task record');
      if (!isRecord(record) || typeof record.id !== 'string' || typeof record.summary !== 'string') {
        throw new Error('memory store found a corrupt task record');
      }
      if (!matchesNeedles(record.searchText ?? '', needles)) continue;
      items.push({
        id: record.id,
        kind: 'task',
        summary: record.summary,
        sourceEventIds: Array.isArray(record.sourceEventIds) ? record.sourceEventIds.map((value) => String(value)) : [],
        occurredAt: String(row.occurred_at),
        status: String(row.status),
      });
    }

    items.sort(compareTimelineItems);
    return items;
  }

  async durableCursor(): Promise<string> {
    this.assertOpen();
    return this.cursor;
  }

  async close(): Promise<void> {
    this.closeSync();
  }

  closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---------------------------------------------------------------- ingestion

  private normalizeBatch(batch: NormalizedBatch): NormalizedEvent[] {
    if (!isRecord(batch) || !Array.isArray(batch.events)) {
      throw new TypeError('ingest requires a normalized batch with an events array');
    }
    return batch.events.map((candidate) => this.validateEvent(candidate));
  }

  private validateEvent(candidate: unknown): NormalizedEvent {
    if (!isRecord(candidate)) throw new TypeError('ingest requires normalized section 5.3 event envelopes');
    const event = candidate as unknown as NormalizedEvent;
    for (const field of ['eventId', 'sourceId', 'sourceEventId', 'occurredAt', 'observedAt', 'kind', 'payloadRef', 'contentHash', 'trust'] as const) {
      const value = event[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`normalized event ${String(event.eventId)} is missing ${field}`);
      }
    }
    if (!Number.isFinite(event.sourceSequence) || !Number.isFinite(event.ingestSequence)) {
      throw new TypeError(`normalized event ${event.eventId} has a non-numeric sequence`);
    }
    const scope = event.scope;
    if (!isRecord(scope) || typeof scope.profileId !== 'string') {
      throw new TypeError(`normalized event ${event.eventId} is missing its scope`);
    }
    if (scope.profileId !== this.profileId) {
      throw new Error(`normalized event ${event.eventId} belongs to profile ${scope.profileId}, not ${this.profileId}`);
    }
    return event;
  }

  private eventAlreadyStored(binding: ProjectBinding, event: NormalizedEvent): boolean {
    const row = this.queryOne(
      `SELECT 1 AS present FROM ${binding.ref}.events
        WHERE event_id = ? OR (source_id = ? AND source_event_id = ?) LIMIT 1`,
      event.eventId,
      event.sourceId,
      event.sourceEventId,
    );
    return row !== undefined;
  }

  /** Inserts the envelope, payload and capsule; returns the touched task routing key, if any. */
  private insertEvent(binding: ProjectBinding, event: NormalizedEvent, payload: unknown): string | null {
    const scope = event.scope;
    this.run(
      `INSERT INTO ${binding.ref}.events (
         event_id, source_id, source_event_id, source_sequence, ingest_sequence, occurred_at,
         observed_at, kind, trust, sensitivity, payload_ref, content_hash, worktree_id, session_id, envelope
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.sourceId,
      event.sourceEventId,
      event.sourceSequence,
      event.ingestSequence,
      event.occurredAt,
      event.observedAt,
      event.kind,
      event.trust,
      scope.sensitivity ?? 'normal',
      event.payloadRef,
      event.contentHash,
      scope.worktreeId ?? null,
      scope.sessionId ?? null,
      sealJson(binding.key, event),
    );

    const storedPayload = payload === undefined ? { payloadRef: event.payloadRef } : payload;
    this.run(
      `INSERT OR REPLACE INTO ${binding.ref}.payloads(payload_ref, event_id, content, content_hash) VALUES (?, ?, ?, ?)`,
      event.payloadRef,
      event.eventId,
      sealJson(binding.key, storedPayload),
      event.contentHash,
    );

    const capsule = reduceSourceCapsule(event, payload);
    this.run(
      `INSERT INTO ${binding.ref}.source_capsules(capsule_id, event_id, kind, occurred_at, trust, summary, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      capsule.id,
      event.eventId,
      capsule.kind,
      capsule.occurredAt,
      capsule.trust,
      sealValue(binding.key, capsule.summary),
      sealValue(binding.key, capsule.searchText),
    );

    if (event.kind === 'decision') {
      const record = isRecord(payload) ? payload : {};
      const rationale = asString(record.rationale);
      const decidingActor = asString(record.decidingActor);
      this.run(
        `INSERT OR REPLACE INTO ${binding.ref}.decisions(decision_id, event_id, occurred_at, deciding_actor, question, choice, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.eventId,
        event.eventId,
        event.occurredAt,
        decidingActor === undefined ? null : sealValue(binding.key, decidingActor),
        sealValue(binding.key, asString(record.question) ?? ''),
        sealValue(binding.key, asString(record.choice) ?? ''),
        rationale === undefined ? null : sealValue(binding.key, rationale),
      );
    }

    const observation = reduceTaskObservation(event, payload);
    if (observation === null) return null;
    const taskKey = taskRoutingKey(observation.taskId);
    this.run(
      `INSERT OR REPLACE INTO ${binding.ref}.task_observations(
         observation_id, task_key, event_id, phase, occurred_at, ingest_sequence, observation
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      observation.observationId,
      taskKey,
      observation.eventId,
      observation.phase,
      observation.occurredAt,
      observation.ingestSequence,
      sealJson(binding.key, observation),
    );
    return taskKey;
  }

  private recordSourceOffset(binding: ProjectBinding, event: NormalizedEvent): void {
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO ${binding.ref}.source_offsets(source_id, last_source_sequence, last_ingest_sequence, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         last_source_sequence = MAX(source_offsets.last_source_sequence, excluded.last_source_sequence),
         last_ingest_sequence = MAX(source_offsets.last_ingest_sequence, excluded.last_ingest_sequence),
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
      event.sourceId,
      event.sourceSequence,
      event.ingestSequence,
      event.eventId,
      now,
    );
    this.run(
      `INSERT INTO main.sources(source_id, project_id, last_source_sequence, last_ingest_sequence, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         project_id = excluded.project_id,
         last_source_sequence = MAX(sources.last_source_sequence, excluded.last_source_sequence),
         last_ingest_sequence = MAX(sources.last_ingest_sequence, excluded.last_ingest_sequence),
         updated_at = excluded.updated_at`,
      event.sourceId,
      binding.scope === 'profile' ? profileScopeId(this.profileId) : binding.projectId,
      event.sourceSequence,
      event.ingestSequence,
      now,
    );
  }

  /** Re-reduces a task from its sealed observations; every provenance field stays ciphertext. */
  private refreshTaskRecord(binding: ProjectBinding, taskKey: string): void {
    const rows = this.query(
      `SELECT observation_id, observation FROM ${binding.ref}.task_observations WHERE task_key = ?`,
      taskKey,
    );
    if (rows.length === 0) return;
    const observations = rows.map((row) => this.decryptJson<TaskObservation>(
      binding,
      row.observation,
      'task observation',
    ));
    const record = reduceTaskRecord(observations);
    this.run(
      `INSERT OR REPLACE INTO ${binding.ref}.task_records(task_key, status, occurred_at, record) VALUES (?, ?, ?, ?)`,
      taskKey,
      record.status,
      record.occurredAt,
      sealJson(binding.key, record),
    );
  }

  /** Advances the durable cursor inside the open transaction; the caller commits it. */
  private writeCursor(insertedEventIds: readonly string[]): string {
    const row = this.queryOne('SELECT epoch FROM main.durable_cursor WHERE cursor_id = ?', CURSOR_ID);
    const epoch = asNumber(row?.epoch) ?? 0;
    const nextEpoch = epoch + 1;
    const digest = fingerprint(...[...insertedEventIds].sort());
    const cursor = `${CURSOR_PREFIX}:${nextEpoch}:${digest.slice(0, 24)}`;
    this.run(
      'UPDATE main.durable_cursor SET epoch = ?, cursor = ?, updated_at = ? WHERE cursor_id = ?',
      nextEpoch,
      cursor,
      new Date().toISOString(),
      CURSOR_ID,
    );
    return cursor;
  }

  // ------------------------------------------------------------------ projects

  /**
   * Attaches (and lazily initializes) the database for one project. `pinned` names every project the
   * running operation needs at once, so eviction only ever drops databases this operation is done
   * with; SQLite's attach budget is respected before the ATTACH is attempted.
   */
  private async ensureProject(projectId: string, pinned: ReadonlySet<string>): Promise<ProjectBinding> {
    const cached = this.attached.get(projectId);
    if (cached !== undefined) {
      this.touch(projectId);
      return cached;
    }
    if (projectId === profileScopeId(this.profileId)) return this.profileBinding();

    const row = this.queryOne('SELECT db_file FROM main.project_registry WHERE project_id = ?', projectId);
    const registeredFile = row === undefined ? undefined : asString(row.db_file);
    const dbFile = registeredFile ?? this.newProjectFile(projectId);
    const key = deriveStoreKey(this.masterKey, projectDomain(this.profileId, projectId));
    await mkdir(join(this.directory, PROJECTS_DIR), { recursive: true, mode: 0o700 });
    this.freeAttachSlots(pinned);
    const ref = this.attachDatabase(dbFile);
    try {
      const state = this.classifySchema(
        ref,
        'project_meta',
        key,
        `project database for ${projectId}`,
        (header) => header.kind === PROJECT_KEY_CHECK_KIND
          && header.profileId === this.profileId
          && header.projectId === projectId,
      );
      for (const statement of projectSchemaSql(ref)) this.db.exec(statement);
      if (state === 'fresh') {
        this.run(
          `INSERT OR REPLACE INTO ${ref}.project_meta(key, value) VALUES (?, ?)`,
          'key_check',
          sealJson(key, { kind: PROJECT_KEY_CHECK_KIND, profileId: this.profileId, projectId, schemaVersion: MEMORY_SCHEMA_VERSION }),
        );
      }
      if (this.readProjectMeta(ref, 'schema_version') === undefined) {
        this.run(
          `INSERT OR REPLACE INTO ${ref}.project_meta(key, value) VALUES (?, ?)`,
          'schema_version',
          sealValue(key, String(MEMORY_SCHEMA_VERSION)),
        );
      }
      if (registeredFile === undefined) {
        this.run(
          'INSERT INTO main.project_registry(project_id, db_file, created_at) VALUES (?, ?, ?)',
          projectId,
          dbFile,
          new Date().toISOString(),
        );
      }
      const binding: ProjectBinding = { projectId, ref, dbFile, key, scope: 'project' };
      this.attached.set(projectId, binding);
      return binding;
    } catch (error) {
      this.detachRef(projectId, ref);
      throw error;
    }
  }

  /** Read path: never creates a database, so a query cannot mutate durable state. */
  private readProject(projectId: string): ProjectBinding | null {
    const cached = this.attached.get(projectId);
    if (cached !== undefined) {
      this.touch(projectId);
      return cached;
    }
    if (projectId === profileScopeId(this.profileId)) return this.profileBinding();
    const row = this.queryOne('SELECT db_file FROM main.project_registry WHERE project_id = ?', projectId);
    const dbFile = row === undefined ? undefined : asString(row.db_file);
    if (dbFile === undefined) return null;
    if (!existsSync(join(this.directory, PROJECTS_DIR, dbFile))) return null;
    const key = deriveStoreKey(this.masterKey, projectDomain(this.profileId, projectId));
    this.freeAttachSlots(new Set([projectId]));
    const ref = this.attachDatabase(dbFile);
    let state: 'fresh' | 'initialized';
    try {
      state = this.classifySchema(
        ref,
        'project_meta',
        key,
        `project database for ${projectId}`,
        (header) => header.kind === PROJECT_KEY_CHECK_KIND
          && header.profileId === this.profileId
          && header.projectId === projectId,
      );
    } catch (error) {
      this.detachRef(projectId, ref);
      throw error;
    }
    if (state === 'fresh') {
      this.detachRef(projectId, ref);
      return null;
    }
    const binding: ProjectBinding = { projectId, ref, dbFile, key, scope: 'project' };
    this.attached.set(projectId, binding);
    return binding;
  }

  /** Moves a binding to the most-recently-used end so eviction drops the coldest database first. */
  private touch(projectId: string): void {
    const binding = this.attached.get(projectId);
    if (binding === undefined) return;
    this.attached.delete(projectId);
    this.attached.set(projectId, binding);
  }

  private attachedProjectCount(): number {
    let count = 0;
    for (const binding of this.attached.values()) if (binding.scope === 'project') count += 1;
    return count;
  }

  /** DETACHes least-recently-used project databases until the next ATTACH fits SQLite's budget. */
  private freeAttachSlots(pinned: ReadonlySet<string>): void {
    while (this.attachedProjectCount() >= MAX_ATTACHED_PROJECTS) {
      const victim = [...this.attached.values()].find(
        (binding) => binding.scope === 'project' && !pinned.has(binding.projectId),
      );
      if (victim === undefined) {
        throw new MemoryStoreCapacityError(
          `memory store cannot attach a project database while ${this.attachedProjectCount()} pinned project databases `
          + `are attached; SQLite allows ${MAX_ATTACHED_PROJECTS} at once`,
        );
      }
      this.detach(victim);
    }
  }

  private detach(binding: ProjectBinding): void {
    this.detachRef(binding.projectId, binding.ref);
  }

  private detachRef(projectId: string, ref: string): void {
    this.attached.delete(projectId);
    this.db.exec(`DETACH DATABASE ${ref}`);
  }

  private attachDatabase(dbFile: string): string {
    const ref = `p${this.attachCounter}`;
    this.attachCounter += 1;
    try {
      this.db.prepare(`ATTACH DATABASE ? AS ${ref}`).run(join(this.directory, PROJECTS_DIR, dbFile));
    } catch (error) {
      if (/too many attached databases/i.test(String((error as Error).message))) {
        throw new MemoryStoreCapacityError(
          `memory store hit SQLite's limit of ${MAX_ATTACHED_PROJECTS} attached project databases; `
          + 'split the operation into smaller batches',
        );
      }
      throw error;
    }
    return ref;
  }

  private profileBinding(): ProjectBinding {
    const existing = this.attached.get(profileScopeId(this.profileId));
    if (existing !== undefined) return existing;
    const binding: ProjectBinding = {
      projectId: profileScopeId(this.profileId),
      ref: 'main',
      dbFile: null,
      key: this.profileKey,
      scope: 'profile',
    };
    this.attached.set(binding.projectId, binding);
    return binding;
  }

  private newProjectFile(projectId: string): string {
    const slug = projectId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const digest = fingerprint(this.profileId, projectId).slice(0, 12);
    return `${slug.length === 0 ? 'project' : slug}-${digest}.db`;
  }

  // -------------------------------------------------------------------- sqlite

  /**
   * Classifies a database before init-vs-verify is chosen, using its contents: an empty schema is
   * fresh (a first run that crashed before its initialization transaction committed), a sealed key
   * check makes it initialized, and rows without a usable key check mean damaged - never reset.
   */
  private classifySchema(
    ref: string,
    metaTable: 'profile_meta' | 'project_meta',
    key: Buffer,
    label: string,
    validateKeyCheck: (header: Record<string, unknown>) => boolean,
  ): 'fresh' | 'initialized' {
    let tables: Row[];
    try {
      tables = this.query(`SELECT name FROM ${ref}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    } catch (error) {
      throw new Error(`memory store ${label} is not a readable SQLite database: ${(error as Error).message}`);
    }
    if (tables.length === 0) return 'fresh';
    if (!tables.some((row) => String(row.name) === metaTable)) {
      throw new Error(`memory store ${label} is damaged: it holds records but no ${metaTable} (refusing to re-initialize)`);
    }
    const check = this.readMeta(ref, metaTable, 'key_check');
    if (check === undefined) {
      for (const table of tables) {
        const name = String(table.name).replace(/"/g, '""');
        const count = this.queryOne(`SELECT COUNT(*) AS count FROM ${ref}."${name}"`);
        if ((asNumber(count?.count) ?? 0) > 0) {
          throw new Error(`memory store ${label} is damaged: it holds records but no key check (refusing to re-initialize)`);
        }
      }
      return 'fresh';
    }
    let header: unknown;
    try {
      header = openJson<unknown>(key, check);
    } catch {
      throw new Error(`memory store ${label} could not be decrypted with the provided key (wrong key or damaged store)`);
    }
    if (!isRecord(header) || !validateKeyCheck(header)) {
      throw new Error(`memory store ${label} failed its key check`);
    }
    const version = this.readMeta(ref, metaTable, 'schema_version');
    if (version !== undefined) {
      let decoded: string;
      try {
        decoded = openText(key, version);
      } catch {
        throw new Error(`memory store ${label} could not be decrypted with the provided key (wrong key or damaged store)`);
      }
      if (decoded !== String(MEMORY_SCHEMA_VERSION)) {
        throw new Error(`memory store ${label} uses schema version ${decoded}, which is not supported by this build`);
      }
    }
    return 'initialized';
  }

  private readMeta(ref: string, metaTable: 'profile_meta' | 'project_meta', metaKey: string): Uint8Array | undefined {
    try {
      const row = this.queryOne(`SELECT value FROM ${ref}.${metaTable} WHERE key = ?`, metaKey);
      return row === undefined ? undefined : toBytes(row.value);
    } catch {
      return undefined;
    }
  }

  private writeProfileMeta(metaKey: string, value: Uint8Array): void {
    this.run('INSERT OR REPLACE INTO main.profile_meta(key, value) VALUES (?, ?)', metaKey, value);
  }

  private readProjectMeta(ref: string, metaKey: string): Uint8Array | undefined {
    return this.readMeta(ref, 'project_meta', metaKey);
  }

  private decryptText(binding: ProjectBinding, value: unknown, label: string): string {
    try {
      return openText(binding.key, toBytes(value));
    } catch {
      throw new Error(`memory store could not decrypt ${label}; the store is damaged or the key is wrong`);
    }
  }

  private decryptJson<T>(binding: ProjectBinding, value: unknown, label: string): T {
    try {
      return openJson<T>(binding.key, toBytes(value));
    } catch {
      throw new Error(`memory store could not decrypt ${label}; the store is damaged or the key is wrong`);
    }
  }

  private query(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as unknown as Row[];
  }

  private queryOne(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as unknown as Row | undefined;
  }

  private run(sql: string, ...params: SqlValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory store is closed');
  }
}

export async function createMemoryStore(options: CreateMemoryStoreOptions): Promise<MemoryStore> {
  if (!isRecord(options)) throw new TypeError('createMemoryStore requires { directory, key, profileId }');
  const directory = asString(options.directory);
  const key = asString(options.key);
  const profileId = asString(options.profileId);
  if (directory === undefined || directory.length === 0) throw new TypeError('createMemoryStore requires a directory');
  if (key === undefined || key.length === 0) throw new TypeError('createMemoryStore requires key material');
  if (profileId === undefined || profileId.length === 0) throw new TypeError('createMemoryStore requires a profileId');

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const profilePath = join(directory, PROFILE_DB_FILE);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(profilePath);
  } catch (error) {
    throw new Error(`memory store could not open ${profilePath}: ${(error as Error).message}`);
  }

  const store = new SqliteMemoryStore({ directory, key, profileId }, db, profilePath, deriveStoreKey(key, profileDomain(profileId)));
  try {
    // Init-vs-verify is content-based: a crashed first run leaves an empty profile.db, which must
    // initialize again instead of failing its key check forever.
    if (store.profileState() === 'initialized') store.verifyExistingProfile();
    else store.initializeProfile();
  } catch (error) {
    store.closeSync();
    throw error;
  }
  return store;
}

export type {
  CreateMemoryStoreOptions,
  IngestOptions,
  IngestResult,
  MemoryStore,
  NormalizedBatch,
  TimelineItem,
  TimelineQuery,
} from './types.js';
