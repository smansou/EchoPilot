# Encrypted memory store (M01 tracer bullet)

`createMemoryStore({ directory, key, profileId })` keeps every durable byte inside `directory`:

- `profile.db` — profile registry (key check, durable cursor, sources, project registry) and the
  records of profile-scoped events.
- `projects/<slug>-<fingerprint>.db` — one database per project; queries are served from that
  database only, so a timeline can never cross project boundaries.

## Encryption gate

This fork has no SQLCipher native addon available (no `better-sqlite3*` dependency and no network
access to build one), so the encrypted SQLite wrapper is implemented in `index.ts` + `crypto.ts`:
envelopes, payloads, capsule summaries/search text, decision text and derived task provenance are
sealed with AES-256-GCM under HKDF-derived, domain-separated subkeys before they reach SQLite.
Lexical matching therefore runs over decrypted text in memory instead of a plaintext FTS index.

The profile database stores a sealed key check: opening an existing store with a wrong key fails
before any write, and the store is never reset or silently re-initialized.

## Durability

The profile database and the touched project databases share one SQLite connection. Ingest writes
events, payloads, capsules, derived task records, source offsets and the durable cursor in a single
transaction over the default rollback journal, so multi-database commit stays atomic; a throw from
`options.onBeforeCommit` rolls the whole batch back and the durable cursor keeps its previous value.
