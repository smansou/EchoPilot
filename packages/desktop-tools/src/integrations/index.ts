/**
 * C03 — structured connector (browser + editor) → scoped desktop action → verification
 * (IMPLEMENTATION_PLAN.md §7.2 C03; §5.4 "Prefer connector → AX → visual in that order" and the C
 * flow "revalidate target → execute one bounded step → inspect resulting state → record receipt";
 * §5.3 contracts).
 *
 * `createStructuredIntegrationService({ scope, extensions, grants, connectors })` is the seam
 * between a planned desktop action and the allowlisted application extensions (the Chrome DOM
 * extension and the VS Code editor extension) over native messaging. It guarantees:
 *
 * - a handshake is allowlisted per extension *and* origin, and binds only capabilities the
 *   extension declares and the user actually granted: an unlisted extension id is
 *   `unknown_extension`, a foreign origin `origin_not_allowed`, and a request for anything wider
 *   than the grant `capability_not_granted` — a refused handshake executes nothing;
 * - the service issues the session id and the nonce (a 128-bit WebCrypto UUID each), so an
 *   extension can never choose its own session identity, and a session id that was never issued is
 *   `unknown_session` before any connector is touched;
 * - every dispatched message is authenticated against the bound session — origin, then nonce, then
 *   the session's capability set — and a message that fails any of those checks produces neither
 *   `before`/`after` state nor an evidence id, because no read of the application happened;
 * - a read capability performs exactly one structured read (evidence `int:before:<actionId>`); a
 *   write capability preflights the target, performs exactly one structured write, and verifies it
 *   with a read-back (evidence `int:before:<actionId>` and `int:after:<actionId>`). A read-back
 *   that disagrees is `failed` with `verification_failed` and never claims `completed`;
 * - the connector boundary is structured only: the service never synthesizes keystrokes, never
 *   moves focus, never submits an editor buffer, and never scrapes a browser profile or imports
 *   cookies — the session works on the one target its grant names.
 *
 * The explicit project scope (`scope.projectId`) is required at construction, so a structured
 * action can never be dispatched outside a project. The native counterparts of these seams are the
 * allowlisted extension packages themselves; their real browser/editor qualification is recorded
 * separately from this deterministic oracle.
 */
import { readEvidenceIds, writeEvidenceIds } from './evidence.js';
import { bindingStopReason, dispatchStopReason } from './guards.js';
import { isReadCapability, writeVerified } from './verification.js';
import type {
  ExtensionDescriptor,
  IntegrationBindInput,
  IntegrationCapability,
  IntegrationDispatchInput,
  IntegrationOutcome,
  IntegrationSession,
  IntegrationStopReason,
  SessionBinding,
  StructuredIntegrationOptions,
  StructuredIntegrationService,
} from './types.js';

export type {
  CapabilityGrant,
  ExtensionDescriptor,
  IntegrationBindInput,
  IntegrationBindingFailure,
  IntegrationCapability,
  IntegrationDispatchInput,
  IntegrationOutcome,
  IntegrationSession,
  IntegrationStopReason,
  SessionBinding,
  StructuredConnector,
  StructuredControlState,
  StructuredIntegrationOptions,
  StructuredIntegrationService,
} from './types.js';
export { afterEvidenceId, beforeEvidenceId, readEvidenceIds, writeEvidenceIds } from './evidence.js';
export { bindingStopReason, dispatchStopReason } from './guards.js';
export { expectedValueAfterWrite, isReadCapability, writeVerified } from './verification.js';

/** A caller or message that never bound a session, or an extension the allowlist does not wire. */
function denied(actionId: string, reason: IntegrationStopReason): IntegrationOutcome {
  return { actionId, status: 'denied', reason, before: null, after: null, evidenceIds: [] };
}

/** The structured action reached the extension but the result was not a verified one. */
function unverified(
  actionId: string,
  before: string | null,
  after: string | null,
  evidenceIds: ReadonlyArray<string>,
): IntegrationOutcome {
  return { actionId, status: 'failed', reason: 'verification_failed', before, after, evidenceIds };
}

/**
 * Session ids and nonces are service-issued and unguessable: a 128-bit WebCrypto UUID each, so a
 * page that learned the extension id cannot replay a session it never received.
 */
