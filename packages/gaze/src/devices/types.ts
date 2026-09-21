/**
 * G03 — the dedicated-device gaze seam (IMPLEMENTATION_PLAN.md §7.2 G03; §5.11).
 *
 * A dedicated tracker (the Tobii Pro Fusion C SDK behind the native `GazeTobii` helper) is a
 * second *source* of §5.11 gaze evidence, never a second pipeline: the helper publishes one
 * observation per sample as normalized `[0,1]` display coordinates plus a per-eye validity, the
 * runtime corrects them into desktop logical points through the per-display calibration, and the
 * shared G01 resolver and G02 confirmation/action rules consume the result exactly as they consume
 * webcam samples.
 *
 * Every type here is metadata. Coordinates, validities, timestamps, calibration generations and
 * display transforms cross the seam; no frame, no SDK handle and no device payload does.
 */
import type { CalibrationRecord, DisplayTransform, GazeRuntimeStatus, GazeSample } from '../types.js';

/** The exact device/SDK/OS/architecture combination a qualification run was executed against. */
export type DeviceCombination = Readonly<{
  deviceModel: string;
  sdkName: string;
  sdkVersion: string;
  platform: string;
  osVersion: string;
  architecture: string;
}>;

/**
 * One sample as the native helper publishes it: `gazeX`/`gazeY` are normalized `[0,1]` logical
 * display coordinates, validities are `[0,1]` per eye. An observation whose validities are below
 * the usable threshold is not a measurement (the dedicated-device mirror of the webcam
 * frame-quality rejection) and is counted as rejected, never fitted and never published.
 */
export type DeviceObservation = Readonly<{
  capturedAt: string;
  displayId: string;
  gazeX: number;
  gazeY: number;
  leftValidity: number;
  rightValidity: number;
}>;

/** A missing device, a missing SDK or a denied permission is a value, never a throw. */
export type DeviceConnection =
  | Readonly<{ connected: true }>
  | Readonly<{ connected: false; reason: string }>;

/** The native `GazeTobii` helper as a value: connect/disconnect plus a disconnect notification. */
export type DeviceBridge = Readonly<{
  combination: DeviceCombination;
  connect(): Promise<DeviceConnection>;
  disconnect(): Promise<void>;
  onDisconnect(listener: (reason: string) => void): () => void;
}>;

/** One of the nine device calibration targets (or one of the held-out validation targets). */
export type DeviceCalibrationPoint = Readonly<{
  targetId: string;
  x: number;
  y: number;
  observations: readonly DeviceObservation[];
}>;

export type DeviceQualificationCheck = Readonly<{
  checkId: string;
  status: 'passed' | 'failed';
  detail: string;
}>;

export type DeviceQualification = Readonly<{
  combination: DeviceCombination;
  supported: boolean;
  reason?: string;
  checks: readonly DeviceQualificationCheck[];
  probe: Readonly<{ meanX: number; meanY: number }> | null;
}>;

export type DedicatedGazeDeviceRuntime = Readonly<{
  connect(input: Readonly<{ displayId: string }>): Promise<GazeRuntimeStatus>;
  disconnect(): Promise<void>;
  status(): GazeRuntimeStatus;
  calibrate(input: Readonly<{
    displayId: string;
    points: readonly DeviceCalibrationPoint[];
    validationPoints: readonly DeviceCalibrationPoint[];
  }>): CalibrationRecord;
  activeCalibration(): CalibrationRecord | null;
  ingest(observation: DeviceObservation): GazeSample | null;
  samples(): readonly GazeSample[];
}>;

export type DedicatedGazeDeviceOptions = Readonly<{
  now: () => Date;
  displays: Readonly<{ current(displayId: string): DisplayTransform | null }>;
  bridge: DeviceBridge;
  persist?: (record: Record<string, unknown>) => void;
}>;
