/**
 * G03 gaze-evaluation acceptance oracle — dedicated device and webcam conditions → one scored,
 * separated quality report (IMPLEMENTATION_PLAN.md §7.2 G03; §5.11 gaze evaluation gates;
 * BACKLOG.json G03 accept 3).
 *
 * `packages/eval/src/gaze/index.ts` must export (this file freezes exactly these names):
 *
 *   G03_PRECISION_GATE = 0.9
 *     §5.11: ≥90% precision among automatically resolved read-only targets.
 *   G03_DEICTIC_IMPROVEMENT_GATE = 0.1
 *     §5.11: ≥10 percentage-point improvement over the same resolver without gaze on the deictic
 *     subset.
 *
 *   runGazeEvaluation({ study, resolve }) → Promise<GazeEvaluationReport>
 *
 *     study — the study exactly as it was recorded:
 *       { studyId, participants: [{ participantId, condition: 'webcam' | 'device',
 *         calibration: { status: 'accepted' } | { status: 'rejected', reason },
 *         references: [{ referenceId, intendedTargetId, deictic, request: ResolveRequest }] }] }
 *       `intendedTargetId` and `deictic` are labels and never reach `resolve`. A
 *       calibration-rejected participant's references carry `gaze: null` because the runtime
 *       produced no calibrated samples for them.
 *
 *     resolve(request) → ResolveOutcome | Promise<ResolveOutcome>
 *       the system under test — the shared G01 resolver in the app. The harness calls it once per
 *       study reference with the request exactly as recorded, and once more with `gaze: null` for
 *       every deictic tracking reference (the same resolver, no gaze). It is never called with an
 *       utterance the study does not contain.
 *
 *     Verdicts (once per reference, never two):
 *       success              tracking reference the resolver resolved to `intendedTargetId`
 *       miss                 tracking reference the resolver resolved to any other target
 *       abstention           tracking reference the resolver did not resolve (clarify or abstain)
 *       calibration_failure  reference of a participant whose calibration was rejected; its
 *                            outcome/basis are reported, but it never enters the tracking counts,
 *                            because §5.11 keeps named/numbered voice targeting alive there.
 *
 *     Report:
 *       { studyId, participantCount, referenceCount,
 *         references: [{ participantId, referenceId, condition, calibration: 'accepted'|'rejected',
 *                        verdict, targetId: string|null, outcome, reason, basis, gazeUsed }],
 *         precision: { trackingReferenceCount, resolvedCount, successCount, missCount, precision,
 *                      withinPrecisionGate },
 *         abstention: { count, rate, byReason },
 *         calibrationFailures: { participantCount, referenceCount, fallbackResolvedCount,
 *                                participants: [{ participantId, reason, referenceCount,
 *                                                 fallbackResolvedCount }] },
 *         deictic: { referenceCount,
 *                    gazeOn: { resolvedCount, correctCount, correctRate },
 *                    gazeOff: { resolvedCount, correctCount, correctRate },
 *                    improvementPercentagePoints, withinGate },
 *         participants: [{ participantId, condition, calibration, referenceCount,
 *                          trackingReferenceCount, calibrationFailureReferenceCount,
 *                          resolvedCount, successCount, missCount, abstentionCount,
 *                          fallbackResolvedCount, precision: number|null, correctRate: number|null,
 *                          withinPrecisionGate: boolean|null }],
 *         participantVariation: { minPrecision, maxPrecision, worstParticipantIds,
 *                                 participantsBelowPrecisionGate },
 *         withinTargets }
 *
 *     Rules the report is read for:
 *       - precision = successCount / resolvedCount over tracking references, and a 0/0 study is
 *         refused rather than scored; abstention.rate = abstention.count / trackingReferenceCount;
 *         the precision denominator never contains abstentions or calibration failures;
 *       - improvementPercentagePoints = (gazeOn.correctRate − gazeOff.correctRate) × 100 over the
 *         deictic tracking references, reported as-is even when it is negative or zero;
 *       - participantVariation holds one row per participant plus min/max precision over
 *         participants that have tracking data and the ids holding the minimum, so a passing mean
 *         with an unusable subset is visible rather than averaged away;
 *       - withinTargets = precision.withinPrecisionGate && deictic.withinGate;
 *       - a study with no participants, or any participant with no references, is a TypeError.
 *
 * Fixtures: 20 participants × 40 references (§5.11 minimum sizes) driven through the real shared
 * resolver. Scene 1 has three equal-semantic read-only targets, so context-only evidence cannot
 * resolve them; scene 2 has one strongly scored target so the gaze-off baseline resolves, which is
 * what makes the improvement gate a real comparison. Real captures on a Tobii Pro Fusion, glasses,
 * lighting, skin tones, posture and multi-display variation stay interactive qualifications and
 * are reported as a remaining limitation — never claimed here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createReferenceResolver } from '../../../gaze/src/resolution.js';
import type {
  CalibrationRecord,
  CandidateControl,
  DisplayTransform,
  GazeEvidence,
  GazeSample,
  ResolveOutcome,
  ResolveRequest,
} from '../../../gaze/src/types.js';

type Condition = 'webcam' | 'device';
type Calibration = Readonly<{ status: 'accepted' }> | Readonly<{ status: 'rejected'; reason: string }>;

type StudyReference = Readonly<{
  referenceId: string;
  intendedTargetId: string;
  deictic: boolean;
  request: ResolveRequest;
}>;

type StudyParticipant = Readonly<{
  participantId: string;
  condition: Condition;
  calibration: Calibration;
  references: readonly StudyReference[];
}>;

type Study = Readonly<{ studyId: string; participants: readonly StudyParticipant[] }>;

type Verdict = 'success' | 'miss' | 'abstention' | 'calibration_failure';

type ReferenceRow = Readonly<{
  participantId: string;
  referenceId: string;
  condition: Condition;
  calibration: 'accepted' | 'rejected';
  verdict: Verdict;
  targetId: string | null;
  outcome: 'resolved' | 'clarify' | 'abstain';
  reason: string;
  basis: 'gaze' | 'named' | 'context' | 'none';
  gazeUsed: boolean;
}>;

type Rate = Readonly<{ resolvedCount: number; correctCount: number; correctRate: number }>;

type ParticipantRow = Readonly<{
  participantId: string;
  condition: Condition;
  calibration: Calibration;
  referenceCount: number;
  trackingReferenceCount: number;
  calibrationFailureReferenceCount: number;
  resolvedCount: number;
  successCount: number;
  missCount: number;
  abstentionCount: number;
  fallbackResolvedCount: number;
  precision: number | null;
  correctRate: number | null;
  withinPrecisionGate: boolean | null;
}>;

type Report = Readonly<{
  studyId: string;
  participantCount: number;
  referenceCount: number;
  references: readonly ReferenceRow[];
  precision: Readonly<{
    trackingReferenceCount: number;
    resolvedCount: number;
    successCount: number;
    missCount: number;
    precision: number;
    withinPrecisionGate: boolean;
  }>;
  abstention: Readonly<{ count: number; rate: number; byReason: Readonly<Record<string, number>> }>;
  calibrationFailures: Readonly<{
    participantCount: number;
    referenceCount: number;
    fallbackResolvedCount: number;
    participants: readonly Readonly<{
      participantId: string;
      reason: string;
      referenceCount: number;
      fallbackResolvedCount: number;
    }>[];
  }>;
  deictic: Readonly<{
    referenceCount: number;
    gazeOn: Rate;
    gazeOff: Rate;
    improvementPercentagePoints: number;
    withinGate: boolean;
  }>;
  participants: readonly ParticipantRow[];
  participantVariation: Readonly<{
    minPrecision: number | null;
    maxPrecision: number | null;
    worstParticipantIds: readonly string[];
    participantsBelowPrecisionGate: readonly string[];
  }>;
  withinTargets: boolean;
}>;

type EvaluationModule = Readonly<{
  G03_PRECISION_GATE: number;
  G03_DEICTIC_IMPROVEMENT_GATE: number;
  runGazeEvaluation(input: Readonly<{
    study: Study;
    resolve: (request: ResolveRequest) => ResolveOutcome | Promise<ResolveOutcome>;
  }>): Promise<Report>;
}>;

const MISSING_BEHAVIOR = 'G03 required gaze-evaluation behavior is not implemented yet: '
  + 'packages/eval/src/gaze/index.ts must export G03_PRECISION_GATE (0.9), '
  + 'G03_DEICTIC_IMPROVEMENT_GATE (0.1) and runGazeEvaluation({ study, resolve }) returning the '
  + 'separated precision / abstention / calibration-failure / participant-variation report.';

/** Until the implementation exists every test fails with the missing behavior, never a crash. */
function missingModule(detail: string): EvaluationModule {
  const fail = (): never => assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
  return {
    G03_PRECISION_GATE: 0.9,
    G03_DEICTIC_IMPROVEMENT_GATE: 0.1,
    async runGazeEvaluation(): Promise<never> {
      return fail();
    },
  };
}

