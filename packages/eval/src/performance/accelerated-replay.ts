/**
 * Q02 accelerated replay driver — time-compressed companion to the eight-hour macOS qualification.
 *
 * `scripts/bench-macos/eight-hour-replay.mjs` needs a real eight-hour wall-clock run on M4/24 GB
 * and M2/16 GB machines. This driver is the repeatable, sub-ten-minute qualification the ticket
 * asks for: it runs the eight-hour session on a virtual clock against the real resource scheduler
 * (`packages/core/src/scheduler/index.ts`) and covers the long-session invariants plus
 * 1,000 events/s bursts, large logs, worker crashes, simulated sleep/wake, and network partitions.
 *
 * Determinism: the driver uses a seeded PRNG, an injected virtual clock, and bounded temp-file
 * spools. The same seed produces the same counters, and the runner records a counter fingerprint
 * so two runs can be compared. The driver never opens an audio device, the network, or user data;
 * the only host resources it touches are CPU, bounded memory, and spool files inside a temp
 * directory.
 *
 * Everything the macOS runner needs is written to the measurements JSON: queue/spool high-water
 * marks, dropped and gapped data, audio-callback blocking evidence, and one recovery outcome per
 * fault scenario. The runner fails closed when this file (or any counter in it) is missing.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, hostname, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createResourceScheduler,
  IDLE_RETURN_MS,
  MODEL_IDLE_UNLOAD_MS,
  type AudioFrame,
  type DurableEvent,
  type GapReason,
  type SchedulerJob,
} from '../../../core/src/scheduler/index.js';
import { EIGHT_HOURS_MS } from './eight-hour-replay.js';

const MIB = 1024 ** 2;
const DEFAULT_SEED = 0x5eed002;

/** Fault scenarios the accelerated qualification must cover. */
export const ACCELERATED_REQUIRED_SCENARIOS = [
  'long_session_invariants',
  'event_burst_1000_per_s',
  'large_logs',
  'worker_crash',
  'sleep_wake',
  'network_partition',
] as const;

export type AcceleratedScenarioId = (typeof ACCELERATED_REQUIRED_SCENARIOS)[number];

export type RecoveryOutcome = Readonly<{
  scenario: string;
  fault: string;
  outcome: 'recovered' | 'failed';
  detail: string;
}>;

export type AcceleratedCounters = Readonly<{
  audioQueueHighWater: number;
  audioRingCapacity: number;
  audioPosts: number;
  audioAccepted: number;
  audioDropped: number;
  audioDiscontinuities: number;
  eventQueueHighWater: number;
  eventQueueCapacity: number;
  eventsEnqueued: number;
  eventsAccepted: number;
  eventsShed: number;
  spoolBytesHighWater: number;
  spoolQuotaBytes: number;
  spoolOverQuotaBytes: number;
  spoolRecords: number;
  gapRecords: number;
  gappedBytes: number;
  droppedFrames: number;
  persistFailures: number;
  /** Total across scenarios: work that ran inside an audio callback (must stay 0). */
  workDuringAudioCallbacks: number;
  /** Total across scenarios: audio receipts that returned a promise instead of a value. */
  asyncReceipts: number;
}>;

export type ScenarioResult = Readonly<{
  id: string;
  passed: boolean;
  checks: readonly string[];
  failures: readonly string[];
  measurements: Readonly<Record<string, number | string>>;
  counters: AcceleratedCounters;
  gapsByReason: Readonly<Record<GapReason, number>>;
  recovery: readonly RecoveryOutcome[];
}>;

export type AcceleratedReplayResult = Readonly<{
  schemaVersion: 1;
  mode: 'accelerated';
  generatedAt: string;
  seed: number;
  host: Readonly<{
    name: string;
    model: string;
    cores: number;
    memoryBytes: number;
    arch: string;
    release: string;
  }>;
  simulatedDurationMs: number;
  requiredSimulatedDurationMs: number;
  wallClockMs: number;
  coldStartMs: number;
  coldStartBudgetMs: number;
  counters: AcceleratedCounters;
  gapsByReason: Readonly<Record<GapReason, number>>;
  audioCallback: Readonly<{
    posts: number;
    maxCallbackMicros: number;
    workDuringAudioCallbacks: number;
    synchronous: boolean;
  }>;
  memory: Readonly<{
    rssStartBytes: number;
    rssEndBytes: number;
    rssHighWaterBytes: number;
    rssHour1Bytes: number | null;
    rssHour8Bytes: number | null;
    maxRssGrowthBytes: number;
  }>;
  recovery: readonly RecoveryOutcome[];
  scenarios: readonly ScenarioResult[];
  requiredScenarios: readonly string[];
  counterFingerprint: string;
  failures: readonly string[];
  passed: boolean;
}>;

export type AcceleratedReplayOptions = Readonly<{ seed?: number; samplesPath?: string }>;

type Scheduler = ReturnType<typeof createResourceScheduler>;
type AudioReceipt = ReturnType<Scheduler['postAudioFrame']>;
type EnqueueReceipt = ReturnType<Scheduler['enqueue']>;
type SchedulerStats = ReturnType<Scheduler['stats']>;
type Snapshot = SchedulerStats & Readonly<{ gapRecords: number; gappedBytes: number }>;

type HarnessLimits = Readonly<{
  audioRingCapacity: number;
  eventQueueCapacity: number;
  spoolQuotaBytes: number;
}>;

type HarnessConfig = HarnessLimits & Readonly<{ label: string }>;

type MutableCounters = {
  audioQueueHighWater: number;
  audioPosts: number;
  audioAccepted: number;
  audioDropped: number;
  audioCallbackMaxMicros: number;
  workDuringAudioCallbacks: number;
  asyncReceipts: number;
  eventsEnqueued: number;
  eventsAccepted: number;
  eventQueueHighWater: number;
  rawBytesEnqueued: number;
  spoolOfferedBytes: number;
  spoolStoredBytes: number;
  spoolBytesHighWater: number;
  spoolOverQuotaBytes: number;
  spoolRecords: number;
  spoolRefusals: number;
  unloads: number;
  jobSteps: number;
  jobFailures: number;
  pumps: number;
  persistRejections: number;
};

type Harness = Readonly<{
  limits: HarnessLimits;
  counters: MutableCounters;
  spoolPath: string;
  scheduler: Scheduler;
  setNow(value: number): void;
  postAudio(frame: AudioFrame): AudioReceipt;
  enqueue(event: DurableEvent): EnqueueReceipt;
  submitJob(job: SchedulerJob): void;
  pump(): Promise<Awaited<ReturnType<Scheduler['pump']>>>;
  drainAll(maxPumps?: number): Promise<number>;
  snapshot(): Snapshot;
  failWork(label: string, message: string): void;
  failPersist(message: string | null): void;
  /** Gate the next `durable.persist`; resolves once that persist is in flight. */
  holdPersist(): Promise<void>;
  releasePersist(): void;
  persistedEventIds(): readonly string[];
  jobSteps(): readonly string[];
  spoolFileBytes(): Promise<number>;
  close(): Promise<void>;
}>;

type SampleSink = { push(sample: Readonly<Record<string, number | string>>): void };

type ScenarioContext = Readonly<{
  createHarness(config: HarnessConfig): Promise<Harness>;
  samples: SampleSink;
}>;

