/**
 * C02 acceptance oracle — voice action → proposal → grant → AX execution → verified result
 * (IMPLEMENTATION_PLAN.md §7.2 C02; §5.9 action lifecycle and execution security).
 *
 * `packages/desktop-tools/src/actions/index.ts` must export (this file freezes these names):
 *
 *   createDesktopActionService({ ax, now, scope }) → DesktopActionService
 *
 *     ax — the C02 native boundary (§5.4 "read/navigate/click/type/select/scroll through AX"):
 *       inspect(targetRef) → Promise<DesktopAxControl | null>
 *         Current state of one control, or null when it no longer exists. `fingerprint` is the
 *         target fingerprint the resolver captured; it covers the control's app, window, role,
 *         and label identity, so a replaced control or window never passes a stale fingerprint.
 *       setValue({ targetRef, value }) → Promise<void>
 *         One AX write. It resolves when the AX call returns, which is not proof the application
 *         applied it — that is what the post-action read-back is for.
 *
 *     now — deterministic clock; every timestamp and expiry the service writes comes from it.
 *     scope — the explicit project association, e.g.
 *       { profileId: 'profile-c02', projectId: 'atlas', sensitivity: 'normal' }.
 *
 *     service:
 *       propose({ actionId, idempotencyKey, utterance, effect, steps }) → Promise<Proposal>
 *         The voice request becomes a proposal, never an execution. Proposal =
 *         { proposalId, actionId, state: 'proposed', argumentHash, scope }. The argument hash
 *         binds the ordered steps (operation, target ref, target fingerprint, value).
 *       authorize({ proposalId, utterance }) → Promise<Authorization>
 *         The voice grant. Authorization = { authorizationId, proposalId, authorized,
 *         argumentHash, expiresAt }. It binds the proposal's argument hash and expires at most
 *         30 s after the grant (§5.9 confirmation expiry). No grant, no execution.
 *       advance({ proposalId }) → Promise<Outcome>
 *         Preflights and runs exactly the next pending step: guard checks, the AX write, then the
 *         read-back verification. One step per call is what makes cancelling between steps
 *         decidable. A stopped step stays unexecuted, so an advance after a fresh grant can
 *         preflight it again.
 *       cancel({ proposalId }) → Promise<Outcome>
 *         Cancels the remaining steps between steps; a cancelled action never resumes.
 *
 *     Proposal steps = { stepId, operation: 'set_value', targetRef, targetFingerprint, value }.
 *
 *     Outcome = {
 *       actionId, proposalId,
 *       status: 'in_progress' | 'completed' | 'denied' | 'failed' | 'cancelled',
 *       reason?: 'not_authorized' | 'grant_expired' | 'focus_changed' | 'target_identity_changed'
 *              | 'target_disabled' | 'verification_failed' | 'cancelled_by_user',
 *       steps: [{ stepId, status: 'completed' | 'unexecuted' | 'failed',
 *                 before: string | null, after: string | null, evidenceIds: string[] }],
 *       evidenceIds: string[],   // union of the step evidence, in step order
 *     }
 *     Evidence ids are derived, not invented: the preflight read is 'act:before:<stepId>' and the
 *     verified read-back is 'act:after:<stepId>'. A stopped step has no before/after evidence.
 *
 * Deterministic rules pinned here (BACKLOG.json C02 acceptance criteria):
 *   1. A voice request turns into a proposal, the proposal executes only after the voice grant,
 *      and the granted step changes the intended field: the read-back equals the requested value,
 *      the rest of the window keeps its values, and the receipt carries the before/after evidence
 *      and a completed action status. An unauthorized advance executes nothing.
 *   2. Changed focus (the step's target is no longer the focused control), a changed target
 *      fingerprint, a disabled control, or an authorization past its expiry stops execution: no AX
 *      write happens, the receipt names the guard, the step is reported unexecuted, and the target
 *      keeps its value. The guard is rechecked for every step, not once per action.
 *   3. Cancelling between steps stops the remaining steps: the receipt reports the completed and
 *      the unexecuted step ids, the unexecuted step never writes, and the action never resumes.
 *   4. A write the application does not apply is not a verified result: the read-back disagrees,
 *      the step is reported failed with verification_failed, and the receipt never claims
 *      completed.
 *
 * Remaining limitation: this oracle pins the TypeScript seam with deterministic doubles. Real AX
 * traversal of TextEdit and the fixture application, the signed native helper, macOS permission
 * prompts, and per-application control trees still need a manual qualification pass against real
 * windows; the fixture is fully synthetic (no real application, user text, or screen content).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/desktop/actions/c02-actions.json', import.meta.url);
/** Deterministic injected clock: every timestamp and expiry the service writes comes from it. */
const NOW = '2026-09-21T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);
/** §5.9: an authorization binds the granted arguments and expires at most 30 s after the grant. */
const MAX_AUTHORIZATION_MS = 30_000;

