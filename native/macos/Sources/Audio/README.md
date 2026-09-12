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

Failure path: denial, device removal (CoreAudio listener), screen lock (distributed notification)
and helper crash (`reportHelperCrash`) all emit a host event, release capture, and leave the widget
a visible state instead of hanging.

The deterministic acceptance path drives `packages/voice` through the fake host contract; this
module is what the signed helper feeds into in the app.