/** Deterministic PRNG (mulberry32) — the replay is identical for a given seed. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyCounters(): MutableCounters {
  return {
    audioQueueHighWater: 0,
    audioPosts: 0,
    audioAccepted: 0,
    audioDropped: 0,
    audioCallbackMaxMicros: 0,
    workDuringAudioCallbacks: 0,
    asyncReceipts: 0,
    eventsEnqueued: 0,
    eventsAccepted: 0,
    eventQueueHighWater: 0,
    rawBytesEnqueued: 0,
    spoolOfferedBytes: 0,
    spoolStoredBytes: 0,
    spoolBytesHighWater: 0,
    spoolOverQuotaBytes: 0,
    spoolRecords: 0,
    spoolRefusals: 0,
    unloads: 0,
    jobSteps: 0,
    jobFailures: 0,
    pumps: 0,
    persistRejections: 0,
  };
}

function sampleOf(counters: MutableCounters): Readonly<Record<string, number>> {
  return {
    audioQueueHighWater: counters.audioQueueHighWater,
    eventQueueHighWater: counters.eventQueueHighWater,
    spoolBytesHighWater: counters.spoolBytesHighWater,
    audioAccepted: counters.audioAccepted,
    audioDropped: counters.audioDropped,
    eventsEnqueued: counters.eventsEnqueued,
    eventsAccepted: counters.eventsAccepted,
    spoolStoredBytes: counters.spoolStoredBytes,
  };
}

async function createHarness(spoolRoot: string, config: HarnessConfig, samples: SampleSink): Promise<Harness> {
  const counters = emptyCounters();
  const workFailures = new Map<string, string>();
  const persisted: DurableEvent[] = [];
  const steps: string[] = [];
  const directory = await mkdtemp(join(spoolRoot, `${config.label}-`));
  const spoolPath = join(directory, 'raw.spool');
  const spoolFd = openSync(spoolPath, 'w');
  const spoolChunk = Buffer.alloc(64 * 1024);
  let storedBytes = 0;
  let spoolOpen = true;
  let insideAudioCallback = false;
  let persistFailure: string | null = null;
  let persistGate: Promise<void> | null = null;
  let releasePersistGate: (() => void) | null = null;
  let notePersistStarted: (() => void) | null = null;
  let nowMs = 0;

  const writeSpoolBytes = (bytes: number) => {
    let remaining = bytes;
    while (remaining > 0) {
      const size = Math.min(remaining, spoolChunk.length);
      writeSync(spoolFd, spoolChunk, 0, size);
      remaining -= size;
    }
  };

  const scheduler = createResourceScheduler({
    now: () => nowMs,
    audioRingCapacity: config.audioRingCapacity,
    eventQueueCapacity: config.eventQueueCapacity,
    spoolQuotaBytes: config.spoolQuotaBytes,
    jsWork: async (label, payload) => {
      if (insideAudioCallback) counters.workDuringAudioCallbacks += 1;
      if (label === 'durable.persist') {
        if (persistGate !== null) {
          const gate = persistGate;
          notePersistStarted?.();
          notePersistStarted = null;
          await gate;
        }
        if (persistFailure !== null) {
          counters.persistRejections += 1;
          throw new Error(persistFailure);
        }
        persisted.push(payload as DurableEvent);
      }
      // Record the attempt before injecting a fault: a crashed step still ran exactly once, and
      // `jobSteps()` is the attempt log the crash scenario asserts against.
      if (label.startsWith('job:')) {
        counters.jobSteps += 1;
        steps.push(label.slice('job:'.length));
      }
      const failure = workFailures.get(label);
      if (failure !== undefined) {
        counters.jobFailures += 1;
        throw new Error(failure);
      }
      return `ok:${label}`;
    },
    spool: (record) => {
      if (insideAudioCallback) counters.workDuringAudioCallbacks += 1;
      counters.spoolOfferedBytes += record.bytes;
      if (!spoolOpen || storedBytes + record.bytes > config.spoolQuotaBytes) {
        // The scheduler promises never to offer more than spoolQuotaBytes. A record that crosses
        // the quota is a scheduler bug rather than a disk refusal, so both are counted apart.
        if (spoolOpen) counters.spoolOverQuotaBytes += record.bytes;
        counters.spoolRefusals += 1;
        return false;
      }
      writeSpoolBytes(record.bytes);
      storedBytes += record.bytes;
      counters.spoolStoredBytes = storedBytes;
      counters.spoolRecords += 1;
      counters.spoolBytesHighWater = Math.max(counters.spoolBytesHighWater, storedBytes);
      return true;
    },
    unloadModels: () => {
      if (insideAudioCallback) counters.workDuringAudioCallbacks += 1;
      counters.unloads += 1;
    },
  });

  const postAudio = (frame: AudioFrame): AudioReceipt => {
    insideAudioCallback = true;
    const started = performance.now();
    try {
      const receipt = scheduler.postAudioFrame(frame);
      if (receipt instanceof Promise) counters.asyncReceipts += 1;
      counters.audioPosts += 1;
      if (receipt.accepted) counters.audioAccepted += 1;
      else counters.audioDropped += 1;
      counters.audioQueueHighWater = Math.max(counters.audioQueueHighWater, receipt.depth);
      counters.audioCallbackMaxMicros = Math.max(
        counters.audioCallbackMaxMicros,
        (performance.now() - started) * 1_000,
      );
      return receipt;
    } finally {
      insideAudioCallback = false;
    }
  };

  const enqueue = (event: DurableEvent): EnqueueReceipt => {
    const receipt = scheduler.enqueue(event);
    counters.eventsEnqueued += 1;
    if (receipt.accepted) counters.eventsAccepted += 1;
    if (event.kind === 'raw_output') counters.rawBytesEnqueued += event.bytes;
    counters.eventQueueHighWater = Math.max(counters.eventQueueHighWater, receipt.depth);
    return receipt;
  };

  const pump = async (): Promise<Awaited<ReturnType<Scheduler['pump']>>> => {
    counters.pumps += 1;
    const receipts = await scheduler.pump();
    if (counters.pumps <= 12 || counters.pumps % 60 === 0) {
      samples.push({ scenario: config.label, virtualMs: nowMs, ...sampleOf(counters) });
    }
    return receipts;
  };

  const snapshot = (): Snapshot => {
    const current = scheduler.stats();
    return {
      ...current,
      gapRecords: current.gaps.length,
      gappedBytes: current.gaps.reduce((total, gap) => total + gap.omittedBytes, 0),
    };
  };

  const drainAll = async (maxPumps = 4_096): Promise<number> => {
    for (let guard = 0; guard < maxPumps; guard += 1) {
      const receipts = await pump();
      const current = snapshot();
      if (receipts.length === 0 && current.audio.depth === 0 && current.events.depth === 0) return guard + 1;
    }
    throw new Error(`${config.label}: the scheduler never drained`);
  };

  return {
    limits: config,
    counters,
    spoolPath,
    scheduler,
    setNow: (value) => { nowMs = value; },
    postAudio,
    enqueue,
    submitJob: (job) => { scheduler.submitJob(job); },
    pump,
    drainAll,
    snapshot,
    failWork: (label, message) => { workFailures.set(label, message); },
    failPersist: (message) => { persistFailure = message; },
    holdPersist: () => new Promise<void>((resolveStarted) => {
      persistGate = new Promise<void>((release) => { releasePersistGate = release; });
      notePersistStarted = resolveStarted;
    }),
    releasePersist: () => {
      releasePersistGate?.();
      releasePersistGate = null;
      persistGate = null;
    },
    persistedEventIds: () => persisted.map((event) => event.id),
    jobSteps: () => [...steps],
    spoolFileBytes: async () => (await stat(spoolPath)).size,
    close: async () => {
      spoolOpen = false;
      closeSync(spoolFd);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function scenarioCounters(harness: Harness, final: Snapshot): AcceleratedCounters {
  return {
    audioQueueHighWater: harness.counters.audioQueueHighWater,
    audioRingCapacity: harness.limits.audioRingCapacity,
    audioPosts: harness.counters.audioPosts,
    audioAccepted: harness.counters.audioAccepted,
    audioDropped: harness.counters.audioDropped,
    audioDiscontinuities: final.audio.discontinuities,
    eventQueueHighWater: harness.counters.eventQueueHighWater,
    eventQueueCapacity: harness.limits.eventQueueCapacity,
    eventsEnqueued: harness.counters.eventsEnqueued,
    eventsAccepted: harness.counters.eventsAccepted,
    eventsShed: final.events.shed,
    spoolBytesHighWater: harness.counters.spoolBytesHighWater,
    spoolQuotaBytes: harness.limits.spoolQuotaBytes,
    spoolOverQuotaBytes: harness.counters.spoolOverQuotaBytes,
    spoolRecords: harness.counters.spoolRecords,
    gapRecords: final.gapRecords,
    gappedBytes: final.gappedBytes,
    droppedFrames: final.audio.droppedFrames,
    persistFailures: final.events.persistFailures,
    workDuringAudioCallbacks: harness.counters.workDuringAudioCallbacks,
    asyncReceipts: harness.counters.asyncReceipts,
  };
}

function gapsByReason(gaps: readonly Readonly<{ reason: GapReason }>[]): Record<GapReason, number> {
  const counts: Record<GapReason, number> = { queue_overflow: 0, disk_quota: 0, memory_pressure: 0 };
  for (const gap of gaps) counts[gap.reason] += 1;
  return counts;
}

type Checker = {
  check(condition: boolean, id: string, message: string): boolean;
  checks: string[];
  failures: string[];
};

function createChecker(): Checker {
  const checks: string[] = [];
  const failures: string[] = [];
  return {
    checks,
    failures,
    check(condition, id, message) {
      if (condition) checks.push(id);
      else failures.push(`${id}: ${message}`);
      return condition;
    },
  };
}

function recovery(scenario: string, fault: string, recovered: boolean, detail: string): RecoveryOutcome {
  return { scenario, fault, outcome: recovered ? 'recovered' : 'failed', detail };
}

function text(value: number | string | null | undefined): string {
  return value === null || value === undefined ? 'unmeasured' : String(value);
}

/** Long-session invariants: eight virtual hours, idle unload/reload, return-to-idle, bounded queues. */
async function scenarioLongSession(context: ScenarioContext): Promise<ScenarioResult> {
  const checker = createChecker();
  const { check } = checker;
  const harness = await context.createHarness({
    label: 'long-session',
    audioRingCapacity: 64,
    eventQueueCapacity: 256,
    spoolQuotaBytes: 64 * MIB,
  });

  const hourSeconds = 60 * 60;
  const totalSeconds = 8 * hourSeconds;
  const idleStartSecond = 3 * hourSeconds;
  const idleEndSecond = idleStartSecond + Math.ceil((MODEL_IDLE_UNLOAD_MS + 5_000) / 1_000);
  const quietStartSecond = 7 * hourSeconds;
  const returnToIdleSecond = quietStartSecond + Math.ceil(IDLE_RETURN_MS / 1_000) + 2;
  const rssStartBytes = process.memoryUsage().rss;
  let rssHighWater = rssStartBytes;
  let rssHour1: number | null = null;
  let rssHour8: number | null = null;
  let sequence = 0;
  let offset = 0;
  let approvals = 0;
  let results = 0;
  let jobs = 0;
  let idleReceipts = -1;
  let returnToIdleDepths: Readonly<{ audio: number; events: number; jobs: number }> | null = null;
  let unloadsAtIdleWindowEnd: number | null = null;

  for (let second = 0; second < totalSeconds; second += 1) {
    const nowMs = second * 1_000;
    harness.setNow(nowMs);
    const idling = second >= idleStartSecond && second < idleEndSecond;
    const quiet = second >= quietStartSecond;

    if (!idling && !quiet) {
      for (let frame = 0; frame < 10; frame += 1) harness.postAudio({ sequence: sequence++, bytes: 640 });
      if (second % 600 === 0) {
        harness.enqueue({ id: `approval-${++approvals}`, kind: 'approval', bytes: 256, offset });
        offset += 256;
      }
      if (second % 900 === 0) {
        harness.enqueue({ id: `result-${++results}`, kind: 'result', bytes: 192, offset });
        offset += 192;
      }
      if (second % 300 === 0) {
        harness.submitJob({
          id: `job-${++jobs}`,
          class: 'consolidation',
          steps: ['batch-1', 'batch-2'],
          slot: 'consolidation',
        });
      }
    }

    // Raw capture keeps flowing through the idle window and the quiet tail: raw_output is not
    // useful activity, so the 90 s idle-unload window still runs.
    harness.enqueue({ id: `raw-${second}`, kind: 'raw_output', bytes: 512, offset });
    offset += 512;
    harness.scheduler.tick();

    if (second === returnToIdleSecond) {
      const receipts = await harness.pump();
      const currents = harness.snapshot();
      idleReceipts = receipts.length;
      returnToIdleDepths = {
        audio: currents.audio.depth,
        events: currents.events.depth,
        jobs: currents.jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'preempted').length,
      };
    } else {
      await harness.pump();
    }

    if (second === 3_600) {
      rssHour1 = process.memoryUsage().rss;
      context.samples.push({ scenario: 'long-session-hour-1', virtualMs: nowMs, rssBytes: rssHour1 });
    }
    if (second === totalSeconds - 1) {
      rssHour8 = process.memoryUsage().rss;
      context.samples.push({ scenario: 'long-session-hour-8', virtualMs: nowMs, rssBytes: rssHour8 });
    }
    if (second % 600 === 0) rssHighWater = Math.max(rssHighWater, process.memoryUsage().rss);
    if (second === idleEndSecond) unloadsAtIdleWindowEnd = harness.counters.unloads;
  }

  const pumps = await harness.drainAll();
  const final = harness.snapshot();
  const spoolFileBytes = await harness.spoolFileBytes();
  const rawBytesEnqueued = harness.counters.rawBytesEnqueued;

  check(harness.counters.workDuringAudioCallbacks === 0, 'audio_callback_no_work',
    `postAudioFrame must never run JS/database/spool work (saw ${harness.counters.workDuringAudioCallbacks})`);
  check(harness.counters.asyncReceipts === 0, 'audio_callback_synchronous',
    'postAudioFrame must return synchronously, never a promise');
  check(final.audio.depth === 0, 'audio_drained', `audio ring must end empty (depth ${final.audio.depth})`);
  check(final.events.depth === 0, 'events_drained', `event backlog must end empty (depth ${final.events.depth})`);
  check(harness.counters.audioQueueHighWater <= 64, 'audio_queue_bounded',
    `audio ring high-water ${harness.counters.audioQueueHighWater} exceeds capacity 64`);
  check(harness.counters.eventQueueHighWater <= 256, 'event_queue_bounded',
    `event backlog high-water ${harness.counters.eventQueueHighWater} exceeds capacity 256`);
  check(harness.counters.spoolOverQuotaBytes === 0 && harness.counters.spoolOfferedBytes <= 64 * MIB, 'spool_bounded',
    `spool offered ${harness.counters.spoolOfferedBytes} of a 64 MiB quota`);
  check(spoolFileBytes <= 64 * MIB && spoolFileBytes === harness.counters.spoolStoredBytes, 'spool_file_bounded',
    `spool file ${spoolFileBytes} must match stored bytes and stay inside quota`);
  check(harness.counters.spoolStoredBytes + final.gappedBytes === rawBytesEnqueued, 'raw_accounting_exact',
    `spooled ${harness.counters.spoolStoredBytes} + gapped ${final.gappedBytes} must equal ${rawBytesEnqueued} raw bytes`);
  check(idleReceipts === 0 && returnToIdleDepths !== null
    && returnToIdleDepths.audio === 0 && returnToIdleDepths.events === 0 && returnToIdleDepths.jobs === 0,
    'return_to_idle_within_budget',
    `the pipeline must be idle within ${IDLE_RETURN_MS} ms of the last useful work (receipts ${idleReceipts})`);
  check(rssHour1 !== null && rssHour8 !== null && Math.abs(rssHour8 - rssHour1) < 128 * MIB, 'long_session_memory_stable',
    `RSS must not drift across eight virtual hours (hour1 ${text(rssHour1)}, hour8 ${text(rssHour8)})`);
  check(harness.counters.unloads >= 2 && final.models.resident === false, 'idle_unload_after_tail',
    `the idle window and the quiet tail must unload models without useful work (unloads ${harness.counters.unloads})`);
  check(unloadsAtIdleWindowEnd === 1, 'idle_window_unloads_once',
    `the ${(idleEndSecond - idleStartSecond)} s idle window must unload models exactly once (saw ${text(unloadsAtIdleWindowEnd)})`);
  check(final.models.lastUnloadAt !== undefined && final.models.lastUnloadAt > quietStartSecond * 1_000,
    'idle_unload_timestamp', 'the last unload must be recorded after the last useful activity');
  check(final.events.persistFailures === 0, 'long_session_no_persist_failures',
    'no durable decision may fail to persist in a healthy long session');

  const outcome = recovery('long_session_invariants', 'eight_hour_session', checker.failures.length === 0,
    `${pumps} drain pumps; audio ${final.audio.depth}, events ${final.events.depth}, unloads ${harness.counters.unloads}`);
  await harness.close();
  return {
    id: 'long_session_invariants',
    passed: checker.failures.length === 0,
    checks: checker.checks,
    failures: checker.failures,
    measurements: {
      simulatedMs: totalSeconds * 1_000,
      pumps,
      rawBytesEnqueued,
      spoolStoredBytes: harness.counters.spoolStoredBytes,
      gappedBytes: final.gappedBytes,
      gaps: final.gapRecords,
      unloads: harness.counters.unloads,
      maxAudioCallbackMicros: Math.round(harness.counters.audioCallbackMaxMicros),
      rssStartBytes,
      rssHighWaterBytes: rssHighWater,
      rssHour1Bytes: rssHour1 ?? -1,
      rssHour8Bytes: rssHour8 ?? -1,
      idleWindowMs: (idleEndSecond - idleStartSecond) * 1_000,
    },
    counters: scenarioCounters(harness, final),
    gapsByReason: gapsByReason(final.gaps),
    recovery: [outcome],
  };
}

