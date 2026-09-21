/**
 * S04 — the structural contract of the scoped-command executor
 * (IMPLEMENTATION_PLAN.md §7.2 S04; §5.9 "Security, keys, permissions, and execution").
 *
 * The pieces frozen here are the ones the tool half (`packages/desktop-tools/src/commands`)
 * and the native halves (`native/macos/Sources/Execution`, the libproc process table) meet on:
 *
 * - a `CommandRequest` is one scoped request: an argv array (never a shell string), the executor
 *   it asks for, the guest/host working directory, the network hosts it would like, and the grant
 *   it rides on. Mounts, the network profile, and host authority are *never* request fields —
 *   they are what the executor derives and surfaces in a proposal;
 * - a `CommandProposal` is inert: the canonical granted mount (VM), the controlled network profile
 *   (an allowlist that is never `open`), and the host authority the host executor would exercise;
 * - a `VmPort` is the injected managed-Lima backend (Lima is an optional component, so `null`
 *   means VM commands are refused with `vm_unavailable`, never downgraded to host execution);
 * - a `CommandOutcome` is what the executor *observed*, including `stopped` and
 *   `uncertainChildren`: a process the executor could not prove stopped is reported with its pid
 *   and evidence instead of being folded into a clean success.
 */
import type { Scope } from '../../../contracts/src/index.js';

/** §7.2 S04 labels: which executor actually ran the command. */
export const ISOLATED_VM_LABEL = 'isolated-vm';
export const HOST_EXECUTION_LABEL = 'host-execution';

/** §5.9 permission tuple values for the two executors, and the separate shell capability. */
export const VM_CAPABILITY = 'execution.vm';
export const VM_DESTINATION = 'managed-vm';
export const HOST_AUTONOMY_CAPABILITY = 'execution.host_autonomy';
export const HOST_DESTINATION = 'native-host';
export const SHELL_SCRIPT_CAPABILITY = 'execution.shell_script';

/** Programs that turn an argv into an interpreter script; they need the shell-script capability. */
export const SHELL_PROGRAMS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh'];

/** A command with no explicit timeout still gets one: nothing runs unbounded. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type ExecutionExecutor = 'vm' | 'host';

export type ExecutionState = 'completed' | 'failed' | 'denied' | 'timed_out' | 'cancelled';

/**
 * Denial reasons. Every one of them means "nothing was started": `exitCode` is null, stdout/stderr
 * are empty, and no process group exists — the tool half reports the reason verbatim.
 */
export type ExecutionDenialReason =
  | 'grant_required'
  | 'grant_revoked'
  | 'host_autonomy_required'
  | 'network_not_granted'
  | 'shell_script_requires_grant'
  | 'vm_unavailable'
  | 'invalid_request'
  | 'not_running'
  | 'stop_unverified';

/** The §5.9 permission tuple as the executor sees it immediately before execution. */
export type GrantSnapshot = Readonly<{
  grantId: string;
  version: number;
  state: 'active' | 'revoked';
  capability: string;
  destination: string;
  resource: Readonly<Record<string, string>>;
  networkAllow: readonly string[];
}>;

/** The grant source is injected: it is re-read before execution, never cached by the executor. */
export type GrantSource = Readonly<{ current(grantId: string): Promise<GrantSnapshot | null> }>;

export type CommandRequest = Readonly<{
  requestId: string;
  idempotencyKey: string;
  scope: Scope;
  utterance: string;
  executor: ExecutionExecutor;
  argv: readonly string[];
  workdir: string;
  networkAllow: readonly string[];
  grantId: string;
  timeoutMs?: number;
}>;

export type Mount = Readonly<{ source: string; target: string; writable: boolean }>;

export type NetworkProfile = Readonly<{ mode: 'deny' | 'allowlist'; hosts: readonly string[] }>;

export type HostAuthority = Readonly<{ capability: string; grantId: string; grantVersion: number }>;

export type CommandProposal = Readonly<{
  proposalId: string;
  requestId: string;
  executor: ExecutionExecutor;
  executionLabel: string;
  argv: readonly string[];
  workdir: string;
  mounts: readonly Mount[];
  network: NetworkProfile | null;
  hostAuthority: HostAuthority | null;
  grantId: string;
  grantVersion: number;
}>;

export type UncertainChild = Readonly<{ pid: number; evidence: string }>;

/** The plan handed to the VM backend: argv, guest working directory, mounts, network, timeout. */
export type VmRunPlan = Readonly<{
  requestId: string;
  argv: readonly string[];
  workdir: string;
  mounts: readonly Mount[];
  network: NetworkProfile | null;
  timeoutMs: number;
}>;

/** What the guest observed. `uncertainChildren` are guest processes the backend cannot prove dead. */
export type VmObservation = Readonly<{
  state: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  processGroupId: number | null;
  uncertainChildren: readonly UncertainChild[];
}>;

export type VmStopReport = Readonly<{ stopped: boolean; uncertainChildren: readonly UncertainChild[] }>;

export type VmPort = Readonly<{
  run(plan: VmRunPlan): Promise<VmObservation>;
  stop(requestId: string): Promise<VmStopReport>;
}>;

export type CommandOutcome = Readonly<{
  requestId: string;
  proposalId: string;
  executor: ExecutionExecutor;
  executionLabel: string;
  state: ExecutionState;
  reason?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  processGroupId: number | null;
  stopped: boolean;
  uncertainChildren: readonly UncertainChild[];
  observedAt: string;
}>;

export type CommandExecution = Readonly<{
  propose(request: CommandRequest): Promise<CommandProposal>;
  dispatch(request: CommandRequest): Promise<CommandOutcome>;
  cancel(requestId: string): Promise<CommandOutcome>;
}>;

export type CommandExecutionOptions = Readonly<{
  vm?: VmPort | null;
  grants: GrantSource;
  /** Deterministic clock: every observed timestamp comes from here. */
  now?: () => Date;
  /** The process table the host executor records descendants from; injectable for tests. */
  table?: import('./process-table.js').ProcessTable;
}>;
