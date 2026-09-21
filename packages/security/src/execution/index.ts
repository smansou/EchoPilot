/**
 * S04 — scoped command request → isolated or explicit host executor → observed outcome
 * (IMPLEMENTATION_PLAN.md §7.2 S04; §5.9 "Security, keys, permissions, and execution").
 *
 * `createCommandExecution({ vm, grants, now })` is the seam between a scoped command request and
 * whatever actually runs it. §5.9 gives the companion two executors and no third one:
 *
 * - the default is the managed Linux VM (`isolated-vm`): one writable mount — the canonical
 *   granted workspace root, never the workspace's parent, the home directory, or `/` — and a
 *   controlled network profile that is an allowlist (or `deny`) and never `open`. Lima is an
 *   optional component, so the backend is injected: with no VM installed, a VM request is denied
 *   `vm_unavailable` and is never quietly run on the host instead;
 * - the native macOS path (`host-execution`) is available only with the explicit
 *   `execution.host_autonomy` grant, which the proposal surfaces and dispatch re-checks. Host
 *   execution claims no containment: no mount, no network namespace, only the managed process.
 *
 * What the request can never do is choose its own containment: mounts, the network profile, and
 * host authority are not request fields. A request may *narrow* the granted network allowlist and
 * nothing else (`network_not_granted`), and a shell (`sh -c …`) is refused as a script
 * (`shell_script_requires_grant`) because scripts are their own granted capability.
 *
 * Everything the executor reports is what it observed. `propose` is inert; `dispatch` re-reads the
 * grant immediately before running and an unknown, revoked, or unauthorized grant starts nothing
 * (exit code null, empty output, no process group). A timeout or cancel stops the managed process
 * group for real, and a child the executor cannot prove stopped — one that left the group, or a
 * guest process Lima cannot reach — is reported in `uncertainChildren` with its pid and evidence,
 * with `stopped: false`. The executor never upgrades a denial into a run, or a survivor into a
 * clean stop.
 *
 * The clock is injected: `observedAt` on every outcome comes from `now`, so a scenario replays
 * byte-stable. The native counterpart of the process half is `native/macos/Sources/Execution`
 * (libproc process observation); the VM half is whatever `VmPort` the host wires in (the managed
 * Lima instance in production, a deterministic guest in the oracle).
 */
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { proposalIdFor } from './binding.js';
import {
  authorityGuard,
  effectiveNetworkHosts,
  grantGuard,
  networkGuard,
  networkProfile,
  shellGuard,
} from './guards.js';
import { startHostRun, type HostRun } from './host-executor.js';
import { createProcessTable, type ProcessTable } from './process-table.js';
import type {
  CommandExecution,
  CommandExecutionOptions,
  CommandOutcome,
  CommandProposal,
  CommandRequest,
  ExecutionDenialReason,
  ExecutionExecutor,
  GrantSnapshot,
  Mount,
  UncertainChild,
  VmObservation,
} from './types.js';
import {
  DEFAULT_TIMEOUT_MS,
  HOST_AUTONOMY_CAPABILITY,
  HOST_EXECUTION_LABEL,
  ISOLATED_VM_LABEL,
} from './types.js';

type ActiveVmCommand = { readonly executor: 'vm'; cancelledOutcome: CommandOutcome | null };
type ActiveHostCommand = { readonly executor: 'host'; readonly run: HostRun };
type ActiveCommand = ActiveVmCommand | ActiveHostCommand;

export function executionLabelFor(executor: ExecutionExecutor): string {
  return executor === 'host' ? HOST_EXECUTION_LABEL : ISOLATED_VM_LABEL;
}

/** Deduplicate by pid: the first evidence for a pid wins, and a pid is never reported twice. */
function mergeUncertainChildren(
  left: readonly UncertainChild[],
  right: readonly UncertainChild[],
): readonly UncertainChild[] {
  const merged = new Map<number, UncertainChild>();
  for (const entry of [...left, ...right]) {
    if (!merged.has(entry.pid)) merged.set(entry.pid, entry);
  }
  return [...merged.values()];
}

