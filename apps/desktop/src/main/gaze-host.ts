import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWebcamGazeRuntime, createReferenceResolver, type CalibrationPoint, type CalibrationRecord, type DisplayTransform, type LandmarkFrame, type WebcamGazeRuntime, type GazeRuntimeStatus, type ResolveRequest, type GazeSample } from '../../../../packages/gaze/src/index';

export type GazeCalibrationTarget = {index: number; total: number; x: number; y: number; normalizedX: number; normalizedY: number; heldOut: boolean; readyAt: number; frames: number};
export type GazeHostResult = {ok: boolean; error?: string; status?: GazeRuntimeStatus; displays?: readonly DisplayTransform[]; target?: GazeCalibrationTarget; calibration?: CalibrationRecord | null; quality?: number; dedicatedDevice?: 'adapter_not_bundled'; resolution?: unknown; latestSample?: GazeSample};
export type GazeTransport = {stop(): void};
export type GazeHostOptions = {bundleDir: string; activeProjectId(): string | null; displays(): readonly DisplayTransform[]; now?(): number; open?(displayId: string, event: (value: unknown) => void, exit: () => void): GazeTransport};
const POSITIONS = [[.15,.15],[.5,.15],[.85,.15],[.15,.5],[.5,.5],[.85,.5],[.15,.85],[.5,.85],[.85,.85],[.3,.3],[.7,.3],[.3,.7],[.7,.7],[.5,.6]] as const;

/** Camera is launched only by explicit enable, on private stdio, with bounded metadata lines. */
export function openNativeGaze(bundleDir: string, displayId: string, event: (value: unknown) => void, exit: () => void): GazeTransport {
  const helper = resolve(bundleDir, '../native/echopilot-gaze');
  if (!existsSync(helper)) throw Error('helper_missing');
  const child = spawn(helper, [displayId], {stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '';
  let stopped = false;
  const stop = () => {if (stopped) return; stopped = true; child.stdin.end('stop\n'); child.kill('SIGTERM');};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 131_072) {stop(); exit(); return;}
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 16_384) {stop(); exit(); return;}
      try {event(JSON.parse(line));} catch {stop(); exit(); return;}
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.resume();
  child.on('error', exit);
  child.on('exit', exit);
  return {stop};
}

function parseFrame(value: unknown): LandmarkFrame | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as LandmarkFrame;
  if (typeof frame.cameraId !== 'string' || frame.cameraId.length > 256 || typeof frame.displayId !== 'string' || frame.displayId.length > 256 || typeof frame.capturedAt !== 'string' || !Number.isFinite(Date.parse(frame.capturedAt)) || typeof frame.eyesVisible !== 'boolean' || !Number.isFinite(frame.quality) || frame.quality < 0 || frame.quality > 1 || !frame.features) return null;
  const keys = ['irisX','irisY','ear','faceX','faceY','faceScale','yaw','pitch','roll'] as const;
  if (!keys.every((key) => Number.isFinite(frame.features[key]))) return null;
  if (['irisX','irisY','faceX','faceY','faceScale','ear'].some((key) => {const coordinate = frame.features[key as keyof LandmarkFrame['features']]; return coordinate < 0 || coordinate > 1;})) return null;
  return {capturedAt: frame.capturedAt, cameraId: frame.cameraId, displayId: frame.displayId, eyesVisible: frame.eyesVisible, quality: frame.quality, features: Object.fromEntries(keys.map((key) => [key, frame.features[key]])) as unknown as LandmarkFrame['features']};
}

