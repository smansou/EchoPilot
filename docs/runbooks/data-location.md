# Where EchoPilot keeps your data

EchoPilot is local-first. Everything it creates lives on your Mac unless you explicitly export or
enable a premium request that sends selected context.

## Application Support

Sessions, transcripts, narration records, routing decisions and settings live under
`~/Library/Application Support/EchoPilot/`:

- `sessions/` — per-session transcripts, dictation corrections and narration chapters (SQLite plus
  JSON sidecars).
- `memory/` — the memory database (events, temporally indexed facts, embeddings and source links).
  Memory is rebuilt from the session store when a model or schema changes; nothing is fetched from
  the network to rebuild it.
- `models/` — the verified asset pack unpacked from the installer, keyed by the manifest digest.
- `updates/` — the release store (`versions/`, `staging/`, `current`, `journal.json`,
  `history.json`) that the update and rollback machinery maintains.
- `logs/` — rotating local diagnostic logs, which never contain audio.

## Deleting your data

- **One session** — Session list → context menu → *Delete session*. The transcript, audio scratch
  files and narration are removed and any memory events sourced only from that session are
  retracted.
- **All memory** — **Settings → Memory → Delete all memory**. This removes the memory database and
  derived indexes; sessions remain unless you also delete them.
- **Everything** — quit EchoPilot, then remove `~/Library/Application Support/EchoPilot/`. The next
  launch recreates a clean store and re-verifies the installed model pack from its manifest.
- **Diagnostics** — the support bundle contains logs and permission state only; you can delete it
  from `~/Desktop` after sending it.

Deletion is immediate and local. App uninstall does not remove Application Support automatically —
delete the folder yourself if you want the data gone. Because the store is plain files in that
folder, you can also archive or move it with your normal backup tooling.
