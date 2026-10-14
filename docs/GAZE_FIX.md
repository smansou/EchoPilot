# Gaze correction — October 11, 2026

The installed app at `/Applications/EchoPilot.app` uses Brown/Pomona WebGazer 3.5.3 for complete local webcam inference, eye-patch regression, and its upstream Kalman filter. Production no longer launches the custom Apple Vision gaze estimator. Camera images stay in the dedicated renderer; only screen coordinates and held-out uncertainty cross into main-process memory.

## Window safety

Calibration uses a normal titled, closable and minimizable window at the ordinary window level. It cannot enter fullscreen and never uses the screen-saver level or appears over all workspaces. Close, Cmd-W, the visible Stop button, Escape, Settings → Turn off gaze, and quitting the app release the session. Escape stays registered after calibration. Renderer loss, display changes and load cancellation tear down the windows. Calibration has a five-minute deadline.

After successful calibration the camera renderer is hidden. Only a 96×96 logical-point, nonfocusable, click-through floating window remains, drawing a 32-point dot and soft halo. No full-screen transparent window is used for tracking. Four Kalman-filtered predictions are buffered; the marker eases over 180ms with a small deadband and bounded speed. Stale tracking hides the marker after 800ms and discards its presentation buffer.

## Accuracy and module provenance

Nine targets collect five distinct camera observations each through WebGazer's calibration API. Five additional targets are never used for training. Their error calculation includes bias and jitter; poor calibration is rejected. Error thresholds are product acceptance gates, not a guarantee of pixel accuracy. Recalibration and real-device acceptance remain necessary after changes in lighting, posture or camera setup.

- Official module: https://github.com/brownhci/WebGazer/releases/tag/3.5.3
- Official package: https://www.npmjs.com/package/webgazer
- Independent validation: https://pmc.ncbi.nlm.nih.gov/articles/PMC11289066/
- User-supplied comparison list: https://github.com/eyes-on-disabilities/awesome-eye-tracking

The published validation supports coarse areas of interest and identifies noise/precision limits. It does not establish precise cursor targeting on this user's Mac. The comparison list also includes WebGazer. Pupil Labs targets specialized hardware; GazeTracking supplies eye directions/ratios rather than a complete calibrated screen tracker; lookie-lookie describes itself as a TensorFlow demo. Research gaze-direction models would require another custom screen-mapping system.

WebGazer 3.5.3 is the final planned upstream release; maintenance is no longer guaranteed. All required MediaPipe models, JavaScript and WASM files are bundled locally. The only upstream runtime patch accepts Electron's secure custom protocol via `isSecureContext`; inference, regression and filtering are unchanged. License and archive SHA-256 are included in `apps/desktop/src/renderer/public/vendor/webgazer/`. Corresponding module sources are retained in `vendor-webgazer-source/`. GPL-3.0-or-later applies. MediaPipe's Emscripten glue needs dynamic function creation; its CSP exception is limited to the dedicated gaze document. Other documents keep their existing restriction. Video permission is limited to the owned gaze renderer; it cannot invoke voice/history commands.

## Verification

- Full `pnpm check`: 646 passed, zero failed/skipped; contracts, types and build passed. Final lifecycle hardening additionally passed typecheck, targeted gaze tests, native-window smoke and packaged startup qualification.
- Three regressions: bad calibration refusal, screen transforms/uncertainty/staleness/display changes, marker buffering/easing on both axes.
- Fourteen real Electron window checks: normal window properties, minimize, native close, cancellation during load, concurrent starts, rejected calibration, small marker, Escape retained after calibration, stale marker hiding, another window receiving focus, Escape cleanup and renderer crashes. `artifacts/gaze-overlay-acceptance.json`.
- Actual WebGazer/MediaPipe inference with a public portrait streamed through a local canvas: 15 detected-face observations, 14 finite Kalman predictions, all tracks released, zero external requests. `artifacts/webgazer-module-acceptance.json`.
- Actual rendered calibration with deterministic predictions: all 45 training observations, held-out targets, hidden-window tracking continuation and complete stop. `artifacts/gaze-renderer-acceptance.json`.
- Actual rendered calibration with real WebGazer and a static public face replay: unusable calibration rejected and tracks released. `artifacts/gaze-real-renderer-acceptance.json`.
- Rendered calibration inspected in `artifacts/gaze-calibration.png`.
- `/private/tmp/EchoPilot-gaze-fixed-20261011.app.qualification.json`: local-qualified; signature, plist and packaged app smoke passed. Local ad-hoc build, not notarized.

No user webcam, microphone, personal face image, provider key or paid provider was used in these tests. These checks establish integration and escape behavior; they do not establish human gaze accuracy. The user should now test Settings → Gaze → Calibrate gaze, vertical/horizontal motion, switching apps and Escape. Voice and session-sync acceptance are separate and unchanged by this fix.
