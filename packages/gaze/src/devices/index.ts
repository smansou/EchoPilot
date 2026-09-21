/**
 * G03 — the dedicated-device gaze seam the app imports (IMPLEMENTATION_PLAN.md §7.2 G03; §5.11).
 *
 *   createDedicatedGazeDevice({ now, displays, bridge, persist? })
 *     connect({ displayId }) → status (never rejects; a missing device/SDK/permission is a value)
 *     disconnect() → stops the helper stream, unsubscribes and invalidates gaze immediately
 *     calibrate({ displayId, points, validationPoints }) → per-display accepted/rejected record
 *     ingest(observation) → a §5.11 sample in desktop logical points | null
 *     samples() → the bounded ten-second ring, cleared by a disconnect
 *
 *   qualifyDeviceCombination({ combination, bridge, display, probe }) → the executed checks
 *   listSupportedDeviceCombinations() → the tested device/SDK/OS matrix
 *
 * Device observations map onto the same `GazeSample`/`GazeEvidence` schema the webcam runtime
 * publishes, so the shared G01 resolver and the G02 confirmation/action rules consume device
 * evidence through the identical path. Device payloads never cross this seam.
 */
export * from './types.js';
export * from './calibration.js';
export * from './runtime.js';
export * from './qualification.js';
