#!/usr/bin/env node
/**
 * Q04 release qualification CLI (IMPLEMENTATION_PLAN.md §4.4/§4.5; BACKLOG.json Q04).
 *
 *   node --import tsx scripts/release/qualify-release.mjs <leg> [options]
 *
 * Three legs, each writing a JSON report and failing closed with a `problem: <detail>` line and a
 * nonzero exit status:
 *
 *   adversarial --corpus <file> --report <file>
 *     Drives a gaze confirmation-bypass corpus (one synthesized case per attack, plus the
 *     legitimate-confirmation control) through the shipped confirmation gate in
 *     `packages/eval/src/release/gaze-harness.ts`, records what actually executed — measured from
 *     the AX bridge's write log, never from the attack's claim — and runs the repository
 *     adversarial suites (R03 routing corpus, S04 scoped execution, G02 gaze confirmation) with
 *     their real exit statuses. Exit 0 requires zero violations, every case matching its declared
 *     expectation, and every suite green. A missing or malformed corpus, an unknown attack, or a
 *     case whose declared expectation is violated fails the leg.
 *
 *   recovery --root <dir> --report <file>
 *     Owns a fixture install store under `--root` and recovers from the five required faults with
 *     the real code paths: a staged update that fails verification (and a crash at the journal
 *     stage) with rollback + `install.mjs verify`; a worker crash and the disk-quota spool shed
 *     from the accelerated replay; and a revoked microphone grant and a removed input device
 *     through the shipped voice session. Exit 0 requires exactly one recovered finding per fault
 *     and a store that verifies from a fresh process.
 *
 *   reliability --sessions <file> --report <file>
 *     Measures the §4.4 target — ≥99.5% crash-free over ≥1,000 sessions — from a beta session
 *     ledger `{ ledgerVersion, sessions: [{ sessionId, crashed }] }`. Prints
 *     `crash-free: <rate> over <n> sessions` when it passes and fails closed on a missing,
 *     unreadable or malformed ledger, an empty or duplicate session id, fewer than 1,000 sessions,
 *     or a rate below 0.995.
 *
 * The adversarial report is tied to the corpus bytes by sha256, so a report can never be detached
 * from the corpus it defended.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_CLI = join(REPO_ROOT, 'scripts', 'release', 'install.mjs');
const GAZE_HARNESS = join(REPO_ROOT, 'packages', 'eval', 'src', 'release', 'gaze-harness.ts');
const VOICE_HARNESS = join(REPO_ROOT, 'packages', 'eval', 'src', 'release', 'voice-harness.ts');
const ACCELERATED_REPLAY = join(REPO_ROOT, 'packages', 'eval', 'src', 'performance', 'accelerated-replay.ts');
const VERIFY_PACK = join(REPO_ROOT, 'scripts', 'release', 'verify-pack.mjs');

const CRASH_FREE_TARGET = 0.995;
const CRASH_FREE_MINIMUM_SESSIONS = 1000;
const REQUIRED_RECOVERY_DRILLS = Object.freeze([
  'update_failure',
  'worker_crash',
  'low_disk',
  'revoked_tcc',
  'device_removal',
]);

/** The repository suites the adversarial leg must run, with their real exit statuses. */
const ADVERSARIAL_SUITES = Object.freeze([
  { id: 'routing-cross-project', path: 'packages/routing/src/state/r03.acceptance.test.ts' },
  { id: 'desktop-scoped-execution', path: 'packages/desktop-tools/src/commands/s04.acceptance.test.ts' },
  { id: 'gaze-confirmation', path: 'packages/desktop-tools/src/gaze-actions/g02.acceptance.test.ts' },
]);

class UsageError extends Error {}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function problem(message, problems = []) {
  problems.push(message);
  console.error(`problem: ${message}`);
  return problems;
}

function runArgv(command, { cwd = REPO_ROOT, timeoutMs = 240_000 } = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: 'true' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function runInstall(args) {
  return runArgv([process.execPath, INSTALL_CLI, ...args]);
}

async function writeReport(reportPath, report, problems) {
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return true;
  } catch (error) {
    problem(`could not write the report to ${reportPath}: ${error instanceof Error ? error.message : String(error)}`, problems);
    return false;
  }
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new UsageError(`unexpected argument ${JSON.stringify(argument)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${argument} needs a value`);
    if (options.has(argument)) throw new UsageError(`${argument} was given more than once`);
    options.set(argument, value);
    index += 1;
  }
  return options;
}

