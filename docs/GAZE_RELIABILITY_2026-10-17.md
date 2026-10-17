# Gaze and outlining investigation — October 17, 2026

User reports severe jitter, edge exclusion, tracking loss and absent outlines. These
reports override earlier fixture success: personal gaze accuracy is not accepted.

Source starts at `c7b910b` (latest installed camera-framing implementation), in
`/Users/sobhi/.codex/worktrees/23fd/EchoPilot`, branch `bugfix/reliable-gaze-outlines`.

## Confirmed defects and changes

- WebGazer's callback returns unbounded predictions. The host rejected off-screen
  values, making edge extrapolation look like lost tracking. Renderer now bounds
  filtered coordinates to the physical display, including negative origins.
- Marker placement clamped its 96-point window inside the display, keeping its
  centre 48 points from every edge. A native constraint also moved the marker below
  the macOS menu bar. `enableLargerThanScreen` removes that native constraint; the
  actual marker stays 96×96 and its orb moves within the window to reach all edges.
- Upstream Kalman uses a fixed time step and retains velocity through gaps. Disable
  it and apply a three-observation median plus timestamp-based adaptive low-pass
  filter. Validation uses the same filtered signal as tracking. The ridge fit is frozen once before independent validation. No claim of
  explicit head-pose compensation.
- Reject closed/degenerate eye landmarks for calibration and tracking. After 250ms
  without usable eyes, clear host samples and marker; reacquire with fresh samples
  without retraining. Camera-stall teardown remains separate.
- Remove the second four-sample presentation average; interpolate at 40ms rather
  than adding another 180ms delay. Semantic history shrinks from 450ms to 180ms.
- Calibration trains nearer edges and independently validates near all four corners.
  Stop and progress controls stay away from the targets. Moves smoothly between targets and automatically collects 45 spaced training
  observations during stationary pauses; no training clicks. Five independent checks
  each require at least 20 fresh observations.
- The host imposed a minimum sigma of 40 points while fine targets required sigma
  at most 35. Fine targets were therefore impossible. Preserve measured errors with
  a small 4-point numerical floor instead; do not reduce measured real uncertainty.
- Interactive AX reading now requests a 450ms traversal budget. The default 2s
  traversal could exceed the outline's 1.2s scene expiry before delivery. Explicit
  screen reads keep their existing budget. Stale scenes still expire; OCR and a slow
  individual AX call can still exceed the budget and must not become trusted targets.
- Retain actual window geometry as a coarse fallback when no child exposes usable
  boxes, except secure-only scenes. Never invent text/object bounds.
- Settings expose numerical calibration accuracy; outlining reports settling and
  ambiguity instead of only saying the local context is ready.

## Calibration architecture assessment

WebGazer 3.5.3 is its final planned release; official maintenance ended February 24,
2026: https://github.com/brownhci/WebGazer/releases/tag/3.5.3

Smooth-pursuit calibration is established, and a webcam study found its best
fixation result by combining fixation and pursuit calibration:
https://pure.mpg.de/rest/items/item_3386007_3/component/file_3477673/content

A moving target alone does not improve the current estimator. Training must account
for eye-following delay, blinks, screen coverage and the regressor's 50-record window.
Recommended next comparison: hands-free moving transitions with stationary collection
and independent validation, then a properly aligned continuous alternative. This
is now implemented as stationary sampling with animated transitions, without claiming superiority over a properly aligned continuous-pursuit model. The user's actual webcam check is the
required next evidence; passing synthetic tests is not completion of the product goal.

## Verification

- Full pre-native-change check: 708 tests, contracts, types and build pass. Restricted
  run failed only the localhost connector fixtures; host-context run passed.
- Focused signal tests cover single-frame spikes, 10/15/30Hz motion, no overshoot,
  stale/duplicate samples, reacquisition, blink geometry and negative-origin edges.
- Production host-to-attention test confirms fine sentence selection is possible
  with genuinely small measured errors; coarse measured uncertainty stays intact.
- Native Accessibility suite: 53 XCTest + 2 Swift Testing tests pass.
- Native highlight fixture passes actual ordinary-window focus, click-through,
  geometry, concurrent setup, cleanup and recovery checks. No private capture.
- Rendered calibration orchestration passes 800×600 layout, training freshness,
  independent checks, loss/retry and camera cleanup with synthetic landmarks.
- Full production-root camera/renderer/host/native-marker fixture passes all four
  physical screen corners, eye-loss invalidation and reacquisition, independent pointer
  visibility, Stop releasing both streams, and reuse of a saved fit with zero training
  records on restart. Synthetic restart check: 12,762ms.
- Stall variant passes: full initial synthetic calibration 24,651ms; sustained source
  stall closes both windows and releases both streams in 2,523ms.
- Compact 800×600 variant passes actual target/preview/Stop/help geometry.
- Actual vendored WebGazer/MediaPipe portrait replay verifies 240 frozen coefficients
  agree with upstream predictions within rounding and restore into an empty module.
- Full final project check: 717 tests, generated contracts, types and build pass.
- Settings fixture verifies Start/Stop, pointer independence, display-disconnect recovery,
  and permission grant followed by focus updating the UI without a restart.

No paid provider requests or user's camera images have been used in these checks.

## Saved calibration and voice lifecycle

`webgazer-model.ts` derives the same ridge solution once from the pinned module's
numeric training data and uses the module's own feature extraction during inference.
This removes two 120×120 regression solves from every frame. Persist only the fitted
240 coefficients and compatibility metadata; no patches or training features enter
`gaze-profile.enc`. Electron safeStorage encrypts it in the existing user-data folder.
Camera/crop, display transform and viewport changes invalidate reuse. Ignore at most
two logical points of native frame rounding; independent checks remain required. A
failed reuse check invalidates that saved fit rather than repeatedly retrying it.

Start/Stop gaze works independently of voice. Separate opt-in settings start gaze with
live voice or smart dictation; automatic gaze stops with the owning session. Manually
started gaze remains independent. Hiding the pointer leaves outlines and context active.
Outlines default on after accepted calibration. Smart dictation retains AX/local OCR and
screenshot fallback with gaze off. A stale/lost gaze no longer suppresses that fallback.

Permission UI refreshes on focus and every two seconds. A fresh native helper reads
current AX and screen-recording authorization; screenshot fallback also uses that fresh
permission result. Media permission requests remain restricted to their intended renderer.
Actual OS permission toggling and human camera accuracy still require user acceptance.

## Latest candidate

Candidate: `/private/tmp/EchoPilot-handsfree-final-20261017.app`.
Previous candidate `/private/tmp/EchoPilot-handsfree-20261017.app` was local-qualified;
final candidate has the additional saved-fit invalidation path. Do not install an older
reliability-only candidate. Final qualification/installation and human acceptance are
recorded in the latest LIVE_HANDOFF entry once completed.


Final candidate is now **local-qualified and installed** at `/Applications/EchoPilot.app`.
Installed signature verifies; main, preload, renderer index and native observer hashes
match the qualified candidate. Relaunched successfully. Rollback is
`/private/tmp/EchoPilot-before-handsfree-20261017.app`. Existing user data is preserved.
The user is testing actual calibration, natural tracking and saved-fit reuse; acceptance
remains pending. No calibration/profile values from the user's camera are in this log.
