/**
 * Q02 acceptance oracle (criterion 2, plus the scheduler half of the ticket scope) —
 * resource/backpressure failures → recovery.
 *
 * Ticket Q02 (IMPLEMENTATION_PLAN.md §5.10 "One scheduler arbitrates inference… Backpressure spools
 * events to encrypted disk up to quota; it never blocks an audio callback", §5.10 gap records,
 * §4.4 "Event ingestion … bounded queue … no audio callback blocked by ingestion" and the
 * "Local model unload" hard budget; BACKLOG.json Q02). Nothing here touches real time, real
 * hardware, or a real database: every clock, worker, disk, and host call is injected and recorded,
 * so the same run is byte-identical every time.
 *
 * Frozen seam (the implementation of Q02 owns packages/core/src/scheduler/index.ts and must export
 * exactly this; the test-role never edits that file):
 *
 *   createResourceScheduler(options) → ResourceScheduler
 *
 *   options:
 *     now(): number
 *       Injected monotonic clock in milliseconds. The only time source; never Date.now().
 *     audioRingCapacity: number
 *       Hard bound (≥ 1) for buffered transport frames between the native audio callback and the
 *       ASR/JS pipeline.
 *     eventQueueCapacity: number
 *       Hard bound (≥ 1) for the durable-event backlog.
 *     spoolQuotaBytes: number
 *       Hard bound (≥ 1) for encrypted raw spooling.
 *     jsWork(label, payload): Promise<string>
 *       The ONLY place the scheduler may start JavaScript/database work, and only from pump().
 *       The scheduler calls it as:
 *         'asr.frame'       payload = the buffered frame (delivery of accepted audio)
 *         'durable.persist' payload = an 'approval'/'result' event
 *         `job:${job.id}:${step}` payload = one bounded job step
 *       It is never called from postAudioFrame() or enqueue(), and postAudioFrame() never waits on
 *       a pending jsWork promise.
 *     spool(record: { id, bytes, offset }): boolean
 *       Injected encrypted disk. true = stored, false = quota refusal. The scheduler must never
 *       pass it more than spoolQuotaBytes in total for raw output; a refusal becomes a gap record.
 *     unloadModels(): void
 *       Host double; called once when the idle window elapses (see MODEL_IDLE_UNLOAD_MS).
 *
 *   scheduler:
 *     postAudioFrame({ sequence, bytes }) → AudioPostReceipt
 *       Synchronous and non-throwing, even when the ring is full or when JS/database work is
 *       pending. When the ring is full the incoming frame is rejected (accepted: false) and its
 *       sequence range is reported as a discontinuity; the ring never grows past capacity.
 *     enqueue({ id, kind, bytes, offset }) → EnqueueReceipt
 *       Synchronous and bounded. kind 'raw_output' may be shed when the backlog is full, but only
 *       with an explicit gap record carrying the shed byte range; kind 'approval' and 'result'
 *       are never silently dropped, so an arriving approval always displaces raw backlog instead
 *       of being rejected.
 *     submitJob({ id, class, steps, slot? }) → void
 *       class ∈ SCHEDULER_CLASS_PRIORITY; slot ∈ 'generation' | 'synthesis' | 'import' |
 *       'consolidation' when the job needs one of the one-at-a-time resources of §5.10.
 *     pump() → Promise<readonly PumpReceipt[]>
 *       Performs at most one safe step of the highest-priority ready job, delivers buffered audio
 *       to jsWork('asr.frame', …) in ascending sequence order exactly once, drains queued events
 *       (raw → spool with gap records on refusal, approvals/results → jsWork('durable.persist')),
 *       and reports what it did. A lower-priority running job is never continued while a
 *       higher-priority job is ready: it becomes 'preempted' between steps and resumes from its
 *       checkpoint, so no committed step is ever executed twice.
 *     tick() → void
 *       Idle accounting. After MODEL_IDLE_UNLOAD_MS without a conversation, dictation, or queued
 *       useful inference it calls options.unloadModels() exactly once.
 *     pressure('warning' | 'critical') → { unloaded, gaps }
 *       Memory pressure sheds raw backlog (declared with reason 'memory_pressure') and unloads
 *       models; durable approvals/results survive and are persisted on the next pump.
 *     stats() → SchedulerStats
 *       { audio: { depth, acceptedFrames, droppedFrames, discontinuities },
 *         events: { depth, accepted, shed },
 *         spool: { storedBytes, records },
 *         gaps, jobs: [{ jobId, jobClass, status, completedSteps, attempts, lastError? }],
 *         models: { resident, lastUnloadAt? },
 *         slots: { generation, synthesis, import, consolidation } }
 *
 *   constants: SCHEDULER_CLASS_PRIORITY = ['control','asr','correction','narration',
 *              'consolidation','import']; MODEL_IDLE_UNLOAD_MS = 90_000; IDLE_RETURN_MS = 15_000.
 *
 * Remaining limitation this oracle reports instead of claiming: real AVAudioEngine callbacks and
 * real M4/M2 hardware qualification are not exercised here; the injected harness proves the
 * scheduling/backpressure contract deterministically, and the hardware evidence stays with
 * scripts/bench-macos/ (ticket Q02, ticket Q03 gate).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type AudioFrame = Readonly<{ sequence: number; bytes: number }>;
type AudioDiscontinuity = Readonly<{ firstSequence: number; lastSequence: number; droppedFrames: number }>;
type AudioPostReceipt = Readonly<{ accepted: boolean; depth: number; discontinuity?: AudioDiscontinuity }>;

type DurableEventKind = 'raw_output' | 'approval' | 'result';
type DurableEvent = Readonly<{ id: string; kind: DurableEventKind; bytes: number; offset: number }>;

type GapReason = 'queue_overflow' | 'disk_quota' | 'memory_pressure';
type GapRecord = Readonly<{
  fromOffset: number;
  toOffset: number;
  omittedBytes: number;
  reason: GapReason;
  sourceEventId?: string;
}>;
type EnqueueReceipt = Readonly<{ accepted: boolean; depth: number; gap?: GapRecord }>;

type JobClass = 'control' | 'asr' | 'correction' | 'narration' | 'consolidation' | 'import';
type JobSlot = 'generation' | 'synthesis' | 'import' | 'consolidation';
type JobStatus = 'queued' | 'running' | 'preempted' | 'completed' | 'failed';
type SchedulerJob = Readonly<{ id: string; class: JobClass; steps: readonly string[]; slot?: JobSlot }>;
type PumpReceipt = Readonly<{
  jobId: string;
  jobClass: JobClass;
  step: string;
  status: 'completed' | 'failed' | 'preempted';
  error?: string;
}>;

type JobRecord = Readonly<{
  jobId: string;
  jobClass: JobClass;
  status: JobStatus;
  completedSteps: number;
  attempts: number;
  lastError?: string;
}>;

type SchedulerStats = Readonly<{
  audio: Readonly<{ depth: number; acceptedFrames: number; droppedFrames: number; discontinuities: number }>;
  events: Readonly<{ depth: number; accepted: number; shed: number }>;
  spool: Readonly<{ storedBytes: number; records: number }>;
  gaps: readonly GapRecord[];
  jobs: readonly JobRecord[];
  models: Readonly<{ resident: boolean; lastUnloadAt?: number }>;
  slots: Readonly<{ generation: number; synthesis: number; import: number; consolidation: number }>;
}>;

type SpoolRecord = Readonly<{ id: string; bytes: number; offset: number }>;

type SchedulerOptions = Readonly<{
  now: () => number;
  audioRingCapacity: number;
  eventQueueCapacity: number;
  spoolQuotaBytes: number;
  jsWork: (label: string, payload: unknown) => Promise<string>;
  spool: (record: SpoolRecord) => boolean;
  unloadModels: () => void;
}>;

type ResourceScheduler = Readonly<{
  postAudioFrame(frame: AudioFrame): AudioPostReceipt;
  enqueue(event: DurableEvent): EnqueueReceipt;
  submitJob(job: SchedulerJob): void;
  pump(): Promise<readonly PumpReceipt[]>;
  tick(): void;
  pressure(level: 'warning' | 'critical'): Readonly<{ unloaded: boolean; gaps: readonly GapRecord[] }>;
  stats(): SchedulerStats;
}>;

type SchedulerModule = Readonly<{
  createResourceScheduler(options: SchedulerOptions): ResourceScheduler;
  SCHEDULER_CLASS_PRIORITY: readonly JobClass[];
  MODEL_IDLE_UNLOAD_MS: number;
  IDLE_RETURN_MS: number;
}>;

const MISSING_MODULE_MESSAGE =
  'Missing required behavior: packages/core/src/scheduler/index.ts must export '
  + 'createResourceScheduler({ now, audioRingCapacity, eventQueueCapacity, spoolQuotaBytes, jsWork, spool, unloadModels }), '
  + 'SCHEDULER_CLASS_PRIORITY, MODEL_IDLE_UNLOAD_MS, and IDLE_RETURN_MS (see the header of this oracle).';

async function loadSchedulerModule(): Promise<SchedulerModule> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('./index.js')) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(MISSING_MODULE_MESSAGE);
    }
    throw error;
  }
  assert.equal(typeof loaded.createResourceScheduler, 'function', MISSING_MODULE_MESSAGE);
  assert.equal(typeof loaded.MODEL_IDLE_UNLOAD_MS, 'number', MISSING_MODULE_MESSAGE);
  assert.equal(typeof loaded.IDLE_RETURN_MS, 'number', MISSING_MODULE_MESSAGE);
  assert.ok(Array.isArray(loaded.SCHEDULER_CLASS_PRIORITY), MISSING_MODULE_MESSAGE);
  return loaded as unknown as SchedulerModule;
}

type WorkCall = Readonly<{ label: string; payload: unknown }>;

type Harness = Readonly<{
  scheduler: ResourceScheduler;
  calls: WorkCall[];
  workDuringAudio: WorkCall[];
  offered: SpoolRecord[];
  stored: SpoolRecord[];
  refused: SpoolRecord[];
  hang(label: string): void;
  fail(label: string, message: string): void;
  release(): void;
  setNow(value: number): void;
  unloadCalls(): number;
  post(frame: AudioFrame): AudioPostReceipt;
  drain(): Promise<readonly PumpReceipt[]>;
  drainAll(): Promise<readonly PumpReceipt[]>;
}>;

function createHarness(
  module: SchedulerModule,
  overrides: {
    audioRingCapacity?: number;
    eventQueueCapacity?: number;
    spoolQuotaBytes?: number;
  } = {},
): Harness {
  let nowMs = 0;
  let insideAudioCallback = false;
  const calls: WorkCall[] = [];
  const workDuringAudio: WorkCall[] = [];
  const hung = new Set<string>();
  const failing = new Map<string, string>();
  const releases: Array<() => void> = [];
  const offered: SpoolRecord[] = [];
  const stored: SpoolRecord[] = [];
  const refused: SpoolRecord[] = [];
  let storedBytes = 0;
  let unloadCalls = 0;

  const audioRingCapacity = overrides.audioRingCapacity ?? 64;
  const eventQueueCapacity = overrides.eventQueueCapacity ?? 32;
  const spoolQuotaBytes = overrides.spoolQuotaBytes ?? 4096;

  const scheduler = module.createResourceScheduler({
    now: () => nowMs,
    audioRingCapacity,
    eventQueueCapacity,
    spoolQuotaBytes,
    jsWork: async (label, payload) => {
      const call: WorkCall = { label, payload };
      calls.push(call);
      if (insideAudioCallback) workDuringAudio.push(call);
      const failure = failing.get(label);
      if (failure !== undefined) throw new Error(failure);
      if (hung.has(label)) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      }
      return `ok:${label}`;
    },
    spool: (record) => {
      if (insideAudioCallback) workDuringAudio.push({ label: 'spool', payload: record });
      offered.push(record);
      if (storedBytes + record.bytes > spoolQuotaBytes) {
        refused.push(record);
        return false;
      }
      storedBytes += record.bytes;
      stored.push(record);
      return true;
    },
    unloadModels: () => {
      if (insideAudioCallback) workDuringAudio.push({ label: 'unloadModels', payload: undefined });
      unloadCalls += 1;
    },
  });

  const post = (frame: AudioFrame): AudioPostReceipt => {
    insideAudioCallback = true;
    try {
      const receipt = scheduler.postAudioFrame(frame);
      assert.ok(
        !(receipt instanceof Promise),
        'postAudioFrame must be synchronous: the audio callback cannot wait on JS/database work',
      );
      return receipt;
    } finally {
      insideAudioCallback = false;
    }
  };

  const drain = async (): Promise<readonly PumpReceipt[]> => {
    insideAudioCallback = false;
    return scheduler.pump();
  };

  const drainAll = async (): Promise<readonly PumpReceipt[]> => {
    const receipts: PumpReceipt[] = [];
    for (let guard = 0; guard < 5_000; guard += 1) {
      const batch = await drain();
      receipts.push(...batch);
      const stats = scheduler.stats();
      if (batch.length === 0 && stats.audio.depth === 0 && stats.events.depth === 0) return receipts;
    }
    assert.fail(
      'the scheduler never drained: queues must stay bounded and pump() must make progress '
      + `(audio depth ${scheduler.stats().audio.depth}, event depth ${scheduler.stats().events.depth})`,
    );
  };

  return {
    scheduler,
    calls,
    workDuringAudio,
    offered,
    stored,
    refused,
    hang: (label) => hung.add(label),
    fail: (label, message) => failing.set(label, message),
    release: () => {
      while (releases.length > 0) {
        const resolve = releases.shift();
        resolve?.();
      }
    },
    setNow: (value) => {
      nowMs = value;
    },
    unloadCalls: () => unloadCalls,
    post,
    drain,
    drainAll,
  };
}

function jobStepCalls(calls: readonly WorkCall[]): readonly string[] {
  return calls
    .filter((call) => call.label.startsWith('job:'))
    .map((call) => call.label.slice('job:'.length));
}

test('the frozen §5.10 priority order and unload windows are exported exactly', async () => {
  const module = await loadSchedulerModule();
  assert.deepEqual(
    [...module.SCHEDULER_CLASS_PRIORITY],
    ['control', 'asr', 'correction', 'narration', 'consolidation', 'import'],
    'controls/audio first, ASR next, correction, narration, consolidation, cold imports last',
  );
  assert.equal(module.MODEL_IDLE_UNLOAD_MS, 90_000, '§4.4: unload after 90 s without useful inference');
  assert.equal(module.IDLE_RETURN_MS, 15_000, '§4.4: return to idle budget within 15 s');
});

test('the audio callback never waits on JS/database work and the transport ring stays bounded', async () => {
  const module = await loadSchedulerModule();
  const harness = createHarness(module, { audioRingCapacity: 64, eventQueueCapacity: 16, spoolQuotaBytes: 4096 });

  // JS/database work that is deliberately left hanging: any callback that joined on it would stall.
  harness.hang('job:slow-consolidation:wait-for-db');
  harness.scheduler.submitJob({ id: 'slow-consolidation', class: 'consolidation', steps: ['wait-for-db'] });
  const hangingPump = harness.scheduler.pump();

  const attempts: Array<Readonly<{ frame: AudioFrame; receipt: AudioPostReceipt }>> = [];
  for (let sequence = 0; sequence < 200; sequence += 1) {
    const frame: AudioFrame = { sequence, bytes: 640 };
    attempts.push({ frame, receipt: harness.post(frame) });
  }

  assert.equal(
    harness.workDuringAudio.length,
    0,
    'the audio callback must not start JS/database work (jsWork/spool/unload) synchronously',
  );

  const accepted = attempts.filter((entry) => entry.receipt.accepted);
  const dropped = attempts.filter((entry) => !entry.receipt.accepted);
  assert.ok(dropped.length > 0, 'a 64-frame ring must reject overflow instead of growing without bound');
  for (const entry of attempts) {
    assert.ok(
      entry.receipt.depth <= 64,
      `ring depth ${entry.receipt.depth} must never exceed audioRingCapacity 64`,
    );
  }

  const stats = harness.scheduler.stats();
  assert.equal(stats.audio.acceptedFrames, accepted.length, 'acceptedFrames must match the accepted receipts');
  assert.equal(stats.audio.droppedFrames, dropped.length, 'droppedFrames must match the rejected receipts');
  assert.equal(stats.audio.depth, accepted.length, 'accepted frames are still buffered before the first drain');
  assert.ok(stats.audio.discontinuities > 0, 'overflow must be reported as a discontinuity, not silently');

  const discontinuityCoverage = new Set<number>();
  for (const entry of dropped) {
    const discontinuity = entry.receipt.discontinuity;
    assert.ok(discontinuity, `dropped frame ${entry.frame.sequence} must carry a discontinuity receipt`);
    assert.ok(discontinuity.droppedFrames >= 1, 'a discontinuity must count at least the rejected frame');
    for (let sequence = discontinuity.firstSequence; sequence <= discontinuity.lastSequence; sequence += 1) {
      discontinuityCoverage.add(sequence);
    }
  }
  for (const entry of dropped) {
    assert.ok(
      discontinuityCoverage.has(entry.frame.sequence),
      `dropped frame ${entry.frame.sequence} must be inside a reported discontinuity range`,
    );
  }

  harness.release();
  await hangingPump;
  await harness.drainAll();

  const delivered = harness.calls
    .filter((call) => call.label === 'asr.frame')
    .map((call) => (call.payload as AudioFrame).sequence);
  assert.equal(new Set(delivered).size, delivered.length, 'an accepted frame must be delivered exactly once');
  assert.deepEqual(
    [...delivered].sort((left, right) => left - right),
    accepted.map((entry) => entry.frame.sequence).sort((left, right) => left - right),
    'every accepted frame — and only accepted frames — must reach the ASR pipeline',
  );
  for (let index = 1; index < delivered.length; index += 1) {
    const previous = delivered[index - 1];
    const current = delivered[index];
    assert.ok(previous !== undefined && current !== undefined && previous < current, 'delivery stays in sequence order');
  }
  assert.equal(harness.scheduler.stats().audio.depth, 0, 'the ring is empty after the drain');
});

test('event backlog and encrypted spool stay bounded while every shed raw event is declared and decisions survive', async () => {
  const module = await loadSchedulerModule();
  const harness = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 32, spoolQuotaBytes: 4096 });

  const raw: DurableEvent[] = [];
  let offset = 0;
  for (let index = 0; index < 64; index += 1) {
    raw.push({ id: `raw-${String(index).padStart(3, '0')}`, kind: 'raw_output', bytes: 256, offset });
    offset += 256;
  }

  const receipts = raw.map((event) => harness.scheduler.enqueue(event));
  let stats = harness.scheduler.stats();
  assert.ok(
    stats.events.depth <= 32,
    `the durable-event backlog (${stats.events.depth}) must never exceed eventQueueCapacity`,
  );
  assert.equal(
    receipts.filter((receipt) => receipt.accepted).length + receipts.filter((receipt) => !receipt.accepted).length,
    raw.length,
    'every enqueue is answered synchronously with accept or an explicit gap',
  );
  for (const [index, receipt] of receipts.entries()) {
    const event = raw[index];
    if (event === undefined || receipt.accepted) continue;
    assert.ok(receipt.gap, `shed raw event ${event.id} must carry a gap record`);
    assert.ok(receipt.gap.omittedBytes >= event.bytes, 'the gap must count every shed byte');
  }

  // A decision event while the raw backlog is saturated: §5.10 forbids silently dropping it.
  const approval: DurableEvent = { id: 'approval-001', kind: 'approval', bytes: 128, offset };
  const approvalReceipt = harness.scheduler.enqueue(approval);
  assert.equal(
    approvalReceipt.accepted,
    true,
    'an approval must displace raw backlog (declared as a gap) rather than be rejected',
  );

  await harness.drainAll();

  stats = harness.scheduler.stats();
  assert.ok(
    harness.offered.reduce((total, record) => total + record.bytes, 0) <= 4096,
    'the encrypted spool must never be offered more than spoolQuotaBytes of raw output',
  );
  assert.equal(harness.offered.reduce((total, record) => total + record.bytes, 0), 4096);
  assert.equal(stats.spool.storedBytes, harness.stored.reduce((total, record) => total + record.bytes, 0));
  assert.equal(stats.events.depth, 0, 'the backlog drains to empty');
  assert.equal(harness.refused.length, 0, 'the scheduler must check quota before calling the spool');

  const coveredOffsets = (records: readonly GapRecord[]): Array<Readonly<{ from: number; to: number }>> =>
    records.map((gap) => ({ from: gap.fromOffset, to: gap.toOffset }));
  const gaps = coveredOffsets(stats.gaps);
  const isCovered = (from: number, to: number): boolean =>
    gaps.some((range) => range.from <= from && range.to >= to);

  for (const record of raw) {
    const wasStored = harness.stored.some((entry) => entry.id === record.id);
    if (!wasStored) {
      assert.ok(
        isCovered(record.offset, record.offset + record.bytes),
        `shed raw event ${record.id} (bytes ${record.offset}..${record.offset + record.bytes}) must be inside a gap record`,
      );
    }
  }
  for (const gap of stats.gaps) {
    assert.equal(
      gap.toOffset - gap.fromOffset,
      gap.omittedBytes,
      'a gap record must state the exact omitted byte range and count',
    );
  }

  const persisted = harness.calls
    .filter((call) => call.label === 'durable.persist')
    .map((call) => (call.payload as DurableEvent).id);
  assert.ok(persisted.includes('approval-001'), 'the approval must be persisted, never spooled away or dropped');
  for (const call of harness.calls.filter((entry) => entry.label === 'durable.persist')) {
    assert.notEqual((call.payload as DurableEvent).kind, 'raw_output', 'raw output is spooled, not persisted as durable');
  }
});

test('priorities, slot limits, and safe-boundary preemption resume work without repeating a committed step', async () => {
  const module = await loadSchedulerModule();
  const harness = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1024 });

  harness.scheduler.submitJob({ id: 'control-1', class: 'control', steps: ['mute'] });
  harness.scheduler.submitJob({ id: 'asr-1', class: 'asr', steps: ['window'] });
  harness.scheduler.submitJob({ id: 'correction-1', class: 'correction', steps: ['decode'], slot: 'generation' });
  harness.scheduler.submitJob({ id: 'narration-1', class: 'narration', steps: ['synthesize'], slot: 'synthesis' });
  harness.scheduler.submitJob({ id: 'consolidation-1', class: 'consolidation', steps: ['batch', 'batch-2'], slot: 'consolidation' });
  harness.scheduler.submitJob({ id: 'import-1', class: 'import', steps: ['chunk-1', 'chunk-2'], slot: 'import' });

  for (let pump = 0; pump < 12; pump += 1) await harness.drain();

  assert.deepEqual(
    jobStepCalls(harness.calls),
    [
      'control-1:mute',
      'asr-1:window',
      'correction-1:decode',
      'narration-1:synthesize',
      'consolidation-1:batch',
      'consolidation-1:batch-2',
      'import-1:chunk-1',
      'import-1:chunk-2',
    ],
    'one scheduler arbitrates inference in the §5.10 order under contention',
  );

  // Slot limits: a second job needing the same one-at-a-time resource waits for the first.
  const limited = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1024 });
  limited.scheduler.submitJob({ id: 'consolidation-a', class: 'consolidation', steps: ['a-1', 'a-2'], slot: 'consolidation' });
  limited.scheduler.submitJob({ id: 'consolidation-b', class: 'consolidation', steps: ['b-1'], slot: 'consolidation' });
  for (let pump = 0; pump < 6; pump += 1) {
    await limited.drain();
    const running = limited.scheduler.stats().jobs.filter(
      (job) => job.status === 'running' && job.jobClass === 'consolidation',
    );
    assert.ok(running.length <= 1, '§5.10 limits semantic consolidation to one active job');
  }
  const limitedCalls = jobStepCalls(limited.calls);
  assert.ok(limitedCalls.includes('consolidation-a:a-2'), 'the first consolidation job finishes');
  assert.ok(
    limitedCalls.indexOf('consolidation-b:b-1') > limitedCalls.indexOf('consolidation-a:a-2'),
    'the second consolidation job starts only after the first completes',
  );

  // Preemption at a safe boundary: a lower-priority job never continues while control work waits.
  const preempted = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1024 });
  preempted.scheduler.submitJob({ id: 'import-2', class: 'import', steps: ['chunk-1', 'chunk-2', 'chunk-3'], slot: 'import' });
  await preempted.drain();
  assert.deepEqual(jobStepCalls(preempted.calls), ['import-2:chunk-1'], 'the import started first');
  preempted.scheduler.submitJob({ id: 'control-2', class: 'control', steps: ['stop'] });
  await preempted.drain();
  const importRecord = preempted.scheduler.stats().jobs.find((job) => job.jobId === 'import-2');
  assert.equal(importRecord?.status, 'preempted', 'the interrupted job is visibly preempted, not silently killed');
  for (let pump = 0; pump < 8; pump += 1) await preempted.drain();
  assert.deepEqual(
    jobStepCalls(preempted.calls),
    ['import-2:chunk-1', 'control-2:stop', 'import-2:chunk-2', 'import-2:chunk-3'],
    'the preempted job resumes at its checkpoint and never repeats a committed step',
  );
  const importSteps = jobStepCalls(preempted.calls).filter((step) => step.startsWith('import-2:'));
  assert.equal(new Set(importSteps).size, importSteps.length, 'no committed step may run twice');
});

test('a crashed worker reports failure and releases its slot so queued work recovers', async () => {
  const module = await loadSchedulerModule();
  const harness = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1024 });

  harness.fail('job:worker-1:step-2', 'model worker exited (SIGKILL)');
  harness.scheduler.submitJob({ id: 'worker-1', class: 'correction', steps: ['step-1', 'step-2', 'step-3'], slot: 'generation' });
  harness.scheduler.submitJob({ id: 'worker-2', class: 'correction', steps: ['decode'], slot: 'generation' });

  await harness.drain();
  const failureBatch = await harness.drain();
  const failure = failureBatch.find((receipt) => receipt.jobId === 'worker-1' && receipt.status === 'failed');
  assert.ok(failure, 'a worker crash must surface as a failed pump receipt, never as a silent success');
  assert.ok(String(failure.error).includes('SIGKILL'), 'the failure keeps the underlying error visible');

  const crashed = harness.scheduler.stats().jobs.find((job) => job.jobId === 'worker-1');
  assert.equal(crashed?.status, 'failed', 'the crashed job is reported as failed');
  assert.equal(crashed?.attempts, 1, 'a crashed step is not silently retried by the scheduler');
  assert.equal(crashed?.completedSteps, 1, 'only the step that completed before the crash is committed');
  assert.equal(
    harness.calls.filter((call) => call.label === 'job:worker-1:step-2').length,
    1,
    'the crashed step must not be executed again without an explicit retry',
  );

  await harness.drain();
  assert.ok(
    harness.calls.some((call) => call.label === 'job:worker-2:decode'),
    'the released generation slot lets the queued job recover',
  );
});

test('idle windows unload models and memory pressure sheds raw data only, with recovery afterwards', async () => {
  const module = await loadSchedulerModule();
  const harness = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1024 });

  harness.post({ sequence: 0, bytes: 640 });
  harness.scheduler.submitJob({ id: 'consolidation-idle', class: 'consolidation', steps: ['batch'], slot: 'consolidation' });
  await harness.drain();

  harness.setNow(89_000);
  harness.scheduler.tick();
  assert.equal(harness.unloadCalls(), 0, 'the model stays resident inside the 90 s useful-work window');
  harness.setNow(90_000);
  harness.scheduler.tick();
  assert.equal(harness.unloadCalls(), 1, '§4.4: unload after 90 s without conversation/dictation/queued inference');
  assert.equal(harness.scheduler.stats().models.lastUnloadAt, 90_000);

  // Queued useful inference keeps the model alive across the idle window.
  harness.post({ sequence: 1, bytes: 640 });
  harness.scheduler.submitJob({ id: 'queued-consolidation', class: 'consolidation', steps: ['later'], slot: 'consolidation' });
  harness.setNow(180_000);
  harness.scheduler.tick();
  assert.equal(harness.unloadCalls(), 1, 'queued useful inference is activity, not idleness');
  await harness.drain();
  harness.setNow(270_000);
  harness.scheduler.tick();
  assert.equal(harness.unloadCalls(), 2, 'after the queued work completes the idle window runs again');

  // Memory pressure: raw backlog is shed with explicit gaps; decisions survive and are persisted.
  const pressure = createHarness(module, { audioRingCapacity: 8, eventQueueCapacity: 8, spoolQuotaBytes: 1024 });
  pressure.scheduler.enqueue({ id: 'raw-a', kind: 'raw_output', bytes: 256, offset: 0 });
  pressure.scheduler.enqueue({ id: 'raw-b', kind: 'raw_output', bytes: 256, offset: 256 });
  pressure.scheduler.enqueue({ id: 'approval-p', kind: 'approval', bytes: 128, offset: 512 });
  const receipt = pressure.scheduler.pressure('critical');
  assert.equal(receipt.unloaded, true, 'critical memory pressure unloads models');
  assert.ok(receipt.gaps.length > 0, 'every shed raw event during pressure is declared, never silently dropped');
  assert.ok(
    receipt.gaps.every((gap) => gap.reason === 'memory_pressure'),
    'pressure gaps are labelled with their cause',
  );
  assert.equal(pressure.scheduler.stats().models.resident, false);
  assert.equal(
    pressure.scheduler.stats().events.depth,
    0,
    'raw backlog is shed on critical pressure instead of growing without bound',
  );

  await pressure.drainAll();
  const persisted = pressure.calls
    .filter((call) => call.label === 'durable.persist')
    .map((call) => (call.payload as DurableEvent).id);
  assert.deepEqual(persisted, ['approval-p'], 'the approval survives pressure and is persisted on the next pump');

  pressure.scheduler.enqueue({ id: 'raw-c', kind: 'raw_output', bytes: 256, offset: 640 });
  assert.equal(
    pressure.scheduler.stats().events.depth >= 1,
    true,
    'the scheduler recovers: raw events are accepted again after pressure',
  );
});
