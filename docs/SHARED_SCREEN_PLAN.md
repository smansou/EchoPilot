# Shared screen attention — implementation and review plan

## Goal

Make natural references such as “this paragraph”, “the button above” and “no, this one” visible and understandable during live conversation. Stabilize coarse webcam gaze with local screen semantics rather than pretending that smoothing provides pixel accuracy.

## Chosen design

1. Keep official local WebGazer inference/regression/Kalman filtering; use its user-paced nine-target/five-click workflow, camera feedback and retry. Measure unseen targets and retain covariance; refuse collapsed or directionally blind fits.
2. Read foreground Accessibility geometry/text ranges locally, with paragraph/sentence boxes only when the app exposes real ranges. Opt-in local Vision OCR is a conservative fallback for windows lacking accessible text targets; it refuses secure/truncated trees and never saves or sends images.
3. Select a stable semantic region using measured gaze covariance plus recent variability, dwell, hysteresis, per-region revisions and stale-scope invalidation. Broad uncertainty selects a large area; narrow text/control targets require stronger evidence. Relative/name search provides voice disambiguation without image analysis.
4. Render a morphing mint/violet frame with four thin, click-through/nonfocusable native edge windows and a small caption outside the selected area. Initial dot-sized frame expands over 220ms; lost attention fades over130ms. Gradients/light flow animate softly; reduced-motion CSS disables decorative loops. Native stop paths remain immediate.
5. Share compact semantic deltas only with the configured voice provider while the user enables “Share what I look at” and live voice is listening. No continuous screenshots, raw webcam frames or raw gaze trajectory enter that stream. Pin the referent when speech arrives and include fresh bounded context in delegated backend requests.
6. `find_screen_target` searches the local map; `focus_screen_target` changes a visual referent only. Actual actions bind to verified native control ancestors and retain fresh spoken confirmation and fingerprint checks. Text areas are descriptive until a supported actionable control is identified; arbitrary dragging/moving and arbitrary commands are not added.

The user approved the screen-derived text feed after an initial automatic-approval rejection. That approval covers the configured OpenAI/Gemini voice path and configured reasoning provider (OpenAI/Gemini/OpenRouter), with explicit runtime sharing. It does not authorize unrelated uploads, secret disclosure or publishing.

## Efficiency policy

- Screen observations are single-flight at roughly700ms cadence while enabled and usable gaze exists. On-demand requests await the same pending observation.
- Local gaze/selection ticks at50ms; only target transitions animate native geometry. Stable targets do not restart placement animation.
- Background semantic packets: at most1/second,1200 UTF-8 bytes/packet,8000 bytes/rolling minute. Cadence and quota survive window/app switches; unchanged semantic state sends nothing.
- Explicit backend screen queries and initial-session snapshots are bounded separately. Tiny revocation notices can bypass the stream quota for safety; audio/provider generation costs are separate. Byte budgets are conservative size limits, not measured token prices.
- OpenAI uses quiet `session.thinking.append` context through the existing adapter, with its existing conservative440-byte chunks. Gemini uses incremental `clientContent` with `turnComplete:false`, and now enables sliding context compression.

## Research references

- WebGazer workflow: https://raw.githubusercontent.com/brownhci/WebGazer/master/www/js/calibration.js
- WebGazer model/limitations: https://webgazer.cs.brown.edu/
- Dwell/forgiving target design: https://learn.microsoft.com/en-us/windows/mixed-reality/design/gaze-and-dwell-eyes
- Apple text bounds: https://developer.apple.com/documentation/appkit/text-specific-parameterized-attributes
- Local Vision text boxes: https://developer.apple.com/documentation/vision/vnrecognizedtext
- Official OpenAI UI-context guidance: https://developers.openai.com/api/docs/guides/live-delegation
- Gemini incremental context: https://ai.google.dev/gemini-api/docs/live-api/capabilities

Published research and vendor documentation guide design; they do not establish that this implementation outperforms existing trackers. Free/open-source alternatives did not establish a complete, validated current-Mac replacement during this investigation.

## Acceptance

Automated: full project checks, native geometry/OCR/control-binding tests, actual WebGazer module replay, calibration UI fixtures, native highlight lifecycle/animation fixtures, selection/cost benchmarks, voice/backend/native-action integration using fake providers, packaged startup qualification.

Human: calibrate with a real face/webcam; inspect a text-heavy app and a control-heavy app; move eyes without moving the mouse; compare area/paragraph specificity; switch windows and scroll; verify Escape and normal app focus; converse about “this”, “that”, “the paragraph above”, and corrections; verify actions ask for confirmation. Private/muted mode and sharing off must revoke the screen context.

Known limits: head-pose/lid-tilt compensation is not added; substantial posture changes require recalibration. Granularity depends on application AX support; OCR currently declines mixed windows that already expose some accessible text. Actual app AX and screen-capture checks need macOS permissions. Actual provider speech quality, latency and billing remain to be measured with user credentials; fixture tests do not establish human conversation quality.