async function loadEvaluationModule(): Promise<EvaluationModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (loaded.G03_PRECISION_GATE !== 0.9) return missingModule('G03_PRECISION_GATE must be 0.9');
  if (loaded.G03_DEICTIC_IMPROVEMENT_GATE !== 0.1) return missingModule('G03_DEICTIC_IMPROVEMENT_GATE must be 0.1');
  if (typeof loaded.runGazeEvaluation !== 'function') return missingModule('runGazeEvaluation is not exported as a function');
  return loaded as unknown as EvaluationModule;
}

const evaluation = await loadEvaluationModule();
const resolver = createReferenceResolver();

/* ------------------------------------------------------------------ the synthetic study ---- */

const DISPLAY: DisplayTransform = Object.freeze({
  displayId: 'display-main',
  originX: 0,
  originY: 0,
  width: 1600,
  height: 1000,
  scale: 2,
  arrangementGeneration: 1,
});

const BOUNDS = Object.freeze({
  publish: { x: 330, y: 238, width: 180, height: 44 },
  discard: { x: 1010, y: 238, width: 180, height: 44 },
  preview: { x: 610, y: 718, width: 180, height: 44 },
});

/** The read-only scene. `equal` scores make context-only evidence unable to resolve anything. */
function scene(scored: 'equal' | 'publish_heavy'): readonly CandidateControl[] {
  const publish = scored === 'publish_heavy' ? 0.95 : 0.5;
  const others = scored === 'publish_heavy' ? 0.025 : 0.5;
  return [
    { candidateId: 'c-publish', label: 'Publish button', bounds: BOUNDS.publish, semanticScore: publish, enabled: true },
    { candidateId: 'c-discard', label: 'Discard button', bounds: BOUNDS.discard, semanticScore: others, enabled: true },
    { candidateId: 'c-preview', label: 'Preview button', bounds: BOUNDS.preview, semanticScore: others, enabled: true },
  ];
}

