/**
 * S04 acceptance oracle — scoped command request → isolated or explicit host executor → observed
 * outcome (IMPLEMENTATION_PLAN.md §7.2 S04; §5.9 "Security, keys, permissions, and execution").
 *
 * `packages/security/src/execution/index.ts` must export (this file freezes these names; the tool
 * surface over the same seam is frozen in packages/desktop-tools/src/commands/s04.acceptance.test.ts):
 *
 *   createCommandExecution({ vm, grants, now }) → CommandExecution
 *
 *     vm — the managed Lima VM backend (§7.2 S04: "a managed Lima Linux VM with an explicit project
 *       mount and controlled network profile"). Lima is an optional component, so it is injected;
 *       `null`/omitted means no VM is installed and VM commands are refused, never downgraded.
 *         run(plan) → Promise<VmObservation>
 *           plan = { requestId, argv, workdir, mounts, network, timeoutMs }
 *             argv      the executable and its arguments, never a shell string
 *             workdir   the guest working directory (a guest path inside a mount target)
 *             mounts    the guest mount set: the only host directories that exist in the guest
 *             network   the controlled network profile (null = no network)
 *           Starts the command in the guest and resolves with the guest's observation:
 *           { state: 'completed'|'failed'|'timed_out'|'cancelled', exitCode, stdout, stderr,
 *             processGroupId, uncertainChildren: [{ pid, evidence }] }
 *         stop(requestId) → { stopped, uncertainChildren }
 *           Stops the managed process group inside the guest. `stopped: false` plus a non-empty
 *           uncertainChildren means the guest still has children the VM cannot prove stopped.
 *
 *     grants — the §5.9 permission tuple source, checked again immediately before execution:
 *       current(grantId) → null | { grantId, version, state: 'active'|'revoked', capability,
 *                                   destination, resource: { workspaceRoot, guestRoot },
 *                                   networkAllow: string[] }
 *
 *     now — deterministic clock; every timestamp comes from it (default () => new Date()).
 *
 *     CommandExecution:
 *       propose(request) → Promise<CommandProposal>
 *         Inert: nothing is started, no VM plan is sent. CommandRequest =
 *         { requestId, idempotencyKey, scope, utterance, executor: 'vm'|'host', argv, workdir,
 *           networkAllow, grantId, timeoutMs? }.
 *         Proposal = { proposalId, requestId, executor, executionLabel, argv, workdir, mounts,
 *                      network, hostAuthority, grantId, grantVersion }
 *           mounts         vm: exactly one writable mount { source: canonical granted workspace
 *                          root, target: guestRoot } — never the workspace's parent, the home
 *                          directory, or `/`; host: [] because host execution claims no containment
 *           network        vm: { mode: 'allowlist', hosts } with hosts ⊆ the grant's networkAllow,
 *                          never 'open'; host: null — host execution claims no network isolation
 *           hostAuthority  host: { capability: 'execution.host_autonomy', grantId, grantVersion };
 *                          vm: null
 *           executionLabel 'isolated-vm' for the VM executor, 'host-execution' for the host (§7.2 S04)
 *         A replayed request yields the same proposalId: it is derived from the request binding.
 *       dispatch(request) → Promise<CommandOutcome>
 *         Re-checks the active grant immediately before execution, then runs the argv without shell
 *         interpolation and resolves once the managed process group is gone (or proven not gone):
 *         { requestId, proposalId, executor, executionLabel,
 *           state: 'completed'|'failed'|'denied'|'timed_out'|'cancelled', reason?, exitCode,
 *           stdout, stderr, processGroupId, stopped, uncertainChildren, observedAt }
 *         Denials start nothing (exitCode null, empty stdout/stderr, processGroupId null):
 *           'grant_required'             unknown/inactive grant, or a capability+destination that
 *                                        do not authorize the requested executor
 *           'grant_revoked'              the grant was revoked after the proposal
 *           'host_autonomy_required'     host execution without the Host Autonomy capability
 *           'network_not_granted'        a requested endpoint outside the grant's networkAllow
 *           'shell_script_requires_grant' argv[0] is a shell (sh/bash/zsh/dash/ksh/csh/tcsh):
 *                                        shell scripts are a separate granted capability
 *           'vm_unavailable'             executor 'vm' while no VM backend is installed
 *       cancel(requestId) → Promise<CommandOutcome>
 *         Stops the managed process group of the in-flight request; the in-flight dispatch also
 *         resolves with that outcome (state 'cancelled'). Before stopping, the executor records the
 *         process tree under the managed group leader; after the group kill it re-checks every
 *         recorded pid. `stopped` is true only when nothing from this run is still running, and any
 *         survivor is reported in `uncertainChildren` with evidence — never claimed stopped.
 *
 * Deterministic rules pinned here (BACKLOG.json S04 acceptance criteria):
 *   1. A VM command changes the allowed test workspace; the same run cannot read the canary outside
 *      its mount and cannot reach the denied endpoint, and both refusals are observed (nonzero exit
 *      plus stderr) rather than reported as success. The mount set is exactly the canonical granted
 *      workspace, the network profile is never widened by a request, and an argument containing shell
 *      metacharacters stays one argv element.
 *   2. A macOS-specific command (`/usr/bin/sw_vers`) runs only with an active Host Autonomy grant,
 *      is labeled 'host-execution' with its host authority surfaced in the proposal, and is denied
 *      ('host_autonomy_required', nothing started) under any other grant.
 *   3. Timeout and cancel stop the managed process group: a same-group grandchild is gone too; a
 *      child that escaped the group is reported in uncertainChildren with `stopped: false`, and a
 *      guest child Lima cannot prove stopped is reported the same way instead of claimed stopped.
 *
 * Remaining limitation: the VM legs run against the documented deterministic guest double (Lima,
 * a real guest network namespace, and the signed native host helper need a machine where those
 * components are installed and a manual qualification pass), and the host legs exercise the real
 * process supervisor rather than a signed helper. Nothing here is claimed as hardware evidence.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';

const FIXTURE_URL = new URL('./fixtures/s04-execution.json', import.meta.url);
const MISSING_BEHAVIOR = 'Missing required behavior:';

type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string; displayName: string }>;
  workspace: Readonly<{
    allowedDirectory: string;
    outsideDirectory: string;
    canaryRelativePath: string;
    canaryContent: string;
    guestRoot: string;
    probeFile: string;
    injectedFile: string;
  }>;
  grants: Readonly<{ vmGrantId: string; hostGrantId: string; revokedGrantId: string }>;
  capabilities: Readonly<{ vm: string; hostAutonomy: string; shellScript: string }>;
  destinations: Readonly<{ vm: string; host: string }>;
  network: Readonly<{ allowedHost: string; deniedHost: string }>;
  labels: Readonly<{ vm: string; host: string }>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
const SCOPE: Scope = {
  profileId: fixture.profileId,
  projectId: fixture.project.projectId,
  sensitivity: 'normal',
};
const GUEST_ROOT = fixture.workspace.guestRoot;
const NOW = '2026-09-21T09:00:00.000Z';

type GrantSnapshot = Readonly<{
  grantId: string;
  version: number;
  state: 'active' | 'revoked';
  capability: string;
  destination: string;
  resource: Readonly<Record<string, string>>;
  networkAllow: readonly string[];
}>;

type GrantSource = Readonly<{ current(grantId: string): Promise<GrantSnapshot | null> }>;

type Mount = Readonly<{ source: string; target: string; writable: boolean }>;
type NetworkProfile = Readonly<{ mode: 'deny' | 'allowlist'; hosts: readonly string[] }>;
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
  hostAuthority: null | Readonly<{ capability: string; grantId: string; grantVersion: number }>;
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

type VmRunPlan = Readonly<{
  requestId: string;
  argv: readonly string[];
  workdir: string;
  mounts: readonly Mount[];
  network: NetworkProfile | null;
  timeoutMs: number;
}>;

type VmObservation = Readonly<{
  state: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  processGroupId: number | null;
  uncertainChildren: readonly UncertainChild[];
}>;

type VmStopReport = Readonly<{ stopped: boolean; uncertainChildren: readonly UncertainChild[] }>;
type VmPort = Readonly<{ run(plan: VmRunPlan): Promise<VmObservation>; stop(requestId: string): Promise<VmStopReport> }>;

type CommandExecution = Readonly<{
  propose(request: CommandRequest): Promise<CommandProposal>;
  dispatch(request: CommandRequest): Promise<CommandOutcome>;
  cancel(requestId: string): Promise<CommandOutcome>;
}>;

type CommandExecutionModule = Readonly<{
  createCommandExecution(options: Readonly<{ vm?: VmPort | null; grants: GrantSource; now?: () => Date }>): CommandExecution;
}>;

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): CommandExecutionModule {
  return {
    createCommandExecution(): never {
      assert.fail(`${MISSING_BEHAVIOR} packages/security/src/execution/index.ts must export `
        + 'createCommandExecution({ vm, grants, now }) so a scoped command request becomes a proposal '
        + 'that surfaces its mount, network profile, and host authority and then runs through the '
        + 'isolated VM or the explicit host executor with an observed outcome. ' + detail);
    },
  };
}

async function loadExecutionModule(): Promise<CommandExecutionModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createCommandExecution !== 'function') {
    return missingModule('createCommandExecution is not exported');
  }
  return loaded as unknown as CommandExecutionModule;
}

const executionModule = await loadExecutionModule();

// ---------------------------------------------------------------------------------------------
// deterministic doubles

type GrantRegistry = Readonly<{
  source: GrantSource;
  add(input: Readonly<{
    grantId: string;
    capability: string;
    destination: string;
    resource: Readonly<Record<string, string>>;
    networkAllow?: readonly string[];
  }>): GrantSnapshot;
  revoke(grantId: string): void;
}>;

function createGrantRegistry(): GrantRegistry {
  const entries = new Map<string, GrantSnapshot>();
  return {
    source: { current: async (grantId) => entries.get(grantId) ?? null },
    add(input) {
      const snapshot: GrantSnapshot = {
        grantId: input.grantId,
        version: 1,
        state: 'active',
        capability: input.capability,
        destination: input.destination,
        resource: input.resource,
        networkAllow: input.networkAllow ?? [],
      };
      entries.set(snapshot.grantId, snapshot);
      return snapshot;
    },
    revoke(grantId) {
      const existing = entries.get(grantId);
      if (existing) entries.set(grantId, { ...existing, state: 'revoked', version: existing.version + 1 });
    },
  };
}

/** The guest binaries the deterministic Lima guest can resolve; anything else is "command not found". */
const GUEST_EXECUTABLES: Readonly<Record<string, string>> = {
  '/bin/cat': '/bin/cat',
  '/bin/echo': '/bin/echo',
  '/bin/sh': '/bin/sh',
  '/usr/bin/curl': '/usr/bin/curl',
  '/usr/bin/touch': '/usr/bin/touch',
};

