# ASR — local Silero VAD + WhisperKit small.en

| Piece | File | Rule |
| --- | --- | --- |
| Silero VAD | `SileroVAD.swift` | 512-sample frames at 16 kHz, hysteresis (0.5 / 0.35), endpoint after 450 ms of trailing silence |
| WhisperKit small.en | `WhisperKitSmallEN.swift` | English-only first model pack, model folder on disk, `allowsNetwork = false`, rejects windows > 15 s |
| Window planner | `ASRWindowPlanner.swift` | ≤ 15 s windows, 1 s overlap, stable-prefix commits only on a window boundary or endpoint |
| Session bridge | `VoiceTracerBridge.swift` | host + VAD + transcriber + planner → `status()` / `subscribe()` / `transcript()` / `mute()` / `close()` |

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
- Endpoint commits can carry empty text when the engine is certain the utterance is over; the
  widget keeps them in order and drops the empty strings when rendering.

The transcriber and the VAD are injected, so a signed build links the real WhisperKit small.en pack
and the Silero ONNX/CoreML backend while development harnesses can run the deterministic stand-ins.

## Build and test without Xcode

`Package.swift` in this directory builds this module on its own and depends on the `Audio` package
next to it (packets and the bounded ring come from there); the root `native/macos/Package.swift`
keeps building only the signed `echopilot-secrets` helper.

```sh
swift build --package-path native/macos/Sources/ASR
swift test --package-path native/macos/Sources/ASR
```

`Tests/V01PipelineTests.swift` is the native pipeline regression: exactly-once packet delivery
through `MicrophoneGraph` + `VoiceTracerBridge`, one 400 ms window that holds each packet once,
mute and an ordinary capture release settling while audio keeps flowing, and the 15 s window bound
for an oversized packet. It also covers the visible failure states: mic denial (through the graph's
permission override seam), device removal, lock and helper crash each keep their error code,
message and `closed` input visible, drop the pending audio, stop opening new ASR windows, and still
settle on `close()`. It never asks for microphone permission or opens a device, so it runs headless.
Each package keeps its `.build` scratch directory ignored, so the checked-out tree stays clean after
a gate run.