async function waitFor(predicate, label, timeoutMs = 4_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 5);
    });
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ------------------------------------------------------------------ adversarial leg --------- */

function normaliseCorpusCase(raw, index) {
  const record = typeof raw === 'object' && raw !== null ? raw : {};
  const caseId = typeof record.caseId === 'string' && record.caseId.trim().length > 0 ? record.caseId : `case-${index}`;
  const attack = typeof record.attack === 'string' ? record.attack : null;
  const targetLabel = typeof record.targetLabel === 'string' && record.targetLabel.length > 0 ? record.targetLabel : null;
  const stepValue = typeof record.stepValue === 'string' && record.stepValue.length > 0 ? record.stepValue : null;
  const expect = typeof record.expect === 'object' && record.expect !== null ? record.expect : {};
  const expectExecuted = typeof expect.executed === 'boolean' ? expect.executed : null;
  const malformed = attack === null || targetLabel === null || stepValue === null || expectExecuted === null;
  return {
    caseId,
    kind: typeof record.kind === 'string' && record.kind.length > 0 ? record.kind : 'gaze_action',
    attack,
    effect: typeof record.effect === 'string' ? record.effect : 'external',
    targetLabel,
    stepValue,
    expectExecuted,
    malformed,
  };
}

async function adversarialLeg(options) {
  const problems = [];
  const corpusArgument = options.get('--corpus');
  const reportPath = options.get('--report');
  if (corpusArgument === undefined) problem('--corpus <file> is required for the adversarial leg', problems);
  if (reportPath === undefined) problem('--report <file> is required for the adversarial leg', problems);

  const report = {
    leg: 'adversarial',
    verdict: 'failed',
    corpus: { path: corpusArgument ?? null, sha256: null },
    violations: [],
    cases: [],
    suites: [],
  };

  if (corpusArgument !== undefined) {
    let bytes = null;
    try {
      bytes = await readFile(corpusArgument);
      report.corpus.sha256 = sha256Bytes(bytes);
    } catch (error) {
      problem(
        `the adversarial corpus ${corpusArgument} is missing or unreadable: `
          + `${error instanceof Error ? error.message : String(error)}`,
        problems,
      );
    }

    let corpus = null;
    if (bytes !== null) {
      try {
        corpus = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        problem(
          `the adversarial corpus ${corpusArgument} is not valid JSON: `
            + `${error instanceof Error ? error.message : String(error)}`,
          problems,
        );
      }
    }

    if (corpus !== null) {
      if (!Array.isArray(corpus?.cases) || corpus.cases.length === 0) {
        problem('the adversarial corpus must declare a non-empty cases[] array', problems);
      } else {
        const { KNOWN_GAZE_ATTACKS, runGazeCase } = await import(pathToFileURL(GAZE_HARNESS).href);
        const known = new Set(KNOWN_GAZE_ATTACKS);
        for (const [index, raw] of corpus.cases.entries()) {
          const spec = normaliseCorpusCase(raw, index);
          if (spec.malformed) {
            problem(
              `corpus case ${spec.caseId} is malformed: it needs caseId, attack, targetLabel, stepValue `
                + 'and expect.executed',
              problems,
            );
            report.violations.push({ caseId: spec.caseId, detail: 'malformed corpus case' });
            report.cases.push({
              caseId: spec.caseId,
              kind: spec.kind,
              attack: spec.attack ?? 'unknown',
              attempted: true,
              executed: false,
              reason: 'malformed_corpus_case',
            });
            continue;
          }
          if (!known.has(spec.attack)) {
            problem(`corpus case ${spec.caseId} names an unknown attack ${JSON.stringify(spec.attack)}`, problems);
            report.violations.push({ caseId: spec.caseId, detail: `unknown attack ${spec.attack}` });
            report.cases.push({
              caseId: spec.caseId,
              kind: spec.kind,
              attack: spec.attack,
              attempted: true,
              executed: false,
              reason: 'unknown_attack',
            });
            continue;
          }
          const outcome = await runGazeCase({
            caseId: spec.caseId,
            kind: spec.kind,
            attack: spec.attack,
            effect: spec.effect,
            targetLabel: spec.targetLabel,
            stepValue: spec.stepValue,
            expect: { executed: spec.expectExecuted },
          });
          report.cases.push({
            caseId: outcome.caseId,
            kind: outcome.kind,
            attack: outcome.attack,
            attempted: true,
            executed: outcome.executed,
            reason: outcome.reason,
            expected: spec.expectExecuted,
            matched: outcome.matched,
          });
          if (!outcome.matched || outcome.executed !== spec.expectExecuted) {
            report.violations.push({
              caseId: spec.caseId,
              detail: `attack ${spec.attack} executed=${outcome.executed} but the corpus declares `
                + `executed=${spec.expectExecuted} (gate said: ${outcome.reason})`,
            });
          }
        }
      }
    }
  }

  for (const suite of ADVERSARIAL_SUITES) {
    // The recorded argv stays portable: the report names the same command a human would run.
    const command = ['node', '--import', 'tsx', '--test', suite.path];
    const result = runArgv(command);
    report.suites.push({ id: suite.id, command, exitStatus: result.status ?? -1 });
    if (result.status !== 0) {
      problem(
        `the repository suite ${suite.path} must be green\n${outputOf(result).trim().slice(-1_500)}`,
        problems,
      );
    }
  }

  for (const violation of report.violations) {
    problem(
      `case ${violation.caseId} violated its declared expectation: ${violation.detail} — no unauthorized `
        + 'action or bypassed gaze confirmation may occur',
      problems,
    );
  }
  report.verdict = problems.length === 0 ? 'passed' : 'failed';
  if (reportPath !== undefined) await writeReport(reportPath, report, problems);
  if (problems.length === 0) {
    console.log(
      `adversarial: ${report.cases.length} corpus case(s) defended against ${report.suites.length} repository `
        + `suite(s); corpus sha256 ${report.corpus.sha256}`,
    );
    return 0;
  }
  return 1;
}