/** Guest path → host path through the declared mount set; null when the guest cannot see it. */
function guestToHost(mounts: readonly Mount[], guestPath: string): string | null {
  const normalized = posix.normalize(guestPath);
  for (const mount of mounts) {
    const target = posix.normalize(mount.target);
    if (normalized !== target && !normalized.startsWith(`${target}/`)) continue;
    const suffix = normalized.slice(target.length).replace(/^\/+/, '');
    return suffix.length > 0 ? join(mount.source, suffix) : mount.source;
  }
  return null;
}

type FakeVm = VmPort & Readonly<{
  plans: VmRunPlan[];
  stops: string[];
  scriptNext(observation: VmObservation): void;
}>;

/** A deterministic Lima guest whose filesystem is exactly the declared mounts and whose network is
 * exactly the declared profile: paths outside the mounts do not exist in the guest, and hosts
 * outside the allowlist refuse the connection. The guest runs simple argv shapes for real against
 * the mapped host paths, so a workspace change is a real file and an echo of a metacharacter is a
 * real literal argument. */
function createFakeVm(): FakeVm {
  const plans: VmRunPlan[] = [];
  const stops: string[] = [];
  const scripted: VmObservation[] = [];
  return {
    plans,
    stops,
    scriptNext(observation) {
      scripted.push(observation);
    },
    async run(plan) {
      plans.push(plan);
      const next = scripted.shift();
      if (next) return next;
      const workdir = guestToHost(plan.mounts, plan.workdir);
      if (workdir === null) return guestFailure(2, `${plan.workdir}: No such file or directory`);
      const executable = GUEST_EXECUTABLES[plan.argv[0] ?? ''];
      if (executable === undefined) return guestFailure(127, `${plan.argv[0] ?? ''}: command not found`);
      if (plan.argv[0] === '/usr/bin/curl') {
        const url = plan.argv[1] ?? '';
        const host = url.replace(/^https?:\/\//, '').split('/')[0]?.split(':')[0] ?? '';
        const allowed = plan.network !== null && plan.network.hosts.includes(host);
        if (!allowed) {
          return guestFailure(7, `curl: (7) Failed to connect to ${host} port 80: Connection refused`);
        }
        return {
          state: 'completed', exitCode: 0, stdout: '{"ok":true}\n', stderr: '',
          processGroupId: null, uncertainChildren: [],
        };
      }
      const mapped: string[] = [executable];
      for (const element of plan.argv.slice(1)) {
        if (!element.startsWith('/')) {
          mapped.push(element);
          continue;
        }
        const host = guestToHost(plan.mounts, element);
        if (host === null) return guestFailure(1, `${basename(executable)}: ${element}: No such file or directory`);
        mapped.push(host);
      }
      return await runGuestProcess(mapped, workdir, plan.timeoutMs);
    },
    async stop(requestId) {
      stops.push(requestId);
      return { stopped: true, uncertainChildren: [] };
    },
  };
}

function guestFailure(exitCode: number, message: string): VmObservation {
  return {
    state: 'failed', exitCode, stdout: '', stderr: `${message}\n`,
    processGroupId: null, uncertainChildren: [],
  };
}

async function runGuestProcess(argv: readonly string[], cwd: string, timeoutMs: number): Promise<VmObservation> {
  const executable = argv[0];
  assert.ok(executable, 'the guest resolves an executable before running');
  const child = spawn(executable, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const result = await new Promise<Readonly<{ code: number | null; timedOut: boolean }>>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
  const state = result.timedOut ? 'timed_out' : result.code === 0 ? 'completed' : 'failed';
  return { state, exitCode: result.code, stdout, stderr, processGroupId: null, uncertainChildren: [] };
}

function lastPlan(vm: FakeVm): VmRunPlan {
  const plan = vm.plans[vm.plans.length - 1];
  assert.ok(plan, 'the VM backend must have received a run plan');
  return plan;
}

// ---------------------------------------------------------------------------------------------
// scenario scaffolding

type Scenario = Readonly<{
  root: string;
  allowedRoot: string;
  allowedReal: string;
  canaryPath: string;
  canaryReal: string;
  rootReal: string;
  cleanup(): Promise<void>;
}>;

async function createScenario(): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), 's04-execution-'));
  const allowedRoot = join(root, fixture.workspace.allowedDirectory);
  const outsideRoot = join(root, fixture.workspace.outsideDirectory);
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(allowedRoot, 'README.txt'), 'allowed workspace\n', 'utf8');
  const canaryPath = join(root, fixture.workspace.canaryRelativePath);
  await writeFile(canaryPath, fixture.workspace.canaryContent, 'utf8');
  return {
    root,
    allowedRoot,
    allowedReal: await realpath(allowedRoot),
    canaryPath,
    canaryReal: await realpath(canaryPath),
    rootReal: await realpath(root),
    cleanup: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent.endsWith('/') ? parent : `${parent}/`}`);
}

function fixedClock(iso: string): Readonly<{ now: () => Date }> {
  return { now: () => new Date(iso) };
}

function vmRequest(grantId: string, overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    requestId: 'req-s04-vm',
    idempotencyKey: 'idem-s04-vm',
    scope: SCOPE,
    utterance: 'Run the command in the isolated VM',
    executor: 'vm',
    argv: ['/usr/bin/touch', fixture.workspace.probeFile],
    workdir: GUEST_ROOT,
    networkAllow: [fixture.network.allowedHost],
    grantId,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function hostRequest(grantId: string, argv: readonly string[], workdir: string, overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    requestId: 'req-s04-host',
    idempotencyKey: 'idem-s04-host',
    scope: SCOPE,
    utterance: 'Run the macOS-specific command on the host',
    executor: 'host',
    argv,
    workdir,
    networkAllow: [],
    grantId,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function vmExecution(vm: VmPort | null, grants: GrantRegistry, now = fixedClock(NOW).now): CommandExecution {
  return executionModule.createCommandExecution({ vm, grants: grants.source, now });
}

// ---------------------------------------------------------------------------------------------
// acceptance legs

test('a scoped VM proposal surfaces exactly the granted mount, the controlled network profile, and the isolated-vm label', async () => {
  const scenario = await createScenario();
  try {
    const vm = createFakeVm();
    const registry = createGrantRegistry();
    const grant = registry.add({
      grantId: fixture.grants.vmGrantId,
      capability: fixture.capabilities.vm,
      destination: fixture.destinations.vm,
      resource: { workspaceRoot: scenario.allowedRoot, guestRoot: GUEST_ROOT },
      networkAllow: [fixture.network.allowedHost],
    });
    const execution = vmExecution(vm, registry);
    const request = vmRequest(grant.grantId, { argv: ['/usr/bin/touch', `${fixture.workspace.probeFile}; rm -rf /`] });

    const proposal = await execution.propose(request);
    assert.equal(vm.plans.length, 0, 'proposing is inert: no VM run before dispatch');
    assert.equal(proposal.executor, 'vm');
    assert.equal(proposal.executionLabel, fixture.labels.vm);
    assert.deepEqual([...proposal.argv], [...request.argv], 'the argv array is carried through verbatim');
    assert.equal(proposal.workdir, GUEST_ROOT);

    assert.equal(proposal.mounts.length, 1, 'the VM gets exactly one mount: the granted workspace');
    const mount = proposal.mounts[0];
    assert.ok(mount, 'the granted mount is surfaced in the proposal');
    assert.equal(mount.target, GUEST_ROOT);
    assert.equal(mount.writable, true);
    assert.equal(mount.source, scenario.allowedReal, 'the mount is the canonical granted workspace root');
    assert.equal(isInside(mount.source, scenario.canaryReal), false, 'the canary outside the mount is not in the VM view');
    assert.equal(isInside(mount.source, scenario.rootReal), false, 'the workspace parent is never mounted');

    assert.ok(proposal.network, 'the VM proposal carries a controlled network profile');
    assert.equal(proposal.network.mode, 'allowlist', 'the network profile is never open');
    assert.deepEqual([...proposal.network.hosts], [fixture.network.allowedHost]);
    assert.equal(proposal.hostAuthority, null, 'a VM command claims no host authority');

    const repeat = await execution.propose(request);
    assert.equal(repeat.proposalId, proposal.proposalId, 'a replayed request yields the same proposal');

    // §5.9: the grant version is re-checked immediately before execution.
    registry.revoke(grant.grantId);
    const denied = await execution.dispatch(request);
    assert.equal(denied.state, 'denied');
    assert.equal(denied.reason, 'grant_revoked');
    assert.equal(vm.plans.length, 0, 'a revoked grant never reaches the VM');
    assert.equal(denied.exitCode, null);
    assert.equal(denied.processGroupId, null);

    // Lima is an optional component: without a VM backend nothing runs and nothing is faked.
    const withoutVm = vmExecution(null, registry);
    const unavailable = await withoutVm.dispatch(vmRequest('grant-s04-no-vm'));
    assert.equal(unavailable.state, 'denied');
    assert.equal(unavailable.reason, 'vm_unavailable');
    assert.equal(unavailable.executionLabel, fixture.labels.vm);
  } finally {
    await scenario.cleanup();
  }
});

test('a VM command changes the mounted workspace and cannot read the canary outside the mount or reach the denied endpoint', async () => {
  const scenario = await createScenario();
  try {
    const vm = createFakeVm();
    const registry = createGrantRegistry();
    const grant = registry.add({
      grantId: fixture.grants.vmGrantId,
      capability: fixture.capabilities.vm,
      destination: fixture.destinations.vm,
      resource: { workspaceRoot: scenario.allowedRoot, guestRoot: GUEST_ROOT },
      networkAllow: [fixture.network.allowedHost],
    });
    const execution = vmExecution(vm, registry);
    const base = vmRequest(grant.grantId);

    const touched = await execution.dispatch({ ...base, requestId: 'req-s04-vm-touch' });
    assert.equal(touched.state, 'completed');
    assert.equal(touched.exitCode, 0);
    assert.equal(touched.executionLabel, fixture.labels.vm);
    assert.equal(touched.stopped, true);
    assert.equal(touched.observedAt, NOW);
    assert.equal(existsSync(join(scenario.allowedRoot, fixture.workspace.probeFile)), true,
      'the VM command changes the allowed test workspace');
    const touchPlan = lastPlan(vm);
    assert.deepEqual([...touchPlan.argv], [...base.argv]);
    assert.equal(touchPlan.mounts.length, 1);
    assert.equal(touchPlan.mounts[0]?.source, scenario.allowedReal);
    assert.ok(touchPlan.network);
    assert.equal(touchPlan.network.mode, 'allowlist');
    assert.deepEqual([...touchPlan.network.hosts], [fixture.network.allowedHost]);

    // No shell interpolation: one argv element stays one literal argument.
    const echoed = await execution.dispatch({
      ...base,
      requestId: 'req-s04-vm-echo',
      argv: ['/bin/echo', `probe; touch ${fixture.workspace.injectedFile}`],
    });
    assert.equal(echoed.state, 'completed');
    assert.equal(echoed.stdout, `probe; touch ${fixture.workspace.injectedFile}\n`);
    assert.equal(existsSync(join(scenario.allowedRoot, fixture.workspace.injectedFile)), false,
      'a metacharacter argument is never re-parsed by a shell');
    assert.deepEqual([...lastPlan(vm).argv], ['/bin/echo', `probe; touch ${fixture.workspace.injectedFile}`]);

    const canary = await execution.dispatch({
      ...base,
      requestId: 'req-s04-vm-canary',
      argv: ['/bin/cat', scenario.canaryPath],
    });
    assert.equal(canary.state, 'failed', 'the canary outside the mount is not readable');
    assert.notEqual(canary.exitCode, 0);
    assert.equal(canary.stdout, '');
    assert.match(canary.stderr, /No such file or directory/);
    assert.equal(
      `${canary.stdout}${canary.stderr}`.includes(fixture.workspace.canaryContent),
      false,
      'the canary content never appears in the observed outcome',
    );
    assert.equal(await readFile(scenario.canaryPath, 'utf8'), fixture.workspace.canaryContent,
      'the canary outside the mount is untouched');

    const deniedCurl = await execution.dispatch({
      ...base,
      requestId: 'req-s04-vm-curl-denied',
      argv: ['/usr/bin/curl', `http://${fixture.network.deniedHost}/beacon`],
    });
    assert.equal(deniedCurl.state, 'failed', 'the denied endpoint is unreachable');
    assert.equal(deniedCurl.exitCode, 7);
    assert.match(deniedCurl.stderr, /Failed to connect/);
    assert.equal(deniedCurl.stderr.includes(fixture.network.deniedHost), true, 'the refusal names the endpoint');

    const allowedCurl = await execution.dispatch({
      ...base,
      requestId: 'req-s04-vm-curl-allowed',
      argv: ['/usr/bin/curl', `http://${fixture.network.allowedHost}/index.json`],
    });
    assert.equal(allowedCurl.state, 'completed', 'the allowlisted endpoint stays reachable');
    assert.equal(allowedCurl.exitCode, 0);

    const before = vm.plans.length;
    const widened = await execution.dispatch({
      ...base,
      requestId: 'req-s04-vm-curl-widen',
      argv: ['/usr/bin/curl', `http://${fixture.network.deniedHost}/beacon`],
      networkAllow: [fixture.network.deniedHost],
    });
    assert.equal(widened.state, 'denied', 'a request can never widen the granted network profile');
    assert.equal(widened.reason, 'network_not_granted');
    assert.equal(vm.plans.length, before, 'the denied request never reaches the VM');

    const shell = await execution.dispatch({
      ...base,
      requestId: 'req-s04-vm-shell',
      argv: ['/bin/sh', '-c', 'echo hi'],
    });
    assert.equal(shell.state, 'denied', 'a shell script is a separate granted capability');
    assert.equal(shell.reason, 'shell_script_requires_grant');
    assert.equal(vm.plans.length, before, 'a shell script never reaches the VM without its own grant');
  } finally {
    await scenario.cleanup();
  }
});

