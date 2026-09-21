/**
 * G02 acceptance oracle — gaze + deictic command → target clarification/confirmation → verified
 * desktop action (IMPLEMENTATION_PLAN.md §7.2 G02; §5.11 gaze estimation and target fusion;
 * §5.9 action lifecycle and execution security; BACKLOG.json G02).
 *
 * `packages/desktop-tools/src/gaze-actions/index.ts` must export (this file freezes these names):
 *
 *   createGazeActionCoordinator({ ax, now, scope, confidenceThreshold?, autonomy? }) → Coordinator
 *
 *     ax — the raw AX boundary the C02 service uses, with G02's target identity: `inspect(ref)`
 *       returns the control's current state including `bounds` and a `fingerprint` that covers the
 *       control's window/label identity *and* its on-screen rectangle, because a gaze-derived
 *       target is a screen position — a control that moved or was replaced never passes a stale
 *       fingerprint. `inspect` is the only read; `setValue` is the only write.
 *     now — deterministic clock. The confirmation lifetime (30 s, §5.9) is measured against it.
 *     scope — the explicit project association (the shared §5.3 contract).
 *     confidenceThreshold — the configured read-only threshold (default 0.80, §5.11). It applies to
 *       the outcome of the shared G01 resolver: a gaze answer counts as resolved only when the
 *       resolver resolved it *and* the calibrated confidence is at or above this threshold, so the
 *       same fixation can resolve at 0.80 and ask at 0.90.
 *     autonomy — the session's autonomy profile ('project-partner' default, 'host-autonomy' the
 *       broadest). It is an input only so this oracle can prove it cannot relax the gaze rule.
 *
 *     coordinator:
 *       propose({ requestId, utterance, candidates, gaze, effect, step }) → Promise<ProposalResult>
 *         Resolution only, never execution. The deictic phrase and the calibrated gaze go to the
 *         G01 resolver over the caller's candidates: utterance timing alignment, multiple
 *         candidates, calibrated confidence, and the live AX state of the resolved target.
 *           { kind: 'clarify', requestId, question, options: [{ index, candidateId, label }] }
 *             an ambiguous or below-threshold target asks with named and numbered candidates;
 *           { kind: 'abstain', requestId, reason } — e.g. calibration_failed; nothing is guessed;
 *           { kind: 'proposal', proposal: { proposalId, requestId, targetRef, targetFingerprint,
 *             candidateId, effect, gazeUsed, confidence, basis, requiresConfirmation } }
 *             binds the resolved target and its live fingerprint, the effect, and the step.
 *             A proposal is inert: propose performs no AX write. `requiresConfirmation` is true
 *             exactly for a consequential effect (not 'read') whose target came from gaze.
 *         step is present for every effect except 'read': { stepId, value } — the value is both the
 *         write and the named effect.
 *       confirm({ proposalId, utterance }) → Promise<ConfirmationResult>
 *         The mandatory fresh explicit target-and-effect confirmation for a consequential
 *         gaze-derived action. It is accepted only when the utterance names the resolved control
 *         (whole-label match, the rule the resolver uses) and the effect (the step value); it is
 *         bound to the proposal, single use, and expires 30 s after it is spoken.
 *           { confirmed: true, confirmationId, proposalId, expiresAt }
 *           { confirmed: false, reason: 'target_not_named' | 'effect_not_named' | ... }
 *       advance({ proposalId }) → Promise<Receipt>
 *         Preflights the confirmed target against live AX state, performs exactly one write, and
 *         verifies it by read-back. Receipt = { proposalId, status, reason?, steps, evidenceIds }
 *         with steps [{ stepId, status: 'completed' | 'unexecuted' | 'failed', before, after,
 *         evidenceIds }] and derived evidence ids act:before:<stepId> / act:after:<stepId>.
 *         Denials this oracle pins: 'confirmation_required', 'confirmation_expired',
 *         'target_identity_changed'. A denied advance performs no AX write and leaves the step
 *         unexecuted with no before/after evidence.
 *
 * Deterministic rules pinned here (BACKLOG.json G02 acceptance criteria):
 *   1. Ambiguous targets prompt a named/numbered clarification, and read-only answers use the
 *      configured confidence threshold: the boundary fixation asks instead of resolving, the 0.841
 *      fixation resolves read-only at 0.80 and is clarified at 0.90, and a rejected calibration
 *      abstains with its reason.
 *   2. Every consequential gaze-derived action requires a fresh explicit target-and-effect
 *      confirmation: resolution alone never writes, a generic or one-sided utterance is refused, a
 *      consumed confirmation cannot authorize a second action, an expired confirmation stops, and
 *      Host Autonomy does not relax any of it. A target the user named is not given a redundant
 *      gaze confirmation.
 *   3. Moving or replacing a target after confirmation prevents execution, and no gaze-only event
 *      can create an action: the preflight rechecks the live target identity, a moved or replaced
 *      control is denied with zero writes, and an advance for a proposal that never existed is
 *      denied with zero writes.
 *
 * Frozen fixture: `fixtures/gaze/actions/g02-gaze-actions.json` — a fully synthetic session over a
 * two-control AX tree with three calibrated fixations, a rejected calibration, a deictic phrase, a
 * named phrase, six confirmation utterances, and move/replacement target changes. Nothing here
 * touches real time, real hardware, real applications, or user data.
 *
 * Remaining limitation this oracle reports instead of claiming: webcam capture, MediaPipe
 * landmarks, live AX traversal of real windows, real screen coordinates, macOS permission prompts,
 * and the 20-participant §5.11 accuracy qualification stay with their own tickets/passes. This
 * oracle proves the resolver/fusion and action-seam contract deterministically against doubles.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Scope } from '../../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/gaze/actions/g02-gaze-actions.json', import.meta.url);
/** §5.11: read-only resolution needs calibrated top probability ≥ 0.80 and a ≥ 0.20 margin. */
const READ_ONLY_CONFIDENCE = 0.8;
/** §5.9: a confirmation binds its arguments and expires at most 30 s after it is spoken. */
const MAX_CONFIRMATION_MS = 30_000;
/** The deterministic injected clock: every confirmation timestamp comes from it. */
const NOW = '2026-09-21T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);

type FixtureBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

type FixtureControl = Readonly<{
  ref: string;
  windowTitle: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  bounds: FixtureBounds;
}>;

type FixtureCandidate = Readonly<{
  candidateId: string;
  targetRef: string;
  label: string;
  bounds: FixtureBounds;
  semanticScore: number;
  enabled: boolean;
}>;

type FixtureFixation = Readonly<{
  meanX: number;
  meanY: number;
  quality: number;
  offsetsMs: readonly number[];
}>;

type FixtureCalibration = Readonly<{
  calibrationGeneration: number;
  displayId: string;
  cameraId: string;
  accepted: boolean;
  reason?: string;
  framesUsed: number;
  framesRejected: number;
  validationFramesUsed: number;
  residualCovariance2x2: readonly [readonly [number, number], readonly [number, number]];
  displayArrangementGeneration: number;
  recordedAt: string;
}>;

type FixtureDisplay = Readonly<{
  displayId: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  scale: number;
  arrangementGeneration: number;
}>;

type FixtureUtterance = Readonly<{ utteranceId: string; text: string }>;
type FixtureRequestUtterance = Readonly<{
  utteranceId: string;
  turnId: string;
  text: string;
  wordAt: string;
}>;
type FixtureRequest = Readonly<{ requestId: string; stepId: string; value: string }>;
/** The §7.1 autonomy profiles; 'host-autonomy' is the broadest one. */
type GazeAutonomy = 'observe' | 'project-partner' | 'desktop-partner' | 'host-autonomy';

type Fixture = Readonly<{
  fixtureId: string;
  provenance: string;
  profileId: string;
  project: Readonly<{ projectId: string }>;
  window: Readonly<{ appBundleId: string; windowTitle: string }>;
  display: FixtureDisplay;
  calibration: FixtureCalibration;
  rejectedCalibration: FixtureCalibration;
  controls: readonly FixtureControl[];
  candidates: readonly FixtureCandidate[];
  fixations: Readonly<{ confident: FixtureFixation; band: FixtureFixation; ambiguous: FixtureFixation }>;
  speech: Readonly<{
    deictic: FixtureRequestUtterance;
    named: FixtureRequestUtterance;
    confirmation: FixtureUtterance;
    confirmationTargetOnly: FixtureUtterance;
    confirmationEffectOnly: FixtureUtterance;
    confirmationGeneric: FixtureUtterance;
    confirmationSecond: FixtureUtterance;
    confirmationRepeat: FixtureUtterance;
  }>;
  requests: Readonly<{ primary: FixtureRequest; second: FixtureRequest; repeat: FixtureRequest }>;
  moves: Readonly<{
    bounds: FixtureBounds;
    replacement: Readonly<{ windowTitle: string; label: string }>;
  }>;
  autonomy: Readonly<{ default: GazeAutonomy; permissive: GazeAutonomy }>;
  authorizationTtlMs: number;
}>;

