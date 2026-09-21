/**
 * G01 — webcam calibration → gaze distribution → resolve a spoken read-only reference
 * (IMPLEMENTATION_PLAN.md §5.11).
 *
 * The seam the app imports:
 *
 *   createWebcamGazeRuntime({ now, camera, displays, persist? })
 *     start(displayId) → status (never rejects; denial is `camera_denied`)
 *     calibrate({ displayId, points, validationPoints }) → accepted/rejected record
 *     ingest(frame) → calibrated sample | null (blink, low quality, unknown/stale display)
 *     samples() → the bounded ten-second ring (timestamps, transforms, uncertainty, generation)
 *
 *   createReferenceResolver({ now? })
 *     resolve({ utteranceId, turnId, phrase, candidates, gaze }) → resolved | clarify | abstain
 *
 * Camera frames never cross this seam: the runtime takes landmark/quality features, every
 * published type is metadata, and the optional persistence sink only sees gaze metadata.
 */
export * from './types.js';
export * from './numerics.js';
export * from './calibration.js';
export * from './runtime.js';
export * from './resolution.js';
