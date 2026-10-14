// Focused tests for the local progress board, wrapper, and their safety properties.
// Endpoints are exercised through the exported request handler; a loopback bind test
// skips only when the sandbox denies socket listens. Children are trivial node
// processes only; no GUI or full project gates are launched.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_STATE_BYTES,
  createProgressServer,
  getProcessStartMs,
  handleRequest,
  isProcessAlive,
  loadProjectedState,
  readState,
  validateState,
  writeStateAtomic,
} from './progress-board.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_CLI = path.join(ROOT, 'scripts', 'progress-task.mjs');
const HTML_FILE = path.join(ROOT, 'docs', 'progress-board.html');

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-board-test-'));
  return path.join(dir, 'progress-state.json');
}

function makeTask(overrides = {}) {
  return {
    id: 'sample-task',
    title: 'Sample task',
    stage: 'backlog',
    scope: 'Sample scope',
    evidence: 'None recorded yet',
    remaining: 'Something remains',
    caveat: '',
    lifecycle: { status: 'idle', phase: null, pid: null, startedAt: null, endedAt: null, exitCode: null, lastRunNote: null },
    ...overrides,
  };
}

function makeState(tasks = [makeTask()], overrides = {}) {
  return {
    appName: 'EchoPilot',
    releaseReady: false,
    releaseNote: 'EchoPilot is not release-ready.',
    progressUpdatedAt: '2020-01-02T03:04:05.000Z',
    tasks,
    ...overrides,
  };
}

function taskById(state, id) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  assert.ok(task, `task ${id} missing`);
  return task;
}

// Drives the real handler with a minimal ServerResponse stand-in.
function invoke(stateFile, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve) => {
    const result = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
        return this;
      },
      end(body) {
        if (typeof body === 'string') result.body += body;
        resolve(result);
      },
    };
    handleRequest({ method, url }, res, { stateFile, htmlFile: HTML_FILE });
  });
}

function nodeCode(code) {
  return [process.execPath, '-e', code];
}

function runWrapper(stateFile, args, timeout = 20000) {
  return spawnSync(process.execPath, [TASK_CLI, ...args], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, PROGRESS_STATE_FILE: stateFile },
  });
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

