/**
 * G03 — gaze evaluation: dedicated device and webcam conditions score into one separated quality
 * report (IMPLEMENTATION_PLAN.md §7.2 G03; §5.11 gaze evaluation gates; BACKLOG.json G03 accept 3).
 *
 * The harness drives the real system under test: it calls the injected resolver once per recorded
 * study reference with the request exactly as it was recorded, and once more with `gaze: null` for
 * every deictic tracking reference — the same resolver without gaze, so the deictic improvement is
 * measured instead of assumed.
 *
 * Verdicts are assigned once per reference, never twice:
 *
 *   success              a tracking reference the resolver resolved to the intended target
 *   miss                 a tracking reference the resolver resolved to another target
 *   abstention           a tracking reference the resolver did not resolve (clarify or abstain)
 *   calibration_failure  a reference of a participant whose calibration was rejected; its
 *                        outcome/basis are reported, but it never enters the tracking counts,
 *                        because §5.11 keeps named/numbered voice targeting alive there
 *
 * The report keeps the four failure modes apart — precision (success over automatically resolved
 * tracking references), abstention, calibration failures and per-participant variation — so a
 * passing mean cannot hide an unusable subset. A study with no participants, or a participant with
 * no references, is refused with a TypeError rather than scored as perfect.
 */
import type { ResolveOutcome, ResolveRequest } from '../../../gaze/src/types.js';

/** §5.11: ≥90% precision among automatically resolved read-only targets. */
export const G03_PRECISION_GATE = 0.9;

/** §5.11: ≥10 percentage points of deictic improvement over the same resolver without gaze. */
export const G03_DEICTIC_IMPROVEMENT_GATE = 0.1;

export type GazeEvaluationCondition = 'webcam' | 'device';

export type GazeEvaluationCalibration =
  | Readonly<{ status: 'accepted' }>
  | Readonly<{ status: 'rejected'; reason: string }>;

export type GazeEvaluationReference = Readonly<{
  referenceId: string;
  intendedTargetId: string;
  deictic: boolean;
  request: ResolveRequest;
}>;

export type GazeEvaluationParticipant = Readonly<{
  participantId: string;
  condition: GazeEvaluationCondition;
  calibration: GazeEvaluationCalibration;
  references: readonly GazeEvaluationReference[];
}>;

export type GazeEvaluationStudy = Readonly<{
  studyId: string;
  participants: readonly GazeEvaluationParticipant[];
}>;

export type GazeEvaluationVerdict = 'success' | 'miss' | 'abstention' | 'calibration_failure';

export type GazeEvaluationReferenceRow = Readonly<{
  participantId: string;
  referenceId: string;
  condition: GazeEvaluationCondition;
  calibration: 'accepted' | 'rejected';
  verdict: GazeEvaluationVerdict;
  targetId: string | null;
  outcome: ResolveOutcome['outcome'];
  reason: string;
  basis: ResolveOutcome['basis'];
  gazeUsed: boolean;
}>;

export type GazeEvaluationRate = Readonly<{
  resolvedCount: number;
  correctCount: number;
  correctRate: number;
}>;

export type GazeEvaluationParticipantRow = Readonly<{
  participantId: string;
  condition: GazeEvaluationCondition;
  calibration: GazeEvaluationCalibration;
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

export type GazeEvaluationReport = Readonly<{
  studyId: string;
  participantCount: number;
  referenceCount: number;
  references: readonly GazeEvaluationReferenceRow[];
  precision: Readonly<{
    trackingReferenceCount: number;
    resolvedCount: number;
    successCount: number;
    missCount: number;
    precision: number;
    withinPrecisionGate: boolean;
  }>;
  abstention: Readonly<{
    count: number;
    rate: number;
    byReason: Readonly<Record<string, number>>;
  }>;
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
    gazeOn: GazeEvaluationRate;
    gazeOff: GazeEvaluationRate;
    improvementPercentagePoints: number;
    withinGate: boolean;
  }>;
  participants: readonly GazeEvaluationParticipantRow[];
  participantVariation: Readonly<{
    minPrecision: number | null;
    maxPrecision: number | null;
    worstParticipantIds: readonly string[];
    participantsBelowPrecisionGate: readonly string[];
  }>;
  withinTargets: boolean;
}>;