const DEICTIC_PHRASE = Object.freeze({ text: 'which one is this', wordAt: '2026-09-21T10:00:05.000Z' });
const NAMED_PHRASE = Object.freeze({ text: 'publish button', wordAt: '2026-09-21T10:00:05.000Z' });

function calibration(generation: number): CalibrationRecord {
  return {
    calibrationGeneration: generation,
    displayId: DISPLAY.displayId,
    cameraId: 'camera-builtin',
    accepted: true,
    framesUsed: 45,
    framesRejected: 0,
    validationFramesUsed: 10,
    residualCovariance2x2: [[1.6, 0.1], [0.1, 1.1]],
    displayArrangementGeneration: DISPLAY.arrangementGeneration,
    recordedAt: '2026-09-21T09:59:00.000Z',
  };
}

function sampleAt(x: number, y: number, generation: number): GazeSample {
  return {
    timestamp: '2026-09-21T10:00:04.800Z',
    displayId: DISPLAY.displayId,
    meanX: x,
    meanY: y,
    covariance2x2: [[1.2, 0.05], [0.05, 0.9]],
    quality: 0.95,
    calibrationGeneration: generation,
    displayTransform: DISPLAY,
  };
}

type GazePoint = 'on_intended' | 'on_other' | 'off_targets';

const GAZE_POINTS: Readonly<Record<GazePoint, readonly [number, number]>> = Object.freeze({
  on_intended: [420, 260],
  on_other: [1100, 260],
  off_targets: [60, 960],
});

function evidence(point: GazePoint, generation: number): GazeEvidence {
  const [x, y] = GAZE_POINTS[point];
  return { samples: [sampleAt(x, y, generation)], calibration: calibration(generation) };
}

type ReferenceKind =
  | 'precise'
  | 'misdirected'
  | 'drifted'
  | 'named'
  | 'no_gaze_deictic'
  | 'context_precise'
  | 'context_misdirected';

