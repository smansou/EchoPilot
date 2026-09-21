/**
 * C03 — visual target → scoped desktop action → verification
 * (IMPLEMENTATION_PLAN.md §7.2 C03; §5.4 "Prefer connector → AX → visual in that order" and the C
 * flow "revalidate target → execute one bounded step → inspect resulting state → record receipt";
 * §5.3 retention: screenshots expire from RAM after 60 seconds).
 *
 * `createVisualCoordinateExecutor({ capture, pointer, now, scope, routes })` is the last-resort
 * coordinate path behind the structured connector and Accessibility routes. It guarantees:
 *
 * - ordering: a target a connector/AX route already serves is denied `structured_route_available`
 *   and is never clicked by coordinates, so the cheaper structured path is always preferred;
 * - freshness: an observation captured more than `SCREENSHOT_TTL_MS` (60 s, the RAM retention
 *   bound) before execution is denied `screenshot_stale` with zero clicks and zero captures, even
 *   when the current frame would still match — a stale screenshot is not a plan;
 * - liveness: the click point is derived from a frame captured now, under the explicit project
 *   scope, never from the caller's screenshot. A fresh frame that no longer contains the target
 *   (`target_missing`), reports another fingerprint (`target_changed`), or reports another rectangle
 *   (`target_moved`) is denied with zero clicks and only the pre-click frame as evidence;
 * - bounded execution: exactly one pointer click is issued, at the centre of the fresh frame's
 *   rectangle, and the action is then verified against the surface: the post-click frame must show
 *   the same identity with an advanced `stateVersion`, otherwise the outcome is `failed` with
 *   `verification_failed` and never claims `completed`.
 *
 * Evidence ids are derived, not invented: the pre-click fresh frame is `vis:before:<actionId>` and
 * the post-click frame is `vis:after:<actionId>`. A refusal that captured nothing reports no
 * evidence. The clock is injected, so the staleness bound is evaluated deterministically, and the
 * native counterpart of the capture seam is `native/macos/Sources/Capture` (ScreenCaptureKit),
 * whose real frame freshness, Retina/multi-display transforms and pointer synthesis need the
 * separate hardware qualification pass.
 */
import { beforeEvidenceId, clickEvidenceIds } from './evidence.js';
import {
  clickCentre,
  findTarget,
  isObservationStale,
  routeForTarget,
  targetStopReason,
} from './targeting.js';
import type {
  VisualClickPoint,
  VisualCoordinateExecutor,
  VisualObservation,
  VisualOptions,
  VisualOutcome,
  VisualStopReason,
  VisualTarget,
} from './types.js';

export type {
  VisualBounds,
  VisualCapture,
  VisualCaptureSource,
  VisualClickPoint,
  VisualCoordinateExecutor,
  VisualObservation,
  VisualOptions,
  VisualOutcome,
  VisualPointer,
  VisualRoute,
  VisualStopReason,
  VisualTarget,
} from './types.js';
export { SCREENSHOT_TTL_MS, clickCentre, findTarget, isObservationStale, routeForTarget, targetStopReason } from './targeting.js';
export { afterEvidenceId, beforeEvidenceId, clickEvidenceIds } from './evidence.js';

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`C03: ${field} must be a non-empty string`);
  }
  return value;
}

/** A refusal before the click: nothing was clicked, and (for route/staleness) nothing was captured. */
function denied(
  actionId: string,
  reason: VisualStopReason,
  evidenceIds: ReadonlyArray<string>,
): VisualOutcome {
  return { actionId, status: 'denied', reason, clickPoint: null, evidenceIds };
}

export function createVisualCoordinateExecutor(options: VisualOptions): VisualCoordinateExecutor {
  const { capture, pointer, now, scope, routes } = options;
  const projectId = scope.projectId;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new TypeError(
      'C03: createVisualCoordinateExecutor requires an explicit project scope (scope.projectId); '
      + 'a coordinate click is never issued outside a project.',
    );
  }

  async function click(input: Readonly<{
    actionId: string;
    targetRef: string;
    observation: VisualObservation;
  }>): Promise<VisualOutcome> {
    const actionId = requireText(input.actionId, 'actionId');
    const targetRef = requireText(input.targetRef, 'targetRef');
    const { observation } = input;

    // connector → AX → visual: a target a structured route already serves is never clicked here.
    if (routeForTarget(routes, targetRef) !== null) {
      return denied(actionId, 'structured_route_available', []);
    }

    // A stale screenshot is not a plan: refuse it before capturing anything at all.
    const atMs = now().getTime();
    if (!Number.isFinite(atMs)) {
      throw new TypeError('C03: the injected clock returned an invalid date');
    }
    if (isObservationStale(observation, atMs)) {
      return denied(actionId, 'screenshot_stale', []);
    }

    // The click is derived from a frame captured now, under the explicit project scope.
    const before = await capture.capture({ scope });
    const liveTarget = findTarget(before.targets, targetRef);
    const stop = targetStopReason(observation, liveTarget);
    if (stop !== null || liveTarget === null) {
      return denied(actionId, stop ?? 'target_missing', [beforeEvidenceId(actionId)]);
    }

    const clickPoint: VisualClickPoint = clickCentre(liveTarget.bounds);
    await pointer.click({ x: clickPoint.x, y: clickPoint.y });

    // Verified against the surface, never by the click call returning.
    const after = await capture.capture({ scope });
    const evidenceIds = clickEvidenceIds(actionId);
    const afterTarget: VisualTarget | null = findTarget(after.targets, targetRef);
    const verified = afterTarget !== null
      && afterTarget.fingerprint === liveTarget.fingerprint
      && afterTarget.stateVersion > liveTarget.stateVersion;
    if (!verified) {
      return {
        actionId,
        status: 'failed',
        reason: 'verification_failed',
        clickPoint,
        evidenceIds,
      };
    }
    return { actionId, status: 'completed', clickPoint, evidenceIds };
  }

  return { click };
}
