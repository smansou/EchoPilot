#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAcceleratedMeasurements } from './accelerated-measurements.mjs';

/**
 * Q02 macOS replay qualification runner.
 *
 * Two modes:
 *   ECHOPILOT_BENCH_MODE=accelerated (default)
 *     Runs the deterministic accelerated qualification
 *     (packages/eval/src/performance/accelerated-replay.ts) and reports its measurements. Budgeted
 *     at ten minutes of wall clock, and every counter must come from the driver's measurement file:
 *     a missing or malformed measurement fails the qualification instead of being treated as zero.
 *   ECHOPILOT_BENCH_MODE=eight_hour
 *     Runs ECHOPILOT_REPLAY_COMMAND and polls ECHOPILOT_REPLAY_COUNTERS for a real eight-hour run.
 *
 * Qualification is always fail-closed: `qualification: "passed"` requires a complete measurement
 * set, every hard budget inside its limit, and every recovery outcome recovered.
 *
 * Swap is reported as an absolute system high-water mark plus the growth attributable to the
 * qualification from a baseline taken immediately before the replay started. The budget is graded
 * against the attributable growth, because a machine that has swapped for hours before this run
 * would otherwise fail a budget for memory the qualification never touched.
 */

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;
const ACCELERATED_BUDGET_MS = 10 * 60 * 1_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const budgets = {
  M4_24_GB: {
    maxResidentBytes: 18 * GIB,
    maxSwapBytes: 512 * MIB,
    maxColdStartMs: 15_000,
    maxAudioQueueDepth: 64,
    maxEventQueueDepth: 256,
    maxSpoolBytes: 512 * MIB,
  },
  M2_16_GB: {
    maxResidentBytes: 12 * GIB,
    maxSwapBytes: 1024 * MIB,
    maxColdStartMs: 15_000,
    maxAudioQueueDepth: 64,
    maxEventQueueDepth: 256,
    maxSpoolBytes: 512 * MIB,
  },
};

const mode = process.env.ECHOPILOT_BENCH_MODE ?? 'accelerated';
if (mode !== 'accelerated' && mode !== 'eight_hour') {
  throw new Error('ECHOPILOT_BENCH_MODE must be accelerated or eight_hour');
}

const target = process.env.ECHOPILOT_BENCH_TARGET;
const command = process.env.ECHOPILOT_REPLAY_COMMAND;
const reportPath = resolve(process.env.ECHOPILOT_BENCH_REPORT ?? 'artifacts/performance/eight-hour-replay.json');
const samplePath = resolve(process.env.ECHOPILOT_BENCH_SAMPLES ?? 'artifacts/performance/eight-hour-replay.ndjson');
const coldStartPath = process.env.ECHOPILOT_COLD_START_MS_FILE;
const countersPath = process.env.ECHOPILOT_REPLAY_COUNTERS;
const measurementsPath = resolve(
  process.env.ECHOPILOT_ACCELERATED_MEASUREMENTS ?? 'artifacts/performance/accelerated-replay.json',
);
const driverLogPath = resolve(
  process.env.ECHOPILOT_ACCELERATED_LOG ?? 'artifacts/performance/accelerated-replay.driver.log',
);
const allowUnmeasuredSwap = process.env.ECHOPILOT_ALLOW_UNMEASURED_SWAP === '1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (!(target in budgets)) throw new Error('ECHOPILOT_BENCH_TARGET must be M4_24_GB or M2_16_GB');
if (mode === 'eight_hour' && !command) throw new Error('ECHOPILOT_REPLAY_COMMAND is required');

function run(commandName, args, options = {}) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(commandName, args, { stdio: options.inherit === true ? 'inherit' : ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolveResult({ exitCode: -1, stdout: '' });
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolveResult({ exitCode: -1, stdout }));
    child.on('close', (exitCode) => resolveResult({ exitCode: exitCode ?? -1, stdout }));
  });
}

