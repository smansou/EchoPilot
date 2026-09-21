/**
 * G03 acceptance oracle — dedicated device → calibrated desktop gaze → same resolver and action
 * rules (IMPLEMENTATION_PLAN.md §7.2 G03; §5.11 gaze estimation and target fusion; BACKLOG.json G03).
 *
 * `packages/gaze/src/devices/index.ts` must export (this file freezes exactly these names):
 *
 *   createDedicatedGazeDevice({ now, displays, bridge, persist? }) → DedicatedGazeDeviceRuntime
 *
 *     The optional Tobii Pro Fusion adapter's TypeScript seam. It publishes the same §5.11 gaze
 *     schema the webcam runtime publishes, so the shared resolver and the G02 confirmation/action
 *     rules consume device evidence without a second pipeline:
 *
 *     bridge — the native GazeTobii helper as a value, never frames:
 *       combination: { deviceModel, sdkName, sdkVersion, platform, osVersion, architecture } —
 *         the exact combination that was qualified, echoed by the helper;
 *       connect() → Promise<{ connected: true } | { connected: false, reason }> — a missing
 *         device, missing SDK or denied permission is a value, never a throw;
 *       disconnect() → Promise<void> — stops the device stream;
 *       onDisconnect(listener) → unsubscribe — the helper reports USB removal/crash here. The
 *         runtime must act synchronously in this listener: the disconnect invalidates gaze
 *         immediately (status(), samples(), activeCalibration() and ingest() reflect it before
 *         any further await).
 *     now — deterministic clock (status/record timestamps come from it).
 *     displays.current(displayId) → DisplayTransform | null — the live display arrangement.
 *     persist?(record) — diagnostic sink; only sample/calibration/status metadata may reach it.
 *
 *     observation (the shape the native helper publishes per sample) →
 *       { capturedAt, displayId, gazeX, gazeY, leftValidity, rightValidity }
 *       gazeX/gazeY are normalized [0,1] display coordinates; validity is 0..1 per eye. An
 *       observation whose validities are below the usable threshold is not a measurement
 *       (mirrors the webcam frame-quality rejection) and is counted as rejected, never fitted.
 *
 *     runtime:
 *       connect({ displayId }) → Promise<GazeRuntimeStatus> — never rejects. A refused bridge
 *         returns { state: 'unavailable', reason } with the bridge's reason ('device_missing',
 *         'sdk_missing', …); a successful connect returns { state: 'active', displayId }.
 *       disconnect() → Promise<void> — stops the device (bridge.disconnect()), unsubscribes and
 *         invalidates gaze immediately; status() then reports 'device_disconnected'.
 *       status() → GazeRuntimeStatus — 'device_disconnected' after a disconnect, the bridge
 *         refusal reason after a refused connect, otherwise the active/calibrated state.
 *       calibrate({ displayId, points, validationPoints }) → CalibrationRecord — per-display
 *         device calibration. points: nine screen targets whose observations carry the device's
 *         raw gaze; validationPoints: held-out targets. The fitted per-display correction maps
 *         the device's raw point into desktop logical points, and the record's residual covariance
 *         comes from the held-out targets. Every input observation is counted exactly once in
 *         framesUsed or framesRejected; a fit that cannot be trusted is accepted: false with
 *         reason 'calibration_failed' and produces no active calibration.
 *       activeCalibration() → CalibrationRecord | null — per display; null after a disconnect or
 *         a rejected fit, and a later reconnect requires a fresh calibration (generation grows).
 *       ingest(observation) → GazeSample | null — the §5.11 schema exactly:
 *         { timestamp, displayId, meanX, meanY, covariance2x2, quality, calibrationGeneration,
 *           displayTransform }
 *         timestamp equals observation.capturedAt; meanX/meanY are corrected desktop logical
 *         points; covariance2x2 is symmetric and finite; quality is in (0, 1]; the sample carries
 *         the transform it was produced under. null while there is no active calibration, for an
 *         uncalibrated display, or after a disconnect.
 *       samples() → readonly GazeSample[] — the bounded ten-second ring, cleared by a disconnect.
 *
 *   qualifyDeviceCombination({ combination, bridge, display, probe }) → Promise<DeviceQualification>
 *     Runs the actual qualification for one combination against the live bridge:
 *       checks always include 'combination_support' (device model + SDK + OS + architecture),
 *       'handshake' (bridge.connect() inside the qualification) and 'schema_mapping' (the probe
 *       observation `{ gazeX, gazeY }` mapped through `display` into desktop logical points);
 *       supported: true only when every check passed and the combination is part of the tested
 *       support matrix — a consumer Tobii device, an untested SDK version or an untested OS is
 *       rejected with 'unsupported_device_model' / 'unsupported_sdk_version' /
 *       'unsupported_os_version' / 'unsupported_platform';
 *       probe: the mapped logical point (or null when mapping was not attempted).
 *
 *   listSupportedDeviceCombinations() → readonly DeviceCombination[]
 *     The published support list. It is a claim about tests, so this oracle re-runs a qualification
 *     for every published combination and for the frozen candidate matrix: every published
 *     combination must qualify as supported here, everything qualified as supported here must be
 *     published, and consumer Tobii devices must never appear.
 *
 * Deterministic rules pinned here (BACKLOG.json G03 acceptance criteria):
 *   1. Device samples map to the shared gaze schema and use the same confirmation path as webcam
 *      input: the corrected sample lands on the intended control, the shared G01 resolver returns
 *      the same decision for device evidence and for webcam-schema evidence of the same scene, and
 *      the G02 coordinator applies the identical fresh target-and-effect confirmation rule (a
 *      device-derived consequential action never writes before a fresh confirmation naming the
 *      target and the effect).
 *   2. Supported device/SDK/OS combinations are exactly the combinations that pass a real
 *      qualification run, and a disconnect invalidates gaze immediately (status, samples,
 *      calibration and ingest all flip without waiting), with a fresh calibration required after
 *      reconnect. A missing device stays a value: named voice targeting keeps working.
 *   3. Device calibration failures stay separated from working sessions: a rejected fit produces
 *      no active calibration, no samples, and names 'calibration_failed'.
 *
 * Frozen fixture: `packages/gaze/src/devices/fixtures/g03-tobii-session.json` — a fully synthetic
 * dedicated-device session (normalized gaze metadata only, no hardware, no SDK, no user data) with
 * a nine-target calibration, five held-out targets, one fixation on the published control, a
 * rejected all-invalid calibration and a six-row qualification matrix.
 *
 * Remaining limitation this oracle reports instead of claiming: the real Tobii Pro Fusion C SDK
 * linkage, USB/device enumeration on real hardware, per-display physical setup and the 20-person
 * §5.11 study are interactive/hardware qualifications; this oracle proves the seam contract
 * deterministically against a bridge double and leaves that evidence to the release pass.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createGazeActionCoordinator } from '../../../desktop-tools/src/gaze-actions/index.js';
import { createReferenceResolver } from '../resolution.js';
import type {
  CalibrationRecord,
  CandidateControl,
  DisplayTransform,
  GazeEvidence,
  GazeRuntimeStatus,
  GazeSample,
  ResolveOutcome,
} from '../types.js';

const FIXTURE_URL = new URL('./fixtures/g03-tobii-session.json', import.meta.url);
/** The fixture's device observations start at this instant; the injected clock sits after them. */
const CLOCK_AFTER_SESSION = '2026-09-21T10:00:30.000Z';
/** §5.11: read-only resolution requires calibrated top probability ≥ 0.80 and a ≥ 0.20 margin. */
const READ_ONLY_CONFIDENCE = 0.8;
const READ_ONLY_MARGIN = 0.2;

