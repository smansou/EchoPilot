import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCELERATED_REQUIRED_SCENARIOS,
  runAcceleratedReplay,
} from './accelerated-replay.js';
import { EIGHT_HOURS_MS } from './eight-hour-replay.js';

test('the accelerated qualification covers every required fault scenario within its budgets', async () => {
  const result = await runAcceleratedReplay();

  assert.equal(result.passed, true, `unexpected failures: ${JSON.stringify(result.failures)}`);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.id),
    [...ACCELERATED_REQUIRED_SCENARIOS],
  );
  for (const scenario of result.scenarios) {
    assert.equal(scenario.passed, true, `${scenario.id}: ${JSON.stringify(scenario.failures)}`);
    assert.deepEqual(scenario.failures, []);
  }

  assert.equal(result.simulatedDurationMs, EIGHT_HOURS_MS, 'the long session is a full eight virtual hours');
  assert.equal(result.requiredSimulatedDurationMs, EIGHT_HOURS_MS);
  assert.ok(result.wallClockMs > 0 && result.wallClockMs < 10 * 60 * 1_000, `wall clock ${result.wallClockMs}ms`);
  assert.ok(result.coldStartMs <= result.coldStartBudgetMs, `cold start ${result.coldStartMs}ms`);

  const counters = result.counters;
  assert.ok(counters.audioQueueHighWater <= counters.audioRingCapacity, 'the audio ring stays bounded');
  assert.ok(counters.eventQueueHighWater <= counters.eventQueueCapacity, 'the event queue stays bounded');
  assert.ok(counters.spoolBytesHighWater <= counters.spoolQuotaBytes, 'the spool stays inside its quota');
  assert.equal(counters.spoolOverQuotaBytes, 0, 'the scheduler must never offer the spool an over-quota record');
  assert.ok(counters.audioPosts > 0 && counters.eventsEnqueued > 0, 'the run must actually do work');
  assert.ok(counters.eventsShed > 0, 'bursts must shed bounded data rather than grow without limit');
  assert.equal(counters.gapRecords, counters.eventsShed, 'every shed event is declared as a gap');
  assert.ok(counters.gappedBytes > 0);

  assert.equal(counters.workDuringAudioCallbacks, 0, 'no audio callback may wait on JS/database work');
  assert.equal(counters.asyncReceipts, 0, 'audio callbacks must return synchronously');
  assert.equal(result.audioCallback.synchronous, true);
  assert.equal(result.audioCallback.workDuringAudioCallbacks, 0);

  assert.equal(result.recovery.length, ACCELERATED_REQUIRED_SCENARIOS.length);
  for (const outcome of result.recovery) {
    assert.equal(outcome.outcome, 'recovered', `${outcome.scenario}: ${outcome.detail}`);
  }

  assert.ok(result.memory.rssHighWaterBytes >= result.memory.rssStartBytes);
  assert.ok(result.memory.rssHour1Bytes !== null && result.memory.rssHour8Bytes !== null,
    'the long session must sample RSS at hour one and hour eight');
  assert.ok(result.gapsByReason.queue_overflow > 0);
  assert.ok(result.gapsByReason.disk_quota > 0);
  assert.equal(result.counterFingerprint.length, 16);

  const partition = result.scenarios.find((scenario) => scenario.id === 'network_partition');
  assert.ok(partition !== undefined);
  for (const id of [
    'partition_retains_full_backlog',
    'partition_backlog_bounded',
    'partition_persists_every_decision_exactly_once',
    'partition_saturated_backlog_bounded',
    'partition_saturated_keeps_decisions',
    'partition_saturated_sheds_raw_only',
    'partition_saturated_recovers_exactly_once',
    'partition_audio_callback_no_work',
  ]) {
    assert.ok(partition.checks.includes(id), `network partition should record the ${id} check`);
  }
  assert.equal(partition.measurements.saturatedBacklogDepth, partition.measurements.saturatedDecisionsRetained);

  const crash = result.scenarios.find((scenario) => scenario.id === 'worker_crash');
  assert.ok(crash !== undefined);
  assert.equal(crash.measurements.crashStepRuns, 1, 'the crashed step must run exactly once');
  assert.equal(crash.measurements.queuedJobStatus, 'completed');
});

test('two runs of the same seed produce the same bounded-resource fingerprint', async () => {
  const first = await runAcceleratedReplay();
  const second = await runAcceleratedReplay();
  assert.equal(first.counterFingerprint, second.counterFingerprint,
    'the accelerated qualification must be repeatable for a fixed seed');
  assert.deepEqual(first.counters, second.counters);
  assert.deepEqual(first.gapsByReason, second.gapsByReason);
});
