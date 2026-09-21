export const SCHEDULER_CLASS_PRIORITY = [
  'control',
  'asr',
  'correction',
  'narration',
  'consolidation',
  'import',
] as const;

export const MODEL_IDLE_UNLOAD_MS = 90_000;
export const IDLE_RETURN_MS = 15_000;

export type JobClass = (typeof SCHEDULER_CLASS_PRIORITY)[number];
export type JobSlot = 'generation' | 'synthesis' | 'import' | 'consolidation';
export type JobStatus = 'queued' | 'running' | 'preempted' | 'completed' | 'failed';
export type DurableEventKind = 'raw_output' | 'approval' | 'result';
export type GapReason = 'queue_overflow' | 'disk_quota' | 'memory_pressure';

export type AudioFrame = Readonly<{ sequence: number; bytes: number }>;
export type DurableEvent = Readonly<{ id: string; kind: DurableEventKind; bytes: number; offset: number }>;
export type SchedulerJob = Readonly<{
  id: string;
  class: JobClass;
  steps: readonly string[];
  slot?: JobSlot;
}>;
export type SpoolRecord = Readonly<{ id: string; bytes: number; offset: number }>;
export type GapRecord = Readonly<{
  fromOffset: number;
  toOffset: number;
  omittedBytes: number;
  reason: GapReason;
  sourceEventId?: string;
}>;

export type SchedulerOptions = Readonly<{
  now: () => number;
  audioRingCapacity: number;
  eventQueueCapacity: number;
  spoolQuotaBytes: number;
  jsWork: (label: string, payload: unknown) => Promise<string>;
  spool: (record: SpoolRecord) => boolean;
  unloadModels: () => void;
}>;

type MutableJob = {
  readonly id: string;
  readonly class: JobClass;
  readonly steps: readonly string[];
  readonly slot?: JobSlot;
  readonly order: number;
  status: JobStatus;
  completedSteps: number;
  attempts: number;
  lastError?: string;
};

type PumpReceipt = Readonly<{
  jobId: string;
  jobClass: JobClass;
  step: string;
  status: 'completed' | 'failed' | 'preempted';
  error?: string;
}>;

const priority = new Map<JobClass, number>(
  SCHEDULER_CLASS_PRIORITY.map((jobClass, index) => [jobClass, index]),
);

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function gapFor(event: DurableEvent, reason: GapReason): GapRecord {
  return {
    fromOffset: event.offset,
    toOffset: event.offset + event.bytes,
    omittedBytes: event.bytes,
    reason,
    sourceEventId: event.id,
  };
}