/* --------------------------------------------------------------------- recovery leg --------- */

async function writeFixturePack(workspace, name, { tamperManifest = false, marker = name } = {}) {
  const pack = join(workspace, name, 'pack');
  const files = [
    ['models/tts/weights.bin', `q04 fixture tts weights ${marker}\n`],
    ['models/voices/alba/tokens.bin', `q04 fixture voice alba tokens ${marker}\n`],
    ['models/voices/alba/config.json', '{"voice":"alba","sampleRate":24000}\n'],
    ['licenses/q04-fixture-tts-weights.txt', 'CC-BY-4.0 fixture license (q04 recovery drill)\n'],
    ['licenses/q04-fixture-voice-alba.txt', 'CC-BY-4.0 fixture license (q04 recovery drill)\n'],
  ];
  for (const [relativePath, text] of files) {
    const absolute = join(pack, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(text));
  }
  const { sha256Directory } = await import(pathToFileURL(VERIFY_PACK).href);
  const weights = await readFile(join(pack, 'models/tts/weights.bin'));
  const voiceRoot = join(pack, 'models/voices/alba');
  const voiceFiles = [];
  const stack = [voiceRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) voiceFiles.push(absolute);
    }
  }
  const voiceBytes = (await Promise.all(voiceFiles.map((file) => readFile(file)))).reduce(
    (total, buffer) => total + buffer.length,
    0,
  );
  const manifest = {
    manifestVersion: 1,
    generatedBy: 'q04 recovery drill fixture',
    outputFormat: { sampleRate: 24000, channels: 1, packetMs: 20 },
    offlineInstall: { requiresApiKey: false, runtimeDownloads: [] },
    assets: [
      {
        id: 'q04-fixture-tts-weights',
        kind: 'model',
        revision: 'fixture-2026-09',
        license: 'CC-BY-4.0',
        licenseFile: 'licenses/q04-fixture-tts-weights.txt',
        path: 'models/tts/weights.bin',
        bytes: weights.length,
        sha256: tamperManifest ? 'f'.repeat(64) : sha256Bytes(weights),
      },
      {
        id: 'q04-fixture-voice-alba',
        kind: 'voice',
        voiceId: 'alba',
        revision: 'fixture-2026-09',
        license: 'CC-BY-4.0',
        licenseFile: 'licenses/q04-fixture-voice-alba.txt',
        path: 'models/voices/alba',
        bytes: voiceBytes,
        sha256: await sha256Directory(voiceRoot),
      },
    ],
  };
  const manifestPath = join(workspace, name, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { pack, manifestPath };
}

