/**
 * V05 evidence for the production hands-free lifecycle.
 *
 * These tests drive `voice-activation.ts` — the module the desktop app actually instantiates —
 * against the real child processes the product spawns: the local conversation worker (stand-in,
 * same stdio protocol) and the signed helper's stand-in (same authenticated wire protocol). The
 * only things faked are the microphone and the ASR pack; every lifecycle step, measurement and
 * report below travels the production path:
 *
 *   enable → ActivationHost → worker residency + helper voice-command/voice-ack
 *   helper frames (standby energy, acoustic windows) → ConversationActivationController
 *   reports → VoiceTelemetrySink → the JSONL file the app writes under userData
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { voiceIndicator, type VoiceControlSnapshot } from '../renderer/control/voice';
import { createNativeHost, type NativeHost } from './native-host';
import { createShell } from './shell';
import type { VoiceTelemetryRecord } from './voice-telemetry';
import { createVoiceActivationService, type VoiceActivationService } from './voice-activation';

const FAKE_HOST = fileURLToPath(new URL('./fake-native-host.ts', import.meta.url));
const FAKE_WORKER = fileURLToPath(new URL('./fake-voice-worker.ts', import.meta.url));
const TOKEN = 'v05-voice-activation-token-00000001';

type Clock = Readonly<{ now(): number; advance(ms: number): void }>;

type Fixture = Readonly<{
  service: VoiceActivationService;
  host: NativeHost;
  /** Present only when the fixture drives a deterministic 20-minute timeline. */
  clock: Clock;
  records(): Promise<VoiceTelemetryRecord[]>;
  waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}>;

