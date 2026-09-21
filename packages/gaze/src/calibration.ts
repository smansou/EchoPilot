/**
 * G01 — webcam calibration: the nine 1.2 s screen targets plus the held-out validation targets
 * become one gaze distribution over the desktop (IMPLEMENTATION_PLAN.md §5.11).
 *
 * The fit is deliberately small and checkable:
 *
 * - only usable frames are fitted — `eyesVisible === false` (blink/occlusion) and low-quality
 *   frames are rejected and counted, never fitted, so every input frame is counted exactly once
 *   in `framesUsed + framesRejected`;
 * - the design is a standardized second-order polynomial of the iris position with a ridge term,
 *   so the nine targets are not asked to invert an ill-conditioned system;
 * - the residual covariance comes from the five held-out targets only: the fit's own error, not
 *   its training error, and the number the resolver turns into uncertainty;
 * - a fit that cannot be trusted (too little evidence, singular, non-positive-definite or
 *   implausibly large residuals for this display) reports `accepted: false` /
 *   `calibration_failed` instead of becoming a confident wrong answer later.
 */
import { isPositiveDefinite, mean, populationStandardDeviation, sampleCovariance, solveLinearSystem, ZERO_COVARIANCE } from './numerics.js';
import type { CalibrationPoint, CalibrationRecord, Covariance2x2, LandmarkFrame } from './types.js';

/** Below this eye-aspect ratio the eye is not open enough to be a measurement. */
export const EYES_VISIBLE_EAR_MINIMUM = 0.15;

/** Below this per-frame quality the landmark estimate is not trustworthy. */
export const FRAME_QUALITY_MINIMUM = 0.5;

/** Nine targets already give 45 usable frames in the synthetic session; 12 is the floor. */
export const MINIMUM_FIT_FRAMES = 12;

/** The residual covariance needs at least two held-out observations to be an estimate at all. */
export const MINIMUM_VALIDATION_FRAMES = 2;

/** Residual σ may not exceed a fifth of the display's larger side; beyond that the fit is noise. */
export const MAXIMUM_RESIDUAL_SIGMA_RATIO = 0.2;

const RIDGE_LAMBDA = 0.1;
const DESIGN_WIDTH = 6;

/** The fitted mapping: landmark features → desktop logical points. */
export type GazeFit = Readonly<{
  predict(frame: LandmarkFrame): readonly [number, number];
}>;

export type CalibrationFit = Readonly<{
  fit: GazeFit | null;
  framesUsed: number;
  framesRejected: number;
  validationFramesUsed: number;
  residualCovariance: Covariance2x2;
  accepted: boolean;
}>;

/** Blink/occlusion and low-quality frames are rejected, never fitted. */
export function isUsableFrame(frame: LandmarkFrame): boolean {
  return frame.eyesVisible === true
    && Number.isFinite(frame.quality)
    && frame.quality >= FRAME_QUALITY_MINIMUM
    && Number.isFinite(frame.features.ear)
    && frame.features.ear >= EYES_VISIBLE_EAR_MINIMUM;
}

/** One standardized second-order design vector: [1, a, b, a², b², ab]. */
function designVector(
  frame: LandmarkFrame,
  centerX: number,
  centerY: number,
  scaleX: number,
  scaleY: number,
): readonly number[] {
  const a = (frame.features.irisX - centerX) / scaleX;
  const b = (frame.features.irisY - centerY) / scaleY;
  return [1, a, b, a * a, b * b, a * b];
}

function dot(coefficients: readonly number[], design: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < coefficients.length; index += 1) total += (coefficients[index] ?? 0) * (design[index] ?? 0);
  return total;
}

/**
 * Fits the calibration targets and measures the fit against the held-out validation targets.
 * Deterministic: same points in, same coefficients and covariance out.
 */
