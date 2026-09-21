/**
 * G01 acceptance oracle — webcam calibration → gaze distribution → resolve a spoken read-only
 * reference (IMPLEMENTATION_PLAN.md §5.11; BACKLOG.json G01; the frozen oracle is this file, the
 * session is `fixtures/gaze/g01-webcam-session.json`).
 *
 * `packages/gaze/src/index.ts` must export (this file freezes exactly these names):
 *
 *   createWebcamGazeRuntime({ now, camera, displays, persist? }) → WebcamGazeRuntime
 *
 *     now() — the only clock; every sample/record timestamp must come from it (never Date.now()).
 *     camera — { id, requestAccess(): Promise<'granted' | 'denied'> }. Denial is a value, not a
 *       throw: start() resolves with state 'unavailable' and reason 'camera_denied'.
 *     displays.current(displayId) → DisplayTransform | null — the live display arrangement.
 *       Every sample carries the transform it was produced under. A changed
 *       `arrangementGeneration` (or no calibration for that display) makes gaze unknown:
 *       ingest() returns null and a later resolution abstains instead of using stale evidence.
 *     persist?(record) — optional diagnostic sink. If the runtime persists anything at all it
 *       must be sample/calibration/status metadata; camera frames (or any pixel/blob payload)
 *       may never reach it. This oracle probes that with a canary payload attached to the
 *       landmark frames.
 *
 *     start(displayId) → Promise<GazeRuntimeStatus>  ({ state: 'active' | 'unavailable',
 *       reason: 'not_started' | 'stopped' | 'camera_denied' | 'tracking_lost' |
 *       'calibration_stale' | 'camera_unavailable', displayId?, calibrationGeneration? })
 *       Never rejects. After TRACKING_LOSS_FRAMES consecutive frames with eyesVisible === false
 *       or a rejected quality, the state becomes 'unavailable' with reason 'tracking_lost';
 *       voice/named targeting is unaffected because gaze is optional evidence.
 *     stop() → Promise<void>
 *     status() → GazeRuntimeStatus
 *       Evaluated against the live display arrangement: once a calibrated display's
 *       arrangementGeneration changes, status() itself reports 'calibration_stale' (the session
 *       checks status before it starts a turn), without waiting for another frame.
 *     calibrate({ displayId, points, validationPoints }) → CalibrationRecord
 *       points: nine 1.2 s screen targets; validationPoints: five held-out targets used for the
 *       residual covariance. Every input frame is counted exactly once in framesUsed or
 *       framesRejected; blink/occlusion frames (eyesVisible === false) and low-quality frames are
 *       rejected, never fitted. A fit that cannot be trusted returns accepted: false with reason
 *       'calibration_failed'.
 *       CalibrationRecord: { calibrationGeneration, displayId, cameraId, accepted, reason?,
 *         framesUsed, framesRejected, validationFramesUsed, residualCovariance2x2,
 *         displayArrangementGeneration, recordedAt }.
 *     activeCalibration() → CalibrationRecord | null
 *     ingest(frame) → GazeSample | null
 *       Landmarks and quality features only — the TS side never receives camera frames. Returns
 *       null for rejected frames (blink/occlusion, low quality, unknown or stale display).
 *       GazeSample is exactly the §5.11 shape:
 *         { timestamp, displayId, meanX, meanY, covariance2x2, quality, calibrationGeneration,
 *           displayTransform }
 *       in desktop logical points; timestamp equals the frame's capturedAt; covariance2x2 is the
 *       uncertainty (symmetric, positive definite).
 *     samples() → readonly GazeSample[]
 *       The bounded ten-second ring (GAZE_SAMPLE_RING_MS); older samples are evicted, including
 *       after a clock jump, and no frame data is retained anywhere.
 *
 *   createReferenceResolver({ now? }) → ReferenceResolver
 *
 *     resolve({ utteranceId, turnId, phrase, candidates, gaze }) → ResolveOutcome
 *       phrase: { text, wordAt } — the ASR timestamp of the deictic word. Gaze evidence is the
 *       fixation inside [wordAt-700 ms, wordAt+200 ms] (§5.11), robustly aggregated; a glance
 *       outside that window must not change the resolution.
 *       candidates: { candidateId, label, bounds, semanticScore, enabled } in the same logical
 *       points as gaze samples.
 *       gaze: { samples, calibration } | null — null is the context-only baseline (the same
 *       resolver, same candidates, no gaze evidence).
 *       ResolveOutcome: { utteranceId, turnId, outcome: 'resolved' | 'clarify' | 'abstain',
 *         targetId?, confidence, margin, basis: 'gaze' | 'named' | 'context' | 'none',
 *         gazeUsed, reason, candidateIds }.
 *       Read-only resolution requires top probability ≥ READ_ONLY_CONFIDENCE (0.80) and a margin
 *       ≥ READ_ONLY_MARGIN (0.20) over the runner-up — otherwise the outcome names two or three
 *       candidates and asks (Product clarification). It never resolves a wrong target confidently.
 *       Gaze never overrides a named target: when the phrase names exactly one candidate the
 *       resolution succeeds by voice with basis 'named' and gazeUsed false, including while the
 *       camera is denied or the tracking is invalid. A failed calibration (accepted: false) or a
 *       stale calibration generation is never used: reason 'calibration_failed' /
 *       'calibration_stale' and no target.
 *
 * Frozen fixture: `fixtures/gaze/g01-webcam-session.json` — a fully synthetic session (nine
 * calibration targets with blink frames, five held-out validation targets, five held-out deictic
 * references with one distractor glance before the spoken word, a named-target turn, a 15-frame
 * tracking-loss burst, an uncalibrated second display, and ring-probe frames). Nothing here
 * touches real time, real hardware, or a real camera.
 *
 * Remaining limitation this oracle reports instead of claiming: AVFoundation capture, the
 * MediaPipe landmark worker, camera permission dialogs and the 20-participant §5.11
 * qualification are interactive/hardware evidence and stay with their own tickets. This oracle
 * proves the calibration, sample schema, uncertainty, generation, retention, resolution,
 * baseline-improvement, abstention and voice-fallback contract deterministically.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FIXTURE_URL = new URL('../../../fixtures/gaze/g01-webcam-session.json', import.meta.url);

/** §5.11: bounded ten-second gaze ring; a delayed ASR word cannot pull in an older glance. */
const GAZE_SAMPLE_RING_MS = 10_000;
/** Consecutive unusable frames before the runtime reports tracking_lost. */
const TRACKING_LOSS_FRAMES = 15;
/** §5.11: read-only resolution needs calibrated top probability ≥ 0.80 and a ≥ 0.20 margin. */
const READ_ONLY_CONFIDENCE = 0.8;
const READ_ONLY_MARGIN = 0.2;
/** §5.11 deictic alignment window around the ASR word timestamp. */
const DEICTIC_WINDOW_BEFORE_MS = 700;
const DEICTIC_WINDOW_AFTER_MS = 200;
const CANARY_FRAME_BYTES = 'CANARY-RAW-FRAME-BYTES-G01';
const CANARY_FRAME_DATA_URL = 'data:image/jpeg;base64,CANARY-G01';

