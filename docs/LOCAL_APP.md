# Local macOS app bundle

Cloud voice requires `dist/native/echopilot-secrets`. The macOS build compiles it
directly from the helper sources, without resolving the offline ASR packages.
Packaging fails if it is missing; runtime lookup also supports older SwiftPM paths.

For stable local Keychain identity, `node scripts/local-signing.mjs` explicitly sets
up a private build keychain under `~/Library/Application Support/EchoPilot Build`.
This setup requires user approval: it adds a self-signed certificate to this user's
code-signing trust settings, never TLS or system-wide trust. Builds only reuse an
existing valid identity and never add trust. Keep this directory across worktrees
and updates. The signing key and password stay outside the repository with
user-only permissions. Without a valid configured identity, builds retain the
ad-hoc development fallback.

The first launch after switching from an old ad-hoc build may require choosing
**Always Allow** for EchoPilot's existing Keychain items. This preserves their
secrets and encryption keys. Subsequent builds with the same certificate should
retain access. Local signing is not Developer ID signing or notarization.

`pnpm package` assembles a real, double-clickable `EchoPilot.app` from this checkout using the
official Electron.app that the `electron` dependency already installed under `node_modules`. It is
a **local development bundle**, not a distributable release: it is ad-hoc signed so macOS can run
it, and it carries a machine-readable record saying exactly that.

Everything is assembled from what is already on disk. The command never downloads anything, never
reads the Keychain or an Apple credential, never asks for admin rights, and never writes to
`/Applications`.

## Reproducible commands

```sh
pnpm install --frozen-lockfile   # provides node_modules/electron/dist/Electron.app
pnpm dev                         # builds the Swift helpers + TS bundle, then opens the dev app
pnpm models:asr                  # pinned public WhisperKit + tokenizer pack (build-time download)
pnpm models:vad                  # pinned public MIT Silero CoreML conversion (build-time download)
pnpm build                       # refresh dist after source edits
pnpm package                     # assembles artifacts/local-app/EchoPilot-<version>-<stamp>-<nonce>.app
pnpm package:verify <bundle.app> --voice # signatures, asset digests, IPC/restart and microphone load/close
open "artifacts/local-app/EchoPilot-…"   # the exact command is printed when packaging finishes
```

`pnpm dev` builds the native helpers (`dist/native/PlatformHost`, `dist/native/echopilot-desktop`,
`dist/native/EchoPilotVoice.app`, and the optional `echopilot-secrets` /
`echopilot-exec-observation` binaries) and the compiled interface. `pnpm package` only needs the
compiled interface itself: it refreshes `dist/{main,preload,renderer}` with
`node scripts/build.mjs` once (disable with `--no-build`); it does **not** build the Swift helpers.

## Options

| Flag | Meaning |
| --- | --- |
| `--out <path>.app` | Explicit output path (default: a uniquely named bundle under `artifacts/local-app`). |
| `--ui-only` | Explicit opt-out: skips the voice helper, ASR pack and Silero VAD, and labels the bundle `ui-only`. |
| `--replace-existing` | Replaces an existing `EchoPilot-*.app` **inside `artifacts/local-app` only**; never on by default. |
| `--no-build` | Package existing `dist` output without refreshing the TypeScript build. |
| `--electron-app <path>` | Use a different Electron.app (default: `node_modules/electron/dist/Electron.app`). |
| `--json` | Print the machine-readable summary instead of the human summary. |
| `--help` | Show usage. |

Every run allocates a new versioned name (`EchoPilot-<version>-<timestamp>-<nonce>.app`), so
existing bundles are never overwritten by default and several builds can coexist.

## Bundle layout

```
EchoPilot-<version>-<timestamp>-<nonce>.app
└── Contents
    ├── MacOS/EchoPilot                 # the Electron executable, renamed
    ├── Frameworks/…                    # official Electron helpers, re-signed ad-hoc
    ├── Info.plist                      # executable/name/display name EchoPilot,
    │                                   # CFBundleIdentifier com.echopilot.desktop.local
    └── Resources/app                   # app.getAppPath(): everything the runtime resolves
        ├── package.json                # name echopilot, productName EchoPilot, main dist/main/index.cjs
        ├── local-bundle.json           # included/omitted record: ad-hoc, not notarized, not distributable
        ├── dist/{main,preload,renderer,native}
        ├── scripts/release/installers.json
        └── models/{manifest.json,licenses,asr/small.en,asr/silero_vad.mlmodelc}
```

The display name and executable are `EchoPilot`; the local bundle identifier
`com.echopilot.desktop.local` is intentionally distinct from the `com.echopilot.desktop` release
identity. The bundle is finished with `codesign --force --sign - --timestamp=none` and checked with
`codesign --verify --deep --strict`; `plutil` rewrites and then re-reads the Info.plist keys so the
claimed identity is the identity on disk. `plutil` and `codesign` are invoked as argv arrays
through `spawn` — never through a shell, and never with credentials or a Keychain unlock.
Electron ships its helper apps and frameworks linker-signed, which the deep strict check rejects,
so every nested `.app`/`.framework` under `Contents/Frameworks` is re-signed ad-hoc first
(deepest first, `Versions/Current` symlinks are not followed), then the voice helper with its
entitlement, and only then the outer bundle.

## What travels into the bundle

- **Required:** `dist/main`, `dist/preload`, `dist/renderer`, `dist/native` (including
  `PlatformHost`, `echopilot-desktop`, and — unless `--ui-only` — the packaged voice helper), plus
  `scripts/release/installers.json`, `models/manifest.json` and `models/licenses` so the in-app
  diagnostics report real readiness instead of guessing.
