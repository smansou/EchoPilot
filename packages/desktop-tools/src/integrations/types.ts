/**
 * C03 structured integration contracts (IMPLEMENTATION_PLAN.md §7.2 C03, §5.4 "Prefer connector →
 * AX → visual in that order").
 *
 * The allowlisted browser extension (DOM-backed controls) and the VS Code extension (editor state
 * and insertion) sit behind these types. The connector boundary only ever performs structured reads
 * and structured writes; there is deliberately no synthetic-typing, focus-transfer, or submit call
 * in the vocabulary, because the acceptance criterion is that the structured path needs less focus
 * interference than typing into the application.
 */
import type { Scope } from '../../../contracts/src/index.js';

/** The capability vocabulary an allowlisted extension may declare and a bound session may use. */
export type IntegrationCapability =
  | 'dom.read_controls'
  | 'dom.set_value'
  | 'editor.read_state'
  | 'editor.insert_text';

/** One structured read: the live value the extension API reports for a target. */
export type StructuredControlState = Readonly<{
  targetRef: string;
  fingerprint: string;
  value: string;
}>;

/** One allowlisted application surface: its app, its extension origin, and its vocabulary. */
export type ExtensionDescriptor = Readonly<{
  extensionId: string;
  app: string;
  origin: string;
  capabilities: ReadonlyArray<IntegrationCapability>;
}>;

/** The user's scoped grant for one extension origin; a bound session may never exceed it. */
export type CapabilityGrant = Readonly<{
  extensionId: string;
  origin: string;
  granted: ReadonlyArray<IntegrationCapability>;
}>;

/** The raw extension boundary: structured reads and writes for exactly one extension id. */
export type StructuredConnector = Readonly<{
  extensionId: string;
  read(input: Readonly<{
    capability: IntegrationCapability;
    targetRef: string;
  }>): Promise<StructuredControlState | null>;
  write(input: Readonly<{
    capability: IntegrationCapability;
    targetRef: string;
    value: string;
  }>): Promise<void>;
}>;

/** A session the service issued: the extension never picks the session id or the nonce. */
export type IntegrationSession = Readonly<{
  sessionId: string;
  nonce: string;
  extensionId: string;
  origin: string;
  capabilities: ReadonlyArray<IntegrationCapability>;
}>;

/** Why a native-messaging handshake was refused; a refused handshake executes nothing. */
export type IntegrationBindingFailure =
  | 'unknown_extension'
  | 'origin_not_allowed'
  | 'capability_not_granted';

export type SessionBinding =
  | Readonly<{ bound: true; session: IntegrationSession }>
  | Readonly<{ bound: false; reason: IntegrationBindingFailure }>;

/** Why an authenticated message did not reach the connector. */
export type IntegrationStopReason =
  | 'unknown_session'
  | 'origin_mismatch'
  | 'nonce_mismatch'
  | 'capability_not_granted'
  | 'verification_failed';

/**
 * One scoped structured action. `before` is the preflight read (the value the extension reported
 * before the write), `after` is the verifying read-back, and both are `null` when nothing was read
 * (a denied message produces neither).
 */
export type IntegrationOutcome = Readonly<{
  actionId: string;
  status: 'completed' | 'denied' | 'failed';
  reason?: IntegrationStopReason;
  before: string | null;
  after: string | null;
  evidenceIds: ReadonlyArray<string>;
}>;

export type IntegrationBindInput = Readonly<{
  extensionId: string;
  origin: string;
  requestedCapabilities: ReadonlyArray<IntegrationCapability>;
}>;

export type IntegrationDispatchInput = Readonly<{
  sessionId: string;
  nonce: string;
  origin: string;
  capability: IntegrationCapability;
  actionId: string;
  targetRef: string;
  value?: string;
}>;

export type StructuredIntegrationService = Readonly<{
  bindSession(input: IntegrationBindInput): Promise<SessionBinding>;
  dispatch(input: IntegrationDispatchInput): Promise<IntegrationOutcome>;
}>;

export type StructuredIntegrationOptions = Readonly<{
  scope: Scope;
  extensions: ReadonlyArray<ExtensionDescriptor>;
  grants: ReadonlyArray<CapabilityGrant>;
  connectors: ReadonlyArray<StructuredConnector>;
}>;