/** One calibrated gaze sample in desktop logical points (the §5.11 G01 shape). */
type GazeSample = Readonly<{
  timestamp: string;
  displayId: string;
  meanX: number;
  meanY: number;
  covariance2x2: readonly [readonly [number, number], readonly [number, number]];
  quality: number;
  calibrationGeneration: number;
  displayTransform: FixtureDisplay;
}>;

type GazeEvidence = Readonly<{ samples: readonly GazeSample[]; calibration: FixtureCalibration }>;
type GazeActionEffect = 'read' | 'local_write' | 'external';
type GazeActionStep = Readonly<{ stepId: string; value: string }>;
type GazeClarificationOption = Readonly<{ index: number; candidateId: string; label: string }>;

type GazeActionProposal = Readonly<{
  proposalId: string;
  requestId: string;
  targetRef: string;
  targetFingerprint: string;
  candidateId: string;
  effect: GazeActionEffect;
  gazeUsed: boolean;
  confidence: number;
  basis: 'gaze' | 'named' | 'context';
  requiresConfirmation: boolean;
}>;

type GazeClarifyResult = Readonly<{
  kind: 'clarify';
  requestId: string;
  question: string;
  options: readonly GazeClarificationOption[];
}>;
type GazeAbstainResult = Readonly<{ kind: 'abstain'; requestId: string; reason: string }>;
type GazeProposalResult =
  | GazeClarifyResult
  | GazeAbstainResult
  | Readonly<{ kind: 'proposal'; proposal: GazeActionProposal }>;

type GazeConfirmationAccepted = Readonly<{
  confirmed: true;
  confirmationId: string;
  proposalId: string;
  expiresAt: string;
}>;
type GazeConfirmationRefused = Readonly<{ confirmed: false; reason: string }>;
type GazeConfirmationResult = GazeConfirmationAccepted | GazeConfirmationRefused;

type GazeStepReceipt = Readonly<{
  stepId: string;
  status: 'completed' | 'unexecuted' | 'failed';
  before: string | null;
  after: string | null;
  evidenceIds: readonly string[];
}>;
type GazeActionReceipt = Readonly<{
  proposalId: string;
  status: 'completed' | 'denied' | 'failed' | 'in_progress';
  reason?: string;
  steps: readonly GazeStepReceipt[];
  evidenceIds: readonly string[];
}>;

type GazeAxControl = Readonly<{
  appBundleId: string;
  windowTitle: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  bounds: FixtureBounds;
  fingerprint: string;
}>;