/**
 * One recorded reference. Every intended target is the published control; the gaze point decides
 * what the shared resolver does with it. `named` resolves by voice with no gaze, `no_gaze_deictic`
 * is the calibration-failed participant's deictic reference, and the `context_*` kinds belong to
 * the scene whose context-only scores already resolve, so the improvement gate has a real baseline.
 */
function studyReference(referenceId: string, kind: ReferenceKind, generation: number): StudyReference {
  const deictic = kind !== 'named';
  const scored = kind === 'context_precise' || kind === 'context_misdirected' ? 'publish_heavy' : 'equal';
  const gazePoint: GazePoint | null = kind === 'named' || kind === 'no_gaze_deictic'
    ? null
    : kind === 'precise' || kind === 'context_precise'
      ? 'on_intended'
      : kind === 'misdirected' || kind === 'context_misdirected'
        ? 'on_other'
        : 'off_targets';
  return {
    referenceId,
    intendedTargetId: 'c-publish',
    deictic,
    request: {
      utteranceId: referenceId,
      turnId: `${referenceId}-turn`,
      phrase: kind === 'named' ? NAMED_PHRASE : DEICTIC_PHRASE,
      candidates: scene(scored),
      gaze: gazePoint === null ? null : evidence(gazePoint, generation),
    },
  };
}

function participant(input: Readonly<{
  participantId: string;
  condition: Condition;
  calibration: Calibration;
  kinds: readonly ReferenceKind[];
  generation: number;
}>): StudyParticipant {
  return {
    participantId: input.participantId,
    condition: input.condition,
    calibration: input.calibration,
    references: input.kinds.map((kind, index) => studyReference(
      `${input.participantId}-r${String(index).padStart(2, '0')}`,
      kind,
      input.generation,
    )),
  };
}

function repeated(kind: ReferenceKind, count: number): readonly ReferenceKind[] {
  return Array.from({ length: count }, () => kind);
}

const ACCEPTED: Calibration = Object.freeze({ status: 'accepted' });
const REJECTED: Calibration = Object.freeze({ status: 'rejected', reason: 'calibration_failed' });

/**
 * 20 participants × 40 references. 13 webcam participants track precisely; `p14-weak` is the
 * unusable subset (12 precise / 16 misdirected / 12 drifted); four device participants track
 * precisely; `p19`/`p20` fail calibration and retain named/numbered voice targeting.
 */
function mainStudy(): Study {
  const participants: StudyParticipant[] = [];
  for (let index = 1; index <= 13; index += 1) {
    participants.push(participant({
      participantId: `p${String(index).padStart(2, '0')}`,
      condition: 'webcam',
      calibration: ACCEPTED,
      kinds: repeated('precise', 40),
      generation: 100 + participants.length,
    }));
  }
  const weakKinds: ReferenceKind[] = [];
  for (let index = 0; index < 40; index += 1) {
    const slot = index % 10;
    weakKinds.push(slot < 3 ? 'precise' : slot < 7 ? 'misdirected' : 'drifted');
  }
  participants.push(participant({
    participantId: 'p14-weak',
    condition: 'webcam',
    calibration: ACCEPTED,
    kinds: weakKinds,
    generation: 100 + participants.length,
  }));
  for (let index = 15; index <= 18; index += 1) {
    participants.push(participant({
      participantId: `p${String(index).padStart(2, '0')}`,
      condition: 'device',
      calibration: ACCEPTED,
      kinds: repeated('precise', 40),
      generation: 100 + participants.length,
    }));
  }
  for (const participantId of ['p19', 'p20']) {
    participants.push(participant({
      participantId,
      condition: 'webcam',
      calibration: REJECTED,
      kinds: [...repeated('named', 20), ...repeated('no_gaze_deictic', 20)],
      generation: 100 + participants.length,
    }));
  }
  return { studyId: 'g03-study-main', participants };
}

/**
 * 20 participants × 40 references on the publish-heavy scene: ten track precisely, ten see their
 * gaze overridden onto the wrong control while the context-only baseline still resolves. The
 * measured improvement is negative on purpose — the report must not clamp it to zero.
 */
