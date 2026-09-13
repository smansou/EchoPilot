/**
 * Deterministic extraction for N01: one normalized §5.3 envelope plus the payload its `payloadRef`
 * resolves to becomes either a task receipt or nothing at all.
 *
 * The rules that matter for the acceptance criteria live here:
 *
 * - a receipt only exists when the *tool* reported the result (`tool_completed` with tool-observed
 *   or imported trust). Agent text is context; the managed app-server fixture shows an agent message
 *   claiming "all 24 read-only checks passed" right after the shell exited 1, and that sentence can
 *   never upgrade the observed exit code;
 * - exit codes are integers (a JSON numeric string is accepted because app-server payloads are
 *   inconsistent); prose numbers like "24 checks" are never exit codes;
 * - every reader is defensive: an unknown shape resolves to `null` instead of throwing, because a
 *   narration tracer must not take the ingest pipeline down over one unexpected payload.
 */
import type { EventEnvelope } from '../../contracts/src/index.js';

/** A `tool_started` payload in the pinned `fixtures/harness/codex` app-server shape. */
export type ToolStart = Readonly<{
  taskId: string | null;
  command: string | null;
  title: string | null;
  receiptId: string | null;
}>;

/** A `tool_completed` payload: the only place an observed exit code may come from. */
export type ToolCompletion = Readonly<{
  taskId: string | null;
  command: string | null;
  receiptId: string | null;
  output: string | null;
  exitCode: number | null;
}>;

export type SessionStatePayload = Readonly<{ method: string | null; status: string | null }>;

/** The app-server method that closes one managed turn (the turn's last event). */
export const TURN_COMPLETED_METHOD = 'turn/completed';

const MAX_TEXT = 8_192;
const MAX_IDENTIFIER = 128;

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT) return null;
  return trimmed;
}

function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  const raw = text(value);
  if (raw === null || raw.length > MAX_IDENTIFIER) return null;
  return raw;
}

/** Exit codes are integers; a numeric string is accepted, anything wordy is not an exit code. */
export function exitCode(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Reads the tool-start fields N01 needs; a payload without any of them is not a tool start. */
export function readToolStart(payload: unknown): ToolStart | null {
  const input = record(payload);
  if (!input) return null;
  const start: ToolStart = {
    taskId: identifier(input.taskId),
    command: text(input.command),
    title: text(input.title),
    receiptId: identifier(input.receiptId),
  };
  if (start.taskId === null && start.command === null && start.title === null) return null;
  return start;
}

/** Reads the tool-completion fields N01 needs; an exit code is optional but never invented. */
export function readToolCompletion(payload: unknown): ToolCompletion | null {
  const input = record(payload);
  if (!input) return null;
  return {
    taskId: identifier(input.taskId),
    command: text(input.command),
    receiptId: identifier(input.receiptId),
    output: text(input.output),
    exitCode: exitCode(input.exitCode),
  };
}

/** Agent/user prose is display context only; it is retained so it is demonstrably never a receipt. */
export function readAgentText(payload: unknown): string | null {
  const input = record(payload);
  if (!input) return null;
  return text(input.text);
}

export function readSessionState(payload: unknown): SessionStatePayload | null {
  const input = record(payload);
  if (!input) return null;
  return { method: text(input.method), status: text(input.status) };
}

/**
 * True only for envelopes whose result was observed by the tool boundary. `agent_reported` and
 * `user_explicit` envelopes are never receipts even when their payload mimics a tool completion.
 */
export function isObservedToolReceipt(event: EventEnvelope): boolean {
  return event.kind === 'tool_completed'
    && (event.trust === 'tool_observed' || event.trust === 'imported');
}