async function drillUpdateFailure(workspace, root, problems) {
  const first = await writeFixturePack(workspace, 'update-1.0.0');
  const install = runInstall(['install', '--root', root, '--pack', first.pack, '--manifest', first.manifestPath, '--version', '1.0.0']);
  if (install.status !== 0 || !outputOf(install).includes('active: 1.0.0')) {
    throw new Error(`the baseline install of 1.0.0 did not commit\n${outputOf(install).trim().slice(-1_200)}`);
  }

  const tampered = await writeFixturePack(workspace, 'update-1.1.0-tampered', { tamperManifest: true });
  const failedUpdate = runInstall(['update', '--root', root, '--pack', tampered.pack, '--manifest', tampered.manifestPath, '--version', '1.1.0']);
  if (failedUpdate.status === 0 || !outputOf(failedUpdate).includes('problem:')) {
    throw new Error('a staged update whose bytes do not match its manifest must fail with a problem: line');
  }
  const afterFailure = runInstall(['verify', '--root', root]);
  if (afterFailure.status !== 0 || !outputOf(afterFailure).includes('active: 1.0.0')) {
    throw new Error('the failed update must leave the previous version active and verifiable');
  }

  const second = await writeFixturePack(workspace, 'update-1.1.0');
  const crash = runInstall(['update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath, '--version', '1.1.0', '--simulate-crash-after', 'journal']);
  if (crash.status === 0) throw new Error('the simulated crash must not report a successful update');
  await readFile(join(root, 'journal.json'), 'utf8').catch(() => {
    throw new Error('the crash-at-journal update must leave the journal for the retry to complete');
  });

  const retry = runInstall(['update', '--root', root, '--pack', second.pack, '--manifest', second.manifestPath, '--version', '1.1.0']);
  if (retry.status !== 0 || !outputOf(retry).includes('active: 1.1.0')) {
    throw new Error(`the retried update must commit 1.1.0\n${outputOf(retry).trim().slice(-1_200)}`);
  }
  const rollback = runInstall(['rollback', '--root', root]);
  if (rollback.status !== 0 || !outputOf(rollback).includes('active: 1.0.0')) {
    throw new Error(`the rollback must restore 1.0.0\n${outputOf(rollback).trim().slice(-1_200)}`);
  }
  const verify = runInstall(['verify', '--root', root]);
  if (verify.status !== 0 || !outputOf(verify).includes('verify: ok')) {
    throw new Error(`the rolled-back store must verify\n${outputOf(verify).trim().slice(-1_200)}`);
  }
  void problems;
  return 'a staged 1.1.0 update failed manifest verification with the previous 1.0.0 still active; a second '
    + 'staged update crashed at the journal stage; the retry committed 1.1.0; rollback restored 1.0.0 and '
    + 'verify reported verify: ok';
}

async function drillWorkerCrashAndDisk(replay) {
  const worker = replay.recovery.find((entry) => entry.scenario === 'worker_crash');
  if (replay.passed !== true || worker === undefined || worker.outcome !== 'recovered') {
    throw new Error(
      `the accelerated replay must recover from a worker crash (passed=${replay.passed}, `
        + `worker_crash=${JSON.stringify(worker ?? null)})`,
    );
  }
  if (replay.counters.spoolOverQuotaBytes !== 0 || replay.counters.spoolBytesHighWater > replay.counters.spoolQuotaBytes) {
    throw new Error('the spool must stay inside its quota while the disk-quota drill sheds');
  }
  const diskGaps = replay.gapsByReason.disk_quota;
  if (!(diskGaps > 0)) {
    throw new Error('the low-disk drill must shed ingestion as explicit disk_quota gaps');
  }
  return {
    worker: `accelerated replay worker_crash: ${worker.detail}`,
    disk: `spool reached ${replay.counters.spoolBytesHighWater} of ${replay.counters.spoolQuotaBytes} bytes and shed `
      + `${diskGaps} large-log record(s) as explicit disk_quota gaps; ${replay.counters.spoolOverQuotaBytes} bytes `
      + 'were offered past the quota',
  };
}

async function drillHostEvent(fault, problems) {
  const { createVoiceHarness } = await import(pathToFileURL(VOICE_HARNESS).href);
  const utterances = [`note this for the atlas project (${fault})`];
  const harness = createVoiceHarness({ permission: 'granted', utterances });
  await harness.session.start();
  await harness.pushFrames(24);
  await harness.waitForCommitted(1);
  if (!harness.captureActive()) throw new Error('the voice session must be capturing before the fault');

  if (fault === 'revoked_tcc') harness.emit({ type: 'permission_denied' });
  else harness.emit({ type: 'device_removed', deviceId: 'mic-builtin' });
  await waitFor(() => harness.session.status().input === 'closed', `${fault} to close capture`);
  const status = harness.session.status();
  const expectedCode = fault === 'revoked_tcc' ? 'mic_denied' : 'device_removed';
  if (status.error?.code !== expectedCode) {
    throw new Error(`the ${fault} fault must surface error ${expectedCode}; saw ${JSON.stringify(status.error)}`);
  }
  if (harness.captureActive()) throw new Error(`the ${fault} fault must stop capture`);
  const committedBefore = harness.transcriptTexts().length;
  await harness.pushFrames(24).catch(() => undefined);
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, 30);
  });
  if (harness.transcriptTexts().length !== committedBefore) {
    throw new Error(`the ${fault} fault must invalidate live evidence; further frames were committed`);
  }

  const fresh = createVoiceHarness({ permission: 'granted', utterances: [`resumed after ${fault}`] });
  await fresh.session.start();
  await fresh.pushFrames(24);
  await fresh.waitForCommitted(1);
  if (!fresh.transcriptTexts()[0]?.includes('resumed')) {
    throw new Error(`capture must resume with a fresh grant after ${fault}`);
  }
  void problems;
  return fault === 'revoked_tcc'
    ? 'revoking the microphone grant closed capture with mic_denied, committed nothing from 24 further '
      + 'frames, and a fresh grant resumed capture with a new session'
    : 'removing the input device closed capture with device_removed, discarded the in-flight utterance, and '
      + 'the device returning resumed capture with a new session';
}

