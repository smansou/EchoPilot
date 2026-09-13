# `@echopilot/narration` (N01)

N01 tracer bullet: **agent test result → durable event → concise spoken outcome → replay**.

The seam is `createNarrationTracer({ attention, voice, now, memory })` from `src/index.ts`, driven
one normalized §5.3 `EventEnvelope` (+ the payload its `payloadRef` resolves to) at a time. The
acceptance oracle lives in `test/n01.acceptance.test.ts` and replays the managed read-only journal
in `fixtures/narration/basic/managed-readonly-tests.json`, whose exit codes are re-observed by
executing the real read-only suite `fixtures/narration/basic/check-readonly-suite.mjs`.

## Guarantees

- **One turn, one utterance.** Only `session_state` / `turn/completed` produces a plan. Progress
  messages, stdout log lines (`unsupported` / `log_line`), user text and agent text are context for
  the reducer and never become one utterance each.
- **Receipt-only outcomes.** The turn status comes from `tool_completed` envelopes with
  tool-observed (or imported) trust. A nonzero observed exit code can never be upgraded by later
  agent text, and a zero exit code can never be downgraded by an agent hedge. No receipt → no
  outcome and no speech.
- **Lease-gated speech.** The tracer asks the shared attention policy for a lease and submits one
  §5.3 `SpeechPlan` whose epoch and expiry are copied from that lease. No lease (muted, unleased or
  expired) → nothing is submitted; a stale lease leaves nothing audible and nothing to replay.
- **Evidence, not recitation.** Plans and replay records cite the durable `tool_started` /
  `tool_completed` events (plus the turn-closing event) the outcome was reduced from. The spoken
  text is a factual template with the observed counts and exit code, never a command's log lines.
- **Replay.** `replay()` returns the audible outcomes newest-last, each identifying its plan,
  segment, session and evidence. Nothing audible → empty.
- **Best-effort durable receipts.** When a M01 memory sink is supplied, each heard segment is
  persisted as a `delivery_receipt` envelope with a hash of the spoken text. A memory failure never
  blocks narration, and never changes what `replay()` reports.

## Deliberate limits

- A failing receipt is announced as the turn's single completion outcome (blocking fact first) —
  splitting a failure into a separate blocking utterance is N03's queue arbitration.
- `gap` events are N01's blocking-event announcement: one bounded sentence per gap, deduplicated,
  with the gap event cited as evidence instead of smoothed over.
- Semantic interpretation, verbosity levels and multi-session coalescing arrive in N02/N03, and no
  independent TTS engine is introduced: the tracer only builds plans for the shared voice layer.
- The journal is a deterministic normalized input, not a live app-server child process; managed
  app-server plumbing stays covered by H01's oracle. Microphone, signed helper and TTS voice are out
  of scope for this tracer.