test('a macOS-specific command runs only with a Host Autonomy grant and is labeled as host execution', async () => {
  const scenario = await createScenario();
  try {
    const registry = createGrantRegistry();
    const hostGrant = registry.add({
      grantId: fixture.grants.hostGrantId,
      capability: fixture.capabilities.hostAutonomy,
      destination: fixture.destinations.host,
      resource: {},
    });
    registry.add({
      grantId: fixture.grants.vmGrantId,
      capability: fixture.capabilities.vm,
      destination: fixture.destinations.vm,
      resource: { workspaceRoot: scenario.allowedRoot, guestRoot: GUEST_ROOT },
      networkAllow: [fixture.network.allowedHost],
    });
    const execution = vmExecution(createFakeVm(), registry);
    const version = ['/usr/bin/sw_vers', '-productVersion'];
    assert.equal(existsSync(version[0] ?? ''), true, 'this oracle targets macOS, where /usr/bin/sw_vers exists');
    const request = hostRequest(hostGrant.grantId, version, scenario.allowedRoot);

    const proposal = await execution.propose(request);
    assert.equal(proposal.executor, 'host');
    assert.equal(proposal.executionLabel, fixture.labels.host);
    assert.deepEqual([...proposal.argv], [...version]);
    assert.deepEqual([...proposal.mounts], [], 'host execution claims no containment');
    assert.equal(proposal.network, null, 'host execution claims no network isolation');
    assert.ok(proposal.hostAuthority, 'the host authority is surfaced in the proposal');
    assert.equal(proposal.hostAuthority.capability, fixture.capabilities.hostAutonomy);
    assert.equal(proposal.hostAuthority.grantId, hostGrant.grantId);
    assert.equal(proposal.hostAuthority.grantVersion, hostGrant.version);

    const outcome = await execution.dispatch(request);
    assert.equal(outcome.state, 'completed');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.executionLabel, fixture.labels.host);
    assert.equal(outcome.stopped, true);
    assert.match(outcome.stdout, /^\d+\.\d+/);

    const marker = join(scenario.root, 'host-denied-marker.txt');
    const markerCommand = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
    const denied = await execution.dispatch(hostRequest(fixture.grants.vmGrantId, markerCommand, scenario.root, {
      requestId: 'req-s04-host-denied',
      timeoutMs: 5_000,
    }));
    assert.equal(denied.state, 'denied', 'a VM grant is not Host Autonomy');
    assert.equal(denied.reason, 'host_autonomy_required');
    assert.equal(denied.executionLabel, fixture.labels.host);
    assert.equal(denied.exitCode, null);
    assert.equal(denied.processGroupId, null);
    assert.equal(existsSync(marker), false, 'a denied host command never starts');

    const unknown = await execution.dispatch(hostRequest('grant-s04-unknown', markerCommand, scenario.root, {
      requestId: 'req-s04-host-unknown',
      timeoutMs: 5_000,
    }));
    assert.equal(unknown.state, 'denied');
    assert.equal(unknown.reason, 'grant_required');
    assert.equal(existsSync(marker), false);
  } finally {
    await scenario.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// managed process group

type ManagedScript = Readonly<{ scriptPath: string; readyPath: string }>;

/** A real command that forks a child in its own process group and keeps running.
 *
 * The escaped child inherits the managed stdio the way a real daemon would, but it leaves the
 * managed process group, so a group kill cannot reach it. An executor that only tracks the group
 * leader therefore cannot honestly report the stop as complete: it has to enumerate the
 * descendants it is responsible for (darwin libproc, since restricted runtimes deny ps/pgrep),
 * stop the group, and report every enumerated child that is still alive as uncertain. */
async function writeManagedScript(scenario: Scenario, name: string, escaped: boolean): Promise<ManagedScript> {
  const scriptPath = join(scenario.root, name);
  const readyPath = join(scenario.root, `${name}.ready.json`);
  const childOptions = escaped ? '{ detached: true }' : "{ stdio: 'ignore' }";
  const source = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], ${childOptions});`,
    escaped ? 'child.unref();' : '',
    `writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parent: process.pid, ${escaped ? 'escaped' : 'child'}: child.pid }));`,
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
  await writeFile(scriptPath, source, 'utf8');
  return { scriptPath, readyPath };
}

type ManagedPids = Readonly<{ parent: number; child?: number; escaped?: number }>;

async function waitForReady(path: string, label: string, timeoutMs = 20_000): Promise<ManagedPids> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8')) as ManagedPids;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`the host command never reported itself through ${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid)) {
    if (Date.now() > deadline) assert.fail(`${label} ${pid} is still running after the stop`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a timeout stops the managed process group, including a same-group child', async () => {
  const scenario = await createScenario();
  try {
    const registry = createGrantRegistry();
    const grant = registry.add({
      grantId: fixture.grants.hostGrantId,
      capability: fixture.capabilities.hostAutonomy,
      destination: fixture.destinations.host,
      resource: {},
    });
    const execution = vmExecution(null, registry);
    const managed = await writeManagedScript(scenario, 'timeout-child.cjs', false);
    const request = hostRequest(grant.grantId, [process.execPath, managed.scriptPath], scenario.root, {
      requestId: 'req-s04-host-timeout',
      timeoutMs: 1_500,
    });

    const pending = execution.dispatch(request);
    const pids = await waitForReady(managed.readyPath, 'the timeout script');
    const outcome = await pending;

    assert.equal(outcome.state, 'timed_out');
    assert.equal(outcome.executionLabel, fixture.labels.host);
    assert.equal(typeof outcome.processGroupId, 'number', 'the managed process group is reported');
    assert.equal(outcome.stopped, true, 'a timed-out command reports the group stopped');
    assert.deepEqual([...outcome.uncertainChildren], []);
    await assertGone(pids.parent, 'the timed-out command');
    const timedOutChild = pids.child ?? 0;
    assert.ok(timedOutChild > 0, 'the timeout script reports its same-group child');
    await assertGone(timedOutChild, 'the same-group child');
  } finally {
    await scenario.cleanup();
  }
});