test('serves the board at / and only the two allowlisted GET endpoints', async () => {
  const stateFile = tmpStateFile();
  writeStateAtomic(stateFile, makeState());

  const root = await invoke(stateFile, { url: '/' });
  assert.equal(root.status, 200);
  assert.match(root.headers['Content-Type'], /^text\/html/);
  assert.match(root.body, /EchoPilot/);
  assert.match(root.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.equal(root.headers['Access-Control-Allow-Origin'], undefined);

  const rejects = ['/nope', '/api/other', '/api/progress/', '/package.json', '/../package.json', '/%2e%2e%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd'];
  for (const url of rejects) {
    const res = await invoke(stateFile, { url });
    assert.equal(res.status, 404, `expected 404 for ${url}`);
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
    assert.ok(!res.body.includes('echopilot'), `no repo content leaked for ${url}`);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await invoke(stateFile, { method, url: '/api/progress' });
    assert.equal(res.status, 405, `expected 405 for ${method}`);
    assert.equal(res.headers.Allow, 'GET');
  }
});

test('api returns a fresh whitelisted projection: no secrets, no invented progress time', async () => {
  const stateFile = tmpStateFile();
  writeStateAtomic(
    stateFile,
    makeState([
      makeTask({
        id: 'secret-holder',
        stage: 'review',
        caveat: 'Local evidence only',
        secret: 'sk-live-TOPSECRET',
        token: 'tok-abc-123',
        env: { API_KEY: 'also-secret' },
        rawLog: 'raw transcript line',
      }),
    ]),
  );
  const mtimeBefore = fs.statSync(stateFile).mtimeMs;
  const res = await invoke(stateFile, { url: '/api/progress' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.releaseReady, false);
  assert.match(body.releaseNote, /not release-ready/);
  assert.equal(body.progressUpdatedAt, '2020-01-02T03:04:05.000Z', 'freshness must come from recorded state, not the server clock');
  assert.equal(body.recordedTaskCount, 1);
  assert.equal(body.workerActive, false);
  assert.equal(body.percent, undefined);
  assert.equal(body.completion, undefined);
  for (const needle of ['TOPSECRET', 'tok-abc-123', 'also-secret', 'rawLog', 'raw transcript']) {
    assert.ok(!res.body.includes(needle), `response leaked ${needle}`);
  }
  assert.deepEqual(
    Object.keys(body.tasks[0]).sort(),
    ['caveat', 'evidence', 'id', 'lifecycle', 'remaining', 'scope', 'stage', 'title'],
  );
  assert.equal(body.tasks[0].stage, 'review');
  assert.equal(fs.statSync(stateFile).mtimeMs, mtimeBefore, 'server must not write state');
});

test('api errors truthfully on invalid, unknown, or oversized state', async () => {
  const cases = [
    [makeState([makeTask({ stage: 'done' })]), /unknown stage/],
    [makeState([makeTask()], { releaseReady: true }), /releaseReady/],
    [makeState([makeTask()], { releaseNote: '' }), /releaseNote/],
  ];
  for (const [state, pattern] of cases) {
    const stateFile = tmpStateFile();
    writeStateAtomic(stateFile, makeState());
    fs.writeFileSync(stateFile, JSON.stringify(state)); // raw write to bypass write-side validation
    const res = await invoke(stateFile, { url: '/api/progress' });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, pattern);
  }

  const junkFile = tmpStateFile();
  fs.writeFileSync(junkFile, '{ not json');
  const junkRes = await invoke(junkFile, { url: '/api/progress' });
  assert.equal(junkRes.status, 500);
  assert.match(JSON.parse(junkRes.body).error, /not valid JSON/);

  const bigFile = tmpStateFile();
  fs.writeFileSync(bigFile, `{"appName":"EchoPilot","padding":"${'x'.repeat(MAX_STATE_BYTES)}"}`);
  const bigRes = await invoke(bigFile, { url: '/api/progress' });
  assert.equal(bigRes.status, 500);
  assert.match(JSON.parse(bigRes.body).error, /exceeds/);
});

test('a dead recorded PID reconciles to interrupted/review, while a live one stays running', async () => {
  const stateFile = tmpStateFile();
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const deadPid = dead.pid;
  dead.kill('SIGKILL');
  await once(dead, 'exit');

  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    writeStateAtomic(
      stateFile,
      makeState([
        makeTask({
          id: 'stale-task',
          stage: 'in-progress',
          lifecycle: {
            status: 'running',
            phase: 'implement',
            pid: deadPid,
            startedAt: new Date(Date.now() - 60000).toISOString(),
            endedAt: null,
            exitCode: null,
            lastRunNote: null,
          },
        }),
        makeTask({
          id: 'live-task',
          stage: 'in-progress',
          lifecycle: {
            status: 'running',
            phase: 'implement',
            pid: live.pid,
            startedAt: new Date(Date.now() - 1000).toISOString(),
            endedAt: null,
            exitCode: null,
            lastRunNote: null,
          },
        }),
      ]),
    );
    const projected = loadProjectedState(stateFile);
    const stale = projected.tasks.find((task) => task.id === 'stale-task');
    assert.equal(stale.stage, 'review', 'a dead recorded run must return to review');
    assert.equal(stale.lifecycle.status, 'interrupted');
    assert.equal(stale.lifecycle.runningNow, false);
    assert.equal(stale.lifecycle.endedAt, null, 'no synthetic end time for an unwitnessed death');
    assert.match(stale.lifecycle.lastRunNote, /interrupted/);
    const liveTask = projected.tasks.find((task) => task.id === 'live-task');
    assert.equal(liveTask.stage, 'in-progress');
    assert.equal(liveTask.lifecycle.runningNow, true);
    assert.equal(projected.workerActive, true);
    assert.deepEqual(projected.activeTaskIds, ['live-task']);

    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(taskById(persisted, 'stale-task').lifecycle.status, 'running', 'projection must not rewrite the file');

    const api = JSON.parse((await invoke(stateFile, { url: '/api/progress' })).body);
    assert.equal(api.tasks.find((task) => task.id === 'stale-task').lifecycle.status, 'interrupted');
    assert.equal(api.workerActive, true);
  } finally {
    live.kill('SIGKILL');
    await once(live, 'exit').catch(() => {});
  }
});

