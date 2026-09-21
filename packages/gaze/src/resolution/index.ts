/**
 * G02 — the deictic reference seam a gaze-derived desktop action is resolved through
 * (IMPLEMENTATION_PLAN.md §7.2 G02; §5.11 gaze estimation and target fusion).
 *
 * The solving stays G01's: `../resolution.ts` owns the whole-label name match, the calibration
 * generation checks, the quality-weighted Gaussian fused over the candidate rectangles inside the
 * deictic window, and the read-only rule (top probability ≥ 0.80 with a ≥ 0.20 margin). This module
 * is the adapter G02 needs on top of that shared resolver, never a second solver:
 *
 * 1. it feeds the shared resolver the caller's candidates — which carry the AX `targetRef` a
 *    proposal must bind — and maps the resolver's ranked candidate identifiers back onto them, so
 *    the resolved target and every clarification option are the caller's own controls;
 * 2. it applies the session's configured confidence threshold to the resolver's outcome: a gaze
 *    answer counts as resolved only when the resolver resolved it *and* the calibrated confidence
 *    is at or above the threshold, so the same fixation resolves read-only at 0.80 and asks at 0.90;
 * 3. a resolution below the configured threshold becomes a clarification over the resolver's
 *    ranked alternatives (at most three, §5.11) — never a guess, and never a write.
 *
 * `utteranceNamesLabel` is exported because the confirmation seam needs the same whole-label rule:
 * a confirmation must name the resolved control, not merely share a word with its label.
 */
import { createReferenceResolver } from '../resolution.js';
import type { CandidateControl, CalibrationRecord, GazeSample } from '../types.js';

/** §5.11: a clarification never offers more than the three strongest candidates. */
const MAXIMUM_CLARIFICATION_OPTIONS = 3;

/** The fallback identity for a caller that resolves without ASR identifiers of its own. */
const ANONYMOUS_UTTERANCE = 'gaze-resolution';

export type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>;

/** A control the caller offers, including the AX target the confirmed action would be bound to. */
export type ResolutionCandidate = CandidateControl & Readonly<{ targetRef: string }>;

export type ResolutionUtterance = Readonly<{
  text: string;
  wordAt: string;
  utteranceId?: string;
  turnId?: string;
}>;

export type GazeEvidence = Readonly<{ samples: readonly GazeSample[]; calibration: CalibrationRecord }>;

export type TargetResolution =
  | Readonly<{
      kind: 'resolved';
      candidate: ResolutionCandidate;
      confidence: number;
      basis: 'named' | 'gaze' | 'context';
      gazeUsed: boolean;
    }>
  | Readonly<{ kind: 'clarify'; candidates: readonly ResolutionCandidate[] }>
  | Readonly<{ kind: 'abstain'; reason: string }>;

function normalizedWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Match a complete label as consecutive words, never as an arbitrary substring. */
export function utteranceNamesLabel(text: string, label: string): boolean {
  const words = normalizedWords(text);
  const labelWords = normalizedWords(label);
  if (labelWords.length === 0 || labelWords.length > words.length) return false;
  return words.some((_word, start) =>
    labelWords.every((labelWord, offset) => words[start + offset] === labelWord));
}

export function resolveTarget(input: Readonly<{
  utterance: ResolutionUtterance;
  candidates: readonly ResolutionCandidate[];
  gaze: GazeEvidence | null;
  confidenceThreshold: number;
}>): TargetResolution {
  const byCandidateId = new Map(
    input.candidates.map((candidate) => [candidate.candidateId, candidate] as const),
  );
  const candidatesFor = (candidateIds: readonly string[]): readonly ResolutionCandidate[] =>
    candidateIds
      .map((candidateId) => byCandidateId.get(candidateId))
      .filter((candidate): candidate is ResolutionCandidate => candidate !== undefined);
  const rankedWith = (target: ResolutionCandidate, ranked: readonly ResolutionCandidate[]) =>
    [target, ...ranked.filter((candidate) => candidate.candidateId !== target.candidateId)];

  const outcome = createReferenceResolver().resolve({
    utteranceId: input.utterance.utteranceId ?? ANONYMOUS_UTTERANCE,
    turnId: input.utterance.turnId ?? input.utterance.utteranceId ?? ANONYMOUS_UTTERANCE,
    phrase: { text: input.utterance.text, wordAt: input.utterance.wordAt },
    candidates: input.candidates,
    gaze: input.gaze,
  });

  if (outcome.outcome === 'abstain') {
    return { kind: 'abstain', reason: outcome.reason ?? 'gaze_unresolved' };
  }

  const ranked = candidatesFor(outcome.candidateIds);
  if (outcome.outcome === 'clarify') {
    if (ranked.length === 0) return { kind: 'abstain', reason: 'no_candidates' };
    return { kind: 'clarify', candidates: ranked.slice(0, MAXIMUM_CLARIFICATION_OPTIONS) };
  }

  const target = byCandidateId.get(outcome.targetId ?? '');
  if (!target) return { kind: 'abstain', reason: 'no_candidates' };
  if (outcome.confidence < input.confidenceThreshold) {
    return {
      kind: 'clarify',
      candidates: rankedWith(target, ranked).slice(0, MAXIMUM_CLARIFICATION_OPTIONS),
    };
  }
  return {
    kind: 'resolved',
    candidate: target,
    confidence: outcome.confidence,
    basis: outcome.basis === 'named' ? 'named' : outcome.basis === 'context' ? 'context' : 'gaze',
    gazeUsed: outcome.gazeUsed,
  };
}
