/**
 * Q04 cross-pillar evidence harness — the deterministic gaze/desktop control used by the release
 * gate evidence and by `scripts/release/qualify-release.mjs`.
 *
 * Everything here drives the *shipped* confirmation gate
 * (`packages/desktop-tools/src/gaze-actions/index.ts`) over a synthesized two-control AX tree: the
 * corpus supplies only the target label, the step value and the attack, and the harness never
 * re-implements the safety rule it is checking. A consequential gaze-derived action executes only
 * when the shipped coordinator accepted a fresh, target-and-effect-naming, single-use confirmation;
 * every probe reports what the coordinator actually did, including its refusal reason.
 */
import { createGazeActionCoordinator } from '../../../desktop-tools/src/gaze-actions/index.js';
import type { GazeEvidence } from '../../../gaze/src/resolution/index.js';

export type HarnessBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

export type HarnessCandidate = Readonly<{
  candidateId: string;
  targetRef: string;
  label: string;
  bounds: HarnessBounds;
  semanticScore: number;
  enabled: boolean;
}>;

export type HarnessEffect = 'read' | 'local_write' | 'external';

export type GazeCaseSpec = Readonly<{
  caseId: string;
  kind?: string;
  attack: string;
  effect?: HarnessEffect;
  targetLabel: string;
  stepValue: string;
  expect: Readonly<{ executed: boolean }>;
}>;

export type GazeCaseOutcome = Readonly<{
  caseId: string;
  kind: string;
  attack: string;
  attempted: true;
  executed: boolean;
  reason: string;
  expected: boolean;
  matched: boolean;
  writes: readonly Readonly<{ targetRef: string; value: string }>[];
}>;

export type HarnessWrites = ReadonlyArray<Readonly<{ targetRef: string; value: string }>>;

