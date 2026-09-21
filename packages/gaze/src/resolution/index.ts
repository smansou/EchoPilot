export type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>;

export type ResolutionCandidate = Readonly<{
  candidateId: string;
  targetRef: string;
  label: string;
  bounds: Bounds;
  semanticScore: number;
  enabled: boolean;
}>;

export type ResolutionUtterance = Readonly<{ text: string; wordAt: string }>;

export type Calibration = Readonly<{
  accepted: boolean;
  reason?: string;
  calibrationGeneration: number;
  displayId: string;
  displayArrangementGeneration: number;
}>;

export type GazeSample = Readonly<{
  timestamp: string;
  displayId: string;
  meanX: number;
  meanY: number;
  quality: number;
  calibrationGeneration: number;
  displayTransform: Readonly<{ arrangementGeneration: number }>;
}>;

export type GazeEvidence = Readonly<{
  samples: readonly GazeSample[];
  calibration: Calibration;
}>;

export type TargetResolution =
  | Readonly<{ kind: 'resolved'; candidate: ResolutionCandidate; confidence: number; basis: 'named' | 'gaze'; gazeUsed: boolean }>
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

function center(bounds: Bounds): Readonly<{ x: number; y: number }> {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distanceSquared(x: number, y: number, bounds: Bounds): number {
  const target = center(bounds);
  return (x - target.x) ** 2 + (y - target.y) ** 2;
}

export function resolveTarget(input: Readonly<{
  utterance: ResolutionUtterance;
  candidates: readonly ResolutionCandidate[];
  gaze: GazeEvidence | null;
  confidenceThreshold: number;
}>): TargetResolution {
  const candidates = input.candidates.filter((candidate) => candidate.enabled);
  const named = candidates.filter((candidate) => utteranceNamesLabel(input.utterance.text, candidate.label));
  if (named.length === 1) {
    return { kind: 'resolved', candidate: named[0], confidence: 1, basis: 'named', gazeUsed: false };
  }

  if (!input.gaze) return { kind: 'clarify', candidates: candidates.slice(0, 3) };
  const { calibration } = input.gaze;
  if (!calibration.accepted) {
    return { kind: 'abstain', reason: calibration.reason ?? 'calibration_failed' };
  }

  const wordAt = Date.parse(input.utterance.wordAt);
  const samples = input.gaze.samples.filter((sample) => {
    const timestamp = Date.parse(sample.timestamp);
    return Number.isFinite(timestamp)
      && timestamp >= wordAt - 700
      && timestamp <= wordAt + 200
      && sample.quality > 0
      && sample.displayId === calibration.displayId
      && sample.calibrationGeneration === calibration.calibrationGeneration
      && sample.displayTransform.arrangementGeneration === calibration.displayArrangementGeneration;
  });
  if (samples.length === 0) return { kind: 'abstain', reason: 'gaze_unavailable' };
  if (candidates.length === 0) return { kind: 'abstain', reason: 'no_candidates' };

  const weight = samples.reduce((total, sample) => total + sample.quality, 0);
  const x = samples.reduce((total, sample) => total + sample.meanX * sample.quality, 0) / weight;
  const y = samples.reduce((total, sample) => total + sample.meanY * sample.quality, 0) / weight;
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: distanceSquared(x, y, candidate.bounds) }))
    .sort((left, right) => left.distance - right.distance);

  const first = ranked[0];
  const second = ranked[1];
  // A normalized nearest-target margin. The small smoothing term keeps confidence finite at a
  // target centre while preserving an exact 0.5 tie at a shared boundary.
  const firstDistance = Math.sqrt(first.distance);
  const secondDistance = second ? Math.sqrt(second.distance) : Number.POSITIVE_INFINITY;
  const gap = secondDistance - firstDistance;
  const confidence = second
    ? 0.5 + 0.5 * Math.max(0, gap) / (Math.max(0, gap) + 2)
    : 1;

  if (confidence < input.confidenceThreshold || confidence - (1 - confidence) < 0.2) {
    return { kind: 'clarify', candidates: ranked.slice(0, 3).map((entry) => entry.candidate) };
  }
  return { kind: 'resolved', candidate: first.candidate, confidence, basis: 'gaze', gazeUsed: true };
}