test('a cancel stops the managed process group and an escaped child is reported, never claimed stopped', async () => {
  const scenario = await createScenario();
  const survivors: number[] = [];
  try {
    const registry = createGrantRegistry();
    const grant = registry.add({
      grantId: fixture.grants.hostGrantId,
      capability: fixture.capabilities.hostAutonomy,
      destination: fixture.destinations.host,
      resource: {},
    });
    const execution = vmExecution(null, registry);

    const clean = await writeManagedScript(scenario, 'cancel-child.cjs', false);
    const cleanRequest = hostRequest(grant.grantId, [process.execPath, clean.scriptPath], scenario.root, {
      requestId: 'req-s04-host-cancel',
      timeoutMs: 30_000,
    });
    const cleanPending = execution.dispatch(cleanRequest);
    const cleanPids = await waitForReady(clean.readyPath, 'the cancel script');
    const cleanOutcome = await execution.cancel(cleanRequest.requestId);
    const cleanReported = await cleanPending;
    assert.equal(cleanOutcome.state, 'cancelled');
    assert.equal(cleanReported.state, 'cancelled', 'the in-flight dispatch reports the cancel');
    assert.equal(cleanOutcome.stopped, true);
    assert.deepEqual([...cleanOutcome.uncertainChildren], []);
    await assertGone(cleanPids.parent, 'the cancelled command');
    const cancelledChild = cleanPids.child ?? 0;
    assert.ok(cancelledChild > 0, 'the cancel script reports its same-group child');
    await assertGone(cancelledChild, 'the same-group child');

    const escaped = await writeManagedScript(scenario, 'escaped-child.cjs', true);
    const escapedRequest = hostRequest(grant.grantId, [process.execPath, escaped.scriptPath], scenario.root, {
      requestId: 'req-s04-host-escaped',
      timeoutMs: 30_000,
    });
    const escapedPending = execution.dispatch(escapedRequest);
    const escapedPids = await waitForReady(escaped.readyPath, 'the escaped-child script');
    const escapedPid = escapedPids.escaped ?? 0;
    assert.ok(escapedPid > 0, 'the escaped-child script reports the escaped pid');
    survivors.push(escapedPid);
    assert.equal(isAlive(escapedPid), true, 'the escaped child runs before the cancel');
    const escapedOutcome = await execution.cancel(escapedRequest.requestId);
    await escapedPending;

    assert.equal(escapedOutcome.state, 'cancelled');
    assert.equal(escapedOutcome.stopped, false, 'a child outside the group is never claimed stopped');
    assert.equal(
      escapedOutcome.uncertainChildren.some((entry) => entry.pid === escapedPid),
      true,
      'the child that outlived the group is reported by pid, never hidden behind a clean stop',
    );
    assert.equal(
      escapedOutcome.uncertainChildren.every((entry) => entry.evidence.length > 0),
      true,
      'every uncertain child carries evidence',
    );
    await assertGone(escapedPids.parent, 'the cancelled command');
  } finally {
    for (const pid of survivors) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The escaped child is already gone; nothing to clean up.
      }
    }
    await scenario.cleanup();
  }
});

