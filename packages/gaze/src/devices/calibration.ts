/**
 * G03 — dedicated-device calibration: the nine raw targets plus the held-out validation targets
 * become the per-display correction from normalized device gaze to desktop logical points.
 *
 * The fit mirrors the webcam fit's discipline:
 *
 * - only usable observations are fitted — a sample whose per-eye validity is below the usable
 *   threshold is no measurement and is counted as rejected, so every input observation is counted
 *   exactly once in `framesUsed + framesRejected`;
 * - the correction is an affine least-squares map of the normalized gaze point (the device hands
 *   over screen coordinates, not iris geometry, so no polynomial is needed), which also makes the
 *   residuals interpretable as desktop points;
 * - the residual covariance comes from the held-out validation targets only: the fit's own error,
 *   not its training error, and the number the resolver turns into uncertainty;
 * - a fit that cannot be trusted (too little evidence, singular, non-positive-definite or
 *   implausibly large residuals for this display) reports `accepted: false` /
 *   `calibration_failed` instead of becoming a confident wrong answer later.
 */
import {
  isPositiveDefinite,
  sampleCovariance,
  solveLinearSystem,
  ZERO_COVARIANCE,
} from '../numerics.js';
import type { CalibrationRecord, Covariance2x2 } from '../types.js';
import type { DeviceCalibrationPoint, DeviceObservation } from './types.js';

/** Below this per-eye validity the device sample is not a measurement. */
export const DEVICE_VALIDITY_MINIMUM = 0.5;

/** Nine targets already give 27 usable observations in the synthetic session; 12 is the floor. */
export const MINIMUM_DEVICE_FIT_OBSERVATIONS = 12;

/** The residual covariance needs at least two held-out observations to be an estimate at all. */
export const MINIMUM_DEVICE_VALIDATION_OBSERVATIONS = 2;

/** Residual σ may not exceed a fifth of the display's larger side; beyond that the fit is noise. */
export const MAXIMUM_DEVICE_RESIDUAL_SIGMA_RATIO = 0.2;

const DESIGN_WIDTH = 3;
const RIDGE_LAMBDA = 1e-6;

/** Both eyes must have produced a usable measurement; a closed eye is not a sample. */
export function isUsableDeviceObservation(observation: DeviceObservation): boolean {
  return Number.isFinite(observation.leftValidity)
    && Number.isFinite(observation.rightValidity)
    && observation.leftValidity >= DEVICE_VALIDITY_MINIMUM
    && observation.rightValidity >= DEVICE_VALIDITY_MINIMUM;
}

/** The published sample quality: the weaker eye bounds how much this observation is trusted. */
export function deviceObservationQuality(observation: DeviceObservation): number {
  const weakest = Math.min(observation.leftValidity, observation.rightValidity);
  return Math.min(1, Math.max(weakest, Number.EPSILON));
}

/** The fitted mapping: normalized device gaze → desktop logical points. */
export type DeviceGazeFit = Readonly<{
  predict(observation: DeviceObservation): readonly [number, number];
}>;

export type DeviceCalibrationFit = Readonly<{
  fit: DeviceGazeFit | null;
  framesUsed: number;
  framesRejected: number;
  validationFramesUsed: number;
  residualCovariance: Covariance2x2;
  accepted: boolean;
}>;

/** One standardized design vector: [1, gazeX, gazeY]. */
function designVector(observation: DeviceObservation): readonly [number, number, number] {
  return [1, observation.gazeX, observation.gazeY];
}

function dot(coefficients: readonly number[], design: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < coefficients.length; index += 1) {
    total += (coefficients[index] ?? 0) * (design[index] ?? 0);
  }
  return total;
}

/**
 * Fits the device calibration targets and measures the fit against the held-out validation targets.
 * Deterministic: same observations in, same coefficients and covariance out.
 */