type GazeAxBridge = Readonly<{
  inspect(targetRef: string): Promise<GazeAxControl | null>;
  setValue(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
}>;

type GazeActionCoordinator = Readonly<{
  propose(input: Readonly<{
    requestId: string;
    utterance: FixtureRequestUtterance;
    candidates: readonly FixtureCandidate[];
    gaze: GazeEvidence | null;
    effect: GazeActionEffect;
    step: GazeActionStep | null;
  }>): Promise<GazeProposalResult>;
  confirm(input: Readonly<{
    proposalId: string;
    utterance: FixtureUtterance;
  }>): Promise<GazeConfirmationResult>;
  advance(input: Readonly<{ proposalId: string }>): Promise<GazeActionReceipt>;
}>;

type GazeActionCoordinatorOptions = Readonly<{
  ax: GazeAxBridge;
  now: () => Date;
  scope: Scope;
  confidenceThreshold?: number;
  autonomy?: GazeAutonomy;
}>;

type GazeActionModule = Readonly<{
  createGazeActionCoordinator(options: GazeActionCoordinatorOptions): GazeActionCoordinator;
}>;

const MISSING_BEHAVIOR = 'G02 required gaze action behavior is not implemented yet: '
  + 'packages/desktop-tools/src/gaze-actions/index.ts must export createGazeActionCoordinator({ ax, '
  + 'now, scope, confidenceThreshold?, autonomy? }) returning propose, confirm, and advance over '
  + 'the frozen gaze target, confirmation, and AX receipt seam.';

/** Until the implementation exists every test fails with the missing behavior, never a crash. */
function missingModule(detail: string): GazeActionModule {
  return {
    createGazeActionCoordinator(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadGazeActionModule(): Promise<GazeActionModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createGazeActionCoordinator !== 'function') {
    return missingModule('createGazeActionCoordinator is not exported');
  }
  return loaded as unknown as GazeActionModule;
}

const gazeActions = await loadGazeActionModule();
const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

function control(ref: string): FixtureControl {
  const found = fixture.controls.find((candidate) => candidate.ref === ref);
  assert.ok(found, `fixture control ${ref} must exist`);
  return found;
}

function initialValue(ref: string): string {
  return control(ref).value;
}

function evidenceFor(stepId: string): ReadonlyArray<string> {
  return [`act:before:${stepId}`, `act:after:${stepId}`];
}

type FakeAx = GazeAxBridge & Readonly<{
  writes: ReadonlyArray<Readonly<{ targetRef: string; value: string }>>;
  move(targetRef: string, bounds: FixtureBounds): void;
  replace(targetRef: string, patch: Readonly<{ windowTitle: string; label: string }>): void;
  valueOf(targetRef: string): string;
  fingerprintOf(targetRef: string): string;
}>;

function fakeAx(): FakeAx {
  const controls = new Map<string, FixtureControl>(
    fixture.controls.map((entry) => [entry.ref, { ...entry }]),
  );
  const writes: Array<{ targetRef: string; value: string }> = [];
  const require = (targetRef: string): FixtureControl => {
    const found = controls.get(targetRef);
    if (!found) throw new Error(`G02 oracle: unknown fixture control ${targetRef}`);
    return found;
  };
  // The G02 target identity: the window/label identity *and* the on-screen rectangle, so a control
  // that moved or was replaced can never pass the fingerprint the user confirmed.
  const fingerprint = (entry: FixtureControl): string => [
    'g02',
    fixture.window.appBundleId,
    entry.windowTitle,
    entry.role,
    entry.label,
    entry.bounds.x,
    entry.bounds.y,
    entry.bounds.width,
    entry.bounds.height,
  ].join('|');
  return {
    writes,
    move(targetRef, bounds) {
      controls.set(targetRef, { ...require(targetRef), bounds: { ...bounds } });
    },
    replace(targetRef, patch) {
      controls.set(targetRef, { ...require(targetRef), ...patch });
    },
    valueOf(targetRef) {
      return require(targetRef).value;
    },
    fingerprintOf(targetRef) {
      return fingerprint(require(targetRef));
    },
    async inspect(targetRef) {
      const found = controls.get(targetRef);
      if (!found) return null;
      return {
        appBundleId: fixture.window.appBundleId,
        windowTitle: found.windowTitle,
        role: found.role,
        label: found.label,
        value: found.value,
        enabled: found.enabled,
        focused: found.focused,
        bounds: { ...found.bounds },
        fingerprint: fingerprint(found),
      };
    },
    async setValue({ targetRef, value }) {
      writes.push({ targetRef, value });
      controls.set(targetRef, { ...require(targetRef), value });
    },
  };
}

/**
 * The fixture fixation as calibrated gaze evidence: five samples inside the §5.11 deictic window
 * [wordAt − 700 ms, wordAt + 200 ms], each carrying the calibration and display transform.
 */
function gazeEvidence(fixation: FixtureFixation, calibration: FixtureCalibration): GazeEvidence {
  const wordMs = Date.parse(fixture.speech.deictic.wordAt);
  return {
    samples: fixation.offsetsMs.map((offsetMs) => ({
      timestamp: new Date(wordMs + offsetMs).toISOString(),
      displayId: calibration.displayId,
      meanX: fixation.meanX,
      meanY: fixation.meanY,
      covariance2x2: [[1, 0], [0, 1]] as const,
      quality: fixation.quality,
      calibrationGeneration: calibration.calibrationGeneration,
      displayTransform: fixture.display,
    })),
    calibration,
  };
}

type SessionOptions = Readonly<{ confidenceThreshold?: number; autonomy?: GazeAutonomy }>;

type ProposeInput = Readonly<{
  request: FixtureRequest;
  effect: GazeActionEffect;
  phrase?: FixtureRequestUtterance;
  fixation?: FixtureFixation;
  calibration?: FixtureCalibration;
  /** Explicit evidence override; null is the context-only baseline (same request, no gaze). */
  gaze?: GazeEvidence | null;
}>;

type Session = Readonly<{
  coordinator: GazeActionCoordinator;
  ax: FakeAx;
  clock: Readonly<{ now: () => Date; advanceMs: (ms: number) => void }>;
  propose: (input: ProposeInput) => Promise<GazeProposalResult>;
}>;

function session(options: SessionOptions = {}): Session {
  let currentMs = NOW_MS;
  const ax = fakeAx();
  const coordinator = gazeActions.createGazeActionCoordinator({
    ax,
    now: () => new Date(currentMs),
    scope: {
      profileId: fixture.profileId,
      projectId: fixture.project.projectId,
      sensitivity: 'normal',
    },
    ...(options.confidenceThreshold === undefined
      ? {}
      : { confidenceThreshold: options.confidenceThreshold }),
    autonomy: options.autonomy ?? fixture.autonomy.default,
  });
  return {
    coordinator,
    ax,
    clock: {
      now: () => new Date(currentMs),
      advanceMs(ms: number) {
        currentMs += ms;
      },
    },
    propose(input: ProposeInput) {
      const gaze = input.gaze !== undefined
        ? input.gaze
        : gazeEvidence(input.fixation ?? fixture.fixations.confident, input.calibration ?? fixture.calibration);
      return coordinator.propose({
        requestId: input.request.requestId,
        utterance: input.phrase ?? fixture.speech.deictic,
        candidates: fixture.candidates,
        gaze,
        effect: input.effect,
        step: input.effect === 'read' ? null : { stepId: input.request.stepId, value: input.request.value },
      });
    },
  };
}

function expectProposal(result: GazeProposalResult): GazeActionProposal {
  if (result.kind === 'proposal') return result.proposal;
  throw new Error(`G02 oracle: expected a resolved proposal, got a ${result.kind}: ${JSON.stringify(result)}`);
}

function expectClarify(result: GazeProposalResult): GazeClarifyResult {
  if (result.kind === 'clarify') return result;
  throw new Error(`G02 oracle: expected a clarification, got a ${result.kind}: ${JSON.stringify(result)}`);
}

function expectAbstain(result: GazeProposalResult): GazeAbstainResult {
  if (result.kind === 'abstain') return result;
  throw new Error(`G02 oracle: expected an abstention, got a ${result.kind}: ${JSON.stringify(result)}`);
}

async function acceptConfirmation(
  run: Session,
  proposal: GazeActionProposal,
  utterance: FixtureUtterance,
): Promise<GazeConfirmationAccepted> {
  const result = await run.coordinator.confirm({ proposalId: proposal.proposalId, utterance });
  if (!result.confirmed) {
    throw new Error(`G02 oracle: expected "${utterance.text}" to confirm the action, refused with ${result.reason}`);
  }
  return result;
}

async function refuseConfirmation(
  run: Session,
  proposal: GazeActionProposal,
  utterance: FixtureUtterance,
): Promise<string> {
  const result = await run.coordinator.confirm({ proposalId: proposal.proposalId, utterance });
  if (result.confirmed) {
    throw new Error(`G02 oracle: "${utterance.text}" must not be accepted as a confirmation`);
  }
  assert.ok(result.reason.length > 0, 'a refused confirmation names a reason');
  return result.reason;
}

function stepReceipt(receipt: GazeActionReceipt, stepId: string): GazeStepReceipt {
  const step = receipt.steps.find((candidate) => candidate.stepId === stepId);
  assert.ok(step, `the receipt reports step ${stepId}: ${JSON.stringify(receipt.steps)}`);
  return step;
}

/** A stopped action: denied status, the named guard, no write, and the step left unexecuted. */
function expectStopped(receipt: GazeActionReceipt, stepId: string, reason: string): void {
  assert.equal(receipt.status, 'denied', `the advance is denied: ${JSON.stringify(receipt)}`);
  assert.equal(receipt.reason, reason, 'the receipt names the guard');
  assert.deepEqual([...receipt.evidenceIds], [], 'a denied action carries no evidence');
  const step = stepReceipt(receipt, stepId);
  assert.deepEqual(
    { status: step.status, before: step.before, after: step.after, evidenceIds: [...step.evidenceIds] },
    { status: 'unexecuted', before: null, after: null, evidenceIds: [] },
    'a stopped step is reported unexecuted with no read-back',
  );
}

test('G02-C1.1 an ambiguous deictic target asks a named/numbered clarification and writes nothing', async () => {
  const run = session();
  const clarify = expectClarify(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.ambiguous,
  }));

  assert.equal(clarify.requestId, fixture.requests.primary.requestId, 'the clarification binds the request');
  assert.ok(clarify.question.trim().length > 0, 'the clarification asks a question');
  assert.ok(clarify.options.length >= 2, 'a product clarification offers at least two candidates');
  assert.ok(clarify.options.length <= 3, 'a product clarification offers at most three candidates (§5.11)');
  assert.deepEqual(
    [...clarify.options.map((option) => option.index)],
    clarify.options.map((_option, position) => position + 1),
    'the options are numbered from one so the user can answer with a number',
  );
  assert.deepEqual(
    [...clarify.options.map((option) => option.label)].sort(),
    ['Discard', 'Publish'],
    'the clarification names the plausible controls',
  );
  for (const option of clarify.options) {
    assert.ok(clarify.question.includes(option.label), `the question names ${option.label}`);
    assert.ok(clarify.question.includes(String(option.index)), `the question numbers option ${option.index}`);
  }
  assert.equal(run.ax.writes.length, 0, 'an ambiguous target performs no AX write');
});