export type HarnessAx = Readonly<{
  inspect(targetRef: string): Promise<Readonly<{ value: string; fingerprint: string }> | null>;
  setValue(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
  writes(): readonly Readonly<{ targetRef: string; value: string }>[];
  valueOf(targetRef: string): string | null;
  fingerprintOf(targetRef: string): string | null;
  move(targetRef: string, bounds?: HarnessBounds): void;
  /** Makes the next write land as a different value, so read-back verification must fail. */
  corruptNextWrite(): void;
}>;

/** The frozen §5.9 confirmation lifetime; the harness clock moves past it explicitly. */
export const CONFIRMATION_TTL_MS = 30_000;
export const GAZE_NOW = '2026-09-21T10:00:00.000Z';
export const GAZE_WORD_AT = '2026-09-21T10:00:01.000Z';

export const KNOWN_GAZE_ATTACKS = Object.freeze([
  'advance_without_confirm',
  'confirm_wrong_target',
  'confirm_without_effect',
  'confirm_generic_affirmation',
  'replay_confirmation',
  'expire_before_advance',
  'advance_after_target_change',
  'advance_under_host_autonomy',
  'legitimate_confirmation',
]);

const PRIMARY_BOUNDS: HarnessBounds = { x: 400, y: 300, width: 180, height: 120 };
const DECOY_BOUNDS: HarnessBounds = { x: 580, y: 300, width: 180, height: 120 };
const DISPLAY = Object.freeze({
  displayId: 'display-main',
  originX: 0,
  originY: 0,
  width: 1600,
  height: 1000,
  scale: 2,
  arrangementGeneration: 1,
});

function candidateFor(label: string, bounds: HarnessBounds, suffix: string): HarnessCandidate {
  return {
    candidateId: `cand-${suffix}`,
    targetRef: `ax-${suffix}`,
    label,
    bounds,
    semanticScore: 1,
    enabled: true,
  };
}

export function createHarnessAx(candidates: readonly HarnessCandidate[]): HarnessAx {
  const controls = new Map<string, { candidate: HarnessCandidate; value: string; corrupt: boolean }>(
    candidates.map((candidate) => [candidate.targetRef, { candidate, value: 'idle', corrupt: false }]),
  );
  const writes: Array<{ targetRef: string; value: string }> = [];
  let corruptNextWrite = false;
  const fingerprint = (candidate: HarnessCandidate): string => [
    'q04',
    candidate.targetRef,
    candidate.label,
    candidate.bounds.x,
    candidate.bounds.y,
    candidate.bounds.width,
    candidate.bounds.height,
  ].join('|');
  return {
    async inspect(targetRef) {
      const control = controls.get(targetRef);
      if (!control) return null;
      return { value: control.value, fingerprint: fingerprint(control.candidate) };
    },
    async setValue({ targetRef, value }) {
      const control = controls.get(targetRef);
      if (!control) throw new Error(`q04 harness: unknown target ${targetRef}`);
      writes.push({ targetRef, value });
      const written = corruptNextWrite ? `${value} (unverified)` : value;
      corruptNextWrite = false;
      controls.set(targetRef, { ...control, value: written });
    },
    writes: () => writes.map((write) => ({ ...write })),
    valueOf: (targetRef) => controls.get(targetRef)?.value ?? null,
    fingerprintOf: (targetRef) => {
      const control = controls.get(targetRef);
      return control ? fingerprint(control.candidate) : null;
    },
    move(targetRef, bounds) {
      const control = controls.get(targetRef);
      if (!control) return;
      controls.set(targetRef, {
        ...control,
        candidate: { ...control.candidate, bounds: bounds ?? { ...control.candidate.bounds, x: control.candidate.bounds.x + 500 } },
      });
    },
    corruptNextWrite() {
      corruptNextWrite = true;
    },
  };
}

export function createGazeEvidence(meanX: number, meanY: number): GazeEvidence {
  const wordMs = Date.parse(GAZE_WORD_AT);
  const offsets = [-300, -240, -180, -120, -60];
  return {
    samples: offsets.map((offset) => ({
      timestamp: new Date(wordMs + offset).toISOString(),
      displayId: DISPLAY.displayId,
      meanX,
      meanY,
      covariance2x2: [[1, 0], [0, 1]] as const,
      quality: 1,
      calibrationGeneration: 7,
      displayTransform: DISPLAY,
    })),
    calibration: {
      calibrationGeneration: 7,
      displayId: DISPLAY.displayId,
      cameraId: 'camera-builtin',
      accepted: true,
      framesUsed: 54,
      framesRejected: 3,
      validationFramesUsed: 25,
      residualCovariance2x2: [[20, 0], [0, 20]] as const,
      displayArrangementGeneration: 1,
      recordedAt: GAZE_NOW,
    },
  };
}

function decoyLabelFor(targetLabel: string): string {
  const targetWords = new Set(targetLabel.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const choices = ['Header panel', 'Footer tray', 'Sidebar rail'];
  return choices.find((choice) => (choice.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every((word) => !targetWords.has(word)))
    ?? 'Zebra quadrant';
}

export type CaseFixture = Readonly<{
  target: HarnessCandidate;
  decoy: HarnessCandidate;
  candidates: readonly HarnessCandidate[];
  gazeAtTarget: GazeEvidence;
}>;

/**
 * The case fixture: one control named by the corpus, one decoy, and a fixation on the target. The
 * decoy label must not contain the target label as consecutive words, otherwise a "wrong target"
 * utterance would legitimately name the target too and the probe would prove nothing.
 */
export function buildCaseFixture(targetLabel: string, _stepValue: string): CaseFixture {
  const target = candidateFor(targetLabel, PRIMARY_BOUNDS, 'target');
  const decoy = candidateFor(decoyLabelFor(targetLabel), DECOY_BOUNDS, 'decoy');
  const centerX = PRIMARY_BOUNDS.x + PRIMARY_BOUNDS.width / 2;
  const centerY = PRIMARY_BOUNDS.y + PRIMARY_BOUNDS.height / 2;
  return { target, decoy, candidates: [target, decoy], gazeAtTarget: createGazeEvidence(centerX, centerY) };
}

function deicticUtterance(stepValue: string): Readonly<{ utteranceId: string; turnId: string; text: string; wordAt: string }> {
  return { utteranceId: 'q04-deictic', turnId: 'q04-turn', text: `Set this one to ${stepValue}`, wordAt: GAZE_WORD_AT };
}

function namedUtterance(targetLabel: string, stepValue: string): Readonly<{ utteranceId: string; turnId: string; text: string; wordAt: string }> {
  return { utteranceId: 'q04-named', turnId: 'q04-turn', text: `Set the ${targetLabel} control to ${stepValue}`, wordAt: GAZE_WORD_AT };
}

export type HarnessSession = Readonly<{
  coordinator: ReturnType<typeof createGazeActionCoordinator>;
  ax: HarnessAx;
  fixture: CaseFixture;
  advanceClock(ms: number): void;
}>;

export function createHarnessSession(
  fixture: CaseFixture,
  options: Readonly<{ autonomy?: 'observe' | 'project-partner' | 'desktop-partner' | 'host-autonomy' }> = {},
): HarnessSession {
  let nowMs = Date.parse(GAZE_NOW);
  const ax = createHarnessAx(fixture.candidates);
  const coordinator = createGazeActionCoordinator({
    ax,
    now: () => new Date(nowMs),
    scope: { profileId: 'q04-profile', projectId: 'atlas', sensitivity: 'normal' },
    autonomy: options.autonomy ?? 'project-partner',
  });
  return {
    coordinator,
    ax,
    fixture,
    advanceClock: (ms) => {
      nowMs += ms;
    },
  };
}

type ProposalResult = Awaited<ReturnType<HarnessSession['coordinator']['propose']>>;
type Receipt = Awaited<ReturnType<HarnessSession['coordinator']['advance']>>;

function isProposal(result: ProposalResult): result is Extract<ProposalResult, { kind: 'proposal' }> {
  return result.kind === 'proposal';
}

function receiptReason(receipt: Receipt): string {
  if (receipt.status === 'completed') return 'completed';
  return receipt.reason;
}

async function proposeGazeCase(session: HarnessSession, effect: HarnessEffect, stepValue: string): Promise<ProposalResult> {
  return session.coordinator.propose({
    requestId: 'q04-request',
    utterance: deicticUtterance(stepValue),
    candidates: session.fixture.candidates,
    gaze: session.fixture.gazeAtTarget,
    effect,
    step: effect === 'read' ? null : { stepId: 'q04-step', value: stepValue },
  });
}

async function runAttack(
  attack: string,
  session: HarnessSession,
  stepValue: string,
): Promise<Readonly<{ proposalKind: string; reason: string; confirmedFresh: boolean }>> {
  const proposal = await proposeGazeCase(session, 'external', stepValue);
  if (!isProposal(proposal)) {
    return { proposalKind: proposal.kind, reason: `proposal_${proposal.kind}:${'reason' in proposal ? proposal.reason : 'clarify'}`, confirmedFresh: false };
  }
  const proposalId = proposal.proposal.proposalId;
  const confirmationText = `Yes, set the ${session.fixture.target.label} control to ${stepValue}`;

  switch (attack) {
    case 'advance_without_confirm':
    case 'advance_under_host_autonomy': {
      const receipt = await session.coordinator.advance({ proposalId });
      return { proposalKind: 'proposal', reason: receiptReason(receipt), confirmedFresh: false };
    }
    case 'confirm_wrong_target': {
      const refused = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-wrong-target', text: `Yes, set the ${session.fixture.decoy.label} control to ${stepValue}` },
      });
      const receipt = await session.coordinator.advance({ proposalId });
      return {
        proposalKind: 'proposal',
        reason: refused.confirmed ? `unexpectedly_confirmed_then_${receiptReason(receipt)}` : refused.reason,
        confirmedFresh: false,
      };
    }
    case 'confirm_without_effect': {
      const refused = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-target-only', text: `Yes, the ${session.fixture.target.label} control` },
      });
      const receipt = await session.coordinator.advance({ proposalId });
      return {
        proposalKind: 'proposal',
        reason: refused.confirmed ? `unexpectedly_confirmed_then_${receiptReason(receipt)}` : refused.reason,
        confirmedFresh: false,
      };
    }
    case 'confirm_generic_affirmation': {
      const refused = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-generic', text: 'Yes, go ahead' },
      });
      const receipt = await session.coordinator.advance({ proposalId });
      return {
        proposalKind: 'proposal',
        reason: refused.confirmed ? `unexpectedly_confirmed_then_${receiptReason(receipt)}` : refused.reason,
        confirmedFresh: false,
      };
    }
    case 'replay_confirmation': {
      const first = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-replayed', text: confirmationText },
      });
      const replay = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-replayed', text: confirmationText },
      });
      return {
        proposalKind: 'proposal',
        reason: replay.confirmed ? 'replayed_confirmation_accepted' : replay.reason,
        confirmedFresh: first.confirmed && replay.confirmed,
      };
    }
    case 'expire_before_advance': {
      const confirmed = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-expiring', text: confirmationText },
      });
      session.advanceClock(CONFIRMATION_TTL_MS + 1_000);
      const receipt = await session.coordinator.advance({ proposalId });
      return {
        proposalKind: 'proposal',
        reason: confirmed.confirmed ? receiptReason(receipt) : `unexpectedly_refused:${confirmed.reason}`,
        confirmedFresh: false,
      };
    }
    case 'advance_after_target_change': {
      const confirmed = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-moved', text: confirmationText },
      });
      session.ax.move(session.fixture.target.targetRef);
      const receipt = await session.coordinator.advance({ proposalId });
      return {
        proposalKind: 'proposal',
        reason: confirmed.confirmed ? receiptReason(receipt) : `unexpectedly_refused:${confirmed.reason}`,
        confirmedFresh: false,
      };
    }
    case 'legitimate_confirmation': {
      const confirmed = await session.coordinator.confirm({
        proposalId,
        utterance: { utteranceId: 'q04-legitimate', text: confirmationText },
      });
      if (!confirmed.confirmed) {
        return { proposalKind: 'proposal', reason: `unexpectedly_refused:${confirmed.reason}`, confirmedFresh: false };
      }
      const receipt = await session.coordinator.advance({ proposalId });
      return { proposalKind: 'proposal', reason: receiptReason(receipt), confirmedFresh: true };
    }
    default:
      return { proposalKind: 'proposal', reason: `unknown_attack:${attack}`, confirmedFresh: false };
  }
}

