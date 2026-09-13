# Narration basic fixtures (N01)

`managed-readonly-tests.json` is the versioned input journal for the N01 acceptance oracle in
`packages/narration/test/n01.acceptance.test.ts`. It carries normalized `EventEnvelope` records plus
the payload each `payloadRef` resolves to, one case per requested outcome.

Provenance: the journal mirrors a managed read-only Codex app-server session (the pinned
`fixtures/harness/codex/fake-app-server.mjs` shape: `session_state`, `tool_started`,
`tool_completed`, `agent_message`) that ran the read-only fixture
`check-readonly-suite.mjs` as its test command, with that command's stdout lines attached as
`unsupported`/`log_line` records. Everything is synthetic and consented for tests: no user data, no
network, no writes. The command is genuinely read-only, and the oracle executes it while validating
that each recorded exit code is the real observed exit code.

Cases:

- `nonzero-exit` — 24 read-only checks where 3 fail (`exitCode: 1`), 6 progress messages and 24 log
  lines around them, and a trailing agent message claiming that all checks passed. The single spoken
  completion outcome must agree with the observed exit code, not with that claim.
- `clean-pass` — the same fixture suite run with `--clean` (`exitCode: 0`) plus an agent message that
  hedges the result. The spoken outcome must report the observed pass and must not repeat the hedge.

Limitations: the journal is a deterministic input, not a live harness session; managed app-server
plumbing is covered by H01's own oracle. Microphone, signed helper, and TTS voice are out of scope
for this tracer — the oracle drives the shared speech-lease seam with deterministic doubles.
