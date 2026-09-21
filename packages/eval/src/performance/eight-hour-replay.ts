export const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

export type HardwareTarget = 'M4_24_GB' | 'M2_16_GB';
export type QualificationStatus = 'passed' | 'failed' | 'not_run';

export type ReplaySample = Readonly<{
  elapsedMs: number;
  residentBytes: number;
  swapBytes: number;
  audioQueueDepth: number;
  eventQueueDepth: number;
  spoolBytes: number;
  droppedFrames: number;
  gappedBytes: number;
}>;

export type ReplayBudgets = Readonly<{
  durationMs: number;
  maxResidentBytes: number;
  maxSwapBytes: number;
  maxColdStartMs: number;
  maxAudioQueueDepth: number;
  maxEventQueueDepth: number;
  maxSpoolBytes: number;
}>;

export type ReplayReport = Readonly<{
  schemaVersion: 1;
  target: HardwareTarget;
  qualification: QualificationStatus;
  durationMs: number;
  coldStartMs: number | null;
  peakResidentBytes: number;
  peakSwapBytes: number;
  peakAudioQueueDepth: number;
  peakEventQueueDepth: number;
  peakSpoolBytes: number;
  droppedFrames: number;
  gappedBytes: number;
  failures: readonly string[];
}>;

export const REPLAY_BUDGETS: Readonly<Record<HardwareTarget, ReplayBudgets>> = {
  M4_24_GB: {
    durationMs: EIGHT_HOURS_MS,
    maxResidentBytes: 18 * 1024 ** 3,
    maxSwapBytes: 512 * 1024 ** 2,
    maxColdStartMs: 15_000,
    maxAudioQueueDepth: 64,
    maxEventQueueDepth: 256,
    maxSpoolBytes: 512 * 1024 ** 2,
  },
  M2_16_GB: {
    durationMs: EIGHT_HOURS_MS,
    maxResidentBytes: 12 * 1024 ** 3,
    maxSwapBytes: 1024 * 1024 ** 2,
    maxColdStartMs: 15_000,
    maxAudioQueueDepth: 64,
    maxEventQueueDepth: 256,
    maxSpoolBytes: 512 * 1024 ** 2,
  },
};

export function buildReplayReport(input: Readonly<{
  target: HardwareTarget;
  samples: readonly ReplaySample[];
  coldStartMs: number | null;
  completed: boolean;
}>): ReplayReport {
  const budgets = REPLAY_BUDGETS[input.target];
  const peak = (select: (sample: ReplaySample) => number): number =>
    input.samples.reduce((maximum, sample) => Math.max(maximum, select(sample)), 0);
  const last = input.samples.at(-1);
  const durationMs = last?.elapsedMs ?? 0;
  const peakResidentBytes = peak((sample) => sample.residentBytes);
  const peakSwapBytes = peak((sample) => sample.swapBytes);
  const peakAudioQueueDepth = peak((sample) => sample.audioQueueDepth);
  const peakEventQueueDepth = peak((sample) => sample.eventQueueDepth);
  const peakSpoolBytes = peak((sample) => sample.spoolBytes);
  const droppedFrames = last?.droppedFrames ?? 0;
  const gappedBytes = last?.gappedBytes ?? 0;
  const failures: string[] = [];

  if (!input.completed || durationMs < budgets.durationMs) failures.push('eight_hour_context_incomplete');
  if (input.coldStartMs === null) failures.push('cold_start_not_measured');
  else if (input.coldStartMs > budgets.maxColdStartMs) failures.push('cold_start_budget_exceeded');
  if (peakResidentBytes > budgets.maxResidentBytes) failures.push('resident_memory_budget_exceeded');
  if (peakSwapBytes > budgets.maxSwapBytes) failures.push('swap_budget_exceeded');
  if (peakAudioQueueDepth > budgets.maxAudioQueueDepth) failures.push('audio_queue_budget_exceeded');
  if (peakEventQueueDepth > budgets.maxEventQueueDepth) failures.push('event_queue_budget_exceeded');
  if (peakSpoolBytes > budgets.maxSpoolBytes) failures.push('spool_budget_exceeded');

  return {
    schemaVersion: 1,
    target: input.target,
    qualification: input.completed && failures.length === 0 ? 'passed' : input.samples.length === 0 ? 'not_run' : 'failed',
    durationMs,
    coldStartMs: input.coldStartMs,
    peakResidentBytes,
    peakSwapBytes,
    peakAudioQueueDepth,
    peakEventQueueDepth,
    peakSpoolBytes,
    droppedFrames,
    gappedBytes,
    failures,
  };
}
