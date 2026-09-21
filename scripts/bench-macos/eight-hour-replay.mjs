#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;
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

const target = process.env.ECHOPILOT_BENCH_TARGET;
const command = process.env.ECHOPILOT_REPLAY_COMMAND;
const reportPath = resolve(process.env.ECHOPILOT_BENCH_REPORT ?? 'artifacts/performance/eight-hour-replay.json');
const samplePath = resolve(process.env.ECHOPILOT_BENCH_SAMPLES ?? 'artifacts/performance/eight-hour-replay.ndjson');
const coldStartPath = process.env.ECHOPILOT_COLD_START_MS_FILE;
const countersPath = process.env.ECHOPILOT_REPLAY_COUNTERS;

if (!(target in budgets)) throw new Error('ECHOPILOT_BENCH_TARGET must be M4_24_GB or M2_16_GB');
if (!command) throw new Error('ECHOPILOT_REPLAY_COMMAND is required');

function run(commandName, args) {
  return new Promise((resolveResult) => {
    const child = spawn(commandName, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolveResult({ exitCode: -1, stdout: '' }));
    child.on('close', (exitCode) => resolveResult({ exitCode: exitCode ?? -1, stdout }));
  });
}

async function processResidentBytes(pid) {
  const result = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
  return result.exitCode === 0 ? (Number.parseInt(result.stdout.trim(), 10) || 0) * 1024 : 0;
}

async function systemSwapBytes() {
  const result = await run('sysctl', ['-n', 'vm.swapusage']);
  const match = /used\s*=\s*([0-9.]+)([KMG])/i.exec(result.stdout);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  const multiplier = { K: 1024, M: MIB, G: GIB }[match[2].toUpperCase()];
  return Math.round(value * multiplier);
}

async function readCounters(previous) {
  if (!countersPath) return previous;
  try {
    const parsed = JSON.parse(await readFile(countersPath, 'utf8'));
    return {
      droppedFrames: Number(parsed.droppedFrames) || 0,
      gappedBytes: Number(parsed.gappedBytes) || 0,
      audioQueueDepth: Number(parsed.audioQueueDepth) || 0,
      eventQueueDepth: Number(parsed.eventQueueDepth) || 0,
      spoolBytes: Number(parsed.spoolBytes) || 0,
    };
  } catch {
    return previous;
  }
}

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

let peakResidentBytes = 0;
let peakSwapBytes = 0;
let peakAudioQueueDepth = 0;
let peakEventQueueDepth = 0;
let peakSpoolBytes = 0;
let counters = { droppedFrames: 0, gappedBytes: 0, audioQueueDepth: 0, eventQueueDepth: 0, spoolBytes: 0 };

while (!exited && Date.now() - startedAt < EIGHT_HOURS_MS) {
  const elapsedMs = Date.now() - startedAt;
  const [residentBytes, swapBytes] = await Promise.all([
    processResidentBytes(child.pid),
    systemSwapBytes(),
  ]);
  counters = await readCounters(counters);
  peakResidentBytes = Math.max(peakResidentBytes, residentBytes);
  peakSwapBytes = Math.max(peakSwapBytes, swapBytes);
  peakAudioQueueDepth = Math.max(peakAudioQueueDepth, counters.audioQueueDepth);
  peakEventQueueDepth = Math.max(peakEventQueueDepth, counters.eventQueueDepth);
  peakSpoolBytes = Math.max(peakSpoolBytes, counters.spoolBytes);
  await appendFile(samplePath, `${JSON.stringify({ elapsedMs, residentBytes, swapBytes, ...counters })}\n`);
  await Promise.race([exit, new Promise((resolveSleep) => setTimeout(resolveSleep, 30_000))]);
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
const failures = [];
if (durationMs < EIGHT_HOURS_MS) failures.push('eight_hour_context_incomplete');
if (exitCode !== 0) failures.push(`replay_exit_${exitCode}`);
if (coldStartMs === null) failures.push('cold_start_not_measured');
else if (coldStartMs > limit.maxColdStartMs) failures.push('cold_start_budget_exceeded');
if (peakResidentBytes > limit.maxResidentBytes) failures.push('resident_memory_budget_exceeded');
if (peakSwapBytes > limit.maxSwapBytes) failures.push('swap_budget_exceeded');
if (peakAudioQueueDepth > limit.maxAudioQueueDepth) failures.push('audio_queue_budget_exceeded');
if (peakEventQueueDepth > limit.maxEventQueueDepth) failures.push('event_queue_budget_exceeded');
if (peakSpoolBytes > limit.maxSpoolBytes) failures.push('spool_budget_exceeded');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: hostname(),
  target,
  qualification: failures.length === 0 ? 'passed' : 'failed',
  durationMs,
  coldStartMs,
  peakResidentBytes,
  peakSwapBytes,
  peakAudioQueueDepth,
  peakEventQueueDepth,
  peakSpoolBytes,
  droppedFrames: counters.droppedFrames,
  gappedBytes: counters.gappedBytes,
  failures,
  samples: samplePath,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
process.exitCode = failures.length === 0 ? 0 : 1;