function deterministicClock(): Clock {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

/** Real wall-clock time: used where the test must observe real timers renewing or idling a session. */
const realClock: Clock = { now: () => Date.now(), advance: () => {} };

async function startFixture(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ tickIntervalMs?: number; clock?: Clock }> = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-v05-'));
  const telemetryPath = join(directory, 'activation.jsonl');
  const clock = options.clock ?? deterministicClock();
  let host: NativeHost | undefined;
  const shell = createShell({
    token: TOKEN,
    register: () => true,
    writeToHelper: (line) => host?.send(line) === true,
  });
  host = createNativeHost({
    shell,
    token: TOKEN,
    env: { ...process.env, ECHOPILOT_NATIVE_HOST: FAKE_HOST, ...env },
    log: () => {},
  });
  const service = createVoiceActivationService({
    shell,
    telemetryPath,
    env: { ...process.env, ECHOPILOT_VOICE_WORKER: FAKE_WORKER, ...env },
    tickIntervalMs: options.tickIntervalMs ?? 25,
    clock,
    log: () => {},
  });
  service.attachNativeHost(host);
  host.start();
  const activeHost = host;

  async function records(): Promise<VoiceTelemetryRecord[]> {
    let content = '';
    try {
      content = await readFile(telemetryPath, 'utf8');
    } catch {
      return [];
    }
    const parsed: VoiceTelemetryRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      parsed.push(JSON.parse(line) as VoiceTelemetryRecord);
    }
    return parsed;
  }

  async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs = 8_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    assert.fail(`timed out waiting for ${description}`);
  }

  return {
    service,
    host: activeHost,
    clock,
    records,
    waitFor,
    async close() {
      await service.dispose();
      activeHost.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('one enable carries a 20-minute hands-free conversation and default idle closes the mic and unloads models', async () => {
  const run = await startFixture({ ECHOPILOT_VOICE_IDLE_MS: '60000' });
  try {
    await run.service.enable();
    assert.equal(run.service.runtime.controller.snapshot().state, 'active');
    assert.equal(run.service.worker.loaded(), true);

    // Twenty minutes of exchanges renew the session from activity alone; no UI event is involved.
    for (let elapsed = 30_000; elapsed <= 20 * 60_000; elapsed += 30_000) {
      run.clock.advance(30_000);
      run.service.runtime.controller.noteActivity();
      await run.service.runtime.controller.tick();
      assert.equal(
        run.service.runtime.controller.snapshot().state,
        'active',
        `the session stayed active at ${elapsed / 1_000}s`,
      );
      assert.equal(run.service.worker.loaded(), true, 'the conversation models stayed resident (one load, no churn)');
    }
    const talking = run.service.runtime.controller.snapshot();
    assert.equal(talking.microphoneOpen, true);
    assert.equal(talking.conversationModelsLoaded, true);

    // The first idle window after the last utterance is the teardown, with no UI interaction.
    run.clock.advance(60_001);
    await run.service.runtime.controller.tick();
    const idle = run.service.runtime.controller.snapshot();
    assert.equal(idle.state, 'idle');
    assert.equal(idle.microphoneOpen, false);
    assert.equal(idle.conversationModelsLoaded, false);
    assert.equal(idle.wakeModelLoaded, false);
    assert.equal(run.service.worker.loaded(), false, 'the worker process exited, releasing the microphone and models');
  } finally {
    await run.close();
  }
});

test('transcripts from the live conversation path renew the session across idle windows', async () => {
  const run = await startFixture({
    ECHOPILOT_VOICE_IDLE_MS: '400',
    ECHOPILOT_FAKE_TRANSCRIPT_INTERVAL_MS: '100',
    ECHOPILOT_FAKE_TRANSCRIPT_COUNT: '6',
  }, { clock: realClock });
  try {
    await run.service.enable();
    const startedAt = run.service.runtime.controller.snapshot().lastActivityAt;
    assert.ok(startedAt !== null);
    await run.waitFor(
      () => (run.service.runtime.controller.snapshot().lastActivityAt ?? 0) > startedAt,
      'a transcript frame to renew the session',
    );
    // Six transcripts at 100 ms keep the session alive for well over two full idle windows.
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    assert.equal(run.service.runtime.controller.snapshot().state, 'active');
    // The moment the conversation goes quiet the next idle window tears everything down.
    await run.waitFor(
      () => run.service.runtime.controller.snapshot().state === 'idle',
      'idle teardown after the last transcript',
      6_000,
    );
    assert.equal(run.service.worker.loaded(), false);
  } finally {
    await run.close();
  }
});

test('optional standby shows a distinct persistent indicator and its measured energy trace passes the gate', async () => {
  const run = await startFixture({
    ECHOPILOT_VOICE_STANDBY: '1',
    ECHOPILOT_VOICE_IDLE_MS: '200',
    ECHOPILOT_FAKE_STANDBY_TICK_MS: '2500',
    // Only this stand-in's memory entry is scaled: its Node/tsx runtime baseline is ~90 MB, which
    // is not the signed helper's footprint. CPU and wakeups below stay on the product budget.
    ECHOPILOT_STANDBY_MEMORY_BUDGET_MB: '160',
  });
  try {
    await run.service.enable();
    run.clock.advance(201);
    await run.service.runtime.controller.tick();
    const standby = run.service.runtime.controller.snapshot();
    assert.equal(standby.state, 'standby');
    assert.equal(standby.microphoneOpen, true);
    assert.equal(standby.conversationModelsLoaded, false, 'standby must not hold the conversation pack');
    assert.equal(standby.wakeModelLoaded, true);

    // The indicator is a projection of the lifecycle, and standby is not the active-listening look.
    const indicator = voiceIndicator(standby as unknown as VoiceControlSnapshot);
    assert.equal(indicator.kind, 'standby');
    assert.equal(indicator.persistent, true);
    assert.equal(indicator.animated, false);
    assert.equal(indicator.tone, 'standby');
    const activeIndicator = voiceIndicator({
      state: 'active',
      enabled: true,
      microphoneOpen: true,
      conversationModelsLoaded: true,
      wakeModelLoaded: false,
      standbyEnabled: true,
    });
    assert.notEqual(indicator.label, activeIndicator.label);
    assert.notEqual(indicator.tone, activeIndicator.tone);

    // The helper's sampler measures this process while standby is open and the report crosses the
    // real budget (2% average CPU, 30 wakeups/min) in the production sink.
    await run.waitFor(async () => {
      const reports = (await run.records()).filter((record) => record.kind === 'standby-report');
      return reports.some((record) => record.report.sampleCount >= 1 && record.report.durationMs >= 2_000);
    }, 'a measured standby energy report');

    await run.service.telemetry.flush();
    const records = await run.records();
    const measured = records.filter((record) => record.kind === 'standby-report').at(-1)?.report;
    assert.ok(measured);
    assert.equal(measured.passed, true, `expected a within-budget trace, got ${JSON.stringify(measured)}`);
    assert.ok(measured.averageCpuPercent >= 0 && measured.averageCpuPercent < 2);
    assert.ok(measured.wakeupsPerMinute > 0 && measured.wakeupsPerMinute <= 30);
    assert.ok(measured.peakResidentMemoryMb > 0, 'the memory reading is this process, measured');
    assert.deepEqual(measured.violations, []);
    const samples = records.filter((record) => record.kind === 'standby-sample');
    assert.ok(samples.length >= 1, 'each raw sampler reading is retained next to the helper gate');
    assert.ok(samples[0] !== undefined && samples[0].native !== null);

    await run.service.disable();
    const off = run.service.runtime.controller.snapshot();
    assert.equal(off.state, 'disabled');
    assert.equal(off.microphoneOpen, false);
    assert.equal(off.wakeModelLoaded, false);
    await run.waitFor(() => run.service.worker.loaded() === false, 'the conversation worker to exit');
  } finally {
    await run.close();
  }
});

test('the standby gate is driven by measurement: a genuinely busy helper fails the budget and the violation is reported', async () => {
  const run = await startFixture({
    ECHOPILOT_VOICE_STANDBY: '1',
    ECHOPILOT_VOICE_IDLE_MS: '200',
    ECHOPILOT_FAKE_STANDBY_TICK_MS: '1000',
    // A real 400 ms busy-wait per second: the CPU reading below is measured, not injected.
    ECHOPILOT_FAKE_STANDBY_CPU_BURN_MS: '400',
    // The memory entry is restated below the stand-in's real footprint, so the same measured
    // reading also has to cross a restated budget. That only happens if the app's own gate reads
    // the knob rather than a private constant.
    ECHOPILOT_STANDBY_MEMORY_BUDGET_MB: '16',
  });
  try {
    await run.service.enable();
    run.clock.advance(201);
    await run.service.runtime.controller.tick();
    assert.equal(run.service.runtime.controller.snapshot().state, 'standby');

    await run.waitFor(async () => (await run.records()).some(
      (record) => record.kind === 'standby-report' && record.report.passed === false,
    ), 'an over-budget standby report');

    const failing = (await run.records())
      .filter((record) => record.kind === 'standby-report')
      .map((record) => record.report)
      .filter((report) => !report.passed)
      .at(-1);
    assert.ok(failing);
    assert.ok(failing.violations.includes('average_cpu'), JSON.stringify(failing));
    assert.ok(failing.violations.includes('resident_memory'), JSON.stringify(failing));
    const offending = (await run.records()).find(
      (record) => record.kind === 'standby-sample',
    );
    assert.ok(offending && offending.kind === 'standby-sample');
    assert.ok(offending.sample.cpuPercent > 2, `measured CPU ${offending.sample.cpuPercent}`);
  } finally {
    await run.close();
  }
});

test('TV and background-speech false triggers are measured per environment and a wake never authorizes an action', async () => {
  const tv = await startFixture({
    ECHOPILOT_VOICE_STANDBY: '1',
    ECHOPILOT_VOICE_IDLE_MS: '200',
    ECHOPILOT_FAKE_STANDBY_TICK_MS: '250',
    ECHOPILOT_FAKE_STANDBY_ENVIRONMENT: 'tv',
    ECHOPILOT_FAKE_STANDBY_DETECT_EVERY: '1',
  });
  try {
    await tv.service.enable();
    // Two standby sessions: a TV detection reopens the conversation (attention, not an action),
    // idle returns to standby, and the second detection is measured as the same false trigger.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      tv.clock.advance(201);
      await tv.service.runtime.controller.tick();
      await tv.waitFor(() => tv.service.runtime.controller.snapshot().state === 'standby', 'standby listening');
      await tv.waitFor(
        () => tv.service.runtime.controller.snapshot().state === 'active',
        `TV wake ${cycle + 1} to reopen the conversation`,
        5_000,
      );
      assert.equal(tv.service.runtime.controller.snapshot().enabled, true, 'a wake reopens only within the enabled session');
    }

    // Each detection is reported after the lifecycle step it caused, and the sink appends to the
    // file asynchronously: wait for the durable records instead of sampling them once.
    await tv.waitFor(async () => {
      const recorded = await tv.records();
      const detected = recorded.some(
        (record) => record.kind === 'wake-report' && record.report.byEnvironment.tv.detections >= 2,
      );
      const outcomes = recorded.filter((record) => record.kind === 'wake-outcome').length;
      return detected && outcomes >= 2;
    }, 'two measured TV detections and their outcomes');
    await tv.service.telemetry.flush();
    const records = await tv.records();
    const wakeReports = records.filter((record) => record.kind === 'wake-report').map((record) => record.report);
    const tvReport = wakeReports.at(-1);
    assert.ok(tvReport);
    assert.ok(tvReport.byEnvironment.tv.detections >= 2, JSON.stringify(tvReport));
    assert.ok(tvReport.byEnvironment.tv.falseTriggers >= 2, JSON.stringify(tvReport));
    assert.ok(tvReport.byEnvironment.tv.exposureMs > 0, 'the exposure denominator is measured too');
    assert.ok(tvReport.byEnvironment.tv.falseTriggersPerHour > 0);
    assert.equal(tvReport.byEnvironment.background_speech.falseTriggers, 0, 'environments are not conflated');

    const outcomes = records.filter((record) => record.kind === 'wake-outcome').map((record) => record.outcome);
    assert.ok(outcomes.length >= 2);
    for (const outcome of outcomes) {
      assert.equal(outcome.actionAuthorized, false);
      assert.equal(outcome.requiresExplicitActionConfirmation, true);
    }
  } finally {
    await tv.close();
  }

  const background = await startFixture({
    ECHOPILOT_VOICE_STANDBY: '1',
    ECHOPILOT_VOICE_IDLE_MS: '200',
    ECHOPILOT_FAKE_STANDBY_TICK_MS: '250',
    ECHOPILOT_FAKE_STANDBY_ENVIRONMENT: 'background_speech',
    ECHOPILOT_FAKE_STANDBY_DETECT_EVERY: '1',
  });
  try {
    await background.service.enable();
    background.clock.advance(201);
    await background.service.runtime.controller.tick();
    await background.waitFor(async () => {
      const reports = (await background.records()).filter((record) => record.kind === 'wake-report');
      return reports.some((record) => record.report.byEnvironment.background_speech.falseTriggers >= 1);
    }, 'a measured background-speech false trigger');

    await background.service.telemetry.flush();
    const report = (await background.records())
      .filter((record) => record.kind === 'wake-report')
      .map((record) => record.report)
      .at(-1);
    assert.ok(report);
    assert.ok(report.byEnvironment.background_speech.falseTriggers >= 1, JSON.stringify(report));
    assert.ok(report.byEnvironment.background_speech.falseTriggersPerHour > 0);
    assert.equal(report.byEnvironment.tv.falseTriggers, 0);
  } finally {
    await background.close();
  }
});
