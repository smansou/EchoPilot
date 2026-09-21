/**
 * Strict reader for the accelerated qualification measurement file produced by
 * `packages/eval/src/performance/accelerated-replay.ts`.
 *
 * Every quality gate in the macOS report is computed from these numbers, so a missing, unreadable,
 * or malformed measurement must fail the qualification. The reader never substitutes a default or a
 * zero for an absent counter: a document that omits `droppedFrames` is reported as
 * `accelerated_counter_missing:droppedFrames` rather than being graded as zero dropped frames.
 */
import { readFile } from 'node:fs/promises';

export const ACCELERATED_REQUIRED_SCENARIOS = [
  'long_session_invariants',
  'event_burst_1000_per_s',
  'large_logs',
  'worker_crash',
  'sleep_wake',
  'network_partition',
];

export const ACCELERATED_COUNTER_FIELDS = [
  'audioQueueHighWater',
  'audioRingCapacity',
  'audioPosts',
  'audioAccepted',
  'audioDropped',
  'audioDiscontinuities',
  'eventQueueHighWater',
  'eventQueueCapacity',
  'eventsEnqueued',
  'eventsAccepted',
  'eventsShed',
  'spoolBytesHighWater',
  'spoolQuotaBytes',
  'spoolOverQuotaBytes',
  'spoolRecords',
  'gapRecords',
  'gappedBytes',
  'droppedFrames',
  'persistFailures',
  'workDuringAudioCallbacks',
  'asyncReceipts',
];

export const ACCELERATED_MEMORY_FIELDS = [
  'rssStartBytes',
  'rssEndBytes',
  'rssHighWaterBytes',
  'maxRssGrowthBytes',
];

export const ACCELERATED_GAP_REASONS = ['queue_overflow', 'disk_quota', 'memory_pressure'];

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate an already-parsed measurement document. Pure: safe to unit-test with fixtures. */
export function validateAcceleratedMeasurements(parsed) {
  if (!isRecord(parsed)) return { failures: ['accelerated_measurements_invalid'], measurements: null };
  const failures = [];

  const counters = parsed.counters;
  if (!isRecord(counters)) {
    failures.push('accelerated_counters_missing');
  } else {
    for (const field of ACCELERATED_COUNTER_FIELDS) {
      if (counters[field] === undefined) failures.push(`accelerated_counter_missing:${field}`);
      else if (!isCount(counters[field])) failures.push(`accelerated_counter_invalid:${field}`);
    }
  }

  const memory = parsed.memory;
  if (!isRecord(memory)) {
    failures.push('accelerated_memory_missing');
  } else {
    for (const field of ACCELERATED_MEMORY_FIELDS) {
      if (memory[field] === undefined) failures.push(`accelerated_memory_missing:${field}`);
      else if (!isCount(memory[field])) failures.push(`accelerated_memory_invalid:${field}`);
    }
    for (const field of ['rssHour1Bytes', 'rssHour8Bytes']) {
      if (memory[field] !== null && !isCount(memory[field])) failures.push(`accelerated_memory_invalid:${field}`);
    }
  }

  const gapsByReason = parsed.gapsByReason;
  if (!isRecord(gapsByReason)) {
    failures.push('accelerated_gaps_missing');
  } else {
    for (const reason of ACCELERATED_GAP_REASONS) {
      if (!isCount(gapsByReason[reason])) failures.push(`accelerated_gap_missing:${reason}`);
    }
  }

  if (!isCount(parsed.coldStartMs)) failures.push('accelerated_cold_start_missing');
  if (!isCount(parsed.simulatedDurationMs)) failures.push('accelerated_simulated_duration_missing');
  if (!isCount(parsed.wallClockMs)) failures.push('accelerated_wall_clock_missing');
  if (typeof parsed.counterFingerprint !== 'string' || parsed.counterFingerprint.length === 0) {
    failures.push('accelerated_fingerprint_missing');
  }
  if (typeof parsed.passed !== 'boolean') failures.push('accelerated_status_missing');
  if (!Array.isArray(parsed.failures)) failures.push('accelerated_failures_missing');

  const scenarios = new Map();
  if (!Array.isArray(parsed.scenarios)) {
    failures.push('accelerated_scenarios_missing');
  } else {
    for (const scenario of parsed.scenarios) {
      if (!isRecord(scenario) || typeof scenario.id !== 'string') continue;
      scenarios.set(scenario.id, scenario);
    }
    for (const id of ACCELERATED_REQUIRED_SCENARIOS) {
      const scenario = scenarios.get(id);
      if (scenario === undefined) failures.push(`accelerated_scenario_missing:${id}`);
      else if (typeof scenario.passed !== 'boolean') failures.push(`accelerated_scenario_invalid:${id}`);
    }
  }

  if (!Array.isArray(parsed.recovery)) failures.push('accelerated_recovery_missing');

  if (failures.length > 0) return { failures, measurements: null };
  return { failures: [], measurements: { ...parsed, scenarios: [...scenarios.values()] } };
}

/** Read and validate the measurement file at `path`. A missing file is a failure, never zeroes. */
export async function readAcceleratedMeasurements(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return { failures: ['accelerated_measurements_unavailable'], measurements: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { failures: ['accelerated_measurements_invalid'], measurements: null };
  }
  return validateAcceleratedMeasurements(parsed);
}