/** 1,000 events/s burst against a hard 256-event backlog and a 4 MiB spool quota. */
async function scenarioEventBurst(context: ScenarioContext): Promise<ScenarioResult> {
  const checker = createChecker();
  const { check } = checker;
  const harness = await context.createHarness({
    label: 'event-burst',
    audioRingCapacity: 64,
    eventQueueCapacity: 256,
    spoolQuotaBytes: 4 * MIB,
  });
  const random = createRandom(0xb0_1257);
  const burstSeconds = 6;
  const eventsPerSecond = 1_000;
  let offset = 0;
  let durableEnqueued = 0;
  let durableAccepted = 0;
  let gappedReceipts = 0;

  for (let second = 0; second < burstSeconds; second += 1) {
    harness.setNow(second * 1_000 + 999);
    for (let index = 0; index < eventsPerSecond; index += 1) {
      const roll = random();
      const kind: DurableEvent['kind'] = index % 500 === 0 ? 'approval' : index % 250 === 0 ? 'result' : 'raw_output';
      const bytes = kind === 'raw_output' ? 256 + Math.floor(roll * 1_792) : 256;
      const receipt = harness.enqueue({ id: `${kind}-${second}-${index}`, kind, bytes, offset });
      offset += bytes;
      if (kind !== 'raw_output') {
        durableEnqueued += 1;
        if (receipt.accepted) durableAccepted += 1;
      }
      if (!receipt.accepted) {
        gappedReceipts += 1;
        if (receipt.gap === undefined || receipt.gap.omittedBytes < bytes) {
          checker.failures.push(`shed_receipt_has_gap: shed event ${kind}-${second}-${index} lacks an exact gap record`);
        }
      }
    }
    await harness.pump();
  }

  const pumps = await harness.drainAll();
  const final = harness.snapshot();
  const spoolFileBytes = await harness.spoolFileBytes();
  const rawBytesEnqueued = harness.counters.rawBytesEnqueued;

  check(harness.counters.eventsEnqueued === burstSeconds * eventsPerSecond, 'burst_arrival_rate',
    `the burst must deliver ${burstSeconds * eventsPerSecond} events (saw ${harness.counters.eventsEnqueued})`);
  check(durableAccepted === durableEnqueued, 'durable_never_shed',
    `${durableEnqueued - durableAccepted} approvals/results were rejected instead of displacing raw backlog`);
  check(harness.counters.eventQueueHighWater <= 256, 'event_queue_bounded',
    `event backlog high-water ${harness.counters.eventQueueHighWater} exceeds capacity 256`);
  check(harness.counters.spoolOverQuotaBytes === 0, 'spool_quota_respected',
    `the scheduler offered ${harness.counters.spoolOverQuotaBytes} bytes past the spool quota`);
  check(spoolFileBytes <= 4 * MIB && harness.counters.spoolStoredBytes === spoolFileBytes, 'spool_file_bounded',
    `spool file ${spoolFileBytes} must match stored bytes and stay inside the 4 MiB quota`);
  check(final.gappedBytes + harness.counters.spoolStoredBytes === rawBytesEnqueued, 'gap_accounting_exact',
    `gapped ${final.gappedBytes} + spooled ${harness.counters.spoolStoredBytes} vs ${rawBytesEnqueued} raw bytes`);
  check(final.events.shed === final.gapRecords, 'shed_counter_matches_gaps',
    `events.shed ${final.events.shed} must equal gap records ${final.gapRecords}`);
  check(final.gaps.every((gap) => gap.toOffset - gap.fromOffset === gap.omittedBytes), 'gap_ranges_exact',
    'every gap record must state the exact omitted byte range');
  check(gappedReceipts > 0, 'burst_exercised_backlog',
    'a 1,000 events/s burst against a 256-event backlog must shed raw output');
  check(final.events.depth === 0, 'burst_recovered', `backlog must drain to empty (depth ${final.events.depth})`);

  const recovered = harness.enqueue({ id: 'post-burst-raw', kind: 'raw_output', bytes: 256, offset });
  check(recovered.accepted, 'post_burst_accepts_new_raw',
    'after the burst the scheduler must accept new raw output again');
  await harness.drainAll();
  check(final.events.persistFailures === 0, 'no_persist_failures_without_fault', 'no partition was injected');

  const outcome = recovery('event_burst_1000_per_s', 'sustained_1000_events_per_second', checker.failures.length === 0,
    `${pumps} pumps drained the burst; ${final.events.shed} raw events declared as gaps`);
  await harness.close();
  return {
    id: 'event_burst_1000_per_s',
    passed: checker.failures.length === 0,
    checks: checker.checks,
    failures: checker.failures,
    measurements: {
      eventsEnqueued: harness.counters.eventsEnqueued,
      eventsPerSecond,
      burstSeconds,
      pumps,
      eventsShed: final.events.shed,
      gappedBytes: final.gappedBytes,
      spoolStoredBytes: harness.counters.spoolStoredBytes,
      maxAudioCallbackMicros: Math.round(harness.counters.audioCallbackMaxMicros),
      rssHighWaterBytes: process.memoryUsage().rss,
    },
    counters: scenarioCounters(harness, final),
    gapsByReason: gapsByReason(final.gaps),
    recovery: [outcome],
  };
}