export function createResourceScheduler(options: SchedulerOptions) {
  const audioRingCapacity = positiveInteger('audioRingCapacity', options.audioRingCapacity);
  const eventQueueCapacity = positiveInteger('eventQueueCapacity', options.eventQueueCapacity);
  const spoolQuotaBytes = positiveInteger('spoolQuotaBytes', options.spoolQuotaBytes);

  const audioQueue: AudioFrame[] = [];
  const eventQueue: DurableEvent[] = [];
  const pressureRecoveryQueue: DurableEvent[] = [];
  const gaps: GapRecord[] = [];
  const jobs: MutableJob[] = [];
  const slotOwners = new Map<JobSlot, MutableJob>();

  let acceptedFrames = 0;
  let droppedFrames = 0;
  let discontinuities = 0;
  let acceptedEvents = 0;
  let shedEvents = 0;
  let storedBytes = 0;
  let spoolRecords = 0;
  let nextJobOrder = 0;
  let modelsResident = true;
  let lastUnloadAt: number | undefined;
  let lastUsefulAt = options.now();
  let activePump: Promise<unknown> | undefined;

  const noteUsefulActivity = () => {
    lastUsefulAt = options.now();
    modelsResident = true;
  };

  const recordGap = (event: DurableEvent, reason: GapReason): GapRecord => {
    const gap = gapFor(event, reason);
    gaps.push(gap);
    shedEvents += 1;
    return gap;
  };

  const releaseSlot = (job: MutableJob) => {
    if (job.slot !== undefined && slotOwners.get(job.slot) === job) {
      slotOwners.delete(job.slot);
    }
  };

  const unload = (): boolean => {
    if (!modelsResident) return false;
    options.unloadModels();
    modelsResident = false;
    lastUnloadAt = options.now();
    return true;
  };

  const hasUsefulWork = (): boolean =>
    audioQueue.length > 0
    || eventQueue.some((event) => event.kind !== 'raw_output')
    || pressureRecoveryQueue.length > 0
    || jobs.some((job) => job.status === 'queued' || job.status === 'running' || job.status === 'preempted');

  const selectJob = (): MutableJob | undefined => {
    const candidates = jobs.filter((job) => {
      if (job.status === 'completed' || job.status === 'failed') return false;
      if (job.slot === undefined) return true;
      const owner = slotOwners.get(job.slot);
      return owner === undefined || owner === job;
    });
    candidates.sort((left, right) => {
      const classDifference = (priority.get(left.class) ?? Number.MAX_SAFE_INTEGER)
        - (priority.get(right.class) ?? Number.MAX_SAFE_INTEGER);
      if (classDifference !== 0) return classDifference;
      const leftRunning = left.status === 'running' || left.status === 'preempted' ? 0 : 1;
      const rightRunning = right.status === 'running' || right.status === 'preempted' ? 0 : 1;
      return leftRunning - rightRunning || left.order - right.order;
    });
    return candidates[0];
  };

  const drainAudio = async () => {
    const frames = audioQueue.splice(0).sort((left, right) => left.sequence - right.sequence);
    for (const frame of frames) await options.jsWork('asr.frame', frame);
  };

  const drainEvents = async () => {
    const events = [...pressureRecoveryQueue.splice(0), ...eventQueue.splice(0)];
    for (const event of events) {
      if (event.kind !== 'raw_output') {
        await options.jsWork('durable.persist', event);
        continue;
      }

      const record = { id: event.id, bytes: event.bytes, offset: event.offset };
      const stored = options.spool(record);
      if (stored && storedBytes + event.bytes <= spoolQuotaBytes) {
        storedBytes += event.bytes;
        spoolRecords += 1;
      } else {
        recordGap(event, 'disk_quota');
      }
    }
  };

  const runJobStep = async (): Promise<readonly PumpReceipt[]> => {
    const selected = selectJob();
    if (selected === undefined) return [];

    for (const job of jobs) {
      if (job === selected || job.status !== 'running') continue;
      if ((priority.get(job.class) ?? 0) > (priority.get(selected.class) ?? 0)) job.status = 'preempted';
    }

    if (selected.slot !== undefined && slotOwners.get(selected.slot) === undefined) {
      slotOwners.set(selected.slot, selected);
    }
    selected.status = 'running';
    const step = selected.steps[selected.completedSteps];
    if (step === undefined) {
      selected.status = 'completed';
      releaseSlot(selected);
      return [];
    }

    try {
      await options.jsWork(`job:${selected.id}:${step}`, selected);
      selected.completedSteps += 1;
      if (selected.completedSteps === selected.steps.length) {
        selected.status = 'completed';
        releaseSlot(selected);
      }
      return [{
        jobId: selected.id,
        jobClass: selected.class,
        step,
        status: 'completed',
      }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      selected.attempts += 1;
      selected.lastError = message;
      selected.status = 'failed';
      releaseSlot(selected);
      return [{
        jobId: selected.id,
        jobClass: selected.class,
        step,
        status: 'failed',
        error: message,
      }];
    }
  };

  const runPump = async (): Promise<readonly PumpReceipt[]> => {
    const receipts = await runJobStep();
    await drainAudio();
    await drainEvents();
    if (receipts.length > 0 || hasUsefulWork()) noteUsefulActivity();
    return receipts;
  };

  return {
    postAudioFrame(frame: AudioFrame) {
      if (audioQueue.length >= audioRingCapacity) {
        droppedFrames += 1;
        discontinuities += 1;
        return {
          accepted: false,
          depth: audioQueue.length,
          discontinuity: {
            firstSequence: frame.sequence,
            lastSequence: frame.sequence,
            droppedFrames: 1,
          },
        };
      }
      audioQueue.push(frame);
      acceptedFrames += 1;
      noteUsefulActivity();
      return { accepted: true, depth: audioQueue.length };
    },

    enqueue(event: DurableEvent) {
      if (eventQueue.length < eventQueueCapacity) {
        eventQueue.push(event);
        acceptedEvents += 1;
        if (event.kind !== 'raw_output') noteUsefulActivity();
        return { accepted: true, depth: eventQueue.length };
      }

      if (event.kind === 'raw_output') {
        return { accepted: false, depth: eventQueue.length, gap: recordGap(event, 'queue_overflow') };
      }

      const rawIndex = eventQueue.findIndex((queued) => queued.kind === 'raw_output');
      if (rawIndex < 0) return { accepted: false, depth: eventQueue.length };
      const displaced = eventQueue.splice(rawIndex, 1, event)[0];
      acceptedEvents += 1;
      noteUsefulActivity();
      return {
        accepted: true,
        depth: eventQueue.length,
        gap: displaced === undefined ? undefined : recordGap(displaced, 'queue_overflow'),
      };
    },

    submitJob(job: SchedulerJob) {
      if (jobs.some((existing) => existing.id === job.id)) {
        throw new Error(`job ${job.id} already exists`);
      }
      if (!priority.has(job.class)) throw new Error(`unsupported scheduler class: ${job.class}`);
      jobs.push({
        ...job,
        order: nextJobOrder,
        status: job.steps.length === 0 ? 'completed' : 'queued',
        completedSteps: 0,
        attempts: 0,
      });
      nextJobOrder += 1;
      if (job.steps.length > 0) noteUsefulActivity();
    },

    pump() {
      const result = activePump === undefined
        ? runPump()
        : activePump.then(runPump, runPump);
      const tracked = result.finally(() => {
        if (activePump === tracked) activePump = undefined;
      });
      activePump = tracked;
      return result;
    },

    tick() {
      if (hasUsefulWork()) {
        lastUsefulAt = options.now();
        return;
      }
      if (options.now() - lastUsefulAt >= MODEL_IDLE_UNLOAD_MS) unload();
    },

    pressure(level: 'warning' | 'critical') {
      const pressureGaps: GapRecord[] = [];
      const survivors: DurableEvent[] = [];
      for (const event of eventQueue.splice(0)) {
        if (event.kind === 'raw_output') pressureGaps.push(recordGap(event, 'memory_pressure'));
        else survivors.push(event);
      }
      pressureRecoveryQueue.push(...survivors);
      return { unloaded: level === 'critical' ? unload() : false, gaps: pressureGaps };
    },

    stats() {
      return {
        audio: {
          depth: audioQueue.length,
          acceptedFrames,
          droppedFrames,
          discontinuities,
        },
        events: {
          depth: eventQueue.length,
          accepted: acceptedEvents,
          shed: shedEvents,
        },
        spool: { storedBytes, records: spoolRecords },
        gaps: gaps.map((gap) => ({ ...gap })),
        jobs: jobs.map((job) => ({
          jobId: job.id,
          jobClass: job.class,
          status: job.status,
          completedSteps: job.completedSteps,
          attempts: job.attempts,
          ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
        })),
        models: {
          resident: modelsResident,
          ...(lastUnloadAt === undefined ? {} : { lastUnloadAt }),
        },
        slots: {
          generation: slotOwners.has('generation') ? 1 : 0,
          synthesis: slotOwners.has('synthesis') ? 1 : 0,
          import: slotOwners.has('import') ? 1 : 0,
          consolidation: slotOwners.has('consolidation') ? 1 : 0,
        },
      };
    },
  } as const;
}
