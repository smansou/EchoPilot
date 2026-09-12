# ASR — local Silero VAD + WhisperKit small.en

| Piece | File | Rule |
| --- | --- | --- |
| Silero VAD | `SileroVAD.swift` | 512-sample frames at 16 kHz, hysteresis (0.5 / 0.35), endpoint after 450 ms of trailing silence |
| WhisperKit small.en | `WhisperKitSmallEN.swift` | English-only first model pack, model folder on disk, `allowsNetwork = false`, rejects windows > 15 s |
| Window planner | `ASRWindowPlanner.swift` | ≤ 15 s windows, 1 s overlap, stable-prefix commits only on a window boundary or endpoint |
| Session bridge | `VoiceTracerBridge.swift` | host + VAD + transcriber + planner → `status()` / `subscribe()` / `transcript()` / `mute()` / `close()` |
| Local runtime | `SileroVAD.swift`, `WhisperKitSmallEN.swift` | CoreML Silero v5 backend (`SileroVADCoreMLBackend`, registered by production) + pinned WhisperKit small.en; no download, no network |
| Production bootstrap | `VoiceSessionBootstrap.swift` | resolves the on-disk packs, registers the Silero backend and instantiates `VoiceTracerBridge` |
| Voice host | `VoiceHost/main.swift` | `echopilot-voice`: stdio JSON only (`hello`/`status`/`transcript`/`error`; `start`/`mute`/`status`/`close`) |

Rules that match `packages/voice` one-for-one:

- Word timestamps are milliseconds relative to the start of the **utterance**, never to an individual
  window; the planner adds the window offset and keeps the committed prefix.
- Partial results are display-only. Only `final` updates carry committed text, and a committed
  prefix is never re-committed (overlap words are filtered by their end timestamp).
- A discontinuity (dropped audio from the bounded ring) discards the open window instead of
  splicing non-contiguous audio; the dropped count stays visible in `status()`.
- A host failure (denial, device removal, lock, helper crash) is terminal for the session: it
  clears the ring, releases capture, resets the planner, and keeps the error visible in
  `status()` while late packets are dropped instead of being transcribed or committed.
- Mute and host failure bump the pipeline epoch: a transcription that is already in flight when the
  user mutes (or when the host fails) is cancelled and invalidated, so its late result can never be
  applied or emitted as a final transcript. The epoch check, the planner apply and the append to the
  committed transcript are one critical section (`VoiceTracerBridge.applyEngineResult`), so a mute
  or failure can never land between "the result is still current" and "the result is committed".
- The capture path and mute share one critical section too: a packet that raced the mute is either
  cleared with the ring or dropped by the capture guard, so `queuedFrames` is 0 once `mute()`
  resolves and no window reopens on the audio the widget already stopped showing.
- Endpoint commits can carry empty text when the engine is certain the utterance is over; the
  widget keeps them in order and drops the empty strings when rendering.

The transcriber and the VAD are injected, so the signed build links the real WhisperKit small.en
pack and the Silero CoreML backend while development harnesses can run the deterministic
stand-ins. Production is wired end to end: `VoiceSessionBootstrap.registerProductionBackends()`
registers `SileroVADCoreMLBackend` with `SileroVADBackendRegistry`, and
`VoiceSessionBootstrap.makeLocalSession(_:)` builds the `MicrophoneGraph` + Silero VAD + WhisperKit
small.en + `VoiceTracerBridge` session the host runs.

## Build and test without Xcode

`Package.swift` in this directory builds this module on its own and depends on the `Audio` package
next to it (packets and the bounded ring come from there) and on the pinned WhisperKit release, so
`canImport(WhisperKit)` is true for the local engine. The root `native/macos/Package.swift` builds
the signed `echopilot-secrets` helper and the production voice tracer `echopilot-voice`, which
links this package (including WhisperKit) through `Sources/ASR/VoiceHost`.

```sh
swift build --package-path native/macos/Sources/ASR
swift test --package-path native/macos/Sources/ASR
swift build --package-path native/macos            # echopilot-secrets + echopilot-voice
```

The host reads `ECHOPILOT_ASR_MODEL_DIR` (the folder holding `small.en`),
`ECHOPILOT_SILERO_MODEL_DIR` (optional; the Silero pack is also looked up in the app bundle) and
`ECHOPILOT_MAX_QUEUED_FRAMES`, then serves `{"type":"start"|"mute"|"status"|"transcript"|"close"}`
commands on stdin. A missing pack exits with a visible `{"type":"error", …}` frame before capture
opens, so the widget never hangs on a broken install.

`Tests/V01PipelineTests.swift` is the native pipeline regression: exactly-once packet delivery
through `MicrophoneGraph` + `VoiceTracerBridge`, one 400 ms window that holds each packet once,
15 s of speech plus trailing silence committing local text whose word timestamps are rebased from
the engine's window onto the utterance, mute and an ordinary capture release settling while audio
keeps flowing, and the 15 s window bound for an oversized packet. It also covers the visible
failure states: mic denial (through the graph's
permission override seam), device removal, lock and helper crash each keep their error code,
message and `closed` input visible, drop the pending audio, stop opening new ASR windows, and still
settle on `close()`. Two more cases hold the mute/failure race: a gated transcriber that answers
only *after* `mute()` (or after a host failure) must not commit a final transcript, a result whose
epoch was invalidated is rejected at the single commit boundary even though the planner owned its
window up to the reset, and packets still being delivered while `mute()` runs leave no queued input
behind. The suite also
asserts the production wiring itself: `WhisperKitSmallEN.isBackendLinked` is true and
`registerProductionBackends()` registers a Silero backend, while a pack folder without the Silero
model fails closed in `VoiceSessionBootstrap.makeLocalSession(_:)`. It never asks for microphone
permission or opens a device, so it runs headless. Each package keeps its `.build` scratch (and its
`Package.resolved` pin) ignored, so the checked-out tree stays clean after a gate run.