test('wrapper maps outcomes: implement->review, verify pass->verified, failures->blocked', () => {
  const stateFile = tmpStateFile();
  writeStateAtomic(
    stateFile,
    makeState([
      makeTask({ id: 'impl-task' }),
      makeTask({ id: 'verify-task', stage: 'review' }),
      makeTask({ id: 'fail-verify', stage: 'review' }),
      makeTask({ id: 'fail-impl' }),
    ]),
  );

  const impl = runWrapper(stateFile, ['--id', 'impl-task', '--phase', 'implement', '--', ...nodeCode('process.exit(0)')]);
  assert.equal(impl.status, 0);
  let task = taskById(readState(stateFile), 'impl-task');
  assert.equal(task.stage, 'review', 'implement exit 0 must land in review, never verified');
  assert.equal(task.lifecycle.status, 'succeeded');
  assert.equal(task.lifecycle.exitCode, 0);
  assert.equal(task.lifecycle.pid, impl.pid);
  assert.ok(task.lifecycle.startedAt && task.lifecycle.endedAt);

  const verify = runWrapper(stateFile, ['--id', 'verify-task', '--phase', 'verify', '--', ...nodeCode('process.exit(0)')]);
  assert.equal(verify.status, 0);
  task = taskById(readState(stateFile), 'verify-task');
  assert.equal(task.stage, 'verified', 'verify exit 0 verifies that specific task');
  assert.equal(task.lifecycle.status, 'succeeded');

  const verifyFail = runWrapper(stateFile, ['--id', 'fail-verify', '--phase', 'verify', '--', ...nodeCode('process.exit(3)')]);
  assert.equal(verifyFail.status, 3, 'wrapper propagates the child exit code');
  task = taskById(readState(stateFile), 'fail-verify');
  assert.equal(task.stage, 'blocked');
  assert.equal(task.lifecycle.status, 'failed');
  assert.equal(task.lifecycle.exitCode, 3);

  const implFail = runWrapper(stateFile, ['--id', 'fail-impl', '--phase', 'implement', '--', ...nodeCode('process.exit(1)')]);
  assert.equal(implFail.status, 1);
  task = taskById(readState(stateFile), 'fail-impl');
  assert.equal(task.stage, 'blocked');
  assert.equal(task.lifecycle.exitCode, 1);
});

test('wrapper refuses unknown ids and duplicate concurrent runs, and interrupts cleanly', async () => {
  const stateFile = tmpStateFile();
  writeStateAtomic(stateFile, makeState([makeTask({ id: 'dupe-task', stage: 'in-progress' })]));

  const unknown = runWrapper(stateFile, ['--id', 'not-a-card', '--phase', 'implement', '--', ...nodeCode('process.exit(0)')]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown task/);

  const wrapper = spawn(
    process.execPath,
    [TASK_CLI, '--id', 'dupe-task', '--phase', 'implement', '--', process.execPath, '-e', 'setTimeout(() => process.exit(0), 30000)'],
    { env: { ...process.env, PROGRESS_STATE_FILE: stateFile }, stdio: 'ignore' },
  );
  await waitFor(() => readState(stateFile).tasks[0].lifecycle.status === 'running');

  const duplicate = runWrapper(stateFile, ['--id', 'dupe-task', '--phase', 'implement', '--', ...nodeCode('process.exit(0)')]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /already running|state lock/);

  wrapper.kill('SIGTERM');
  const [exitCode] = await once(wrapper, 'exit');
  assert.equal(exitCode, 143, 'interrupted wrapper exits with 128+SIGTERM');
  const task = taskById(readState(stateFile), 'dupe-task');
  assert.equal(task.lifecycle.status, 'interrupted');
  assert.equal(task.stage, 'review', 'an interrupted run returns to review, not running');
  assert.match(task.lifecycle.lastRunNote, /interrupted/);
});

