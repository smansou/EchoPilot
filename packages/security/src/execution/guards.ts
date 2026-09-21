/**
 * S04 execution guards — the decisions taken after the grant is re-read and before anything is
 * started. They are pure functions over the request and the live grant, so the same tuple always
 * produces the same verdict and every check is re-evaluated per dispatch (never once per
 * proposal, which is exactly how a grant revoked between the two is caught).
 *
 * Order (first match wins, and the first check is the one that can stop execution outright):
 *   1. availability — a VM request with no VM backend is `vm_unavailable` before any grant work,
 *      because Lima is an optional component and a missing VM is never downgraded to the host;
 *   2. grant        — unknown/inactive grant, then a capability+destination that does not
 *      authorize the requested executor (`host_autonomy_required` for the host executor);
 *   3. network      — a request may narrow the granted allowlist but never widen it;
 *   4. shell        — an argv whose program is a shell is a script, and scripts are their own
 *      granted capability.
 */
import type {
  CommandRequest,
  ExecutionDenialReason,
  GrantSnapshot,
  NetworkProfile,
} from './types.js';
import {
  HOST_AUTONOMY_CAPABILITY,
  HOST_DESTINATION,
  SHELL_PROGRAMS,
  VM_CAPABILITY,
  VM_DESTINATION,
} from './types.js';

export type GuardVerdict = Readonly<{ ok: true } | { ok: false; reason: ExecutionDenialReason }>;

const ALLOWED: GuardVerdict = { ok: true };

/** The grant was revoked (or replaced by a revoked revision) after the proposal was surfaced. */
export function grantGuard(grant: GrantSnapshot | null): GuardVerdict {
  if (grant === null) return { ok: false, reason: 'grant_required' };
  if (grant.state !== 'active') return { ok: false, reason: 'grant_revoked' };
  return ALLOWED;
}

/** The §5.9 capability+destination tuple that authorizes the requested executor. */
export function authorityGuard(request: CommandRequest, grant: GrantSnapshot): GuardVerdict {
  if (request.executor === 'host') {
    return grant.capability === HOST_AUTONOMY_CAPABILITY && grant.destination === HOST_DESTINATION
      ? ALLOWED
      : { ok: false, reason: 'host_autonomy_required' };
  }
  return grant.capability === VM_CAPABILITY && grant.destination === VM_DESTINATION
    ? ALLOWED
    : { ok: false, reason: 'grant_required' };
}

/** The effective network profile: the grant's allowlist narrowed by the request, never widened. */
export function effectiveNetworkHosts(
  request: CommandRequest,
  grant: GrantSnapshot | null,
): readonly string[] {
  if (grant === null) return [];
  const requested = new Set(request.networkAllow);
  return grant.networkAllow.filter((host) => requested.has(host));
}

/** A request that names a host outside the grant's allowlist is refused before it reaches a VM. */
export function networkGuard(request: CommandRequest, grant: GrantSnapshot): GuardVerdict {
  const granted = new Set(grant.networkAllow);
  return request.networkAllow.every((host) => granted.has(host))
    ? ALLOWED
    : { ok: false, reason: 'network_not_granted' };
}

/** `sh -c`, `bash script.sh`, … are interpreter scripts, not argv: they need their own grant. */
export function shellGuard(argv: readonly string[]): GuardVerdict {
  const program = argv[0];
  if (program === undefined) return { ok: false, reason: 'invalid_request' };
  const name = program.split('/').pop()?.toLowerCase() ?? '';
  return SHELL_PROGRAMS.includes(name)
    ? { ok: false, reason: 'shell_script_requires_grant' }
    : ALLOWED;
}

/** The VM's controlled network profile. It is an allowlist or it is deny — never `open`. */
export function networkProfile(hosts: readonly string[]): NetworkProfile {
  const unique = [...new Set(hosts)].filter((host) => host.length > 0);
  return unique.length === 0
    ? { mode: 'deny', hosts: [] }
    : { mode: 'allowlist', hosts: unique };
}
