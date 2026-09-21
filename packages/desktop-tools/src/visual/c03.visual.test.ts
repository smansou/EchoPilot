/**
 * C03 acceptance oracle — visual coordinate target → scoped desktop action → verification
 * (IMPLEMENTATION_PLAN.md §7.2 C03; §5.4 "Prefer connector → AX → visual in that order" and the C
 * flow "revalidate target → execute one bounded step → inspect resulting state → record receipt";
 * §5.3 retention: screenshots expire from RAM after 60 seconds).
 *
 * `packages/desktop-tools/src/visual/index.ts` must export (this file freezes these names):
 *
 *   createVisualCoordinateExecutor({ capture, pointer, now, scope, routes })
 *     → VisualCoordinateExecutor
 *
 *     capture — the raw screen-capture boundary (the native ScreenCaptureKit seam):
 *       capture({ scope }) → Promise<{ captureId, capturedAtMs, targets }>
 *         One fresh frame of the scoped display. Every target in the frame carries
 *         { targetRef, label, bounds, fingerprint, stateVersion }: `fingerprint` is the identity the
 *         planner and the executor compare, `bounds` its live rectangle, and `stateVersion` a value
 *         the target advances whenever a click actually lands on it. The executor captures fresh at
 *         execution time; a caller's screenshot is never the source of click coordinates.
 *
 *     pointer — the raw pointer boundary: click({ x, y }) → Promise<void>. One synthetic click.
 *
 *     now — deterministic clock; the staleness bound is evaluated against it.
 *     scope — the explicit project association, e.g.
 *       { profileId: 'profile-c03', projectId: 'atlas', sensitivity: 'normal' }; every capture is
 *       issued under it.
 *     routes — the structured routes that already serve a target:
 *       { targetRef, via: 'connector' | 'ax' }. Prefer connector → AX → visual: a target with a
 *       structured route is never clicked by coordinates.
 *
 *     executor:
 *       click({ actionId, targetRef, observation }) → Promise<VisualOutcome>
 *         observation = { screenshotRef, capturedAtMs, targetFingerprint, bounds }: the frame the
 *         plan was made from and the target rectangle the plan wants clicked.
 *         Outcome = {
 *           actionId,
 *           status: 'completed' | 'denied' | 'failed',
 *           reason?: 'structured_route_available' | 'screenshot_stale' | 'target_missing'
 *                  | 'target_moved' | 'target_changed' | 'verification_failed',
 *           clickPoint: { x, y } | null,   // the point the click used, null when nothing was clicked
 *           evidenceIds: string[],
 *         }
 *         Evidence ids are derived, not invented: the pre-click fresh frame is
 *         'vis:before:<actionId>' and the post-click frame is 'vis:after:<actionId>'. A refusal
 *         that captured nothing reports no evidence.
 *
 * Deterministic rules pinned here (BACKLOG.json C03 acceptance criteria):
 *   1. A target a connector/AX route already serves is denied 'structured_route_available' and never
 *      clicked by coordinates (connector → AX → visual ordering).
 *   2. Execution derives the click from a live frame: the executor takes a fresh capture at execution
 *      time and clicks that frame's target centre. A fresh frame that no longer contains the target
 *      ('target_missing'), reports another identity ('target_changed'), or another rectangle
 *      ('target_moved') is denied with zero clicks — the plan's coordinates are never clicked.
 *   3. A stale screenshot is not a plan: an observation captured more than SCREENSHOT_TTL_MS (60 s,
 *      the RAM retention bound) before execution is denied 'screenshot_stale' with zero clicks, even
 *      when the current frame still matches.
 *   4. A click is verified against the surface: the post-click frame must show the clicked target's
 *      stateVersion advanced; otherwise the outcome is 'failed' with 'verification_failed' and never
 *      claims 'completed'.
 *
 * Remaining limitation: this oracle pins the TypeScript seam with deterministic doubles. Real
 * ScreenCaptureKit frame freshness, display/coordinate transforms (Retina scale, multiple displays),
 * and real pointer clicks still need the manual hardware qualification pass recorded by release
 * evidence; the fixture is fully synthetic (no real screen, window, or user content).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';

type VisualBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
type VisualClickPoint = Readonly<{ x: number; y: number }>;

type VisualTarget = Readonly<{
  targetRef: string;
  label: string;
  bounds: VisualBounds;
  fingerprint: string;
  stateVersion: number;
}>;

type VisualCapture = Readonly<{
  captureId: string;
  capturedAtMs: number;
  targets: ReadonlyArray<VisualTarget>;
}>;

/** What the plan saw: the frame it was made from and the rectangle it wants clicked. */
type VisualObservation = Readonly<{
  screenshotRef: string;
  capturedAtMs: number;
  targetFingerprint: string;
  bounds: VisualBounds;
}>;