function contextStudy(): Study {
  const participants: StudyParticipant[] = [];
  for (let index = 1; index <= 10; index += 1) {
    participants.push(participant({
      participantId: `p${String(index).padStart(2, '0')}`,
      condition: 'device',
      calibration: ACCEPTED,
      kinds: repeated('context_precise', 40),
      generation: 200 + participants.length,
    }));
  }
  for (let index = 11; index <= 20; index += 1) {
    participants.push(participant({
      participantId: `p${String(index).padStart(2, '0')}`,
      condition: 'webcam',
      calibration: ACCEPTED,
      kinds: [...repeated('context_precise', 20), ...repeated('context_misdirected', 20)],
      generation: 200 + participants.length,
    }));
  }
  return { studyId: 'g03-study-context', participants };
}

/* ------------------------------------------------------------------ oracle harness ---- */

type Call = Readonly<{ utteranceId: string; withGaze: boolean }>;

/** The system under test: the real shared resolver, with every call it receives recorded. */
function recordingResolver(calls: Call[]): (request: ResolveRequest) => ResolveOutcome {
  return (request: ResolveRequest): ResolveOutcome => {
    calls.push({ utteranceId: request.utteranceId, withGaze: (request.gaze ?? null) !== null });
    return resolver.resolve(request);
  };
}

function studyReferences(study: Study): readonly StudyReference[] {
  return study.participants.flatMap((entry) => entry.references);
}

