/**
 * C03 visual coordinate fallback contracts (IMPLEMENTATION_PLAN.md §7.2 C03; §5.4 "Prefer connector
 * → AX → visual in that order").
 */
import type { Scope } from '../../../contracts/src/index.js';

export type VisualBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
export type VisualClickPoint = Readonly<{ x: number; y: number }>;

/** One target the fresh capture reports: identity (`fingerprint`), rectangle, and click counter. */
export type VisualTarget = Readonly<{
  targetRef: string;
  label: string;
  bounds: VisualBounds;
  fingerprint: string;
  stateVersion: number;
}>;

/** One fresh frame of the scoped display; frames are captured, never replayed from the plan. */
export type VisualCapture = Readonly<{
  captureId: string;
  capturedAtMs: number;
  targets: ReadonlyArray<VisualTarget>;
}>;

/** What the plan saw: the frame it was made from and the rectangle it wants clicked. */
export type VisualObservation = Readonly<{
  screenshotRef: string;
  capturedAtMs: number;
  targetFingerprint: string;
  bounds: VisualBounds;
}>;

/** A structured route that already serves a target; such a target is never clicked by coordinates. */
export type VisualRoute = Readonly<{ targetRef: string; via: 'connector' | 'ax' }>;

export type VisualStopReason =
  | 'structured_route_available'
  | 'screenshot_stale'
  | 'target_missing'
  | 'target_moved'
  | 'target_changed'
  | 'verification_failed';

export type VisualOutcome = Readonly<{
  actionId: string;
  status: 'completed' | 'denied' | 'failed';
  reason?: VisualStopReason;
  clickPoint: VisualClickPoint | null;
  evidenceIds: ReadonlyArray<string>;
}>;

/** The raw screen-capture boundary (the native ScreenCaptureKit seam). */
export type VisualCaptureSource = Readonly<{
  capture(input: Readonly<{ scope: Scope }>): Promise<VisualCapture>;
}>;

/** The raw pointer boundary: one synthetic click per call. */
export type VisualPointer = Readonly<{
  click(input: Readonly<{ x: number; y: number }>): Promise<void>;
}>;

export type VisualCoordinateExecutor = Readonly<{
  click(input: Readonly<{
    actionId: string;
    targetRef: string;
    observation: VisualObservation;
  }>): Promise<VisualOutcome>;
}>;

export type VisualOptions = Readonly<{
  capture: VisualCaptureSource;
  pointer: VisualPointer;
  now: () => Date;
  scope: Scope;
  routes: ReadonlyArray<VisualRoute>;
}>;
