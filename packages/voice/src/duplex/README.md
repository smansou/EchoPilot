# packages/voice/src/duplex — overlapping speech while narration is audible

`index.ts` is the V03 duplex policy: it sits between the audible narration (the V02 playback session
or the `PlaybackGraph` device queue) and the user's overlapping speech. The native pipeline reports a
non-echo onset as soon as the microphone hears speech over narration, then the ASR/prosody evidence
once the utterance is stable; both events carry the same monotonic clock the Section 4.4 budgets are
measured on, so the controller never reads wall time.

Exports:

- `createDuplexController({ clock, output, agent })` — the controller
  (`noteSpeechOnset`, `submitUserSpeech`, `stopSpeaking`, `submitAgentControl`, `status`).
- `classifyOverlappingSpeech(evidence)` — the pure Section 5.5 classification, exported so the
  widget can show why an utterance was treated the way it was.
- `DUCK_LEVEL_DB`, `RESTORE_FADE_MS`, `MIN_CLASSIFIABLE_CONFIDENCE`,
  `BACKCHANNEL_MAX_DURATION_MS` — the tuning constants the release measurement reports against.

Policy per outcome:

| Outcome | Device | Committed | Effect on managed work |
| --- | --- | --- | --- |
| onset (duck) | `duck(-18 dB)`, cursor kept | — | none |
| `backchannel` | `restore(40 ms)` from the preserved cursor | no | none |
| `interruption` | `pause()` (epoch kept) | yes, for routing | none |
| `uncertain` | `pause()` (epoch kept) | yes, for routing | none |
| `explicit_stop` | `stop()` (epoch cancelled) | yes, for routing | none — only `submitAgentControl` reaches the harness |

Uncertainty wins over the stop spotter: a low-confidence, empty or truncated utterance pauses
narration, which the user can repeat, instead of cancelling a generation that was never really asked
to stop. A backchannel is only recognized while no confirmation is pending and no new request
follows, so an answer to a confirmation is never swallowed as an acknowledgement.

Routed agent-control is at-most-once (Section 5.6): `submitAgentControl` keeps the observed receipt
of every distinct `requestId` for the lifetime of the controller, so a redelivery resolves the same
receipt — even when it arrives after hundreds of newer routed requests — instead of instructing the
managed agent twice.

Verified by the frozen oracle `acceptance.test.ts` against `fixtures/duplex/`. Section 4.4 numbers are
decisions on an injected monotonic clock; acoustic and device latency (AEC, microphone, speaker or
headphone route) stay subject to the reference-machine qualification run.
