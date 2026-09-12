# PlatformHost (F02)

The signed macOS helper behind the widget's `helper` status. It owns no UI: it reports microphone
and screen-capture permission state over newline-delimited JSON on stdout and authenticates every
message with the per-launch token issued by `createShell`.

## Build and sign

```sh
bash native/macos/Sources/PlatformHost/build.sh                     # ad-hoc signature (local)
ECHOPILOT_CODESIGN_IDENTITY="Developer ID Application: …" \
  bash native/macos/Sources/PlatformHost/build.sh                   # notarizable signature
```

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
| app → helper | `{"type":"status"}`, `{"type":"permissions-changed"}`, `{"type":"quit"}` |

A message with a wrong token, wrong `protocolVersion`, unknown `type`, or malformed `status` is
rejected by the shell and leaves widget state untouched.