type FixtureObservation = Readonly<{
  capturedAt: string;
  displayId: string;
  gazeX: number;
  gazeY: number;
  leftValidity: number;
  rightValidity: number;
}>;

type FixtureCalibrationPoint = Readonly<{
  targetId: string;
  x: number;
  y: number;
  observations: readonly FixtureObservation[];
}>;

type FixtureCalibration = Readonly<{
  displayId: string;
  targets: readonly FixtureCalibrationPoint[];
  validationTargets: readonly FixtureCalibrationPoint[];
}>;

type FixtureCombination = Readonly<{
  deviceModel: string;
  sdkName: string;
  sdkVersion: string;
  platform: string;
  osVersion: string;
  architecture: string;
}>;

type FixtureBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
type FixtureCandidate = CandidateControl & Readonly<{ targetRef: string }>;
type FixtureRequestUtterance = Readonly<{ utteranceId: string; turnId: string; text: string; wordAt: string }>;
type FixtureUtterance = Readonly<{ utteranceId: string; text: string; turnId?: string; wordAt?: string }>;

type FixtureControl = Readonly<{
  ref: string;
  windowTitle: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  bounds: FixtureBounds;
}>;

type Fixture = Readonly<{
  fixtureId: string;
  provenance: string;
  display: DisplayTransform;
  sideDisplay: DisplayTransform;
  device: Readonly<{ deviceId: string; combination: FixtureCombination }>;
  qualification: Readonly<{
    probe: Readonly<{ gazeX: number; gazeY: number }>;
    expectedProbePoint: Readonly<{ x: number; y: number }>;
    combinations: readonly Readonly<{ combination: FixtureCombination; supported: boolean; reason?: string }>[];
  }>;
  calibration: FixtureCalibration;
  failedCalibration: FixtureCalibration;
  speech: Readonly<{
    deictic: FixtureRequestUtterance;
    named: FixtureRequestUtterance;
    confirmation: FixtureUtterance;
    confirmationTargetOnly: FixtureUtterance;
    confirmationGeneric: FixtureUtterance;
    confirmationRepeat: FixtureUtterance;
  }>;
  request: Readonly<{ requestId: string; stepId: string; value: string }>;
  fixations: Readonly<{ publish: Readonly<{ observations: readonly FixtureObservation[] }> }>;
  candidates: readonly FixtureCandidate[];
  controls: readonly FixtureControl[];
  webcamParity: Readonly<{ calibration: CalibrationRecord; samples: readonly GazeSample[] }>;
  canary: Readonly<{ observationField: string; value: string }>;
}>;

/** The bridge the native GazeTobii helper implements; this oracle drives a deterministic double. */
type DeviceConnection = Readonly<{ connected: true }> | Readonly<{ connected: false; reason: string }>;

