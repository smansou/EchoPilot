# Attention fixtures (R02)

`r02-pillar-stream.json` is the versioned event stream for the R02 acceptance oracle in
`packages/attention/test/r02.acceptance.test.ts`. It replays one synthetic session through the shared
attention policy (IMPLEMENTATION_PLAN.md §5.7) under an injected fake clock:

- `pillarSources` — the pillar/module sources exercised: `capture`, `harness`, `memory`, `narration`,
  `desktop`, `gaze`, `voice`. No source is special-cased; each candidate carries its `sourceId`.
- `steps[].at` — the fake clock value for that step; every receipt's `decidedAt` must equal it.
- `steps[].kind` — `candidate` (submit one candidate), `tick` (re-evaluate deferred candidates),
  `user-speaking-start` / `user-speaking-end` (the user's utterance), or `settings` (one
  `updateSettings` patch).
- `steps[].expect` — the receipt stream that step must return, matched by `candidateId`, `outcome`,
  `reason`, and (when the key is present) `setting`, `null` meaning no settings value governed the
  decision.

The stream covers: turn-complete summaries after the 750 ms quiet gap and per-turn replacement of a
stale summary; routine digests under the focused-work 120 s cooldown; a background session shown
visually; a blocking request deferred while the user speaks and spoken at the safe gap; an important
failure; explicit output silence suppressing both a user-requested reply and a blocking event; mute
suppressing without queueing; and a spoken reply after the user resumes the assistant.

Provenance: fully synthetic. The fixture is authored from the §5.7 event-class table and the R02
acceptance criteria; there is no user data, no recording, no network, and no live audio. Times are
fixed UTC ISO strings so the replay is deterministic.

Limitations: the oracle drives the shared speech-lease seam with a deterministic audio probe (the
§5.3 rule that a playback adapter checks `canSpeak` before a chunk), so real TTS output, audio
devices, microphone capture and V03 duplex barge-in are out of scope here and are covered by their own
tickets. Steps whose expected outcome is not `spoken` are placed at least the 30 s lease bound after
the last spoken decision, so no expectation depends on floor interactions this oracle does not pin.
