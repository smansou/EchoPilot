# packages/voice — local voice tracer session

`src/index.ts` is the host-facing half of the V01 tracer: Speak → native audio → local ASR →
widget transcript → mute. It drives the native helper through the frozen host contract and is
verified by `test/acceptance.test.ts` against the fake host plus the frozen fixtures in
`fixtures/audio/`.

Exports:

- `ASR_MAX_WINDOW_MS` — 15 s hard bound for one local ASR window.
- `createLocalVoiceSession({ host, asr, maxQueuedFrames })` — the widget session
  (`start`, `pushInput`, `mute`, `status`, `subscribe`, `transcript`, `close`).

Rules:

- Windows roll at 15 s with a 1 s overlap. Only fully heard words are committed, only on a window
  boundary or an endpoint ("commit stable prefixes"); `partial` updates are display-only and are
  never routed or committed.
- The transport ring holds at most `maxQueuedFrames` packets. A stalled ASR consumer makes the ring
  drop the oldest audio and count a discontinuity; the affected window is discarded instead of
  splicing non-contiguous audio.
- Mute stops native capture, drops queued and pending audio and clears partial text; the microphone
  permission itself is untouched.
- Mic denial, device removal, lock and helper crash resolve `start()` normally and stay visible in
  `status().error` with capture released.

Native counterpart: `native/macos/Sources/Audio/` (microphone graph, bounded PCM channel, device
enumeration, permissions) and `native/macos/Sources/ASR/` (Silero VAD, WhisperKit small.en, window
planner, session bridge).
