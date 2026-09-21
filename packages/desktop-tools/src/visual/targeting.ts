/**
 * C03 visual targeting guards: the pure decisions the executor makes against a fresh frame. None of
 * them consult the plan's screenshot for coordinates — the plan only supplies the identity and the
 * rectangle to revalidate, and the fresh frame supplies the point that is actually clicked.
 */
import type {
  VisualBounds,
  VisualClickPoint,
  VisualObservation,
  VisualRoute,
  VisualStopReason,
  VisualTarget,
} from './types.js';

/** §5.3 retention: a screenshot expires from RAM after 60 s, so an older observation is not a plan. */
export const SCREENSHOT_TTL_MS = 60_000;

/** The structured route for a target, if one exists; connector → AX → visual is checked per target. */
export function routeForTarget(
  routes: ReadonlyArray<VisualRoute>,
  targetRef: string,
): VisualRoute | null {
  return routes.find((route) => route.targetRef === targetRef) ?? null;
}

/** An observation older than the RAM retention bound can never authorize a click. */
export function isObservationStale(observation: VisualObservation, atMs: number): boolean {
  return !Number.isFinite(observation.capturedAtMs)
    || atMs - observation.capturedAtMs > SCREENSHOT_TTL_MS;
}

/** The live target the fresh frame reports for the planned ref. */
export function findTarget(
  targets: ReadonlyArray<VisualTarget>,
  targetRef: string,
): VisualTarget | null {
  return targets.find((target) => target.targetRef === targetRef) ?? null;
}

function sameBounds(left: VisualBounds, right: VisualBounds): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

/**
 * The revalidation decision over the fresh frame. A missing target, a replaced identity, or a moved
 * rectangle each stop the coordinate click before it is attempted; only a fresh frame that agrees
 * with the plan's fingerprint and bounds is clickable.
 */
export function targetStopReason(
  observation: VisualObservation,
  liveTarget: VisualTarget | null,
): VisualStopReason | null {
  if (liveTarget === null) return 'target_missing';
  if (liveTarget.fingerprint !== observation.targetFingerprint) return 'target_changed';
  if (!sameBounds(liveTarget.bounds, observation.bounds)) return 'target_moved';
  return null;
}

/** The point the click uses: the centre of the fresh frame's live rectangle, never the plan's. */
export function clickCentre(bounds: VisualBounds): VisualClickPoint {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
