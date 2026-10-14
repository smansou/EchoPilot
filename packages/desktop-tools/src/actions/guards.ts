/**
 * C02 preflight guards. The guards are pure decisions over the grant and the live AX control, so
 * the same input always produces the same stop reason and the rule set is re-evaluated for every
 * step of a multi-step action — never once per action.
 *
 * Order (first match wins, and the first check that can stop execution is the authorization):
 *   1. grant      — no grant, an unauthorized grant, or a grant past its expiry stops the step;
 *   2. identity   — the control no longer exists, or its fingerprint is not the granted one
 *                   (a replaced control or window never passes a stale fingerprint);
 *   3. disabled   — the granted control reports itself disabled;
 *   4. focus      — the granted target is no longer the focused control, so a keystroke or value
 *                   write would land somewhere the user did not confirm.
 */
import type {
  DesktopActionAuthorization,
  DesktopActionStopReason,
  DesktopActionStep,
  DesktopAxControl,
} from './types.js';

export type LiveAuthorization = DesktopActionAuthorization & Readonly<{ expiresAtMs: number }>;

/** The grant check: an absent, unauthorized, or expired grant stops before any AX work. */
export function authorizationStopReason(
  authorization: LiveAuthorization | null,
  atMs: number,
): DesktopActionStopReason | null {
  if (authorization === null || !authorization.authorized) return 'not_authorized';
  if (atMs > authorization.expiresAtMs) return 'grant_expired';
  return null;
}

/** The target check over the live control the preflight read returned. */
export function targetStopReason(
  step: DesktopActionStep,
  control: DesktopAxControl | null,
): DesktopActionStopReason | null {
  if (control === null) return 'target_identity_changed';
  if (control.fingerprint !== step.targetFingerprint) return 'target_identity_changed';
  if (step.expectedValue !== undefined && control.value !== step.expectedValue) return 'target_identity_changed';
  if (!control.enabled) return 'target_disabled';
  if (!control.focused) return 'focus_changed';
  return null;
}
