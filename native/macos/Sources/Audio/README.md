# Audio — native microphone graph

The signed helper builds the capture side of the V01 tracer bullet:

| Piece | File | Contract |
| --- | --- | --- |
| 20 ms PCM packets | `AudioFrames.swift` | `{ sequence, sampleRate: 16000, channels: 1, monotonicNs, pcm }` — the frozen `VoiceSession.pushInput` frame |
| Bounded transport ring | `BoundedPCMChannel.swift` | `maxQueuedFrames` packets, drop-oldest overflow, `droppedFrames` + `discontinuityCount`, ASR reset marker |
| Device enumeration | `AudioDeviceEnumerator.swift` | input devices (`uid`, `name`, `isDefault`) + change observation for `device_removed` |
| Permissions | `MicrophonePermission.swift` | explicit active-session `granted` / `denied` / `unknown`, request only when a session asks |
| Microphone graph | `MicrophoneGraph.swift` | `permission()`, `startCapture(onFrame:)`, `stopCapture()`, `captureActive()`, `onEvent(_:)` — the fake host's shape |
| Playback graph | `PlaybackGraph.swift` | `open(format:)`, `write(_:)`, `onProgress(_:)`, `flush()`, `interrupt(epoch:)`, `close()` — the output half of the same session |

Capture path: `AVAudioEngine` input tap → `AVAudioConverter` to 16 kHz mono Int16 → `AudioPacketizer`
(20 ms packets, monotonic packet start times) → `frameListener` → bounded ring → ASR consumer.
The listener is the only producer into the ring: the graph hands each packet over exactly once, so
the ring's capacity and the ASR window/endpoint timing match real audio time.

## Playback (V02)

`PlaybackGraph` is the device queue the TypeScript playback session writes to
(`packages/voice/src/playback/index.ts`): it opens the output device with the declared format
(24 kHz mono Int16 packets from the bundled Pocket TTS worker) and schedules each frame on an
`AVAudioPlayerNode`.

- Progress is real: a frame is only reported as rendered from the player's `.dataPlayedBack`
  completion, so a sentence the worker generated but the device never played is not "heard" and is
  not replayable.
- Cancel is a device operation: `flush()` stops the node, which discards every buffer that was
  queued but not yet rendered, and `interrupt(epoch:)` additionally adopts a newer generation so a
  worker frame produced after the cancel is dropped by `write` (visible in `staleFrameCount`)
  instead of becoming audible.
- Every listener call happens on the graph's state queue, so a flush is never half-applied when the
  widget observes it.

The graph is a library file of this package, so `swift build --package-path
native/macos/Sources/Audio` builds it next to the capture side without a signing identity.

Failure path: denial, device removal (CoreAudio listener), screen lock (distributed notification)
and helper crash (`reportHelperCrash`) all emit a host event, release capture, and leave the widget
a visible state instead of hanging. The session bridge treats such an event as terminal for that
session: it clears the ring and drops later packets, so nothing is transcribed after the widget
showed the failure. `setPermissionOverrideForTesting` and `emitForTesting` let the headless
regression exercise the denial and event paths without prompting for a microphone.
`stopCapture()` flips the capture flags under the state lock and then releases it before
`removeTap`/`engine.stop()`: those calls wait for an in-flight tap block, and a tap block takes the
state lock, so holding it across the release would deadlock mute, lock and device-removal stops.

## Build and test without Xcode

`Package.swift` in this directory builds this module on its own; the root `native/macos/Package.swift`
builds the signed `echopilot-secrets` helper and the production voice tracer
`echopilot-voice` (`Sources/ASR/VoiceHost`), which links this module, the `ASR` package and the
pinned WhisperKit small.en backend.

```sh
swift build --package-path native/macos/Sources/Audio
```

The native pipeline regression (exactly-once packet delivery, bounded windows, mute/release
settling while audio flows) spans this module and `ASR`, so it lives in the ASR package's XCTest
target: `swift test --package-path native/macos/Sources/ASR`. Each package keeps its `.build`
scratch directory ignored, so the checked-out tree stays clean after a gate run.

The deterministic acceptance path drives `packages/voice` through the fake host contract; this
module is what the signed helper feeds into in the app.
