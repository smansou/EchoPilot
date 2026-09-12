/**
 * Renderer-side view of a managed Codex session (H01 tracer path: `→ UI → interrupt/resume`).
 *
 * This module is the only place the renderer learns about a managed session. It consumes v1
 * contract envelopes — the same `parseEventEnvelope` boundary every other renderer surface uses —
 * and never talks to the app-server directly: prompts, interrupts, resumes, and approval decisions
 * cross back through a `ManagedSessionControl` implementation (the harness adapter).
 *
 * Two invariants matter for the UI:
 *
 *   - An approval prompt stays `pending` until an explicit, authorized decision for that exact
 *     request id is applied. Stream activity, a disconnected companion, or a closed session never
 *     clears it, so the UI can never render a guarded action as approved on its own.
 *   - Events carry references, not content. Hidden reasoning is dropped by the adapter before it
 *     reaches this view, and unknown drifts arrive as `unsupported` diagnostics that increment a
 *     counter instead of becoming message or tool rows.
 */
import {
  parseEventEnvelope,
  type EventEnvelope,
  type HarnessCapability,
  type HarnessDeliveryReceipt,
  type Scope,
} from '../../../../../../packages/contracts/src/index.js';

export type SessionPhase = 'starting' | 'running' | 'interrupted' | 'completed' | 'closed';

export type ToolActivity = Readonly<{
  /** Stable identity of one tool item, derived from the envelope's payload reference. */
  toolRef: string;
  phase: 'running' | 'completed';
  turnId?: string;
}>;

export type MessageActivity = Readonly<{
  eventId: string;
  turnId?: string;
  /** Reference to the stored agent message; content is fetched from memory, never inlined here. */
  payloadRef: string;
  trust: EventEnvelope['trust'];
}>;

export type ApprovalPrompt = Readonly<{
  requestId: string;
  turnId?: string;
  status: 'pending';
  requestedAt: string;
}>;

export type ManagedSessionView = Readonly<{
  scope: Scope;
  sessionId: string | null;
  phase: SessionPhase;
  tools: ReadonlyArray<ToolActivity>;
  messages: ReadonlyArray<MessageActivity>;
  /** `null` only when nothing is pending; never cleared by anything but an authorized decision. */
  approval: ApprovalPrompt | null;
  unsupportedCount: number;
  lastEventId: string | null;
}>;

/** An explicit decision for one observed approval request, made by an authorized actor. */
export type AuthorizedApprovalDecision = Readonly<{
  requestId: string;
  decision: 'approve' | 'deny';
  authorizedBy: string;
}>;

/** The write path back to the managed adapter. Nothing here implies ambient-session control. */
export type ManagedSessionControl = Readonly<{
  prompt(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
  interrupt(turnId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /**
   * Only an authorized decision reaches this call; the UI must not supply one on its own.
   * Implementations reject when no request with that id is pending.
   */
  respondApproval(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  capabilities(): Promise<ReadonlySet<HarnessCapability>>;
}>;

export function initialSessionView(scope: Scope): ManagedSessionView {
  return {
    scope,
    sessionId: null,
    phase: 'starting',
    tools: [],
    messages: [],
    approval: null,
    unsupportedCount: 0,
    lastEventId: null,
  };
}

/** The payload reference suffix the managed adapter uses to pair a tool item's start and completion. */
function toolRef(payloadRef: string): string {
  return payloadRef.replace(/\/(started|completed|message)$/, '');
}

function optionalTurnId(event: EventEnvelope): Readonly<{ turnId?: string }> {
  return event.turnId === undefined ? {} : { turnId: event.turnId };
}

function withSessionId(view: ManagedSessionView, event: EventEnvelope): ManagedSessionView {
  const sessionId = event.scope.sessionId;
  return sessionId === undefined || sessionId === view.sessionId ? view : { ...view, sessionId };
}

/**
 * Fold one contract envelope into the view. Rejects (throws) anything that is not a v1 envelope,
 * so a malformed producer can never paint a fake tool result or message into the UI.
 */
export function applySessionEvent(view: ManagedSessionView, rawEvent: unknown): ManagedSessionView {
  const event = parseEventEnvelope(rawEvent);
  const base = withSessionId(view, event);
  switch (event.kind) {
    case 'session_state': {
      const phase: SessionPhase = event.turnId === undefined
        ? 'starting'
        : view.phase === 'closed' ? 'closed' : 'running';
      return { ...base, phase, lastEventId: event.eventId };
    }
    case 'tool_started':
      return {
        ...base,
        tools: [
          ...view.tools,
          { toolRef: toolRef(event.payloadRef), phase: 'running', ...optionalTurnId(event) },
        ],
        lastEventId: event.eventId,
      };
    case 'tool_completed': {
      const ref = toolRef(event.payloadRef);
      const matched = view.tools.some((tool) => tool.toolRef === ref && tool.phase === 'running');
      return {
        ...base,
        tools: matched
          ? view.tools.map((tool) => (
            tool.toolRef === ref && tool.phase === 'running' ? { ...tool, phase: 'completed' } : tool
          ))
          : [...view.tools, { toolRef: ref, phase: 'completed', ...optionalTurnId(event) }],
        lastEventId: event.eventId,
      };
    }
    case 'agent_message':
      return {
        ...base,
        messages: [
          ...view.messages,
          {
            eventId: event.eventId,
            payloadRef: event.payloadRef,
            trust: event.trust,
            ...optionalTurnId(event),
          },
        ],
        lastEventId: event.eventId,
      };
    case 'approval_requested':
      return {
        ...base,
        // Stays pending until applyApprovalDecision() supplies an authorized decision.
        approval: {
          requestId: event.sourceEventId,
          status: 'pending',
          requestedAt: event.observedAt,
          ...optionalTurnId(event),
        },
        lastEventId: event.eventId,
      };
    case 'unsupported':
      // Unknown producer drifts stay diagnostic; they never become message or tool rows.
      return { ...base, unsupportedCount: view.unsupportedCount + 1, lastEventId: event.eventId };
    default:
      return { ...base, lastEventId: event.eventId };
  }
}

/**
 * Apply an authorized decision. Unlike stream events this is never derived from the wire: the
 * caller must hold the decision, name the request id it answers, and identify the authorizer.
 * Unknown or already-answered request ids leave the view untouched.
 */
export function applyApprovalDecision(
  view: ManagedSessionView,
  decision: AuthorizedApprovalDecision,
): ManagedSessionView {
  if (decision.authorizedBy.trim().length === 0) {
    throw new TypeError('An approval decision requires an authorized actor');
  }
  if (view.approval === null || view.approval.requestId !== decision.requestId) return view;
  return { ...view, approval: null };
}

/** Marks the session closed (companion failure or deliberate close) without answering approvals. */
export function markSessionClosed(view: ManagedSessionView): ManagedSessionView {
  return { ...view, phase: 'closed' };
}
