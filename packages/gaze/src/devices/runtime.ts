/**
 * G03 — the dedicated-device gaze runtime (IMPLEMENTATION_PLAN.md §7.2 G03; §5.11).
 *
 * The runtime is the seam between the native `GazeTobii` helper and the rest of the app, and it
 * publishes exactly the §5.11 schema the webcam runtime publishes, so the shared resolver and the
 * G02 confirmation/action rules consume device evidence without a second pipeline:
 *
 * - `connect()` never rejects. A missing device, a missing SDK or a denied permission is a value
 *   (`{ state: 'unavailable', reason }`), and named/numbered voice targeting keeps working because
 *   gaze stays optional evidence;
 * - the helper's disconnect notification is acted on synchronously: a USB removal or helper crash
 *   invalidates the status, the sample ring, the calibration and `ingest()` before any further
 *   await, and a reconnect requires a fresh per-display calibration;
 * - `calibrate()` maps the device's normalized raw gaze into desktop logical points through the
 *   per-display fit and measures its residual covariance on the held-out validation targets; a fit
 *   that cannot be trusted stays `accepted: false` / `calibration_failed` and publishes nothing;
 * - `ingest()` takes normalized gaze plus validity only — never a frame or SDK payload — and
 *   returns null for an unusable observation, an unknown/stale display or an uncalibrated display;
 * - the sample ring is bounded to ten seconds of device time and cleared by a disconnect;
 * - the persistence sink only ever sees sample/calibration/status metadata, never raw device
 *   coordinates and never the observation payload.
 */
import { GAZE_SAMPLE_RING_MS } from '../types.js';
import type {
  CalibrationRecord,
  DisplayTransform,
  GazeRuntimeStatus,
  GazeSample,
} from '../types.js';
import {
  buildDeviceCalibrationRecord,
  deviceObservationQuality,
  isUsableDeviceObservation,
  type DeviceGazeFit,
} from './calibration.js';
import type {
  DedicatedGazeDeviceOptions,
  DedicatedGazeDeviceRuntime,
  DeviceCalibrationPoint,
  DeviceObservation,
} from './types.js';

type Lifecycle = 'idle' | 'active' | 'unavailable';

type StoredCalibration = Readonly<{ record: CalibrationRecord; fit: DeviceGazeFit }>;

