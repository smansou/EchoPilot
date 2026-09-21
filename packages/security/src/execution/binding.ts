/**
 * S04 request binding. A proposal is only as specific as its binding, so the proposal id is a
 * SHA-256 over a canonical JSON encoding of the explicit scope, the request id, the idempotency
 * key, the executor, the argv array, the working directory, the requested network hosts, and the
 * grant id: a replayed request (same binding) addresses the same proposal, and a request whose
 * argv, workdir, executor, or grant changed can never reuse it.
 *
 * The encoding drops `undefined` and sorts object keys, so the same request always produces the
 * same id — including across processes, which is what makes a replayed tool call idempotent.
 */
import { createHash } from 'node:crypto';

import type { Scope } from '../../../contracts/src/index.js';
import type { CommandRequest } from './types.js';

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
  throw new TypeError('S04: binding input must be JSON-serializable');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The scope binding: normalized so an omitted optional id hashes the same as `undefined`. */
export function scopeBinding(scope: Scope): Readonly<Record<string, string | null>> {
  return {
    profileId: scope.profileId,
    projectId: scope.projectId ?? null,
    worktreeId: scope.worktreeId ?? null,
    sessionId: scope.sessionId ?? null,
    sensitivity: scope.sensitivity,
  };
}

/**
 * The proposal binding. The timeout is deliberately not part of it: the proposal is the
 * containment plan (executor, argv, mount, network, authority), and the same plan proposed with a
 * different timeout is still the same plan.
 */
export function proposalIdFor(request: CommandRequest): string {
  const digest = sha256Hex(canonicalJson({
    scope: scopeBinding(request.scope),
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    executor: request.executor,
    argv: [...request.argv],
    workdir: request.workdir,
    networkAllow: [...request.networkAllow],
    grantId: request.grantId,
  }));
  return `proposal-${digest.slice(0, 16)}`;
}
