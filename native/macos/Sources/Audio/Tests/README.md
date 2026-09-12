# V01 native pipeline regression

`main.swift` drives the real `MicrophoneGraph` → frame listener → `BoundedPCMChannel` →
`VoiceTracerBridge` → Silero VAD / `ASRWindowPlanner` path through the same packetizer the audio tap
uses, without asking for microphone permission or opening a device:

1. the graph hands each packet to the frame listener exactly once and never enqueues a second copy
   into the ring (one producer per packet);
2. the bridge's first 400 ms ASR window contains exactly 20 in-order packets — duplicated or
   dropped audio fails the ramp check;
3. mute settles and clears pending audio;
4. one oversized (16 s) packet is split so no ASR window exceeds 15 s.

```sh
swiftc -module-cache-path "$(mktemp -d)" -o /tmp/v01-native-tests \
  native/macos/Sources/Audio/*.swift native/macos/Sources/ASR/*.swift \
  native/macos/Sources/Audio/Tests/main.swift && /tmp/v01-native-tests
```

This directory is test-only and must stay out of the signed helper target: the helper compiles
`Sources/Audio` and `Sources/ASR` without `Tests`.
