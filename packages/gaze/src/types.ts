/**
 * G01 — the §5.11 gaze vocabulary shared by the webcam runtime, the calibration fit and the
 * reference resolver.
 *
 * Everything below is metadata: timestamps, display transforms, uncertainty, calibration
 * generations. Camera frames (pixels, blobs, data URLs) never appear in any of these types, so a
 * frame cannot leak through the runtime surface, the sample ring or the diagnostic sink even by
 * accident.
 */

/** §5.11: the sample ring keeps ten seconds of calibrated gaze; a delayed ASR word cannot pull in
 * an older glance (the deictic window is narrower than the ring on purpose). */
export const GAZE_SAMPLE_RING_MS = 10_000;

/** §5.11: consecutive unusable frames before the runtime reports tracking loss. */
export const TRACKING_LOSS_FRAMES = 15;

/** §5.11: read-only resolution needs a calibrated top probability ≥ 0.80 … */
export const READ_ONLY_CONFIDENCE = 0.8;

/** … and a margin ≥ 0.20 over the runner-up; below that the outcome asks instead of acting. */
export const READ_ONLY_MARGIN = 0.2;

/** §5.11: the deictic window around the ASR timestamp of the spoken word. */
export const DEICTIC_WINDOW_BEFORE_MS = 700;
export const DEICTIC_WINDOW_AFTER_MS = 200;

/** A display's live arrangement in desktop logical points. Every gaze sample carries the transform
 * it was produced under; a changed `arrangementGeneration` invalidates the calibration for that
 * display (the user moved, mirrored or replaced it). */
export type DisplayTransform = Readonly<{
  displayId: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  scale: number;
  arrangementGeneration: number;
}>;

/** The landmark/quality features a frame carries across the native seam — never a camera frame. */
export type LandmarkFeatures = Readonly<{
  irisX: number;
  irisY: number;
  ear: number;
  faceX: number;
  faceY: number;
  faceScale: number;
  yaw: number;
  pitch: number;
  roll: number;
}>;

/** One landmark observation. `capturedAt` is the only timestamp a sample may be built from. */
export type LandmarkFrame = Readonly<{
  capturedAt: string;
  cameraId: string;
  displayId: string;
  eyesVisible: boolean;
  quality: number;
  features: LandmarkFeatures;
}>;

/** Symmetric 2×2 covariance: the uncertainty of a gaze observation, never a point claim. */
export type Covariance2x2 = readonly [readonly [number, number], readonly [number, number]];

/** §5.11 gaze sample in desktop logical points. */
export type GazeSample = Readonly<{
  timestamp: string;
  displayId: string;
  meanX: number;
  meanY: number;
  covariance2x2: Covariance2x2;
  quality: number;
  calibrationGeneration: number;
  displayTransform: DisplayTransform;
}>;

/** One of the nine 1.2 s calibration targets (or one of the held-out validation targets). */
export type CalibrationPoint = Readonly<{
  targetId: string;
  x: number;
  y: number;
  frames: readonly LandmarkFrame[];
}>;

/** §5.11 calibration record: what was fitted, from how much evidence, and how uncertain it is. */
export type CalibrationRecord = Readonly<{
  calibrationGeneration: number;
  displayId: string;
  cameraId: string;
  accepted: boolean;
  reason?: string;
  framesUsed: number;
  framesRejected: number;
  validationFramesUsed: number;
  residualCovariance2x2: Covariance2x2;
  displayArrangementGeneration: number;
  recordedAt: string;
}>;

/** The runtime's visible state; `status()` re-evaluates it against the live display arrangement. */
export type GazeRuntimeStatus = Readonly<{
  state: 'active' | 'unavailable';
  reason?: string;
  displayId?: string;
  calibrationGeneration?: number;
}>;

/** Diagnostics only. A persisted record may carry sample/calibration/status metadata and nothing
 * that could contain a camera frame. */
export type GazePersistRecord = Readonly<{ kind?: string } & Record<string, unknown>>;
export type GazePersistSink = (record: GazePersistRecord) => void;

/** Camera permission is a value, never a throw: denial is reported through `status()`. */
export type CameraAccess = 'granted' | 'denied';

export type WebcamGazeCamera = Readonly<{
  id: string;
  requestAccess(): Promise<CameraAccess>;
}>;

/** The live display arrangement; an unknown display returns null instead of a guess. */
export type DisplayArrangement = Readonly<{
  current(displayId: string): DisplayTransform | null;
}>;

export type WebcamGazeRuntimeOptions = Readonly<{
  now: () => Date;
  camera: WebcamGazeCamera;
  displays: DisplayArrangement;
  persist?: GazePersistSink;
}>;

export type WebcamGazeRuntime = Readonly<{
  start(displayId: string): Promise<GazeRuntimeStatus>;
  stop(): Promise<void>;
  status(): GazeRuntimeStatus;
  calibrate(input: Readonly<{
    displayId: string;
    points: readonly CalibrationPoint[];
    validationPoints: readonly CalibrationPoint[];
  }>): CalibrationRecord;
  activeCalibration(): CalibrationRecord | null;
  ingest(frame: LandmarkFrame): GazeSample | null;
  samples(): readonly GazeSample[];
}>;

/** A control the reference could resolve to. `semanticScore` is the context-only evidence; bounds
 * are in the same desktop logical points as gaze samples. */
export type CandidateControl = Readonly<{
  candidateId: string;
  label: string;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  semanticScore: number;
  enabled: boolean;
}>;

/** Gaze evidence for one utterance: samples plus the calibration that produced them. */
export type GazeEvidence = Readonly<{
  samples: readonly GazeSample[];
  calibration: CalibrationRecord;
}>;

export type ResolveRequest = Readonly<{
  utteranceId: string;
  turnId: string;
  phrase: Readonly<{ text: string; wordAt: string }>;
  candidates: readonly CandidateControl[];
  /** null is the context-only baseline: same resolver, same candidates, no gaze evidence. */
  gaze?: GazeEvidence | null;
}>;

export type ResolveOutcome = Readonly<{
  utteranceId: string;
  turnId: string;
  outcome: 'resolved' | 'clarify' | 'abstain';
  targetId?: string;
  confidence: number;
  margin: number;
  basis: 'gaze' | 'named' | 'context' | 'none';
  gazeUsed: boolean;
  reason: string;
  candidateIds: readonly string[];
}>;

export type ReferenceResolver = Readonly<{ resolve(request: ResolveRequest): ResolveOutcome }>;

export type ReferenceResolverOptions = Readonly<{ now?: () => Date }>;
