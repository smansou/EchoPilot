import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReplayReport,
  EIGHT_HOURS_MS,
  REPLAY_BUDGETS,
  type HardwareTarget,
  type ReplaySample,
} from './eight-hour-replay.js';

function sampleFor(target: HardwareTarget, overrides: Partial<ReplaySample> = {}): ReplaySample {
  const budget = REPLAY_BUDGETS[target];
  return {
    elapsedMs: EIGHT_HOURS_MS,
    residentBytes: budget.maxResidentBytes,
    swapBytes: budget.maxSwapBytes,
    audioQueueDepth: budget.maxAudioQueueDepth,
    eventQueueDepth: budget.maxEventQueueDepth,
    spoolBytes: budget.maxSpoolBytes,
    droppedFrames: 7,
    gappedBytes: 160,
    ...overrides,
  };
}

test('eight-hour report qualifies both hardware budget profiles at their limits and retains diagnostics', () => {
  for (const target of ['M4_24_GB', 'M2_16_GB'] as const) {
    const budget = REPLAY_BUDGETS[target];
    const report = buildReplayReport({
      target,
      samples: [sampleFor(target, { elapsedMs: 0 }), sampleFor(target)],
      coldStartMs: budget.maxColdStartMs,
      completed: true,
    });

    assert.equal(report.qualification, 'passed', `${target} should pass at each inclusive budget`);
    assert.deepEqual(report.failures, []);
    assert.equal(report.durationMs, EIGHT_HOURS_MS);
    assert.equal(report.coldStartMs, budget.maxColdStartMs);
    assert.equal(report.peakResidentBytes, budget.maxResidentBytes);
    assert.equal(report.peakSwapBytes, budget.maxSwapBytes);
    assert.equal(report.peakAudioQueueDepth, budget.maxAudioQueueDepth);
    assert.equal(report.peakEventQueueDepth, budget.maxEventQueueDepth);
    assert.equal(report.peakSpoolBytes, budget.maxSpoolBytes);
    assert.equal(report.droppedFrames, 7);
    assert.equal(report.gappedBytes, 160);
  }
});

test('eight-hour report fails each exceeded hard budget and incomplete or unmeasured replay', () => {
  for (const target of ['M4_24_GB', 'M2_16_GB'] as const) {
    const budget = REPLAY_BUDGETS[target];
    const cases: Array<Readonly<{ sample: ReplaySample; coldStartMs: number; failure: string }>> = [
      { sample: sampleFor(target, { residentBytes: budget.maxResidentBytes + 1 }), coldStartMs: budget.maxColdStartMs, failure: 'resident_memory_budget_exceeded' },
      { sample: sampleFor(target, { swapBytes: budget.maxSwapBytes + 1 }), coldStartMs: budget.maxColdStartMs, failure: 'swap_budget_exceeded' },
      { sample: sampleFor(target, { audioQueueDepth: budget.maxAudioQueueDepth + 1 }), coldStartMs: budget.maxColdStartMs, failure: 'audio_queue_budget_exceeded' },
      { sample: sampleFor(target, { eventQueueDepth: budget.maxEventQueueDepth + 1 }), coldStartMs: budget.maxColdStartMs, failure: 'event_queue_budget_exceeded' },
      { sample: sampleFor(target, { spoolBytes: budget.maxSpoolBytes + 1 }), coldStartMs: budget.maxColdStartMs, failure: 'spool_budget_exceeded' },
      { sample: sampleFor(target), coldStartMs: budget.maxColdStartMs + 1, failure: 'cold_start_budget_exceeded' },
      { sample: sampleFor(target, { elapsedMs: EIGHT_HOURS_MS - 1 }), coldStartMs: budget.maxColdStartMs, failure: 'eight_hour_context_incomplete' },
    ];

    for (const scenario of cases) {
      const report = buildReplayReport({
        target,
        samples: [scenario.sample],
        coldStartMs: scenario.coldStartMs,
        completed: true,
      });
      assert.equal(report.qualification, 'failed', `${target}: ${scenario.failure}`);
      assert.ok(report.failures.includes(scenario.failure), `${target}: report should identify ${scenario.failure}`);
    }
  }

  const unmeasured = buildReplayReport({ target: 'M4_24_GB', samples: [], coldStartMs: null, completed: false });
  assert.equal(unmeasured.qualification, 'not_run');
  assert.ok(unmeasured.failures.includes('eight_hour_context_incomplete'));
  assert.ok(unmeasured.failures.includes('cold_start_not_measured'));
});
