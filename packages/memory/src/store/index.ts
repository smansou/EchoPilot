/**
 * M01 memory tracer bullet: normalized event -> encrypted store -> restart -> source-backed timeline.
 *
 * Encryption gate: this fork ships no SQLCipher native addon (there is no `better-sqlite3*`
 * dependency and no network access to build a Node-API one), so the encrypted SQLite wrapper is
 * implemented here: every record body (envelope, payload, capsule summary/search text, decision
 * text, derived task provenance) is sealed with AES-256-GCM under HKDF-derived, domain-separated
 * subkeys before it reaches SQLite. The profile database and each project database therefore hold
 * ciphertext for record content, and opening an existing store with the wrong key fails the stored
 * key check instead of resetting or silently re-initializing the store.
 *
 * Durability: the profile database and every project database are attached to one SQLite
 * connection and all ingest writes (events, payloads, capsules, derived records, source offsets,
 * durable cursor) happen in a single transaction. The default rollback journal is kept so
 * multi-database commit is atomic, and `onBeforeCommit` faults roll the whole batch back.
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
  private readonly bindings = new Map<string, ProjectBinding>();
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
    const check = this.readProfileMeta('key_check');
    if (check === undefined) {
      throw new Error(`memory store at ${this.profilePath} is not an echopilot memory store (missing key check)`);
    }
    let header: unknown;
    try {
      header = openJson<unknown>(this.profileKey, check);
    } catch {
      throw new Error(`memory store at ${this.profilePath} could not be decrypted with the provided key (wrong key or damaged store)`);
    }
    if (!isRecord(header) || header.kind !== PROFILE_KEY_CHECK_KIND || header.profileId !== this.profileId) {
      throw new Error(`memory store key check does not match profile ${this.profileId}`);
    }
    const version = this.readProfileMeta('schema_version');
    if (version !== undefined) {
      let decoded: string;
      try {
        decoded = openText(this.profileKey, version);
      } catch {
        throw new Error(`memory store at ${this.profilePath} could not be decrypted with the provided key (wrong key or damaged store)`);
      }
      if (decoded !== String(MEMORY_SCHEMA_VERSION)) {
        throw new Error(`memory store schema version ${decoded} is not supported by this build`);
      }
    }
    const row = this.queryOne('SELECT cursor FROM main.durable_cursor WHERE cursor_id = ?', CURSOR_ID);
    this.cursor = row === undefined ? '' : (asString(row.cursor) ?? '');
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
    const bindings = new Map<string, ProjectBinding>();
    for (const [projectId] of orderedGroups) bindings.set(projectId, await this.ensureProject(projectId));

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
      `SELECT task_id, status, occurred_at, summary, search_text, source_event_ids
         FROM ${binding.ref}.task_records ORDER BY occurred_at, task_id`,
    );
    for (const row of tasks) {
      const summary = this.decryptText(binding, row.summary, 'task summary');
      const searchText = this.decryptText(binding, row.search_text, 'task search text');
      if (!matchesNeedles(searchText, needles)) continue;
      const sourceEventIds = this.decryptJson<unknown>(binding, row.source_event_ids, 'task source events');
      items.push({
        id: String(row.task_id),
        kind: 'task',
        summary,
        sourceEventIds: Array.isArray(sourceEventIds) ? sourceEventIds.map((value) => String(value)) : [],
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

  /** Inserts the envelope, payload and capsule; returns the touched task id, if any. */
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
      this.run(
        `INSERT OR REPLACE INTO ${binding.ref}.decisions(decision_id, event_id, occurred_at, deciding_actor, question, choice, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.eventId,
        event.eventId,
        event.occurredAt,
        asString(record.decidingActor) ?? null,
        sealValue(binding.key, asString(record.question) ?? ''),
        sealValue(binding.key, asString(record.choice) ?? ''),
        rationale === undefined ? null : sealValue(binding.key, rationale),
      );
    }

    const observation = reduceTaskObservation(event, payload);
    if (observation === null) return null;
    this.run(
      `INSERT OR REPLACE INTO ${binding.ref}.task_observations(
         observation_id, task_id, event_id, phase, tool, command, title, exit_code, receipt_id, occurred_at, ingest_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      observation.observationId,
      observation.taskId,
      observation.eventId,
      observation.phase,
      observation.tool ?? null,
      observation.command ?? null,
      observation.title ?? null,
      observation.exitCode ?? null,
      observation.receiptId ?? null,
      observation.occurredAt,
      observation.ingestSequence,
    );
    return observation.taskId;
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

  private refreshTaskRecord(binding: ProjectBinding, taskId: string): void {
    const rows = this.query(
      `SELECT observation_id, task_id, event_id, phase, tool, command, title, exit_code, receipt_id, occurred_at, ingest_sequence
         FROM ${binding.ref}.task_observations WHERE task_id = ?`,
      taskId,
    );
    if (rows.length === 0) return;
    const record = reduceTaskRecord(rows.map((row) => this.rowToTaskObservation(row)));
    this.run(
      `INSERT OR REPLACE INTO ${binding.ref}.task_records(
         task_id, status, occurred_at, latest_receipt_id, summary, search_text, source_event_ids
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.status,
      record.occurredAt,
      record.latestReceiptId ?? null,
      sealValue(binding.key, record.summary),
      sealValue(binding.key, record.searchText),
      sealJson(binding.key, record.sourceEventIds),
    );
  }

  private rowToTaskObservation(row: Row): TaskObservation {
    const tool = asString(row.tool);
    const command = asString(row.command);
    const title = asString(row.title);
    const receiptId = asString(row.receipt_id);
    const exitCode = asNumber(row.exit_code);
    return {
      observationId: String(row.observation_id),
      taskId: String(row.task_id),
      eventId: String(row.event_id),
      phase: row.phase === 'started' ? 'started' : 'completed',
      occurredAt: String(row.occurred_at),
      ingestSequence: asNumber(row.ingest_sequence) ?? 0,
      ...(tool === undefined ? {} : { tool }),
      ...(command === undefined ? {} : { command }),
      ...(title === undefined ? {} : { title }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(receiptId === undefined ? {} : { receiptId }),
    };
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

  private async ensureProject(projectId: string): Promise<ProjectBinding> {
    const cached = this.bindings.get(projectId);
    if (cached !== undefined) return cached;
    if (projectId === profileScopeId(this.profileId)) return this.profileBinding();

    const row = this.queryOne('SELECT db_file FROM main.project_registry WHERE project_id = ?', projectId);
    const registeredFile = row === undefined ? undefined : asString(row.db_file);
    const dbFile = registeredFile ?? this.newProjectFile(projectId);
    const ref = `p${this.attachCounter}`;
    this.attachCounter += 1;
    await mkdir(join(this.directory, PROJECTS_DIR), { recursive: true, mode: 0o700 });
    this.db.prepare(`ATTACH DATABASE ? AS ${ref}`).run(join(this.directory, PROJECTS_DIR, dbFile));
    for (const statement of projectSchemaSql(ref)) this.db.exec(statement);

    const key = deriveStoreKey(this.masterKey, projectDomain(this.profileId, projectId));
    const check = this.readProjectMeta(ref, 'key_check');
    if (check === undefined) {
      this.run(
        `INSERT OR REPLACE INTO ${ref}.project_meta(key, value) VALUES (?, ?)`,
        'key_check',
        sealJson(key, { kind: PROJECT_KEY_CHECK_KIND, profileId: this.profileId, projectId, schemaVersion: MEMORY_SCHEMA_VERSION }),
      );
      this.run(
        `INSERT OR REPLACE INTO ${ref}.project_meta(key, value) VALUES (?, ?)`,
        'schema_version',
        sealValue(key, String(MEMORY_SCHEMA_VERSION)),
      );
    } else {
      let header: unknown;
      try {
        header = openJson<unknown>(key, check);
      } catch {
        throw new Error(`memory store project database for ${projectId} could not be decrypted with the provided key`);
      }
      if (!isRecord(header) || header.kind !== PROJECT_KEY_CHECK_KIND || header.projectId !== projectId) {
        throw new Error(`memory store project database for ${projectId} failed its key check`);
      }
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
    this.bindings.set(projectId, binding);
    return binding;
  }

  /** Read path: never creates a database, so a query cannot mutate durable state. */
  private readProject(projectId: string): ProjectBinding | null {
    const cached = this.bindings.get(projectId);
    if (cached !== undefined) return cached;
    if (projectId === profileScopeId(this.profileId)) return this.profileBinding();
    const row = this.queryOne('SELECT db_file FROM main.project_registry WHERE project_id = ?', projectId);
    const dbFile = row === undefined ? undefined : asString(row.db_file);
    if (dbFile === undefined) return null;
    if (!existsSync(join(this.directory, PROJECTS_DIR, dbFile))) return null;
    const ref = `p${this.attachCounter}`;
    this.attachCounter += 1;
    this.db.prepare(`ATTACH DATABASE ? AS ${ref}`).run(join(this.directory, PROJECTS_DIR, dbFile));
    if (this.readProjectMeta(ref, 'key_check') === undefined) return null;
    const key = deriveStoreKey(this.masterKey, projectDomain(this.profileId, projectId));
    const binding: ProjectBinding = { projectId, ref, dbFile, key, scope: 'project' };
    this.bindings.set(projectId, binding);
    return binding;
  }

  private profileBinding(): ProjectBinding {
    const existing = this.bindings.get(profileScopeId(this.profileId));
    if (existing !== undefined) return existing;
    const binding: ProjectBinding = {
      projectId: profileScopeId(this.profileId),
      ref: 'main',
      dbFile: null,
      key: this.profileKey,
      scope: 'profile',
    };
    this.bindings.set(binding.projectId, binding);
    return binding;
  }

  private newProjectFile(projectId: string): string {
    const slug = projectId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const digest = fingerprint(this.profileId, projectId).slice(0, 12);
    return `${slug.length === 0 ? 'project' : slug}-${digest}.db`;
  }

  // -------------------------------------------------------------------- sqlite

  private readProfileMeta(metaKey: string): Uint8Array | undefined {
    try {
      const row = this.queryOne('SELECT value FROM main.profile_meta WHERE key = ?', metaKey);
      return row === undefined ? undefined : toBytes(row.value);
    } catch {
      return undefined;
    }
  }

  private writeProfileMeta(metaKey: string, value: Uint8Array): void {
    this.run('INSERT OR REPLACE INTO main.profile_meta(key, value) VALUES (?, ?)', metaKey, value);
  }

  private readProjectMeta(ref: string, metaKey: string): Uint8Array | undefined {
    try {
      const row = this.queryOne(`SELECT value FROM ${ref}.project_meta WHERE key = ?`, metaKey);
      return row === undefined ? undefined : toBytes(row.value);
    } catch {
      return undefined;
    }
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
  const existing = existsSync(profilePath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(profilePath);
  } catch (error) {
    throw new Error(`memory store could not open ${profilePath}: ${(error as Error).message}`);
  }

  const store = new SqliteMemoryStore({ directory, key, profileId }, db, profilePath, deriveStoreKey(key, profileDomain(profileId)));
  try {
    if (existing) store.verifyExistingProfile();
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