test('two overlapping wrappers on different tasks preserve both outcomes under the global state lock', async () => {
  const stateFile = tmpStateFile();
  writeStateAtomic(stateFile, makeState([makeTask({ id: 'alpha-task' }), makeTask({ id: 'beta-task' })]));
  const wrappers = ['alpha-task', 'beta-task'].map((id) =>
    spawn(
      process.execPath,
      [TASK_CLI, '--id', id, '--phase', 'implement', '--', ...nodeCode('setTimeout(() => process.exit(0), 1500)')],
      { env: { ...process.env, PROGRESS_STATE_FILE: stateFile }, stdio: 'ignore' },
    ),
  );
  const exits = wrappers.map((wrapper) => once(wrapper, 'exit'));
  try {
    await waitFor(() => {
      const state = readState(stateFile);
      return ['alpha-task', 'beta-task'].every((id) => taskById(state, id).lifecycle.status === 'running');
    }, 8000);
    const [[codeA], [codeB]] = await Promise.all(exits);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);
    const state = readState(stateFile);
    for (const id of ['alpha-task', 'beta-task']) {
      const task = taskById(state, id);
      assert.equal(task.lifecycle.status, 'succeeded', `${id} must not be clobbered by the other run`);
      assert.equal(task.lifecycle.exitCode, 0);
      assert.equal(task.stage, 'review');
      assert.ok(task.lifecycle.startedAt && task.lifecycle.endedAt);
    }
  } finally {
    for (const wrapper of wrappers) {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    }
  }
});

