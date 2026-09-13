# V01 native pipeline regression

`V01PipelineTests.swift` drives the real `MicrophoneGraph` → frame listener → `BoundedPCMChannel` →
`VoiceTracerBridge` → Silero VAD / `ASRWindowPlanner` path through the same packetizer the audio tap
uses, without asking for microphone permission or opening a device:

1. the graph hands each packet to the frame listener exactly once and never enqueues a second copy
   into the ring (one producer per packet);
2. the bridge's first 400 ms ASR window contains exactly 20 in-order packets — duplicated or
   dropped audio fails the ramp check;
3. the 15 s utterance commits local text with utterance-relative timestamps, the endpoint ends it
   exactly once, and the trailing silence that keeps flowing afterwards commits nothing: no word is
   committed twice and no second utterance id appears (the engine stand-in returns no words for a
   silent window, like the real pack);
4. mute settles and clears pending audio, and an ordinary capture release settles while the tap
   path keeps delivering audio;
5. one oversized (16 s) packet is split so no ASR window exceeds 15 s;
6. mic denial, device removal, lock and helper crash stay visible (code, message, `closed` input),
   drop the pending ring, open no new ASR windows and still settle on `close()`;
7. a transcription that answers only *after* `mute()` or a host failure is invalidated: no final
   transcript is committed and nothing is emitted (gated-transcriber race);
8. the production wiring is real: `WhisperKitSmallEN.isBackendLinked` is true,
   `registerProductionBackends()` registers a Silero backend and a pack folder without the Silero
   model fails closed in `VoiceSessionBootstrap.makeLocalSession(_:)`;
9. an incomplete WhisperKit pack fails closed in `WhisperKitSmallEN.init` before capture: a missing
   or corrupt `tokenizer.json`, a tokenizer file without its `model` section, a missing CoreML
   bundle and a pack without any tokenizer/model config are all rejected instead of letting
   WhisperKit's tokenizer loader reach the Hub (a complete pack still loads).

```sh
swift test --package-path native/macos/Sources/ASR
```

The checks span `Audio` and `ASR`, so they live in the ASR package's `ASRTests` XCTest target
(`@testable import` reaches the internal test seams). They are XCTest cases, not an executable
script, so the loop gate validates them by running the suite instead of merely compiling them.
