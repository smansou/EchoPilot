# fixtures/harness/recovery

`fake-recovery-app-server.mjs` is a real stdio child that speaks the pinned Codex app-server
protocol (newline-delimited JSON-RPC on stdin/stdout, `codex-cli 0.154.0`) with a configurable
session identity, a session-state file, and a `drop-ack` scenario for connection loss around the
send/ack boundary. It lets the H04 oracle drive several live managed adapters, reconnect after a
lost acknowledgment, and reconcile delivery outcomes from observed session state without a real
Codex account, network, or desktop session.

Scenarios (`H04_SCENARIO`):

- `session` — acknowledges `turn/start`, completes one command item, and completes the turn.
- `approval` — opens a guarded command item and blocks on the approval request (id 7) until the
  client answers accept/decline.
- `drop-ack` — records the accepted turn in the session-state file and exits without answering
  `turn/start`: the instruction reached the harness, the acknowledgment was lost.

Environment: `H04_THREAD_ID`, `H04_SESSION_ID`, `H04_PROJECT_ID`, `H04_JOURNAL` (JSONL journal of
every inbound/outbound message and lifecycle event), and `H04_SESSION_STATE` (JSON file rewritten
with the accepted turns: `{sessionId, projectId, cwd, turns:[{turnId, instruction, status}]}`).
The child executes no commands; the approval ping-pong only decides whether the scripted guarded
item completes. If this fixture cannot speak the pinned protocol, the H04 acceptance oracle and
the H01-managed adapter both fail loudly rather than passing on mocks.

## Verification

Both H04 suites run offline (no Codex/Claude account, no network, no desktop session) and are part
of the frozen `pnpm test` command:

- `node --import tsx --test packages/core/src/session-registry/h04.acceptance.test.ts` — the
  end-to-end oracle: two live Codex children plus a scripted Claude stream through the registry and
  conformance runner, then a reconnect across the `drop-ack` boundary.
- `node --import tsx --test packages/core/src/session-registry/recovery.behavior.test.ts` —
  in-process doubles for the same seams: a racing replay of one idempotency key, a lost
  acknowledgment that stays `unknown` across `reconnect()` and reconciles from observed state
  after a worktree (`cwd`) change, unsupported receipts reported as typed failures, and the
  per-session capability gate.

The `drop-ack` child journals the `turn/start` it accepted before exiting, so the duplicate-send
claim rests on wire evidence (`H04_JOURNAL`) plus the fixture's session-state file
(`H04_SESSION_STATE`) rather than on the client's own bookkeeping. Because the evidence is a local
child process, an oracle run can be repeated after a provider outage (H04 finding
`f-dc66fa9f90c6`, an upstream 402 from the oracle provider) without any account or balance.