export function fitDeviceCalibration(input: Readonly<{
  points: readonly DeviceCalibrationPoint[];
  validationPoints: readonly DeviceCalibrationPoint[];
  maximumResidualSigma: number;
}>): DeviceCalibrationFit {
  const observations: Array<Readonly<{ observation: DeviceObservation; targetX: number; targetY: number }>> = [];
  let framesRejected = 0;
  for (const point of input.points) {
    for (const observation of point.observations) {
      if (!isUsableDeviceObservation(observation)) {
        framesRejected += 1;
        continue;
      }
      observations.push({ observation, targetX: point.x, targetY: point.y });
    }
  }
  const framesUsed = observations.length;
  const rejected: DeviceCalibrationFit = {
    fit: null,
    framesUsed,
    framesRejected,
    validationFramesUsed: 0,
    residualCovariance: ZERO_COVARIANCE,
    accepted: false,
  };
  if (framesUsed < MINIMUM_DEVICE_FIT_OBSERVATIONS) return rejected;

  const normal = Array.from({ length: DESIGN_WIDTH }, () => new Array<number>(DESIGN_WIDTH).fill(0));
  const momentX = new Array<number>(DESIGN_WIDTH).fill(0);
  const momentY = new Array<number>(DESIGN_WIDTH).fill(0);
  for (const entry of observations) {
    const design = designVector(entry.observation);
    for (let row = 0; row < DESIGN_WIDTH; row += 1) {
      momentX[row] = (momentX[row] ?? 0) + (design[row] ?? 0) * entry.targetX;
      momentY[row] = (momentY[row] ?? 0) + (design[row] ?? 0) * entry.targetY;
      const normalRow = normal[row]!;
      for (let column = 0; column < DESIGN_WIDTH; column += 1) {
        normalRow[column] = (normalRow[column] ?? 0) + (design[row] ?? 0) * (design[column] ?? 0);
      }
    }
  }
  // A tiny ridge on the gaze terms only keeps the 3×3 system solvable for degenerate input
  // without biasing an ordinary nine-target session.
  for (let index = 1; index < DESIGN_WIDTH; index += 1) {
    const normalRow = normal[index]!;
    normalRow[index] = (normalRow[index] ?? 0) + RIDGE_LAMBDA;
  }

  const coefficientsX = solveLinearSystem(normal, momentX);
  const coefficientsY = solveLinearSystem(normal, momentY);
  if (!coefficientsX || !coefficientsY) return rejected;

  const predict = (observation: DeviceObservation): readonly [number, number] => {
    const design = designVector(observation);
    return [dot(coefficientsX, design), dot(coefficientsY, design)];
  };
  if (!Number.isFinite(predict(observations[0]!.observation)[0])) return rejected;
  const fit: DeviceGazeFit = { predict };

  const residuals: Array<readonly [number, number]> = [];
  for (const point of input.validationPoints) {
    for (const observation of point.observations) {
      if (!isUsableDeviceObservation(observation)) continue;
      const [predictedX, predictedY] = predict(observation);
      residuals.push([predictedX - point.x, predictedY - point.y]);
    }
  }
  const residualCovariance = sampleCovariance(residuals);
  const accepted = residuals.length >= MINIMUM_DEVICE_VALIDATION_OBSERVATIONS
    && isPositiveDefinite(residualCovariance)
    && Math.sqrt(residualCovariance[0][0]) <= input.maximumResidualSigma
    && Math.sqrt(residualCovariance[1][1]) <= input.maximumResidualSigma;
  return {
    fit,
    framesUsed,
    framesRejected,
    validationFramesUsed: residuals.length,
    residualCovariance,
    accepted,
  };
}

/**
 * Builds the record the runtime stores and hands to the shared resolver. `recordedAt` and the
 * counts come from the caller (the injected clock and the counted observations) so the record
 * replays byte-identically.
 */
export function buildDeviceCalibrationRecord(input: Readonly<{
  displayId: string;
  cameraId: string;
  calibrationGeneration: number;
  displayArrangementGeneration: number;
  recordedAt: string;
  points: readonly DeviceCalibrationPoint[];
  validationPoints: readonly DeviceCalibrationPoint[];
  displayExtent: number;
}>): Readonly<{ record: CalibrationRecord; fit: DeviceGazeFit | null }> {
  const fitted = fitDeviceCalibration({
    points: input.points,
    validationPoints: input.validationPoints,
    maximumResidualSigma: Math.max(input.displayExtent, 1) * MAXIMUM_DEVICE_RESIDUAL_SIGMA_RATIO,
  });
  const base = {
    calibrationGeneration: input.calibrationGeneration,
    displayId: input.displayId,
    cameraId: input.cameraId,
    framesUsed: fitted.framesUsed,
    framesRejected: fitted.framesRejected,
    validationFramesUsed: fitted.validationFramesUsed,
    residualCovariance2x2: fitted.residualCovariance,
    displayArrangementGeneration: input.displayArrangementGeneration,
    recordedAt: input.recordedAt,
  };
  if (!fitted.accepted || !fitted.fit) {
    return { record: { ...base, accepted: false, reason: 'calibration_failed' }, fit: null };
  }
  return { record: { ...base, accepted: true }, fit: fitted.fit };
}