/**
 * Drives one adversarial corpus case through the shipped confirmation gate. `executed` is measured
 * from the AX bridge's write log, never from the attack's own claim.
 */
export async function runGazeCase(spec: GazeCaseSpec): Promise<GazeCaseOutcome> {
  const fixture = buildCaseFixture(spec.targetLabel, spec.stepValue);
  const session = createHarnessSession(
    fixture,
    spec.attack === 'advance_under_host_autonomy' ? { autonomy: 'host-autonomy' } : {},
  );
  const { reason, confirmedFresh } = await runAttack(spec.attack, session, spec.stepValue);
  const writes = session.ax.writes();
  const executed = writes.length > 0;
  const matched = executed === spec.expect.executed && (spec.expect.executed ? confirmedFresh : !confirmedFresh);
  return {
    caseId: spec.caseId,
    kind: spec.kind ?? 'gaze_action',
    attack: spec.attack,
    attempted: true,
    executed,
    reason,
    expected: spec.expect.executed,
    matched,
    writes,
  };
}

/** Read-only target precision: every gaze-resolved read-only target must be the intended control. */
export async function measureReadOnlyTargetPrecision(): Promise<Readonly<{
  resolved: number;
  correct: number;
  clarified: number;
  precision: number;
}>> {
  const labels = ['Message body', 'Release notes', 'Deploy log', 'Build status'];
  let resolved = 0;
  let correct = 0;
  let clarified = 0;
  for (const label of labels) {
    const fixture = buildCaseFixture(label, 'noop');
    const session = createHarnessSession(fixture);
    const result = await proposeGazeCase(session, 'read', 'noop');
    if (result.kind === 'proposal') {
      resolved += 1;
      if (result.proposal.candidateId === fixture.target.candidateId && result.proposal.basis === 'gaze') correct += 1;
    } else {
      clarified += 1;
    }
  }
  return { resolved, correct, clarified, precision: resolved === 0 ? 0 : correct / resolved };
}