type DeviceBridge = Readonly<{
  combination: FixtureCombination;
  connect(): Promise<DeviceConnection>;
  disconnect(): Promise<void>;
  onDisconnect(listener: (reason: string) => void): () => void;
}>;

type DeviceQualificationCheck = Readonly<{ checkId: string; status: 'passed' | 'failed'; detail: string }>;

type DeviceQualification = Readonly<{
  combination: FixtureCombination;
  supported: boolean;
  reason?: string;
  checks: readonly DeviceQualificationCheck[];
  probe: Readonly<{ meanX: number; meanY: number }> | null;
}>;

type DedicatedGazeDeviceRuntime = Readonly<{
  connect(input: Readonly<{ displayId: string }>): Promise<GazeRuntimeStatus>;
  disconnect(): Promise<void>;
  status(): GazeRuntimeStatus;
  calibrate(input: Readonly<{
    displayId: string;
    points: readonly FixtureCalibrationPoint[];
    validationPoints: readonly FixtureCalibrationPoint[];
  }>): CalibrationRecord;
  activeCalibration(): CalibrationRecord | null;
  ingest(observation: FixtureObservation): GazeSample | null;
  samples(): readonly GazeSample[];
}>;

type DedicatedGazeDeviceModule = Readonly<{
  createDedicatedGazeDevice(options: Readonly<{
    now: () => Date;
    displays: Readonly<{ current(displayId: string): DisplayTransform | null }>;
    bridge: DeviceBridge;
    persist?: (record: Record<string, unknown>) => void;
  }>): DedicatedGazeDeviceRuntime;
  qualifyDeviceCombination(input: Readonly<{
    combination: FixtureCombination;
    bridge: DeviceBridge;
    display: DisplayTransform;
    probe: Readonly<{ gazeX: number; gazeY: number }>;
  }>): Promise<DeviceQualification>;
  listSupportedDeviceCombinations(): readonly FixtureCombination[];
}>;

const MISSING_BEHAVIOR = 'G03 required dedicated-device behavior is not implemented yet: '
  + 'packages/gaze/src/devices/index.ts must export createDedicatedGazeDevice({ now, displays, '
  + 'bridge, persist? }) returning connect, disconnect, status, calibrate, activeCalibration, '
  + 'ingest and samples over the shared gaze schema, plus qualifyDeviceCombination and '
  + 'listSupportedDeviceCombinations.';

/** Until the implementation exists every test fails with the missing behavior, never a crash. */
function missingModule(detail: string): DedicatedGazeDeviceModule {
  const fail = (): never => assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
  return {
    createDedicatedGazeDevice: fail,
    qualifyDeviceCombination: fail,
    listSupportedDeviceCombinations: fail,
  };
}

async function loadDeviceModule(): Promise<DedicatedGazeDeviceModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  const exported = ['createDedicatedGazeDevice', 'qualifyDeviceCombination', 'listSupportedDeviceCombinations'];
  for (const name of exported) {
    if (typeof loaded[name] !== 'function') return missingModule(`${name} is not exported`);
  }
  return loaded as unknown as DedicatedGazeDeviceModule;
}

const devices = await loadDeviceModule();
const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
const resolver = createReferenceResolver();

function control(ref: string): FixtureControl {
  const found = fixture.controls.find((entry) => entry.ref === ref);
  assert.ok(found, `fixture control ${ref} must exist`);
  return found;
}

function sameCombination(left: FixtureCombination, right: FixtureCombination): boolean {
  return left.deviceModel === right.deviceModel
    && left.sdkName === right.sdkName
    && left.sdkVersion === right.sdkVersion
    && left.platform === right.platform
    && left.osVersion === right.osVersion
    && left.architecture === right.architecture;
}

type FakeBridge = DeviceBridge & Readonly<{
  connectCalls(): number;
  disconnectCalls(): number;
  listenerCount(): number;
  emitDisconnect(reason: string): void;
}>;

