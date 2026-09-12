# Audio — native microphone graph

The signed helper builds the capture side of the V01 tracer bullet:

| Piece | File | Contract |
| --- | --- | --- |
| 20 ms PCM packets | `AudioFrames.swift` | `{ sequence, sampleRate: 16000, channels: 1, monotonicNs, pcm }` — the frozen `VoiceSession.pushInput` frame |
| Bounded transport ring | `BoundedPCMChannel.swift` | `maxQueuedFrames` packets, drop-oldest overflow, `droppedFrames` + `discontinuityCount`, ASR reset marker |
| Device enumeration | `AudioDeviceEnumerator.swift` | input devices (`uid`, `name`, `isDefault`) + change observation for `device_removed` |
| Permissions | `MicrophonePermission.swift` | explicit active-session `granted` / `denied` / `unknown`, request only when a session asks |
| Microphone graph | `MicrophoneGraph.swift` | `permission()`, `startCapture(onFrame:)`, `stopCapture()`, `captureActive()`, `onEvent(_:)` — the fake host's shape |

Capture path: `AVAudioEngine` input tap → `AVAudioConverter` to 16 kHz mono Int16 → `AudioPacketizer`
(20 ms packets, monotonic packet start times) → `frameListener` → bounded ring → ASR consumer.
The listener is the only producer into the ring: the graph hands each packet over exactly once, so
the ring's capacity and the ASR window/endpoint timing match real audio time.

Failure path: denial, device removal (CoreAudio listener), screen lock (distributed notification)
and helper crash (`reportHelperCrash`) all emit a host event, release capture, and leave the widget
a visible state instead of hanging.
`stopCapture()` flips the capture flags under the state lock and then releases it before
`removeTap`/`engine.stop()`: those calls wait for an in-flight tap block, and a tap block takes the
state lock, so holding it across the release would deadlock mute, lock and device-removal stops.

`Tests/main.swift` is the native pipeline regression (exactly-once packet delivery through
`MicrophoneGraph` + `VoiceTracerBridge`, bounded windows); it is test-only and stays out of the
helper target.

The deterministic acceptance path drives `packages/voice` through the fake host contract; this
module is what the signed helper feeds into in the app.
