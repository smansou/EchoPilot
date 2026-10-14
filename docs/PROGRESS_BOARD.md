# EchoPilot progress board (local, read-only)

A local Signal Room board that shows **recorded task state** for EchoPilot. It runs
only on your machine, only on `127.0.0.1`, and it never writes to the state file.

```bash
node scripts/progress-board.mjs      # serve http://127.0.0.1:8790
node scripts/progress-task.mjs --id voice-live --phase verify -- pnpm --filter @echopilot/voice test
```

## What the board is (and is not)

- It shows **tasks recorded** in `docs/progress-state.json`, written by the wrapper below.
- It is **not** a discovery of all feature completeness: a task name with a passing slice
  does not mean the whole capability is verified.
- There is **no invented overall completion percentage**; only per-column counts.
- The **tracked task active** badge means a wrapped `progress-task.mjs` run is currently
  executing; it does not track unwrapped orchestration or sessions started outside the
  wrapper.
- Human and visual acceptance still requires review of the actual behavior.
- Work does **not** continue after the orchestrator stops; nothing here schedules or
  restarts runs, and there is no autonomous loop.
- `docs/progress-state.json` asserts `releaseReady: false`: the app is not release-ready.

## Columns (stages)

| Stage | Meaning |
| --- | --- |
| Backlog | Recorded, not yet exercised |
| In progress | An implementation run is executing (or was interrupted) |
| Review | Work exists but needs code/visual/human review; a passing implementation run lands here, never in Verified |
| Verified | A `--phase verify` run exited 0 **for that specific task only** |
| Blocked | A run failed, or a dependency is missing; stays blocked until resolved |

## Wrapper semantics

```bash
node scripts/progress-task.mjs --id ID --phase implement|verify -- COMMAND [ARGS...]
```

- The child process is executed with **inherited stdio**; redirect the worker transcript
  in the calling shell if you want one. The wrapper never captures, stores, or renders logs.
- It records lifecycle start/end timestamps, phase, exit code, and the wrapper PID.
- Outcome mapping:
  - `implement` exit 0 → **Review** (never auto-Verified)
  - `implement` exit ≠ 0 → **Blocked**
  - `verify` exit 0 → **Verified** (that specific task only)
  - `verify` exit ≠ 0 → **Blocked**
  - interrupted (SIGINT/SIGTERM, crash, restart) → **Review** with lifecycle `interrupted`
- Task IDs are validated (`a-z0-9-`, max 64) and must already exist in the seeded state:
  the wrapper never invents task cards.
- Duplicate concurrent runs of the same task are refused using the recorded running PID;
  the check happens inside the state-lock transaction, so it cannot be raced.
- Every state mutation runs under one short-lived, state-file-global lock in the OS temp
  directory; the lock is released before a task starts and is never held while it runs.
  The lock carries an owner nonce, so a late release can never delete a lock another run
  acquired, and stale locks from dead processes are removed by owner record, not trusted.
- SIGINT/SIGTERM are forwarded to the task's own process group on POSIX (descendants are
  terminated too, never the board runner's group), escalate to SIGKILL after 5s, and a
  second signal terminates and exits immediately; Windows uses a direct child kill.
- All state writes are atomic (temp file + rename) and every read/modify/write is
  serialized under the same lock, so runs of different tasks cannot clobber each other.

## Restart and freshness

- If the recorded run says `running` but the PID is not alive (crash, restart, or an
  orphaned record), the board **shows that run as `interrupted` and the task in Review** —
  never as running. The server only projects this at read time; it does not rewrite the
  file. The projected interruption keeps the recorded `endedAt` exactly as stored (usually
  null) and adds an interrupted note — the board never fabricates an end timestamp it did
  not observe. The next wrapper run for that task persists the reconciled lifecycle.
- PID-reuse false positives are mitigated where feasible by comparing the live process
  start time (`ps -o lstart=`) with the recorded start time. If that check is unavailable,
  the wrapper falls back to a plain liveness probe. The `ps` probe is time-bounded, so a
  hung probe can never stall the board or a wrapper transaction.
- **Freshness is derived from recorded timestamps** in the state file
  (`progressUpdatedAt`, task lifecycle times). The server clock is never presented as
  "last progress time".

## Server security posture

- Listens only on `127.0.0.1:8790` (loopback; no interface binding option).
- Exactly two allowlisted `GET` endpoints: `/` (fixed HTML file) and `/api/progress`.
  Everything else is 404; non-GET is 405. There is no filesystem traversal surface, no
  write endpoint, no proxy, and no CORS headers.
- Every request re-reads the bounded (< 256 KB, ≤ 200 tasks) state file afresh and
  validates it; unknown stages/statuses produce a truthful `500` error rather than a guess.
- The API returns a **whitelist projection** (id, title, stage, scope, evidence, remaining,
  caveat, lifecycle fields) — anything else in the file, including tokens or credentials,
  is dropped and never reaches the browser.
- The page renders exclusively through `textContent`, includes a restrictive CSP, and
  respects `prefers-reduced-motion`.

## Files

- `scripts/progress-board.mjs` — server, validation, projection, lifecycle reconciliation
- `scripts/progress-task.mjs` — CLI execution wrapper that records run lifecycles
- `scripts/progress-board.test.mjs` — focused `node:test` coverage
- `docs/progress-state.json` — seeded, curated task records
- `docs/progress-board.html` — Kanban board UI (vanilla, no dependencies)
