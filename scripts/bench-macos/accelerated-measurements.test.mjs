import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACCELERATED_COUNTER_FIELDS,
  ACCELERATED_REQUIRED_SCENARIOS,
  readAcceleratedMeasurements,
  validateAcceleratedMeasurements,
} from './accelerated-measurements.mjs';

function validDocument() {
  return {
    counters: Object.fromEntries(ACCELERATED_COUNTER_FIELDS.map((field) => [field, 1])),
    memory: {
      rssStartBytes: 1,
      rssEndBytes: 1,
      rssHighWaterBytes: 1,
      maxRssGrowthBytes: 0,
      rssHour1Bytes: 1,
      rssHour8Bytes: 1,
    },
    gapsByReason: { queue_overflow: 0, disk_quota: 0, memory_pressure: 0 },
    coldStartMs: 90,
    simulatedDurationMs: 28_800_000,
    wallClockMs: 200,
    counterFingerprint: 'deadbeefdeadbeef',
    passed: true,
    failures: [],
    recovery: ACCELERATED_REQUIRED_SCENARIOS.map((scenario) => ({
      scenario,
      fault: 'x',
      outcome: 'recovered',
      detail: 'x',
    })),
    scenarios: ACCELERATED_REQUIRED_SCENARIOS.map((id) => ({ id, passed: true })),
  };
}

test('a complete measurement document validates without failures', () => {
  const reading = validateAcceleratedMeasurements(validDocument());
  assert.deepEqual(reading.failures, []);
  assert.ok(reading.measurements);
  assert.deepEqual(
    reading.measurements.scenarios.map((scenario) => scenario.id),
    [...ACCELERATED_REQUIRED_SCENARIOS],
  );
});

test('a missing measurement file fails closed and never yields zero-valued counters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q02-measurements-'));
  try {
    const reading = await readAcceleratedMeasurements(join(directory, 'absent.json'));
    assert.equal(reading.measurements, null, 'an absent file must not be read as counters');
    assert.deepEqual(reading.failures, ['accelerated_measurements_unavailable']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unreadable or non-JSON measurement file fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'q02-measurements-'));
  try {
    const path = join(directory, 'broken.json');
    await writeFile(path, '{"counters": ');
    const reading = await readAcceleratedMeasurements(path);
    assert.equal(reading.measurements, null);
    assert.deepEqual(reading.failures, ['accelerated_measurements_invalid']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every absent counter is named and stops the qualification passing', () => {
  for (const field of ACCELERATED_COUNTER_FIELDS) {
    const document = validDocument();
    delete document.counters[field];
    const reading = validateAcceleratedMeasurements(document);
    assert.equal(reading.measurements, null, `${field} must not be graded when absent`);
    assert.ok(
      reading.failures.includes(`accelerated_counter_missing:${field}`),
      `missing ${field} should be reported, saw ${JSON.stringify(reading.failures)}`,
    );
  }
});

test('non-integer, negative, and undefined counters are invalid rather than zero', () => {
  for (const [field, value] of [
    ['droppedFrames', '136'],
    ['gappedBytes', -1],
    ['spoolBytesHighWater', null],
    ['audioQueueHighWater', 64.5],
  ]) {
    const document = validDocument();
    document.counters[field] = value;
    const reading = validateAcceleratedMeasurements(document);
    assert.equal(reading.measurements, null);
    assert.ok(reading.failures.includes(`accelerated_counter_invalid:${field}`), `${field}=${value}`);
  }
});

test('missing high-water diagnostics, scenarios, and recovery outcomes fail closed', () => {
  const noMemory = validDocument();
  delete noMemory.memory.rssHighWaterBytes;
  assert.ok(validateAcceleratedMeasurements(noMemory).failures.includes('accelerated_memory_missing:rssHighWaterBytes'));

  const noGaps = validDocument();
  delete noGaps.gapsByReason.memory_pressure;
  assert.ok(validateAcceleratedMeasurements(noGaps).failures.includes('accelerated_gap_missing:memory_pressure'));

  const noColdStart = validDocument();
  delete noColdStart.coldStartMs;
  assert.ok(validateAcceleratedMeasurements(noColdStart).failures.includes('accelerated_cold_start_missing'));

  const noScenario = validDocument();
  noScenario.scenarios = noScenario.scenarios.filter((scenario) => scenario.id !== 'network_partition');
  assert.ok(validateAcceleratedMeasurements(noScenario).failures.includes('accelerated_scenario_missing:network_partition'));

  const noRecovery = validDocument();
  delete noRecovery.recovery;
  assert.ok(validateAcceleratedMeasurements(noRecovery).failures.includes('accelerated_recovery_missing'));

  const noStatus = validDocument();
  delete noStatus.passed;
  assert.ok(validateAcceleratedMeasurements(noStatus).failures.includes('accelerated_status_missing'));
});

test('a document with zeroed but present counters stays measured and is left to the budget checks', () => {
  const document = validDocument();
  for (const field of ACCELERATED_COUNTER_FIELDS) document.counters[field] = 0;
  const reading = validateAcceleratedMeasurements(document);
  assert.deepEqual(reading.failures, [], 'present zero counters are measurements, not missing data');
  assert.equal(reading.measurements.counters.droppedFrames, 0);
});
