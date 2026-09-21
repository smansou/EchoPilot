/**
 * C02 lifecycle unit checks — the parts of the action contract the frozen acceptance oracle leaves
 * open, kept on the same deterministic fixture corpus (`fixtures/desktop/actions/c02-actions.json`):
 *
 * - proposing is inert and idempotent: no AX read, no AX write, the same idempotency key replays the
 *   same proposal, and a changed argument under that key is refused instead of silently granted;
 * - a stopped step stays resumable: after the grant expires the step is unexecuted and no AX read or
 *   write happened, a fresh grant preflights it again, and only then does the intended field change;
 * - an executed step reads the target exactly twice (preflight + read-back) and writes exactly once;
 * - cancelling a decided action never rewrites its receipt;
 * - the canonical hash contract is pinned to the values the native `DesktopAX` package asserts, so
 *   the TypeScript grant and the Swift session can never drift apart silently.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';
import { argumentHashFor, canonicalJson, sha256Hex } from './arguments.js';
import {
  createDesktopActionService,
  type DesktopActionProposal,
  type DesktopActionService,
  type DesktopActionStep,
  type DesktopAxBridge,
  type DesktopAxControl,
} from './index.js';

const FIXTURE_URL = new URL('../../../../fixtures/desktop/actions/c02-actions.json', import.meta.url);
const NOW_MS = Date.parse('2026-09-21T10:00:00.000Z');

type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string }>;
  app: Readonly<{ bundleId: string; name: string; windowTitle: string }>;
  controls: ReadonlyArray<Readonly<{
    ref: string;
    role: string;
    label: string;
    value: string;
    enabled: boolean;
    focused: boolean;
    fingerprint: string;
  }>>;
  edit: Readonly<{ actionId: string; idempotencyKey: string; stepId: string; targetRef: string; value: string }>;
  multiStep: Readonly<{
    actionId: string;
    idempotencyKey: string;
    steps: ReadonlyArray<Readonly<{ stepId: string; targetRef: string; value: string }>>;
  }>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

function control(ref: string) {
  const found = fixture.controls.find((candidate) => candidate.ref === ref);
  assert.ok(found, `fixture control ${ref} must exist`);
  return found;
}

function harness(): Readonly<{
  service: DesktopActionService;
  controls: Map<string, Fixture['controls'][number]>;
  writes: Array<Readonly<{ targetRef: string; value: string }>>;
  inspections: Array<string>;
  setClock(ms: number): void;
  editSteps(value?: string): ReadonlyArray<DesktopActionStep>;
  propose(steps: ReadonlyArray<DesktopActionStep>): Promise<DesktopActionProposal>;
}> {
  const controls = new Map(fixture.controls.map((entry) => [entry.ref, { ...entry }]));
  const writes: Array<Readonly<{ targetRef: string; value: string }>> = [];
  const inspections: Array<string> = [];
  let currentMs = NOW_MS;
  const ax: DesktopAxBridge = {
    async inspect(targetRef) {
      inspections.push(targetRef);
      const found = controls.get(targetRef);
      return found === undefined
        ? null
        : {
          appBundleId: fixture.app.bundleId,
          windowTitle: fixture.app.windowTitle,
          role: found.role,
          label: found.label,
          value: found.value,
          enabled: found.enabled,
          focused: found.focused,
          fingerprint: found.fingerprint,
        } satisfies DesktopAxControl;
    },
    async setValue({ targetRef, value }) {
      writes.push({ targetRef, value });
      const found = controls.get(targetRef);
      if (found === undefined) throw new Error(`unknown control ${targetRef}`);
      controls.set(targetRef, { ...found, value });
    },
  };
  const scope: Scope = {
    profileId: fixture.profileId,
    projectId: fixture.project.projectId,
    sensitivity: 'normal',
  };
  const service = createDesktopActionService({ ax, now: () => new Date(currentMs), scope });
  const editSteps = (value = fixture.edit.value): ReadonlyArray<DesktopActionStep> => [{
    stepId: fixture.edit.stepId,
    operation: 'set_value',
    targetRef: fixture.edit.targetRef,
    targetFingerprint: control(fixture.edit.targetRef).fingerprint,
    value,
  }];
  return {
    service,
    controls,
    writes,
    inspections,
    setClock(ms) {
      currentMs = ms;
    },
    editSteps,
    propose: (steps) => service.propose({
      actionId: fixture.edit.actionId,
      idempotencyKey: fixture.edit.idempotencyKey,
      utterance: { utteranceId: 'utt-c02-unit', text: 'Set the subject to Final report' },
      effect: 'local_write',
      steps,
    }),
  };
}

const grant = { utteranceId: 'utt-c02-unit-grant', text: 'Yes, set the subject to Final report' };

test('C02 unit: proposing is inert, idempotent, and refuses changed arguments under one key', async () => {
  const run = harness();
  const first = await run.propose(run.editSteps());
  assert.equal(first.state, 'proposed');
  assert.equal(run.inspections.length, 0, 'proposing never reads the desktop');
  assert.equal(run.writes.length, 0, 'proposing never writes to the desktop');

  const replay = await run.propose(run.editSteps());
  assert.equal(replay.proposalId, first.proposalId, 'the same request replays the same proposal');
  assert.equal(replay.argumentHash, first.argumentHash);

  await assert.rejects(
    () => run.propose(run.editSteps('A different value')),
    /already bound to different arguments/,
    'a changed value cannot ride a granted idempotency key',
  );
  assert.equal(run.writes.length, 0);
});

test('C02 unit: an expired grant stops with zero AX reads, and a fresh grant resumes the step', async () => {
  const run = harness();
  const proposal = await run.propose(run.editSteps());
  await run.service.authorize({ proposalId: proposal.proposalId, utterance: grant });
  run.setClock(NOW_MS + 30_001);

  const expired = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(expired.status, 'denied');
  assert.equal(expired.reason, 'grant_expired');
  assert.equal(run.inspections.length, 0, 'the expired grant is refused before any AX read');
  assert.equal(run.writes.length, 0, 'the expired grant is refused before any AX write');
  assert.equal(expired.steps[0]?.status, 'unexecuted');
  assert.equal(run.controls.get(fixture.edit.targetRef)?.value, control(fixture.edit.targetRef).value);

  const fresh = await run.service.authorize({ proposalId: proposal.proposalId, utterance: grant });
  assert.equal(fresh.authorized, true, 'a new grant can authorize the stopped step again');
  const resumed = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(resumed.status, 'completed');
  assert.equal(run.controls.get(fixture.edit.targetRef)?.value, fixture.edit.value);
  assert.deepEqual(run.writes, [{ targetRef: fixture.edit.targetRef, value: fixture.edit.value }]);
});

test('C02 unit: one executed step reads twice and writes once; a decided action never re-runs', async () => {
  const run = harness();
  const proposal = await run.propose(run.editSteps());
  await run.service.authorize({ proposalId: proposal.proposalId, utterance: grant });

  const outcome = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(
    run.inspections,
    [fixture.edit.targetRef, fixture.edit.targetRef],
    'exactly the preflight read and the post-action read-back',
  );
  assert.equal(run.writes.length, 1);

  const cancelled = await run.service.cancel({ proposalId: proposal.proposalId });
  assert.equal(cancelled.status, 'completed', 'cancel never rewrites a completed receipt');
  assert.equal(cancelled.reason, undefined);
  assert.deepEqual([...cancelled.evidenceIds], [
    `act:before:${fixture.edit.stepId}`,
    `act:after:${fixture.edit.stepId}`,
  ]);
  const again = await run.service.advance({ proposalId: proposal.proposalId });
  assert.equal(again.status, 'completed');
  assert.equal(run.writes.length, 1, 'a decided action never reaches AX again');
});

test('C02 unit: the canonical hash contract matches the native DesktopAX expectations', async () => {
  const run = harness();
  const scope: Scope = {
    profileId: fixture.profileId,
    projectId: fixture.project.projectId,
    sensitivity: 'normal',
  };
  const multiSteps: ReadonlyArray<DesktopActionStep> = fixture.multiStep.steps.map((step) => ({
    stepId: step.stepId,
    operation: 'set_value',
    targetRef: step.targetRef,
    targetFingerprint: control(step.targetRef).fingerprint,
    value: step.value,
  }));

  assert.equal(canonicalJson({ b: 1, a: [1, 'x'] }), '{"a":[1,"x"],"b":1}');
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'the empty string is the standard SHA-256 vector the native package also pins',
  );
  assert.equal(
    await argumentHashFor({
      actionId: fixture.edit.actionId,
      effect: 'local_write',
      scope,
      steps: run.editSteps(),
    }),
    '4f63ca0fdcb18b837d50e82be720c543831534090f6b2d42e6e71a3b44488dc4',
    'the edit argument hash is the exact value the Swift DesktopAX tests assert',
  );
  assert.equal(
    await argumentHashFor({
      actionId: fixture.multiStep.actionId,
      effect: 'local_write',
      scope,
      steps: multiSteps,
    }),
    'd7a834a46f56177f881d78db5181db14d626498c634704e7043534c5cf5274ca',
    'the multi-step argument hash is the exact value the Swift DesktopAX tests assert',
  );

  const proposal = await run.propose(run.editSteps());
  assert.equal(proposal.proposalId, 'proposal-56f1aa973e94d704');
  const authorization = await run.service.authorize({
    proposalId: proposal.proposalId,
    utterance: { utteranceId: 'utt-c02-edit-subject-grant', text: 'Yes, set the subject to Final report' },
  });
  assert.equal(authorization.authorizationId, 'grant-c1f65fadde95135a');
  assert.equal(authorization.expiresAt, '2026-09-21T10:00:30.000Z');
});