/** Large logs (512 KiB raw records) against an 8 MiB quota, with post-log recovery. */
async function scenarioLargeLogs(context: ScenarioContext): Promise<ScenarioResult> {
  const checker = createChecker();
  const { check } = checker;
  const harness = await context.createHarness({
    label: 'large-logs',
    audioRingCapacity: 32,
    eventQueueCapacity: 64,
    spoolQuotaBytes: 8 * MIB,
  });
  const logBytes = 512 * 1024;
  const logCount = 200;
  const rssStartBytes = process.memoryUsage().rss;
  let rssHighWater = rssStartBytes;
  let offset = 0;
  const liveBuffers: Buffer[] = [];

  for (let index = 0; index < logCount; index += 1) {
    harness.enqueue({ id: `log-${index}`, kind: 'raw_output', bytes: logBytes, offset });
    offset += logBytes;
    liveBuffers.push(Buffer.alloc(logBytes, index % 256));
    if (liveBuffers.length > 64) liveBuffers.shift();
    rssHighWater = Math.max(rssHighWater, process.memoryUsage().rss);
    if (index % 16 === 0) await harness.pump();
  }

  const pumps = await harness.drainAll();
  const final = harness.snapshot();
  const spoolFileBytes = await harness.spoolFileBytes();
  const rawBytesEnqueued = harness.counters.rawBytesEnqueued;

  check(rawBytesEnqueued === logCount * logBytes, 'large_log_volume',
    `${logCount} logs of ${logBytes} bytes must reach the scheduler`);
  check(final.gappedBytes + harness.counters.spoolStoredBytes === rawBytesEnqueued, 'large_log_gap_accounting',
    `gapped ${final.gappedBytes} + spooled ${harness.counters.spoolStoredBytes} must equal ${rawBytesEnqueued} raw bytes`);
  check(final.gaps.every((gap) => gap.reason === 'disk_quota'), 'large_log_gap_reason',
    'logs shed by the quota must be labelled disk_quota');
  check(final.gaps.every((gap) => gap.toOffset - gap.fromOffset === gap.omittedBytes), 'large_log_ranges_exact',
    'every log gap must state the exact omitted byte range');
  check(harness.counters.spoolOverQuotaBytes === 0, 'spool_quota_respected',
    `the scheduler offered ${harness.counters.spoolOverQuotaBytes} bytes past the spool quota`);
  check(spoolFileBytes <= 8 * MIB && spoolFileBytes === harness.counters.spoolStoredBytes, 'spool_file_bounded',
    `spool file ${spoolFileBytes} must be inside the 8 MiB quota`);
  check(harness.counters.eventQueueHighWater <= 64, 'event_queue_bounded',
    `event backlog high-water ${harness.counters.eventQueueHighWater} exceeds capacity 64`);
  check(rssHighWater - rssStartBytes < 256 * MIB, 'large_log_memory_bounded',
    `RSS grew ${rssHighWater - rssStartBytes} bytes while streaming 100 MiB of logs`);
  check(final.events.depth === 0, 'large_log_recovered', 'the log backlog must drain to empty');

  const approvalBytes = 192;
  const approval = harness.enqueue({ id: 'post-log-approval', kind: 'approval', bytes: approvalBytes, offset });
  check(approval.accepted, 'post_log_accepts_decisions', 'decisions must still be accepted after log pressure');
  await harness.drainAll();
  check(harness.persistedEventIds().includes('post-log-approval'), 'post_log_decision_persisted',
    'the decision enqueued after log pressure must still be persisted');
  check(harness.snapshot().models.resident === true, 'post_log_models_resident', 'useful work must reload models');

  const outcome = recovery('large_logs', 'hundred_mib_log_stream', checker.failures.length === 0,
    `${pumps} pumps; ${final.events.shed} log records declared as gaps; spool ${harness.counters.spoolStoredBytes} bytes`);
  await harness.close();
  return {
    id: 'large_logs',
    passed: checker.failures.length === 0,
    checks: checker.checks,
    failures: checker.failures,
    measurements: {
      logCount,
      logBytes,
      pumps,
      rawBytesEnqueued,
      eventsShed: final.events.shed,
      gappedBytes: final.gappedBytes,
      spoolStoredBytes: harness.counters.spoolStoredBytes,
      rssGrowthBytes: rssHighWater - rssStartBytes,
      liveBuffers: liveBuffers.length,
    },
    counters: scenarioCounters(harness, final),
    gapsByReason: gapsByReason(final.gaps),
    recovery: [outcome],
  };
}