type DisplayTransform = Readonly<{
  displayId: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  scale: number;
  arrangementGeneration: number;
}>;

type LandmarkFeatures = Readonly<{
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

type LandmarkFrame = Readonly<{
  capturedAt: string;
  cameraId: string;
  displayId: string;
  eyesVisible: boolean;
  quality: number;
  features: LandmarkFeatures;
}>;

type GazeSample = Readonly<{
  timestamp: string;
  displayId: string;
  meanX: number;
  meanY: number;
  covariance2x2: readonly [readonly [number, number], readonly [number, number]];
  quality: number;
  calibrationGeneration: number;
  displayTransform: DisplayTransform;
}>;

type CalibrationPoint = Readonly<{ targetId: string; x: number; y: number; frames: readonly LandmarkFrame[] }>;

type CalibrationRecord = Readonly<{
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

type GazeRuntimeStatus = Readonly<{
  state: 'active' | 'unavailable';
  reason?: string;
  displayId?: string;
  calibrationGeneration?: number;
}>;

type GazePersistRecord = Readonly<{ kind?: string } & Record<string, unknown>>;

type WebcamGazeRuntime = Readonly<{
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

type CandidateControl = Readonly<{
  candidateId: string;
  label: string;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  semanticScore: number;
  enabled: boolean;
}>;

type GazeEvidence = Readonly<{ samples: readonly GazeSample[]; calibration: CalibrationRecord }>;

type ResolveRequest = Readonly<{
  utteranceId: string;
  turnId: string;
  phrase: Readonly<{ text: string; wordAt: string }>;
  candidates: readonly CandidateControl[];
  gaze?: GazeEvidence | null;
}>;

type ResolveOutcome = Readonly<{
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

type ReferenceResolver = Readonly<{ resolve(request: ResolveRequest): ResolveOutcome }>;

type GazeModule = Readonly<{
  createWebcamGazeRuntime(options: Readonly<{
    now: () => Date;
    camera: Readonly<{ id: string; requestAccess(): Promise<'granted' | 'denied'> }>;
    displays: Readonly<{ current(displayId: string): DisplayTransform | null }>;
    persist?: (record: GazePersistRecord) => void;
  }>): WebcamGazeRuntime;
  createReferenceResolver(options?: Readonly<{ now?: () => Date }>): ReferenceResolver;
}>;

async function loadGazeModule(): Promise<GazeModule> {
  const fail = (detail: string): never => assert.fail(
    'G01 required gaze behavior is not implemented yet: packages/gaze/src/index.ts must export '
    + 'createWebcamGazeRuntime({ now, camera, displays, persist? }) returning the calibrated '
    + 'webcam runtime (start, stop, status, calibrate, activeCalibration, ingest, samples) and '
    + 'createReferenceResolver({ now? }) returning resolve({ utteranceId, turnId, phrase, '
    + `candidates, gaze }). ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists this resolves to
  // nothing, and that is reported below as the missing behavior instead of an import crash.
  const specifier = ['..', 'src', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createWebcamGazeRuntime !== 'function') return fail('createWebcamGazeRuntime is not exported');
  if (typeof loaded.createReferenceResolver !== 'function') return fail('createReferenceResolver is not exported');
  return loaded as unknown as GazeModule;
}

const gaze = await loadGazeModule();

type ReferenceScene = Readonly<{
  referenceId: string;
  displayId: string;
  wordAt: string;
  phrase: Readonly<{ text: string; word: string }>;
  expectedTargetId: string;
  candidates: readonly CandidateControl[];
  frames: readonly LandmarkFrame[];
}>;

type Fixture = Readonly<{
  fixtureId: string;
  displayMain: DisplayTransform;
  displaySide: DisplayTransform;
  cameraId: string;
  calibration: Readonly<{ displayId: string; targets: readonly CalibrationPoint[]; validationTargets: readonly CalibrationPoint[] }>;
  failedCalibration: Readonly<{ displayId: string; targets: readonly CalibrationPoint[]; validationTargets: readonly CalibrationPoint[] }>;
  referenceScenes: readonly ReferenceScene[];
  namedTurn: Readonly<{ phrase: Readonly<{ text: string; word: string }>; candidates: readonly CandidateControl[] }>;
  trackingLoss: Readonly<{ displayId: string; frames: readonly LandmarkFrame[] }>;
  uncalibratedDisplayFrame: LandmarkFrame;
  ringProbeFrame: LandmarkFrame;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

type FakeClock = Readonly<{ now(): Date; current(): string; set(iso: string): void; advance(ms: number): void }>;

function createClock(startIso: string): FakeClock {
  let currentMs = Date.parse(startIso);
  return {
    now: () => new Date(currentMs),
    current: () => new Date(currentMs).toISOString(),
    set: (iso: string): void => { currentMs = Date.parse(iso); },
    advance: (ms: number): void => { currentMs += ms; },
  };
}

type Harness = Readonly<{
  runtime: WebcamGazeRuntime;
  resolver: ReferenceResolver;
  clock: FakeClock;
  persisted: GazePersistRecord[];
  setArrangementGeneration(generation: number): void;
}>;

function createHarness(options: Readonly<{ access: 'granted' | 'denied'; display?: DisplayTransform; startIso?: string }>): Harness {
  const clock = createClock(options.startIso ?? fixture.ringProbeFrame.capturedAt);
  const persisted: GazePersistRecord[] = [];
  let mainDisplay = options.display ?? fixture.displayMain;
  const runtime = gaze.createWebcamGazeRuntime({
    now: () => clock.now(),
    camera: Object.freeze({ id: fixture.cameraId, requestAccess: async (): Promise<'granted' | 'denied'> => options.access }),
    displays: Object.freeze({
      current: (displayId: string): DisplayTransform | null => {
        if (displayId === mainDisplay.displayId) return mainDisplay;
        if (displayId === fixture.displaySide.displayId) return fixture.displaySide;
        return null;
      },
    }),
    persist: (record: GazePersistRecord): void => { persisted.push(record); },
  });
  const resolver = gaze.createReferenceResolver({ now: () => clock.now() });
  return {
    runtime,
    resolver,
    clock,
    persisted,
    setArrangementGeneration: (generation: number): void => { mainDisplay = { ...mainDisplay, arrangementGeneration: generation }; },
  };
}

/** Camera frames are never part of the TS contract; the canary proves they are not retained. */
function withFrameCanary(frame: LandmarkFrame, index: number): LandmarkFrame {
  return {
    ...frame,
    pixels: `${CANARY_FRAME_BYTES}-${index}`,
    dataUrl: `${CANARY_FRAME_DATA_URL}-${index}`,
  } as unknown as LandmarkFrame;
}

function containsFrameCanary(value: unknown): boolean {
  const text = JSON.stringify(value) ?? '';
  return text.includes('CANARY-RAW-FRAME-BYTES') || text.includes('CANARY-G01');
}

function ingestFrames(harness: Harness, frames: readonly LandmarkFrame[]): ReadonlyArray<GazeSample | null> {
  return frames.map((frame, index) => {
    harness.clock.set(frame.capturedAt);
    return harness.runtime.ingest(withFrameCanary(frame, index));
  });
}

function calibrateMain(harness: Harness): CalibrationRecord {
  harness.clock.set(fixture.calibration.targets[0]?.frames[0]?.capturedAt ?? fixture.ringProbeFrame.capturedAt);
  return harness.runtime.calibrate({
    displayId: fixture.calibration.displayId,
    points: fixture.calibration.targets,
    validationPoints: fixture.calibration.validationTargets,
  });
}

function deicticRequest(scene: ReferenceScene, gazeEvidence: GazeEvidence | null): ResolveRequest {
  return {
    utteranceId: `${scene.referenceId}-utterance`,
    turnId: `${scene.referenceId}-turn`,
    phrase: { text: scene.phrase.text, wordAt: scene.wordAt },
    candidates: scene.candidates,
    gaze: gazeEvidence,
  };
}

function assertSampleShape(sample: GazeSample, frame: LandmarkFrame, record: CalibrationRecord): void {
  const sampleKeys = Object.keys(sample);
  for (const required of ['timestamp', 'displayId', 'meanX', 'meanY', 'covariance2x2', 'quality', 'calibrationGeneration', 'displayTransform']) {
    assert.ok(sampleKeys.includes(required), `gaze sample is missing ${required}`);
  }
  for (const forbidden of ['frame', 'frames', 'pixels', 'image', 'bitmap', 'blob', 'jpeg', 'dataUrl']) {
    assert.ok(!sampleKeys.some((key) => key.toLowerCase().includes(forbidden)), `gaze sample must not carry camera frames (${forbidden})`);
  }
  assert.equal(sample.timestamp, frame.capturedAt, 'sample timestamp must be the frame capture time from the injected clock');
  assert.equal(sample.displayId, frame.displayId);
  assert.equal(sample.calibrationGeneration, record.calibrationGeneration);
  assert.deepEqual(sample.displayTransform, frame.displayId === fixture.displayMain.displayId ? fixture.displayMain : fixture.displaySide);
  assert.ok(Number.isFinite(sample.meanX) && Number.isFinite(sample.meanY), 'sample mean must be finite logical points');
  assert.ok(sample.quality > 0 && sample.quality <= 1, 'sample quality must be in (0, 1]');
  const [[xx, xy], [yx, yy]] = sample.covariance2x2;
  assert.equal(xy, yx, 'covariance must be symmetric');
  assert.ok(Number.isFinite(xx) && Number.isFinite(xy) && Number.isFinite(yy), 'covariance must be finite');
  assert.ok(xx > 0 && yy > 0 && xx * yy - xy * xy > 0, 'covariance must be positive definite (uncertainty, not a point claim)');
}

function correctResolutions(outcomes: readonly ResolveOutcome[], scenes: readonly ReferenceScene[]): number {
  return outcomes.filter((outcome, index) => outcome.outcome === 'resolved' && outcome.targetId === scenes[index]?.expectedTargetId).length;
}

test('G01.A — samples carry timestamps, display transforms, uncertainty and calibration generation; no camera frames persist', async () => {
  const harness = createHarness({ access: 'granted' });
  const start = await harness.runtime.start(fixture.displayMain.displayId);
  assert.equal(start.state, 'active');
  assert.equal(start.displayId, fixture.displayMain.displayId);

  const record = calibrateMain(harness);
  assert.equal(record.accepted, true, 'the nine-target calibration with held-out validation must be accepted');
  assert.equal(record.displayId, fixture.displayMain.displayId);
  assert.equal(record.cameraId, fixture.cameraId);
  assert.equal(record.calibrationGeneration, 1);
  assert.equal(record.displayArrangementGeneration, fixture.displayMain.arrangementGeneration);
  assert.equal(record.recordedAt, harness.clock.current(), 'recordedAt must come from the injected clock');
  assert.equal(record.framesUsed + record.framesRejected, fixture.calibration.targets.reduce((total, target) => total + target.frames.length, 0));
  assert.ok(record.framesRejected >= 3, 'blink/occlusion frames must be rejected, not fitted');
  assert.ok(record.validationFramesUsed >= 25, 'the five held-out validation targets must be fitted into the residual covariance');
  assert.ok(record.residualCovariance2x2[0][0] > 0 && record.residualCovariance2x2[1][1] > 0, 'residual covariance must be a real uncertainty estimate');
  assert.deepEqual(harness.runtime.activeCalibration(), record);
  assert.equal(harness.runtime.status().state, 'active');
  assert.equal(harness.runtime.status().calibrationGeneration, 1);

  const scene = fixture.referenceScenes[0];
  assert.ok(scene);
  harness.clock.set(scene.frames[0]?.capturedAt ?? scene.wordAt);
  const samples = ingestFrames(harness, scene.frames);
  assert.equal(samples.length, scene.frames.length);
  for (const [index, sample] of samples.entries()) {
    const sourceFrame: LandmarkFrame | undefined = scene.frames[index];
    assert.ok(sourceFrame);
    assert.ok(sample, 'a settled, eyes-visible frame must produce a sample');
    assertSampleShape(sample, sourceFrame, record);
  }

  const blinkFrame = fixture.trackingLoss.frames[0];
  assert.ok(blinkFrame);
  harness.clock.set(blinkFrame.capturedAt);
  assert.equal(harness.runtime.ingest(blinkFrame), null, 'blink/occluded frames are rejected, never persisted');

  const serialized = JSON.stringify({ samples: harness.runtime.samples(), status: harness.runtime.status(), calibration: harness.runtime.activeCalibration(), persisted: harness.persisted });
  assert.ok(!serialized.includes('CANARY-RAW-FRAME-BYTES') && !serialized.includes('CANARY-G01'), 'camera frame payloads must never be retained by the runtime');
  assert.ok(!containsFrameCanary(harness.persisted), 'the persistence sink may only see gaze metadata, never frames');
  for (const persistedRecord of harness.persisted) {
    for (const forbidden of ['pixels', 'frame', 'image', 'bitmap', 'blob', 'jpeg', 'dataUrl']) {
      assert.ok(!JSON.stringify(persistedRecord).toLowerCase().includes(forbidden), `persisted gaze metadata must not contain ${forbidden}`);
    }
  }
  const runtimeKeys = Object.keys(harness.runtime).map((key) => key.toLowerCase());
  assert.ok(!runtimeKeys.some((key) => ['frame', 'pixel', 'bitmap', 'image'].some((forbidden) => key.includes(forbidden))), 'the runtime surface must not expose camera frames');
});

test('G01.B — held-out target resolution beats the context-only baseline and abstains when calibration fails', async () => {
  const harness = createHarness({ access: 'granted' });
  await harness.runtime.start(fixture.displayMain.displayId);
  const record = calibrateMain(harness);

  const gazeOutcomes: ResolveOutcome[] = [];
  const baselineOutcomes: ResolveOutcome[] = [];
  for (const scene of fixture.referenceScenes) {
    ingestFrames(harness, scene.frames);
    const evidence: GazeEvidence = { samples: harness.runtime.samples(), calibration: record };
    gazeOutcomes.push(harness.resolver.resolve(deicticRequest(scene, evidence)));
    baselineOutcomes.push(harness.resolver.resolve(deicticRequest(scene, null)));
  }

  for (const [index, outcome] of gazeOutcomes.entries()) {
    const scene = fixture.referenceScenes[index];
    assert.ok(scene);
    assert.equal(outcome.outcome, 'resolved', `${scene.referenceId} must resolve with calibrated gaze (reason: ${outcome.reason})`);
    assert.equal(outcome.targetId, scene.expectedTargetId, `${scene.referenceId} must resolve to the referred target`);
    assert.ok(outcome.confidence >= READ_ONLY_CONFIDENCE, `${scene.referenceId} confidence ${outcome.confidence} must clear ${READ_ONLY_CONFIDENCE}`);
    assert.ok(outcome.margin >= READ_ONLY_MARGIN, `${scene.referenceId} margin ${outcome.margin} must clear ${READ_ONLY_MARGIN}`);
    assert.equal(outcome.gazeUsed, true);
    assert.equal(outcome.basis, 'gaze');
    assert.equal(outcome.utteranceId, `${scene.referenceId}-utterance`);
    assert.equal(outcome.turnId, `${scene.referenceId}-turn`, 'the outcome must stay bound to the active turn');
  }
  for (const [index, outcome] of baselineOutcomes.entries()) {
    const scene = fixture.referenceScenes[index];
    assert.ok(scene);
    assert.ok(
      !(outcome.outcome === 'resolved' && outcome.targetId !== scene.expectedTargetId && outcome.confidence >= READ_ONLY_CONFIDENCE),
      `${scene.referenceId} must never resolve a wrong target confidently without gaze`,
    );
  }
  const gazeCorrect = correctResolutions(gazeOutcomes, fixture.referenceScenes);
  const baselineCorrect = correctResolutions(baselineOutcomes, fixture.referenceScenes);
  assert.equal(gazeCorrect, fixture.referenceScenes.length);
  assert.ok(baselineCorrect < gazeCorrect, `held-out resolution with gaze (${gazeCorrect}) must improve over the context-only baseline (${baselineCorrect})`);

  // The deictic window: reference-4 has a distractor glance before the spoken word.
  const distractorScene = fixture.referenceScenes[3];
  assert.ok(distractorScene);
  const distractorOutcome = gazeOutcomes[3];
  assert.ok(distractorOutcome);
  assert.equal(distractorOutcome.targetId, distractorScene.expectedTargetId, 'a glance outside [wordAt-700ms, wordAt+200ms] must not win');

  // Failed calibration: the same held-out references must abstain instead of guessing.
  const failureHarness = createHarness({ access: 'granted' });
  await failureHarness.runtime.start(fixture.displayMain.displayId);
  const failedRecord = failureHarness.runtime.calibrate({
    displayId: fixture.failedCalibration.displayId,
    points: fixture.failedCalibration.targets,
    validationPoints: fixture.failedCalibration.validationTargets,
  });
  assert.equal(failedRecord.accepted, false, 'an all-blink calibration set must not be accepted');
  assert.equal(failedRecord.reason, 'calibration_failed');
  for (const scene of fixture.referenceScenes) {
    const outcome = failureHarness.resolver.resolve(deicticRequest(scene, { samples: [], calibration: failedRecord }));
    assert.notEqual(outcome.outcome, 'resolved', `${scene.referenceId} must abstain when calibration failed`);
    assert.equal(outcome.targetId, undefined);
    assert.equal(outcome.gazeUsed, false);
    assert.equal(outcome.reason, 'calibration_failed');
    assert.ok(outcome.candidateIds.length >= 2, 'abstention must offer the named/numbered candidates');
  }

  // Stale calibration: a display arrangement change invalidates the evidence immediately, and
  // samples from the retired generation are never combined with the new calibration.
  const staleHarness = createHarness({ access: 'granted' });
  await staleHarness.runtime.start(fixture.displayMain.displayId);
  const staleRecord = calibrateMain(staleHarness);
  const staleScene = fixture.referenceScenes[0];
  assert.ok(staleScene);
  ingestFrames(staleHarness, staleScene.frames);
  const staleSamples = staleHarness.runtime.samples();
  staleHarness.setArrangementGeneration(fixture.displayMain.arrangementGeneration + 1);
  const staleStatus = staleHarness.runtime.status();
  assert.equal(staleStatus.state, 'unavailable');
  assert.equal(staleStatus.reason, 'calibration_stale');
  const staleFrame = staleScene.frames[0];
  assert.ok(staleFrame);
  assert.equal(staleHarness.runtime.ingest(staleFrame), null, 'a changed display arrangement makes gaze unknown');
  const recalibrated = calibrateMain(staleHarness);
  assert.equal(recalibrated.calibrationGeneration, staleRecord.calibrationGeneration + 1, 'recalibration starts a new generation');
  assert.equal(recalibrated.displayArrangementGeneration, fixture.displayMain.arrangementGeneration + 1);
  const staleOutcome = staleHarness.resolver.resolve(deicticRequest(staleScene, { samples: staleSamples, calibration: recalibrated }));
  assert.notEqual(staleOutcome.outcome, 'resolved');
  assert.equal(staleOutcome.targetId, undefined);
  assert.equal(staleOutcome.gazeUsed, false);
  assert.equal(staleOutcome.reason, 'calibration_stale');

  // An uncalibrated display returns unknown instead of reusing another display's calibration.
  const unknownHarness = createHarness({ access: 'granted' });
  await unknownHarness.runtime.start(fixture.displayMain.displayId);
  calibrateMain(unknownHarness);
  unknownHarness.clock.set(fixture.uncalibratedDisplayFrame.capturedAt);
  assert.equal(unknownHarness.runtime.ingest(fixture.uncalibratedDisplayFrame), null);
});

test('G01.C — camera denial or invalid tracking falls back to voice/named targets without breaking the conversation', async () => {
  const denied = createHarness({ access: 'denied' });
  const deniedStatus = await denied.runtime.start(fixture.displayMain.displayId);
  assert.equal(deniedStatus.state, 'unavailable');
  assert.equal(deniedStatus.reason, 'camera_denied');
  assert.equal(denied.runtime.status().reason, 'camera_denied');

  const namedTurn = denied.resolver.resolve({
    utteranceId: 'denied-utterance-1',
    turnId: 'denied-turn-1',
    phrase: { text: fixture.namedTurn.phrase.text, wordAt: fixture.ringProbeFrame.capturedAt },
    candidates: fixture.namedTurn.candidates,
    gaze: null,
  });
  assert.equal(namedTurn.outcome, 'resolved', 'a named target must resolve while the camera is denied');
  assert.equal(namedTurn.targetId, 'named-deploy');
  assert.equal(namedTurn.basis, 'named');
  assert.equal(namedTurn.gazeUsed, false);
  assert.equal(namedTurn.turnId, 'denied-turn-1');

  const followUp = denied.resolver.resolve({
    utteranceId: 'denied-utterance-2',
    turnId: 'denied-turn-2',
    phrase: { text: 'can you explain this one', wordAt: fixture.ringProbeFrame.capturedAt },
    candidates: fixture.referenceScenes[0]?.candidates ?? [],
    gaze: null,
  });
  assert.notEqual(followUp.outcome, 'resolved');
  assert.equal(followUp.turnId, 'denied-turn-2', 'the conversation keeps taking turns after the gaze failure');
  assert.ok(followUp.candidateIds.length >= 2);
  await denied.runtime.stop();

  const invalid = createHarness({ access: 'granted' });
  assert.equal((await invalid.runtime.start(fixture.displayMain.displayId)).state, 'active');
  const rejected = ingestFrames(invalid, fixture.trackingLoss.frames);
  assert.equal(rejected.length, TRACKING_LOSS_FRAMES);
  assert.ok(rejected.every((sample) => sample === null), 'unusable frames must never become samples');
  assert.equal(invalid.runtime.status().state, 'unavailable');
  assert.equal(invalid.runtime.status().reason, 'tracking_lost');

  const namedAfterLoss = invalid.resolver.resolve({
    utteranceId: 'lost-utterance-1',
    turnId: 'lost-turn-1',
    phrase: { text: fixture.namedTurn.phrase.text, wordAt: fixture.ringProbeFrame.capturedAt },
    candidates: fixture.namedTurn.candidates,
    gaze: null,
  });
  assert.equal(namedAfterLoss.outcome, 'resolved');
  assert.equal(namedAfterLoss.targetId, 'named-deploy');
  assert.equal(namedAfterLoss.basis, 'named');
  assert.equal(namedAfterLoss.gazeUsed, false);

  const deicticAfterLoss = invalid.resolver.resolve({
    utteranceId: 'lost-utterance-2',
    turnId: 'lost-turn-2',
    phrase: { text: 'why is this disabled', wordAt: fixture.ringProbeFrame.capturedAt },
    candidates: fixture.referenceScenes[0]?.candidates ?? [],
    gaze: null,
  });
  assert.notEqual(deicticAfterLoss.outcome, 'resolved', 'voice/named targeting replaces gaze, it does not guess');
  assert.equal(deicticAfterLoss.targetId, undefined);
  await invalid.runtime.stop();
});

test('G01.D — replay is deterministic and the sample ring is bounded to ten seconds', async () => {
  const run = async (): Promise<{ samples: readonly GazeSample[]; outcomes: readonly ResolveOutcome[]; baseline: readonly ResolveOutcome[]; record: CalibrationRecord }> => {
    const harness = createHarness({ access: 'granted' });
    await harness.runtime.start(fixture.displayMain.displayId);
    const record = calibrateMain(harness);
    const outcomes: ResolveOutcome[] = [];
    const baseline: ResolveOutcome[] = [];
    for (const scene of fixture.referenceScenes) {
      ingestFrames(harness, scene.frames);
      const evidence: GazeEvidence = { samples: harness.runtime.samples(), calibration: record };
      outcomes.push(harness.resolver.resolve(deicticRequest(scene, evidence)));
      baseline.push(harness.resolver.resolve(deicticRequest(scene, null)));
    }
    const samples = harness.runtime.samples();
    harness.clock.set(fixture.ringProbeFrame.capturedAt);
    const probe = harness.runtime.ingest(fixture.ringProbeFrame);
    assert.ok(probe, 'a valid frame after the clock jump still ingests');
    const ring = harness.runtime.samples();
    assert.ok(ring.length <= 1, 'samples older than the ten-second ring must be evicted');
    assert.equal(ring[0]?.timestamp, fixture.ringProbeFrame.capturedAt);
    assert.ok(ring.every((sample) => Date.parse(sample.timestamp) >= Date.parse(fixture.ringProbeFrame.capturedAt) - GAZE_SAMPLE_RING_MS));
    await harness.runtime.stop();
    return { samples, outcomes, baseline, record };
  };

  const first = await run();
  const second = await run();
  assert.deepEqual(JSON.parse(JSON.stringify(first.samples)), JSON.parse(JSON.stringify(second.samples)), 'gaze samples must replay byte-identically');
  assert.deepEqual(JSON.parse(JSON.stringify(first.outcomes)), JSON.parse(JSON.stringify(second.outcomes)), 'resolutions must replay byte-identically');
  assert.deepEqual(JSON.parse(JSON.stringify(first.baseline)), JSON.parse(JSON.stringify(second.baseline)), 'baseline resolutions must replay byte-identically');
  assert.deepEqual(JSON.parse(JSON.stringify(first.record)), JSON.parse(JSON.stringify(second.record)), 'calibration records must replay byte-identically');
});