- **Public smoke fixture:** only the checked-in `fixtures/bootstrap/session.jsonl` single
  synthetic event travels, so `--smoke` can seed its disposable profile. No other fixture,
  transcript or user record is copied.
- **Pinned ASR pack:** `models/asr/small.en` (Whisper small.en) is included by default whenever it
  is present in the checkout — it is an ignored multi-hundred-megabyte directory, vendored with
  `pnpm models:asr`. If it is absent, packaging warns, records the omission in
  `local-bundle.json`, and the bundle reports dictation unavailable.
- **Silero VAD:** `models/asr/silero_vad.mlmodelc` (or `.mlmodel`; also `models/vad/…`) is copied
  into the bundle and mirrored into `EchoPilotVoice.app/Contents/Resources/Silero`, the location
  the voice helper searches (`Bundle.main.resourceURL/Silero`). That mirror changes the helper
  bundle, so the helper is re-signed ad-hoc with
  `native/macos/VoiceHelper/entitlements.plist` before the outer bundle is signed.
  The shipped pack is the public ungated MIT aufklarer/soniqo conversion of Silero v6.2.1,
  pinned to `523876545a57961474fee9df913e833e130560b8`, with an actual measured digest/size
  in the manifest. It uses 512 new samples plus 64-sample context and separate FP16 `h`/`c`
  state. Real-model prediction and reset were tested through the Swift backend. This
  conversion requires macOS 14 or newer; macOS 13 voice is not qualified. Argmax supplies
  WhisperKit ASR; the VAD conversion is attributed separately.
- **Optional helpers:** `echopilot-secrets` and `echopilot-exec-observation` are bundled when
  `pnpm dev` built them, and recorded as omitted when it did not.

## What never travels

`node_modules`, application source, `.git`, fixtures except the one public smoke event above,
transcripts, `auth.json`, `providers.json`,
`provider-config.json`, user profiles, credentials, `.env*`, `*.log`, `.DS_Store`, `__pycache__`,
and anything not named in the payload list above. Symlinks that resolve outside the repository are
skipped and reported. The optional ~2.9 GiB local reasoner (`models/reasoner/qwen3.5-4b-q4`) is
**never** copied by this path; `local-bundle.json` records that omission, and the app reports the
local reasoner as unavailable until a signed release pack provides it.

## Failure behavior

- Missing compiled resources or native helpers fail the run before anything is created or deleted,
  with a hint pointing at `pnpm dev` / `pnpm build`. There is no silent downgrade; `--ui-only` is
  the only explicit opt-out, it covers only voice assets, and it labels the bundle `ui-only`.
- An existing output is refused unless `--replace-existing` names an `EchoPilot-*.app` under
  `artifacts/local-app`. Replacement happens only after every precondition passed.
- Any failure after staging begins (plutil mismatch, signing, verification) removes the staging
  directory; no half-built bundle is left behind.

Verify a finished bundle with:

```sh
APP="artifacts/local-app/EchoPilot-…"      # the path pnpm package printed
codesign -dv --verbose=4 "$APP"            # Signature=adhoc Identifier=com.echopilot.desktop.local
plutil -p "$APP/Contents/Info.plist"
cat "$APP/Contents/Resources/app/local-bundle.json"
```

## Local bundle vs distributable release

The current delivered checkpoint is
`artifacts/local-app/EchoPilot-0.1.0-2026-09-30-203106Z-0316f8.app`.
Its adjacent `.app.qualification.json` records `local-qualified` on September 30, 2026,
including actual microphone and Whisper model load/release, successful packaged private/IPC
restart smoke, measured ASR/VAD digests and a clean payload inventory. This check used hidden
disposable profiles and did not open or change the user's ordinary app profile.
User-driven desktop focus, camera calibration and the broader acceptance matrix remain untested
by that smoke; see `docs/ACCEPTANCE_LEDGER.md`.

`pnpm package:verify <bundle.app>` records `local-qualified` only after strict codesign,
plist validation, and two launches of the packaged executable using a disposable profile.
The packaged ASR and VAD bytes (including the voice helper's VAD copy) are checked against the
manifest's measured digests. Add `--voice` to test microphone capture, actual Whisper model
loading, and capture/model release as well (the app needs a macOS microphone grant).
The JSON report always keeps `distributable: false` and explicit remaining release blockers.
The full release validator also remains incomplete for an ad-hoc local bundle.

This bundle is for a developer on this Mac. It is **not** Developer ID signed and **not**
notarized, so it must never be shipped or used to validate release claims. The distributable path
is `apps/desktop/forge.config.ts` (DMG/ZIP makers, hardened runtime, `osxNotarize`) fed by the
release metadata in `scripts/release/`. Remaining gates before that path can produce a real
release:

1. Provision the Apple Developer ID identity/team (the repository pins the `TEAMID` placeholder in
   `scripts/release/installers.json` and the Forge config expects `ECHOPILOT_SIGN_IDENTITY`).
2. Sign, notarize and staple the DMG/ZIP artifacts (Apple credentials supplied by the release job,
   never by this script or the repository).
3. Install the release-only Forge dev dependencies and run `electron-forge make` with the makers.
4. Complete the offline model pack (reasoner, Pocket TTS weights/voices and the bundled Python
   runtime) and verify it with `scripts/release/verify-pack.mjs` against `models/manifest.json`.
5. Re-sign the manifest and `pnpm release:validate` green on a clean checkout.

Until those gates pass, `pnpm package` is the supported way to get a real EchoPilot.app with the
current compiled runtime. macOS may still show ordinary TCC permission prompts (microphone,
Accessibility) on first use — those are runtime privacy prompts, not installer permissions.
