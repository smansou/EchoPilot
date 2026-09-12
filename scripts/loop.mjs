#!/usr/bin/env node
// EchoPilot autonomous loop runner.
//
// This file owns IO and orchestration only: git worktrees, state files, agent
// subprocesses/cmux surfaces, gate execution and publication. Every judgement call
// (routing, findings, review decisions, recovery, phase planning) lives in
// scripts/loop-policy.mjs so it can be unit tested without touching a repository.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile, lstat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AGENT_SCHEMAS, CHECK_COMMANDS, MAX_TEST_HASH_HISTORY,
  agentArgv, approvalFlags, beginMergeRepair, beginOracleRepair, boundedText,
  canReconcileLockfile, checkCommandsFor, classifyFailure, cleanPath, commandLabel,
  conflicts, coverageGaps, digest, doneDecision, emptyContracts, hashedFindingId,
  integratedTicketTitle, isManifestPath, isPathAllowed, isUnchangedRerun, loadContracts,
  looksLikeAssertions, makeFinding, mergeFindings, normalizeCollectChecks,
  openBlocking, parseStructuredResult, phaseFor, planTicket, pushTargetAllowed, recoveryPlan,
  repairFingerprint, repetitionBlocked, reviewDecision, routeFor, testFilePath, testPolicy,
  ticketPaths, validCommand,
} from './loop-policy.mjs';

const root = process.cwd();
const loopDir = resolve(process.env.LOOP_STATE_DIR ?? join(root, '.loop'));
const statePath = join(loopDir, 'state.json');
const eventPath = join(loopDir, 'events.jsonl');
const lockPath = join(loopDir, 'lock');
const worktreeRoot = join(loopDir, 'worktrees');
const runRoot = join(loopDir, 'runs');
const contractsPath = join(root, 'loop-contracts.json');
const PORT = Number(process.env.LOOP_PORT ?? 4318);
const CALL_MS = 30 * 60_000;        // hard cap for one agent call; quiet is not a hang
const CHECK_MS = 10 * 60_000;       // deterministic check / install budget
const SURFACE_IDLE_MS = 180_000;    // cmux presentation only: no new output closes the surface
const MAX_OUTPUT = 256_000;         // bounded stdout/stderr per process
const MAX_LINE_BUFFER = 64_000;     // bounded partial-line buffer

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const AGENT_BIN = process.env.LOOP_AGENT_BIN ?? 'codex';
const MAX_ACTIVE = envInt('LOOP_MAX_AGENTS', envInt('LOOP_MAX_ACTIVE', 2));
// F02/S01 keep the historical extra ownership; loop-contracts.json can add more.
const extraPaths = {
  F02: ['apps/desktop/src/renderer/main.tsx', 'apps/desktop/src/renderer/styles.css'],
  S01: ['apps/desktop/src/main/index.ts', 'native/macos/Package.swift', 'pnpm-lock.yaml'],
};

let state;
let contracts = emptyContracts();
let integration = Promise.resolve();
let saveQueue = Promise.resolve();
let stopping = false;
let stopReason;
let runnerLockOwned = false;
const liveChildren = new Set();

function nowIso() {
  return new Date().toISOString();
}

function delay(ms, { unref = false } = {}) {
  return new Promise(resolveWait => {
    const timer = setTimeout(resolveWait, ms);
    if (unref) timer.unref?.();
  });
}