type VisualRoute = Readonly<{ targetRef: string; via: 'connector' | 'ax' }>;

type VisualStopReason =
  | 'structured_route_available'
  | 'screenshot_stale'
  | 'target_missing'
  | 'target_moved'
  | 'target_changed'
  | 'verification_failed';

type VisualOutcome = Readonly<{
  actionId: string;
  status: 'completed' | 'denied' | 'failed';
  reason?: VisualStopReason;
  clickPoint: VisualClickPoint | null;
  evidenceIds: ReadonlyArray<string>;
}>;

type VisualCaptureSource = Readonly<{
  capture(input: Readonly<{ scope: Scope }>): Promise<VisualCapture>;
}>;

type VisualPointer = Readonly<{
  click(input: Readonly<{ x: number; y: number }>): Promise<void>;
}>;

type VisualCoordinateExecutor = Readonly<{
  click(input: Readonly<{
    actionId: string;
    targetRef: string;
    observation: VisualObservation;
  }>): Promise<VisualOutcome>;
}>;

type VisualOptions = Readonly<{
  capture: VisualCaptureSource;
  pointer: VisualPointer;
  now: () => Date;
  scope: Scope;
  routes: ReadonlyArray<VisualRoute>;
}>;

type VisualModule = Readonly<{
  createVisualCoordinateExecutor(options: VisualOptions): VisualCoordinateExecutor;
}>;