test('wrapper terminates the task process group on signal without orphaning descendants', { skip: process.platform === 'win32' ? 'process-group semantics are POSIX-only' : false }, async () => {
  const stateFile = tmpStateFile();
  const markerFile = `${stateFile}.grandchild-pid`;
  writeStateAtomic(stateFile, makeState([makeTask({ id: 'group-task', stage: 'in-progress' })]));
  const childScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(markerFile)}, String(grandchild.pid));`,
    'setTimeout(() => {}, 60000);',
  ].join(' ');
  const wrapper = spawn(
    process.execPath,
    [TASK_CLI, '--id', 'group-task', '--phase', 'implement', '--', ...nodeCode(childScript)],
    { env: { ...process.env, PROGRESS_STATE_FILE: stateFile }, stdio: 'ignore' },
  );
  let grandchildPid = null;
  try {
    await waitFor(() => fs.existsSync(markerFile), 8000);
    grandchildPid = Number(fs.readFileSync(markerFile, 'utf8'));
    assert.ok(pidAlive(grandchildPid), 'the descendant runs before the interrupt');
    wrapper.kill('SIGTERM');
    const [exitCode] = await once(wrapper, 'exit');
    assert.equal(exitCode, 143);
    await waitFor(() => !pidAlive(grandchildPid), 8000);
    const task = taskById(readState(stateFile), 'group-task');
    assert.equal(task.lifecycle.status, 'interrupted');
    assert.equal(task.stage, 'review');
    assert.match(task.lifecycle.lastRunNote, /interrupted/);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    if (grandchildPid !== null && pidAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

test('wrapper forwards SIGINT through a correctly bound handler and classifies the run interrupted', async () => {
  const stateFile = tmpStateFile();
  writeStateAtomic(stateFile, makeState([makeTask({ id: 'sigint-task', stage: 'in-progress' })]));
  const wrapper = spawn(
    process.execPath,
    [TASK_CLI, '--id', 'sigint-task', '--phase', 'implement', '--', ...nodeCode('setTimeout(() => process.exit(0), 30000)')],
    { env: { ...process.env, PROGRESS_STATE_FILE: stateFile }, stdio: 'ignore' },
  );
  try {
    await waitFor(() => readState(stateFile).tasks[0].lifecycle.status === 'running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    wrapper.kill('SIGINT');
    const [exitCode] = await once(wrapper, 'exit');
    assert.equal(exitCode, 130, 'SIGINT maps to 128+2');
    const task = taskById(readState(stateFile), 'sigint-task');
    assert.equal(task.lifecycle.status, 'interrupted');
    assert.equal(task.stage, 'review');
    assert.match(task.lifecycle.lastRunNote, /interrupted/);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
  }
});

test('process probes are bounded and never throw: unknown PIDs are not alive', () => {
  assert.equal(isProcessAlive(999999999), false);
  assert.equal(getProcessStartMs(999999999), null);
});

test('wrapper reconciles a stale running record before starting a new run', () => {
  const stateFile = tmpStateFile();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  writeStateAtomic(
    stateFile,
    makeState([
      makeTask({
        id: 'stale-wrapper',
        stage: 'in-progress',
        lifecycle: {
          status: 'running',
          phase: 'implement',
          pid: dead.pid,
          startedAt: new Date(Date.now() - 3600000).toISOString(),
          endedAt: null,
          exitCode: null,
          lastRunNote: null,
        },
      }),
    ]),
  );
  const result = runWrapper(stateFile, ['--id', 'stale-wrapper', '--phase', 'implement', '--', ...nodeCode('process.exit(0)')]);
  assert.equal(result.status, 0);
  const task = taskById(readState(stateFile), 'stale-wrapper');
  assert.equal(task.stage, 'review');
  assert.equal(task.lifecycle.status, 'succeeded');
});

test('state validation rejects unknown stages, unknown statuses, duplicate and invalid ids', () => {
  assert.throws(() => validateState(makeState([makeTask({ stage: 'done' })])), /unknown stage/);
  assert.throws(
    () => validateState(makeState([makeTask({ lifecycle: { ...makeTask().lifecycle, status: 'live' } })])),
    /unknown lifecycle status/,
  );
  assert.throws(() => validateState(makeState([makeTask({ lifecycle: { ...makeTask().lifecycle, phase: 'ship' } })])), /unknown phase/);
  assert.throws(() => validateState(makeState([makeTask(), makeTask()])), /duplicate/);
  assert.throws(() => validateState(makeState([makeTask({ id: 'Bad Id' })])), /expected/i);
  assert.throws(() => validateState(makeState([makeTask()], { releaseReady: true })), /releaseReady/);
  assert.throws(() => validateState(makeState([makeTask()], { progressUpdatedAt: 'yesterday-ish' })), /ISO timestamp/);
  const tooMany = Array.from({ length: 201 }, (_, index) => makeTask({ id: `task-${index}` }));
  assert.throws(() => validateState(makeState(tooMany)), /exceeds/);
});

test('board HTML renders through textContent only and honours accessibility basics', () => {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(html));
  assert.ok(html.includes('textContent'));
  assert.ok(html.includes('prefers-reduced-motion'));
  assert.ok(html.includes('aria-pressed'));
  assert.ok(html.includes('aria-live'));
  assert.ok(html.includes('not release-ready'));
  assert.ok(html.includes('no tracked task running'));
  assert.ok(html.includes('tracked task active'));
  assert.ok(!/worker active/.test(html), 'the misleading worker-active label must be gone');
  assert.ok(!/Access-Control-Allow/i.test(html));
  assert.equal((html.match(/fetch\('\/api\/progress'/g) ?? []).length, 1);
});

test('server binds to loopback only (skipped when the sandbox denies listens)', async (t) => {
  const server = createProgressServer({ stateFile: tmpStateFile(), htmlFile: HTML_FILE });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    server.close();
    if (error.code === 'EPERM') {
      t.skip('sandbox denies loopback listen; handler tests above cover the endpoints');
      return;
    }
    throw error;
  }
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