/** `ps` is unavailable in some sandboxes; a failed sample must be null, never 0. */
async function processResidentBytes(pid) {
  const result = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
  if (result.exitCode !== 0 || !/^\d+$/.test(result.stdout.trim())) return null;
  return Number(result.stdout.trim()) * 1024;
}

/** `sysctl -n vm.swapusage` is unavailable in some sandboxes; a failed sample must be null. */
async function systemSwapBytes() {
  const result = await run('sysctl', ['-n', 'vm.swapusage']);
  const match = /used\s*=\s*([0-9.]+)([KMG])/i.exec(result.stdout);
  if (result.exitCode !== 0 || !match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const multiplier = { K: 1024, M: MIB, G: GIB }[match[2].toUpperCase()];
  return Math.round(value * multiplier);
}

const EIGHT_HOUR_COUNTER_FIELDS = ['droppedFrames', 'gappedBytes', 'audioQueueDepth', 'eventQueueDepth', 'spoolBytes'];

async function readCounters() {
  if (!countersPath) return { status: 'missing', failure: 'replay_counters_not_configured' };
  let contents;
  try {
    contents = await readFile(countersPath, 'utf8');
  } catch {
    return { status: 'missing', failure: 'replay_counters_unavailable' };
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { status: 'invalid', failure: 'replay_counters_invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || EIGHT_HOUR_COUNTER_FIELDS.some((field) => !Number.isSafeInteger(parsed[field]) || parsed[field] < 0)) {
    return { status: 'invalid', failure: 'replay_counters_invalid' };
  }
  return {
    status: 'measured',
    counters: Object.fromEntries(EIGHT_HOUR_COUNTER_FIELDS.map((field) => [field, parsed[field]])),
  };
}

async function runAcceleratedQualification() {
  const failures = new Set();
  const unmeasured = [];
  const notes = new Set();

  // A qualification that cannot write its measurements cannot be graded, so it fails closed
  // instead of running the replay and reporting numbers nobody can audit.
  let measurementsWritable = true;
  try {
    await mkdir(dirname(measurementsPath), { recursive: true });
  } catch {
    measurementsWritable = false;
    failures.add('accelerated_measurements_unwritable');
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(samplePath), { recursive: true });
  try {
    await mkdir(dirname(driverLogPath), { recursive: true });
    await writeFile(driverLogPath, '');
  } catch {
    notes.add('driver_log_unwritable: the accelerated driver log could not be written');
  }

  const swapBefore = measurementsWritable ? await systemSwapBytes() : null;
  const startedAt = Date.now();
  const child = measurementsWritable ? spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/eval/src/performance/accelerated-replay.ts',
      '--out',
      measurementsPath,
      '--samples',
      samplePath,
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  ) : null;

  let timedOut = false;
  let exitCode = null;
  let durationMs = 0;
  let swapAfter = null;

  if (child !== null) {
    const exited = new Promise((resolveExit) => {
      let settled = false;
      child.on('error', () => { if (!settled) { settled = true; resolveExit(-1); } });
      child.on('close', (code) => { if (!settled) { settled = true; resolveExit(code ?? -1); } });
    });

    let log = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    child.on('close', () => {
      void appendFile(driverLogPath, log).catch(() => {});
    });

    exitCode = await Promise.race([
      exited,
      new Promise((resolveTimeout) => {
        const timeout = setTimeout(() => { timedOut = true; resolveTimeout(-2); }, ACCELERATED_BUDGET_MS);
        void exited.then(() => clearTimeout(timeout));
      }),
    ]);
    if (timedOut) {
      failures.add('accelerated_duration_budget_exceeded');
      child.kill('SIGTERM');
      exitCode = await exited;
    }
    durationMs = Date.now() - startedAt;
    swapAfter = await systemSwapBytes();

    if (durationMs > ACCELERATED_BUDGET_MS) failures.add('accelerated_duration_budget_exceeded');
    if (exitCode !== 0) failures.add(`accelerated_exit_${exitCode}`);
  }

  const reading = measurementsWritable
    ? await readAcceleratedMeasurements(measurementsPath)
    : { failures: [], measurements: null };
  for (const failure of reading.failures) failures.add(failure);
  const measurements = reading.measurements;

  const limit = budgets[target];
  let peakResidentBytes = null;
  let peakSwapBytes = null;
  let peakAudioQueueDepth = null;
  let peakEventQueueDepth = null;
  let peakSpoolBytes = null;
  let droppedFrames = null;
  let gappedBytes = null;

  if (measurements !== null) {
    const counters = measurements.counters;
    peakResidentBytes = measurements.memory.rssHighWaterBytes;
    peakAudioQueueDepth = counters.audioQueueHighWater;
    peakEventQueueDepth = counters.eventQueueHighWater;
    peakSpoolBytes = counters.spoolBytesHighWater;
    droppedFrames = counters.droppedFrames;
    gappedBytes = counters.gappedBytes;

    if (counters.spoolOverQuotaBytes > 0) failures.add('spool_quota_violated');
    if (counters.workDuringAudioCallbacks > 0) failures.add('audio_callback_ran_work');
    if (counters.asyncReceipts > 0) failures.add('audio_callback_async_receipt');
    if (counters.audioQueueHighWater > counters.audioRingCapacity) failures.add('audio_queue_budget_exceeded');
    if (counters.eventQueueHighWater > counters.eventQueueCapacity) failures.add('event_queue_budget_exceeded');
    if (counters.spoolBytesHighWater > counters.spoolQuotaBytes) failures.add('spool_budget_exceeded');
    if (measurements.simulatedDurationMs < EIGHT_HOURS_MS) failures.add('eight_hour_context_incomplete');
    if (peakAudioQueueDepth > limit.maxAudioQueueDepth) failures.add('audio_queue_budget_exceeded');
    if (peakEventQueueDepth > limit.maxEventQueueDepth) failures.add('event_queue_budget_exceeded');
    if (peakSpoolBytes > limit.maxSpoolBytes) failures.add('spool_budget_exceeded');
    if (peakResidentBytes > limit.maxResidentBytes) failures.add('resident_memory_budget_exceeded');
    if (measurements.coldStartMs > limit.maxColdStartMs) failures.add('cold_start_budget_exceeded');
    if (measurements.passed !== true) failures.add('accelerated_qualification_failed');
    if (measurements.failures.length > 0) {
      for (const failure of measurements.failures) failures.add(`accelerated_report:${failure}`);
    }
    for (const outcome of measurements.recovery) {
      if (outcome.outcome !== 'recovered') failures.add(`recovery_failed:${outcome.scenario}`);
    }

    if (swapBefore !== null && swapAfter !== null) peakSwapBytes = Math.max(swapBefore, swapAfter);
  }

  const swapSamples = [swapBefore, swapAfter].filter((value) => value !== null);
  let swapGrowthBytes = null;
  if (swapSamples.length === 0) {
    peakSwapBytes = null;
    if (allowUnmeasuredSwap) {
      notes.add('swap_not_measured:ECHOPILOT_ALLOW_UNMEASURED_SWAP was set, so no swap budget is claimed');
      unmeasured.push('peakSwapBytes');
    } else {
      failures.add('swap_not_measured');
    }
  } else {
    peakSwapBytes = Math.max(...swapSamples);
    swapGrowthBytes = Math.max(0, peakSwapBytes - (swapBefore ?? peakSwapBytes));
    if (swapGrowthBytes > limit.maxSwapBytes) failures.add('swap_budget_exceeded');
    if (peakSwapBytes > limit.maxSwapBytes) {
      notes.add(`swap_baseline_above_budget: system swap already at ${peakSwapBytes} bytes before this `
        + `qualification, so the ${limit.maxSwapBytes} byte budget is graded on attributable growth`);
    }
  }

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: 'accelerated',
    target,
    host: {
      name: hostname(),
      model: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryBytes: totalmem(),
      arch: arch(),
      platform: platform(),
      release: release(),
      node: process.version,
    },
    qualification: failures.size === 0 ? 'passed' : 'failed',
    durationBudgetMs: ACCELERATED_BUDGET_MS,
    durationMs,
    coldStartMs: measurements?.coldStartMs ?? null,
    coldStartBudgetMs: limit.maxColdStartMs,
    simulatedDurationMs: measurements?.simulatedDurationMs ?? null,
    requiredSimulatedDurationMs: EIGHT_HOURS_MS,
    driverWallClockMs: measurements?.wallClockMs ?? null,
    peakResidentBytes,
    peakSwapBytes,
    swapBeforeBytes: swapBefore,
    swapAfterBytes: swapAfter,
    swapGrowthBytes,
    swapMeasured: swapSamples.length > 0,
    peakAudioQueueDepth,
    audioQueueBudget: limit.maxAudioQueueDepth,
    peakEventQueueDepth,
    eventQueueBudget: limit.maxEventQueueDepth,
    peakSpoolBytes,
    spoolBudget: limit.maxSpoolBytes,
    droppedFrames,
    gappedBytes,
    gapsByReason: measurements?.gapsByReason ?? null,
    counters: measurements?.counters ?? null,
    memory: measurements?.memory ?? null,
    recovery: measurements?.recovery ?? null,
    scenarios: measurements?.scenarios.map((scenario) => ({
      id: scenario.id,
      passed: scenario.passed,
      checks: scenario.checks,
      failures: scenario.failures,
    })) ?? null,
    counterFingerprint: measurements?.counterFingerprint ?? null,
    budgetProfile: { maxResidentBytes: limit.maxResidentBytes, maxSwapBytes: limit.maxSwapBytes },
    failures: [...failures],
    unmeasured,
    notes: [...notes],
    samples: samplePath,
    measurementsPath,
    driverLog: driverLogPath,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  process.exitCode = failures.size === 0 ? 0 : 1;
}

async function runEightHourQualification() {
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(samplePath), { recursive: true });
  await writeFile(samplePath, '');

  const startedAt = Date.now();
  const child = spawn('zsh', ['-lc', command], { stdio: 'inherit' });
  const exit = new Promise((resolveExit) => {
    child.on('error', () => resolveExit(-1));
    child.on('close', (exitCode) => resolveExit(exitCode ?? -1));
  });
  let exited = false;
  let exitCode = null;
  void exit.then((code) => {
    exited = true;
    exitCode = code;
  });

  let peakResidentBytes = null;
  let peakSwapBytes = null;
  let swapBaselineBytes = null;
  let peakAudioQueueDepth = null;
  let peakEventQueueDepth = null;
  let peakSpoolBytes = null;
  let counters = null;
  let counterSamples = 0;
  const measurementFailures = new Set();
  let residentSamples = 0;
  let swapSamples = 0;
  if (!countersPath) measurementFailures.add('replay_counters_not_configured');

  while (!exited && Date.now() - startedAt < EIGHT_HOURS_MS) {
    const elapsedMs = Date.now() - startedAt;
    const [residentBytes, swapBytes, counterReading] = await Promise.all([
      processResidentBytes(child.pid),
      systemSwapBytes(),
      readCounters(),
    ]);
    if (residentBytes === null) {
      measurementFailures.add('resident_memory_not_measured');
    } else {
      residentSamples += 1;
      peakResidentBytes = Math.max(peakResidentBytes ?? 0, residentBytes);
    }
    if (swapBytes === null) {
      measurementFailures.add('swap_not_measured');
    } else {
      swapSamples += 1;
      swapBaselineBytes ??= swapBytes;
      peakSwapBytes = Math.max(peakSwapBytes ?? 0, swapBytes);
    }
    if (counterReading.status === 'measured') {
      counters = counterReading.counters;
      counterSamples += 1;
      peakAudioQueueDepth = Math.max(peakAudioQueueDepth ?? 0, counters.audioQueueDepth);
      peakEventQueueDepth = Math.max(peakEventQueueDepth ?? 0, counters.eventQueueDepth);
      peakSpoolBytes = Math.max(peakSpoolBytes ?? 0, counters.spoolBytes);
    } else {
      measurementFailures.add(counterReading.failure);
    }
    await appendFile(samplePath, `${JSON.stringify({
      elapsedMs,
      residentBytes,
      swapBytes,
      counterStatus: counterReading.status,
      ...(counterReading.status === 'measured' ? counterReading.counters : {
        droppedFrames: null,
        gappedBytes: null,
        audioQueueDepth: null,
        eventQueueDepth: null,
        spoolBytes: null,
      }),
    })}\n`);
    await new Promise((resolveWait) => {
      const timeout = setTimeout(resolveWait, 30_000);
      void exit.then(() => {
        clearTimeout(timeout);
        resolveWait();
      });
    });
  }

  if (!exited) {
    child.kill('SIGTERM');
    exitCode = await exit;
  } else {
    exitCode = await exit;
  }

  const durationMs = Date.now() - startedAt;
  let coldStartMs = null;
  if (coldStartPath) {
    try {
      coldStartMs = Number.parseFloat(await readFile(coldStartPath, 'utf8'));
      if (!Number.isFinite(coldStartMs)) coldStartMs = null;
    } catch {}
  }

  const limit = budgets[target];
  const failures = new Set(measurementFailures);
  const notes = new Set();
  if (counterSamples === 0 && ![
    'replay_counters_not_configured',
    'replay_counters_unavailable',
    'replay_counters_invalid',
  ].some((failure) => failures.has(failure))) {
    failures.add('replay_counters_not_measured');
  }
  if (residentSamples === 0) failures.add('resident_memory_not_measured');
  if (swapSamples === 0) failures.add('swap_not_measured');
  if (durationMs < EIGHT_HOURS_MS) failures.add('eight_hour_context_incomplete');
  if (exitCode !== 0) failures.add(`replay_exit_${exitCode}`);
  if (coldStartMs === null) failures.add('cold_start_not_measured');
  else if (coldStartMs > limit.maxColdStartMs) failures.add('cold_start_budget_exceeded');
  if (peakResidentBytes !== null && peakResidentBytes > limit.maxResidentBytes) failures.add('resident_memory_budget_exceeded');
  if (peakSwapBytes !== null) {
    const growth = peakSwapBytes - (swapBaselineBytes ?? peakSwapBytes);
    if (growth > limit.maxSwapBytes) failures.add('swap_budget_exceeded');
    if (peakSwapBytes > limit.maxSwapBytes) {
      notes.add(`swap_baseline_above_budget: system swap already at ${peakSwapBytes} bytes when sampling `
        + `began, so the ${limit.maxSwapBytes} byte budget is graded on attributable growth`);
    }
  }
  if (peakAudioQueueDepth !== null && peakAudioQueueDepth > limit.maxAudioQueueDepth) failures.add('audio_queue_budget_exceeded');
  if (peakEventQueueDepth !== null && peakEventQueueDepth > limit.maxEventQueueDepth) failures.add('event_queue_budget_exceeded');
  if (peakSpoolBytes !== null && peakSpoolBytes > limit.maxSpoolBytes) failures.add('spool_budget_exceeded');

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: 'eight_hour',
    target,
    host: {
      name: hostname(),
      model: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryBytes: totalmem(),
      arch: arch(),
      platform: platform(),
      release: release(),
      node: process.version,
    },
    qualification: failures.size === 0 ? 'passed' : 'failed',
    durationMs,
    coldStartMs,
    peakResidentBytes,
    peakSwapBytes,
    swapBaselineBytes,
    peakAudioQueueDepth,
    peakEventQueueDepth,
    peakSpoolBytes,
    droppedFrames: counters?.droppedFrames ?? null,
    gappedBytes: counters?.gappedBytes ?? null,
    failures: [...failures],
    notes: [...notes],
    samples: samplePath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  process.exitCode = failures.size === 0 ? 0 : 1;
}

if (mode === 'accelerated') await runAcceleratedQualification();
else await runEightHourQualification();
