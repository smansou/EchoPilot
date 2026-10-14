#!/usr/bin/env node
// General task-execution wrapper for the EchoPilot progress board.
//
//   node scripts/progress-task.mjs --id ID --phase implement|verify -- COMMAND [ARGS...]
//
// The wrapper records the run lifecycle (start/end, exit code, phase, PID) into the
// progress state file, executes the child with inherited stdio (the caller redirects
// the worker transcript itself — this wrapper never captures or stores logs), and maps
// the outcome onto the board:
//
//   implement exit 0     -> review    (never verified automatically)
//   implement exit != 0  -> blocked
//   verify exit 0        -> verified  (for this specific task only)
//   verify exit != 0     -> blocked
//   signal / interruption-> review + interrupted lifecycle (never "running")
//
// Every state mutation runs under one short-lived, state-file-global lock in the OS
// temp directory (never held while a child task executes), so concurrent wrappers for
// different tasks cannot clobber each other's read/modify/rename. The lock carries an
// owner nonce, and releasing only ever deletes the lock this process acquired. The
// recorded running PID still prevents duplicate concurrent runs of the same task; a
// stale lock or dead PID is reconciled, not trusted.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STATE_FILE,
  PHASES,
  isProcessAlive,
  isValidTaskId,
  readState,
  reconcileTask,
  writeStateAtomic,
} from './progress-board.mjs';

class UsageError extends Error {}

function usage() {
  return 'usage: node scripts/progress-task.mjs --id ID --phase implement|verify -- COMMAND [ARGS...]';
}

export function parseArgs(argv) {
  const parsed = { id: null, phase: null, command: null };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--') {
      parsed.command = argv.slice(index + 1);
      break;
    }
    if (token === '--id') {
      parsed.id = argv[index + 1];
      index += 2;
      continue;
    }
    if (token === '--phase') {
      parsed.phase = argv[index + 1];
      index += 2;
      continue;
    }
    throw new UsageError(`unexpected argument ${JSON.stringify(token)}\n${usage()}`);
  }
  if (!isValidTaskId(parsed.id)) {
    throw new UsageError(`--id must be a lowercase id of letters, digits and hyphens (max 64)\n${usage()}`);
  }
  if (!PHASES.includes(parsed.phase)) {
    throw new UsageError(`--phase must be implement or verify\n${usage()}`);
  }
  if (!Array.isArray(parsed.command) || parsed.command.length === 0) {
    throw new UsageError(`a command is required after --\n${usage()}`);
  }
  return parsed;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stateLockDir(stateFile) {
  const hash = crypto.createHash('sha1').update(path.resolve(stateFile)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `echopilot-progress-${hash}.lock`);
}

// The lock acquisition currently held by this process, if any. The exit handler
// releases only this exact acquisition, so a late process exit can never delete a
// lock that another wrapper acquired after we released ours.
let heldLock = null;

function withStateLock(stateFile, fn) {
  heldLock = acquireRunLock(stateFile);
  try {
    return fn();
  } finally {
    releaseHeldLock();
  }
}

export function acquireRunLock(stateFile, timeoutMs = 8000) {
  const dir = stateLockDir(stateFile);
  const ownerFile = path.join(dir, 'owner.json');
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }));
      return { dir, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let stale = false;
    let rawOwner = null;
    try {
      rawOwner = fs.readFileSync(ownerFile, 'utf8');
      const owner = JSON.parse(rawOwner);
      stale = !isProcessAlive(owner.pid, owner.startedAt);
    } catch {
      try {
        stale = Date.now() - fs.statSync(dir).mtimeMs >= 2000;
      } catch {
        stale = true;
      }
    }
    if (stale) {
      try {
        // Only remove the lock if its owner record is unchanged since we read it, so
        // we never delete a lock another wrapper just re-acquired.
        let currentRaw = null;
        try {
          currentRaw = fs.readFileSync(ownerFile, 'utf8');
        } catch {
          // owner file vanished; the comparison below still only removes on a match
        }
        if (currentRaw === rawOwner) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // retry below
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`another progress run holds the state lock (${dir}); retry shortly`);
    }
    sleepSync(100);
  }
  throw new Error(`could not acquire the state lock (${dir})`);
}

// Only removes the lock while this process's nonce still owns it; a stale release can
// never delete a lock another wrapper acquired afterwards.
export function releaseRunLock(lock) {
  if (!lock) return;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock.dir, 'owner.json'), 'utf8'));
    if (owner.token !== lock.token) return;
  } catch {
    return;
  }
  try {
    fs.rmSync(lock.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function releaseHeldLock() {
  const lock = heldLock;
  heldLock = null;
  releaseRunLock(lock);
}

process.on('exit', releaseHeldLock);

export function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 1);
}

