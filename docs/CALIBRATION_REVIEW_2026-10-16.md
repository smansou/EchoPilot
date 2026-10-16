# Calibration review — October 16, 2026

## User failure and consumer requirements

The October15 installed build failed real-user calibration with 319 screen points of measured error. This is a human acceptance failure, despite the earlier passing integration tests. The user requested an intuitive illustrated tutorial, larger face feedback under the camera, instructions visible where they are looking, and an evidence-based accuracy/duration strategy.

The aggregate score cannot diagnose that attempt retrospectively: it contained neither the per-axis response nor the per-area summaries needed to distinguish a collapsed fit, a blind direction, excessive jitter or an isolated bad region. No webcam image, landmarks or user gaze recording was collected in this continuation. No claim that the 319-point cause is fixed is justified.

## Configuration decision

Keep upstream WebGazer3.5.3 ridge regression, MediaPipe eye patches and its Kalman setting. Keep nine user-confirmed targets, five deliberate clicks each, centre last. Reposition the upper middle target below the persistent preview so the target is visible; this is an application layout adjustment, not the exact upstream demo geometry.

The vendored `util_regression.mjs` constructs coupled 50-row click windows for coordinates, eye features and records; `util.mjs` overwrites old rows at capacity. Our45 records fit. Simply requesting more clicks or more targets can erase early spatial coverage. There is no supported high-accuracy preset. `ridgeWeighted` emphasizes recent samples; threaded ridge has limitations. Neither is established as better for this user. Avoid a misleading accuracy slider, changing model internals, or relaxing the acceptance threshold to manufacture success.

Available upstream controls include regression selection, Kalman enablement, camera constraints, preview dimensions, visible feedback and explicit click recording. These are implementation controls, not guarantees of accuracy. The upstream filter has fixed tuning and no validated personal accuracy setting. Further model/filter changes need measured held-out spatial error and jitter/latency, rather than finite predictions or appearance alone.

Primary references: [official calibration workflow](https://github.com/brownhci/WebGazer/blob/master/www/js/calibration.js), [official API](https://github.com/brownhci/WebGazer/wiki/Top-Level-API). Exact shipped behaviour was also checked directly against `vendor-webgazer-source/{index,params,util,util_regression,ridgeReg,ridgeWeightedReg,facemesh}.mjs`.

## Implemented changes

- Three short illustrated tutorial cards with Next/Back, subtle transitions and reduced-motion support. Camera startup begins only after Start camera.
- A240×180 camera preview centred near the top. Separate camera readiness screen requires600ms of fresh, green feedback and an explicit Begin calibration. Feedback remains visible throughout calibration.
- Guidance follows each target instead of requiring bottom-of-screen reading. Target settling is explained. Accepted clicks require a new face observation, at least250ms spacing and800ms settling after target changes; the upstream regressor must confirm each record was added.
- Five unseen targets remain independent of training. Each requires a1second settling period followed by at least20 unique finite observations and1.8seconds of measurement. Sustained loss/poor face feedback pauses and resets the current measurement; a single unusable eye patch can be skipped. Focus loss also clears in-progress measurement. A15second per-check timeout remains bounded.
- Startup/retry operations are serialized. A renderer-owned module is discarded after cleanup so a new attempt does not resume its previous inference loop. Explicit Stop releases camera tracks before closing the overlay.
- Failure gives a choice to review setup or continue without gaze. The acceptance thresholds and collapsed/directionally-blind rejection remain in force. Numerical diagnostics explain which check failed, per-area error/bias/jitter and observation counts, in memory only; no camera images, screen text, landmarks or raw trajectory are stored or shared by these diagnostics.

## Verification and limits

Full project checks passed699 tests with zero failures/skips, plus contracts, types and build; log `/private/tmp/echopilot-calibration-check-20261016.log`. Final small UI/cleanup refinements receive focused renderer/type/build verification rather than another unchanged full suite.

Renderer fixtures use simulated observations, not the user's camera. They verify tutorial-before-camera, readiness, deliberate clicks, stale/duplicate/rapid rejection, validation loss/reset/recovery, retry cleanup and layout at800×600. Settled tutorial/setup/training/result screenshots are in `/private/tmp/echopilot-calibration-20261016-*.png` and were visually reviewed. The production-protocol renderer smoke also exercises the actual calibration host, hidden tracking/marker and Stop lifecycle using a fake module. This smoke's previous `--real` flag is explicitly gated; existing actual-WebGazer module replay is a separate script and is not human accuracy evidence.

Packaging/install and native-safety results are recorded at the final checkpoint. Consumer reliability is still unproven. Webcam mapping and posture/lid-tilt robustness remain limitations; a tutorial does not solve estimator accuracy. The next real-device check should first assess clarity of setup and whether the held-out fit succeeds. If it fails again, inspect the newly exposed Calibration details rather than sending the user through repeated unchanged attempts. Do not claim that increasing calibration duration improves accuracy without a measured comparison.
