# PlatformHost (F02, V05 standby)

The signed macOS helper behind the widget's `helper` status. It owns no UI: it reports microphone
and screen-capture permission state over newline-delimited JSON on stdout and authenticates every
message with the per-launch token issued by `createShell`. Since V05 it also hosts the hands-free
standby half: the wake model, the always-on microphone, and the measurements the widget's standby
energy and false-trigger gates are built from.

## Build and sign

```sh
bash native/macos/Sources/PlatformHost/build.sh                     # ad-hoc signature (local)
ECHOPILOT_CODESIGN_IDENTITY="Developer ID Application: …" \
  bash native/macos/Sources/PlatformHost/build.sh                   # notarizable signature
```

The helper is its own SwiftPM package, so it also builds without signing:

```sh
swift build --package-path native/macos/Sources/PlatformHost
```

Its only dependency is the sibling `Audio` package (microphone graph, wake detector, energy
sampler); the graph is path-only, so the build resolves offline.

The default output is `dist/native/PlatformHost`, which `apps/desktop/src/main/native-host.ts`
probes automatically. `codesign --verify --strict` on that binary is the evidence the helper is
signed; a real Microphone/Screen Recording grant can only be observed by running the signed app.

## Work without Xcode

```sh
ECHOPILOT_NATIVE_HOST=apps/desktop/src/main/fake-native-host.ts pnpm dev
```

The fake host speaks the identical wire protocol from Node, including a deliberate disconnect
(`ECHOPILOT_FAKE_DROP_AFTER_MS=1500`) so the widget's recoverable disconnected state can be
exercised without a signed binary.

## Protocol

| Direction | Message |
| --- | --- |
| helper → app | `{"type":"hello","protocolVersion":1,"token":"…","status":{…}}` |
| helper → app | `{"type":"status","protocolVersion":1,"token":"…","status":{…}}` |
| helper → app | `{"type":"log","protocolVersion":1,"token":"…","message":"…"}` |
| helper → app | `{"type":"voice-ack","protocolVersion":1,"token":"…","id":"voice-1","ok":true}` |
| helper → app | `{"type":"voice-observation","protocolVersion":1,"token":"…","observation":{…}}` |
| app → helper | `{"type":"status"}`, `{"type":"permissions-changed"}`, `{"type":"quit"}` |
| app → helper | `{"type":"voice-command","protocolVersion":1,"id":"voice-1","name":"open-microphone","mode":"standby"}` |

A message with a wrong token, wrong `protocolVersion`, unknown `type`, or malformed `status` is
rejected by the shell and leaves widget state untouched.

## V05 standby lifecycle

The app drives the wake listener with four commands — `load-wake-model`, `open-microphone`
(`mode: "standby"`), `close-microphone` and `unload-wake-model` — and every command is
acknowledged, including a refusal (`ok: false` plus an `error`), so a lifecycle step never hangs on
a helper that declined. Conversation capture is deliberately refused here: that microphone belongs
to the local `echopilot-voice` worker, which owns the ASR pack.

While standby capture is open the helper emits, once per tick (default 2.5 s):

| Observation | What it carries |
| --- | --- |
| `standby-energy` | one `proc_pid_rusage` delta for this process (CPU ms, physical footprint, kernel wakeups) plus the duration-weighted gate `StandbyEnergyMonitor` computes over every reading, with its `violations` list |
| `standby-window` | the acoustic window that ended with the tick: environment (`quiet` / `tv` / `background_speech` / `other`), `detected`, `confidence`, `threshold` |

Both are emitted for every window, including the quiet ones that detected nothing: those windows are
the exposure denominator of the false-trigger rate, so "false triggers per hour" is measured rather
than assumed. `detected` is attention, never authorization — the helper performs no action on a
detection, and the app's `ConversationActivationController` is what decides whether an enabled
standby session reopens the conversation.

Knobs for local runs: `ECHOPILOT_STANDBY_TICK_MS` (default 2500),
`ECHOPILOT_STANDBY_WAKE_THRESHOLD` (default 0.8) and `ECHOPILOT_STANDBY_MEMORY_BUDGET_MB` (default
96). Only that last one changes the gate itself, and only its resident-memory entry: the CPU
(2 %) and wakeup (30/minute) budgets always stay at the product values, so a standby loop that
really burns CPU or wakes too often still fails. The desktop app reads the same memory knob for
the copy of the gate it computes over the frames this helper sends.

The supervisor writes only the `message` field of a `log` frame to the app log and redacts the
per-launch token from every line it logs, so the secret never lands in the app log. Launch helpers
with `ECHOPILOT_NATIVE_TOKEN` in the environment (as the supervisor does) rather than on the
command line, where `ps` can read it.
