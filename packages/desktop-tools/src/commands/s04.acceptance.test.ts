/**
 * S04 acceptance oracle (tool half) — a raw `run_command` tool call → scoped command request →
 * isolated or explicit host executor → observed outcome (IMPLEMENTATION_PLAN.md §7.2 S04; §5.9
 * "Default command execution uses the coding harness's supported sandbox. For companion-owned
 * generic commands, provide a Linux VM executor using a managed VM backend with an explicitly
 * mounted workspace and controlled network policy. Native macOS host execution remains available
 * with an explicit Host Autonomy grant").
 *
 * `packages/desktop-tools/src/commands/index.ts` must export (this file freezes these names; the
 * executor half of the same seam is frozen in
 * packages/security/src/execution/s04.acceptance.test.ts):
 *
 *   createCommandTool({ execution, scope }) → CommandTool
 *
 *     execution — the S04 executor port (`packages/security/src/execution`):
 *       propose(request) → Promise<CommandProposal>
 *         The inert plan for a request: mounts, network profile, host authority, execution label.
 *       dispatch(request) → Promise<CommandOutcome>
 *         Runs the argv (never a shell string) through the isolated VM or the explicit host
 *         executor and reports the observed outcome, including `stopped` and `uncertainChildren`.
 *       cancel(requestId) → Promise<CommandOutcome>
 *         Stops the managed process group of an in-flight request.
 *
 *     scope — the explicit project association every call is bound to, e.g.
 *       { profileId: 'profile-s04', projectId: 'atlas', sensitivity: 'normal' }. A tool call never
 *       chooses its own scope. The tool holds no grant source: §5.9 authority (grant tuple, Host
 *       Autonomy, network allowlist, shell capability) is the executor's to check immediately
 *       before execution, and the executor's verdict is what the tool reports.
 *
 *     CommandTool:
 *       describe() → { name, description, parameters }
 *         The surface the model is offered. `name` is 'run_command'. `parameters` is an object
 *         schema whose `required` names at least executor, argv, workdir, and grantId, describing
 *         argv as an *array* of strings — there is no single-string `command` argument, so a shell
 *         string is not a representable call — plus the optional networkAllow and timeoutMs.
 *         Mounts, the network profile, and host authority are never call arguments: a caller cannot
 *         ask for its own containment.
 *       run(input) → Promise<CommandToolResult>
 *         input = { callId, utterance, toolCall: { name, arguments } } — the raw tool call exactly
 *         as the model produced it, plus the invoking request text.
 *         Validation first; a rejected call is inert (the executor is never asked to propose or
 *         dispatch anything, nothing starts):
 *           'invalid_tool_call'  wrong tool name; arguments that are not an object; an unknown
 *                                argument (mounts, network, hostAuthority, scope, requestId, …); a
 *                                malformed required field (an executor other than 'vm'|'host', an
 *                                empty workdir or grantId, a non-positive timeoutMs)
 *           'argv_required'      argv missing, not an array, empty, or holding a non-string
 *                                element — a string command is a shell string, not an argv array
 *         A valid call becomes one scoped CommandRequest: requestId and idempotencyKey are derived
 *         from the call id, so a replayed call is the same request; argv, workdir, networkAllow,
 *         grantId, executor, and the invoking utterance ride through verbatim.
 *         run() then asks the executor for the inert proposal — that is where the mount, the
 *         network profile, and the host authority come from — and dispatches the same request.
 *         Result = { callId, toolName, state, reason?, requestId, proposalId, executionLabel,
 *                    containment, exitCode, stdout, stderr, stopped, uncertainChildren, observedAt }
 *           containment        the proposal's { mounts, network, hostAuthority } surfaced verbatim;
 *                              null only when the call never became a request
 *           state / reason     the executor's verdict, never upgraded: a denied, timed-out, or
 *                              cancelled run is reported as such (a denial has exitCode null and
 *                              empty stdout) and is never claimed completed
 *           stopped / uncertainChildren
 *                              the executor's process-group report carried through: a run with a
 *                              child it cannot prove stopped stays `stopped: false` with evidence
 *           observedAt         the executor's observation time; null when nothing was observed
 *
 * Deterministic rules pinned here (BACKLOG.json S04 acceptance criteria):
 *   1. A tool call is an argv array, never a shell string, and the containment it runs under is the
 *      executor's proposal — a caller-supplied mount, network profile, host authority, or scope is
 *      rejected before anything is planned or started.
 *   2. A macOS-specific host call is surfaced as 'host-execution' with its Host Autonomy grant, and
 *      the executor's refusals ('host_autonomy_required', 'shell_script_requires_grant',
 *      'network_not_granted') are reported with nothing started.
 *   3. A timed-out, cancelled, or uncertain run is reported as observed: `stopped: false` plus the
 *      surviving children and their evidence, never claimed stopped and never upgraded.
 *
 * Remaining limitation: this half runs against a deterministic executor double so the tool surface
 * can be judged on its own; the composed VM and host paths are frozen by the executor oracle, and
 * real Lima isolation, kernel-level host containment, and the signed native helper still need a
 * manual qualification pass on installed hardware. Nothing here is hardware evidence.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../security/src/execution/fixtures/s04-execution.json', import.meta.url);
const MISSING_BEHAVIOR = 'Missing required behavior:';
const TOOL_NAME = 'run_command';
const NOW = '2026-09-21T09:00:00.000Z';
const TIMEOUT_MS = 10_000;
/** Synthetic host path the granted workspace would be mounted from; the tool only echoes it. */
const WORKSPACE_SOURCE = '/Users/atlas/Projects/atlas/allowed-workspace';