type FixtureControl = Readonly<{
  ref: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  fingerprint: string;
}>;
type FixturePatch = Readonly<{ ref: string; state: Partial<FixtureControl> }>;
type FixtureGuard = Readonly<{
  key: string;
  reason: DesktopActionStopReason;
  description: string;
  patch?: ReadonlyArray<FixturePatch>;
  clockOffsetMs?: number;
}>;
type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string }>;
  authorizationTtlMs: number;
  app: Readonly<{ bundleId: string; name: string; windowTitle: string }>;
  voiceRequest: Readonly<{ utteranceId: string; text: string; grantText: string }>;
  controls: ReadonlyArray<FixtureControl>;
  edit: Readonly<{
    actionId: string;
    idempotencyKey: string;
    stepId: string;
    targetRef: string;
    value: string;
    untouchedRef: string;
  }>;
  multiStep: Readonly<{
    actionId: string;
    idempotencyKey: string;
    steps: ReadonlyArray<Readonly<{ stepId: string; targetRef: string; value: string }>>;
  }>;
  guards: ReadonlyArray<FixtureGuard>;
}>;

/** The C02 native boundary: raw AX state in, raw AX writes out. */
type DesktopAxControl = Readonly<{
  appBundleId: string;
  windowTitle: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  fingerprint: string;
}>;
type DesktopAxBridge = Readonly<{
  inspect(targetRef: string): Promise<DesktopAxControl | null>;
  setValue(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
}>;

type DesktopActionUtterance = Readonly<{ utteranceId: string; text: string }>;
type DesktopActionStep = Readonly<{
  stepId: string;
  operation: 'set_value';
  targetRef: string;
  targetFingerprint: string;
  value: string;
}>;
type DesktopActionProposal = Readonly<{
  proposalId: string;
  actionId: string;
  state: 'proposed';
  argumentHash: string;
  scope: Scope;
}>;
type DesktopActionAuthorization = Readonly<{
  authorizationId: string;
  proposalId: string;
  authorized: boolean;
  argumentHash: string;
  expiresAt: string;
}>;
type DesktopActionStopReason =
  | 'not_authorized'
  | 'grant_expired'
  | 'focus_changed'
  | 'target_identity_changed'
  | 'target_disabled'
  | 'verification_failed'
  | 'cancelled_by_user';
type DesktopStepOutcome = Readonly<{
  stepId: string;
  status: 'completed' | 'unexecuted' | 'failed';
  before: string | null;
  after: string | null;
  evidenceIds: ReadonlyArray<string>;
}>;
type DesktopActionOutcome = Readonly<{
  actionId: string;
  proposalId: string;
  status: 'in_progress' | 'completed' | 'denied' | 'failed' | 'cancelled';
  reason?: DesktopActionStopReason;
  steps: ReadonlyArray<DesktopStepOutcome>;
  evidenceIds: ReadonlyArray<string>;
}>;
type DesktopActionService = Readonly<{
  propose(input: Readonly<{
    actionId: string;
    idempotencyKey: string;
    utterance: DesktopActionUtterance;
    effect: 'read' | 'local_write' | 'external';
    steps: ReadonlyArray<DesktopActionStep>;
  }>): Promise<DesktopActionProposal>;
  authorize(input: Readonly<{
    proposalId: string;
    utterance: DesktopActionUtterance;
  }>): Promise<DesktopActionAuthorization>;
  advance(input: Readonly<{ proposalId: string }>): Promise<DesktopActionOutcome>;
  cancel(input: Readonly<{ proposalId: string }>): Promise<DesktopActionOutcome>;
}>;
type DesktopActionOptions = Readonly<{
  ax: DesktopAxBridge;
  now: () => Date;
  scope: Scope;
}>;
type DesktopActionModule = Readonly<{
  createDesktopActionService(options: DesktopActionOptions): DesktopActionService;
}>;

const MISSING_BEHAVIOR = 'C02 required desktop action behavior is not implemented yet: '
  + 'packages/desktop-tools/src/actions/index.ts must export createDesktopActionService({ ax, now, '
  + 'scope }) returning propose, authorize, advance, and cancel over the frozen AX target seam.';

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): DesktopActionModule {
  return {
    createDesktopActionService(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadDesktopActionModule(): Promise<DesktopActionModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createDesktopActionService !== 'function') {
    return missingModule('createDesktopActionService is not exported');
  }
  return loaded as unknown as DesktopActionModule;
}

const desktopActions = await loadDesktopActionModule();
const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

function control(ref: string): FixtureControl {
  const found = fixture.controls.find((candidate) => candidate.ref === ref);
  assert.ok(found, `fixture control ${ref} must exist`);
  return found;
}

const INITIAL_SUBJECT_VALUE = control(fixture.edit.targetRef).value;
const INITIAL_BODY_VALUE = control(fixture.edit.untouchedRef).value;

function stepFor(stepId: string, targetRef: string, value: string): DesktopActionStep {
  return {
    stepId,
    operation: 'set_value',
    targetRef,
    targetFingerprint: control(targetRef).fingerprint,
    value,
  };
}

function editSteps(): ReadonlyArray<DesktopActionStep> {
  return [stepFor(fixture.edit.stepId, fixture.edit.targetRef, fixture.edit.value)];
}

function multiSteps(): ReadonlyArray<DesktopActionStep> {
  return fixture.multiStep.steps.map((step) => stepFor(step.stepId, step.targetRef, step.value));
}

type WriteCall = Readonly<{ targetRef: string; value: string }>;
type FakeBridge = DesktopAxBridge & Readonly<{
  writes: Array<WriteCall>;
  inspections: Array<string>;
  patch(ref: string, patch: Partial<Omit<FixtureControl, 'ref'>>): void;
  valueOf(ref: string): string;
  /** Models an AX write the application accepts but never applies: the read-back must catch it. */
  stallWrites(): void;
}>;

function fakeBridge(): FakeBridge {
  const controls = new Map<string, FixtureControl>(
    fixture.controls.map((entry) => [entry.ref, { ...entry }]),
  );
  const writes: Array<WriteCall> = [];
  const inspections: Array<string> = [];
  let applyWrites = true;
  const require = (ref: string): FixtureControl => {
    const found = controls.get(ref);
    if (!found) throw new Error(`C02 oracle: unknown fixture control ${ref}`);
    return found;
  };
  return {
    writes,
    inspections,
    patch(ref, patch) {
      controls.set(ref, { ...require(ref), ...patch });
    },
    valueOf(ref) {
      return require(ref).value;
    },
    stallWrites() {
      applyWrites = false;
    },
    async inspect(targetRef) {
      inspections.push(targetRef);
      const found = controls.get(targetRef);
      if (!found) return null;
      return {
        appBundleId: fixture.app.bundleId,
        windowTitle: fixture.app.windowTitle,
        role: found.role,
        label: found.label,
        value: found.value,
        enabled: found.enabled,
        focused: found.focused,
        fingerprint: found.fingerprint,
      };
    },
    async setValue({ targetRef, value }) {
      writes.push({ targetRef, value });
      const found = require(targetRef);
      if (applyWrites) controls.set(targetRef, { ...found, value });
    },
  };
}

type Harness = Readonly<{
  service: DesktopActionService;
  ax: FakeBridge;
  clock: Readonly<{ now: () => Date; advanceTo(ms: number): void }>;
  subjectValue(): string;
  bodyValue(): string;
  proposeEdit(): Promise<DesktopActionProposal>;
  proposeMultiStep(): Promise<DesktopActionProposal>;
  grant(proposalId: string): Promise<DesktopActionAuthorization>;
}>;

function harness(): Harness {
  let currentMs = NOW_MS;
  const ax = fakeBridge();
  const service = desktopActions.createDesktopActionService({
    ax,
    now: () => new Date(currentMs),
    scope: {
      profileId: fixture.profileId,
      projectId: fixture.project.projectId,
      sensitivity: 'normal',
    },
  });
  const propose = (
    actionId: string,
    idempotencyKey: string,
    steps: ReadonlyArray<DesktopActionStep>,
  ): Promise<DesktopActionProposal> => service.propose({
    actionId,
    idempotencyKey,
    utterance: { utteranceId: fixture.voiceRequest.utteranceId, text: fixture.voiceRequest.text },
    effect: 'local_write',
    steps,
  });
  return {
    service,
    ax,
    clock: {
      now: () => new Date(currentMs),
      advanceTo(ms: number) {
        currentMs = ms;
      },
    },
    subjectValue: () => ax.valueOf(fixture.edit.targetRef),
    bodyValue: () => ax.valueOf(fixture.edit.untouchedRef),
    proposeEdit: () => propose(fixture.edit.actionId, fixture.edit.idempotencyKey, editSteps()),
    proposeMultiStep: () => propose(fixture.multiStep.actionId, fixture.multiStep.idempotencyKey, multiSteps()),
    grant: (proposalId: string) => service.authorize({
      proposalId,
      utterance: {
        utteranceId: `${fixture.voiceRequest.utteranceId}-grant`,
        text: fixture.voiceRequest.grantText,
      },
    }),
  };
}

/** The reported step, projected so extra implementation fields do not weaken the assertions. */
function stepSummary(outcome: DesktopActionOutcome, stepId: string): Readonly<{
  status: string;
  before: string | null;
  after: string | null;
  evidenceIds: ReadonlyArray<string>;
}> {
  const step = outcome.steps.find((candidate) => candidate.stepId === stepId);
  assert.ok(step, `the outcome must report step ${stepId}; got ${JSON.stringify(outcome.steps)}`);
  return {
    status: step.status,
    before: step.before,
    after: step.after,
    evidenceIds: [...step.evidenceIds],
  };
}

function evidenceFor(stepId: string): ReadonlyArray<string> {
  return [`act:before:${stepId}`, `act:after:${stepId}`];
}

test('C02: a voice request edits the intended field and yields a receipt with before/after evidence', async () => {
  const run = harness();
  const proposal = await run.proposeEdit();

  assert.equal(proposal.state, 'proposed', 'a voice request only creates a proposal');
  assert.equal(proposal.actionId, fixture.edit.actionId);
  assert.ok(proposal.argumentHash.trim().length > 0, 'the proposal binds its arguments');
  assert.equal(proposal.scope.projectId, fixture.project.projectId, 'the proposal carries the explicit project scope');
  assert.equal(run.ax.writes.length, 0, 'proposing never writes to the desktop');

  const blocked = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(blocked.status, 'denied', 'an unauthorized proposal never executes');
  assert.equal(blocked.reason, 'not_authorized', 'the receipt names the missing grant');
  assert.equal(run.ax.writes.length, 0, 'no AX write happens before the voice grant');

  const authorization = await run.grant(proposal.proposalId);
  assert.equal(authorization.authorized, true, 'the voice grant authorizes the proposal');
  assert.equal(authorization.argumentHash, proposal.argumentHash, 'the grant binds the proposal arguments');
  const expiresMs = Date.parse(authorization.expiresAt);
  assert.ok(expiresMs > NOW_MS, 'the grant is live');
  assert.ok(expiresMs - NOW_MS <= MAX_AUTHORIZATION_MS, 'the grant expires within the 30 s confirmation window');
  assert.ok(expiresMs - NOW_MS <= fixture.authorizationTtlMs, 'the grant keeps the fixture TTL bound');

  const outcome = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(outcome.status, 'completed', 'the granted step completes');
  assert.equal(outcome.reason, undefined, 'a completed action carries no stop reason');
  assert.equal(outcome.proposalId, proposal.proposalId);
  assert.equal(outcome.actionId, fixture.edit.actionId);
  assert.deepEqual(stepSummary(outcome, fixture.edit.stepId), {
    status: 'completed',
    before: INITIAL_SUBJECT_VALUE,
    after: fixture.edit.value,
    evidenceIds: evidenceFor(fixture.edit.stepId),
  });
  assert.deepEqual([...outcome.evidenceIds], [...evidenceFor(fixture.edit.stepId)]);
  assert.equal(run.subjectValue(), fixture.edit.value, 'the intended field holds the requested value');
  assert.equal(run.bodyValue(), INITIAL_BODY_VALUE, 'the rest of the window is untouched');
  assert.deepEqual(run.ax.writes, [{ targetRef: fixture.edit.targetRef, value: fixture.edit.value }]);
});

test('C02: changed focus, target identity, disabled state, or an expired grant stops execution', async (t) => {
  assert.deepEqual(
    fixture.guards.map((guard) => guard.reason),
    ['focus_changed', 'target_identity_changed', 'target_disabled', 'grant_expired'],
    'the fixture carries exactly the four acceptance guards',
  );

  for (const guard of fixture.guards) {
    await t.test(guard.key, async () => {
      const run = harness();
      const proposal = await run.proposeEdit();
      await run.grant(proposal.proposalId);
      for (const patch of guard.patch ?? []) run.ax.patch(patch.ref, patch.state);
      if (guard.clockOffsetMs !== undefined) run.clock.advanceTo(NOW_MS + guard.clockOffsetMs);

      const outcome = await run.service.advance({ proposalId: proposal.proposalId });

      assert.equal(outcome.status, 'denied', `${guard.key}: the guarded step is stopped`);
      assert.equal(outcome.reason, guard.reason, `${guard.key}: the receipt names the guard`);
      assert.equal(run.ax.writes.length, 0, `${guard.key}: stopped means no AX write`);
      assert.deepEqual(stepSummary(outcome, fixture.edit.stepId), {
        status: 'unexecuted',
        before: null,
        after: null,
        evidenceIds: [],
      }, `${guard.key}: the step is reported unexecuted`);
      assert.deepEqual([...outcome.evidenceIds], [], `${guard.key}: a stopped step has no before/after evidence`);
      assert.equal(run.subjectValue(), INITIAL_SUBJECT_VALUE, `${guard.key}: the target keeps its value`);
    });
  }
});

test('C02: cancelling between steps reports completed versus unexecuted steps', async () => {
  const run = harness();
  const proposal = await run.proposeMultiStep();
  await run.grant(proposal.proposalId);
  const [clearStep, retypeStep] = fixture.multiStep.steps;
  assert.ok(clearStep, 'the fixture defines a first step');
  assert.ok(retypeStep, 'the fixture defines a second step');

  const first = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(first.status, 'in_progress', 'the first of two steps leaves the action in progress');
  assert.deepEqual(stepSummary(first, clearStep.stepId), {
    status: 'completed',
    before: INITIAL_SUBJECT_VALUE,
    after: clearStep.value,
    evidenceIds: evidenceFor(clearStep.stepId),
  });
  assert.deepEqual(stepSummary(first, retypeStep.stepId), {
    status: 'unexecuted',
    before: null,
    after: null,
    evidenceIds: [],
  }, 'the second step is still unexecuted');
  assert.equal(run.subjectValue(), clearStep.value, 'the completed step changed its field');
  assert.equal(run.bodyValue(), INITIAL_BODY_VALUE, 'the other field is untouched');
  assert.equal(run.ax.writes.length, 1, 'only the completed step reached AX');

  const cancelled = await run.service.cancel({ proposalId: proposal.proposalId });
  assert.equal(cancelled.status, 'cancelled', 'cancelling stops the remaining steps');
  assert.equal(cancelled.reason, 'cancelled_by_user');
  assert.deepEqual(stepSummary(cancelled, clearStep.stepId), {
    status: 'completed',
    before: INITIAL_SUBJECT_VALUE,
    after: clearStep.value,
    evidenceIds: evidenceFor(clearStep.stepId),
  }, 'the completed step stays reported as completed');
  assert.deepEqual(stepSummary(cancelled, retypeStep.stepId), {
    status: 'unexecuted',
    before: null,
    after: null,
    evidenceIds: [],
  }, 'the remaining step is reported unexecuted');
  assert.equal(run.ax.writes.length, 1, 'cancel stops the remaining steps before AX');
  assert.equal(run.subjectValue(), clearStep.value, 'the unexecuted step never wrote its value');
  assert.equal(run.bodyValue(), INITIAL_BODY_VALUE, 'the other field stays untouched');

  const resumed = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(resumed.status, 'cancelled', 'a cancelled action never resumes');
  assert.equal(run.ax.writes.length, 1, 'a cancelled action never reaches AX again');
});

test('C02: a guard change between steps stops the rest of the action', async () => {
  const run = harness();
  const proposal = await run.proposeMultiStep();
  await run.grant(proposal.proposalId);
  const [clearStep, retypeStep] = fixture.multiStep.steps;
  assert.ok(clearStep, 'the fixture defines a first step');
  assert.ok(retypeStep, 'the fixture defines a second step');

  const first = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(first.status, 'in_progress');

  run.ax.patch(retypeStep.targetRef, { enabled: false });
  const stopped = await run.service.advance({ proposalId: proposal.proposalId });

  assert.equal(stopped.status, 'denied', 'the second step is preflighted against the live control');
  assert.equal(stopped.reason, 'target_disabled');
  assert.deepEqual(stepSummary(stopped, clearStep.stepId), {
    status: 'completed',
    before: INITIAL_SUBJECT_VALUE,
    after: clearStep.value,
    evidenceIds: evidenceFor(clearStep.stepId),
  }, 'already completed work stays reported');
  assert.deepEqual(stepSummary(stopped, retypeStep.stepId), {
    status: 'unexecuted',
    before: null,
    after: null,
    evidenceIds: [],
  }, 'the disabled second step is reported unexecuted');
  assert.equal(run.ax.writes.length, 1, 'the disabled step never reaches AX');
  assert.equal(run.subjectValue(), clearStep.value, 'the disabled target keeps the completed value');
});

test('C02: a write the application does not apply is not reported as a verified result', async () => {
  const run = harness();
  const proposal = await run.proposeEdit();
  await run.grant(proposal.proposalId);
  run.ax.stallWrites();

  const outcome = await run.service.advance({ proposalId: proposal.proposalId });

  assert.equal(outcome.status, 'failed', 'a disagreeing read-back is never a completed action');
  assert.equal(outcome.reason, 'verification_failed');
  assert.deepEqual(stepSummary(outcome, fixture.edit.stepId), {
    status: 'failed',
    before: INITIAL_SUBJECT_VALUE,
    after: INITIAL_SUBJECT_VALUE,
    evidenceIds: evidenceFor(fixture.edit.stepId),
  }, 'the before/after evidence disagrees, so the step is not verified');
  assert.deepEqual(run.ax.writes, [{ targetRef: fixture.edit.targetRef, value: fixture.edit.value }]);
  assert.equal(run.subjectValue(), INITIAL_SUBJECT_VALUE, 'the field kept its value');
});