/** The native helper double: connect/disconnect are values, the disconnect event is synchronous. */
function deviceBridge(options: Readonly<{
  combination: FixtureCombination;
  refuseReason?: string;
}>): FakeBridge {
  const listeners = new Set<(reason: string) => void>();
  let connects = 0;
  let disconnects = 0;
  return {
    combination: options.combination,
    async connect(): Promise<DeviceConnection> {
      connects += 1;
      return options.refuseReason === undefined
        ? { connected: true }
        : { connected: false, reason: options.refuseReason };
    },
    async disconnect(): Promise<void> {
      disconnects += 1;
    },
    onDisconnect(listener: (reason: string) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connectCalls: () => connects,
    disconnectCalls: () => disconnects,
    listenerCount: () => listeners.size,
    emitDisconnect(reason: string): void {
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

type DeviceSession = Readonly<{
  runtime: DedicatedGazeDeviceRuntime;
  bridge: FakeBridge;
  persisted: Array<Record<string, unknown>>;
}>;

function deviceSession(options: Readonly<{ refuseReason?: string }> = {}): DeviceSession {
  const persisted: Array<Record<string, unknown>> = [];
  const bridge = deviceBridge({
    combination: fixture.device.combination,
    ...(options.refuseReason === undefined ? {} : { refuseReason: options.refuseReason }),
  });
  const runtime = devices.createDedicatedGazeDevice({
    now: () => new Date(CLOCK_AFTER_SESSION),
    displays: {
      current: (displayId: string) => {
        if (displayId === fixture.display.displayId) return fixture.display;
        if (displayId === fixture.sideDisplay.displayId) return fixture.sideDisplay;
        return null;
      },
    },
    bridge,
    persist: (record) => {
      persisted.push(record);
    },
  });
  return { runtime, bridge, persisted };
}

function expectActive(status: GazeRuntimeStatus, detail: string): void {
  assert.equal(status.state, 'active', `${detail}: ${JSON.stringify(status)}`);
}

function expectUnavailable(status: GazeRuntimeStatus, reason: string, detail: string): void {
  assert.equal(status.state, 'unavailable', `${detail}: ${JSON.stringify(status)}`);
  assert.equal(status.reason, reason, `${detail}: names ${reason}`);
}

async function connectedSession(): Promise<DeviceSession> {
  const session = deviceSession();
  const status = await session.runtime.connect({ displayId: fixture.display.displayId });
  expectActive(status, 'a connect over a live bridge is active');
  return session;
}

function calibrateAccepted(session: DeviceSession): CalibrationRecord {
  const record = session.runtime.calibrate({
    displayId: fixture.calibration.displayId,
    points: fixture.calibration.targets,
    validationPoints: fixture.calibration.validationTargets,
  });
  assert.equal(record.accepted, true, `the fixture calibration is a usable device calibration: ${JSON.stringify(record)}`);
  return record;
}

/** Ingest with a canary field attached: the runtime must publish schema samples, never the payload. */
function ingestObservations(
  session: DeviceSession,
  observations: readonly FixtureObservation[],
): readonly GazeSample[] {
  return observations.map((observation) => {
    const carried = { ...observation, [fixture.canary.observationField]: fixture.canary.value };
    const sample = session.runtime.ingest(carried);
    assert.ok(sample, `the device runtime publishes a sample for ${observation.capturedAt}`);
    return sample;
  });
}

function deviceEvidence(session: DeviceSession, record: CalibrationRecord): GazeEvidence {
  return {
    samples: ingestObservations(session, fixture.fixations.publish.observations),
    calibration: record,
  };
}

function resolveScene(evidence: GazeEvidence | null, phrase: FixtureRequestUtterance): ResolveOutcome {
  return resolver.resolve({
    utteranceId: phrase.utteranceId,
    turnId: phrase.turnId,
    phrase: { text: phrase.text, wordAt: phrase.wordAt },
    candidates: fixture.candidates,
    gaze: evidence,
  });
}

/** The decision-level fields two evidence sources must agree on through the shared resolver. */
function decision(outcome: ResolveOutcome): Readonly<Record<string, unknown>> {
  return {
    outcome: outcome.outcome,
    targetId: outcome.targetId ?? null,
    basis: outcome.basis,
    gazeUsed: outcome.gazeUsed,
    candidateIds: [...outcome.candidateIds],
  };
}

type AxControl = Readonly<{
  appBundleId: string;
  windowTitle: string;
  role: string;
  label: string;
  value: string;
  enabled: boolean;
  focused: boolean;
  bounds: FixtureBounds;
  fingerprint: string;
}>;

type FakeAx = Readonly<{
  writes: ReadonlyArray<Readonly<{ targetRef: string; value: string }>>;
  fingerprintOf(targetRef: string): string;
  valueOf(targetRef: string): string;
  inspect(targetRef: string): Promise<AxControl | null>;
  setValue(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
}>;

function fakeAx(): FakeAx {
  const controls = new Map<string, FixtureControl>(fixture.controls.map((entry) => [entry.ref, { ...entry }]));
  const writes: Array<{ targetRef: string; value: string }> = [];
  const require = (targetRef: string): FixtureControl => {
    const found = controls.get(targetRef);
    if (!found) throw new Error(`G03 oracle: unknown fixture control ${targetRef}`);
    return found;
  };
  // The G02 target identity: window/label identity plus the on-screen rectangle.
  const fingerprint = (entry: FixtureControl): string => [
    'g03',
    fixture.display.displayId,
    entry.windowTitle,
    entry.role,
    entry.label,
    entry.bounds.x,
    entry.bounds.y,
    entry.bounds.width,
    entry.bounds.height,
  ].join('|');
  return {
    writes,
    fingerprintOf: (targetRef: string) => fingerprint(require(targetRef)),
    valueOf: (targetRef: string) => require(targetRef).value,
    async inspect(targetRef: string) {
      const found = controls.get(targetRef);
      if (!found) return null;
      return {
        appBundleId: 'com.echopilot.g03',
        windowTitle: found.windowTitle,
        role: found.role,
        label: found.label,
        value: found.value,
        enabled: found.enabled,
        focused: found.focused,
        bounds: { ...found.bounds },
        fingerprint: fingerprint(found),
      };
    },
    async setValue({ targetRef, value }: Readonly<{ targetRef: string; value: string }>) {
      writes.push({ targetRef, value });
      controls.set(targetRef, { ...require(targetRef), value });
    },
  };
}

type Coordinator = ReturnType<typeof createGazeActionCoordinator>;
type ProposeResult = Awaited<ReturnType<Coordinator['propose']>>;
type ConfirmationResult = Awaited<ReturnType<Coordinator['confirm']>>;
type ActionReceipt = Awaited<ReturnType<Coordinator['advance']>>;

type ActionRun = Readonly<{ coordinator: Coordinator; ax: FakeAx }>;

function actionRun(): ActionRun {
  const ax = fakeAx();
  const coordinator = createGazeActionCoordinator({
    ax,
    now: () => new Date('2026-09-21T10:00:05.000Z'),
    scope: { profileId: 'g03', projectId: 'g03-project', sensitivity: 'normal' },
  });
  return { coordinator, ax };
}

function proposeConsequential(run: ActionRun, evidence: GazeEvidence): Promise<ProposeResult> {
  return run.coordinator.propose({
    requestId: fixture.request.requestId,
    utterance: fixture.speech.deictic,
    candidates: fixture.candidates,
    gaze: evidence,
    effect: 'local_write',
    step: { stepId: fixture.request.stepId, value: fixture.request.value },
  });
}

function expectProposal(result: ProposeResult): Extract<ProposeResult, { kind: 'proposal' }> {
  if (result.kind === 'proposal') return result;
  throw new Error(`G03 oracle: expected a resolved proposal, got a ${result.kind}: ${JSON.stringify(result)}`);
}

function expectRefusal(result: ConfirmationResult, reason: string): void {
  assert.equal(result.confirmed, false, `the confirmation is refused: ${JSON.stringify(result)}`);
  if (!result.confirmed) assert.equal(result.reason, reason, 'the refusal names the reason');
}

function stepOf(receipt: ActionReceipt, stepId: string): ActionReceipt['steps'][number] {
  const step = receipt.steps.find((candidate) => candidate.stepId === stepId);
  assert.ok(step, `the receipt reports step ${stepId}: ${JSON.stringify(receipt.steps)}`);
  return step;
}

/**
 * The full consequential sequence for one evidence source: propose → refused confirmations →
 * fresh target-and-effect confirmation → one verified write → the consumed proposal is inert.
 * Returns the decision-level shape so device and webcam evidence can be compared field by field.
 */
async function runConsequentialSequence(evidence: GazeEvidence): Promise<Readonly<Record<string, unknown>>> {
  const run = actionRun();
  const proposed = expectProposal(await proposeConsequential(run, evidence));
  const { proposal } = proposed;
  assert.equal(proposal.targetRef, 'ax-publish', 'the gaze-derived target is the published control');
  assert.equal(proposal.gazeUsed, true, 'the resolution used gaze evidence');
  assert.equal(proposal.requiresConfirmation, true, 'a consequential gaze-derived action requires confirmation');
  assert.equal(run.ax.writes.length, 0, 'resolution alone never writes');

  const before = await run.coordinator.advance({ proposalId: proposal.proposalId });
  assert.equal(before.status, 'denied', 'an unconfirmed advance is denied');
  assert.equal(before.reason, 'confirmation_required', 'the guard is the missing confirmation');
  assert.equal(run.ax.writes.length, 0, 'an unconfirmed advance never writes');

  expectRefusal(await run.coordinator.confirm({
    proposalId: proposal.proposalId,
    utterance: fixture.speech.confirmationGeneric,
  }), 'target_not_named');
  expectRefusal(await run.coordinator.confirm({
    proposalId: proposal.proposalId,
    utterance: fixture.speech.confirmationTargetOnly,
  }), 'effect_not_named');

  const accepted = await run.coordinator.confirm({
    proposalId: proposal.proposalId,
    utterance: fixture.speech.confirmation,
  });
  assert.equal(accepted.confirmed, true, `the target-and-effect utterance confirms: ${JSON.stringify(accepted)}`);

  const receipt = await run.coordinator.advance({ proposalId: proposal.proposalId });
  assert.equal(receipt.status, 'completed', `the confirmed action completes: ${JSON.stringify(receipt)}`);
  assert.deepEqual(
    [...run.ax.writes],
    [{ targetRef: 'ax-publish', value: fixture.request.value }],
    'exactly one verified write reaches the control',
  );
  const step = stepOf(receipt, fixture.request.stepId);
  assert.deepEqual(
    { status: step.status, before: step.before, after: step.after },
    { status: 'completed', before: control('ax-publish').value, after: fixture.request.value },
    'the step is verified by read-back',
  );
  assert.deepEqual(
    [...step.evidenceIds],
    [`act:before:${fixture.request.stepId}`, `act:after:${fixture.request.stepId}`],
    'the read-back evidence is bound to the step',
  );

  const replayed = await run.coordinator.advance({ proposalId: proposal.proposalId });
  assert.equal(replayed.status, 'denied', 'a consumed proposal cannot execute twice');
  assert.equal(run.ax.writes.length, 1, 'the second advance performs no write');

  return {
    targetRef: proposal.targetRef,
    requiresConfirmation: proposal.requiresConfirmation,
    basis: proposal.basis,
    gazeUsed: proposal.gazeUsed,
    confirmationAccepted: accepted.confirmed,
    receiptStatus: receipt.status,
    stepStatus: step.status,
    evidenceIds: [...step.evidenceIds],
  };
}

test('G03-A1 device observations map to the shared gaze schema in desktop logical points', async () => {
  const session = await connectedSession();
  const record = calibrateAccepted(session);

  const observations = fixture.calibration.targets.flatMap((point) => point.observations);
  assert.equal(
    record.framesUsed + record.framesRejected,
    observations.length,
    'every calibration observation is counted exactly once as used or rejected',
  );
  assert.ok(record.framesUsed >= observations.length / 2, `the fixture session fits its calibration: ${JSON.stringify(record)}`);
  assert.ok(
    Number.isFinite(record.residualCovariance2x2[0][0]) && Number.isFinite(record.residualCovariance2x2[1][1]),
    'the held-out residual covariance is a finite estimate',
  );

  const samples = ingestObservations(session, fixture.fixations.publish.observations);
  for (const [index, sample] of samples.entries()) {
    const observation = fixture.fixations.publish.observations[index]!;
    assert.deepEqual(
      Object.keys(sample).sort(),
      ['timestamp', 'displayId', 'meanX', 'meanY', 'covariance2x2', 'quality', 'calibrationGeneration', 'displayTransform'].sort(),
      'a device sample is exactly the shared §5.11 gaze schema',
    );
    assert.equal(sample.timestamp, observation.capturedAt, 'the sample timestamp is the device timestamp');
    assert.equal(sample.displayId, observation.displayId, 'the sample names its display');
    assert.deepEqual(sample.displayTransform, fixture.display, 'the sample carries the transform it was produced under');
    assert.equal(sample.calibrationGeneration, record.calibrationGeneration, 'the sample binds the active calibration generation');
    assert.ok(Number.isFinite(sample.meanX) && Number.isFinite(sample.meanY), 'the corrected point is finite');
    const publish = control('ax-publish').bounds;
    assert.ok(
      sample.meanX >= publish.x && sample.meanX <= publish.x + publish.width
      && sample.meanY >= publish.y && sample.meanY <= publish.y + publish.height,
      `the calibrated device point lands on the intended control: ${JSON.stringify(sample)}`,
    );
    assert.equal(sample.covariance2x2[0][1], sample.covariance2x2[1][0], 'the covariance is symmetric');
    assert.ok(sample.quality > 0 && sample.quality <= 1, 'quality is a fraction in (0, 1]');
    assert.ok(!JSON.stringify(sample).includes(fixture.canary.value), 'the observation payload never reaches a sample');
  }

  assert.ok(session.persisted.length > 0, 'the runtime reports calibration/sample metadata to the persistence sink');
  assert.ok(
    !JSON.stringify(session.persisted).includes(fixture.canary.value),
    'the diagnostic sink only ever sees metadata, never the observation payload',
  );
  assert.ok(
    !JSON.stringify(session.persisted).includes('gazeX'),
    'the diagnostic sink does not persist raw normalized device coordinates',
  );
});

test('G03-A2 device evidence and webcam evidence resolve identically through the shared resolver', async () => {
  const session = await connectedSession();
  const record = calibrateAccepted(session);

  const deviceOutcome = resolveScene(deviceEvidence(session, record), fixture.speech.deictic);
  const webcamOutcome = resolveScene(fixture.webcamParity, fixture.speech.deictic);

  assert.equal(deviceOutcome.outcome, 'resolved', `the device fixation resolves: ${JSON.stringify(deviceOutcome)}`);
  assert.equal(deviceOutcome.targetId, 'c-publish', 'the device fixation resolves the intended control');
  assert.equal(deviceOutcome.basis, 'gaze', 'the resolution is gaze-based');
  assert.equal(deviceOutcome.gazeUsed, true, 'the resolution used gaze evidence');
  assert.ok(
    deviceOutcome.confidence >= READ_ONLY_CONFIDENCE && deviceOutcome.margin >= READ_ONLY_MARGIN,
    `the device fixation clears the read-only thresholds: ${JSON.stringify(deviceOutcome)}`,
  );
  assert.deepEqual(
    decision(deviceOutcome),
    decision(webcamOutcome),
    'the same scene decides the same way whether the evidence came from the device or the webcam schema',
  );
});

test('G03-A3 a device-derived consequential action follows the same fresh confirmation path as webcam input', async () => {
  const session = await connectedSession();
  const record = calibrateAccepted(session);
  const device = await runConsequentialSequence(deviceEvidence(session, record));
  const webcam = await runConsequentialSequence(fixture.webcamParity);

  assert.deepEqual(device, webcam, 'device and webcam evidence follow the identical confirmation and action rules');
  assert.deepEqual(device, {
    targetRef: 'ax-publish',
    requiresConfirmation: true,
    basis: 'gaze',
    gazeUsed: true,
    confirmationAccepted: true,
    receiptStatus: 'completed',
    stepStatus: 'completed',
    evidenceIds: [`act:before:${fixture.request.stepId}`, `act:after:${fixture.request.stepId}`],
  });
});

test('G03-A4 every device-derived action needs its own fresh confirmation utterance', async () => {
  const session = await connectedSession();
  const record = calibrateAccepted(session);
  const evidence = deviceEvidence(session, record);
  const run = actionRun();

  const first = expectProposal(await proposeConsequential(run, evidence));
  const firstConfirmation = await run.coordinator.confirm({
    proposalId: first.proposal.proposalId,
    utterance: fixture.speech.confirmation,
  });
  assert.equal(firstConfirmation.confirmed, true, 'the first action is confirmed');
  assert.equal(
    (await run.coordinator.advance({ proposalId: first.proposal.proposalId })).status,
    'completed',
    'the first action completes',
  );

  const second = expectProposal(await run.coordinator.propose({
    requestId: 'req-2',
    utterance: fixture.speech.deictic,
    candidates: fixture.candidates,
    gaze: evidence,
    effect: 'local_write',
    step: { stepId: 'step-publish-2', value: fixture.request.value },
  }));
  expectRefusal(await run.coordinator.confirm({
    proposalId: second.proposal.proposalId,
    utterance: fixture.speech.confirmation,
  }), 'confirmation_replayed');
  assert.equal(run.ax.writes.length, 1, 'the utterance that confirmed the first action cannot confirm the second');

  const fresh = await run.coordinator.confirm({
    proposalId: second.proposal.proposalId,
    utterance: fixture.speech.confirmationRepeat,
  });
  assert.equal(fresh.confirmed, true, 'a distinct fresh utterance confirms the new action');
  assert.equal(
    (await run.coordinator.advance({ proposalId: second.proposal.proposalId })).status,
    'completed',
    'the freshly confirmed second action completes',
  );
  assert.deepEqual(
    [...run.ax.writes],
    [
      { targetRef: 'ax-publish', value: fixture.request.value },
      { targetRef: 'ax-publish', value: fixture.request.value },
    ],
    'each action performs exactly its own single verified write',
  );
  expectRefusal(await run.coordinator.confirm({
    proposalId: second.proposal.proposalId,
    utterance: fixture.speech.confirmationRepeat,
  }), 'proposal_consumed');
});

test('G03-B1 the supported device/SDK/OS list is exactly what real qualification runs pass', async () => {
  const supportedHere: FixtureCombination[] = [];
  for (const candidate of fixture.qualification.combinations) {
    const result = await devices.qualifyDeviceCombination({
      combination: candidate.combination,
      bridge: deviceBridge({ combination: candidate.combination }),
      display: fixture.display,
      probe: fixture.qualification.probe,
    });
    assert.deepEqual(result.combination, candidate.combination, 'the qualification echoes the combination it ran');
    assert.ok(result.checks.length >= 3, `the qualification executes its checks: ${JSON.stringify(result.checks)}`);
    for (const check of result.checks) {
      assert.ok(check.checkId.length > 0 && check.detail.length > 0, 'every check is identified and explained');
      assert.deepEqual(['combination_support', 'handshake', 'schema_mapping'].includes(check.checkId), true,
        `the frozen check ids cover the qualification: ${check.checkId}`);
    }
    if (candidate.supported) {
      supportedHere.push(candidate.combination);
      assert.equal(result.supported, true, `the tested combination is supported: ${JSON.stringify(result)}`);
      assert.ok(!result.reason, 'a supported combination carries no rejection reason');
      assert.deepEqual(
        result.checks.map((check) => check.status),
        result.checks.map(() => 'passed'),
        'every qualification check passes for a supported combination',
      );
      assert.ok(result.probe, 'the supported qualification maps its probe observation');
      assert.ok(
        Math.abs(result.probe.meanX - fixture.qualification.expectedProbePoint.x) <= 0.5
        && Math.abs(result.probe.meanY - fixture.qualification.expectedProbePoint.y) <= 0.5,
        `the probe maps through the display transform: ${JSON.stringify(result.probe)}`,
      );
    } else {
      assert.equal(result.supported, false, `the untested combination is refused: ${JSON.stringify(result)}`);
      assert.equal(result.reason, candidate.reason, 'the refusal names the exact unmet qualification');
      assert.ok(
        result.checks.some((check) => check.status === 'failed'),
        'the refusal is backed by a failed executed check',
      );
    }
  }

  const refusedBridge = await devices.qualifyDeviceCombination({
    combination: fixture.device.combination,
    bridge: deviceBridge({ combination: fixture.device.combination, refuseReason: 'device_missing' }),
    display: fixture.display,
    probe: fixture.qualification.probe,
  });
  assert.equal(refusedBridge.supported, false, 'a bridge that cannot connect never qualifies a combination');
  assert.equal(refusedBridge.reason, 'device_missing', 'the handshake refusal is carried through');

  const published = devices.listSupportedDeviceCombinations();
  assert.ok(published.length > 0, 'at least one combination is published as supported');
  for (const combination of published) {
    const result = await devices.qualifyDeviceCombination({
      combination,
      bridge: deviceBridge({ combination }),
      display: fixture.display,
      probe: fixture.qualification.probe,
    });
    assert.equal(
      result.supported,
      true,
      `every published combination passes a real qualification run here: ${JSON.stringify(combination)}`,
    );
  }
  for (const combination of supportedHere) {
    assert.ok(
      published.some((entry) => sameCombination(entry, combination)),
      `the support list reports what this run qualified: ${JSON.stringify(combination)}`,
    );
  }
  assert.ok(
    !published.some((combination) => combination.deviceModel === 'tobii-eye-tracker-5'),
    'support is never extrapolated to consumer Tobii devices',
  );
});

test('G03-B2 a device disconnect invalidates gaze immediately and a reconnect needs a fresh calibration', async () => {
  const session = await connectedSession();
  const record = calibrateAccepted(session);
  ingestObservations(session, fixture.fixations.publish.observations);
  assert.equal(session.runtime.samples().length, fixture.fixations.publish.observations.length, 'the ring holds the fixation samples');
  assert.equal(session.bridge.listenerCount(), 1, 'the runtime listens for the helper disconnect');
  assert.equal(session.runtime.activeCalibration()?.calibrationGeneration, record.calibrationGeneration);

  session.bridge.emitDisconnect('usb_removed');

  const removed = session.runtime.status();
  assert.equal(removed.state, 'unavailable', `the helper disconnect flips the status without waiting: ${JSON.stringify(removed)}`);
  assert.ok(
    typeof removed.reason === 'string' && removed.reason.length > 0,
    'the helper disconnect names a reason',
  );
  assert.deepEqual([...session.runtime.samples()], [], 'the disconnect clears the sample ring');
  assert.equal(session.runtime.activeCalibration(), null, 'the disconnect invalidates the calibration');
  assert.equal(
    session.runtime.ingest(fixture.fixations.publish.observations[0]!),
    null,
    'a disconnected device produces no samples',
  );

  const stale = resolveScene({ samples: session.runtime.samples(), calibration: record }, fixture.speech.deictic);
  assert.equal(stale.outcome, 'abstain', `stale evidence cannot resolve a target: ${JSON.stringify(stale)}`);
  assert.equal(stale.gazeUsed, false, 'a disconnected device contributes no gaze');
  assert.equal(stale.targetId, undefined, 'nothing is guessed after a disconnect');

  const reconnected = await session.runtime.connect({ displayId: fixture.display.displayId });
  expectActive(reconnected, 'the device can be reconnected');
  assert.equal(session.runtime.activeCalibration(), null, 'a reconnect requires a fresh per-display calibration');
  assert.equal(
    session.runtime.ingest(fixture.fixations.publish.observations[0]!),
    null,
    'an uncalibrated device publishes no samples',
  );

  const failed = session.runtime.calibrate({
    displayId: fixture.failedCalibration.displayId,
    points: fixture.failedCalibration.targets,
    validationPoints: fixture.failedCalibration.validationTargets,
  });
  assert.equal(failed.accepted, false, 'an all-invalid observation set never becomes a calibration');
  assert.equal(failed.reason, 'calibration_failed', 'the rejection names the calibration failure');
  assert.equal(session.runtime.activeCalibration(), null, 'a rejected fit leaves no active calibration');
  assert.equal(
    session.runtime.ingest(fixture.fixations.publish.observations[0]!),
    null,
    'a rejected calibration produces no samples',
  );

  const recalibrated = calibrateAccepted(session);
  assert.ok(
    recalibrated.calibrationGeneration > record.calibrationGeneration,
    'a recalibration is a new generation, not a reuse of the pre-disconnect one',
  );
  const after = ingestObservations(session, fixture.fixations.publish.observations);
  assert.equal(after.length, fixture.fixations.publish.observations.length, 'the recalibrated device publishes samples again');
  assert.deepEqual(
    after.map((sample) => sample.calibrationGeneration),
    fixture.fixations.publish.observations.map(() => recalibrated.calibrationGeneration),
    'samples bind the fresh generation',
  );

  assert.equal(
    session.runtime.ingest({ ...fixture.fixations.publish.observations[0]!, displayId: fixture.sideDisplay.displayId }),
    null,
    'looking at an uncalibrated display is unknown, never the other display calibration',
  );

  await session.runtime.disconnect();
  expectUnavailable(session.runtime.status(), 'device_disconnected', "the runtime's own disconnect reports its reason");
  assert.equal(session.bridge.disconnectCalls(), 1, 'stopping the device stops the helper stream');
  assert.equal(session.bridge.listenerCount(), 0, 'stopping the device unsubscribes from the helper');
  assert.deepEqual([...session.runtime.samples()], [], 'stopping the device clears the ring');
  assert.equal(session.runtime.activeCalibration(), null, 'stopping the device invalidates the calibration');
});

test('G03-B3 a missing device is a value and named voice targeting keeps working', async () => {
  const session = deviceSession({ refuseReason: 'device_missing' });
  const status = await session.runtime.connect({ displayId: fixture.display.displayId });
  expectUnavailable(status, 'device_missing', 'a missing device is reported, not thrown');
  assert.equal(session.runtime.activeCalibration(), null, 'no device means no calibration');
  assert.equal(
    session.runtime.ingest(fixture.fixations.publish.observations[0]!),
    null,
    'no device means no samples',
  );

  const named = resolveScene(null, fixture.speech.named);
  assert.equal(named.outcome, 'resolved', `named targeting keeps working: ${JSON.stringify(named)}`);
  assert.equal(named.targetId, 'c-publish', 'the named control resolves by voice');
  assert.equal(named.basis, 'named', 'the resolution is the shared resolver named path');
  assert.equal(named.gazeUsed, false, 'no gaze is invented for a missing device');
});