function closeTo(actual: number, expected: number, detail: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${detail}: ${actual} vs ${expected}`);
}

test('G03-E1 device and webcam conditions score into one report that separates precision, abstention, calibration failure and participant variation', async () => {
  const study = mainStudy();
  const calls: Call[] = [];
  const report = await evaluation.runGazeEvaluation({ study, resolve: recordingResolver(calls) });

  const references = studyReferences(study);
  assert.equal(report.studyId, study.studyId, 'the report names the study it scored');
  assert.equal(report.participantCount, 20, '§5.11: twenty participants are reported');
  assert.equal(report.referenceCount, 800, '§5.11: forty references per participant are reported');
  assert.equal(references.length, 800, 'the fixture holds the §5.11 minimum study');
  assert.equal(
    new Set(report.references.map((row) => row.referenceId)).size,
    references.length,
    'every reference is scored exactly once',
  );
  assert.deepEqual(
    [...new Set(report.references.map((row) => row.condition))].sort(),
    ['device', 'webcam'],
    'device and webcam conditions stay separated in the report',
  );

  // 520 precise webcam + 12 precise weak + 160 precise device = 692 successes;
  // the weak participant's 16 misdirected references are misses, never abstentions;
  // its 12 off-target references are the only abstentions.
  assert.equal(report.precision.trackingReferenceCount, 720, 'the tracking denominator is the 18 calibrated participants');
  assert.equal(report.precision.successCount, 692, 'successful target resolutions are counted');
  assert.equal(report.precision.missCount, 16, 'resolved-but-wrong targets are counted as misses');
  assert.equal(report.precision.resolvedCount, 708, 'the precision denominator is resolved targets only');
  closeTo(report.precision.precision, 692 / 708, 'precision is success over resolved');
  assert.equal(report.precision.withinPrecisionGate, true, 'the overall precision gate passes');
  assert.equal(evaluation.G03_PRECISION_GATE, 0.9, 'the gate is the §5.11 ≥90% precision');
  assert.equal(
    report.abstention.count,
    12,
    'abstention is reported separately from both success and miss',
  );
  closeTo(report.abstention.rate, 12 / 720, 'the abstention rate uses the tracking denominator');
  assert.deepEqual(report.abstention.byReason, { uninformative_gaze: 12 }, 'abstentions keep their reasons');

  const weakMiss = report.references.find((row) => row.referenceId === 'p14-weak-r03');
  assert.ok(weakMiss, 'the weak participant\'s first misdirected reference is in the report');
  assert.deepEqual(
    { verdict: weakMiss.verdict, targetId: weakMiss.targetId, outcome: weakMiss.outcome, basis: weakMiss.basis },
    { verdict: 'miss', targetId: 'c-discard', outcome: 'resolved', basis: 'gaze' },
    'a wrong resolved target is a miss that still names what was resolved',
  );
  const weakAbstention = report.references.find((row) => row.referenceId === 'p14-weak-r07');
  assert.ok(weakAbstention, 'the weak participant\'s first abstention is in the report');
  assert.deepEqual(
    { verdict: weakAbstention.verdict, targetId: weakAbstention.targetId, reason: weakAbstention.reason },
    { verdict: 'abstention', targetId: null, reason: 'uninformative_gaze' },
    'an unresolved reference abstains with its reason and no guessed target',
  );

  assert.equal(report.calibrationFailures.participantCount, 2, 'the rejected calibrations are counted, not hidden');
  assert.equal(report.calibrationFailures.referenceCount, 80, 'their references are separated from tracking references');
  assert.equal(report.calibrationFailures.fallbackResolvedCount, 40, 'named voice targeting still resolved half of them');
  assert.deepEqual(
    report.calibrationFailures.participants.map((entry) => entry.participantId).sort(),
    ['p19', 'p20'],
    'the report names the participants whose calibration failed',
  );
  for (const entry of report.calibrationFailures.participants) {
    assert.equal(entry.reason, 'calibration_failed', 'the calibration failure keeps its reason');
    assert.equal(entry.referenceCount, 40, 'every reference of a failed participant is accounted for');
    assert.equal(entry.fallbackResolvedCount, 20, 'the retained named fallback is reported');
  }
  const failedParticipant = report.participants.find((row) => row.participantId === 'p19');
  assert.ok(failedParticipant, 'the calibration-failed participant has a row');
  assert.deepEqual(
    {
      trackingReferenceCount: failedParticipant.trackingReferenceCount,
      resolvedCount: failedParticipant.resolvedCount,
      abstentionCount: failedParticipant.abstentionCount,
      fallbackResolvedCount: failedParticipant.fallbackResolvedCount,
      precision: failedParticipant.precision,
    },
    { trackingReferenceCount: 0, resolvedCount: 0, abstentionCount: 0, fallbackResolvedCount: 20, precision: null },
    'a calibration failure never enters the tracking precision counts',
  );
  const namedRow = report.references.find((row) => row.referenceId === 'p19-r00');
  assert.ok(namedRow, 'a named fallback reference is in the report');
  assert.deepEqual(
    { verdict: namedRow.verdict, basis: namedRow.basis, gazeUsed: namedRow.gazeUsed, targetId: namedRow.targetId },
    { verdict: 'calibration_failure', basis: 'named', gazeUsed: false, targetId: 'c-publish' },
    'the voice fallback stays visible under the calibration failure',
  );

  assert.equal(report.participants.length, 20, 'every participant has a row');
  const weak = report.participants.find((row) => row.participantId === 'p14-weak');
  assert.ok(weak, 'the weak participant has a row');
  closeTo(weak.precision ?? Number.NaN, 12 / 28, 'the weak participant\'s own precision is reported');
  assert.equal(weak.withinPrecisionGate, false, 'the weak participant is below the precision gate');
  assert.deepEqual(
    report.participantVariation.worstParticipantIds,
    ['p14-weak'],
    'participant variation names the weakest participant',
  );
  closeTo(report.participantVariation.minPrecision ?? Number.NaN, 12 / 28, 'the minimum participant precision is reported');
  closeTo(report.participantVariation.maxPrecision ?? Number.NaN, 1, 'the maximum participant precision is reported');
  assert.deepEqual(
    report.participantVariation.participantsBelowPrecisionGate,
    ['p14-weak'],
    'a passing mean does not hide the unusable subset',
  );

  assert.equal(report.deictic.referenceCount, 720, 'the deictic subset is the tracking references');
  assert.equal(report.deictic.gazeOn.resolvedCount, 708, 'gaze resolves almost every deictic reference');
  assert.equal(report.deictic.gazeOn.correctCount, 692, 'gaze-on correct resolutions are counted');
  closeTo(report.deictic.gazeOn.correctRate, 692 / 720, 'gaze-on correct rate');
  assert.deepEqual(
    {
      resolvedCount: report.deictic.gazeOff.resolvedCount,
      correctCount: report.deictic.gazeOff.correctCount,
      correctRate: report.deictic.gazeOff.correctRate,
    },
    { resolvedCount: 0, correctCount: 0, correctRate: 0 },
    'the equal-score scene cannot be resolved without gaze, so the baseline is measured, not assumed',
  );
  closeTo(report.deictic.improvementPercentagePoints, 692 / 7.2, 'the improvement is the measured difference');
  assert.equal(report.deictic.withinGate, true, 'gaze improves the deictic subset by more than ten points');
  assert.equal(evaluation.G03_DEICTIC_IMPROVEMENT_GATE, 0.1, 'the gate is the §5.11 ≥10 points');
  assert.equal(report.withinTargets, true, 'the study passes the §5.11 gates it is read against');

  // The harness must drive the real resolver: one gaze call per reference plus one gaze-off
  // baseline call per deictic tracking reference, keyed by the recorded utterance ids.
  const expectedCalls = new Map<string, { withGaze: number; withoutGaze: number }>();
  for (const entry of study.participants) {
    for (const reference of entry.references) {
      const counters = expectedCalls.get(reference.referenceId) ?? { withGaze: 0, withoutGaze: 0 };
      if (reference.request.gaze ?? null) counters.withGaze += 1;
      else counters.withoutGaze += 1;
      if (entry.calibration.status === 'accepted' && reference.deictic) counters.withoutGaze += 1;
      expectedCalls.set(reference.referenceId, counters);
    }
  }
  const actualCalls = new Map<string, { withGaze: number; withoutGaze: number }>();
  for (const call of calls) {
    const counters = actualCalls.get(call.utteranceId) ?? { withGaze: 0, withoutGaze: 0 };
    if (call.withGaze) counters.withGaze += 1;
    else counters.withoutGaze += 1;
    actualCalls.set(call.utteranceId, counters);
  }
  assert.equal(calls.length, 1520, 'the system under test ran 800 references and the 720-reference baseline');
  assert.deepEqual(
    [...actualCalls.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    [...expectedCalls.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    'the resolver is called exactly with the recorded requests and the gaze-off baseline',
  );
});

test('G03-E2 the improvement gate is measured against the same resolver without gaze and a negative result is reported', async () => {
  const study = contextStudy();
  const report = await evaluation.runGazeEvaluation({ study, resolve: recordingResolver([]) });

  assert.equal(report.referenceCount, 800, 'the second study is also the §5.11 size');
  assert.equal(report.precision.trackingReferenceCount, 800, 'every reference is a tracking reference');
  assert.equal(report.precision.successCount, 600, 'gaze agrees with the labels on ten participants');
  assert.equal(report.precision.missCount, 200, 'gaze overrides ten participants onto the wrong target');
  closeTo(report.precision.precision, 0.75, 'precision counts the misses');
  assert.equal(report.precision.withinPrecisionGate, false, 'the precision gate fails on this study');
  assert.equal(report.abstention.count, 0, 'a study with no abstentions reports zero, not an omitted section');
  assert.equal(report.calibrationFailures.participantCount, 0, 'no calibration failures are invented');

  assert.equal(report.deictic.gazeOff.resolvedCount, 800, 'the strong context baseline resolves every reference');
  assert.equal(report.deictic.gazeOff.correctCount, 800, 'the context baseline is correct here');
  closeTo(report.deictic.gazeOff.correctRate, 1, 'the gaze-off correct rate is measured through the resolver');
  closeTo(report.deictic.gazeOn.correctRate, 0.75, 'the gaze-on correct rate is measured through the resolver');
  closeTo(report.deictic.improvementPercentagePoints, -25, 'the negative improvement is reported as-is');
  assert.equal(report.deictic.withinGate, false, 'gaze does not beat the baseline, so the gate fails');
  assert.equal(report.withinTargets, false, 'a failed gate is never reported as a pass');

  const half = report.participants.find((row) => row.participantId === 'p11');
  assert.ok(half, 'a mixed participant has a row');
  closeTo(half.precision ?? Number.NaN, 20 / 40, 'the per-participant miss rate is reported');
  assert.deepEqual(
    report.participantVariation.worstParticipantIds,
    Array.from({ length: 10 }, (_, index) => `p${String(index + 11).padStart(2, '0')}`),
    'every participant holding the minimum is named',
  );
});

test('G03-E3 an empty study is refused instead of reporting a perfect score', async () => {
  const resolve = (request: ResolveRequest): ResolveOutcome => resolver.resolve(request);
  await assert.rejects(
    evaluation.runGazeEvaluation({ study: { studyId: 'g03-empty', participants: [] }, resolve }),
    TypeError,
    'a study with no participants cannot produce a report',
  );
  await assert.rejects(
    evaluation.runGazeEvaluation({
      study: {
        studyId: 'g03-empty-participant',
        participants: [{ participantId: 'p-empty', condition: 'webcam', calibration: ACCEPTED, references: [] }],
      },
      resolve,
    }),
    TypeError,
    'a participant with no references cannot produce a report',
  );
});
