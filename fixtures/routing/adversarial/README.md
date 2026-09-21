# Adversarial routing fixtures (R03)

`r03-adversarial-utterances.json` is the versioned adversarial corpus for the R03 acceptance oracle
(`packages/routing/src/state/r03.acceptance.test.ts`, `packages/core/src/dialogue/r03.acceptance.test.ts`).
It extends the R01 held-out corpus with the failure modes the R03 ticket hardens against
(IMPLEMENTATION_PLAN.md §5.6, BACKLOG R03): quoted instructions inside companion explanations,
dictation-literal content, Agent Direct mode, mode switches, overlapping pending events, and stop-all.

The oracle expands the templates into 360 utterances and drives every one of them through the R03
routing state. Ground-truth labels are never passed to the routing state; the oracle only compares
the returned decision against them.

Corpus categories (counts are expansion counts, minimums are asserted by the oracle):

- `quotedInstruction` — `frames × quotations` = 60 utterances. Each contains an instruction-shaped
  span inside quotation marks. `expectSession: null`: a quoted span is quoted content, never an
  instruction. The frames place the quote at the start (the cases the frozen R01 router dispatches
  today), in the middle, and after an attribution clause.
- `companionExplanation` — 26 utterances that talk about sessions without instructing one.
- `ambiguousAddressee` — 16 utterances whose destination is not unique (two Codex sessions, "the
  session", "it", "the other codex", a sent-to referent).
- `noisyAsr` — 24 utterances with explicit ASR confidences. Misheard session names are never
  guessed; an unreliable transcript (below the §5.7 0.95 auto-dispatch floor) is clarified instead
  of dispatched, even when the words are clean; noise in the task clause alone still dispatches.
- `realInstruction` — `templates × names × tasks` = 192 explicit, unique instructions that must
  reach exactly the named session. They exist so a "never dispatch" implementation cannot pass the
  corpus.
- `quoteInsideInstruction` — 8 real instructions that merely mention a quoted phrase; the quotes must
  not suppress a genuinely addressed instruction.
- `agentDirect` — 6 utterances inside Agent Direct mode: ordinary instructions reach the displayed
  session, `Echo …` questions and desktop intents stay local, and an explicit prefix still wins.
- `dictationLiteral` — 14 utterances routed while dictation mode is active. Command-shaped, quoted,
  desktop-shaped, acknowledgment-shaped, and wake-word-shaped text is literal dictation; only the
  end phrase and the §5.6 precedence-1 emergency controls are not literal.
- `partialAsr` — 8 partial transcripts, including one that looks complete.
- `stopAll` — 6 "stop all" utterances in companion, Agent Direct, and dictation mode: the emergency
  control is recognized in every mode and never dispatched.
- `sequences` — 3 multi-turn sequences for overlapping pending events (queued questions, not
  simultaneously eligible), stale pending-answer expiry (30 s), and session switching through modes.

Provenance: fully synthetic. Authored from §5.6 and the R03 acceptance criteria; there is no user
data, no recording, no network, and no live audio. Timestamps are produced by the oracle's injected
fake clock, never by this file.
