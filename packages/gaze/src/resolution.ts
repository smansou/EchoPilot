/**
 * G01 — the reference resolver: a spoken deictic word plus calibrated gaze becomes a read-only
 * target (IMPLEMENTATION_PLAN.md §5.11).
 *
 * The resolver is one function used twice: with gaze evidence and without it (`gaze: null` is the
 * context-only baseline over the same candidates). Evidence is combined in a fixed order so the
 * outcome is always explainable:
 *
 * 1. a spoken name wins — if the phrase names exactly one enabled control, that is the target and
 *    gaze is not consulted at all, which is what keeps the conversation alive while the camera is
 *    denied or the tracking is invalid;
 * 2. otherwise gaze is admitted only when the calibration is accepted, the samples belong to that
 *    calibration's generation and display arrangement, and they fall inside the deictic window
 *    `[wordAt − 700 ms, wordAt + 200 ms]` — a glance outside the window is not evidence;
 * 3. the windowed samples become one Gaussian (quality-weighted mean, uncertainty from the fit's
 *    residual covariance inflated by frame quality and shrunk by the sample count), and each
 *    candidate's probability is the mass of that Gaussian over its rectangle;
 * 4. read-only resolution requires the top probability ≥ 0.80 and a margin ≥ 0.20 over the
 *    runner-up. Anything less names two or three candidates and asks instead of acting, and a
 *    failed or stale calibration abstains with the reason it failed — never a guessed target.
 */
import { rectangleMass } from './numerics.js';
import {
  DEICTIC_WINDOW_AFTER_MS,
  DEICTIC_WINDOW_BEFORE_MS,
  READ_ONLY_CONFIDENCE,
  READ_ONLY_MARGIN,
} from './types.js';
import type {
  CalibrationRecord,
  CandidateControl,
  Covariance2x2,
  GazeSample,
  ReferenceResolver,
  ReferenceResolverOptions,
  ResolveOutcome,
  ResolveRequest,
} from './types.js';

/** Below this total mass the gaze distribution touches no offered control and is uninformative. */
const MINIMUM_TOTAL_MASS = 1e-9;

/** A clarification never offers more than the three strongest candidates. */
const MAXIMUM_CLARIFICATION_CANDIDATES = 3;

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Lowercased, punctuation-free token stream with single spaces; used for whole-label matching. */
function normalizeText(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** The phrase names this control only when the whole label is spoken, not when it shares a word. */
function namesControl(phraseText: string, label: string): boolean {
  const normalizedLabel = normalizeText(label).trim();
  if (!normalizedLabel) return false;
  return phraseText.includes(` ${normalizedLabel} `);
}

function withinDeicticWindow(timestamp: string, wordAt: string): boolean {
  const capturedAt = Date.parse(timestamp);
  const spokenAt = Date.parse(wordAt);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(spokenAt)) return false;
  return capturedAt >= spokenAt - DEICTIC_WINDOW_BEFORE_MS
    && capturedAt <= spokenAt + DEICTIC_WINDOW_AFTER_MS;
}

function semanticProbabilities(candidates: readonly CandidateControl[]): readonly number[] {
  const total = candidates.reduce((sum, candidate) => sum + Math.max(candidate.semanticScore, 0), 0);
  if (!(total > 0)) return candidates.map(() => 1 / candidates.length);
  return candidates.map((candidate) => Math.max(candidate.semanticScore, 0) / total);
}

type Ranked = Readonly<{ candidate: CandidateControl; probability: number }>;

function rank(candidates: readonly CandidateControl[], probabilities: readonly number[]): readonly Ranked[] {
  return candidates
    .map((candidate, index) => ({ candidate, probability: probabilities[index] ?? 0 }))
    .sort((left, right) => right.probability - left.probability
      || compareIdentifiers(left.candidate.candidateId, right.candidate.candidateId));
}

function rankedIdentifiers(ranked: readonly Ranked[], limit = ranked.length): readonly string[] {
  return ranked.slice(0, limit).map((entry) => entry.candidate.candidateId);
}

