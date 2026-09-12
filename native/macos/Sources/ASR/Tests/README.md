# V01 native pipeline regression

`V01PipelineTests.swift` drives the real `MicrophoneGraph` → frame listener → `BoundedPCMChannel` →
`VoiceTracerBridge` → Silero VAD / `ASRWindowPlanner` path through the same packetizer the audio tap
uses, without asking for microphone permission or opening a device:

1. the graph hands each packet to the frame listener exactly once and never enqueues a second copy
   into the ring (one producer per packet);
2. the bridge's first 400 ms ASR window contains exactly 20 in-order packets — duplicated or
   dropped audio fails the ramp check;
3. mute settles and clears pending audio, and an ordinary capture release settles while the tap
   path keeps delivering audio;
4. one oversized (16 s) packet is split so no ASR window exceeds 15 s.

```sh
swift test --package-path native/macos/Sources/ASR
```

The checks span `Audio` and `ASR`, so they live in the ASR package's `ASRTests` XCTest target
(`@testable import` reaches the internal test seams). They are XCTest cases, not an executable
script, so the loop gate validates them by running the suite instead of merely compiling them.
