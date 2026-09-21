/**
 * G01 — the webcam gaze runtime (IMPLEMENTATION_PLAN.md §5.11).
 *
 * The runtime is the seam between the native landmark worker and the rest of the app, and it is
 * deliberately boring about failure:
 *
 * - `start()` never rejects. Camera denial is a value (`camera_denied`), and voice/named targeting
 *   keeps working because gaze is optional evidence;
 * - `status()` is re-evaluated against the *live* display arrangement, so a moved/replaced display
 *   reports `calibration_stale` before the next turn starts rather than after it resolves wrong;
 * - `ingest()` takes landmark/quality features only — never a camera frame — and returns null for
 *   blink/occlusion, low quality, an unknown display, or a retired arrangement generation;
 * - the sample ring is bounded to the last ten seconds and pruned on push and on read, so a
 *   delayed ASR word cannot pull in an older glance (including after a clock jump);
 * - the persistence sink only ever sees sample/calibration/status metadata. Frames are not passed
 *   in, so there is nothing to leak; the oracle's canary proves it end to end.
 */
import { buildCalibrationRecord, isUsableFrame, type GazeFit } from './calibration.js';
import { GAZE_SAMPLE_RING_MS, TRACKING_LOSS_FRAMES } from './types.js';
import type {
  CalibrationPoint,
  CalibrationRecord,
  DisplayTransform,
  GazePersistRecord,
  GazeRuntimeStatus,
  GazeSample,
  LandmarkFrame,
  WebcamGazeRuntime,
  WebcamGazeRuntimeOptions,
} from './types.js';

type Lifecycle = 'not_started' | 'active' | 'stopped' | 'denied';

type StoredCalibration = Readonly<{ record: CalibrationRecord; fit: GazeFit }>;

