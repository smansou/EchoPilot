#!/usr/bin/env node
// Local-only live progress board for EchoPilot.
//
// Serves exactly two allowlisted GET endpoints on 127.0.0.1:
//   /             -> docs/progress-board.html (fixed path, no user-controlled filesystem access)
//   /api/progress -> bounded, validated, whitelist-projected snapshot of docs/progress-state.json
//
// The server never writes state, never proxies anything, never sets CORS headers,
// never exposes raw logs/transcripts, and holds no timers or scheduled jobs: every
// request re-reads the state file fresh and reconciles recorded run lifecycles.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = ['backlog', 'in-progress', 'review', 'verified', 'blocked'];
export const LIFECYCLE_STATUSES = ['idle', 'running', 'succeeded', 'failed', 'interrupted'];
export const PHASES = ['implement', 'verify'];
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;
export const MAX_STATE_BYTES = 256 * 1024;
export const MAX_TASKS = 200;
export const MAX_FIELD_CHARS = 400;
const PID_START_TOLERANCE_MS = 5 * 60 * 1000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const DEFAULT_STATE_FILE = path.join(REPO_ROOT, 'docs', 'progress-state.json');
export const DEFAULT_HTML_FILE = path.join(REPO_ROOT, 'docs', 'progress-board.html');

export class ValidationError extends Error {}

export function isValidTaskId(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function fail(where, message) {
  throw new ValidationError(`${where}: ${message}`);
}

function checkString(value, where, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') fail(where, 'expected a string');
  if (!allowEmpty && value.trim() === '') fail(where, 'expected a non-empty string');
  return value;
}

function checkTime(value, where) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(where, 'expected an ISO timestamp string or null');
  }
  return value;
}

function checkLifecycle(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(where, 'expected an object');
  const status = raw.status;
  if (!LIFECYCLE_STATUSES.includes(status)) fail(`${where}.status`, `unknown lifecycle status ${JSON.stringify(status)}`);
  const phase = raw.phase ?? null;
  if (phase !== null && !PHASES.includes(phase)) fail(`${where}.phase`, `unknown phase ${JSON.stringify(phase)}`);
  const pid = raw.pid ?? null;
  if (pid !== null && !(Number.isInteger(pid) && pid > 0)) fail(`${where}.pid`, 'expected a positive integer or null');
  const exitCode = raw.exitCode ?? null;
  if (exitCode !== null && !Number.isInteger(exitCode)) fail(`${where}.exitCode`, 'expected an integer or null');
  const lastRunNote = raw.lastRunNote ?? null;
  if (lastRunNote !== null) checkString(lastRunNote, `${where}.lastRunNote`);
  return {
    status,
    phase,
    pid,
    startedAt: checkTime(raw.startedAt ?? null, `${where}.startedAt`),
    endedAt: checkTime(raw.endedAt ?? null, `${where}.endedAt`),
    exitCode,
    lastRunNote,
  };
}

// Strictly validates the persisted state and returns a normalized deep copy.
// Unknown stages/statuses are rejected so the board errors truthfully instead of guessing.
export function validateState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('state', 'expected a JSON object');
  const appName = checkString(raw.appName ?? 'EchoPilot', 'state.appName', { allowEmpty: false });
  if (raw.releaseReady !== false) fail('state.releaseReady', 'must be false: this app is not release-ready');
  const releaseNote = checkString(raw.releaseNote, 'state.releaseNote', { allowEmpty: false });
  const progressUpdatedAt = checkTime(raw.progressUpdatedAt ?? null, 'state.progressUpdatedAt');
  if (!Array.isArray(raw.tasks)) fail('state.tasks', 'expected an array');
  if (raw.tasks.length > MAX_TASKS) fail('state.tasks', `exceeds ${MAX_TASKS} tasks`);
  const seen = new Set();
  const tasks = raw.tasks.map((task, index) => {
    const where = `state.tasks[${index}]`;
    if (task === null || typeof task !== 'object' || Array.isArray(task)) fail(where, 'expected an object');
    if (!isValidTaskId(task.id)) fail(`${where}.id`, 'expected a lowercase id of letters, digits and hyphens (max 64)');
    if (seen.has(task.id)) fail(`${where}.id`, `duplicate task id ${JSON.stringify(task.id)}`);
    seen.add(task.id);
    if (!STAGES.includes(task.stage)) fail(`${where}.stage`, `unknown stage ${JSON.stringify(task.stage)}`);
    return {
      id: task.id,
      title: checkString(task.title, `${where}.title`, { allowEmpty: false }),
      stage: task.stage,
      scope: checkString(task.scope ?? '', `${where}.scope`),
      evidence: checkString(task.evidence ?? '', `${where}.evidence`),
      remaining: checkString(task.remaining ?? '', `${where}.remaining`),
      caveat: checkString(task.caveat ?? '', `${where}.caveat`),
      lifecycle: checkLifecycle(task.lifecycle ?? {}, `${where}.lifecycle`),
    };
  });
  return { appName, releaseReady: false, releaseNote, progressUpdatedAt, tasks };
}

export function readState(stateFile) {
  let raw;
  try {
    const stat = fs.statSync(stateFile);
    if (!stat.isFile()) throw new ValidationError(`state file is not a regular file: ${stateFile}`);
    if (stat.size > MAX_STATE_BYTES) {
      throw new ValidationError(`state file exceeds the ${MAX_STATE_BYTES}-byte bound`);
    }
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`cannot read state file: ${error.message}`);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) {
    throw new ValidationError(`state file exceeds the ${MAX_STATE_BYTES}-byte bound`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(`state file is not valid JSON: ${error.message}`);
  }
  return validateState(parsed);
}