/** A worker crash mid-job: failure is visible, the slot is released, queued work recovers. */
async function scenarioWorkerCrash(context: ScenarioContext): Promise<ScenarioResult> {
  const checker = createChecker();
  const { check } = checker;
  const harness = await context.createHarness({
    label: 'worker-crash',
    audioRingCapacity: 16,
    eventQueueCapacity: 32,
    spoolQuotaBytes: 1 * MIB,
  });
  harness.failWork('job:correction-a:decode-2', 'worker exited (SIGKILL)');
  harness.scheduler.submitJob({ id: 'correction-a', class: 'correction', steps: ['decode-1', 'decode-2', 'decode-3'], slot: 'generation' });
  harness.scheduler.submitJob({ id: 'correction-b', class: 'correction', steps: ['decode'], slot: 'generation' });

  const receipts: Array<Readonly<{ jobId: string; status: string; error?: string }>> = [];
  let sequence = 0;
  let audioAcceptedDuringCrash = 0;
  for (let pump = 0; pump < 8; pump += 1) {
    const receipt = harness.postAudio({ sequence: sequence++, bytes: 960 });
    if (receipt.accepted) audioAcceptedDuringCrash += 1;
    receipts.push(...await harness.pump());
    harness.setNow(1_000 + pump * 1_000);
  }

  const final = harness.snapshot();
  const crashed = final.jobs.find((job) => job.jobId === 'correction-a');
  const recovered = final.jobs.find((job) => job.jobId === 'correction-b');
  const crashReceipt = receipts.find((receipt) => receipt.jobId === 'correction-a' && receipt.status === 'failed');
  const steps = harness.jobSteps();
  const crashStepRuns = steps.filter((step) => step === 'correction-a:decode-2').length;

  check(crashReceipt !== undefined && String(crashReceipt.error).includes('SIGKILL'), 'crash_surfaces_failure',
    'the crash must surface as a failed pump receipt carrying the worker error');
  check(crashed?.status === 'failed', 'crash_status_failed', `crashed job status ${text(crashed?.status ?? null)}`);
  check(crashed?.attempts === 1, 'crash_not_retried_silently', `attempts ${text(crashed?.attempts ?? null)} must be 1`);
  check(crashed?.completedSteps === 1, 'crash_keeps_committed_steps', `completedSteps ${text(crashed?.completedSteps ?? null)} must be 1`);
  check(crashStepRuns === 1, 'crash_step_not_repeated', 'the crashed step must run exactly once');
  check(recovered?.status === 'completed', 'crash_slot_released_for_queued_work',
    `queued job status ${text(recovered?.status ?? null)} must recover after the slot is released`);
  check(final.slots.generation === 0, 'crash_slot_free', 'the generation slot must be free after the crash');
  check(audioAcceptedDuringCrash === 8, 'crash_audio_still_accepted',
    `audio callbacks must keep being accepted during the crash (saw ${audioAcceptedDuringCrash})`);
  check(final.audio.depth === 0, 'crash_audio_drained', 'the ring must drain after the crash');
  check(harness.counters.workDuringAudioCallbacks === 0, 'crash_audio_callback_no_work',
    'the audio callback must never run work, even while a worker is crashing');

  const outcome = recovery('worker_crash', 'model_worker_sigkill', checker.failures.length === 0,
    `correction-a failed after ${text(crashed?.completedSteps ?? null)} steps; correction-b ${text(recovered?.status ?? null)}`);
  await harness.close();
  return {
    id: 'worker_crash',
    passed: checker.failures.length === 0,
    checks: checker.checks,
    failures: checker.failures,
    measurements: {
      crashedAttempts: crashed?.attempts ?? -1,
      crashedCompletedSteps: crashed?.completedSteps ?? -1,
      crashStepRuns,
      queuedJobStatus: recovered?.status ?? 'missing',
      audioAcceptedDuringCrash,
      maxAudioCallbackMicros: Math.round(harness.counters.audioCallbackMaxMicros),
    },
    counters: scenarioCounters(harness, final),
    gapsByReason: gapsByReason(final.gaps),
    recovery: [outcome],
  };
}