export function fitGazeCalibration(input: Readonly<{
  points: readonly CalibrationPoint[];
  validationPoints: readonly CalibrationPoint[];
  maximumResidualSigma: number;
}>): CalibrationFit {
  const observations: Array<Readonly<{ frame: LandmarkFrame; targetX: number; targetY: number }>> = [];
  let framesRejected = 0;
  for (const point of input.points) {
    for (const frame of point.frames) {
      if (!isUsableFrame(frame)) {
        framesRejected += 1;
        continue;
      }
      observations.push({ frame, targetX: point.x, targetY: point.y });
    }
  }
  const framesUsed = observations.length;
  const rejected: CalibrationFit = {
    fit: null,
    framesUsed,
    framesRejected,
    validationFramesUsed: 0,
    residualCovariance: ZERO_COVARIANCE,
    accepted: false,
  };
  if (framesUsed < MINIMUM_FIT_FRAMES) return rejected;

  const irisX = observations.map((observation) => observation.frame.features.irisX);
  const irisY = observations.map((observation) => observation.frame.features.irisY);
  const centerX = mean(irisX);
  const centerY = mean(irisY);
  const scaleX = populationStandardDeviation(irisX) || 1;
  const scaleY = populationStandardDeviation(irisY) || 1;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return rejected;

  const normal = Array.from({ length: DESIGN_WIDTH }, () => new Array<number>(DESIGN_WIDTH).fill(0));
  const momentX = new Array<number>(DESIGN_WIDTH).fill(0);
  const momentY = new Array<number>(DESIGN_WIDTH).fill(0);
  for (const observation of observations) {
    const design = designVector(observation.frame, centerX, centerY, scaleX, scaleY);
    for (let row = 0; row < DESIGN_WIDTH; row += 1) {
      momentX[row] = (momentX[row] ?? 0) + (design[row] ?? 0) * observation.targetX;
      momentY[row] = (momentY[row] ?? 0) + (design[row] ?? 0) * observation.targetY;
      const normalRow = normal[row]!;
      for (let column = 0; column < DESIGN_WIDTH; column += 1) {
        normalRow[column] = (normalRow[column] ?? 0) + (design[row] ?? 0) * (design[column] ?? 0);
      }
    }
  }
  for (let index = 1; index < DESIGN_WIDTH; index += 1) {
    const normalRow = normal[index]!;
    normalRow[index] = (normalRow[index] ?? 0) + RIDGE_LAMBDA;
  }

  const coefficientsX = solveLinearSystem(normal, momentX);
  const coefficientsY = solveLinearSystem(normal, momentY);
  if (!coefficientsX || !coefficientsY) return rejected;

  const predict = (frame: LandmarkFrame): readonly [number, number] => {
    const design = designVector(frame, centerX, centerY, scaleX, scaleY);
    return [dot(coefficientsX, design), dot(coefficientsY, design)];
  };
  const fit: GazeFit = { predict };

  const residuals: Array<readonly [number, number]> = [];
  for (const point of input.validationPoints) {
    for (const frame of point.frames) {
      if (!isUsableFrame(frame)) continue;
      const [predictedX, predictedY] = predict(frame);
      residuals.push([predictedX - point.x, predictedY - point.y]);
    }
  }
  const residualCovariance = sampleCovariance(residuals);
  const accepted = residuals.length >= MINIMUM_VALIDATION_FRAMES
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
 * Builds the record the runtime stores and hands to the resolver. `recordedAt` and the counts come
 * from the caller (the injected clock and the counted frames) so the record replays byte-identically.
 */
export function buildCalibrationRecord(input: Readonly<{
  displayId: string;
  cameraId: string;
  calibrationGeneration: number;
  displayArrangementGeneration: number;
  recordedAt: string;
  points: readonly CalibrationPoint[];
  validationPoints: readonly CalibrationPoint[];
  displayExtent: number;
}>): Readonly<{ record: CalibrationRecord; fit: GazeFit | null }> {
  const fitted = fitGazeCalibration({
    points: input.points,
    validationPoints: input.validationPoints,
    maximumResidualSigma: Math.max(input.displayExtent, 1) * MAXIMUM_RESIDUAL_SIGMA_RATIO,
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