type Aggregated = Readonly<{ meanX: number; meanY: number; covariance: Covariance2x2 }>;

/**
 * Robust aggregation of the deictic window into one distribution: the mean is quality-weighted so
 * a marginal frame cannot drag the gaze off the control, the between-sample scatter is divided by
 * the count (more evidence tightens the estimate), and the fit's residual covariance is inflated
 * by the mean inverse quality (marginal frames widen it).
 */
function aggregate(gazeSamples: readonly GazeSample[], calibration: CalibrationRecord): Aggregated {
  const count = gazeSamples.length;
  const weights = gazeSamples.map((sample) => (sample.quality > 0 ? sample.quality : Number.EPSILON));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    meanX += gazeSamples[index]!.meanX * weights[index]!;
    meanY += gazeSamples[index]!.meanY * weights[index]!;
  }
  meanX /= totalWeight;
  meanY /= totalWeight;
  let scatterXx = 0;
  let scatterXy = 0;
  let scatterYy = 0;
  for (let index = 0; index < count; index += 1) {
    const weight = weights[index]!;
    const deltaX = gazeSamples[index]!.meanX - meanX;
    const deltaY = gazeSamples[index]!.meanY - meanY;
    scatterXx += weight * deltaX * deltaX;
    scatterXy += weight * deltaX * deltaY;
    scatterYy += weight * deltaY * deltaY;
  }
  scatterXx /= totalWeight;
  scatterXy /= totalWeight;
  scatterYy /= totalWeight;
  const inflation = weights.reduce((sum, weight) => sum + 1 / weight, 0) / count;
  const [[residualXx, residualXy], [, residualYy]] = calibration.residualCovariance2x2;
  const scaledResidualXx = (residualXx * inflation) / count;
  const scaledResidualXy = (residualXy * inflation) / count;
  const scaledResidualYy = (residualYy * inflation) / count;
  return {
    meanX,
    meanY,
    covariance: [
      [scaledResidualXx + scatterXx / count, scaledResidualXy + scatterXy / count],
      [scaledResidualXy + scatterXy / count, scaledResidualYy + scatterYy / count],
    ],
  };
}

