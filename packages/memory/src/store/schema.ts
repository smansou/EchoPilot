/**
 * Essential section 5.8 tables/indexes for the profile database and each project database.
 * Record bodies live in BLOB columns that only ever receive sealed envelopes; plaintext columns
 * hold routing metadata (ids, kinds, timestamps, sequences) needed to index and page records.
 */

export const MEMORY_SCHEMA_VERSION = 1;
export const PROFILE_DB_FILE = 'profile.db';
export const PROJECTS_DIR = 'projects';

/** Records without an explicit project scope live in the profile database itself. */
export function profileScopeId(profileId: string): string {
  return `profile:${profileId}`;
}

function assertSchemaRef(ref: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    throw new Error(`memory store received an invalid database reference: ${ref}`);
  }
}

export function recordSchemaSql(ref: string): string[] {
  assertSchemaRef(ref);
  return [
    `CREATE TABLE IF NOT EXISTS ${ref}.events (
       event_id TEXT PRIMARY KEY,
       source_id TEXT NOT NULL,
       source_event_id TEXT NOT NULL,
       source_sequence INTEGER NOT NULL,
       ingest_sequence INTEGER NOT NULL,
       occurred_at TEXT NOT NULL,
       observed_at TEXT NOT NULL,
       kind TEXT NOT NULL,
       trust TEXT NOT NULL,
       sensitivity TEXT NOT NULL,
       payload_ref TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       worktree_id TEXT,
       session_id TEXT,
       envelope BLOB NOT NULL,
       UNIQUE (source_id, source_event_id)
     )`,
    `CREATE INDEX IF NOT EXISTS ${ref}.idx_events_occurred ON events (occurred_at)`,
    `CREATE INDEX IF NOT EXISTS ${ref}.idx_events_kind ON events (kind)`,
    `CREATE TABLE IF NOT EXISTS ${ref}.payloads (
       payload_ref TEXT PRIMARY KEY,
       event_id TEXT NOT NULL,
       content BLOB NOT NULL,
       content_hash TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS ${ref}.idx_payloads_event ON payloads (event_id)`,
    `CREATE TABLE IF NOT EXISTS ${ref}.source_capsules (
       capsule_id TEXT PRIMARY KEY,
       event_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       occurred_at TEXT NOT NULL,
       trust TEXT NOT NULL,
       summary BLOB NOT NULL,
       search_text BLOB NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS ${ref}.idx_capsules_occurred ON source_capsules (occurred_at)`,
    `CREATE TABLE IF NOT EXISTS ${ref}.decisions (
       decision_id TEXT PRIMARY KEY,
       event_id TEXT NOT NULL,
       occurred_at TEXT NOT NULL,
       deciding_actor TEXT,
       question BLOB NOT NULL,
       choice BLOB NOT NULL,
       rationale BLOB
     )`,
    `CREATE TABLE IF NOT EXISTS ${ref}.task_observations (
       observation_id TEXT PRIMARY KEY,
       task_id TEXT NOT NULL,
       event_id TEXT NOT NULL,
       phase TEXT NOT NULL,
       tool TEXT,
       command TEXT,
       title TEXT,
       exit_code INTEGER,
       receipt_id TEXT,
       occurred_at TEXT NOT NULL,
       ingest_sequence INTEGER NOT NULL,
       UNIQUE (event_id, phase)
     )`,
    `CREATE INDEX IF NOT EXISTS ${ref}.idx_task_observations_task ON task_observations (task_id)`,
    `CREATE TABLE IF NOT EXISTS ${ref}.task_records (
       task_id TEXT PRIMARY KEY,
       status TEXT NOT NULL,
       occurred_at TEXT NOT NULL,
       latest_receipt_id TEXT,
       summary BLOB NOT NULL,
       search_text BLOB NOT NULL,
       source_event_ids BLOB NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS ${ref}.idx_task_records_occurred ON task_records (occurred_at)`,
    `CREATE TABLE IF NOT EXISTS ${ref}.source_offsets (
       source_id TEXT PRIMARY KEY,
       last_source_sequence INTEGER NOT NULL,
       last_ingest_sequence INTEGER NOT NULL,
       last_event_id TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  ];
}

export function profileSchemaSql(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS main.profile_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS main.durable_cursor (
       cursor_id TEXT PRIMARY KEY,
       epoch INTEGER NOT NULL,
       cursor TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS main.sources (
       source_id TEXT PRIMARY KEY,
       project_id TEXT,
       last_source_sequence INTEGER NOT NULL,
       last_ingest_sequence INTEGER NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS main.project_registry (
       project_id TEXT PRIMARY KEY,
       db_file TEXT NOT NULL UNIQUE,
       created_at TEXT NOT NULL
     )`,
    ...recordSchemaSql('main'),
  ];
}

export function projectSchemaSql(ref: string): string[] {
  assertSchemaRef(ref);
  return [
    `CREATE TABLE IF NOT EXISTS ${ref}.project_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)`,
    ...recordSchemaSql(ref),
  ];
}
