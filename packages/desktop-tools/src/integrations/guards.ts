/**
 * C03 handshake and message guards. Both are pure decisions over the allowlist, the user's grant,
 * and the session the service issued, so the same message always produces the same stop reason and
 * none of them can reach a connector on its own.
 *
 * Order (first match wins):
 *   1. extension — an id that is not allowlisted (or has no registered connector) is unknown;
 *   2. origin    — the origin must be exactly the allowlisted origin of that extension, so a page
 *                  that found the extension id cannot impersonate its surface;
 *   3. grant     — the requested capabilities must be declared by the extension *and* granted by
 *                  the user, so a handshake can never bind more than the grant;
 *   4. message   — a dispatched message is authenticated against the bound session (origin, then
 *                  nonce) before its capability is checked against the session's bound set.
 */
import type {
  CapabilityGrant,
  ExtensionDescriptor,
  IntegrationBindingFailure,
  IntegrationCapability,
  IntegrationSession,
  IntegrationStopReason,
} from './types.js';

export type BindingAttempt = Readonly<{
  descriptor: ExtensionDescriptor | null;
  origin: string;
  grant: CapabilityGrant | null;
  requested: ReadonlyArray<IntegrationCapability>;
}>;

/** The handshake decision; `null` means the session may be bound with the requested capabilities. */
export function bindingStopReason(attempt: BindingAttempt): IntegrationBindingFailure | null {
  const { descriptor, origin, grant, requested } = attempt;
  if (descriptor === null) return 'unknown_extension';
  if (descriptor.origin !== origin) return 'origin_not_allowed';
  if (grant === null) return 'capability_not_granted';
  if (requested.some((capability) => !descriptor.capabilities.includes(capability))) {
    return 'capability_not_granted';
  }
  if (requested.some((capability) => !grant.granted.includes(capability))) {
    return 'capability_not_granted';
  }
  return null;
}

export type DispatchAttempt = Readonly<{
  origin: string;
  nonce: string;
  capability: IntegrationCapability;
}>;

/** The message decision for a known session; `null` means the message is authenticated. */
export function dispatchStopReason(
  session: IntegrationSession,
  attempt: DispatchAttempt,
): IntegrationStopReason | null {
  if (session.origin !== attempt.origin) return 'origin_mismatch';
  if (session.nonce !== attempt.nonce) return 'nonce_mismatch';
  if (!session.capabilities.includes(attempt.capability)) return 'capability_not_granted';
  return null;
}
