/**
 * C02 argument binding. A proposal is only as specific as its arguments, so the hash binds the
 * ordered steps (operation, target ref, target fingerprint, value), the declared effect, and the
 * scope: a grant that names one hash can never authorize a different target, value, or effect.
 *
 * The hash is SHA-256 over a canonical JSON encoding (keys sorted, dropped `undefined`), so the
 * same arguments always produce the same hash and id on every replay, and it runs on WebCrypto
 * (`globalThis.crypto.subtle`), which exists in Node and in the Electron main process without
 * pulling a Node-only module into the desktop tools.
 */
import type { Scope } from '../../../contracts/src/index.js';
import type { DesktopActionEffect, DesktopActionStep } from './types.js';

/** §5.9 confirmation expiry: an authorization is live for at most 30 s after the grant. */
export const MAX_AUTHORIZATION_MS = 30_000;

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
  throw new TypeError('C02: argument hash input must be JSON-serializable');
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new TypeError('C02: WebCrypto SHA-256 is unavailable in this runtime');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The scope binding, normalized so optional ids hash the same whether omitted or `undefined`. */
function scopeBinding(scope: Scope): Readonly<Record<string, string | null>> {
  return {
    profileId: scope.profileId,
    projectId: scope.projectId ?? null,
    worktreeId: scope.worktreeId ?? null,
    sessionId: scope.sessionId ?? null,
    sensitivity: scope.sensitivity,
  };
}

export type ArgumentBinding = Readonly<{
  actionId: string;
  effect: DesktopActionEffect;
  scope: Scope;
  steps: ReadonlyArray<DesktopActionStep>;
}>;

/** Binds every ordered step, the declared effect, and the explicit project scope. */
export async function argumentHashFor(binding: ArgumentBinding): Promise<string> {
  return sha256Hex(canonicalJson({
    actionId: binding.actionId,
    effect: binding.effect,
    scope: scopeBinding(binding.scope),
    steps: binding.steps.map((step) => ({
      stepId: step.stepId,
      operation: step.operation,
      targetRef: step.targetRef,
      targetFingerprint: step.targetFingerprint,
      value: step.value,
    })),
  }));
}

/**
 * The proposal id is derived from the scope, action, idempotency key, and argument hash, so a
 * replay of the same request addresses the same proposal and a changed argument can never reuse it.
 */
export async function proposalIdFor(input: Readonly<{
  scope: Scope;
  actionId: string;
  idempotencyKey: string;
  argumentHash: string;
}>): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    scope: scopeBinding(input.scope),
    actionId: input.actionId,
    idempotencyKey: input.idempotencyKey,
    argumentHash: input.argumentHash,
  }));
  return `proposal-${digest.slice(0, 16)}`;
}

/** The grant id is derived from the binding and the grant instant; `sequence` keeps replays unique. */
export async function authorizationIdFor(input: Readonly<{
  proposalId: string;
  argumentHash: string;
  utteranceId: string;
  issuedAtMs: number;
  sequence: number;
}>): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    proposalId: input.proposalId,
    argumentHash: input.argumentHash,
    utteranceId: input.utteranceId,
    issuedAtMs: input.issuedAtMs,
    sequence: input.sequence,
  }));
  return `grant-${digest.slice(0, 16)}`;
}