export function createCommandExecution(options: CommandExecutionOptions): CommandExecution {
  const vm = options.vm ?? null;
  const grants = options.grants;
  const now = options.now ?? (() => new Date());
  const table: ProcessTable = options.table ?? createProcessTable();

  const active = new Map<string, ActiveCommand>();
  const known = new Map<string, Readonly<{ executor: ExecutionExecutor; proposalId: string }>>();

  const observedAt = (): string => now().toISOString();

  /** The canonical granted workspace root: a symlinked granted root mounts as its real path. */
  const canonicalPath = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };

  /** The VM's mount set: exactly one writable mount of the canonical granted workspace root. */
  const mountsFor = async (request: CommandRequest, grant: GrantSnapshot | null): Promise<readonly Mount[]> => {
    if (request.executor !== 'vm' || grant === null) return [];
    const workspaceRoot = grant.resource.workspaceRoot;
    const guestRoot = grant.resource.guestRoot;
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return [];
    if (typeof guestRoot !== 'string' || guestRoot.length === 0) return [];
    return [{ source: await canonicalPath(workspaceRoot), target: guestRoot, writable: true }];
  };

  const deny = (
    request: CommandRequest,
    proposalId: string,
    reason: ExecutionDenialReason,
  ): CommandOutcome => ({
    requestId: request.requestId,
    proposalId,
    executor: request.executor,
    executionLabel: executionLabelFor(request.executor),
    state: 'denied',
    reason,
    exitCode: null,
    stdout: '',
    stderr: '',
    processGroupId: null,
    stopped: true,
    uncertainChildren: [],
    observedAt: observedAt(),
  });

  const remember = (request: CommandRequest, proposalId: string): void => {
    known.set(request.requestId, { executor: request.executor, proposalId });
  };

  const propose = async (request: CommandRequest): Promise<CommandProposal> => {
    const grant = await grants.current(request.grantId);
    const proposalId = proposalIdFor(request);
    remember(request, proposalId);
    return {
      proposalId,
      requestId: request.requestId,
      executor: request.executor,
      executionLabel: executionLabelFor(request.executor),
      argv: [...request.argv],
      workdir: request.workdir,
      mounts: await mountsFor(request, grant),
      network: request.executor === 'vm'
        ? networkProfile(effectiveNetworkHosts(request, grant))
        : null,
      hostAuthority: request.executor === 'host' && grant !== null
        ? {
          capability: HOST_AUTONOMY_CAPABILITY,
          grantId: grant.grantId,
          grantVersion: grant.version,
        }
        : null,
      grantId: request.grantId,
      grantVersion: grant?.version ?? 0,
    };
  };

  const runVm = async (
    request: CommandRequest,
    grant: GrantSnapshot,
    proposalId: string,
    timeoutMs: number,
  ): Promise<CommandOutcome> => {
    const backend = vm;
    if (backend === null) return deny(request, proposalId, 'vm_unavailable');
    const entry: ActiveVmCommand = { executor: 'vm', cancelledOutcome: null };
    active.set(request.requestId, entry);
    try {
      const observation: VmObservation = await backend.run({
        requestId: request.requestId,
        argv: [...request.argv],
        workdir: request.workdir,
        mounts: await mountsFor(request, grant),
        network: networkProfile(effectiveNetworkHosts(request, grant)),
        timeoutMs,
      });
      let uncertainChildren: readonly UncertainChild[] = observation.uncertainChildren;
      if (observation.state === 'timed_out' || observation.state === 'cancelled') {
        try {
          const report = await backend.stop(request.requestId);
          uncertainChildren = mergeUncertainChildren(uncertainChildren, report.uncertainChildren);
        } catch {
          // The backend refused to stop: the observation stands, survivors and all.
        }
      }
      const cancelled = entry.cancelledOutcome;
      if (cancelled !== null) return cancelled;
      return {
        requestId: request.requestId,
        proposalId,
        executor: 'vm',
        executionLabel: ISOLATED_VM_LABEL,
        state: observation.state,
        exitCode: observation.exitCode,
        stdout: observation.stdout,
        stderr: observation.stderr,
        processGroupId: observation.processGroupId,
        stopped: uncertainChildren.length === 0,
        uncertainChildren,
        observedAt: observedAt(),
      };
    } catch (error) {
      return {
        requestId: request.requestId,
        proposalId,
        executor: 'vm',
        executionLabel: ISOLATED_VM_LABEL,
        state: 'failed',
        reason: 'vm_failed',
        exitCode: null,
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        processGroupId: null,
        stopped: false,
        uncertainChildren: [],
        observedAt: observedAt(),
      };
    } finally {
      active.delete(request.requestId);
    }
  };

  const runHost = async (
    request: CommandRequest,
    proposalId: string,
    timeoutMs: number,
  ): Promise<CommandOutcome> => {
    const run = startHostRun({ request, proposalId, table, now, timeoutMs });
    active.set(request.requestId, { executor: 'host', run });
    try {
      return await run.outcome;
    } finally {
      active.delete(request.requestId);
    }
  };

  const dispatch = async (request: CommandRequest): Promise<CommandOutcome> => {
    const proposalId = proposalIdFor(request);
    remember(request, proposalId);
    if (request.argv.length === 0) return deny(request, proposalId, 'invalid_request');
    if (request.executor === 'vm' && vm === null) return deny(request, proposalId, 'vm_unavailable');

    // §5.9: the grant is re-read immediately before execution, never trusted from the proposal.
    const grant = await grants.current(request.grantId);
    const grantVerdict = grantGuard(grant);
    if (!grantVerdict.ok) return deny(request, proposalId, grantVerdict.reason);
    const live = grant as GrantSnapshot;
    const authorityVerdict = authorityGuard(request, live);
    if (!authorityVerdict.ok) return deny(request, proposalId, authorityVerdict.reason);
    const networkVerdict = networkGuard(request, live);
    if (!networkVerdict.ok) return deny(request, proposalId, networkVerdict.reason);
    const shellVerdict = shellGuard(request.argv);
    if (!shellVerdict.ok) return deny(request, proposalId, shellVerdict.reason);

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return request.executor === 'vm'
      ? await runVm(request, live, proposalId, timeoutMs)
      : await runHost(request, proposalId, timeoutMs);
  };

  const cancel = async (requestId: string): Promise<CommandOutcome> => {
    const entry = active.get(requestId);
    if (entry !== undefined && entry.executor === 'host') {
      return await entry.run.cancel();
    }
    if (entry !== undefined && entry.executor === 'vm' && vm !== null) {
      let uncertainChildren: readonly UncertainChild[] = [];
      let stopped = false;
      try {
        const report = await vm.stop(requestId);
        uncertainChildren = report.uncertainChildren;
        stopped = report.stopped && uncertainChildren.length === 0;
      } catch {
        // Nothing was proven: report the cancel as unverified rather than claiming a stop.
        uncertainChildren = [];
        stopped = false;
      }
      const outcome: CommandOutcome = {
        requestId,
        proposalId: known.get(requestId)?.proposalId ?? '',
        executor: 'vm',
        executionLabel: ISOLATED_VM_LABEL,
        state: 'cancelled',
        exitCode: null,
        stdout: '',
        stderr: '',
        processGroupId: null,
        stopped,
        uncertainChildren,
        observedAt: observedAt(),
      };
      entry.cancelledOutcome = outcome;
      return outcome;
    }
    const identity = known.get(requestId);
    return {
      requestId,
      proposalId: identity?.proposalId ?? '',
      executor: identity?.executor ?? 'vm',
      executionLabel: executionLabelFor(identity?.executor ?? 'vm'),
      state: 'denied',
      reason: 'not_running',
      exitCode: null,
      stdout: '',
      stderr: '',
      processGroupId: null,
      stopped: true,
      uncertainChildren: [],
      observedAt: observedAt(),
    };
  };

  return { propose, dispatch, cancel };
}