/** Simulated sleep/wake: idle unload while asleep, transport overflow on wake, exact-once delivery. */
async function scenarioSleepWake(context: ScenarioContext): Promise<ScenarioResult> {
  const checker = createChecker();
  const { check } = checker;
  const harness = await context.createHarness({
    label: 'sleep-wake',
    audioRingCapacity: 64,
    eventQueueCapacity: 128,
    spoolQuotaBytes: 4 * MIB,
  });
  let sequence = 0;
  for (let frame = 0; frame < 40; frame += 1) harness.postAudio({ sequence: sequence++, bytes: 640 });
  harness.scheduler.submitJob({ id: 'pre-sleep', class: 'asr', steps: ['window'] });
  await harness.drainAll();

  const sleepAtMs = 60_000;
  harness.setNow(sleepAtMs);
  harness.scheduler.tick();
  const unloadsBeforeSleep = harness.counters.unloads;
  harness.setNow(sleepAtMs + 45 * 60 * 1_000);
  harness.scheduler.tick();
  const asleep = harness.snapshot();
  check(unloadsBeforeSleep === 0, 'no_unload_before_sleep', 'models stay resident during active use');
  check(asleep.models.resident === false, 'sleep_unloads_models', 'a 45 minute sleep must unload models');
  check(harness.counters.unloads === 1, 'sleep_unloads_once', `unloads ${harness.counters.unloads} must be 1`);
  check(asleep.audio.depth === 0 && asleep.events.depth === 0, 'sleep_queues_empty',
    'nothing may stay queued while the machine sleeps');

  const wakeAtMs = sleepAtMs + 45 * 60 * 1_000 + 1_000;
  harness.setNow(wakeAtMs);
  const wakeBurst = 200;
  const attempted: Array<Readonly<{ sequence: number; receipt: AudioReceipt }>> = [];
  for (let frame = 0; frame < wakeBurst; frame += 1) {
    const frameSequence = sequence++;
    attempted.push({ sequence: frameSequence, receipt: harness.postAudio({ sequence: frameSequence, bytes: 960 }) });
  }
  const dropped = attempted.filter((entry) => !entry.receipt.accepted);
  const discontinuityCoverage = new Set<number>();
  for (const entry of dropped) {
    const discontinuity = entry.receipt.discontinuity;
    if (discontinuity === undefined) continue;
    for (let value = discontinuity.firstSequence; value <= discontinuity.lastSequence; value += 1) {
      discontinuityCoverage.add(value);
    }
  }
  check(dropped.length > 0, 'wake_overflow_observed',
    'the wake burst must overflow the transport ring so the discontinuity path is exercised');
  check(dropped.every((entry) => discontinuityCoverage.has(entry.sequence)), 'wake_discontinuity_declared',
    'every frame dropped on wake must fall inside a declared discontinuity range');
  check(asleep.models.resident === false && attempted.some((entry) => entry.receipt.accepted), 'wake_accepts_frames_while_unloaded',
    'frames must be accepted on wake even before models reload');

  await harness.drainAll();
  const afterWake = harness.snapshot();
  check(afterWake.audio.depth === 0, 'wake_ring_drained', 'the ring must drain after wake');
  check(afterWake.models.resident === true, 'wake_activity_reloads_models',
    'delivering the wake frames is useful activity and must reload models');
  harness.scheduler.submitJob({ id: 'post-wake', class: 'asr', steps: ['window'] });
  harness.setNow(wakeAtMs + 1_000);
  await harness.drainAll();
  const postWake = harness.snapshot();
  check(postWake.jobs.every((job) => job.status === 'completed'), 'wake_work_completes', 'post-wake work must complete');
  check(harness.counters.workDuringAudioCallbacks === 0, 'wake_audio_callback_no_work',
    'the wake burst must never run work inside the audio callback');
  check(harness.counters.spoolOverQuotaBytes === 0 && harness.counters.spoolOfferedBytes <= 4 * MIB, 'wake_spool_bounded',
    'the spool must stay inside its quota across sleep and wake');

  const outcome = recovery('sleep_wake', 'system_sleep_and_wake_burst', checker.failures.length === 0,
    `unloaded during sleep, ${dropped.length} frames declared as discontinuities, models reloaded on wake`);
  await harness.close();
  return {
    id: 'sleep_wake',
    passed: checker.failures.length === 0,
    checks: checker.checks,
    failures: checker.failures,
    measurements: {
      wakeBurstFrames: wakeBurst,
      droppedOnWake: dropped.length,
      unloads: harness.counters.unloads,
      maxAudioCallbackMicros: Math.round(harness.counters.audioCallbackMaxMicros),
    },
    counters: scenarioCounters(harness, postWake),
    gapsByReason: gapsByReason(postWake.gaps),
    recovery: [outcome],
  };
}