function inside(file, base) {
  const relativePath = relative(base, file);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function pathsFor(ticket) {
  return ticketPaths(ticket, { extraPaths, contracts });
}

function summarizeFailure(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= 400 ? clean : `${clean.slice(0, 399)}…`;
}

// ---------------------------------------------------------------- process IO
function stopProcessTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function tail(current, chunk, limit) {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(-limit);
}

// The ONLY autonomous kill switch is `timeout`. There is deliberately no idle
// timeout: an agent that thinks for ten quiet minutes is working, not hung.
async function processRun(command, args, { cwd = root, input = '', timeout = CHECK_MS, onLine, env = {} } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true' },
    });
    const pid = child.pid;
    if (pid) liveChildren.add(pid);
    let out = '';
    let err = '';
    let buffer = '';
    let timedOut = false;
    const finish = () => {
      if (pid) liveChildren.delete(pid);
    };
    const hard = setTimeout(() => {
      timedOut = true;
      stopProcessTree(pid, 'SIGTERM');
      setTimeout(() => stopProcessTree(pid, 'SIGKILL'), 5_000).unref();
    }, timeout);
    child.stdout.on('data', chunk => {
      out = tail(out, String(chunk), MAX_OUTPUT);
      buffer += chunk;
      if (buffer.length > MAX_LINE_BUFFER) buffer = buffer.slice(-MAX_LINE_BUFFER);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          onLine?.(line);
        } catch {}
      }
    });
    child.stderr.on('data', chunk => {
      err = tail(err, String(chunk), MAX_OUTPUT);
    });
    child.on('error', error => {
      clearTimeout(hard);
      finish();
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(hard);
      finish();
      resolveRun({ code, out, err, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// SIGINT/SIGTERM or loop exit: stop direct children process-group-first.
async function stopChildren() {
  const pids = [...liveChildren];
  for (const pid of pids) stopProcessTree(pid, 'SIGTERM');
  if (!pids.length) return;
  await delay(1_500);
  for (const pid of [...liveChildren]) stopProcessTree(pid, 'SIGKILL');
}

async function gitOptional(cwd, args, { timeout = 60_000 } = {}) {
  try {
    const run = await processRun('git', args, { cwd, timeout });
    return run.code === 0 ? run.out.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function git(cwd, ...args) {
  const run = await processRun('git', args, { cwd, timeout: 60_000 });
  if (run.code !== 0) throw new Error(`git ${args[0]} failed: ${run.err.slice(-1500)}`);
  return args.includes('-z') ? run.out : run.out.trim();
}

async function isAncestor(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  const run = await processRun('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, timeout: 60_000 });
  return run.code === 0;
}

// ---------------------------------------------------------------- runner lock
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// Acquire .loop/lock before touching state so two runners cannot fight over one
// worktree set. A live pid refuses startup; a stale lock is taken over.
async function acquireRunnerLock() {
  await mkdir(loopDir, { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: nowIso(), cwd: root })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, payload, { mode: 0o600, flag: 'wx' });
      runnerLockOwned = true;
      process.on('exit', () => {
        if (!runnerLockOwned) return;
        try {
          rmSync(lockPath, { force: true });
        } catch {}
      });
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {}
      if (owner?.pid && owner.pid !== process.pid && pidAlive(owner.pid)) {
        throw Object.assign(new Error(`Another loop runner (pid ${owner.pid}, started ${owner.startedAt ?? 'unknown'}) holds ${lockPath}`), { failureClass: 'user' });
      }
      // Stale or unreadable lock: take it over, then confirm the takeover stuck.
      await writeFile(lockPath, payload, { mode: 0o600 });
      const check = JSON.parse((await readFile(lockPath, 'utf8').catch(() => '{}')) || '{}');
      if (check?.pid === process.pid) {
        runnerLockOwned = true;
        return;
      }
    }
  }
  throw new Error(`Could not acquire ${lockPath}`);
}

async function releaseRunnerLock() {
  if (!runnerLockOwned) return;
  runnerLockOwned = false;
  await rm(lockPath, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------- state
function save(event) {
  const job = saveQueue.then(async () => {
    state.updatedAt = nowIso();
    const tmp = join(loopDir, `state.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, statePath);
    if (event) await appendFile(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    queueStatus();
  });
  saveQueue = job.catch(() => undefined);
  return job;
}

async function update(id, patch, message) {
  Object.assign(state.tickets[id], patch, { updatedAt: nowIso() });
  await save(message ? { at: nowIso(), ticketId: id, message } : undefined);
}

function logEvent(ticketId, message) {
  return save({ at: nowIso(), ticketId, message: boundedText(message, { max: 2000 }) });
}

function freshRecord(ticket) {
  return {
    id: ticket.id,
    path: ticket.path,
    status: 'ready',
    phase: 'test',
    detail: 'waiting for dependencies',
    runs: 0,
    substantiveFailures: 0,
    transientFailures: 0,
    bootstrapRetries: 0,
    oracleRepairs: 0,
    mergeRepairs: 0,
    repairFingerprints: [],
    repairPending: false,
    findings: [],
    testFiles: [],
    testCommand: [],
    testHashes: {},
    updatedAt: nowIso(),
  };
}

// Legacy records keep their durable information: lastFailure and old issue arrays
// migrate into record.findings with stable hashed IDs instead of being dropped.
function normalizeRecord(record, ticket) {
  record.id = ticket.id;
  record.path = ticket.path;
  record.runs = record.runs ?? 0;
  record.substantiveFailures = record.substantiveFailures ?? 0;
  record.transientFailures = record.transientFailures ?? 0;
  record.bootstrapRetries = record.bootstrapRetries ?? 0;
  record.oracleRepairs = record.oracleRepairs ?? 0;
  record.mergeRepairs = record.mergeRepairs ?? 0;
  record.repairFingerprints = Array.isArray(record.repairFingerprints) ? record.repairFingerprints.slice(-8) : [];
  record.repairPending = Boolean(record.repairPending);
  record.testFiles = Array.isArray(record.testFiles) ? record.testFiles : [];
  record.testCommand = Array.isArray(record.testCommand) ? record.testCommand : [];
  record.testHashes = record.testHashes && typeof record.testHashes === 'object' ? record.testHashes : {};
  const incoming = [];
  if (Array.isArray(record.issues)) {
    for (const issue of record.issues) {
      const description = String(issue ?? '').trim();
      if (description) incoming.push({ id: hashedFindingId(description), severity: 'major', category: 'ticket', description });
    }
    delete record.issues;
  }
  if (record.lastFailure && !(record.findings ?? []).length) {
    const description = boundedText(String(record.lastFailure));
    const category = record.phase === 'test' || record.failureClass === 'oracle' ? 'oracle' : 'ticket';
    incoming.push({ id: hashedFindingId(description), severity: 'major', category, description, status: record.status === 'done' ? 'verified' : 'open' });
  }
  const merged = mergeFindings(record.findings ?? [], incoming, { head: record.approvedHead });
  record.findings = merged.findings;
  return record;
}

// ---------------------------------------------------------------- worktrees
async function cleanRoot() {
  if (await git(root, 'status', '--porcelain')) throw new Error('Integration checkout is dirty; refusing to integrate or push');
  return git(root, 'branch', '--show-current');
}

// feat(ID) commits are history metadata only; reconciliation uses approvedHead,
// same-head gate evidence and the publication marker.
async function integrationHistory(branch) {
  const history = new Map();
  const log = await git(root, 'log', '--format=%H\t%s', branch, '--');
  for (const line of log.split('\n')) {
    const found = integratedTicketTitle(line);
    if (!found) continue;
    const commits = history.get(found.id) ?? [];
    commits.push(found.commit);
    history.set(found.id, commits);
  }
  return history;
}

async function changedFiles(cwd, base) {
  const tracked = await git(cwd, 'diff', '--name-only', '-z', base, '--');
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set(`${tracked}\0${untracked}`.split('\0').filter(Boolean))];
}

async function validateChanges(cwd, base, paths) {
  for (const file of await changedFiles(cwd, base)) {
    if (!isPathAllowed(file, paths)) throw Object.assign(new Error(`Outside ticket ownership: ${file}`), { failureClass: 'implementation' });
    const full = resolve(cwd, file);
    if (!inside(full, cwd)) throw new Error(`Path escapes candidate: ${file}`);
    try {
      if ((await lstat(full)).isSymbolicLink()) throw new Error(`Symlink not accepted: ${file}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function seedLegacy(ticket, target, base) {
  const legacy = state.tickets[ticket.id].legacy;
  if (!legacy) return false;
  const paths = pathsFor(ticket).map(cleanPath);
  let seeded = false;
  if (legacy.branch) {
    try {
      const common = await git(root, 'merge-base', base, legacy.branch);
      const patch = await git(root, 'diff', '--binary', common, legacy.branch, '--', ...paths);
      if (patch) {
        const run = await processRun('git', ['apply', '--index', '--whitespace=nowarn', '-'], { cwd: target, input: `${patch}\n` });
        if (run.code !== 0) throw new Error(run.err);
        seeded = true;
      }
    } catch {}
  }
  if (legacy.worktree) {
    try {
      const dirty = await git(legacy.worktree, 'diff', '--binary', 'HEAD', '--', ...paths);
      if (dirty) {
        const run = await processRun('git', ['apply', '--index', '--whitespace=nowarn', '-'], { cwd: target, input: `${dirty}\n` });
        if (run.code === 0) seeded = true;
      }
      const files = (await git(legacy.worktree, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...paths)).split('\0').filter(Boolean);
      for (const file of files) {
        if (!isPathAllowed(file, pathsFor(ticket))) continue;
        const source = resolve(legacy.worktree, file);
        if ((await lstat(source)).isSymbolicLink()) continue;
        const destination = resolve(target, file);
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination, { recursive: true, force: true });
        seeded = true;
      }
    } catch {}
  }
  return seeded;
}

// The candidate worktree is retained across runs; nothing here discards work.
async function worktree(ticket) {
  const record = state.tickets[ticket.id];
  const path = join(worktreeRoot, ticket.id);
  const branch = `codex/loop/${ticket.id}`;
  try {
    await stat(join(path, '.git'));
    return { path, branch, base: await git(root, 'merge-base', state.integrationBranch, branch) };
  } catch {}
  try {
    await git(root, 'show-ref', '--verify', `refs/heads/${branch}`);
    await git(root, 'worktree', 'add', path, branch);
  } catch {
    await git(root, 'worktree', 'add', '-b', branch, path, state.integrationBranch);
  }
  const base = await git(root, 'merge-base', state.integrationBranch, branch);
  const seeded = await seedLegacy(ticket, path, state.integrationBranch);
  record.seeded = seeded;
  return { path, branch, base };
}

// ---------------------------------------------------------------- agent terminals
// cmux is optional presentation. LOOP_TERMINALS=direct (the default) runs agents as
// plain subprocesses; cmux keeps one surface per ticket when the loop is launched
// from inside a cmux workspace.
const CMUX_BIN = process.env.CMUX_BIN ?? '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX_GRID = join(root, 'scripts', 'cmux-grid.mjs');
const CMUX_RUNNER = join(root, 'scripts', 'loop-agent-call.mjs');
const TERMINALS = (process.env.LOOP_TERMINALS ?? 'direct').toLowerCase();
const CMUX_WORKSPACE = process.env.CMUX_WORKSPACE_ID ?? '';
const CMUX_SUPERVISOR = process.env.CMUX_SUPERVISOR_SURFACE ?? process.env.CMUX_SURFACE_ID ?? '';
const useCmux = TERMINALS === 'cmux' || (TERMINALS === 'auto' && Boolean(CMUX_WORKSPACE && CMUX_SUPERVISOR));
const agentSurfaces = new Map();
const activeSurfaces = new Set();
let statusPending = false;
let lastStatusAt = 0;

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function cmux(args, { timeout = 30_000 } = {}) {
  return processRun(CMUX_BIN, args, { timeout });
}

async function runGrid(command, args) {
  const run = await processRun('node', [CMUX_GRID, command, '--workspace', CMUX_WORKSPACE, '--supervisor-surface', CMUX_SUPERVISOR, ...args], { timeout: 300_000 });
  if (run.code !== 0) throw new Error(`cmux-grid ${command} failed: ${(run.err || run.out).trim().slice(-800)}`);
  return JSON.parse(run.out.trim().split('\n').filter(Boolean).pop() ?? '{}');
}

let gridQueue = Promise.resolve();
function grid(command, args) {
  const job = gridQueue.then(() => runGrid(command, args));
  gridQueue = job.catch(() => undefined);
  return job;
}

async function labelSurface(surface, label) {
  if (!surface || !label) return;
  await cmux(['rename-tab', '--workspace', CMUX_WORKSPACE, '--surface', surface, label], { timeout: 20_000 });
}

async function ticketSurface(ticket, cwd, invocation, label) {
  const existing = agentSurfaces.get(ticket.id);
  if (existing) {
    const sent = await grid('send', ['--surface', existing, '--command', invocation]);
    if (sent.surface) {
      activeSurfaces.add(existing);
      await labelSurface(existing, label);
      return existing;
    }
    agentSurfaces.delete(ticket.id);
  }
  const spawned = await grid('spawn', ['--name', ticket.id, '--cwd', cwd, '--command', invocation, '--title', label]);
  agentSurfaces.set(ticket.id, spawned.surface);
  activeSurfaces.add(spawned.surface);
  return spawned.surface;
}

async function releaseTicketSurface(ticketId) {
  const surface = agentSurfaces.get(ticketId);
  if (!surface) return;
  activeSurfaces.delete(surface);
}

async function stopAgents() {
  if (!useCmux) return;
  for (const surface of [...activeSurfaces]) {
    try {
      await cmux(['send-key', '--workspace', CMUX_WORKSPACE, '--surface', surface, 'ctrl+c'], { timeout: 15_000 });
    } catch {}
  }
}

async function readExitCode(path) {
  try {
    const value = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
    return Number.isNaN(value) ? undefined : value;
  } catch {
    return undefined;
  }
}

async function surfaceAlive(surface) {
  const run = await cmux(['--json', '--id-format', 'both', 'surface-health', '--workspace', CMUX_WORKSPACE], { timeout: 20_000 });
  if (run.code !== 0) return true;
  try {
    const ids = (JSON.parse(run.out).surfaces ?? []).map(item => item.id ?? item.surface_id).filter(Boolean);
    return !ids.length || ids.includes(surface);
  } catch {
    return true;
  }
}

async function cancelSurface(surface) {
  await cmux(['send-key', '--workspace', CMUX_WORKSPACE, '--surface', surface, 'ctrl+c'], { timeout: 20_000 });
  await delay(3_000);
  await cmux(['close-surface', '--workspace', CMUX_WORKSPACE, '--surface', surface], { timeout: 20_000 });
}

async function tailDetail(logPath, role) {
  try {
    const lines = (await readFile(logPath, 'utf8')).trimEnd().split('\n').slice(-40).reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const kind = event.item?.type ?? event.type;
        if (kind) return `${role} · ${kind}`;
      } catch {}
    }
  } catch {}
  return undefined;
}

// cmux does not hand us the agent's stdout: the surface runner writes an exit
// sentinel and liveness is inferred from log growth plus surface existence. A long
// quiet stretch is not a failure: only a surface that actually disappeared ends the
// call early, otherwise the 30-minute hard cap applies exactly as in direct mode.
async function waitForSurface(surface, { exitPath, logPath, ticketId, role }) {
  const started = Date.now();
  const idleLimit = Math.max(SURFACE_IDLE_MS, envInt('LOOP_IDLE_MS', 480_000));
  let last = Date.now();
  let size = -1;
  let polls = 0;
  while (true) {
    if (stopping) return { code: -1, timedOut: false, out: '', err: 'loop is stopping', aborted: true };
    const code = await readExitCode(exitPath);
    if (code !== undefined) return { code, timedOut: false, out: '', err: '' };
    if (Date.now() - last > idleLimit) {
      if (!(await surfaceAlive(surface))) return { code: -1, timedOut: false, out: '', err: `${role} terminal disappeared while the agent was quiet` };
      last = Date.now();
      void update(ticketId, { detail: `${role} · quiet for ${Math.round(idleLimit / 1000)}s (still alive)` });
    }
    if (Date.now() - started > CALL_MS) {
      await cancelSurface(surface);
      return { code: -1, timedOut: true, out: '', err: `${role} exceeded ${Math.round(CALL_MS / 60000)} minutes` };
    }
    polls += 1;
    if (polls % 12 === 0 && !(await surfaceAlive(surface))) return { code: -1, timedOut: false, out: '', err: `${role} terminal was closed before it finished` };
    if (polls % 6 === 0) {
      const detail = await tailDetail(logPath, role);
      if (detail) void update(ticketId, { detail });
    }
    let current = -1;
    try {
      current = (await stat(logPath)).size;
    } catch {}
    if (current !== size) {
      size = current;
      last = Date.now();
    }
    await delay(1_000);
  }
}

function queueStatus() {
  if (!useCmux || statusPending || Date.now() - lastStatusAt < 4_000) return;
  statusPending = true;
  setTimeout(() => {
    statusPending = false;
    lastStatusAt = Date.now();
    void publishStatus();
  }, 250).unref();
}

async function publishStatus() {
  if (!useCmux || !state?.tickets) return;
  const records = Object.values(state.tickets);
  const total = records.length;
  const done = records.filter(record => record.status === 'done').length;
  const active = records.filter(record => record.status === 'implementing' || record.status === 'review').length;
  const blocked = records.filter(record => record.status === 'blocked').length;
  const label = `${done}/${total} done · ${active} active${blocked ? ` · ${blocked} blocked` : ''}`;
  try {
    await cmux(['set-status', 'loop', label, '--workspace', CMUX_WORKSPACE, '--color', blocked ? '#ff453a' : '#30d158'], { timeout: 20_000 });
  } catch {}
  try {
    await cmux(['set-progress', String(total ? done / total : 0), '--label', `${done}/${total} tickets`, '--workspace', CMUX_WORKSPACE], { timeout: 20_000 });
  } catch {}
}

// ---------------------------------------------------------------- agent call
async function artifactPaths(dir) {
  try {
    const entries = await readdir(dir);
    return entries.filter(name => name.endsWith('.log')).sort().slice(-20).map(name => join(dir, name));
  } catch {
    return [];
  }
}

function findingsPrompt(findings, { head } = {}) {
  const open = (findings ?? []).filter(finding => finding.status === 'open');
  if (!open.length) return 'Open findings: none.';
  const lines = open.map(finding => `- [${finding.id}] severity=${finding.severity} category=${finding.category} status=${finding.status} introducedAt=${finding.introducedAt}\n  ${finding.description}`);
  return `Open findings (durable records; every blocker below is in scope, verify ids against HEAD ${head ?? 'unknown'}):\n${lines.join('\n')}`;
}

async function agentCall(ticket, record, role, cwd, prompt, dir) {
  const route = routeFor(role);
  await update(ticket.id, { model: route.model, effort: route.effort, detail: `${role} · starting` });
  await mkdir(dir, { recursive: true });
  const structuredPrompt = `${prompt}\n\nYour final response must be only one raw JSON object matching the supplied output schema. Do not wrap it in Markdown fences and do not place prose before or after it.`;
  const schemaPath = join(dir, `${role}-schema.json`);
  const resultPath = join(dir, `${role}-result.json`);
  const logPath = join(dir, `${role}.log`);
  const promptPath = join(dir, `${role}-prompt.txt`);
  const exitPath = join(dir, `${role}.exit`);
  const jobPath = join(dir, `${role}-job.json`);
  await writeFile(schemaPath, JSON.stringify(AGENT_SCHEMAS[role]), { mode: 0o600 });
  await writeFile(promptPath, structuredPrompt, { mode: 0o600 });
  await writeFile(resultPath, '', { mode: 0o600 });
  await rm(exitPath, { force: true });
  const args = agentArgv(role, { cwd, model: route.model, effort: route.effort, schemaPath, resultPath });
  const env = { CODEX_HOME: route.codexHome };
  let run;
  if (useCmux) {
    await writeFile(jobPath, JSON.stringify({ agentBin: AGENT_BIN, args, cwd, promptFile: promptPath, logFile: logPath, exitFile: exitPath, model: route.model, label: `${ticket.id} · ${role}`, env }), { mode: 0o600 });
    const surface = await ticketSurface(ticket, cwd, `node ${quote(CMUX_RUNNER)} ${quote(jobPath)}`, `${ticket.id} · ${role}`);
    run = await waitForSurface(surface, { exitPath, logPath, ticketId: ticket.id, role });
  } else {
    run = await processRun(AGENT_BIN, args, {
      cwd,
      input: structuredPrompt,
      timeout: CALL_MS,
      env,
      onLine: line => {
        try {
          const event = JSON.parse(line);
          if (event.type) void update(ticket.id, { detail: `${role} · ${event.type}` });
        } catch {}
      },
    });
    await writeFile(logPath, `${run.err}\n${run.out}`, { mode: 0o600 });
  }
  if (run.code !== 0 || run.timedOut) {
    if (useCmux) await appendFile(logPath, `\n${run.err ?? ''}\n`);
    throw new Error(run.timedOut
      ? run.err || `${role} exceeded its ${Math.round(CALL_MS / 60000)}-minute hard timeout`
      : `${(run.err ?? '').slice(-1500) || `${role} failed`}`);
  }
  const value = parseStructuredResult(await readFile(resultPath, 'utf8'));
  return { value, route, logPath };
}

// ---------------------------------------------------------------- test hashes
async function hashTests(cwd, files) {
  const result = {};
  for (const file of files) {
    try {
      result[file] = digest(await readFile(join(cwd, file)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return result;
}

async function assertTestsUnchanged(cwd, hashes) {
  for (const [file, hash] of Object.entries(hashes ?? {})) {
    let current;
    try {
      current = digest(await readFile(join(cwd, file)));
    } catch (error) {
      if (error?.code === 'ENOENT') throw Object.assign(new Error(`Frozen acceptance test is missing: ${file}`), { failureClass: 'implementation' });
      throw error;
    }
    if (current !== hash) throw Object.assign(new Error(`Implementation modified the frozen test baseline: ${file}`), { failureClass: 'implementation' });
  }
}

async function commit(cwd, message) {
  const files = await changedFiles(cwd, 'HEAD');
  if (!files.length) return undefined;
  await git(cwd, 'add', '--', ...files);
  await git(cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', message);
  return gitOptional(cwd, ['rev-parse', 'HEAD']);
}

async function runLoggedCommand(command, cwd, logName, dir, { failureClass = 'implementation' } = {}) {
  const run = await processRun(command[0], command.slice(1), { cwd, timeout: CHECK_MS });
  if (dir && logName) await writeFile(join(dir, logName), `${run.out}\n${run.err}`, { mode: 0o600 });
  if (run.code !== 0) {
    throw Object.assign(new Error(`${commandLabel(command)} failed: ${boundedText(run.err || run.out, { max: 1500 })}`), { failureClass });
  }
  return run;
}

// ---------------------------------------------------------------- phases
async function installDeps(cwd, dir) {
  const run = await processRun('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd, timeout: CHECK_MS });
  if (dir) await writeFile(join(dir, 'install.log'), `${run.out}\n${run.err}`, { mode: 0o600 });
  if (run.code !== 0) throw Object.assign(new Error(`Dependency install failed: ${boundedText(run.err, { max: 1500 })}`), { failureClass: 'bootstrap' });
  return run;
}

// Authorised lockfile reconciliation only: `--lockfile-only --ignore-scripts` may run
// when every manifest/lockfile involved is explicitly owned or explicitly shared.
async function reconcileLockfile(ticket, tree, dir) {
  const allowed = [...pathsFor(ticket), ...contracts.sharedPaths];
  const manifests = (await changedFiles(tree.path, state.integrationBranch).catch(() => [])).filter(isManifestPath);
  const verdict = canReconcileLockfile(manifests, allowed);
  if (!verdict.allowed) {
    await logEvent(ticket.id, `lockfile reconcile skipped (not authorised): ${verdict.offenders.join(', ') || 'no manifest inside ownership'}`);
    return false;
  }
  const run = await processRun('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: tree.path, timeout: CHECK_MS });
  await writeFile(join(dir, 'lockfile-reconcile.log'), `${run.out}\n${run.err}`, { mode: 0o600 });
  if (run.code !== 0) throw Object.assign(new Error(`Lockfile reconcile failed: ${boundedText(run.err, { max: 1500 })}`), { failureClass: 'bootstrap' });
  await validateChanges(tree.path, tree.base, [...allowed, 'pnpm-lock.yaml']);
  await logEvent(ticket.id, `lockfile reconciled for ${manifests.join(', ')}`);
  return true;
}

// Bootstrap after a rebase: install first, and only reconcile the lockfile when the
// frozen install fails and the manifests are explicitly allowed.
async function bootstrapAfterRebase(ticket, record, tree, dir) {
  const run = await processRun('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: tree.path, timeout: CHECK_MS });
  if (dir) await writeFile(join(dir, 'install.log'), `${run.out}\n${run.err}`, { mode: 0o600 });
  if (run.code === 0) return;
  const reconciled = await reconcileLockfile(ticket, tree, dir);
  if (reconciled) {
    await installDeps(tree.path, dir);
    return;
  }
  throw Object.assign(new Error(`Dependency install failed after rebase: ${boundedText(run.err, { max: 1500 })}`), { failureClass: 'bootstrap' });
}

async function testPhase(ticket, record, tree, dir) {
  const paths = pathsFor(ticket);
  const existing = await changedFiles(tree.path, tree.base);
  const policy = testPolicy({ hasCandidate: existing.length > 0 || Boolean(record.approvedHead) });
  const prompt = `Author the smallest meaningful automated acceptance oracle for this ticket.
Ticket: ${JSON.stringify({ id: ticket.id, path: ticket.path, accept: ticket.accept })}.
${findingsPrompt(record.findings ?? [], {})}
You may create or edit only test/spec files, fixture directories, or scripts named check/test/smoke inside these owned paths: ${JSON.stringify(paths)}. Never edit production code.
Return the exact safe argv test command (heads ${JSON.stringify(['pnpm', 'node', 'swift'])} only) that verifies the acceptance criteria.
${policy.requiresRed
    ? 'There is no implementation yet: the oracle must fail now because the required behavior is missing, not because of syntax, setup, imports or placeholders.'
    : 'A retained candidate implementation is already present: the oracle must pass against it. Do not require red, do not weaken, rewrite or delete production code, and do not silently freeze unrelated test files.'}
Do not create random placeholder test files. If this ticket is genuinely not automatable, return not_applicable with concrete evidence.`;
  const { value } = await agentCall(ticket, record, 'test', tree.path, prompt, dir);
  if (value.outcome === 'blocked') throw new Error(value.summary);
  if (value.outcome === 'not_applicable') {
    const existingTests = (await changedFiles(tree.path, tree.base)).filter(file => testFilePath(file) && isPathAllowed(file, paths));
    if (policy.freezeExistingOnNotApplicable && existingTests.length) {
      record.testFiles = existingTests;
      record.testHashes = await hashTests(tree.path, existingTests);
      record.testCommand = validCommand(value.testCommand) ? value.testCommand : [];
      record.testEvidence = value.evidence;
      record.testFrozenBy = 'test:retained-fallback';
      await logEvent(ticket.id, 'oracle not_applicable: retained candidate test files frozen (documented fallback)');
      return;
    }
    record.testFiles = [];
    record.testCommand = [];
    record.testHashes = {};
    record.testEvidence = value.evidence;
    record.testFrozenBy = 'test:none';
    await logEvent(ticket.id, 'oracle not_applicable with evidence; no test frozen');
    return;
  }
  if (!validCommand(value.testCommand)) throw Object.assign(new Error('Test author returned an unsafe or invalid test command'), { failureClass: 'implementation' });
  const authored = await changedFiles(tree.path, 'HEAD');
  const bad = authored.filter(file => !testFilePath(file) || !isPathAllowed(file, paths));
  if (bad.length) throw Object.assign(new Error(`Test phase changed a non-test path: ${bad.join(', ')}`), { failureClass: 'implementation' });
  const files = authored.length ? authored : (value.testFiles ?? []).filter(file => testFilePath(file) && isPathAllowed(file, paths));
  if (!files.length) throw new Error('Test author created no test file and declared none');
  for (const file of files.filter(name => /\.(m|c)?jsx?$/.test(name))) {
    const source = await readFile(join(tree.path, file), 'utf8');
    if (!looksLikeAssertions(source)) throw Object.assign(new Error(`Test oracle ${file} contains no assertions`), { failureClass: 'oracle' });
  }
  const run = await processRun(value.testCommand[0], value.testCommand.slice(1), { cwd: tree.path, timeout: CHECK_MS });
  await writeFile(join(dir, policy.requiresRed ? 'red-test.log' : 'candidate-test.log'), `${run.out}\n${run.err}`, { mode: 0o600 });
  if (policy.requiresRed && run.code === 0) throw Object.assign(new Error('New acceptance test passed before implementation'), { failureClass: 'implementation' });
  record.testFiles = files;
  record.testCommand = value.testCommand;
  record.testHashes = await hashTests(tree.path, files);
  record.testEvidence = value.evidence;
  record.testFrozenBy = 'test';
  await commit(tree.path, `test(${ticket.id}): add acceptance oracle`);
  await logEvent(ticket.id, `oracle frozen: ${files.length} file(s), ${policy.requiresRed ? 'red baseline' : 'retained candidate'}`);
}

async function implementPhase(ticket, record, tree, dir, { sharedRepair = false } = {}) {
  const owned = pathsFor(ticket);
  const paths = sharedRepair ? [...new Set([...owned, ...contracts.sharedPaths])] : owned;
  const open = openBlocking(record.findings ?? []);
  const before = await git(tree.path, 'rev-parse', 'HEAD');
  const prompt = `Implement or repair this ticket in the retained candidate.
Ticket: ${JSON.stringify({ id: ticket.id, path: ticket.path, accept: ticket.accept, ownedPaths: owned })}.
${findingsPrompt(open, { head: before })}
Every open blocker above is authoritative, including its full description; address all of them in one pass.
Evidence logs from previous attempts (read them before editing): ${JSON.stringify(await artifactPaths(dir))}.
Frozen acceptance tests (never modify, weaken, rename or delete): ${JSON.stringify(record.testFiles ?? [])}.
Frozen test command: ${JSON.stringify(record.testCommand?.length ? record.testCommand : CHECK_COMMANDS[1])}.
${sharedRepair ? `This repair may additionally touch the explicitly shared paths ${JSON.stringify(contracts.sharedPaths)}; execution is serialized while shared paths are in play. Do not touch anything else.` : ''}
Last failure summary: ${JSON.stringify(record.lastFailure ?? 'none')}.
Inspect only owned/changed files; do not read the broad implementation plan. Allowed paths: ${JSON.stringify(paths)}.
Run focused checks, then return one concrete evidence item per acceptance criterion.
Do not commit, push, edit loop/backlog files, create agents, launch GUI apps, or request user input.`;
  const { value } = await agentCall(ticket, record, 'worker', tree.path, prompt, dir);
  if (value.outcome !== 'completed') throw Object.assign(new Error(value.summary), { failureClass: 'implementation' });
  if (value.evidence.length < ticket.accept.length) throw Object.assign(new Error('Implementation omitted acceptance evidence'), { failureClass: 'implementation' });
  tree.base = await git(root, 'merge-base', state.integrationBranch, tree.branch);
  await assertTestsUnchanged(tree.path, record.testHashes);
  await validateChanges(tree.path, tree.base, paths);
  if (record.testCommand?.length) await runLoggedCommand(record.testCommand, tree.path, 'green-test.log', dir);
  await writeFile(join(dir, 'evidence.log'), `${value.evidence.join('\n')}\n`, { mode: 0o600 });
  await commit(tree.path, `feat(${ticket.id}): ${String(value.summary ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
  const after = await git(tree.path, 'rev-parse', 'HEAD');
  if (before === after && open.length) {
    throw Object.assign(new Error('Repair produced no new commit for the open findings'), { failureClass: 'implementation', noProgress: true });
  }
  record.workerEvidence = value.evidence;
  record.workerRisks = value.risks ?? [];
  record.repairPending = false;
  record.sharedRepair = false;
}

// An oracle objection reroutes here: the independent test role may repair ONLY the
// frozen tests. Original hashes/evidence are archived; the implementer is never
// allowed to weaken its own oracle.
async function oracleRepairPhase(ticket, record, tree, dir) {
  const paths = pathsFor(ticket);
  const before = await git(tree.path, 'rev-parse', 'HEAD');
  const blockers = openBlocking(record.findings ?? []).filter(finding => finding.category === 'oracle');
  const prompt = `Independent oracle repair. You are the test role; the implementer must never repair its own acceptance oracle.
${findingsPrompt(blockers, { head: before })}
Repair ONLY the frozen acceptance tests. You may edit test/spec files, fixture directories or scripts named check/test/smoke inside these owned paths: ${JSON.stringify(paths)}. Do not edit production code, and never weaken or delete assertions merely to make the suite pass.
A retained candidate implementation exists, so the repaired oracle is expected to pass against it. Do not require red.
Validate the oracle itself: a defect may be syntax, setup/imports, a placeholder, or a tautology that asserts nothing meaningful. If the original test was invalid, replace it and explain why in evidence; otherwise fix only the defect the reviewer described.
Archived original hashes (informational; the loop keeps them): ${JSON.stringify(record.testHashes ?? {})}.
Return the exact safe argv test command and the files you changed.`;
  const { value } = await agentCall(ticket, record, 'test', tree.path, prompt, dir);
  if (value.outcome !== 'completed') throw Object.assign(new Error(value.summary || 'oracle repair declined'), { failureClass: 'oracle', phase: 'oracle-repair' });
  if (!validCommand(value.testCommand)) throw Object.assign(new Error('Oracle repair returned an unsafe or invalid test command'), { failureClass: 'oracle', phase: 'oracle-repair' });
  const changed = await changedFiles(tree.path, before);
  const bad = changed.filter(file => !testFilePath(file) || !isPathAllowed(file, paths));
  if (bad.length) throw Object.assign(new Error(`Oracle repair touched a non-test path: ${bad.join(', ')}`), { failureClass: 'oracle', phase: 'oracle-repair' });
  for (const file of changed.filter(name => /\.(m|c)?jsx?$/.test(name))) {
    const source = await readFile(join(tree.path, file), 'utf8');
    if (!looksLikeAssertions(source)) throw Object.assign(new Error(`Repaired oracle ${file} contains no assertions`), { failureClass: 'oracle', phase: 'oracle-repair' });
  }
  const run = await processRun(value.testCommand[0], value.testCommand.slice(1), { cwd: tree.path, timeout: CHECK_MS });
  await writeFile(join(dir, 'oracle-repair.log'), `${run.out}\n${run.err}`, { mode: 0o600 });
  if (run.code !== 0) throw Object.assign(new Error(`Repaired oracle still fails on the retained candidate: ${boundedText(run.err || run.out, { max: 1500 })}`), { failureClass: 'oracle', phase: 'oracle-repair' });
  record.testHashHistory = [...(record.testHashHistory ?? []), { at: nowIso(), reason: 'oracle-repair', hashes: record.testHashes ?? {} }].slice(-MAX_TEST_HASH_HISTORY);
  record.oracleRepairEvidence = [...(record.oracleRepairEvidence ?? []), ...(value.evidence ?? [])].slice(-16);
  const candidates = [...new Set([...(record.testFiles ?? []), ...changed, ...(value.testFiles ?? []).filter(file => testFilePath(file) && isPathAllowed(file, paths))])];
  const existing = [];
  for (const file of candidates) {
    try {
      await stat(join(tree.path, file));
      existing.push(file);
    } catch {}
  }
  if (changed.length) await commit(tree.path, `test(${ticket.id}): repair acceptance oracle`);
  record.testFiles = existing;
  record.testCommand = value.testCommand;
  record.testHashes = await hashTests(tree.path, existing);
  record.testFrozenBy = 'test:repair';
  record.testEvidence = [...(record.testEvidence ?? []), ...(value.evidence ?? [])].slice(-16);
  record.oracleRepairs = (record.oracleRepairs ?? 0) + 1;
  record.repairPending = false;
  record.phase = 'checks';
  await logEvent(ticket.id, `oracle repaired by the independent test role (${existing.length} frozen file(s), originals archived)`);
}

async function mergeRepairPhase(ticket, record, tree, dir, error) {
  const owned = pathsFor(ticket);
  const allowed = [...new Set([...owned, ...contracts.sharedPaths])];
  const prompt = `Conflict repair only: rebase this candidate branch onto ${state.integrationBranch} and resolve conflicts. Ticket ${ticket.id}.
Procedure: run \`git rebase ${state.integrationBranch}\` in this worktree, resolve each conflict, \`git add\` the resolved files, \`git rebase --continue\`, and finish with a clean working tree and no rebase in progress.
Allowed paths: owned ${JSON.stringify(owned)} plus explicitly shared ${JSON.stringify(contracts.sharedPaths)}. Touch nothing outside them, add no features, and do not weaken or delete the frozen acceptance tests ${JSON.stringify(record.testFiles ?? [])}.
Original rebase error: ${boundedText(String(error?.message ?? error), { max: 1500 })}.
Return evidence describing each resolved conflict.`;
  const { value } = await agentCall(ticket, record, 'worker', tree.path, prompt, dir);
  if (value.outcome !== 'completed') throw Object.assign(new Error(value.summary), { failureClass: 'merge', phase: 'merge-repair' });
  if (await gitOptional(tree.path, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'])) {
    const continued = await gitOptional(tree.path, ['-c', 'core.editor=true', 'rebase', '--continue']);
    if (continued === undefined) {
      await gitOptional(tree.path, ['rebase', '--abort']);
      throw Object.assign(new Error('Merge repair left an unfinished rebase'), { failureClass: 'merge', phase: 'merge-repair' });
    }
  }
  tree.base = await git(root, 'merge-base', state.integrationBranch, tree.branch);
  await assertTestsUnchanged(tree.path, record.testHashes);
  await validateChanges(tree.path, tree.base, allowed);
  await writeFile(join(dir, 'merge-repair.log'), `${(value.evidence ?? []).join('\n')}\n`, { mode: 0o600 });
  record.sharedRepair = true; // hold the conservative reservation while shared paths were in play
  record.workerEvidence = [...(record.workerEvidence ?? []), `merge-repair: ${summarizeFailure(value.summary)}`].slice(-8);
  await commit(tree.path, `chore(${ticket.id}): resolve rebase conflict onto ${state.integrationBranch}`);
  await logEvent(ticket.id, 'merge repair completed; retrying rebase');
}

async function rebaseWithRepair(ticket, record, tree, dir) {
  for (;;) {
    try {
      await git(tree.path, 'rebase', state.integrationBranch);
      return;
    } catch (error) {
      await gitOptional(tree.path, ['rebase', '--abort']);
      const budget = beginMergeRepair(record);
      if (!budget.allowed) {
        record.status = 'blocked';
        record.phase = 'review';
        record.detail = budget.reason;
        record.lastFailure = summarizeFailure(`Rebase onto ${state.integrationBranch} failed: ${error?.message ?? error}`);
        await save({ at: nowIso(), ticketId: ticket.id, message: `blocked: ${record.lastFailure}` });
        throw Object.assign(new Error(`Rebase failed and ${budget.reason}`), { failureClass: 'merge', phase: 'merge-repair', skipRecord: true });
      }
      record.mergeRepairs = budget.mergeRepairs;
      await update(ticket.id, { status: 'review', phase: 'merge-repair', detail: 'conflict repair in the retained candidate' }, 'merge repair dispatched');
      await mergeRepairPhase(ticket, record, tree, dir, error);
    }
  }
}

// ---------------------------------------------------------------- gates
let gatesModule;
async function loadGates() {
  if (gatesModule !== undefined) return gatesModule;
  try {
    gatesModule = await import('./loop-gates.mjs');
  } catch {
    gatesModule = null;
  }
  return gatesModule;
}

async function collectGateCommands(ticket, record, tree) {
  const changed = await changedFiles(tree.path, state.integrationBranch);
  const gates = await loadGates();
  if(typeof gates?.collectChecks !== 'function')throw Object.assign(new Error('Required validation module is unavailable'),{failureClass:'user'});
  const collected = normalizeCollectChecks(await gates.collectChecks(tree.path,{testCommand:record.testCommand??[],changedFiles:changed}));
  record.lastCoverage={...collected.coverage,missing:collected.missing,at:nowIso()};
  if(collected.missing.length)throw Object.assign(new Error(`Missing acceptance/build wiring: ${collected.missing.join('; ')}`),{failureClass:'implementation',phase:'implement'});
  const commands=collected.commands.map(command=>[...command]);
  for(const command of contracts.tickets?.[ticket.id]?.checks??[])if(!commands.some(c=>JSON.stringify(c)===JSON.stringify(command)))commands.push([...command]);
  if(!commands.length)throw Object.assign(new Error('No deterministic gates generated'),{failureClass:'user'});
  return commands;
}

async function gatePhase(ticket, record, tree, dir) {
  await bootstrapAfterRebase(ticket, record, tree, dir);
  const head = await git(tree.path, 'rev-parse', 'HEAD');
  await assertTestsUnchanged(tree.path, record.testHashes);
  await validateChanges(tree.path, tree.base, pathsFor(ticket));
  if (record.gateEvidence?.head === head && record.gateEvidence.base === tree.base && (record.gateEvidence.commands ?? []).length) {
    await logEvent(ticket.id, `deterministic checks reused at ${head.slice(0, 8)}`);
    return record.gateEvidence;
  }
  const commands = await collectGateCommands(ticket, record, tree);
  if (record.testCommand?.length) await runLoggedCommand(record.testCommand, tree.path, 'frozen-test.log', dir, { failureClass: 'implementation' });
  const ran = [];
  for (let index = 0; index < commands.length; index += 1) {
    await runLoggedCommand(commands[index], tree.path, `check-${index + 1}.log`, dir, { failureClass: 'implementation' });
    ran.push(commandLabel(commands[index]));
  }
  if(await git(tree.path,'rev-parse','HEAD')!==head || (await changedFiles(tree.path,'HEAD')).length)throw Object.assign(new Error('Checks changed candidate contents; repair before review'),{failureClass:'implementation'});
  await assertTestsUnchanged(tree.path,record.testHashes);
  record.gateEvidence = { head, base: tree.base, commands: ran, at: nowIso() };
  record.checkCommands = commands.map(command => [...command]);
  await logEvent(ticket.id, `gates passed at ${head.slice(0, 8)}: ${ran.join(' | ')}`);
  return record.gateEvidence;
}

// ---------------------------------------------------------------- review/integrate/publish
async function reviewPhase(ticket, record, tree, dir, { head, base }) {
  const artifacts = await artifactPaths(dir);
  const findings = record.findings ?? [];
  const prompt = `Independently review ONE ticket candidate. Ticket: ${JSON.stringify({ id: ticket.id, path: ticket.path, accept: ticket.accept, ownedPaths: pathsFor(ticket), nonBlocking: contracts.tickets?.[ticket.id]?.nonBlocking ?? [] })}.
Scope: (1) the acceptance criteria above, (2) the current diff ${base}..${head} in this worktree, (3) the prior findings below. Nothing else is in scope for approval.
Prior findings - explicitly verify every open blocking id against the current HEAD ${head} and list the ids that are now actually fixed in resolvedFindingIds:
${findings.length ? findings.map(finding => `- [${finding.id}] severity=${finding.severity} category=${finding.category} status=${finding.status}${finding.verifiedHead ? ` verifiedHead=${finding.verifiedHead}` : ''}\n  ${finding.description}`).join('\n') : '(none)'}
Evidence: \`git diff ${base}..${head}\`; frozen tests ${JSON.stringify(record.testFiles ?? [])} with archived hashes ${JSON.stringify(record.testHashes ?? {})}; log paths ${JSON.stringify(artifacts)} (red baseline, frozen test, checks, previous findings).
Confirm the production diff did not alter the frozen test baseline, and judge whether the tests are meaningful rather than tautological.
Classify anything unrelated to this ticket's acceptance criteria and this diff as category 'followup' (or 'shared' for a shared-path problem). Followups are recorded for later tickets and must NOT block approval. Keep blocking only real security/correctness defects inside the ticket's own scope: a correct ticket must not be blocked by unrelated architecture work.
Do not approve while any blocking finding (severity security/blocker/major) is still open, and never accept a weakened or rewritten test. Do not edit files.`;
  const { value } = await agentCall(ticket, record, 'reviewer', tree.path, prompt, dir);
  return value;
}

// Publication is a separate, resumable step: a failed push never reimplements or
// re-merges an already integrated ticket.
async function publishPhase(ticket, record, tree, dir) {
  const integratedHead = record.integratedHead ?? record.publication?.integratedHead;
  if (!integratedHead) throw Object.assign(new Error('Publication requested without a stored integratedHead'), { failureClass: 'merge', phase: 'publish' });
  if (!state.publish) {
    record.publication = { approvedHead: record.approvedHead, integratedHead, pushed: false, at: nowIso() };
    record.status = 'done';
    record.phase = 'done';
    record.commit = integratedHead;
    record.detail = 'accepted and integrated (publish disabled)';
    delete record.legacyVerification;
    await save({ at: nowIso(), ticketId: ticket.id, message: `done ${integratedHead.slice(0, 8)} (local integration; publish disabled)` });
    return;
  }
  const remote = await gitOptional(root, ['remote', 'get-url', 'origin']);
  const allowed = pushTargetAllowed(state.integrationBranch, remote);
  if (!allowed.ok) throw Object.assign(new Error(`Refusing to push: ${allowed.reason}`), { failureClass: 'auth', phase: 'publish' });
  const pushed = await processRun('git', ['push', 'origin', `HEAD:refs/heads/${state.integrationBranch}`], { cwd: root, timeout: 120_000 });
  if (pushed.code !== 0) {
    throw Object.assign(new Error(`Push failed (implementation stays merged; only publication retries): ${boundedText(pushed.err || pushed.out, { max: 1500 })}`), { failureClass: 'provider', phase: 'publish' });
  }
  record.publication = { approvedHead: record.approvedHead, integratedHead, pushed: true, at: nowIso() };
  record.status = 'done';
  record.phase = 'done';
  record.commit = integratedHead;
  record.detail = 'accepted and published';
  await save({ at: nowIso(), ticketId: ticket.id, message: `done ${integratedHead.slice(0, 8)} (published)` });
}

// Suppress the duplicate failure record when a caller already wrote a precise status.
function failureRecordSkipped(error) {
  return Boolean(error?.skipRecord);
}

async function integrate(ticket, record, tree, dir, plan) {
  integration = integration.then(async () => {
    await update(ticket.id, { status: 'review', phase: 'checks', detail: 'rebasing onto the integration branch' }, 'entered checks');
    await cleanRoot();
    if (!plan.skipRebase) await rebaseWithRepair(ticket, record, tree, dir);
    tree.base = await git(root, 'merge-base', state.integrationBranch, tree.branch);
    await gatePhase(ticket, record, tree, dir);
    const head = await git(tree.path, 'rev-parse', 'HEAD');
    const reviewRootHead = await git(root, 'rev-parse', 'HEAD');
    if (!(plan.skipReview && record.approvedHead === head)) {
      if (record.approvedHead && record.approvedHead !== head) {
        delete record.approvedHead;
        delete record.publication;
        await logEvent(ticket.id, 'candidate moved after approval; previous approval invalidated');
      }
      const review = await reviewPhase(ticket, record, tree, dir, { head, base: reviewRootHead });
      const decision = reviewDecision(record, review, { head, now: nowIso() });
      record.findings = decision.findings;
      record.reviewCount = (record.reviewCount ?? 0) + 1;
      if (decision.decision === 'approve') {
        record.approvedHead = head;
        record.approvedAt = nowIso();
        record.sharedRepair = false;
        record.repairPending = false;
        delete record.lastFailure;
        record.repairFingerprints = [];
        record.substantiveFailures = 0;
        await save({ at: nowIso(), ticketId: ticket.id, message: `approved ${head.slice(0, 8)} (${decision.findings.filter(finding => finding.status === 'verified').length} finding id(s) verified)` });
      } else {
        record.phase = decision.phase;
        record.sharedRepair = Boolean(decision.sharedRepair);
        record.repairPending = true;
        record.lastFailure = decision.short;
        await save({ at: nowIso(), ticketId: ticket.id, message: `review rejected: ${decision.short}` });
        throw Object.assign(new Error(`Review requested changes (${decision.blocking.map(finding => finding.id).join(', ') || 'unspecified'}): ${decision.short}`), {
          failureClass: decision.phase === 'oracle-repair' ? 'oracle' : 'review',
          phase: decision.phase,
          fingerprint: decision.fingerprint,
        });
      }
    }
    await assertTestsUnchanged(tree.path,record.testHashes);
    if((await changedFiles(tree.path,'HEAD')).length)throw Object.assign(new Error('Reviewer changed candidate files'),{failureClass:'user'});
    await cleanRoot();
    if (await git(root, 'rev-parse', 'HEAD') !== reviewRootHead) {
      throw Object.assign(new Error('Integration head changed during review; re-review required'), { failureClass: 'review', phase: 'integrate' });
    }
    if (await git(tree.path, 'rev-parse', 'HEAD') !== record.approvedHead) {
      throw Object.assign(new Error('Candidate changed after review; re-review required'), { failureClass: 'review', phase: 'integrate' });
    }
    await git(root, 'merge', '--ff-only', tree.branch);
    record.integratedHead = await git(root, 'rev-parse', 'HEAD');
    record.phase = 'publish';
    record.detail = 'merged; publishing';
    await save({ at: nowIso(), ticketId: ticket.id, message: `merged ${record.integratedHead.slice(0, 8)} (integratedHead stored before publication)` });
    await publishPhase(ticket, record, tree, dir);
  }).catch(async error => {
    if (failureRecordSkipped(error)) return;
    await recordFailure(ticket, record, error, { phase: record.phase });
  });
  return integration;
}

// ---------------------------------------------------------------- failure recovery
function requestStop(failureClass, reason) {
  if (stopping) return;
  stopping = true;
  stopReason = { failureClass, reason, at: nowIso() };
  console.error(`loop stopping (${failureClass}): ${reason}`);
}

function applyRecovery(record, plan) {
  if (plan.providerRetries !== undefined) {
    state.provider = { retries: plan.providerRetries, nextRetryAt: plan.retryAt ?? state.provider?.nextRetryAt ?? 0, updatedAt: nowIso() };
  }
  if (plan.substantiveFailures !== undefined) record.substantiveFailures = plan.substantiveFailures;
  if (plan.bootstrapRetries !== undefined) record.bootstrapRetries = plan.bootstrapRetries;
  if (plan.oracleRepairs !== undefined) record.oracleRepairs = plan.oracleRepairs;
  if (plan.mergeRepairs !== undefined) record.mergeRepairs = plan.mergeRepairs;
}

async function recordFailure(ticket, record, error, context = {}) {
  const message = boundedText(String(error?.message ?? error));
  const phase = context.phase ?? error?.phase ?? record.phase;
  const failureClass = error?.failureClass ?? context.failureClass ?? classifyFailure(message, { phase });
  const plan = recoveryPlan(failureClass, { ...record, providerRetries: state.provider?.retries ?? 0 }, { phase, now: Date.now(), reason: context.reason });
  applyRecovery(record, plan);
  record.failureClass = failureClass;
  record.lastFailure = summarizeFailure(message);
  if (plan.action === 'stop') {
    requestStop(failureClass, plan.reason ?? record.lastFailure);
    await save({ at: nowIso(), ticketId: ticket.id, message: `stopped: ${record.lastFailure}` });
    return plan;
  }
  if (plan.action === 'blocked') {
    record.status = 'blocked';
    record.phase = plan.phase ?? phase;
    record.detail = plan.reason ?? 'blocked';
  } else {
    record.status = 'ready';
    record.phase = plan.phase ?? phase;
    record.retryAt = plan.retryAt ?? 0;
    record.detail = plan.reason ?? 'repair queued';
    if (plan.action === 'repair') {
      const fingerprint = error?.fingerprint ?? repairFingerprint({ phase: record.phase, message });
      record.repairFingerprints = [...(record.repairFingerprints ?? []), fingerprint].slice(-8);
      record.repairPending = true;
      if (repetitionBlocked(record)) {
        record.status = 'blocked';
        record.detail = `repeated identical failure after ${record.repairFingerprints.length} recorded fingerprints; candidate retained`;
      } else if (context.head && isUnchangedRerun(record, context.head)) {
        record.status = 'blocked';
        record.detail = 'no-progress: candidate unchanged after a repair attempt';
      }
      record.repairHead = context.head ?? record.repairHead;
    }
  }
  await save({ at: nowIso(), ticketId: ticket.id, message: `${record.status}: ${record.lastFailure}` });
  return plan;
}

// ---------------------------------------------------------------- run loop
async function gatherFacts(record, tree, head) {
  const dirty = (await changedFiles(tree.path, 'HEAD')).length > 0;
  const hasCandidate = head !== tree.base || dirty || Boolean(record.approvedHead) || Boolean(record.workerEvidence?.length) || Boolean(Object.keys(record.testHashes ?? {}).length);
  const gateEvidenceCurrent = Boolean(record.gateEvidence?.head && record.gateEvidence.head === head && record.gateEvidence.base === tree.base && (record.gateEvidence.commands ?? []).length);
  const publicationMarker = Boolean(record.publication?.approvedHead && record.publication?.integratedHead);
  const publicationSatisfied = publicationMarker && (!state.publish || record.publication.pushed === true);
  return {
    hasCandidate,
    gateEvidenceCurrent,
    approvedHeadCurrent: Boolean(record.approvedHead && record.approvedHead === head),
    approvedHeadAncestor: await isAncestor(record.approvedHead, state.integrationBranch),
    publicationMarker,
    publicationSatisfied,
  };
}

async function runTicket(ticket) {
  const record = state.tickets[ticket.id];
  record.status = 'implementing';
  record.detail = 'preparing candidate';
  record.updatedAt = nowIso();
  await save({ at: nowIso(), ticketId: ticket.id, message: 'run started (candidate retained)' });
  const tree = await worktree(ticket);
  const dir = join(runRoot, `${ticket.id}-${record.runs + 1}`);
  record.runs += 1;
  await mkdir(dir, { recursive: true });
  try {
    const head = await git(tree.path, 'rev-parse', 'HEAD');
    const facts = await gatherFacts(record, tree, head);
    const plan = planTicket(record, facts);
    if (plan.action === 'done') {
      record.status = 'done';
      record.phase = 'done';
      record.commit = record.integratedHead ?? record.approvedHead;
      record.detail = 'reconciled: approved head merged and published';
      delete record.legacyVerification;
      await save({ at: nowIso(), ticketId: ticket.id, message: `done (verified) ${String(record.commit).slice(0, 8)}` });
      return;
    }
    if (plan.phase === 'publish') {
      await publishPhase(ticket, record, tree, dir);
      return;
    }
    // Dependencies are only needed before phases that run code in the candidate.
    await installDeps(tree.path, dir);
    if (plan.phase === 'oracle-repair') {
      const budget = beginOracleRepair(record);
      if (!budget.allowed) {
        record.status = 'blocked';
        record.phase = 'review';
        record.detail = budget.reason;
        await save({ at: nowIso(), ticketId: ticket.id, message: `blocked: ${budget.reason}` });
        return;
      }
      await update(ticket.id, { status: 'implementing', phase: 'oracle-repair', detail: 'independent oracle repair' }, 'oracle repair dispatched to the test role');
      await oracleRepairPhase(ticket, record, tree, dir);
    } else if (!facts.hasCandidate) {
      if (record.testFrozenBy !== 'test:none') await testPhase(ticket, record, tree, dir);
      await implementPhase(ticket, record, tree, dir);
    } else if (record.repairPending) {
      // A review rejection is pending: the worker must repair before any cached gate
      // evidence can be reused for a fresh review.
      await implementPhase(ticket, record, tree, dir, { sharedRepair: Boolean(record.sharedRepair) });
    } else if (!record.testCommand?.length && !['test:none', 'test:retained-fallback'].includes(record.testFrozenBy)) {
      // Retained candidate without a real oracle: author meaningful tests instead of
      // silently freezing whatever test files happen to be lying around.
      await testPhase(ticket, record, tree, dir);
      await implementPhase(ticket, record, tree, dir);
    } else if (plan.phase === 'implement') {
      const probe = await processRun(record.testCommand[0], record.testCommand.slice(1), { cwd: tree.path, timeout: CHECK_MS });
      await writeFile(join(dir, 'frozen-test.log'), `${probe.out}\n${probe.err}`, { mode: 0o600 });
      if (probe.code === 0) {
        await assertTestsUnchanged(tree.path, record.testHashes);
        await update(ticket.id, { phase: 'checks', detail: 'candidate retained; implementation phase skipped' }, 'candidate already green; skipping re-implementation');
      } else {
        await implementPhase(ticket, record, tree, dir, { sharedRepair: Boolean(record.sharedRepair) });
      }
    }
    await integrate(ticket, record, tree, dir, plan);
  } catch (error) {
    if (stopping) {
      await logEvent(ticket.id, `stopped: ${summarizeFailure(String(error?.message ?? error))}`);
    } else {
      await recordFailure(ticket, record, error, { phase: record.phase, head: await gitOptional(tree.path, ['rev-parse', 'HEAD']) });
    }
  } finally {
    await releaseTicketSurface(ticket.id);
  }
}

function ticketConflict(a, b) {
  if (a.block === b.block) return true;
  return conflicts(pathsFor(a), pathsFor(b));
}

function readyBatch(tickets, active) {
  const done = new Set(Object.values(state.tickets).filter(record => record.status === 'done').map(record => record.id));
  const occupied = tickets.filter(ticket => active.has(ticket.id));
  const selected = [];
  for (const ticket of tickets) {
    const record = state.tickets[ticket.id];
    if (record.status !== 'ready' || (record.retryAt ?? 0) > Date.now() || !ticket.deps.every(dep => done.has(dep))) continue;
    const others = [...occupied, ...selected];
    if (record.sharedRepair) {
      // Conservative serialization only while explicitly shared paths are in play.
      if (others.length) continue;
    } else if (others.some(other => state.tickets[other.id]?.sharedRepair || ticketConflict(ticket, other))) {
      continue;
    }
    if (MAX_ACTIVE && active.size + selected.length >= MAX_ACTIVE) break;
    selected.push(ticket);
  }
  return selected;
}

async function loop(tickets) {
  state.running = true;
  await save();
  queueStatus();
  console.log(useCmux ? `Agent terminals: cmux workspace ${CMUX_WORKSPACE} (supervisor ${CMUX_SUPERVISOR})` : 'Agent terminals: direct subprocesses (default)');
  const active = new Map();
  try {
    while (!stopping) {
      // Provider rate/quota limits are a run-level cooldown, not a per-ticket retry.
      const providerWait = (state.provider?.nextRetryAt ?? 0) - Date.now();
      if (providerWait > 0 && !active.size) {
        console.log(`provider cooldown: waiting ${Math.round(providerWait / 1000)}s before dispatching more work`);
        await delay(Math.min(60_000, providerWait));
        continue;
      }
      const candidates = readyBatch(tickets, active);
      for (const ticket of candidates) {
        const job = runTicket(ticket).finally(() => active.delete(ticket.id));
        active.set(ticket.id, job);
      }
      if (active.size) {
        await Promise.race(active.values());
        continue;
      }
      if (tickets.every(ticket => state.tickets[ticket.id].status === 'done')) break;
      const retryTimes = tickets
        .map(ticket => state.tickets[ticket.id])
        .filter(record => record.status === 'ready' && (record.retryAt ?? 0) > Date.now())
        .map(record => record.retryAt);
      if (retryTimes.length) {
        await delay(Math.min(60_000, Math.max(500, Math.min(...retryTimes) - Date.now())));
        continue;
      }
      const remaining = tickets.filter(ticket => state.tickets[ticket.id].status !== 'done');
      console.log(`No runnable ticket left: ${remaining.map(ticket => `${ticket.id}:${state.tickets[ticket.id].status}`).join(', ')}`);
      break;
    }
  } finally {
    state.running = false;
    await save();
    await stopAgents();
    await stopChildren();
    await Promise.race([Promise.allSettled([...active.values()]), delay(10_000, { unref: true })]);
  }
  if (stopReason) {
    console.error(`run ended: ${stopReason.failureClass} - ${stopReason.reason}`);
    process.exitCode = 1;
  }
}

async function retryBlocked(tickets, ids) {
  const wanted = new Set(ids.filter(id => id && id !== '--'));
  const selected = tickets.filter(ticket => (!wanted.size || wanted.has(ticket.id)) && state.tickets[ticket.id]?.status === 'blocked');
  if (!selected.length) throw new Error(`No blocked tickets matched${wanted.size ? ` ${[...wanted].join(', ')}` : ''}`);
  for (const ticket of selected) {
    const record = state.tickets[ticket.id];
    const blockers = openBlocking(record.findings ?? []);
    record.status = 'ready';
    record.phase = blockers.length
      ? (blockers.every(finding => finding.category === 'oracle') ? 'oracle-repair' : 'implement')
      : (record.testCommand?.length ? 'implement' : 'test');
    record.repairPending = blockers.length > 0;
    record.substantiveFailures = 0;
    record.transientFailures = 0;
    record.bootstrapRetries = 0;
    record.oracleRepairs = 0;
    record.mergeRepairs = 0;
    record.repairFingerprints = [];
    delete record.repairHead;
    record.retryAt = 0;
    record.detail = 'requeued after manual review (candidate and findings retained)';
    await save({ at: nowIso(), ticketId: ticket.id, message: 'manually requeued; retained candidate, findings and frozen tests' });
  }
  console.log(`Requeued ${selected.map(ticket => ticket.id).join(', ')}; no candidate files were discarded`);
}

async function markVerifiedDone(ticket, record) {
  record.status = 'done';
  record.phase = 'done';
  record.commit = record.integratedHead ?? record.approvedHead;
  record.detail = 'reconciled: approved head merged and published, evidence retained';
  await save({ at: nowIso(), ticketId: ticket.id, message: `done (verified) ${String(record.commit).slice(0, 8)}` });
}

// ---------------------------------------------------------------- initialize
async function initialize(tickets) {
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  const branch = await cleanRoot();
  let loaded;
  try {
    loaded = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Never reset corrupt state: an operator must decide what happens to it.
      throw new Error(`Refusing to start: ${statePath} exists but could not be parsed (${error?.message}). Move or repair it instead of resetting loop state.`);
    }
  }
  state = loaded ?? { version: 2, running: false, publish: true, integrationBranch: branch, updatedAt: nowIso(), tickets: {} };
  state.version = 2;
  state.integrationBranch = branch;
  state.provider = { retries: 0, nextRetryAt: 0, ...(state.provider ?? {}) };
  const rawContracts = await readFile(contractsPath, 'utf8').catch(error => {
    if (error?.code !== 'ENOENT') console.warn(`loop-contracts.json unreadable: ${error?.message}`);
    return undefined;
  });
  try {
    contracts = loadContracts(rawContracts ? JSON.parse(rawContracts) : undefined);
  } catch (error) {
    console.warn(`loop-contracts.json ignored: ${error?.message}`);
    contracts = emptyContracts();
  }
  const history = await integrationHistory(branch);
  for (const ticket of tickets) {
    let record = state.tickets[ticket.id];
    if (!record) {
      record = state.tickets[ticket.id] = freshRecord(ticket);
    } else {
      normalizeRecord(record, ticket);
    }
    if (['implementing', 'review'].includes(record.status)) {
      record.status = 'ready';
      record.phase = phaseFor(record);
      record.detail = 'recovered after runner restart (candidate retained)';
    }
    if (record.approvedHead) {
      const facts = {
        approvedHeadAncestor: await isAncestor(record.approvedHead, branch),
        publicationSatisfied: Boolean(record.publication?.approvedHead && record.publication?.integratedHead)
          && (!state.publish || record.publication.pushed === true),
      };
      const decision = doneDecision(record, facts);
      if (decision === 'verified') {
        if (record.status !== 'done') await markVerifiedDone(ticket, record);
        delete record.legacyVerification;
        continue;
      }
      if (decision === 'publish-pending') {
        if (record.status !== 'done') {
          record.status = 'ready';
          record.phase = 'publish';
          record.detail = 'publication pending; implementation already merged and will not be reimplemented';
        }
        continue;
      }
    }
    if (record.status === 'done') {
      // A done entry without approval evidence remains legacy metadata: the parent
      // audits it separately and the loop neither reruns nor re-verifies it.
      record.legacyVerification = 'unverified';
      continue;
    }
    const merged = history.get(ticket.id);
    if (merged) {
      record.legacyVerification = 'unverified';
      record.integrationHistory = { commit: merged[0], commits: merged.length, at: nowIso() };
      if (record.status !== 'blocked') {
        // feat(ID) titles are not proof of done: require an audit instead of rerunning.
        record.status = 'blocked';
        record.phase = 'review';
        record.detail = 'merged commit present without approval evidence; audit required before any rerun';
      }
    }
  }
  await save();
}

// ---------------------------------------------------------------- dashboard
function dashboard() {
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>EchoPilot</title><style>*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#e8edf7;font:14px system-ui;padding:24px}h1{font-size:24px;margin:0 0 6px}.sub{color:#8995aa;margin-bottom:22px}.board{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:14px}.col{background:#121a2b;border:1px solid #26334a;border-radius:14px;padding:12px;min-height:70vh}.col h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#91a0b8;margin:4px 4px 12px}.card{background:#182238;border:1px solid #30405d;border-radius:10px;padding:12px;margin:9px 0}.card b{font-size:15px}.card p{color:#aeb9cb;line-height:1.35;margin:7px 0 0}.card small{display:block;color:#6f809d;margin-top:8px}.done{border-color:#285b49}.review{border-color:#7a5c27}.blocked{border-color:#8a3434}@media(max-width:1100px){.board{grid-template-columns:1fr 1fr}}@media(max-width:520px){.board{grid-template-columns:1fr}}</style><h1>EchoPilot build</h1><div class="sub" id="summary">Loading…</div><main class="board" id="board"></main><script>const columns=[['ready','Ready'],['implementing','Implementing'],['review','Review'],['blocked','Blocked'],['done','Done']];async function draw(){const s=await fetch('/state').then(r=>r.json());summary.textContent=s.running?'Loop running · '+new Date(s.updatedAt).toLocaleTimeString():'Loop stopped';board.innerHTML=columns.map(([key,title])=>'<section class="col"><h2>'+title+'</h2>'+Object.values(s.tickets).filter(t=>t.status===key).map(t=>'<article class="card '+key+'"><b>'+t.id+'</b><p>'+escape(t.detail||t.path)+'</p><small>'+(t.model?t.model+' · '+t.effort:'waiting for dependencies')+'</small></article>').join('')+'</section>').join('')}function escape(x){const d=document.createElement('div');d.textContent=x;return d.innerHTML}draw();setInterval(draw,1500)</script>`;
}

function serve() {
  const server = createServer((req, res) => {
    if (req.url === '/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(state));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(dashboard());
  });
  // The dashboard is presentation only: a busy or forbidden port must never take
  // the loop down with it.
  server.on('error', error => {
    console.error(`dashboard disabled: cannot listen on 127.0.0.1:${PORT} (${error?.code ?? error?.message})`);
  });
  server.once('listening', () => {
    const address = server.address();
    console.log(`EchoPilot lean loop: http://127.0.0.1:${typeof address === 'object' && address ? address.port : PORT}`);
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

// ---------------------------------------------------------------- entry points
async function selfTest() {
  const invariants = [
    routeFor('worker').model === 'deepseek-flash' && routeFor('worker').effort === 'max',
    routeFor('worker').codexHome === '/Users/sobhi/.codex-deepseek-worker',
    routeFor('reviewer').model === 'gpt-5.6-sol' && routeFor('reviewer').effort === 'high',
    routeFor('reviewer').codexHome === '/Users/sobhi/.codex',
    routeFor('reviewer', { LOOP_CODEX_HOME: '/tmp/deepseek-home' }).codexHome === '/Users/sobhi/.codex',
    integratedTicketTitle('a5b57cd\tfeat(F01): done')?.id === 'F01',
    !integratedTicketTitle('a5b57cd\ttest(F01): red baseline'),
    doneDecision({ approvedHead: 'x' }, { approvedHeadAncestor: true, publicationSatisfied: true }) === 'legacy-unverified',
  ];
  if (invariants.some(value => !value)) throw new Error('loop self-test failed');
  const { findings } = mergeFindings([], [makeFinding({ description: 'x'.repeat(9000) })]);
  if (findings[0].description.length !== 9000) throw new Error('durable findings were truncated');
  console.log('loop self-test passed (policy invariants; full suite: node --test scripts/loop-policy.test.mjs)');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const tickets = JSON.parse(await readFile(join(root, 'BACKLOG.json'), 'utf8')).tickets;
  if (process.argv.includes('--dry-run')) {
    const routes = ['worker', 'test', 'reviewer'].map(role => {
      const route = routeFor(role);
      const approval = approvalFlags(role, { env: process.env });
      return { role, model: route.model, effort: route.effort, codexHome: route.codexHome, sandbox: approval.sandbox, approvalPolicy: approval.approvalPolicy, approveForMe: approval.approveForMe };
    });
    console.table(routes);
    console.table(tickets.map(ticket => ({ id: ticket.id, deps: ticket.deps.join(','), ownedPaths: pathsFor(ticket).join(' ') })));
    return;
  }
  if (TERMINALS === 'cmux' && (!CMUX_WORKSPACE || !CMUX_SUPERVISOR)) {
    throw new Error('LOOP_TERMINALS=cmux requires a loop launched from a cmux terminal (CMUX_WORKSPACE_ID and CMUX_SURFACE_ID are missing)');
  }
  await acquireRunnerLock();
  try {
    const available = await processRun(AGENT_BIN, ['--version'], { timeout: 15_000 });
    if (available.code !== 0) throw new Error(`Agent CLI is unavailable: ${AGENT_BIN}`);
    await initialize(tickets);
    if (process.argv.includes('--initialize-only')) {
      const records = Object.values(state.tickets);
      const done = records.filter(record => record.status === 'done');
      const verified = done.filter(record => !record.legacyVerification).length;
      console.log(`Initialized ${tickets.length} tickets: ${done.length} done (${verified} verified, ${done.length - verified} legacy-unverified), ${tickets.length - done.length} remaining`);
      for (const record of done) console.log(`${record.id} ${record.commit}${record.legacyVerification ? ` [${record.legacyVerification}]` : ''}`);
      return;
    }
    const retryIndex = process.argv.indexOf('--retry-blocked');
    if (retryIndex >= 0) {
      await retryBlocked(tickets, process.argv.slice(retryIndex + 1));
      return;
    }
    const server = serve();
    const shutdown = () => {
      stopping = true;
      try {
        server.close();
      } catch {}
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await loop(tickets);
    try {
      server.close();
    } catch {}
  } finally {
    await releaseRunnerLock();
  }
}

// Only run when invoked as a script: importing this module (tests, tooling) must
// never start agents or touch runtime state.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

export { main };