test('G02-C1.2 a read-only answer resolves inside the configured confidence threshold', async () => {
  const run = session({ confidenceThreshold: READ_ONLY_CONFIDENCE });
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'read',
    fixation: fixture.fixations.band,
  }));

  assert.equal(proposal.requestId, fixture.requests.primary.requestId);
  assert.equal(proposal.candidateId, 'cand-publish', 'the calibrated gaze resolves the Publish control');
  assert.equal(proposal.targetRef, 'ax-publish', 'the proposal binds the resolved AX target');
  assert.equal(proposal.effect, 'read');
  assert.equal(proposal.basis, 'gaze');
  assert.equal(proposal.gazeUsed, true);
  assert.ok(
    proposal.confidence >= READ_ONLY_CONFIDENCE && proposal.confidence < 0.9,
    `the fixture fixation sits inside the read-only confidence band, got ${proposal.confidence}`,
  );
  assert.ok(proposal.targetFingerprint.length > 0, 'the proposal binds the live target fingerprint');
  assert.equal(proposal.requiresConfirmation, false, 'a read-only answer is not a consequential action');
  assert.equal(run.ax.writes.length, 0, 'resolution performs no AX write');
});

test('G02-C1.3 the configured threshold governs: the same fixation is clarified at 0.90', async () => {
  const run = session({ confidenceThreshold: 0.9 });
  const clarify = expectClarify(await run.propose({
    request: fixture.requests.primary,
    effect: 'read',
    fixation: fixture.fixations.band,
  }));

  assert.ok(clarify.options.length >= 2, 'below the configured threshold the target is asked, not guessed');
  assert.equal(run.ax.writes.length, 0, 'a below-threshold answer performs no AX write');
});