/** Network partition: durable decisions survive an offline store and persist exactly once on heal. */
async function scenarioNetworkPartition(context: ScenarioContext): Promise<ScenarioResult> {
  const checker = createChecker();
  const { check } = checker;
  const harness = await context.createHarness({
    label: 'network-partition',
    audioRingCapacity: 32,
    eventQueueCapacity: 64,
    spoolQuotaBytes: 2 * MIB,
  });
  const decisionIds: string[] = [];
  let offset = 0;
  for (let index = 0; index < 20; index += 1) {
    const kind: DurableEvent['kind'] = index % 4 === 0 ? 'result' : 'approval';
    const id = `decision-${index}`;
    decisionIds.push(id);
    const receipt = harness.enqueue({ id, kind, bytes: 256, offset });
    check(receipt.accepted, 'partition_decision_accepted', `decision ${id} must be accepted while offline`);
    offset += 256;
    harness.enqueue({ id: `raw-${index}`, kind: 'raw_output', bytes: 512, offset });
    offset += 512;
  }

  harness.failPersist('network unreachable: durable store offline');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    harness.setNow(attempt * 1_000);
    await harness.pump();
  }
  const offline = harness.snapshot();
  check(offline.events.depth === decisionIds.length * 2, 'partition_retains_full_backlog',
    `all ${decisionIds.length * 2} queued events must stay queued while the store is offline (depth ${offline.events.depth})`);
  check(offline.events.depth <= 64, 'partition_backlog_bounded',
    `the retained backlog ${offline.events.depth} must stay inside eventQueueCapacity 64`);
  check(harness.persistedEventIds().length === 0, 'partition_persisted_nothing',
    'no decision may be reported as persisted while the store is offline');
  check(offline.events.persistFailures > 0, 'partition_failures_counted',
    'the retained persist failures must be counted');
  check(offline.gaps.every((gap) => (gap.sourceEventId ?? '').startsWith('raw-')), 'partition_gaps_are_raw_only',
    'offline gaps may only describe raw output, never approvals or results');
  check(harness.counters.spoolOverQuotaBytes === 0, 'partition_spool_bounded',
    'the local spool must stay inside its quota during the partition');

  harness.failPersist(null);
  harness.setNow(10_000);
  const pumps = await harness.drainAll();
  const healed = harness.snapshot();
  const persisted = harness.persistedEventIds();
  check(
    persisted.length === decisionIds.length && decisionIds.every((id, index) => persisted[index] === id),
    'partition_persists_every_decision_exactly_once',
    `persisted ${persisted.length}/${decisionIds.length} decisions in order`,
  );
  check(healed.events.depth === 0, 'partition_recovers_queue', 'the backlog must drain after the partition heals');
  check(healed.events.persistFailures === offline.events.persistFailures, 'partition_failure_counter_settles',
    'the failure counter must stop growing once the store is reachable');

  // Saturated backlog: a persist that fails while it is in flight, with raw output arriving behind
  // it. Decisions must survive, raw output may be shed with a declared gap, and the queue must come
  // back inside eventQueueCapacity instead of growing past it.
  const saturated = await context.createHarness({
    label: 'network-partition-saturated',
    audioRingCapacity: 8,
    eventQueueCapacity: 8,
    spoolQuotaBytes: 1 * MIB,
  });
  const saturatedDecisions: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `saturated-decision-${index}`;
    saturatedDecisions.push(id);
    saturated.enqueue({ id, kind: 'approval', bytes: 256, offset: index * 256 });
  }
  saturated.failPersist('network unreachable: durable store offline');
  const started = saturated.holdPersist();
  const inFlight = saturated.pump();
  await started;
  for (let index = 0; index < 8; index += 1) {
    saturated.enqueue({ id: `saturated-raw-${index}`, kind: 'raw_output', bytes: 512, offset: 0 });
  }
  saturated.releasePersist();
  await inFlight;
  const restrained = saturated.snapshot();
  check(restrained.events.depth <= 8, 'partition_saturated_backlog_bounded',
    `a failed in-flight persist must keep the backlog inside eventQueueCapacity 8 (depth ${restrained.events.depth})`);
  check(restrained.events.depth === saturatedDecisions.length, 'partition_saturated_keeps_decisions',
    `all ${saturatedDecisions.length} decisions must survive the failed persist (depth ${restrained.events.depth})`);
  check(
    restrained.gaps.length === 8 && restrained.gaps.every((gap) => (gap.sourceEventId ?? '').startsWith('saturated-raw-')),
    'partition_saturated_sheds_raw_only',
    `the overflow must shed raw output only, saw ${JSON.stringify(restrained.gaps.map((gap) => gap.sourceEventId))}`,
  );
  check(saturated.counters.spoolOverQuotaBytes === 0, 'partition_saturated_spool_bounded',
    'the local spool must stay inside its quota while the backlog is saturated');

  saturated.failPersist(null);
  const saturatedPumps = await saturated.drainAll();
  const saturatedHealed = saturated.snapshot();
  const saturatedPersisted = saturated.persistedEventIds();
  check(
    saturatedPersisted.length === saturatedDecisions.length
    && saturatedDecisions.every((id, index) => saturatedPersisted[index] === id),
    'partition_saturated_recovers_exactly_once',
    `persisted ${saturatedPersisted.length}/${saturatedDecisions.length} decisions in order`,
  );
  check(saturatedHealed.events.depth === 0, 'partition_saturated_recovers_queue',
    'the saturated backlog must drain after the partition heals');
  check(harness.counters.workDuringAudioCallbacks === 0, 'partition_audio_callback_no_work',
    'the audio callback must never run work, even while the durable store is offline');

  const outcome = recovery('network_partition', 'durable_store_offline', checker.failures.length === 0,
    `${decisionIds.length} decisions retained offline and persisted exactly once after ${pumps} heal pumps`);
  await saturated.close();
  await harness.close();
  return {
    id: 'network_partition',
    passed: checker.failures.length === 0,
    checks: checker.checks,
    failures: checker.failures,
    measurements: {
      decisions: decisionIds.length,
      persistFailures: healed.events.persistFailures,
      decisionsRetainedOffline: offline.events.depth,
      decisionsPersistedAfterHeal: persisted.length,
      healPumps: pumps,
      saturatedBacklogDepth: restrained.events.depth,
      saturatedDecisionsRetained: restrained.events.depth,
      saturatedRawShed: restrained.gaps.length,
      saturatedHealPumps: saturatedPumps,
      saturatedPersisted: saturatedPersisted.length,
      spoolStoredBytes: harness.counters.spoolStoredBytes,
    },
    counters: scenarioCounters(harness, healed),
    gapsByReason: gapsByReason(healed.gaps),
    recovery: [outcome],
  };
}

const SCENARIOS: Readonly<Record<AcceleratedScenarioId, (context: ScenarioContext) => Promise<ScenarioResult>>> = {
  long_session_invariants: scenarioLongSession,
  event_burst_1000_per_s: scenarioEventBurst,
  large_logs: scenarioLargeLogs,
  worker_crash: scenarioWorkerCrash,
  sleep_wake: scenarioSleepWake,
  network_partition: scenarioNetworkPartition,
};

function combineCounters(scenarios: readonly ScenarioResult[]): AcceleratedCounters {
  const sum = (select: (counters: AcceleratedCounters) => number): number =>
    scenarios.reduce((total, scenario) => total + select(scenario.counters), 0);
  const peak = (
    select: (counters: AcceleratedCounters) => number,
    limit: (counters: AcceleratedCounters) => number,
  ): Readonly<{ value: number; limit: number }> => {
    let best: AcceleratedCounters | null = null;
    for (const scenario of scenarios) {
      if (best === null || select(scenario.counters) > select(best)) best = scenario.counters;
    }
    return best === null ? { value: 0, limit: 0 } : { value: select(best), limit: limit(best) };
  };
  const audio = peak((counters) => counters.audioQueueHighWater, (counters) => counters.audioRingCapacity);
  const events = peak((counters) => counters.eventQueueHighWater, (counters) => counters.eventQueueCapacity);
  const spool = peak((counters) => counters.spoolBytesHighWater, (counters) => counters.spoolQuotaBytes);
  return {
    audioQueueHighWater: audio.value,
    audioRingCapacity: audio.limit,
    audioPosts: sum((counters) => counters.audioPosts),
    audioAccepted: sum((counters) => counters.audioAccepted),
    audioDropped: sum((counters) => counters.audioDropped),
    audioDiscontinuities: sum((counters) => counters.audioDiscontinuities),
    eventQueueHighWater: events.value,
    eventQueueCapacity: events.limit,
    eventsEnqueued: sum((counters) => counters.eventsEnqueued),
    eventsAccepted: sum((counters) => counters.eventsAccepted),
    eventsShed: sum((counters) => counters.eventsShed),
    spoolBytesHighWater: spool.value,
    spoolQuotaBytes: spool.limit,
    spoolOverQuotaBytes: sum((counters) => counters.spoolOverQuotaBytes),
    spoolRecords: sum((counters) => counters.spoolRecords),
    gapRecords: sum((counters) => counters.gapRecords),
    gappedBytes: sum((counters) => counters.gappedBytes),
    droppedFrames: sum((counters) => counters.droppedFrames),
    persistFailures: sum((counters) => counters.persistFailures),
    workDuringAudioCallbacks: sum((counters) => counters.workDuringAudioCallbacks),
    asyncReceipts: sum((counters) => counters.asyncReceipts),
  };
}

