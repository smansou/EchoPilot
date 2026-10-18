# EchoPilot

EchoPilot is a macOS desktop voice partner. Dictation writes into the app you are using; native live conversation helps you work through questions, understand saved coding sessions and propose supported desktop actions. Both use one small notch. Settings, gaze calibration and encrypted history live in the app window.

Choose Gemini or OpenAI for live voice. Reasoning and dictation can use Gemini, OpenAI or OpenRouter independently. Keys stay in macOS Keychain; local Claude/Codex session discovery requires no separate pairing. The voice model starts with locally prepared session evidence and persistent goals, and delegates missing research or coding work when needed. Assistant & memory settings let you inspect commitments, follow coding tasks, set the idle sleep timeout and calibrate an optional offline wake phrase.

## Run locally

Use macOS, Node.js 24+, pnpm 11.19.0 and Xcode command-line tools for native features.

```sh
pnpm install
pnpm dev
```

In General, choose a provider setup and save its API key. Allow Microphone and Accessibility. Press Control+Option+Space to dictate, or Option+Space for live conversation. Advanced allows a custom voice/reasoning combination. No local model downloads are required for live voice or dictation. For optional English wake phrases, run `pnpm models:wake` before building, then calibrate your phrase in Assistant & memory. Wake audio stays local until voice activates.

`pnpm dev` builds the application and available native helpers. `pnpm package` creates an ad-hoc signed local cloud-voice app without offline ASR/VAD model packs. It is not a notarized distribution. Quit older copies before testing global shortcuts.

See [assistant context and wake voice](docs/PERSONAL_ASSISTANT_CONTEXT_2026-10-18.md), [current handoff](docs/LIVE_HANDOFF.md), [native live voice](docs/REALTIME.md), and [desktop guide](docs/DESKTOP_REDESIGN.md) for verified behavior and remaining acceptance work. Earlier implementation plans and backlog tickets are historical, not a description of the current UI.

## Verify

```sh
pnpm check
pnpm smoke
pnpm release:validate
```

`check` runs contract, type, unit, fixture, and build gates. `smoke` opens Electron twice with a temporary profile and verifies settings, privacy IPC, encrypted memory, forgetting, and startup. Some process-isolation tests need to run outside a restricted filesystem sandbox. `release:validate` also builds and tests the native packages; it currently reports an incomplete release because packaging and acceptance-ledger evidence are missing. Its report is `.loop/release/report.json`.

## Code map

- `apps/desktop/src/main`: app lifecycle, native hosts, managed Codex, settings, and memory routes.
- `apps/desktop/src/preload`: narrow renderer bridge and dedicated key/privacy channels.
- `apps/desktop/src/renderer`: desktop notch, settings, gaze calibration and history.
- `packages/`: domain services and acceptance tests.
- `native/macos/`: Swift audio, ASR, Keychain, Accessibility, execution, and platform helpers.
- `IMPLEMENTATION_PLAN.md` and `BACKLOG.json`: historical architecture and original ticket graph.

The Electron boundary follows the official [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [preload guidance](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload).