test('G02-C1.4 a rejected calibration abstains with its reason instead of guessing', async () => {
  const run = session();
  const abstain = expectAbstain(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
    calibration: fixture.rejectedCalibration,
  }));

  assert.equal(abstain.requestId, fixture.requests.primary.requestId);
  assert.equal(abstain.reason, 'calibration_failed', 'the abstention names the failed calibration');
  assert.equal(run.ax.writes.length, 0, 'nothing is written when gaze is unusable');
});

test('G02-C2.1 a consequential gaze action cannot execute without a fresh confirmation', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));

  assert.equal(proposal.requiresConfirmation, true, 'a consequential gaze-derived action requires a confirmation');
  assert.equal(run.ax.writes.length, 0, 'resolution alone never writes');

  expectStopped(
    await run.coordinator.advance({ proposalId: proposal.proposalId }),
    fixture.requests.primary.stepId,
    'confirmation_required',
  );
  assert.equal(run.ax.writes.length, 0, 'an unconfirmed advance performs no AX write');
  assert.equal(run.ax.valueOf('ax-publish'), initialValue('ax-publish'), 'the target keeps its value');
});

test('G02-C2.2 a generic or one-sided utterance is not a target-and-effect confirmation', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));

  const refusals = [
    [fixture.speech.confirmationGeneric, 'target_not_named'],
    [fixture.speech.confirmationEffectOnly, 'target_not_named'],
    [fixture.speech.confirmationTargetOnly, 'effect_not_named'],
  ] as const;
  for (const [utterance, reason] of refusals) {
    assert.equal(
      await refuseConfirmation(run, proposal, utterance),
      reason,
      `"${utterance.text}" must be refused with ${reason}`,
    );
  }

  expectStopped(
    await run.coordinator.advance({ proposalId: proposal.proposalId }),
    fixture.requests.primary.stepId,
    'confirmation_required',
  );
  assert.equal(run.ax.writes.length, 0, 'refused confirmations never reach AX');
});