function randomToken(kind: 'session' | 'nonce'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid !== 'string' || uuid.length === 0) {
    throw new TypeError('C03: WebCrypto randomUUID is unavailable in this runtime');
  }
  return `${kind}-${uuid}`;
}

/** A grant is per extension *and* origin: a grant for another origin is not this extension's grant. */
function grantKey(extensionId: string, origin: string): string {
  return `${extensionId}\u0000${origin}`;
}

export function createStructuredIntegrationService(
  options: StructuredIntegrationOptions,
): StructuredIntegrationService {
  const { scope, extensions, grants, connectors } = options;
  const projectId = scope.projectId;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new TypeError(
      'C03: createStructuredIntegrationService requires an explicit project scope '
      + '(scope.projectId); a structured action is never dispatched outside a project.',
    );
  }

  const allowlist = new Map<string, ExtensionDescriptor>(
    extensions.map((descriptor) => [descriptor.extensionId, descriptor]),
  );
  const connectorById = new Map(connectors.map((connector) => [connector.extensionId, connector]));
  const grantByKey = new Map(grants.map((grant) => [grantKey(grant.extensionId, grant.origin), grant]));
  const sessions = new Map<string, IntegrationSession>();

  async function bindSession(input: IntegrationBindInput): Promise<SessionBinding> {
    const descriptor = allowlist.get(input.extensionId) ?? null;
    // An allowlisted extension with no registered connector is not usable: binding it would mint a
    // session that can never act, so it is refused like an unknown extension.
    const wired = descriptor !== null && connectorById.has(descriptor.extensionId) ? descriptor : null;
    const reason = bindingStopReason({
      descriptor: wired,
      origin: input.origin,
      grant: grantByKey.get(grantKey(input.extensionId, input.origin)) ?? null,
      requested: input.requestedCapabilities,
    });
    if (reason !== null) return { bound: false, reason };

    const session: IntegrationSession = {
      sessionId: randomToken('session'),
      nonce: randomToken('nonce'),
      extensionId: input.extensionId,
      origin: input.origin,
      capabilities: [...new Set<IntegrationCapability>(input.requestedCapabilities)],
    };
    sessions.set(session.sessionId, session);
    return { bound: true, session };
  }

  async function dispatch(input: IntegrationDispatchInput): Promise<IntegrationOutcome> {
    const session = sessions.get(input.sessionId);
    if (session === undefined) return denied(input.actionId, 'unknown_session');
    const reason = dispatchStopReason(session, {
      origin: input.origin,
      nonce: input.nonce,
      capability: input.capability,
    });
    if (reason !== null) return denied(input.actionId, reason);

    const connector = connectorById.get(session.extensionId);
    if (connector === undefined) return denied(input.actionId, 'unknown_session');

    if (isReadCapability(input.capability)) {
      const state = await connector.read({ capability: input.capability, targetRef: input.targetRef });
      // A read that returned no state cannot report a value: it is not a completed action and it
      // carries no evidence, because no application state was read.
      if (state === null) return unverified(input.actionId, null, null, []);
      return {
        actionId: input.actionId,
        status: 'completed',
        before: state.value,
        after: null,
        evidenceIds: readEvidenceIds(input.actionId),
      };
    }

    const value = input.value;
    if (typeof value !== 'string') {
      // Writing an unspecified value is not a structured action: nothing is written and nothing is
      // claimed. The frozen stop vocabulary has no malformed-request code, so this shares the
      // verification-failure code rather than throwing out of the extension message loop.
      return unverified(input.actionId, null, null, []);
    }

    const preflight = await connector.read({ capability: input.capability, targetRef: input.targetRef });
    // Without a preflight value the caret/target is unknown, so the write is never applied: an
    // unverifiable insertion is exactly what the read-back rule exists to prevent.
    if (preflight === null) return unverified(input.actionId, null, null, []);

    await connector.write({ capability: input.capability, targetRef: input.targetRef, value });
    const readBack = await connector.read({ capability: input.capability, targetRef: input.targetRef });
    const after = readBack === null ? null : readBack.value;
    const evidenceIds = writeEvidenceIds(input.actionId);

    if (!writeVerified(input.capability, preflight.value, value, after)) {
      return unverified(input.actionId, preflight.value, after, evidenceIds);
    }
    return {
      actionId: input.actionId,
      status: 'completed',
      before: preflight.value,
      after,
      evidenceIds,
    };
  }

  return { bindSession, dispatch };
}