export function createWebcamGazeRuntime(options: WebcamGazeRuntimeOptions): WebcamGazeRuntime {
  const { now, camera, displays } = options;
  const persist = options.persist;

  let lifecycle: Lifecycle = 'not_started';
  let activeDisplayId: string | null = null;
  let consecutiveUnusableFrames = 0;
  let trackingLossReported = false;
  const generations = new Map<string, number>();
  const calibrations = new Map<string, StoredCalibration>();
  let ring: GazeSample[] = [];

  /** A sample carries the transform it was produced under; it never carries the frame. */
  const copyTransform = (transform: DisplayTransform): DisplayTransform => ({
    displayId: transform.displayId,
    originX: transform.originX,
    originY: transform.originY,
    width: transform.width,
    height: transform.height,
    scale: transform.scale,
    arrangementGeneration: transform.arrangementGeneration,
  });

  const pruneRing = (referenceMs: number): void => {
    if (!Number.isFinite(referenceMs)) return;
    const cutoff = referenceMs - GAZE_SAMPLE_RING_MS;
    ring = ring.filter((sample) => {
      const capturedAt = Date.parse(sample.timestamp);
      return !Number.isFinite(capturedAt) || capturedAt >= cutoff;
    });
  };

  const statusOf = (): GazeRuntimeStatus => {
    if (lifecycle === 'denied') return { state: 'unavailable', reason: 'camera_denied' };
    if (lifecycle === 'not_started') return { state: 'unavailable', reason: 'not_started' };
    if (lifecycle === 'stopped') return { state: 'unavailable', reason: 'stopped' };
    const displayId = activeDisplayId;
    if (!displayId) return { state: 'unavailable', reason: 'camera_unavailable' };
    const transform = displays.current(displayId);
    if (!transform) return { state: 'unavailable', reason: 'camera_unavailable', displayId };
    const calibration = calibrations.get(displayId);
    if (calibration && transform.arrangementGeneration !== calibration.record.displayArrangementGeneration) {
      return { state: 'unavailable', reason: 'calibration_stale', displayId };
    }
    if (consecutiveUnusableFrames >= TRACKING_LOSS_FRAMES) {
      return { state: 'unavailable', reason: 'tracking_lost', displayId };
    }
    return calibration
      ? { state: 'active', displayId, calibrationGeneration: calibration.record.calibrationGeneration }
      : { state: 'active', displayId };
  };

  const persistStatus = (status: GazeRuntimeStatus): void => {
    if (!persist) return;
    const record: GazePersistRecord = {
      kind: 'gaze_status',
      state: status.state,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.displayId === undefined ? {} : { displayId: status.displayId }),
    };
    persist(record);
  };

  const start = async (displayId: string): Promise<GazeRuntimeStatus> => {
    const access = await camera.requestAccess();
    if (access !== 'granted') {
      lifecycle = 'denied';
      activeDisplayId = null;
      consecutiveUnusableFrames = 0;
      ring = [];
      const status = statusOf();
      persistStatus(status);
      return status;
    }
    lifecycle = 'active';
    activeDisplayId = displayId;
    consecutiveUnusableFrames = 0;
    trackingLossReported = false;
    ring = [];
    const status = statusOf();
    persistStatus(status);
    return status;
  };

  const stop = async (): Promise<void> => {
    if (lifecycle !== 'active') return;
    lifecycle = 'stopped';
    consecutiveUnusableFrames = 0;
    persistStatus(statusOf());
  };

  const calibrate = (input: Readonly<{
    displayId: string;
    points: readonly CalibrationPoint[];
    validationPoints: readonly CalibrationPoint[];
  }>): CalibrationRecord => {
    const generation = (generations.get(input.displayId) ?? 0) + 1;
    generations.set(input.displayId, generation);
    const transform = displays.current(input.displayId);
    const { record, fit } = buildCalibrationRecord({
      displayId: input.displayId,
      cameraId: camera.id,
      calibrationGeneration: generation,
      displayArrangementGeneration: transform?.arrangementGeneration ?? 0,
      recordedAt: now().toISOString(),
      points: input.points,
      validationPoints: input.validationPoints,
      displayExtent: transform ? Math.max(transform.width, transform.height) : 0,
    });
    if (record.accepted && fit) calibrations.set(input.displayId, { record, fit });
    else calibrations.delete(input.displayId);
    persist?.({
      kind: 'gaze_calibration',
      calibrationGeneration: record.calibrationGeneration,
      displayId: record.displayId,
      accepted: record.accepted,
      usableObservations: record.framesUsed,
      rejectedObservations: record.framesRejected,
      validationObservations: record.validationFramesUsed,
      displayArrangementGeneration: record.displayArrangementGeneration,
      recordedAt: record.recordedAt,
    });
    return record;
  };

  const activeCalibration = (): CalibrationRecord | null => {
    if (!activeDisplayId) return null;
    return calibrations.get(activeDisplayId)?.record ?? null;
  };

  const ingest = (frame: LandmarkFrame): GazeSample | null => {
    if (lifecycle !== 'active' || !activeDisplayId) return null;
    // Tracking loss is about the camera, not the display: it is counted before any display or
    // calibration question is asked, so an unusable frame is unusable even without a calibration.
    if (!isUsableFrame(frame)) {
      consecutiveUnusableFrames += 1;
      if (consecutiveUnusableFrames >= TRACKING_LOSS_FRAMES && !trackingLossReported) {
        trackingLossReported = true;
        persistStatus(statusOf());
      }
      return null;
    }
    consecutiveUnusableFrames = 0;
    trackingLossReported = false;
    const transform = displays.current(frame.displayId);
    if (!transform) return null;
    const calibration = calibrations.get(frame.displayId);
    if (!calibration) return null;
    if (transform.arrangementGeneration !== calibration.record.displayArrangementGeneration) return null;
    if (frame.cameraId !== camera.id) return null;
    const [meanX, meanY] = calibration.fit.predict(frame);
    const quality = Math.min(1, Math.max(frame.quality, Number.EPSILON));
    const [[residualXx, residualXy], [, residualYy]] = calibration.record.residualCovariance2x2;
    // One observation carries the fit's residual covariance inflated by this frame's quality:
    // a well-lit, open-eyed frame is a better measurement than a marginal one.
    const inflation = 1 / quality;
    const sample: GazeSample = {
      timestamp: frame.capturedAt,
      displayId: frame.displayId,
      meanX,
      meanY,
      covariance2x2: [
        [residualXx * inflation, residualXy * inflation],
        [residualXy * inflation, residualYy * inflation],
      ],
      quality,
      calibrationGeneration: calibration.record.calibrationGeneration,
      displayTransform: copyTransform(transform),
    };
    ring.push(sample);
    pruneRing(Date.parse(frame.capturedAt));
    persist?.({
      kind: 'gaze_sample',
      timestamp: sample.timestamp,
      displayId: sample.displayId,
      meanX: sample.meanX,
      meanY: sample.meanY,
      quality: sample.quality,
      calibrationGeneration: sample.calibrationGeneration,
    });
    return sample;
  };

  const samples = (): readonly GazeSample[] => {
    pruneRing(now().getTime());
    return ring.slice();
  };

  return { start, stop, status: statusOf, calibrate, activeCalibration, ingest, samples };
}