async function recoveryLeg(options) {
  const problems = [];
  const root = options.get('--root');
  const reportPath = options.get('--report');
  if (root === undefined) problem('--root <dir> is required for the recovery leg', problems);
  if (reportPath === undefined) problem('--report <file> is required for the recovery leg', problems);

  const findings = new Map();
  if (root !== undefined) {
    const workspace = await mkdtemp(join(tmpdir(), 'q04-recovery-packs-'));
    try {
      try {
        findings.set('update_failure', {
          id: 'update_failure',
          outcome: 'recovered',
          detail: await drillUpdateFailure(workspace, root, problems),
        });
      } catch (error) {
        findings.set('update_failure', {
          id: 'update_failure',
          outcome: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      let replay = null;
      try {
        const { runAcceleratedReplay } = await import(pathToFileURL(ACCELERATED_REPLAY).href);
        replay = await runAcceleratedReplay();
      } catch (error) {
        for (const id of ['worker_crash', 'low_disk']) {
          findings.set(id, {
            id,
            outcome: 'failed',
            detail: `the accelerated replay did not complete: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (replay !== null) {
        try {
          const details = await drillWorkerCrashAndDisk(replay);
          findings.set('worker_crash', { id: 'worker_crash', outcome: 'recovered', detail: details.worker });
          findings.set('low_disk', { id: 'low_disk', outcome: 'recovered', detail: details.disk });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const worker = replay.recovery.find((entry) => entry.scenario === 'worker_crash');
          if (worker !== undefined && worker.outcome === 'recovered') {
            findings.set('worker_crash', { id: 'worker_crash', outcome: 'recovered', detail: worker.detail });
            findings.set('low_disk', { id: 'low_disk', outcome: 'failed', detail });
          } else {
            for (const id of ['worker_crash', 'low_disk']) {
              findings.set(id, { id, outcome: 'failed', detail });
            }
          }
        }
      }

      for (const fault of ['revoked_tcc', 'device_removal']) {
        try {
          findings.set(fault, { id: fault, outcome: 'recovered', detail: await drillHostEvent(fault, problems) });
        } catch (error) {
          findings.set(fault, {
            id: fault,
            outcome: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const verify = runInstall(['verify', '--root', root]);
      if (verify.status !== 0 || !outputOf(verify).includes('verify: ok')) {
        problem(
          `the store the recovery matrix leaves must verify from a fresh process\n${outputOf(verify).trim().slice(-1_200)}`,
          problems,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  const reportFindings = REQUIRED_RECOVERY_DRILLS.map((id) => findings.get(id) ?? {
    id,
    outcome: 'failed',
    detail: 'the drill did not run',
  });
  for (const finding of reportFindings) {
    if (finding.outcome !== 'recovered') {
      problem(`the ${finding.id} recovery drill did not recover: ${finding.detail}`, problems);
    }
  }
  const report = {
    leg: 'recovery',
    verdict: problems.length === 0 ? 'passed' : 'failed',
    findings: reportFindings,
  };
  if (reportPath !== undefined) await writeReport(reportPath, report, problems);
  if (problems.length === 0) {
    console.log(`recovery: ${reportFindings.length} fault(s) recovered; the store verifies with verify: ok`);
    return 0;
  }
  return 1;
}

/* ------------------------------------------------------------------ reliability leg --------- */

async function reliabilityLeg(options) {
  const problems = [];
  const sessionsArgument = options.get('--sessions');
  const reportPath = options.get('--report');
  if (sessionsArgument === undefined) problem('--sessions <file> is required for the reliability leg', problems);
  if (reportPath === undefined) problem('--report <file> is required for the reliability leg', problems);

  const report = {
    leg: 'reliability',
    verdict: 'failed',
    sessions: 0,
    cleanSessions: 0,
    crashedSessions: 0,
    crashFreeRate: 0,
    minimumSessions: CRASH_FREE_MINIMUM_SESSIONS,
    target: CRASH_FREE_TARGET,
    targetMet: false,
  };

  if (sessionsArgument !== undefined) {
    let ledger = null;
    try {
      ledger = JSON.parse(await readFile(sessionsArgument, 'utf8'));
    } catch (error) {
      problem(
        `the beta session ledger ${sessionsArgument} is missing, unreadable or not valid JSON: `
          + `${error instanceof Error ? error.message : String(error)}`,
        problems,
      );
    }
    if (ledger !== null) {
      const sessions = Array.isArray(ledger?.sessions) ? ledger.sessions : null;
      if (sessions === null) {
        problem('the beta session ledger must declare a sessions[] array', problems);
      } else if (sessions.length === 0) {
        problem('the beta session ledger holds no sessions', problems);
      } else {
        const ids = new Set();
        let clean = 0;
        let malformed = false;
        for (const [index, session] of sessions.entries()) {
          const id = typeof session?.sessionId === 'string' ? session.sessionId.trim() : '';
          if (id.length === 0) {
            problem(`beta session ${index} has no sessionId`, problems);
            malformed = true;
            break;
          }
          if (ids.has(id)) {
            problem(`beta session id ${id} appears more than once`, problems);
            malformed = true;
            break;
          }
          ids.add(id);
          if (typeof session?.crashed !== 'boolean') {
            problem(`beta session ${id} must declare a boolean crashed flag`, problems);
            malformed = true;
            break;
          }
          if (!session.crashed) clean += 1;
        }
        if (!malformed) {
          report.sessions = sessions.length;
          report.cleanSessions = clean;
          report.crashedSessions = sessions.length - clean;
          report.crashFreeRate = clean / sessions.length;
          report.targetMet = report.crashFreeRate >= CRASH_FREE_TARGET && sessions.length >= CRASH_FREE_MINIMUM_SESSIONS;
          if (sessions.length < CRASH_FREE_MINIMUM_SESSIONS) {
            problem(
              `the §4.4 crash-free target is measured over at least ${CRASH_FREE_MINIMUM_SESSIONS} sessions; the `
                + `ledger records ${sessions.length}`,
              problems,
            );
          }
          if (report.crashFreeRate < CRASH_FREE_TARGET) {
            problem(
              `crash-free ${report.crashFreeRate} over ${sessions.length} sessions is below the §4.4 target `
                + `${CRASH_FREE_TARGET}`,
              problems,
            );
          }
        }
      }
    }
  }

  report.verdict = problems.length === 0 ? 'passed' : 'failed';
  if (reportPath !== undefined) await writeReport(reportPath, report, problems);
  if (problems.length === 0) {
    console.log(`crash-free: ${report.crashFreeRate} over ${report.sessions} sessions`);
    return 0;
  }
  return 1;
}

/* --------------------------------------------------------------------------- entry ---------- */

const USAGE = [
  'usage: node --import tsx scripts/release/qualify-release.mjs <leg> [options]',
  '  adversarial --corpus <file> --report <file>',
  '  recovery    --root <dir>    --report <file>',
  '  reliability --sessions <file> --report <file>',
].join('\n');

async function main() {
  const [leg, ...rest] = process.argv.slice(2);
  if (leg === undefined || leg === '--help' || leg === 'help') {
    console.log(USAGE);
    return leg === undefined ? 2 : 0;
  }
  let options;
  try {
    options = parseOptions(rest);
  } catch (error) {
    problem(error instanceof Error ? error.message : String(error));
    console.log(USAGE);
    return 2;
  }
  if (leg === 'adversarial') return adversarialLeg(options);
  if (leg === 'recovery') return recoveryLeg(options);
  if (leg === 'reliability') return reliabilityLeg(options);
  problem(`unknown leg ${JSON.stringify(leg)}`);
  console.log(USAGE);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`problem: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