type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string }>;
  workspace: Readonly<{ guestRoot: string; probeFile: string }>;
  grants: Readonly<{ vmGrantId: string; hostGrantId: string; revokedGrantId: string }>;
  capabilities: Readonly<{ vm: string; hostAutonomy: string; shellScript: string }>;
  network: Readonly<{ allowedHost: string; deniedHost: string }>;
  labels: Readonly<{ vm: string; host: string }>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
const SCOPE: Scope = {
  profileId: fixture.profileId,
  projectId: fixture.project.projectId,
  sensitivity: 'normal',
};
const VM_ARGV: readonly string[] = ['/usr/bin/touch', fixture.workspace.probeFile];
const HOST_ARGV: readonly string[] = ['/usr/bin/sw_vers', '-productVersion'];

// ---------------------------------------------------------------------------------------------
// the frozen seam (structural stand-ins for the executor contract)

type Mount = Readonly<{ source: string; target: string; writable: boolean }>;
type NetworkProfile = Readonly<{ mode: 'deny' | 'allowlist'; hosts: readonly string[] }>;
type HostAuthority = Readonly<{ capability: string; grantId: string; grantVersion: number }>;
type UncertainChild = Readonly<{ pid: number; evidence: string }>;

type CommandRequest = Readonly<{
  requestId: string;
  idempotencyKey: string;
  scope: Scope;
  utterance: string;
  executor: 'vm' | 'host';
  argv: readonly string[];
  workdir: string;
  networkAllow: readonly string[];
  grantId: string;
  timeoutMs?: number;
}>;

type CommandProposal = Readonly<{
  proposalId: string;
  requestId: string;
  executor: 'vm' | 'host';
  executionLabel: string;
  argv: readonly string[];
  workdir: string;
  mounts: readonly Mount[];
  network: NetworkProfile | null;
  hostAuthority: HostAuthority | null;
  grantId: string;
  grantVersion: number;
}>;

type CommandOutcome = Readonly<{
  requestId: string;
  proposalId: string;
  executor: 'vm' | 'host';
  executionLabel: string;
  state: 'completed' | 'failed' | 'denied' | 'timed_out' | 'cancelled';
  reason?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  processGroupId: number | null;
  stopped: boolean;
  uncertainChildren: readonly UncertainChild[];
  observedAt: string;
}>;