export function createDedicatedGazeDevice(options: DedicatedGazeDeviceOptions): DedicatedGazeDeviceRuntime {
  const { now, displays, bridge } = options;
  const persist = options.persist;

  let lifecycle: Lifecycle = 'idle';
  let unavailableReason: string | null = null;
  let activeDisplayId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  const generations = new Map<string, number>();
  const calibrations = new Map<string, StoredCalibration>();
  let ring: GazeSample[] = [];

  /** A sample carries the transform it was produced under; it never carries the observation. */
  const copyTransform = (transform: DisplayTransform): DisplayTransform => ({
    displayId: transform.displayId,
    originX: transform.originX,
    originY: transform.originY,
    width: transform.width,
    height: transform.height,
    scale: transform.scale,
    arrangementGeneration: transform.arrangementGeneration,
  });

  /**
   * The ring keeps ten seconds of device time: a sample older than the newest kept sample by more
   * than the §5.11 window is evicted, so a late observation cannot pull in an older glance.
   */
  const pruneRing = (): void => {
    if (ring.length <= 1) return;
    let newest = Number.NEGATIVE_INFINITY;
    for (const sample of ring) {
      const capturedAt = Date.parse(sample.timestamp);
      if (Number.isFinite(capturedAt) && capturedAt > newest) newest = capturedAt;
    }
    if (!Number.isFinite(newest)) {
      ring = ring.slice(-1);
      return;
    }
    const cutoff = newest - GAZE_SAMPLE_RING_MS;
    ring = ring.filter((sample) => {
      const capturedAt = Date.parse(sample.timestamp);
      return !Number.isFinite(capturedAt) || capturedAt >= cutoff;
    });
  };

  const persistStatus = (status: GazeRuntimeStatus): void => {
    if (!persist) return;
    persist({
      kind: 'gaze_status',
      state: status.state,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      ...(status.displayId === undefined ? {} : { displayId: status.displayId }),
    });
  };

  const statusOf = (): GazeRuntimeStatus => {
    if (lifecycle === 'unavailable') {
      return unavailableReason === null
        ? { state: 'unavailable' }
        : { state: 'unavailable', reason: unavailableReason };
    }
    const displayId = activeDisplayId;
    if (displayId === null) return { state: 'unavailable', reason: 'device_not_connected' };
    const transform = displays.current(displayId);
    if (!transform) return { state: 'unavailable', reason: 'display_unavailable', displayId };
    const calibration = calibrations.get(displayId);
    if (calibration && transform.arrangementGeneration !== calibration.record.displayArrangementGeneration) {
      return { state: 'unavailable', reason: 'calibration_stale', displayId };
    }
    return calibration
      ? { state: 'active', displayId, calibrationGeneration: calibration.record.calibrationGeneration }
      : { state: 'active', displayId };
  };

  const invalidate = (reason: string): void => {
    lifecycle = 'unavailable';
    unavailableReason = reason;
    activeDisplayId = null;
    calibrations.clear();
    ring = [];
  };

  /** The helper reports USB removal/crash here; the invalidation is synchronous by contract. */
  const handleHelperDisconnect = (reason: string): void => {
    invalidate(typeof reason === 'string' && reason.length > 0 ? reason : 'device_disconnected');
    persistStatus(statusOf());
  };

  const connect = async (input: Readonly<{ displayId: string }>): Promise<GazeRuntimeStatus> => {
    const displayId = input.displayId;
    if (displays.current(displayId) === null) {
      invalidate('display_unavailable');
      persistStatus(statusOf());
      return statusOf();
    }
    let connection: Awaited<ReturnType<typeof bridge.connect>> | null = null;
    try {
      connection = await bridge.connect();
    } catch {
      connection = null;
    }
    if (connection === null || connection.connected !== true) {
      const refusal = connection === null
        ? 'device_unavailable'
        : typeof connection.reason === 'string' && connection.reason.length > 0
          ? connection.reason
          : 'device_unavailable';
      invalidate(refusal);
      persistStatus(statusOf());
      return statusOf();
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    lifecycle = 'active';
    unavailableReason = null;
    activeDisplayId = displayId;
    // A reconnect is a fresh session: the pre-disconnect calibration cannot be reused.
    calibrations.clear();
    ring = [];
    unsubscribe = bridge.onDisconnect(handleHelperDisconnect);
    const status = statusOf();
    persistStatus(status);
    return status;
  };

  const disconnect = async (): Promise<void> => {
    const wasActive = lifecycle === 'active';
    if (unsubscribe !== null) {
      const stop = unsubscribe;
      unsubscribe = null;
      stop();
    }
    if (wasActive) {
      try {
        await bridge.disconnect();
      } catch {
        // A stream that is already gone is not an error: the gaze is invalid either way.
      }
    }
    invalidate('device_disconnected');
    persistStatus(statusOf());
  };

  const calibrate = (input: Readonly<{
    displayId: string;
    points: readonly DeviceCalibrationPoint[];
    validationPoints: readonly DeviceCalibrationPoint[];
  }>): CalibrationRecord => {
    const displayId = input.displayId;
    const generation = (generations.get(displayId) ?? 0) + 1;
    generations.set(displayId, generation);
    const transform = displays.current(displayId);
    const stamp = now();
    const { record, fit } = buildDeviceCalibrationRecord({
      displayId,
      cameraId: bridge.combination.deviceModel,
      calibrationGeneration: generation,
      displayArrangementGeneration: transform?.arrangementGeneration ?? 0,
      recordedAt: Number.isFinite(stamp.getTime()) ? stamp.toISOString() : '',
      points: input.points,
      validationPoints: input.validationPoints,
      displayExtent: transform ? Math.max(transform.width, transform.height) : 0,
    });
    if (record.accepted && fit) calibrations.set(displayId, { record, fit });
    else calibrations.delete(displayId);
    persist?.({
      kind: 'gaze_calibration',
      deviceModel: bridge.combination.deviceModel,
      sdkVersion: bridge.combination.sdkVersion,
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
    if (lifecycle !== 'active' || activeDisplayId === null) return null;
    return calibrations.get(activeDisplayId)?.record ?? null;
  };

  const ingest = (observation: DeviceObservation): GazeSample | null => {
    if (lifecycle !== 'active') return null;
    if (!isUsableDeviceObservation(observation)) return null;
    const transform = displays.current(observation.displayId);
    if (!transform) return null;
    const calibration = calibrations.get(observation.displayId);
    if (!calibration) return null;
    if (transform.arrangementGeneration !== calibration.record.displayArrangementGeneration) return null;
    const [meanX, meanY] = calibration.fit.predict(observation);
    if (!Number.isFinite(meanX) || !Number.isFinite(meanY)) return null;
    const quality = deviceObservationQuality(observation);
    const inflation = 1 / quality;
    const [[residualXx, residualXy], [, residualYy]] = calibration.record.residualCovariance2x2;
    const sample: GazeSample = {
      timestamp: observation.capturedAt,
      displayId: observation.displayId,
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
    pruneRing();
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
    pruneRing();
    return ring.slice();
  };

  return { connect, disconnect, status: statusOf, calibrate, activeCalibration, ingest, samples };
}
