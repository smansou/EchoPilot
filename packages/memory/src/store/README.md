# Encrypted memory store (M01 tracer bullet)

`createMemoryStore({ directory, key, profileId })` keeps every durable byte inside `directory`:

- `profile.db` — profile registry (key check, durable cursor, sources, project registry) and the
  records of profile-scoped events.
- `projects/<slug>-<fingerprint>.db` — one database per project; queries are served from that
  database only, so a timeline can never cross project boundaries.

## Encryption gate

This fork has no SQLCipher native addon available (no `better-sqlite3*` dependency and no network
access to build one), so the encrypted SQLite wrapper is implemented in `index.ts` + `crypto.ts`:
envelopes, payloads, capsule summaries/search text, decision text and actor, and the reduced task
provenance (external task id, tool, command, title, receipt id, summary) are sealed with
AES-256-GCM under HKDF-derived, domain-separated subkeys before they reach SQLite. Payload-derived
values never appear in a plaintext column: task observations and task records are stored as sealed
BLOBs under a fingerprinted `task_key` routing column, and the only plaintext columns anywhere are
normalized-envelope routing metadata (ids, kinds, trust levels, timestamps, sequences, scope ids)
plus numeric verdicts. Lexical matching therefore runs over decrypted text in memory instead of a
plaintext FTS index.

The profile database stores a sealed key check: opening an existing store with a wrong key fails
before any write, and the store is never reset or silently re-initialized.

## Attach slots and first-run recovery

SQLite allows ten attached databases per connection, so project databases are attached lazily and
only while an operation pins them: the least recently used unpinned databases are `DETACH`ed before
a new one is attached, which keeps every project reachable on one long-lived connection. An ingest
batch that spans more project databases than one connection can hold (more than nine) fails with a
typed `MemoryStoreCapacityError` (`code: 'MEMORY_STORE_CAPACITY'`) instead of a raw SQLite error.

Init-vs-verify is chosen from the profile database contents, not from `profile.db` existing: a
first run that crashes before its initialization transaction commits leaves an empty database that
initializes again on the next open, while a database that holds rows without a usable key check is
reported as damaged and never reset. A store written by an older record layout is refused with an
explicit schema-version error instead of being opened or reset.

## Durability

The profile database and the touched project databases share one SQLite connection. Ingest writes
events, payloads, capsules, derived task records, source offsets and the durable cursor in a single
transaction over the default rollback journal, so multi-database commit stays atomic; a throw from
`options.onBeforeCommit` rolls the whole batch back and the durable cursor keeps its previous value.