type CommandExecutionPort = Readonly<{
  propose(request: CommandRequest): Promise<CommandProposal>;
  dispatch(request: CommandRequest): Promise<CommandOutcome>;
  cancel(requestId: string): Promise<CommandOutcome>;
}>;

type CommandToolParameters = Readonly<{
  type: string;
  properties: Readonly<Record<string, Readonly<{ type?: string; enum?: readonly string[]; items?: Readonly<{ type?: string }> }>>>;
  required: readonly string[];
}>;

type CommandToolDescription = Readonly<{
  name: string;
  description: string;
  parameters: CommandToolParameters;
}>;

type CommandToolInput = Readonly<{
  callId: string;
  utterance: string;
  toolCall: Readonly<{ name: string; arguments: unknown }>;
}>;

type CommandContainment = Readonly<{
  mounts: readonly Mount[];
  network: NetworkProfile | null;
  hostAuthority: HostAuthority | null;
}>;

type CommandToolResult = Readonly<{
  callId: string;
  toolName: string;
  state: 'completed' | 'failed' | 'denied' | 'timed_out' | 'cancelled';
  reason?: string;
  requestId: string | null;
  proposalId: string | null;
  executionLabel: string | null;
  containment: CommandContainment | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stopped: boolean;
  uncertainChildren: readonly UncertainChild[];
  observedAt: string | null;
}>;

type CommandTool = Readonly<{
  describe(): CommandToolDescription;
  run(input: CommandToolInput): Promise<CommandToolResult>;
}>;

type CommandToolModule = Readonly<{
  createCommandTool(options: Readonly<{ execution: CommandExecutionPort; scope: Scope }>): CommandTool;
}>;

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): CommandToolModule {
  return {
    createCommandTool(): never {
      assert.fail(`${MISSING_BEHAVIOR} packages/desktop-tools/src/commands/index.ts must export `
        + 'createCommandTool({ execution, scope }) so a raw run_command tool call is validated as an '
        + 'argv array, bound to its scope, proposed with its mount, network profile, and host '
        + 'authority surfaced, dispatched through the isolated VM or the explicit host executor, and '
        + 'reported as the observed outcome. ' + detail);
    },
  };
}

async function loadCommandToolModule(): Promise<CommandToolModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createCommandTool !== 'function') {
    return missingModule('createCommandTool is not exported');
  }
  return loaded as unknown as CommandToolModule;
}

const commandToolModule = await loadCommandToolModule();

function createTool(execution: CommandExecutionPort, scope: Scope = SCOPE): CommandTool {
  return commandToolModule.createCommandTool({ execution, scope });
}

// ---------------------------------------------------------------------------------------------
// deterministic executor double

type ExecutionStep = Readonly<{ proposal: CommandProposal; outcome: CommandOutcome }>;

type ExecutionDouble = Readonly<{
  port: CommandExecutionPort;
  proposed: CommandRequest[];
  dispatched: CommandRequest[];
  cancelRequests: string[];
  queue(step: ExecutionStep): void;
  callCount(): number;
}>;

/** Stands in for the executor contract: it binds the canned plan to the request it receives, the
 * way the real executor builds its proposal from the request, and records every call. */
