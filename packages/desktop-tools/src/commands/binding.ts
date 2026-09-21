/**
 * S04 request binding. `requestId` and `idempotencyKey` are derived from the call id and the
 * validated call, so a replayed tool call is the same command request — the executor then sees
 * the same binding and addresses the same proposal — while a different call can never reuse the
 * identity. The hash runs on WebCrypto (`globalThis.crypto.subtle`), which exists in Node and in
 * the Electron main process without pulling a Node-only module into the desktop tools.
 */
import type { Scope } from '../../../contracts/src/index.js';
import type { ValidatedCommandArguments } from './guards.js';

/** Deterministic encoding: keys sorted, `undefined` dropped, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new TypeError('S04: request binding input must be JSON-serializable');
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new TypeError('S04: WebCrypto SHA-256 is unavailable in this runtime');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The scope binding: normalized so an omitted optional id hashes the same as `undefined`. */
function scopeBinding(scope: Scope): Readonly<Record<string, string | null>> {
  return {
    profileId: scope.profileId,
    projectId: scope.projectId ?? null,
    worktreeId: scope.worktreeId ?? null,
    sessionId: scope.sessionId ?? null,
    sensitivity: scope.sensitivity,
  };
}

export type CommandRequestBinding = Readonly<{ requestId: string; idempotencyKey: string }>;

/**
 * The identity of one tool call's command request. The timeout is bound too: it is part of the
 * request the executor dispatches even though it is not part of the proposal's containment.
 */
export async function commandRequestBinding(
  callId: string,
  scope: Scope,
  args: ValidatedCommandArguments,
): Promise<CommandRequestBinding> {
  const digest = await sha256Hex(canonicalJson({
    callId,
    scope: scopeBinding(scope),
    executor: args.executor,
    argv: [...args.argv],
    workdir: args.workdir,
    networkAllow: [...args.networkAllow],
    grantId: args.grantId,
    timeoutMs: args.timeoutMs ?? null,
  }));
  return { requestId: `command-${callId}`, idempotencyKey: `idempotency-${digest.slice(0, 32)}` };
}