const MISSING_BEHAVIOR = 'C03 required visual coordinate behavior is not implemented yet: '
  + 'packages/desktop-tools/src/visual/index.ts must export createVisualCoordinateExecutor('
  + '{ capture, pointer, now, scope, routes }) returning click({ actionId, targetRef, observation }) '
  + 'over the frozen fresh-capture seam.';

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): VisualModule {
  return {
    createVisualCoordinateExecutor(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadVisualModule(): Promise<VisualModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createVisualCoordinateExecutor !== 'function') {
    return missingModule('createVisualCoordinateExecutor is not exported');
  }
  return loaded as unknown as VisualModule;
}

const visualCoordinates = await loadVisualModule();

const NOW = '2026-09-21T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);
/** §5.3: screenshots expire from RAM after 60 seconds; an older observation is not a plan. */
const SCREENSHOT_TTL_MS = 60_000;

const SCOPE: Scope = Object.freeze({
  profileId: 'profile-c03',
  projectId: 'atlas',
  sensitivity: 'normal',
});

const TARGET: VisualTarget = Object.freeze({
  targetRef: 'pixel:dom:request-timeout',
  label: 'Request timeout (seconds)',
  bounds: Object.freeze({ x: 120, y: 240, width: 200, height: 32 }),
  fingerprint: 'window:settings#request-timeout@7',
  stateVersion: 4,
});

const MOVED_BOUNDS: VisualBounds = Object.freeze({ x: 320, y: 240, width: 200, height: 32 });
const CLICK_POINT: VisualClickPoint = Object.freeze({ x: 220, y: 256 });

function plannedObservation(): VisualObservation {
  return {
    screenshotRef: 'shot:c03-planner',
    capturedAtMs: NOW_MS,
    targetFingerprint: TARGET.fingerprint,
    bounds: TARGET.bounds,
  };
}

type ScreenCall =
  | Readonly<{ kind: 'capture'; captureId: string }>
  | Readonly<{ kind: 'click'; x: number; y: number }>;

/** The screen double: it hands out fresh frames, counts clicks, and models a click the surface ignores. */
type FakeScreen = Readonly<{
  capture: VisualCaptureSource;
  pointer: VisualPointer;
  calls: Array<ScreenCall>;
  captures: Array<Readonly<{ scope: Scope }>>;
  clicks: ReadonlyArray<VisualClickPoint>;
  target(): VisualTarget;
  patchTarget(patch: Partial<VisualTarget>): void;
  removeTarget(): void;
  stallClicks(): void;
}>;

function containsPoint(bounds: VisualBounds, point: VisualClickPoint): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function fakeScreen(now: () => Date): FakeScreen {
  let targets: Array<VisualTarget> = [{ ...TARGET, bounds: { ...TARGET.bounds } }];
  let applyClicks = true;
  let captureCount = 0;
  const calls: Array<ScreenCall> = [];
  const captureCalls: Array<Readonly<{ scope: Scope }>> = [];
  const clicks: Array<VisualClickPoint> = [];
  const currentTarget = (): VisualTarget => {
    const found = targets[0];
    assert.ok(found, 'the fake screen: the fixture target must exist');
    return found;
  };
  const capture: VisualCaptureSource = {
    async capture({ scope }) {
      captureCount += 1;
      const captureId = `shot:c03:fresh-${captureCount}`;
      captureCalls.push({ scope });
      calls.push({ kind: 'capture', captureId });
      return {
        captureId,
        capturedAtMs: now().getTime(),
        targets: targets.map((entry) => ({ ...entry, bounds: { ...entry.bounds } })),
      };
    },
  };
  const pointer: VisualPointer = {
    async click({ x, y }) {
      calls.push({ kind: 'click', x, y });
      clicks.push({ x, y });
      if (!applyClicks) return;
      targets = targets.map((entry) => (containsPoint(entry.bounds, { x, y })
        ? { ...entry, stateVersion: entry.stateVersion + 1 }
        : entry));
    },
  };
  return {
    capture,
    pointer,
    calls,
    captures: captureCalls,
    clicks,
    target: currentTarget,
    patchTarget(patch) {
      targets = [{ ...currentTarget(), ...patch }];
    },
    removeTarget() {
      targets = [];
    },
    stallClicks() {
      applyClicks = false;
    },
  };
}

type Run = Readonly<{ executor: VisualCoordinateExecutor; screen: FakeScreen }>;

function harness(options?: Readonly<{ routes?: ReadonlyArray<VisualRoute> }>): Run {
  const screen = fakeScreen(() => new Date(NOW_MS));
  const executor = visualCoordinates.createVisualCoordinateExecutor({
    capture: screen.capture,
    pointer: screen.pointer,
    now: () => new Date(NOW_MS),
    scope: SCOPE,
    routes: options?.routes ?? [],
  });
  return { executor, screen };
}

test('C03: a coordinate click uses a fresh frame and verifies the click against the surface', async () => {
  const run = harness();

  const outcome = await run.executor.click({
    actionId: 'act-visual-click',
    targetRef: TARGET.targetRef,
    observation: plannedObservation(),
  });

  assert.equal(outcome.status, 'completed', 'a stable target completes through the coordinate fallback');
  assert.equal(outcome.reason, undefined, 'a completed click carries no stop reason');
  assert.equal(outcome.actionId, 'act-visual-click');
  assert.deepEqual(outcome.clickPoint, CLICK_POINT, 'the outcome reports the point the click used');
  assert.deepEqual([...outcome.evidenceIds], ['vis:before:act-visual-click', 'vis:after:act-visual-click']);
  assert.deepEqual([...run.screen.clicks], [CLICK_POINT],
    'the pointer clicked exactly once, on the fresh target centre');
  assert.ok(run.screen.captures.length >= 2,
    'execution captures a fresh frame before the click and a second frame to verify it');
  assert.ok(run.screen.captures.every((entry) => entry.scope.profileId === SCOPE.profileId
    && entry.scope.projectId === 'atlas'), 'every frame is captured under the explicit project scope');
  assert.equal(run.screen.target().stateVersion, TARGET.stateVersion + 1, 'the surface registered the click');
});

test('C03: a coordinate click is denied when the fresh frame shows the target moved, changed, or gone', async (t) => {
  await t.test('the target moved to another rectangle', async () => {
    const run = harness();
    run.screen.patchTarget({ bounds: MOVED_BOUNDS });

    const outcome = await run.executor.click({
      actionId: 'act-visual-moved',
      targetRef: TARGET.targetRef,
      observation: plannedObservation(),
    });

    assert.equal(outcome.status, 'denied', 'a moved target stops the coordinate action');
    assert.equal(outcome.reason, 'target_moved', 'the receipt names the movement');
    assert.equal(outcome.clickPoint, null, 'nothing was clicked');
    assert.equal(run.screen.clicks.length, 0, 'the plan coordinates are never clicked after the target moved');
  });

  await t.test('the target was replaced by another identity', async () => {
    const run = harness();
    run.screen.patchTarget({ fingerprint: `${TARGET.fingerprint}-replaced` });

    const outcome = await run.executor.click({
      actionId: 'act-visual-changed',
      targetRef: TARGET.targetRef,
      observation: plannedObservation(),
    });

    assert.equal(outcome.status, 'denied', 'a replaced target stops the coordinate action');
    assert.equal(outcome.reason, 'target_changed', 'the receipt names the identity change');
    assert.equal(outcome.clickPoint, null);
    assert.equal(run.screen.clicks.length, 0, 'the replacement is never clicked by coordinates');
  });

  await t.test('the target is gone from the fresh frame', async () => {
    const run = harness();
    run.screen.removeTarget();

    const outcome = await run.executor.click({
      actionId: 'act-visual-gone',
      targetRef: TARGET.targetRef,
      observation: plannedObservation(),
    });

    assert.equal(outcome.status, 'denied', 'a missing target stops the coordinate action');
    assert.equal(outcome.reason, 'target_missing');
    assert.equal(outcome.clickPoint, null);
    assert.equal(run.screen.clicks.length, 0, 'nothing is clicked when the target is not in the fresh frame');
  });
});

test('C03: a stale observation is refused even when the current frame still matches', async () => {
  const run = harness();
  const staleObservation: VisualObservation = {
    screenshotRef: 'shot:c03-planner-stale',
    capturedAtMs: NOW_MS - SCREENSHOT_TTL_MS - 1_000,
    targetFingerprint: TARGET.fingerprint,
    bounds: TARGET.bounds,
  };

  const outcome = await run.executor.click({
    actionId: 'act-visual-stale',
    targetRef: TARGET.targetRef,
    observation: staleObservation,
  });

  assert.equal(outcome.status, 'denied', 'a stale screenshot is not a plan');
  assert.equal(outcome.reason, 'screenshot_stale', 'the receipt names the expired observation');
  assert.equal(outcome.clickPoint, null);
  assert.equal(run.screen.clicks.length, 0,
    'a screenshot older than the 60 s RAM expiry is never a basis for a coordinate click');
});

test('C03: a target a connector or AX route already serves is never clicked by coordinates', async () => {
  const routed = harness({ routes: [{ targetRef: TARGET.targetRef, via: 'ax' }] });
  const denied = await routed.executor.click({
    actionId: 'act-visual-routed',
    targetRef: TARGET.targetRef,
    observation: plannedObservation(),
  });

  assert.equal(denied.status, 'denied', 'connector → AX → visual is enforced before the coordinate click');
  assert.equal(denied.reason, 'structured_route_available');
  assert.equal(denied.clickPoint, null);
  assert.equal(routed.screen.clicks.length, 0, 'a routed target never gets a synthetic click');

  const unrouted = harness({ routes: [{ targetRef: 'pixel:other-control', via: 'connector' }] });
  const completed = await unrouted.executor.click({
    actionId: 'act-visual-unrouted',
    targetRef: TARGET.targetRef,
    observation: plannedObservation(),
  });
  assert.equal(completed.status, 'completed', 'the route check is per target, not a blanket refusal');
  assert.deepEqual([...unrouted.screen.clicks], [CLICK_POINT]);
});

test('C03: a click the surface ignores is not reported as a completed result', async () => {
  const run = harness();
  run.screen.stallClicks();

  const outcome = await run.executor.click({
    actionId: 'act-visual-stalled',
    targetRef: TARGET.targetRef,
    observation: plannedObservation(),
  });

  assert.equal(outcome.status, 'failed', 'an unverified click is never a completed action');
  assert.equal(outcome.reason, 'verification_failed', 'the receipt names the failed verification');
  assert.deepEqual(outcome.clickPoint, CLICK_POINT, 'the click is still reported as attempted');
  assert.deepEqual([...outcome.evidenceIds], ['vis:before:act-visual-stalled', 'vis:after:act-visual-stalled']);
  assert.equal(run.screen.target().stateVersion, TARGET.stateVersion, 'the surface never registered the click');
  assert.deepEqual([...run.screen.clicks], [CLICK_POINT]);
});