test('a VM command whose guest children outlive the stop is reported, not claimed stopped', async () => {
  const scenario = await createScenario();
  try {
    const vm = createFakeVm();
    const registry = createGrantRegistry();
    const grant = registry.add({
      grantId: fixture.grants.vmGrantId,
      capability: fixture.capabilities.vm,
      destination: fixture.destinations.vm,
      resource: { workspaceRoot: scenario.allowedRoot, guestRoot: GUEST_ROOT },
      networkAllow: [fixture.network.allowedHost],
    });
    const execution = vmExecution(vm, registry);
    vm.scriptNext({
      state: 'timed_out',
      exitCode: null,
      stdout: '',
      stderr: '',
      processGroupId: 4242,
      uncertainChildren: [{ pid: 4242, evidence: 'guest process group 4242 still alive after stop' }],
    });

    const outcome = await execution.dispatch(vmRequest(grant.grantId, {
      requestId: 'req-s04-vm-stall',
      argv: ['/usr/bin/touch', fixture.workspace.probeFile],
      timeoutMs: 500,
    }));
    assert.equal(outcome.state, 'timed_out');
    assert.equal(outcome.executionLabel, fixture.labels.vm);
    assert.equal(outcome.stopped, false, 'a guest child that outlives the stop is never claimed stopped');
    assert.equal(outcome.uncertainChildren.length, 1);
    assert.equal(outcome.uncertainChildren[0]?.pid, 4242);
    assert.ok((outcome.uncertainChildren[0]?.evidence ?? '').length > 0);
  } finally {
    await scenario.cleanup();
  }
});