type Counters = {
  tracking: number;
  resolved: number;
  success: number;
  miss: number;
  abstention: number;
  fallback: number;
};

function emptyCounters(): Counters {
  return { tracking: 0, resolved: 0, success: 0, miss: 0, abstention: 0, fallback: 0 };
}

export async function runGazeEvaluation(input: Readonly<{
  study: GazeEvaluationStudy;
  resolve: (request: ResolveRequest) => ResolveOutcome | Promise<ResolveOutcome>;
}>): Promise<GazeEvaluationReport> {
  const { study, resolve } = input;
  if (!study || !Array.isArray(study.participants) || study.participants.length === 0) {
    throw new TypeError('runGazeEvaluation refused an empty study: at least one participant is required');
  }
  for (const participant of study.participants) {
    if (!Array.isArray(participant.references) || participant.references.length === 0) {
      throw new TypeError(
        `runGazeEvaluation refused participant ${participant.participantId}: every participant needs references`,
      );
    }
  }

  const references: GazeEvaluationReferenceRow[] = [];
  const participants: GazeEvaluationParticipantRow[] = [];
  const calibrationFailureRows: Array<Readonly<{
    participantId: string;
    reason: string;
    referenceCount: number;
    fallbackResolvedCount: number;
  }>> = [];
  const abstentionReasons = new Map<string, number>();

  let trackingReferenceCount = 0;
  let resolvedCount = 0;
  let successCount = 0;
  let missCount = 0;
  let abstentionCount = 0;
  let calibrationFailureParticipantCount = 0;
  let calibrationFailureReferenceCount = 0;
  let calibrationFailureFallbackResolvedCount = 0;
  let deicticReferenceCount = 0;
  let gazeOnResolvedCount = 0;
  let gazeOnCorrectCount = 0;
  let gazeOffResolvedCount = 0;
  let gazeOffCorrectCount = 0;

  for (const participant of study.participants) {
    const rejected = participant.calibration.status === 'rejected';
    const rejectionReason = participant.calibration.status === 'rejected' ? participant.calibration.reason : '';
    const counters = emptyCounters();

    for (const reference of participant.references) {
      const outcome = await resolve(reference.request);
      const resolved = outcome.outcome === 'resolved';
      const targetId = resolved ? outcome.targetId ?? null : null;

      if (rejected) {
        if (resolved) counters.fallback += 1;
        references.push({
          participantId: participant.participantId,
          referenceId: reference.referenceId,
          condition: participant.condition,
          calibration: 'rejected',
          verdict: 'calibration_failure',
          targetId,
          outcome: outcome.outcome,
          reason: outcome.reason,
          basis: outcome.basis,
          gazeUsed: outcome.gazeUsed,
        });
        continue;
      }

      counters.tracking += 1;
      let verdict: GazeEvaluationVerdict;
      if (resolved) {
        counters.resolved += 1;
        if (targetId === reference.intendedTargetId) {
          counters.success += 1;
          verdict = 'success';
        } else {
          counters.miss += 1;
          verdict = 'miss';
        }
      } else {
        counters.abstention += 1;
        verdict = 'abstention';
        abstentionReasons.set(outcome.reason, (abstentionReasons.get(outcome.reason) ?? 0) + 1);
      }
      references.push({
        participantId: participant.participantId,
        referenceId: reference.referenceId,
        condition: participant.condition,
        calibration: 'accepted',
        verdict,
        targetId,
        outcome: outcome.outcome,
        reason: outcome.reason,
        basis: outcome.basis,
        gazeUsed: outcome.gazeUsed,
      });

      if (reference.deictic) {
        deicticReferenceCount += 1;
        if (resolved) gazeOnResolvedCount += 1;
        if (resolved && targetId === reference.intendedTargetId) gazeOnCorrectCount += 1;
        // The baseline is the same resolver, the same recorded request, no gaze evidence.
        const baseline = await resolve({ ...reference.request, gaze: null });
        if (baseline.outcome === 'resolved') {
          gazeOffResolvedCount += 1;
          if ((baseline.targetId ?? null) === reference.intendedTargetId) gazeOffCorrectCount += 1;
        }
      }
    }

    trackingReferenceCount += counters.tracking;
    resolvedCount += counters.resolved;
    successCount += counters.success;
    missCount += counters.miss;
    abstentionCount += counters.abstention;

    if (rejected) {
      calibrationFailureParticipantCount += 1;
      calibrationFailureReferenceCount += participant.references.length;
      calibrationFailureFallbackResolvedCount += counters.fallback;
      calibrationFailureRows.push({
        participantId: participant.participantId,
        reason: rejectionReason,
        referenceCount: participant.references.length,
        fallbackResolvedCount: counters.fallback,
      });
    }

    const precision = counters.tracking > 0
      ? counters.resolved > 0
        ? counters.success / counters.resolved
        : 0
      : null;
    participants.push({
      participantId: participant.participantId,
      condition: participant.condition,
      calibration: participant.calibration,
      referenceCount: participant.references.length,
      trackingReferenceCount: counters.tracking,
      calibrationFailureReferenceCount: rejected ? participant.references.length : 0,
      resolvedCount: counters.resolved,
      successCount: counters.success,
      missCount: counters.miss,
      abstentionCount: counters.abstention,
      fallbackResolvedCount: counters.fallback,
      precision,
      correctRate: counters.tracking > 0 ? counters.success / counters.tracking : null,
      withinPrecisionGate: precision === null ? null : precision >= G03_PRECISION_GATE,
    });
  }

  const precisionValue = resolvedCount > 0 ? successCount / resolvedCount : 0;
  const precisionWithinGate = resolvedCount > 0 && precisionValue >= G03_PRECISION_GATE;
  const gazeOnCorrectRate = deicticReferenceCount > 0 ? gazeOnCorrectCount / deicticReferenceCount : 0;
  const gazeOffCorrectRate = deicticReferenceCount > 0 ? gazeOffCorrectCount / deicticReferenceCount : 0;
  const improvementPercentagePoints = (gazeOnCorrectRate - gazeOffCorrectRate) * 100;
  const deicticWithinGate = deicticReferenceCount > 0
    && improvementPercentagePoints >= G03_DEICTIC_IMPROVEMENT_GATE * 100;

  const participantPrecisions = participants.flatMap((row) => (row.precision === null ? [] : [row.precision]));
  const minPrecision = participantPrecisions.length > 0 ? Math.min(...participantPrecisions) : null;
  const maxPrecision = participantPrecisions.length > 0 ? Math.max(...participantPrecisions) : null;

  return {
    studyId: study.studyId,
    participantCount: study.participants.length,
    referenceCount: references.length,
    references,
    precision: {
      trackingReferenceCount,
      resolvedCount,
      successCount,
      missCount,
      precision: precisionValue,
      withinPrecisionGate: precisionWithinGate,
    },
    abstention: {
      count: abstentionCount,
      rate: trackingReferenceCount > 0 ? abstentionCount / trackingReferenceCount : 0,
      byReason: Object.fromEntries([...abstentionReasons.entries()].sort(([left], [right]) => (left < right ? -1 : 1))),
    },
    calibrationFailures: {
      participantCount: calibrationFailureParticipantCount,
      referenceCount: calibrationFailureReferenceCount,
      fallbackResolvedCount: calibrationFailureFallbackResolvedCount,
      participants: calibrationFailureRows,
    },
    deictic: {
      referenceCount: deicticReferenceCount,
      gazeOn: {
        resolvedCount: gazeOnResolvedCount,
        correctCount: gazeOnCorrectCount,
        correctRate: gazeOnCorrectRate,
      },
      gazeOff: {
        resolvedCount: gazeOffResolvedCount,
        correctCount: gazeOffCorrectCount,
        correctRate: gazeOffCorrectRate,
      },
      improvementPercentagePoints,
      withinGate: deicticWithinGate,
    },
    participants,
    participantVariation: {
      minPrecision,
      maxPrecision,
      worstParticipantIds: minPrecision === null
        ? []
        : participants.filter((row) => row.precision === minPrecision).map((row) => row.participantId),
      participantsBelowPrecisionGate: participants
        .filter((row) => row.precision !== null && row.precision < G03_PRECISION_GATE)
        .map((row) => row.participantId),
    },
    withinTargets: precisionWithinGate && deicticWithinGate,
  };
}
