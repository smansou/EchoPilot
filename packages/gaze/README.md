# @echopilot/gaze (G01)

Webcam calibration → gaze distribution → resolve a spoken read-only reference
(IMPLEMENTATION_PLAN.md §5.11). The package is the TypeScript half of the seam: the native worker
produces landmark/quality features, and everything below the type boundary is metadata —
timestamps, display transforms, uncertainty and calibration generations. Camera frames never cross
it, so nothing here can retain or persist a frame.

## Surface

```ts
const runtime = createWebcamGazeRuntime({ now, camera, displays, persist? });
await runtime.start('display-main');            // never rejects: denial is `camera_denied`
const calibration = runtime.calibrate({ displayId, points, validationPoints });
const sample = runtime.ingest(frame);           // GazeSample | null (blink, low quality, stale)
runtime.samples();                              // the bounded ten-second ring
runtime.status();                               // re-evaluated against the live arrangement

const resolver = createReferenceResolver({ now? });
resolver.resolve({ utteranceId, turnId, phrase, candidates, gaze });
```

## Rules the implementation keeps

- **Calibration**: only usable frames (`eyesVisible`, `ear ≥ 0.15`, `quality ≥ 0.5`) are fitted;
  every other frame is counted in `framesRejected`. The residual covariance comes from the held-out
  validation targets, and an untrustworthy fit reports `accepted: false` /
  `calibration_failed` instead of becoming a confident wrong answer later.
- **Samples**: each one carries the frame's `capturedAt`, the transform it was produced under, a
  symmetric positive-definite covariance (the fit's residual covariance inflated by frame quality),
  the frame quality and the calibration generation. The ring keeps ten seconds, pruned on push and
  on read, so a clock jump cannot resurrect an older glance.
- **Generations**: a changed `arrangementGeneration` makes the calibration stale immediately —
  `status()` reports it without waiting for another frame, `ingest()` returns null, and a
  resolution abstains (`calibration_stale`) rather than combining retired evidence with a new fit.
- **Resolution**: a spoken name resolves on its own; otherwise only gaze inside
  `[wordAt − 700 ms, wordAt + 200 ms]` counts, aggregated into one distribution whose mass over
  each enabled candidate gives the probability. Read-only resolution needs top ≥ 0.80 and margin
  ≥ 0.20; below that the outcome names two or three candidates and asks.
- **Failure is a value**: camera denial and tracking loss surface through `status()`
  (`camera_denied`, `tracking_lost`) while voice/named targeting keeps working, because gaze is
  optional evidence.

## Validation

`packages/gaze/test/g01.acceptance.test.ts` is the frozen oracle:

```sh
node --import tsx --test packages/gaze/test/g01.acceptance.test.ts
```

It replays the synthetic session in `fixtures/gaze/g01-webcam-session.json` (nine calibration
targets with blink frames, five held-out validation targets, five held-out deictic references with
a distractor glance, a named turn, a tracking-loss burst, an uncalibrated second display and a ring
probe) entirely through injected clocks and fakes. AVFoundation capture, the MediaPipe landmark
worker, camera-permission dialogs and the 20-participant §5.11 evaluation are interactive hardware
qualification and remain with their own tickets.
