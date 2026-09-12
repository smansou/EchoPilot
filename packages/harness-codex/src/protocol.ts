/**
 * Protocol surface of the managed Codex app-server, projected from the generated JSON Schema
 * bundle of the installed, tested CLI (see `scripts/generate-protocol.mjs`).
 *
 * Every method name and decision string the adapter puts on the wire is verified against that
 * projection at module load. A drifted or hand-written constant fails loudly here instead of
 * silently mutating a session with a method the pinned server never advertised.
 */
import { generatedProtocol } from './generated/protocol.js';

/** The `codex-cli` version whose generated schemas this adapter ships. */
export const SUPPORTED_SERVER_VERSION: string = generatedProtocol.cliVersion;

const clientRequests = new Set<string>(generatedProtocol.clientRequests);
const clientNotifications = new Set<string>(generatedProtocol.clientNotifications);
const serverNotifications = new Set<string>(generatedProtocol.serverNotifications);
const serverRequests = new Set<string>(generatedProtocol.serverRequests);
const threadItemTypes = new Set<string>(generatedProtocol.threadItemTypes);
const approvalDecisions = new Set<string>(generatedProtocol.approvalDecisions);

function requireFrom(source: Set<string>, kind: string, name: string): string {
  if (!source.has(name)) {
    throw new Error(
      `Codex app-server ${SUPPORTED_SERVER_VERSION} does not advertise the ${kind} "${name}"; `
      + 'regenerate packages/harness-codex/schema and src/generated/protocol.ts from the installed CLI.',
    );
  }
  return name;
}

/** The exact method names the tracer bullet depends on, verified against the generated schemas. */
export const METHODS = {
  initialize: requireFrom(clientRequests, 'client request', 'initialize'),
  initialized: requireFrom(clientNotifications, 'client notification', 'initialized'),
  threadStart: requireFrom(clientRequests, 'client request', 'thread/start'),
  threadResume: requireFrom(clientRequests, 'client request', 'thread/resume'),
  turnStart: requireFrom(clientRequests, 'client request', 'turn/start'),
  turnInterrupt: requireFrom(clientRequests, 'client request', 'turn/interrupt'),
} as const;

/**
 * Server → client requests that gate a command on an authorized human/companion decision.
 * Only methods present in the generated schema are answerable; everything else stays unanswered.
 */
export const APPROVAL_REQUEST_METHODS: ReadonlySet<string> = new Set(
  [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'applyPatchApproval',
    'execCommandApproval',
  ].filter((method) => serverRequests.has(method)),
);

/**
 * Thread items that represent an executed tool. `commandExecution` is mandatory for the tracer
 * bullet (read-only fixture task); the rest are the documented tool-ish discriminants of this
 * schema revision, intersected with what the generated bundle actually ships.
 */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(
  [
    requireFrom(threadItemTypes, 'thread item', 'commandExecution'),
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'webSearch',
    'imageView',
    'imageGeneration',
    'collabAgentToolCall',
  ].filter((type) => threadItemTypes.has(type)),
);

export const AGENT_MESSAGE_ITEM_TYPE: string = requireFrom(threadItemTypes, 'thread item', 'agentMessage');
export const HIDDEN_REASONING_ITEM_TYPE: string = requireFrom(threadItemTypes, 'thread item', 'reasoning');

/** Decisions the pinned app-server accepts for an approval request. */
export const APPROVE_DECISION: string = requireFrom(approvalDecisions, 'approval decision', 'accept');
export const DENY_DECISION: string = requireFrom(approvalDecisions, 'approval decision', 'decline');

export function isKnownServerNotification(method: string): boolean {
  return serverNotifications.has(method);
}

export function isApprovalRequestMethod(method: string): boolean {
  return APPROVAL_REQUEST_METHODS.has(method);
}

export function isToolItemType(itemType: unknown): itemType is string {
  return typeof itemType === 'string' && TOOL_ITEM_TYPES.has(itemType);
}

/**
 * Streamed content fragments of the pinned schema are never surfaced as their own event; the
 * completed item carries the content. Methods the schema does not describe still surface as
 * `unsupported` diagnostics rather than being silently dropped.
 */
export function isStreamedContentNotification(method: string): boolean {
  return serverNotifications.has(method) && (method.includes('outputDelta') || method.endsWith('/delta'));
}

/** Streamed model reasoning must never become user-visible content. */
export function isHiddenReasoningNotification(method: string): boolean {
  return method.startsWith('item/reasoning/');
}