function createExecutionDouble(): ExecutionDouble {
  const steps: ExecutionStep[] = [];
  const proposed: CommandRequest[] = [];
  const dispatched: CommandRequest[] = [];
  const cancelRequests: string[] = [];
  let cursor = 0;
  return {
    proposed,
    dispatched,
    cancelRequests,
    queue(step) {
      steps.push(step);
    },
    callCount: () => proposed.length + dispatched.length + cancelRequests.length,
    port: {
      async propose(request) {
        proposed.push(request);
        const step = steps[cursor];
        assert.ok(step, 'the tool asked the executor for more proposals than this leg queued');
        return {
          ...step.proposal,
          requestId: request.requestId,
          executor: request.executor,
          argv: request.argv,
          workdir: request.workdir,
          grantId: request.grantId,
        };
      },
      async dispatch(request) {
        dispatched.push(request);
        const step = steps[cursor];
        assert.ok(step, 'the tool asked the executor for more dispatches than this leg queued');
        cursor += 1;
        return {
          ...step.outcome,
          requestId: request.requestId,
          proposalId: step.proposal.proposalId,
          executor: request.executor,
          executionLabel: step.proposal.executionLabel,
        };
      },
      async cancel(requestId) {
        cancelRequests.push(requestId);
        assert.fail(`the run_command tool has no cancel leg, so ${requestId} must not be cancelled here`);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// builders

type CallArguments = Record<string, unknown>;

function vmCall(argumentsValue: CallArguments = {}, callId = 'call-s04-vm'): CommandToolInput {
  return {
    callId,
    utterance: 'Run the command in the isolated VM',
    toolCall: {
      name: TOOL_NAME,
      arguments: {
        executor: 'vm',
        argv: [...VM_ARGV],
        workdir: fixture.workspace.guestRoot,
        networkAllow: [fixture.network.allowedHost],
        grantId: fixture.grants.vmGrantId,
        timeoutMs: TIMEOUT_MS,
        ...argumentsValue,
      },
    },
  };
}

function hostCall(argumentsValue: CallArguments = {}, callId = 'call-s04-host'): CommandToolInput {
  return {
    callId,
    utterance: 'Run the macOS-specific command on the host',
    toolCall: {
      name: TOOL_NAME,
      arguments: {
        executor: 'host',
        argv: [...HOST_ARGV],
        workdir: WORKSPACE_SOURCE,
        grantId: fixture.grants.hostGrantId,
        timeoutMs: TIMEOUT_MS,
        ...argumentsValue,
      },
    },
  };
}

function vmProposal(overrides: Partial<CommandProposal> = {}): CommandProposal {
  return {
    proposalId: 'prop-s04-vm',
    requestId: 'req-s04-vm',
    executor: 'vm',
    executionLabel: fixture.labels.vm,
    argv: [...VM_ARGV],
    workdir: fixture.workspace.guestRoot,
    mounts: [{ source: WORKSPACE_SOURCE, target: fixture.workspace.guestRoot, writable: true }],
    network: { mode: 'allowlist', hosts: [fixture.network.allowedHost] },
    hostAuthority: null,
    grantId: fixture.grants.vmGrantId,
    grantVersion: 1,
    ...overrides,
  };
}

function hostProposal(overrides: Partial<CommandProposal> = {}): CommandProposal {
  return {
    proposalId: 'prop-s04-host',
    requestId: 'req-s04-host',
    executor: 'host',
    executionLabel: fixture.labels.host,
    argv: [...HOST_ARGV],
    workdir: WORKSPACE_SOURCE,
    mounts: [],
    network: null,
    hostAuthority: {
      capability: fixture.capabilities.hostAutonomy,
      grantId: fixture.grants.hostGrantId,
      grantVersion: 1,
    },
    grantId: fixture.grants.hostGrantId,
    grantVersion: 1,
    ...overrides,
  };
}

function vmOutcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return {
    requestId: 'req-s04-vm',
    proposalId: 'prop-s04-vm',
    executor: 'vm',
    executionLabel: fixture.labels.vm,
    state: 'completed',
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    processGroupId: 5150,
    stopped: true,
    uncertainChildren: [],
    observedAt: NOW,
    ...overrides,
  };
}

function hostOutcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return {
    requestId: 'req-s04-host',
    proposalId: 'prop-s04-host',
    executor: 'host',
    executionLabel: fixture.labels.host,
    state: 'completed',
    exitCode: 0,
    stdout: '15.6.1\n',
    stderr: '',
    processGroupId: 8080,
    stopped: true,
    uncertainChildren: [],
    observedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// acceptance legs

test('the run_command tool describes an argv array, never a command string or a caller-chosen containment', () => {
  const double = createExecutionDouble();
  const tool = createTool(double.port);

  const description = tool.describe();
  assert.equal(description.name, TOOL_NAME);
  assert.equal(description.description.length > 0, true, 'the tool explains itself to the model');

  const parameters = description.parameters;
  assert.equal(parameters.type, 'object');
  for (const key of ['executor', 'argv', 'workdir', 'grantId']) {
    assert.equal(parameters.required.includes(key), true, `${key} is a required tool argument`);
  }
  assert.equal(parameters.properties.argv?.type, 'array', 'the tool takes an argv array');
  assert.equal(parameters.properties.argv?.items?.type, 'string', 'every argv element is a string');
  assert.equal(parameters.properties.command, undefined, 'a single shell-string command is not a representable call');
  assert.deepEqual([...(parameters.properties.executor?.enum ?? [])], ['vm', 'host']);
  for (const key of ['mounts', 'network', 'hostAuthority', 'scope']) {
    assert.equal(parameters.properties[key], undefined, `${key} is never a caller-chosen tool argument`);
  }
  assert.equal(double.callCount(), 0, 'describing the tool runs nothing');
});

test('a run_command tool call becomes one scoped request whose result carries the proposed containment', async () => {
  const double = createExecutionDouble();
  const tool = createTool(double.port);
  const proposal = vmProposal();
  double.queue({ proposal, outcome: vmOutcome() });
  double.queue({ proposal, outcome: vmOutcome() });

  const input = vmCall();
  const result = await tool.run(input);

  assert.equal(result.callId, input.callId);
  assert.equal(result.toolName, TOOL_NAME);
  assert.equal(result.state, 'completed');
  assert.equal(result.reason, undefined, 'a completed call carries no denial reason');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.stderr, '');
  assert.equal(result.stopped, true);
  assert.deepEqual([...result.uncertainChildren], []);
  assert.equal(result.observedAt, NOW, 'the observed time comes from the executor');
  assert.equal(result.proposalId, proposal.proposalId);

  assert.equal(double.proposed.length, 1, 'the tool asks for the inert proposal before running');
  assert.equal(double.dispatched.length, 1);
  const request = double.dispatched[0];
  assert.ok(request, 'the validated call was dispatched');
  assert.equal(result.requestId, request.requestId);
  assert.equal(request.executor, 'vm');
  assert.deepEqual([...request.argv], [...VM_ARGV], 'the argv array rides through verbatim');
  assert.equal(request.workdir, fixture.workspace.guestRoot);
  assert.deepEqual([...request.networkAllow], [fixture.network.allowedHost]);
  assert.equal(request.grantId, fixture.grants.vmGrantId);
  assert.equal(request.timeoutMs, TIMEOUT_MS);
  assert.deepEqual(request.scope, SCOPE, 'the call is bound to the tool scope, never one of its own');
  assert.equal(request.utterance, input.utterance, 'the invoking request text rides into the command request');
  assert.equal(request.requestId.includes(input.callId), true, 'the request id is derived from the call id');
  assert.equal(request.idempotencyKey.length > 0, true, 'a call carries an idempotency binding');

  assert.equal(result.executionLabel, fixture.labels.vm);
  assert.deepEqual(result.containment?.mounts, proposal.mounts, 'the proposed mount is surfaced');
  assert.deepEqual(result.containment?.network, proposal.network, 'the controlled network profile is surfaced');
  assert.equal(result.containment?.hostAuthority, null, 'a VM call claims no host authority');

  const replay = await tool.run(input);
  assert.deepEqual(double.dispatched[1], request, 'a replayed call yields the same request');
  assert.equal(replay.proposalId, result.proposalId, 'a replayed call yields the same proposal');
});

test('a malformed or caller-chosen tool call is denied and never reaches the executor', async (t) => {
  const double = createExecutionDouble();
  const tool = createTool(double.port);

  const cases: ReadonlyArray<Readonly<{ label: string; reason: string; call: CommandToolInput }>> = [
    {
      label: 'a shell command string instead of an argv array',
      reason: 'argv_required',
      call: vmCall({ argv: undefined, command: `touch ${fixture.workspace.probeFile}` }),
    },
    { label: 'an argv that is not an array', reason: 'argv_required', call: vmCall({ argv: '/usr/bin/touch probe.txt' }) },
    { label: 'an empty argv', reason: 'argv_required', call: vmCall({ argv: [] }) },
    { label: 'an argv element that is not a string', reason: 'argv_required', call: vmCall({ argv: ['/usr/bin/touch', 42] }) },
    {
      label: 'a caller-chosen mount',
      reason: 'invalid_tool_call',
      call: vmCall({ mounts: [{ source: '/', target: '/', writable: true }] }),
    },
    {
      label: 'a caller-chosen network profile',
      reason: 'invalid_tool_call',
      call: vmCall({ network: { mode: 'open', hosts: [] } }),
    },
    {
      label: 'a forged host authority',
      reason: 'invalid_tool_call',
      call: vmCall({ hostAuthority: { capability: fixture.capabilities.hostAutonomy, grantId: 'grant-forged', grantVersion: 9 } }),
    },
    {
      label: 'a caller-chosen scope',
      reason: 'invalid_tool_call',
      call: vmCall({ scope: { profileId: 'profile-forged', projectId: 'elsewhere', sensitivity: 'secret' } }),
    },
    { label: 'a caller-chosen request id', reason: 'invalid_tool_call', call: vmCall({ requestId: 'req-forged' }) },
    { label: 'an executor the tool does not have', reason: 'invalid_tool_call', call: vmCall({ executor: 'docker' }) },
    { label: 'an empty workdir', reason: 'invalid_tool_call', call: vmCall({ workdir: '' }) },
    { label: 'a non-positive timeout', reason: 'invalid_tool_call', call: vmCall({ timeoutMs: 0 }) },
    {
      label: 'a different tool name',
      reason: 'invalid_tool_call',
      call: { ...vmCall(), toolCall: { name: 'run_shell', arguments: { command: `touch ${fixture.workspace.probeFile}` } } },
    },
    {
      label: 'arguments that are not an object',
      reason: 'invalid_tool_call',
      call: { callId: 'call-s04-bad', utterance: 'Do something vague', toolCall: { name: TOOL_NAME, arguments: `touch ${fixture.workspace.probeFile}` } },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const result = await tool.run(entry.call);
      assert.equal(result.state, 'denied');
      assert.equal(result.reason, entry.reason);
      assert.equal(result.requestId, null, 'a rejected call never becomes a request');
      assert.equal(result.proposalId, null);
      assert.equal(result.executionLabel, null);
      assert.equal(result.containment, null);
      assert.equal(result.exitCode, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(result.observedAt, null, 'nothing was observed');
      assert.equal(result.stopped, true, 'nothing is running, so a rejected call reports nothing left alive');
    });
  }
  assert.equal(double.callCount(), 0, 'a rejected call starts nothing: the executor is never asked');
});

test('a macOS-specific host call is surfaced as host execution and a refusal is reported, never upgraded', async () => {
  const double = createExecutionDouble();
  const tool = createTool(double.port);
  const proposal = hostProposal();
  double.queue({ proposal, outcome: hostOutcome() });

  const result = await tool.run(hostCall());
  assert.equal(result.state, 'completed');
  assert.equal(result.executionLabel, fixture.labels.host, 'host execution is labeled');
  assert.equal(result.stdout, '15.6.1\n');
  assert.deepEqual([...result.uncertainChildren], []);
  assert.deepEqual([...(result.containment?.mounts ?? [])], [], 'host execution claims no containment');
  assert.equal(result.containment?.network, null, 'host execution claims no network isolation');
  assert.equal(result.containment?.hostAuthority?.capability, fixture.capabilities.hostAutonomy);
  assert.equal(result.containment?.hostAuthority?.grantId, fixture.grants.hostGrantId);
  assert.equal(result.containment?.hostAuthority?.grantVersion, proposal.hostAuthority?.grantVersion);

  const request = double.dispatched[0];
  assert.ok(request, 'the host call was dispatched');
  assert.equal(request.executor, 'host');
  assert.deepEqual([...request.argv], [...HOST_ARGV], 'the macOS-specific argv rides through verbatim');
  assert.deepEqual([...request.networkAllow], [], 'a host call has no network allowlist to widen');
  assert.equal(request.grantId, fixture.grants.hostGrantId);

  double.queue({
    proposal,
    outcome: hostOutcome({
      state: 'denied',
      reason: 'host_autonomy_required',
      exitCode: null,
      stdout: '',
      stderr: '',
      processGroupId: null,
    }),
  });
  const denied = await tool.run(hostCall({ grantId: fixture.grants.vmGrantId }, 'call-s04-host-denied'));
  assert.equal(denied.state, 'denied');
  assert.equal(denied.reason, 'host_autonomy_required');
  assert.equal(denied.exitCode, null, 'a denied host command reports no exit code');
  assert.equal(denied.stdout, '', 'a denied host command produces no output');
  assert.equal(denied.stopped, true);
  assert.equal(denied.executionLabel, fixture.labels.host);
  assert.equal(
    denied.containment?.hostAuthority?.capability,
    fixture.capabilities.hostAutonomy,
    'the authority that was refused is still surfaced',
  );
});

test('a denied shell script or a widened network request is reported as the executor observed it', async () => {
  const double = createExecutionDouble();
  const tool = createTool(double.port);

  double.queue({
    proposal: vmProposal(),
    outcome: vmOutcome({
      state: 'denied',
      reason: 'shell_script_requires_grant',
      exitCode: null,
      stdout: '',
      stderr: '',
      processGroupId: null,
    }),
  });
  const shell = await tool.run(vmCall({ argv: ['/bin/sh', '-c', 'echo hi'] }, 'call-s04-shell'));
  assert.equal(shell.state, 'denied', 'a shell script is a separate granted capability');
  assert.equal(shell.reason, 'shell_script_requires_grant');
  assert.equal(shell.exitCode, null);
  assert.equal(shell.stdout, '');
  assert.equal(shell.executionLabel, fixture.labels.vm);

  double.queue({
    proposal: vmProposal(),
    outcome: vmOutcome({
      state: 'denied',
      reason: 'network_not_granted',
      exitCode: null,
      stdout: '',
      stderr: '',
      processGroupId: null,
    }),
  });
  const widened = await tool.run(vmCall({ networkAllow: [fixture.network.deniedHost] }, 'call-s04-network'));
  assert.equal(widened.state, 'denied');
  assert.equal(widened.reason, 'network_not_granted');
  assert.equal(widened.exitCode, null);
  assert.equal(widened.stdout, '');
});

test('a timed-out or cancelled run is reported as observed, never claimed stopped', async () => {
  const double = createExecutionDouble();
  const tool = createTool(double.port);

  double.queue({
    proposal: vmProposal(),
    outcome: vmOutcome({
      state: 'timed_out',
      exitCode: null,
      stdout: '',
      stopped: false,
      uncertainChildren: [{ pid: 4242, evidence: 'guest process group 4242 is still alive after the stop' }],
    }),
  });
  const timedOut = await tool.run(vmCall({}, 'call-s04-timeout'));
  assert.equal(timedOut.state, 'timed_out');
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.stopped, false, 'a child that outlives the stop is never claimed stopped');
  assert.equal(timedOut.uncertainChildren.length, 1);
  assert.equal(timedOut.uncertainChildren[0]?.pid, 4242);
  assert.equal(
    (timedOut.uncertainChildren[0]?.evidence ?? '').length > 0,
    true,
    'every uncertain child carries evidence',
  );
  assert.equal(timedOut.observedAt, NOW);

  double.queue({
    proposal: hostProposal(),
    outcome: hostOutcome({
      state: 'cancelled',
      exitCode: null,
      stdout: '',
      stopped: false,
      uncertainChildren: [{ pid: 5150, evidence: 'escaped child 5150 survived the managed process group kill' }],
    }),
  });
  const cancelled = await tool.run(hostCall({}, 'call-s04-cancel'));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.stopped, false, 'an escaped child is reported, never claimed stopped');
  assert.equal(cancelled.uncertainChildren[0]?.pid, 5150);
  assert.equal(cancelled.executionLabel, fixture.labels.host);
});
