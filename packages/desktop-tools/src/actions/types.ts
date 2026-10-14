/**
 * C02 — the frozen desktop-action vocabulary (IMPLEMENTATION_PLAN.md §7.2 C02, §5.9 action
 * lifecycle and execution security, §5.4 read/navigate/click/type/select/scroll through AX).
 *
 * These types are the seam between the widget conversation and the native Accessibility helper:
 * the deterministic oracle (`c02.acceptance.test.ts`) freezes the names, and the native
 * `native/macos/Sources/Accessibility` package mirrors the same records in Swift so one contract
 * is exercised by the offline doubles and by the real AX session.
 *
 * The AX boundary is deliberately raw: `inspect` returns what the control currently reports (or
 * null when the control no longer exists) and `setValue` is one AX write that resolves when the AX
 * call returns. Neither is trusted as proof of application state — the preflight read and the
 * post-action read-back in the receipt are.
 */
import type { Scope } from '../../../contracts/src/index.js';

/** One control as the native AX session reports it right now. */
export type DesktopAxControl = Readonly<{
  appBundleId: string;
  windowTitle: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  /**
   * The target fingerprint the resolver captured: it covers the control's app, window, role, and
   * label identity, so a replaced control or a replaced window never passes a stale fingerprint.
   */
  fingerprint: string;
}>;

/** The C02 native boundary: raw AX state in, raw AX writes out. */
export type DesktopAxBridge = Readonly<{
  /** Current state of one control, or null when it no longer exists. */
  inspect(targetRef: string): Promise<DesktopAxControl | null>;
  /** One AX write; resolving is not proof the application applied it. */
  setValue(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
}>;

/** §5.9 effect classification; bound into the argument hash so a grant cannot change effect. */
export type DesktopActionEffect = 'read' | 'local_write' | 'external';

/** The recognized voice request or grant utterance. No ASR runs inside this seam. */
export type DesktopActionUtterance = Readonly<{ utteranceId: string; text: string }>;

/** One ordered step of a proposed action. */
export type DesktopActionStep = Readonly<{
  stepId: string;
  operation: 'set_value';
  targetRef: string;
  targetFingerprint: string;
  value: string;
  expectedValue?: string;
}>;

/** A voice request becomes this proposal; a proposal never executes by itself. */
export type DesktopActionProposal = Readonly<{
  proposalId: string;
  actionId: string;
  state: 'proposed';
  /** Binds the ordered steps (operation, target ref, target fingerprint, value) and the scope. */
  argumentHash: string;
  scope: Scope;
}>;

/** The voice grant. It binds the proposal's argument hash and expires at most 30 s after it. */
export type DesktopActionAuthorization = Readonly<{
  authorizationId: string;
  proposalId: string;
  authorized: boolean;
  argumentHash: string;
  expiresAt: string;
}>;

/** Every stop reason a receipt can name. */
export type DesktopActionStopReason =
  | 'not_authorized'
  | 'grant_expired'
  | 'focus_changed'
  | 'target_identity_changed'
  | 'target_disabled'
  | 'verification_failed'
  | 'cancelled_by_user';

export type DesktopStepStatus = 'completed' | 'unexecuted' | 'failed';

/**
 * One step in a receipt. A stopped step stays `unexecuted` with no before/after values and no
 * evidence, so a guard never leaves half-read state behind; a failed step keeps the disagreeing
 * before/after evidence so the failure is auditable.
 */
export type DesktopStepOutcome = Readonly<{
  stepId: string;
  status: DesktopStepStatus;
  before: string | null;
  after: string | null;
  evidenceIds: ReadonlyArray<string>;
}>;

export type DesktopActionStatus = 'in_progress' | 'completed' | 'denied' | 'failed' | 'cancelled';

/** The action receipt: the complete, ordered account of what happened to every step. */
export type DesktopActionOutcome = Readonly<{
  actionId: string;
  proposalId: string;
  status: DesktopActionStatus;
  reason?: DesktopActionStopReason;
  steps: ReadonlyArray<DesktopStepOutcome>;
  /** Union of the step evidence, in step order; derived, never invented. */
  evidenceIds: ReadonlyArray<string>;
}>;

export type DesktopActionProposeInput = Readonly<{
  actionId: string;
  idempotencyKey: string;
  utterance: DesktopActionUtterance;
  effect: DesktopActionEffect;
  steps: ReadonlyArray<DesktopActionStep>;
}>;

export type DesktopActionAuthorizationInput = Readonly<{
  proposalId: string;
  utterance: DesktopActionUtterance;
}>;

export type DesktopActionAdvanceInput = Readonly<{ proposalId: string }>;
export type DesktopActionCancelInput = Readonly<{ proposalId: string }>;

export type DesktopActionService = Readonly<{
  propose(input: DesktopActionProposeInput): Promise<DesktopActionProposal>;
  authorize(input: DesktopActionAuthorizationInput): Promise<DesktopActionAuthorization>;
  /** Preflights and runs exactly the next pending step; one step per call. */
  advance(input: DesktopActionAdvanceInput): Promise<DesktopActionOutcome>;
  /** Cancels the remaining steps between steps; a cancelled action never resumes. */
  cancel(input: DesktopActionCancelInput): Promise<DesktopActionOutcome>;
}>;

export type DesktopActionOptions = Readonly<{
  ax: DesktopAxBridge;
  /** Deterministic clock; every timestamp and expiry the service writes comes from it. */
  now: () => Date;
  /** The explicit project association; every proposal carries it. */
  scope: Scope;
}>;
