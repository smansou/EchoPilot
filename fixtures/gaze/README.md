# Gaze fixtures (G01)

`g01-webcam-session.json` is the frozen synthetic session for the G01 acceptance oracle in
`packages/gaze/test/g01.acceptance.test.ts`. It follows IMPLEMENTATION_PLAN.md §5.11 and is
replayed entirely through injected clocks and fakes — no camera, no microphone, no network, no
user data:

- `displayMain` / `displaySide` — display transforms (origin, size, scale, arrangement
  generation). Every gaze sample must carry the transform it was produced under; a changed
  arrangement generation invalidates the calibration for that display.
- `calibration.targets` — the nine 1.2 s screen targets (desktop logical points) with per-frame
  landmark/quality features. Three of the targets include a blink frame (`eyesVisible: false`)
  that must be rejected and counted, never fitted.
- `calibration.validationTargets` — the five held-out targets whose residuals define the
  calibration's residual covariance.
- `failedCalibration.targets` — nine all-blink targets; calibration must report `accepted: false`
  with `reason: 'calibration_failed'`.
- `referenceScenes` — five held-out deictic references. Each scene has three candidates with equal
  context-only semantics (so the context-only baseline cannot resolve) and frames positioned so a
  correctly calibrated mapping lands on the referred control. `reference-4` also carries a
  distractor glance ~2 s before the ASR word; the §5.11 alignment window
  (`wordAt-700 ms … wordAt+200 ms`) must exclude it.
- `namedTurn` — a phrase that names exactly one candidate; it must resolve by voice
  (`basis: 'named'`) while the camera is denied or the tracking is invalid.
- `trackingLoss.frames` — 15 consecutive unusable frames; after them the runtime reports
  `unavailable` / `tracking_lost` while voice/named targeting keeps working.
- `uncalibratedDisplayFrame` — a frame on the second display, which has no calibration: unknown.
- `ringProbeFrame` — used after an 11 s clock jump to prove the ten-second sample ring is bounded.

The frames are landmark/quality features only (`irisX`, `irisY`, `ear`, `faceX`, `faceY`,
`faceScale`, `yaw`, `pitch`, `roll`). The oracle attaches a canary pixel payload to every frame it
feeds the runtime and asserts the canary never appears in samples, calibration records, statuses
or anything the runtime hands to its persistence sink: camera frames must not persist.

Provenance: generated deterministically (seeded, no live capture) from a linear iris→display
mapping with additive noise, so a standardized second-order ridge fit recovers held-out targets
with realistic webcam uncertainty. Interactive hardware qualification (AVFoundation capture,
MediaPipe landmarks, the 20-participant §5.11 evaluation) remains with its own tickets.
