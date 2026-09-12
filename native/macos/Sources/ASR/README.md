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
- Endpoint commits can carry empty text when the engine is certain the utterance is over; the
  widget keeps them in order and drops the empty strings when rendering.

The transcriber and the VAD are injected, so a signed build links the real WhisperKit small.en pack
and the Silero ONNX/CoreML backend while development harnesses can run the deterministic stand-ins.