function runChild(command) {
  return new Promise((resolve) => {
    // On POSIX the task gets its own process group so an interrupt terminates the
    // task's descendants too, and never the runner's own group. Windows falls back
    // to plain child.kill.
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let forwardedSignal = null;
    let escalateTimer = null;
    let giveUpTimer = null;

    const clearTimers = () => {
      if (escalateTimer !== null) {
        clearTimeout(escalateTimer);
        escalateTimer = null;
      }
      if (giveUpTimer !== null) {
        clearTimeout(giveUpTimer);
        giveUpTimer = null;
      }
    };

    // Terminates the task's whole process group on POSIX; never the runner's group.
    const terminateTask = (signal) => {
      try {
        if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // fall through to a direct child kill
      }
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      resolve(result);
    };

    // Bound closures carry the actual signal name; Node signal handlers receive no
    // arguments, so registering the raw callback would lose the signal identity.
    const onSignal = (signal) => {
      if (settled) return;
      if (forwardedSignal !== null) {
        terminateTask('SIGKILL');
        process.exit(signalExitCode(signal));
      }
      forwardedSignal = signal;
      terminateTask(signal);
      escalateTimer = setTimeout(() => terminateTask('SIGKILL'), 5000);
      giveUpTimer = setTimeout(() => finish({ code: null, signal }), 8000);
      escalateTimer.unref();
      giveUpTimer.unref();
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    child.on('error', (error) => finish({ code: null, signal: null, spawnError: error }));
    child.on('exit', (code, signal) => finish({ code, signal: signal ?? forwardedSignal }));
  });
}

// Maps an execution outcome onto stage/lifecycle fields and persists it. Re-reads
// state under the global state lock so concurrent runs of other tasks are never
// clobbered.
export function recordOutcome({ stateFile, id, phase, outcome, now = () => new Date().toISOString() }) {
  return withStateLock(stateFile, () => {
    const state = readState(stateFile);
    const index = state.tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new Error(`task ${id} disappeared from progress state; refusing to guess`);
    const task = state.tasks[index];
    const interrupted = outcome.signal != null || outcome.spawnError != null;
    let stage = 'review';
    let status;
    let note;
    if (outcome.spawnError) {
      status = 'failed';
      note = `could not start command: ${outcome.spawnError.message}`;
    } else if (interrupted) {
      status = 'interrupted';
      note = `run interrupted (${outcome.signal}); not running, review required`;
    } else if (outcome.code === 0) {
      status = 'succeeded';
      if (phase === 'implement') {
        stage = 'review';
        note = 'implementation finished with exit 0; review required before any completion claim';
      } else {
        stage = 'verified';
        note = 'verification passed with exit 0 for this specific task';
      }
    } else {
      status = 'failed';
      stage = 'blocked';
      note = `${phase} failed with exit ${outcome.code}; blocked until resolved`;
    }
    const endedAt = now();
    state.tasks[index] = {
      ...task,
      stage,
      lifecycle: {
        status,
        phase,
        pid: task.lifecycle.pid,
        startedAt: task.lifecycle.startedAt,
        endedAt,
        exitCode: outcome.code ?? null,
        lastRunNote: note,
      },
    };
    state.progressUpdatedAt = endedAt;
    writeStateAtomic(stateFile, state);
    return { stage, status, exitCode: outcome.code ?? null };
  });
}

async function main() {
  const { id, phase, command } = parseArgs(process.argv.slice(2));
  const stateFile = process.env.PROGRESS_STATE_FILE || DEFAULT_STATE_FILE;

  const startedAt = new Date().toISOString();
  // Short transaction: read, reconcile, duplicate-check, record start, write. The
  // lock is released before the child task runs and is never held during execution.
  withStateLock(stateFile, () => {
    let state;
    try {
      state = readState(stateFile);
    } catch (error) {
      throw new Error(`cannot read progress state: ${error.message}`);
    }
    const index = state.tasks.findIndex((task) => task.id === id);
    if (index === -1) {
      throw new Error(`unknown task id ${JSON.stringify(id)}: the board only shows recorded tasks, add it to the seeded state first`);
    }
    let task = reconcileTask(state.tasks[index]);
    if (task.lifecycle.status === 'running' && isProcessAlive(task.lifecycle.pid, task.lifecycle.startedAt)) {
      throw new Error(`task ${id} is already running (pid ${task.lifecycle.pid}); refusing a duplicate concurrent run`);
    }
    task = {
      ...task,
      stage: phase === 'implement' ? 'in-progress' : 'review',
      lifecycle: { status: 'running', phase, pid: process.pid, startedAt, endedAt: null, exitCode: null, lastRunNote: null },
    };
    state.tasks[index] = task;
    state.progressUpdatedAt = startedAt;
    writeStateAtomic(stateFile, state);
  });
  process.stdout.write(`progress ${id} · ${phase} · running (pid ${process.pid})\n`);

  const outcome = await runChild(command);
  const result = recordOutcome({ stateFile, id, phase, outcome });
  let code;
  if (outcome.spawnError) code = 127;
  else if (outcome.signal != null) code = signalExitCode(outcome.signal);
  else code = outcome.code ?? 0;
  process.stdout.write(`progress ${id} · ${phase} · exit ${code} -> ${result.stage}\n`);
  process.exit(code);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
main().catch((error) => {
  process.stderr.write(`progress-task: ${error.message}\n`);
  process.exit(2);
});
}