test('G02-C2.3 a fresh target-and-effect confirmation executes one verified write', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));
  const confirmation = await acceptConfirmation(run, proposal, fixture.speech.confirmation);

  assert.equal(confirmation.proposalId, proposal.proposalId, 'the confirmation binds the proposal');
  assert.ok(confirmation.confirmationId.length > 0, 'the confirmation has an id');
  const lifetimeMs = Date.parse(confirmation.expiresAt) - run.clock.now().getTime();
  assert.equal(lifetimeMs, fixture.authorizationTtlMs, 'the confirmation keeps the fixture TTL');
  assert.ok(lifetimeMs <= MAX_CONFIRMATION_MS, '§5.9: a confirmation never lives longer than 30 s');

  const receipt = await run.coordinator.advance({ proposalId: proposal.proposalId });
  assert.equal(receipt.status, 'completed', `the confirmed step completes: ${JSON.stringify(receipt)}`);
  assert.equal(receipt.proposalId, proposal.proposalId);
  assert.deepEqual(
    [...run.ax.writes],
    [{ targetRef: 'ax-publish', value: fixture.requests.primary.value }],
    'exactly one AX write to the resolved target',
  );
  const step = stepReceipt(receipt, fixture.requests.primary.stepId);
  assert.equal(step.status, 'completed');
  assert.equal(step.before, initialValue('ax-publish'));
  assert.equal(step.after, fixture.requests.primary.value, 'the read-back equals the requested value');
  assert.deepEqual([...step.evidenceIds], [...evidenceFor(fixture.requests.primary.stepId)]);
  assert.deepEqual([...receipt.evidenceIds], [...evidenceFor(fixture.requests.primary.stepId)]);
  assert.equal(run.ax.valueOf('ax-publish'), fixture.requests.primary.value);
  assert.equal(run.ax.valueOf('ax-discard'), initialValue('ax-discard'), 'the rest of the window keeps its values');
});

test('G02-C2.4 a consumed confirmation cannot authorize a second action', async () => {
  const run = session();
  const first = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));
  await acceptConfirmation(run, first, fixture.speech.confirmation);
  assert.equal((await run.coordinator.advance({ proposalId: first.proposalId })).status, 'completed');

  const repeat = expectProposal(await run.propose({
    request: fixture.requests.repeat,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));
  await refuseConfirmation(run, repeat, fixture.speech.confirmation);
  expectStopped(
    await run.coordinator.advance({ proposalId: repeat.proposalId }),
    fixture.requests.repeat.stepId,
    'confirmation_required',
  );
  assert.equal(run.ax.writes.length, 1, 'a replayed confirmation never reaches AX');

  await acceptConfirmation(run, repeat, fixture.speech.confirmationRepeat);
  const second = await run.coordinator.advance({ proposalId: repeat.proposalId });
  assert.equal(second.status, 'completed', 'a fresh confirmation authorizes the new action');
  assert.equal(run.ax.writes.length, 2, 'the second action writes exactly once');
  assert.equal(run.ax.valueOf('ax-publish'), fixture.requests.repeat.value);
});