export function writeStateAtomic(stateFile, state) {
  validateState(state);
  const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup only
    }
    throw error;
  }
}

// Best-effort process start time. `ps` may be unavailable in sandboxes; callers must
// tolerate null (falls back to a plain liveness check). The probe is bounded so a
// hung `ps` can never hold a board request or wrapper transaction open.
export function getProcessStartMs(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      killSignal: 'SIGKILL',
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out.replace(/\s+/g, ' '));
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Liveness check with PID-reuse mitigation where feasible: a stored start time must
// match the live process start time within tolerance before the PID is trusted.
export function isProcessAlive(pid, startedAt) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  const expected = startedAt == null ? Number.NaN : Date.parse(startedAt);
  if (!Number.isFinite(expected)) return true;
  const actual = getProcessStartMs(pid);
  if (actual === null) return true;
  return Math.abs(actual - expected) <= PID_START_TOLERANCE_MS;
}

// A task recorded as running whose wrapper process is not alive was interrupted
// (crash, restart, or orphan cleanup); it returns to review, never "running". The
// recorded endedAt is preserved exactly as stored (typically null): an unwitnessed
// death has no observed end time, so the board never fabricates one.
export function reconcileTask(task, { alive = isProcessAlive } = {}) {
  const lc = task.lifecycle;
  if (lc.status !== 'running') return task;
  if (lc.pid !== null && alive(lc.pid, lc.startedAt)) return task;
  return {
    ...task,
    stage: 'review',
    lifecycle: {
      ...lc,
      status: 'interrupted',
      lastRunNote:
        lc.lastRunNote ??
        'No live wrapper process found (crash or restart): run interrupted, review required; no end time recorded.',
    },
  };
}

function clip(value) {
  if (typeof value !== 'string' || value.length <= MAX_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_FIELD_CHARS - 3)}...`;
}

// Whitelist projection: only known display fields reach the browser; anything else
// in the state file (tokens, credentials, transcripts) is dropped, never rendered.
export function projectState(state, { alive = isProcessAlive } = {}) {
  const reconciled = state.tasks.map((task) => reconcileTask(task, { alive }));
  const tasks = reconciled.map((task) => ({
    id: clip(task.id),
    title: clip(task.title),
    stage: task.stage,
    scope: clip(task.scope),
    evidence: clip(task.evidence),
    remaining: clip(task.remaining),
    caveat: clip(task.caveat),
    lifecycle: {
      status: task.lifecycle.status,
      phase: task.lifecycle.phase,
      pid: task.lifecycle.pid,
      startedAt: task.lifecycle.startedAt,
      endedAt: task.lifecycle.endedAt,
      exitCode: task.lifecycle.exitCode,
      runningNow: task.lifecycle.status === 'running',
      lastRunNote: task.lifecycle.lastRunNote === null ? null : clip(task.lifecycle.lastRunNote),
    },
  }));
  const stageCounts = {};
  for (const stage of STAGES) stageCounts[stage] = tasks.filter((task) => task.stage === stage).length;
  return {
    ok: true,
    appName: clip(state.appName),
    releaseReady: false,
    releaseNote: clip(state.releaseNote),
    progressUpdatedAt: state.progressUpdatedAt,
    recordedTaskCount: tasks.length,
    workerActive: tasks.some((task) => task.lifecycle.runningNow),
    activeTaskIds: tasks.filter((task) => task.lifecycle.runningNow).map((task) => task.id),
    stageCounts,
    tasks,
  };
}

export function loadProjectedState(stateFile, options = {}) {
  return projectState(readState(stateFile), options);
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...SECURITY_HEADERS, ...extraHeaders });
  res.end(body);
}

// The complete HTTP surface: allowlisted GET routes only, fixed file paths only,
// explicit content types and security headers, no CORS, no writes.
export function handleRequest(req, res, { stateFile = DEFAULT_STATE_FILE, htmlFile = DEFAULT_HTML_FILE } = {}) {
  const method = req.method || 'GET';
  if (method !== 'GET') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n', { Allow: 'GET' });
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url || '/', `http://${DEFAULT_HOST}`).pathname;
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', 'bad request\n');
    return;
  }
  if (pathname === '/') {
    let html;
    try {
      html = fs.readFileSync(htmlFile, 'utf8');
    } catch (error) {
      send(res, 500, 'text/plain; charset=utf-8', `board html unavailable: ${error.message}\n`);
      return;
    }
    send(res, 200, 'text/html; charset=utf-8', html, {
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
    });
    return;
  }
  if (pathname === '/api/progress') {
    let payload;
    try {
      payload = loadProjectedState(stateFile);
    } catch (error) {
      send(res, 500, 'application/json; charset=utf-8', `${JSON.stringify({ ok: false, error: error.message })}\n`);
      return;
    }
    send(res, 200, 'application/json; charset=utf-8', `${JSON.stringify(payload)}\n`);
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
}

export function createProgressServer(options = {}) {
  return createServer((req, res) => handleRequest(req, res, options));
}

export function startProgressServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = createProgressServer();
  server.listen(port, host, () => {
    process.stdout.write(`progress board: http://${host}:${port} (local only, read-only)\n`);
  });
  return server;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startProgressServer();
}