export function createReferenceResolver(options: ReferenceResolverOptions = {}): ReferenceResolver {
  // `options.now` is the clock a caller shares with the runtime; resolution itself is timestamp
  // free — it reads the ASR `wordAt` and the sample timestamps it is handed, never the wall clock.
  void options;
  const resolve = (request: ResolveRequest): ResolveOutcome => {
    const { utteranceId, turnId, phrase, candidates } = request;
    const enabled = candidates.filter((candidate) => candidate.enabled);
    const pool = enabled.length > 0 ? enabled : candidates;
    const contextRank = rank(pool, semanticProbabilities(pool));
    const contextConfidence = contextRank[0]?.probability ?? 0;
    const contextMargin = contextConfidence - (contextRank[1]?.probability ?? 0);
    const fallbackCandidateIds = rankedIdentifiers(contextRank);

    const abstain = (reason: string): ResolveOutcome => ({
      utteranceId,
      turnId,
      outcome: 'abstain',
      confidence: contextConfidence,
      margin: contextMargin,
      basis: 'none',
      gazeUsed: false,
      reason,
      candidateIds: fallbackCandidateIds,
    });

    if (pool.length === 0) return abstain('no_candidates');

    // 1. A spoken name is the strongest evidence and never needs the camera.
    const phraseText = normalizeText(phrase.text);
    const named = pool.filter((candidate) => namesControl(phraseText, candidate.label));
    if (named.length === 1) {
      const target = named[0]!;
      const rest = contextRank.filter((entry) => entry.candidate.candidateId !== target.candidateId);
      return {
        utteranceId,
        turnId,
        outcome: 'resolved',
        targetId: target.candidateId,
        confidence: 1,
        margin: 1,
        basis: 'named',
        gazeUsed: false,
        reason: 'named_target',
        candidateIds: [target.candidateId, ...rankedIdentifiers(rest)],
      };
    }
    if (named.length > 1) {
      const clarifying = rank(named, named.map(() => 1));
      return {
        utteranceId,
        turnId,
        outcome: 'clarify',
        confidence: 1 / named.length,
        margin: 0,
        basis: 'named',
        gazeUsed: false,
        reason: 'ambiguous_name',
        candidateIds: rankedIdentifiers(clarifying, MAXIMUM_CLARIFICATION_CANDIDATES),
      };
    }

    // 2. Gaze evidence, admitted only when it belongs to this calibration and this window.
    const gaze = request.gaze ?? null;
    const calibration: CalibrationRecord | null = gaze?.calibration ?? null;
    if (gaze && calibration) {
      if (!calibration.accepted) return abstain('calibration_failed');
      const onDisplay = gaze.samples.filter((sample) => sample.displayId === calibration.displayId);
      const retired = onDisplay.some((sample) => sample.calibrationGeneration !== calibration.calibrationGeneration
        || sample.displayTransform.arrangementGeneration !== calibration.displayArrangementGeneration);
      if (retired) return abstain('calibration_stale');
      const windowed = onDisplay.filter((sample) => withinDeicticWindow(sample.timestamp, phrase.wordAt));
      if (windowed.length > 0) {
        const aggregated = aggregate(windowed, calibration);
        const masses = pool.map((candidate) => rectangleMass(
          [aggregated.meanX, aggregated.meanY],
          aggregated.covariance,
          candidate.bounds,
        ));
        const totalMass = masses.reduce((sum, mass) => sum + mass, 0);
        if (totalMass > MINIMUM_TOTAL_MASS) {
          const ranked = rank(pool, masses.map((mass) => mass / totalMass));
          const top = ranked[0]!;
          const confidence = top.probability;
          const margin = confidence - (ranked[1]?.probability ?? 0);
          if (confidence >= READ_ONLY_CONFIDENCE && margin >= READ_ONLY_MARGIN) {
            return {
              utteranceId,
              turnId,
              outcome: 'resolved',
              targetId: top.candidate.candidateId,
              confidence,
              margin,
              basis: 'gaze',
              gazeUsed: true,
              reason: 'gaze_read_only_target',
              candidateIds: rankedIdentifiers(ranked),
            };
          }
          return {
            utteranceId,
            turnId,
            outcome: 'clarify',
            confidence,
            margin,
            basis: 'gaze',
            gazeUsed: true,
            reason: 'below_read_only_threshold',
            candidateIds: rankedIdentifiers(ranked, MAXIMUM_CLARIFICATION_CANDIDATES),
          };
        }
        return {
          utteranceId,
          turnId,
          outcome: 'clarify',
          confidence: 0,
          margin: 0,
          basis: 'gaze',
          gazeUsed: false,
          reason: 'uninformative_gaze',
          candidateIds: fallbackCandidateIds.slice(0, MAXIMUM_CLARIFICATION_CANDIDATES),
        };
      }
      return abstain('no_gaze_in_window');
    }

    // 3. Context only: the same resolver, the same candidates, no gaze evidence.
    if (contextConfidence >= READ_ONLY_CONFIDENCE && contextMargin >= READ_ONLY_MARGIN) {
      return {
        utteranceId,
        turnId,
        outcome: 'resolved',
        targetId: contextRank[0]!.candidate.candidateId,
        confidence: contextConfidence,
        margin: contextMargin,
        basis: 'context',
        gazeUsed: false,
        reason: 'context_read_only_target',
        candidateIds: fallbackCandidateIds,
      };
    }
    return {
      utteranceId,
      turnId,
      outcome: 'clarify',
      confidence: contextConfidence,
      margin: contextMargin,
      basis: 'context',
      gazeUsed: false,
      reason: 'ambiguous_context',
      candidateIds: fallbackCandidateIds.slice(0, MAXIMUM_CLARIFICATION_CANDIDATES),
    };
  };
  return { resolve };
}