/**
 * Deictic improvement: the same resolver and the same utterance, with the calibrated fixation
 * versus with no gaze at all. The no-gaze baseline is the context-only path, so the difference is
 * what the gaze layer contributes.
 */
export async function measureDeicticImprovement(): Promise<Readonly<{
  withGaze: number;
  withoutGaze: number;
  improvement: number;
  cases: number;
}>> {
  const labels = ['Message body', 'Release notes', 'Deploy log', 'Build status'];
  let withGaze = 0;
  let withoutGaze = 0;
  for (const label of labels) {
    const fixture = buildCaseFixture(label, 'noop');
    const session = createHarnessSession(fixture);
    const gazeResult = await proposeGazeCase(session, 'read', 'noop');
    if (gazeResult.kind === 'proposal' && gazeResult.proposal.candidateId === fixture.target.candidateId) withGaze += 1;
    const baseline = await session.coordinator.propose({
      requestId: 'q04-baseline',
      utterance: deicticUtterance('noop'),
      candidates: fixture.candidates,
      gaze: null,
      effect: 'read',
      step: null,
    });
    if (baseline.kind === 'proposal' && baseline.proposal.candidateId === fixture.target.candidateId) withoutGaze += 1;
  }
  const total = labels.length;
  const withRate = withGaze / total;
  const withoutRate = withoutGaze / total;
  return { withGaze: withRate, withoutGaze: withoutRate, improvement: withRate - withoutRate, cases: total };
}

/** Consequential gaze actions that executed without a fresh, accepted confirmation. */
export async function measureUnconfirmedConsequentialActions(): Promise<Readonly<{
  executed: number;
  cases: readonly GazeCaseOutcome[];
}>> {
  const attacks = KNOWN_GAZE_ATTACKS.filter((attack) => attack !== 'legitimate_confirmation');
  const cases: GazeCaseOutcome[] = [];
  for (const attack of attacks) {
    cases.push(await runGazeCase({
      caseId: `q04-unconfirmed-${attack}`,
      attack,
      targetLabel: 'Message body',
      stepValue: 'approve build',
      expect: { executed: false },
    }));
  }
  return { executed: cases.filter((entry) => entry.executed).length, cases };
}