function combineGaps(scenarios: readonly ScenarioResult[]): Record<GapReason, number> {
  const counts: Record<GapReason, number> = { queue_overflow: 0, disk_quota: 0, memory_pressure: 0 };
  for (const scenario of scenarios) {
    counts.queue_overflow += scenario.gapsByReason.queue_overflow;
    counts.disk_quota += scenario.gapsByReason.disk_quota;
    counts.memory_pressure += scenario.gapsByReason.memory_pressure;
  }
  return counts;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Measurement keys that depend on wall-clock timing or on process RSS. They are reported, but are
 * excluded from the fingerprint so two runs of the same seed produce one stable fingerprint.
 */
const VOLATILE_MEASUREMENT_PATTERN = /(rss|micros)/i;

function fingerprintProjection(
  counters: AcceleratedCounters,
  gaps: Record<GapReason, number>,
  scenarios: readonly ScenarioResult[],
): unknown {
  return {
    counters,
    gapsByReason: gaps,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      passed: scenario.passed,
      checks: scenario.checks,
      gapsByReason: scenario.gapsByReason,
      measurements: Object.fromEntries(
        Object.entries(scenario.measurements).filter(([key]) => !VOLATILE_MEASUREMENT_PATTERN.test(key)),
      ),
    })),
  };
}

function missingScenario(id: AcceleratedScenarioId): ScenarioResult {
  return {
    id,
    passed: false,
    checks: [],
    failures: [`scenario_missing: ${id} did not execute`],
    measurements: {},
    counters: {
      audioQueueHighWater: 0,
      audioRingCapacity: 0,
      audioPosts: 0,
      audioAccepted: 0,
      audioDropped: 0,
      audioDiscontinuities: 0,
      eventQueueHighWater: 0,
      eventQueueCapacity: 0,
      eventsEnqueued: 0,
      eventsAccepted: 0,
      eventsShed: 0,
      spoolBytesHighWater: 0,
      spoolQuotaBytes: 0,
      spoolOverQuotaBytes: 0,
      spoolRecords: 0,
      gapRecords: 0,
      gappedBytes: 0,
      droppedFrames: 0,
      persistFailures: 0,
      workDuringAudioCallbacks: 0,
      asyncReceipts: 0,
    },
    gapsByReason: { queue_overflow: 0, disk_quota: 0, memory_pressure: 0 },
    recovery: [{ scenario: id, fault: 'not_executed', outcome: 'failed', detail: 'scenario never ran' }],
  };
}

export async function runAcceleratedReplay(options: AcceleratedReplayOptions = {}): Promise<AcceleratedReplayResult> {
  const seed = options.seed ?? DEFAULT_SEED;
  const startedAt = performance.now();
  const rssStartBytes = process.memoryUsage().rss;
  let rssHighWaterBytes = rssStartBytes;
  const sampleLines: string[] = [];
  const sink: SampleSink = {
    push: (sample) => {
      if (options.samplesPath !== undefined) sampleLines.push(JSON.stringify(sample));
    },
  };
  const spoolRoot = await mkdtemp(join(tmpdir(), 'echopilot-accelerated-'));
  const create = async (config: HarnessConfig): Promise<Harness> => createHarness(spoolRoot, config, sink);

  // Cold start: process start → the first ASR frame delivered through a scheduler pump.
  const coldHarness = await create({ label: 'cold-start', audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1 * MIB });
  coldHarness.postAudio({ sequence: 0, bytes: 640 });
  await coldHarness.scheduler.pump();
  const coldStartMs = Math.round(process.uptime() * 1_000);
  await coldHarness.close();

  const results: ScenarioResult[] = [];
  for (const id of ACCELERATED_REQUIRED_SCENARIOS) {
    const scenario = SCENARIOS[id];
    if (scenario === undefined) {
      results.push(missingScenario(id));
      continue;
    }
    results.push(await scenario({ createHarness: create, samples: sink }));
    rssHighWaterBytes = Math.max(rssHighWaterBytes, process.memoryUsage().rss);
  }

  const counters = combineCounters(results);
  const failures: string[] = [];
  for (const scenario of results) {
    if (!scenario.passed) failures.push(`scenario_failed:${scenario.id}`);
  }
  if (results.length !== ACCELERATED_REQUIRED_SCENARIOS.length) failures.push('scenario_coverage_incomplete');
  if (results.some((scenario) => scenario.recovery.some((entry) => entry.outcome !== 'recovered'))) {
    failures.push('recovery_incomplete');
  }
  if (counters.spoolOverQuotaBytes > 0) failures.push('spool_quota_violated');
  if (counters.workDuringAudioCallbacks > 0) failures.push('audio_callback_ran_work');
  if (counters.asyncReceipts > 0) failures.push('audio_callback_async_receipt');
  const audioCallback = {
    posts: counters.audioPosts,
    maxCallbackMicros: results.reduce((maximum, scenario) =>
      Math.max(maximum, typeof scenario.measurements['maxAudioCallbackMicros'] === 'number'
        ? scenario.measurements['maxAudioCallbackMicros'] as number
        : 0), 0),
    workDuringAudioCallbacks: counters.workDuringAudioCallbacks,
    synchronous: counters.workDuringAudioCallbacks === 0 && counters.asyncReceipts === 0,
  };
  const longSession = results.find((scenario) => scenario.id === 'long_session_invariants');
  const measurementNumber = (scenario: ScenarioResult | undefined, key: string): number | null =>
    scenario !== undefined && typeof scenario.measurements[key] === 'number'
      ? scenario.measurements[key] as number
      : null;
  const result: AcceleratedReplayResult = {
    schemaVersion: 1,
    mode: 'accelerated',
    generatedAt: new Date().toISOString(),
    seed,
    host: {
      name: hostname(),
      model: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryBytes: totalmem(),
      arch: arch(),
      release: release(),
    },
    simulatedDurationMs: measurementNumber(longSession, 'simulatedMs') ?? EIGHT_HOURS_MS,
    requiredSimulatedDurationMs: EIGHT_HOURS_MS,
    wallClockMs: Math.round(performance.now() - startedAt),
    coldStartMs,
    coldStartBudgetMs: 15_000,
    counters,
    gapsByReason: combineGaps(results),
    audioCallback,
    memory: {
      rssStartBytes,
      rssEndBytes: process.memoryUsage().rss,
      rssHighWaterBytes,
      rssHour1Bytes: measurementNumber(longSession, 'rssHour1Bytes'),
      rssHour8Bytes: measurementNumber(longSession, 'rssHour8Bytes'),
      maxRssGrowthBytes: rssHighWaterBytes - rssStartBytes,
    },
    recovery: results.flatMap((scenario) => scenario.recovery),
    scenarios: results,
    requiredScenarios: [...ACCELERATED_REQUIRED_SCENARIOS],
    counterFingerprint: fingerprint(fingerprintProjection(counters, combineGaps(results), results)),
    failures,
    passed: failures.length === 0,
  };
  await rm(spoolRoot, { recursive: true, force: true });
  if (options.samplesPath !== undefined && sampleLines.length > 0) {
    await mkdir(dirname(options.samplesPath), { recursive: true });
    await writeFile(options.samplesPath, `${sampleLines.join('\n')}\n`);
  }
  return result;
}

function parseArgs(argv: readonly string[]): Readonly<{ out: string | null; samples: string | null }> {
  let out: string | null = null;
  let samples: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--out' && value !== undefined) out = value;
    else if (flag === '--samples' && value !== undefined) samples = value;
  }
  return { out, samples };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runAcceleratedReplay(args.samples === null ? {} : { samplesPath: args.samples });
  if (args.out !== null) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    mode: result.mode,
    simulatedDurationMs: result.simulatedDurationMs,
    wallClockMs: result.wallClockMs,
    coldStartMs: result.coldStartMs,
    counterFingerprint: result.counterFingerprint,
    counters: result.counters,
    recovery: result.recovery,
    scenarios: result.scenarios.map((scenario) => ({ id: scenario.id, passed: scenario.passed, failures: scenario.failures })),
    failures: result.failures,
    passed: result.passed,
  }));
  process.exitCode = result.passed ? 0 : 1;
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main();
}
