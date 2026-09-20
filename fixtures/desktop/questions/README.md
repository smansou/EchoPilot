# Desktop question fixtures (C01)

`c01-questions.json` is the deterministic scenario corpus for the C01 desktop "what is this?" tracer
(`packages/desktop-tools/src/context/` + `apps/desktop/src/renderer/widget/`). It replays one
foreground app per scenario through the frozen C01 seam with scripted doubles, so every property the
oracle pins is decidable offline:

- `profileId`, `project` — the explicit project association the conversation is configured with.
  Memory reads must carry this scope; window-title similarity is never a project association.
- `excludedBundleIds` — apps whose content must never be captured or fed to the model.
- `excludedTemplate`, `limitedTemplates` — the deterministic honest answers for an excluded app and
  for missing AX/pixels. `{app}` is replaced with the resolved application name. The limited answers
  never assert control state, so `forbiddenControlStateWords` must not appear in them.
- `scenarios[]` — synthetic apps, window titles, snapshots, memory lines, and scripted model answers:
  - `browser-error` — a captured browser window, an explicit-project memory entry, and a
    title-similar trap entry from another project that must never reach the model.
  - `ide-control` — a captured IDE window with two AX controls.
  - `excluded-app` — an excluded app whose snapshot would leak a synthetic secret marker if the
    service ever asked the helper to capture it (`captureMustNeverBeRequested`, `leakMarker`).
  - `missing-accessibility` — capture denied; the scripted model answer invents a disabled-state
    claim that must never be used.
  - `empty-context` — a snapshot with no non-empty AX value, no OCR span, and no screenshot.

Consumers:

- `packages/desktop-tools/src/context/c01.acceptance.test.ts` — the C01 acceptance oracle. It loads
  this file, drives the frozen `createDesktopContextService` seam with deterministic doubles, and
  reports the missing behavior while no implementation exists. Each memory entry carries its
  `projectId`, so the oracle can prove the scope-less similarity query is the leak the explicit
  project scope prevents.

Provenance: fully synthetic. No screen recording, permission prompt, user data, or network call is
involved. Times are fixed UTC millisecond values so replays are byte-stable.

Limitations: this corpus pins the seam, not the hardware. Real Accessibility/ScreenCaptureKit
capture, macOS permissions, pixel quality, and the rendered widget capture/evidence indicator need
the signed helper and a manual qualification pass; that work is recorded by the tickets that own it
and is never claimed from these mocks. The oracle pins the indicator's data (the answer's `capture`
object plus its evidence ids), not its rendered pixels.