test('G02-C2.5 an expired confirmation does not execute', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.second,
    effect: 'external',
    fixation: fixture.fixations.confident,
  }));
  const confirmation = await acceptConfirmation(run, proposal, fixture.speech.confirmationSecond);
  assert.equal(
    Date.parse(confirmation.expiresAt) - run.clock.now().getTime(),
    fixture.authorizationTtlMs,
    'the confirmation expires on the injected clock',
  );

  run.clock.advanceMs(fixture.authorizationTtlMs + 1);
  expectStopped(
    await run.coordinator.advance({ proposalId: proposal.proposalId }),
    fixture.requests.second.stepId,
    'confirmation_expired',
  );
  assert.equal(run.ax.writes.length, 0, 'an expired confirmation performs no AX write');
  assert.equal(run.ax.valueOf('ax-publish'), initialValue('ax-publish'), 'the target keeps its value');
});

test('G02-C2.6 host autonomy does not relax the gaze confirmation rule', async () => {
  const run = session({ autonomy: fixture.autonomy.permissive });
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));

  assert.equal(proposal.requiresConfirmation, true, 'the requirement is not a function of the autonomy profile');
  expectStopped(
    await run.coordinator.advance({ proposalId: proposal.proposalId }),
    fixture.requests.primary.stepId,
    'confirmation_required',
  );
  assert.equal(run.ax.writes.length, 0, 'host autonomy never substitutes for the gaze confirmation');
});

test('G02-C2.7 a target the user named is not given a redundant gaze confirmation', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    phrase: fixture.speech.named,
    fixation: fixture.fixations.confident,
  }));

  assert.equal(proposal.basis, 'named', 'a spoken name wins over gaze (§5.11)');
  assert.equal(proposal.gazeUsed, false, 'gaze never overrides a named target');
  assert.equal(proposal.targetRef, 'ax-publish');
  assert.equal(proposal.requiresConfirmation, false, 'G02 adds no confirmation to an unrelated non-gaze target');
  assert.equal(run.ax.writes.length, 0);
});

test('G02-C3.1 moving the target after confirmation prevents execution', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));
  await acceptConfirmation(run, proposal, fixture.speech.confirmation);

  run.ax.move('ax-publish', fixture.moves.bounds);
  assert.notEqual(
    run.ax.fingerprintOf('ax-publish'),
    proposal.targetFingerprint,
    'the moved control reports a new identity',
  );

  expectStopped(
    await run.coordinator.advance({ proposalId: proposal.proposalId }),
    fixture.requests.primary.stepId,
    'target_identity_changed',
  );
  assert.equal(run.ax.writes.length, 0, 'a moved target is never written');
  assert.equal(run.ax.valueOf('ax-publish'), initialValue('ax-publish'), 'the target keeps its value');
});

test('G02-C3.2 replacing the target after confirmation prevents execution', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));
  await acceptConfirmation(run, proposal, fixture.speech.confirmation);

  run.ax.replace('ax-publish', fixture.moves.replacement);
  assert.notEqual(
    run.ax.fingerprintOf('ax-publish'),
    proposal.targetFingerprint,
    'the replaced control reports a new identity',
  );

  expectStopped(
    await run.coordinator.advance({ proposalId: proposal.proposalId }),
    fixture.requests.primary.stepId,
    'target_identity_changed',
  );
  assert.equal(run.ax.writes.length, 0, 'a replaced target is never written');
  assert.equal(run.ax.valueOf('ax-publish'), initialValue('ax-publish'));
});

test('G02-C3.3 no gaze-only event can create an action', async () => {
  const run = session();
  const proposal = expectProposal(await run.propose({
    request: fixture.requests.primary,
    effect: 'local_write',
    fixation: fixture.fixations.confident,
  }));

  assert.equal(run.ax.writes.length, 0, 'a fixation plus resolution is not an action');
  const denied = await run.coordinator.advance({ proposalId: 'gaze-only' });
  assert.equal(denied.status, 'denied', 'an advance for a proposal that never existed is denied');
  assert.ok(
    typeof denied.reason === 'string' && denied.reason.length > 0,
    'the denial names a reason',
  );
  assert.equal(run.ax.writes.length, 0, 'no gaze-only path reaches AX');
  assert.equal(run.ax.valueOf('ax-publish'), initialValue('ax-publish'));
  assert.equal(proposal.requiresConfirmation, true);
});