/** Calibrated metadata only; camera frames and uncalibrated point guesses never leave the helper. */
export function createGazeHost(options: GazeHostOptions) {
  const now = options.now ?? Date.now;
  const open = options.open ?? ((displayId, event, exit) => openNativeGaze(options.bundleDir, displayId, event, exit));
  let project: string | null = null;
  let displayId: string | null = null;
  let transport: GazeTransport | null = null;
  let runtime: WebcamGazeRuntime | null = null;
  let reason = 'not_started';
  let revision = 0;
  let lastFrameAt = 0;
  let quality = 0;
  let target: GazeCalibrationTarget | null = null;
  let frames: LandmarkFrame[] = [];
  let points: CalibrationPoint[] = [];
  let validationPoints: CalibrationPoint[] = [];
  let calibrationArrangement: string | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  const resolver = createReferenceResolver({now: () => new Date(now())});
  function stop(stopReason = 'stopped') {
    revision += 1;
    transport?.stop(); transport = null;
    void runtime?.stop(); runtime = null;
    if (startupTimer) clearTimeout(startupTimer); startupTimer = null;
    target = null; frames = []; points = []; validationPoints = []; calibrationArrangement = null;
    project = null; displayId = null; lastFrameAt = 0; quality = 0; reason = stopReason;
  }
  function scope(value: unknown): string {
    const active = options.activeProjectId();
    if (typeof value !== 'string' || value !== active || !active || value.length > 256) throw Error('inactive_project');
    return value;
  }
  function display(): DisplayTransform | null {return options.displays().find((item) => item.displayId === displayId) ?? null;}
  function status(): GazeRuntimeStatus {
    if (project && project !== options.activeProjectId()) stop('inactive_project');
    if (!runtime) return {state: 'unavailable', reason};
    if (now() - lastFrameAt > 2_500) return {state: 'unavailable', reason: 'pupil_tracking_lost'};
    const current = runtime.status();
    if (current.state === 'active' && !runtime.activeCalibration()) return {state: 'unavailable', reason: 'calibration_required', ...(displayId ? {displayId} : {})};
    return current;
  }
  const watchdog = setInterval(() => {if (project && project !== options.activeProjectId()) stop('inactive_project');}, 1_000);
  watchdog.unref();
  function setTarget(index: number) {
    const transform = display(); const position = POSITIONS[index];
    if (!transform || !position) throw Error('display_unavailable');
    frames = [];
    target = {index, total: POSITIONS.length, x: transform.originX + position[0] * transform.width, y: transform.originY + position[1] * transform.height,
      normalizedX: position[0], normalizedY: position[1], heldOut: index >= 9, readyAt: now() + 1_200, frames: 0};
  }
  return {
    dispose() {clearInterval(watchdog); stop();},
    sample() {return status().state === 'active' ? runtime?.samples().at(-1) ?? null : null;},
    recentSamples() {return status().state === 'active' ? runtime?.samples() ?? [] : [];},
    resolve(request: ResolveRequest) {
      const calibration = status().state === 'active' ? runtime?.activeCalibration() : null;
      return resolver.resolve({...request, gaze: calibration && runtime ? {calibration, samples: runtime.samples()} : null});
    },
    async handle(payload: unknown): Promise<GazeHostResult> {
      try {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid_request');
        const request = payload as Record<string, unknown>;
        const projectId = scope(request.projectId);
        if (request.command === 'stop') {stop(); return {ok: true, status: status()};}
        if (request.command === 'start') {
          if (request.enabled !== true) throw Error('camera_enable_required');
          if (typeof request.displayId !== 'string' || !options.displays().some((item) => item.displayId === request.displayId)) throw Error('display_unavailable');
          stop(); project = projectId; displayId = request.displayId; reason = 'camera_starting';
          const generation = revision;
          transport = open(displayId, (value) => {
            if (generation !== revision || !value || typeof value !== 'object') return;
            if (project !== options.activeProjectId()) {stop('inactive_project'); return;}
            const event = value as {type?: string; payload?: unknown};
            if (event.type === 'unavailable') {
              const denial = event.payload as {reason?: string} | undefined;
              stop(denial?.reason === 'camera_denied' ? 'camera_denied' : 'camera_unavailable');
            } else if (event.type === 'started') {
              const cameraId = (event.payload as {cameraId?: unknown} | undefined)?.cameraId;
              if (typeof cameraId !== 'string' || cameraId.length > 256 || !displayId) {stop('malformed_response'); return;}
              if (startupTimer) clearTimeout(startupTimer); startupTimer = null;
              runtime = createWebcamGazeRuntime({now: () => new Date(now()), camera: {id: cameraId, requestAccess: async () => 'granted'}, displays: {current: (id) => options.displays().find((item) => item.displayId === id) ?? null}});
              void runtime.start(displayId);
              lastFrameAt = now(); reason = 'calibration_required';
            } else if (event.type === 'frame') {
              const frame = parseFrame(event.payload);
              if (!frame || frame.displayId !== displayId || Math.abs(Date.parse(frame.capturedAt) - now()) > 5_000) return;
              lastFrameAt = now(); quality = frame.quality;
              runtime?.ingest(frame);
              if (target && frames.length < 24 && now() >= target.readyAt) {frames.push(frame); target.frames = frames.length;}
            }
          }, () => {if (generation === revision) stop('camera_disconnected');});
          startupTimer = setTimeout(() => {if (generation === revision && !runtime) stop('camera_timeout');}, 10_000);
          startupTimer.unref();
        } else if (request.command === 'beginCalibration') {
          if (!runtime || project !== projectId || !display()) throw Error('camera_unavailable');
          calibrationArrangement = JSON.stringify(display());
          points = []; validationPoints = []; setTarget(0);
        } else if (request.command === 'nextCalibration') {
          if (!target || project !== projectId || !runtime || !display()) throw Error('calibration_required');
          if (JSON.stringify(display()) !== calibrationArrangement) {target = null; frames = []; points = []; validationPoints = []; throw Error('display_unavailable');}
          if (now() < target.readyAt) throw Error('target_duration');
          if (frames.filter((frame) => frame.eyesVisible && frame.quality >= .5 && frame.features.ear >= .15).length < 2) throw Error('insufficient_pupil_evidence');
          const point = {targetId: `target-${target.index}`, x: target.x, y: target.y, frames: frames.slice()};
          (target.heldOut ? validationPoints : points).push(point);
          const index = target.index + 1;
          if (index === POSITIONS.length) {
            const calibration = runtime.calibrate({displayId: displayId!, points, validationPoints});
            target = null; frames = []; points = []; validationPoints = [];
            return {ok: calibration.accepted, status: status(), calibration};
          }
          setTarget(index);
        } else if (request.command !== 'status' && request.command !== 'start') throw Error('invalid_request');
        const currentStatus = status();
        const latest = currentStatus.state === 'active' ? runtime?.samples().at(-1) : null;
        return {ok: true, status: currentStatus, displays: options.displays().slice(0, 16), ...(target ? {target: {...target}} : {}), calibration: runtime?.activeCalibration() ?? null, quality, dedicatedDevice: 'adapter_not_bundled', ...(latest ? {latestSample: latest} : {})};
      } catch (error) {
        const allowed = new Set(['inactive_project','invalid_request','helper_missing','camera_enable_required','display_unavailable','camera_unavailable','calibration_required','target_duration','insufficient_pupil_evidence']);
        const message = error instanceof Error ? error.message : '';
        if (requestFailedStartup(message)) stop(message);
        return {ok: false, error: allowed.has(message) ? message : 'camera_unavailable', status: status(), ...(target ? {target: {...target}} : {})};
      }
    },
  };
  function requestFailedStartup(message: string) {return message === 'helper_missing' || (!runtime && !transport && reason === 'camera_starting');}
}
