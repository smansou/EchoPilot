/**
 * G01 — deterministic numerics for the calibrated gaze seam (IMPLEMENTATION_PLAN.md §5.11).
 *
 * The runtime makes three numeric promises it has to keep on every replay: a ridge fit from
 * landmark features to desktop logical points, an uncertainty estimate for that fit, and the mass
 * of the gaze distribution over a control's rectangle. All three are closed form and clock-free,
 * so the same session resolves byte-identically.
 */
import type { Covariance2x2 } from './types.js';

/** A rectangle in desktop logical points — the same space as gaze samples and display transforms. */
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** "No estimate": used while a calibration is unusable, never as a claim of zero uncertainty. */
export const ZERO_COVARIANCE: Covariance2x2 = [
  [0, 0],
  [0, 0],
];

/** Abramowitz & Stegun 7.1.26; |ε| ≤ 1.5e-7, orders of magnitude below the read-only thresholds. */
export function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  if (x > 6) return sign;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/** Φ(z): the standard normal cumulative distribution. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Population σ (ddof 0): the standardization the landmark design was verified with. */
export function populationStandardDeviation(values: readonly number[]): number {
  const center = mean(values);
  if (!Number.isFinite(center)) return Number.NaN;
  let total = 0;
  for (const value of values) total += (value - center) ** 2;
  return Math.sqrt(total / values.length);
}

/** Unbiased sample covariance (ddof 1). Fewer than two pairs is "no estimate", not zero noise. */
export function sampleCovariance(pairs: readonly (readonly [number, number])[]): Covariance2x2 {
  if (pairs.length < 2) return ZERO_COVARIANCE;
  const centerX = mean(pairs.map(([x]) => x));
  const centerY = mean(pairs.map(([, y]) => y));
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y] of pairs) {
    xx += (x - centerX) ** 2;
    yy += (y - centerY) ** 2;
    xy += (x - centerX) * (y - centerY);
  }
  const denominator = pairs.length - 1;
  return [
    [xx / denominator, xy / denominator],
    [xy / denominator, yy / denominator],
  ];
}

/** Symmetric and strictly positive definite: a real uncertainty, not a point claim. */
export function isPositiveDefinite(covariance: Covariance2x2): boolean {
  const [[xx, xy], [yx, yy]] = covariance;
  return Number.isFinite(xx)
    && Number.isFinite(xy)
    && Number.isFinite(yx)
    && Number.isFinite(yy)
    && xx > 0
    && yy > 0
    && xx * yy - xy * yx > 0;
}

/**
 * Gauss–Jordan elimination with partial pivoting. Deterministic (largest-magnitude pivot, first
 * row wins ties) and nullable on purpose: a singular normal-equation system is a calibration that
 * must be rejected, never a throw that would take the conversation down with it.
 */
export function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): readonly number[] | null {
  const size = rhs.length;
  if (size === 0) return null;
  const rows: number[][] = [];
  for (let row = 0; row < size; row += 1) {
    const source = matrix[row];
    if (!source || source.length < size) return null;
    rows.push([...source.slice(0, size), rhs[row] ?? Number.NaN]);
  }
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivotRow]![column]!)) pivotRow = row;
    }
    const pivot = rows[pivotRow]![column]!;
    if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-12) return null;
    const swap = rows[column]!;
    rows[column] = rows[pivotRow]!;
    rows[pivotRow] = swap;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]! / rows[column]![column]!;
      if (factor === 0) continue;
      for (let index = column; index <= size; index += 1) {
        rows[row]![index] = rows[row]![index]! - factor * rows[column]![index]!;
      }
    }
  }
  const solution: number[] = [];
  for (let row = 0; row < size; row += 1) {
    const value = rows[row]![size]! / rows[row]![row]!;
    if (!Number.isFinite(value)) return null;
    solution.push(value);
  }
  return solution;
}

const QUADRATURE_PANELS = 96;
const SIGMA_SPAN = 8;

/**
 * ∫∫ N(μ, Σ) over `rect`, evaluated as ∫ f_x(x) · [Φ(y₂|x) − Φ(y₁|x)] dx with the composite
 * Simpson rule. The x-interval is clamped to μ ± 8σ so a candidate far from the gaze mean scores
 * ~0 instead of picking up quadrature dust — which is exactly the evidence the resolver needs.
 */
export function rectangleMass(
  meanPoint: readonly [number, number],
  covariance: Covariance2x2,
  rect: Rect,
): number {
  const [centerX, centerY] = meanPoint;
  const [[xx, xy], [, yy]] = covariance;
  const sigmaX = Math.sqrt(Math.max(xx, 1e-9));
  const sigmaY = Math.sqrt(Math.max(yy, 1e-9));
  const correlation = clamp(xy / (sigmaX * sigmaY), -0.999, 0.999);
  const conditionalSpread = Math.sqrt(Math.max(1 - correlation * correlation, 1e-12));
  const low = Math.max(rect.x, centerX - SIGMA_SPAN * sigmaX);
  const high = Math.min(rect.x + rect.width, centerX + SIGMA_SPAN * sigmaX);
  if (!(high > low)) return 0;
  const step = (high - low) / QUADRATURE_PANELS;
  const normalizer = 1 / (sigmaX * Math.sqrt(2 * Math.PI));
  let total = 0;
  for (let index = 0; index <= QUADRATURE_PANELS; index += 1) {
    const x = low + index * step;
    const z = (x - centerX) / sigmaX;
    const density = normalizer * Math.exp(-0.5 * z * z);
    const conditionalMean = centerY + correlation * (sigmaY / sigmaX) * (x - centerX);
    const conditionalSd = sigmaY * conditionalSpread;
    const probability = clamp(
      normalCdf((rect.y + rect.height - conditionalMean) / conditionalSd)
        - normalCdf((rect.y - conditionalMean) / conditionalSd),
      0,
      1,
    );
    const weight = index === 0 || index === QUADRATURE_PANELS ? 1 : index % 2 === 0 ? 2 : 4;
    total += weight * density * probability;
  }
  return (total * step) / 3;
}
