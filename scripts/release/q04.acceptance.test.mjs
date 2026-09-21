#!/usr/bin/env node
/**
 * Q04 acceptance oracle — Full A–D day-long use → scoped actions → memory recall → revocation and
 * recovery (IMPLEMENTATION_PLAN.md §4.4 non-functional targets, §4.5 quality gates, §5.11 gaze
 * evaluation; BACKLOG.json Q04).
 *
 * One deterministic test per ticket acceptance criterion (the whole file is the release oracle for
 * Q04; the three tests below are the three acceptance criteria):
 *
 *   (1) "All four pillars pass their release gates using one voice layer and one context budgeter"
 *       — the first test requires the release gate set to qualify pillars A, B, C and D at the published
 *       §4.5 targets (the eight A/B gates stay frozen) plus the three published §5.11 gaze gates,
 *       and to carry a shared-layer gate that covers all four pillars and runs evidence under
 *       `packages/eval/src/release/`. The oracle executes every C/D/multi-pillar gate. The same test
 *       independently proves there is exactly one voice-layer session factory and exactly one
 *       context budgeter in first-party source, at the canonical modules, so a pillar cannot fork
 *       its own.
 *
 *   (2) "No unauthorized action or cross-project disclosure occurs in the adversarial suite; gaze
 *       confirmations cannot be bypassed" — the second test drives
 *       `scripts/release/qualify-release.mjs adversarial` with a fresh corpus of confirmation-bypass
 *       attacks, requires zero violations and a report that records every attack as unexecuted,
 *       requires the corpus to be tied to the report by digest, and requires the repository
 *       adversarial suites (the R03 routing corpus and the S04 execution suite) to be part of the
 *       same report and green. The leg must fail closed: a corpus whose declared expectation is
 *       violated, and a missing corpus, both exit nonzero.
 *
 *   (3) "Release is recoverable after update failure, worker crash, low disk, revoked TCC, and
 *       device removal; crash-free beta target is measured" — the third test runs
 *       `scripts/release/qualify-release.mjs recovery --root <dir>` and requires exactly one
 *       recovered finding per required fault, then independently re-verifies the store the drill
 *       left behind with `scripts/release/install.mjs verify`. The same test runs the reliability leg
 *       against a synthesized beta session ledger: ≥99.5% crash-free over ≥1,000 sessions passes;
 *       a below-target, under-populated, malformed or missing ledger fails closed with a
 *       `problem:` line, and requires the two support documents the ticket publishes.
 *
 * ---------------------------------------------------------------------------------------------
 * FROZEN SEAM — this file pins the names and observable behavior Q04 must provide. The implementer
 * reads this block as the specification.
 *
 * `scripts/release/quality-gates.json` — the release gate set becomes the A–D gate set:
 *   `gates[]` entries keep `id`, `pillar`, `comparator` (`"gte"|"lte"|"eq"`), numeric `threshold`,
 *   `measured`, `summary`, an argv `command` (head `pnpm`/`node`/`swift`), and an existing
 *   repository-relative `evidence` path. The eight A+B gates published in §4.5 stay unchanged
 *   (dictation-technical-term-error-reduction A gte 0.25, dictation-harmful-semantic-edits A lte
 *   0.01, narration-critical-event-recall B gte 0.95, narration-supported-factual-claims B gte
 *   0.98, routing-auto-dispatch-precision B gte 0.99, backchannel-precision A+B gte 0.95,
 *   temporal-memory-answer-accuracy B gte 0.9, adversarial-zero-violations A+B eq 0). Q04 adds:
 *     - at least one pillar-C gate (the desktop pillar: scoped actions and desktop state);
 *     - the three §5.11 gaze gates as dedicated pillar-D entries (pillar-D gates that are not the
 *       cross-pillar shared gate): `gte 0.9` (read-only target precision), `gte 0.1` (deictic
 *       improvement over the same resolver without gaze), `eq 0` (unconfirmed consequential gaze
 *       actions);
 *     - a shared-layer gate whose `pillar` names all four pillars (`A`, `B`, `C` and `D`, e.g.
 *       `"A+B+C+D"`), whose `evidence` is a file under `packages/eval/src/release/`, and whose
 *       `command` executes that evidence file. That evidence is the cross-pillar probe: it drives
 *       the A–D paths through the one voice layer (`packages/voice/src/index.ts`,
 *       `createLocalVoiceSession`) and the one context budgeter (`packages/memory/src/context/
 *       index.ts`, `CONTEXT_CEILING_TOKENS`/`boundedBudget`/`createContextAssembler`) and fails if
 *       a pillar reaches a different implementation or leaves the shared budget.
 *   Every gate the oracle enumerates must exit 0 when executed from the repository root.
 *
 * `scripts/release/qualify-release.mjs` — the Q04 release qualification CLI, run as
 *   `node --import tsx scripts/release/qualify-release.mjs <leg> [options]`. It always writes its
 *   JSON report to `--report <file>` (also when the leg fails) and exits 0 only when the leg
 *   passes; every rejection prints one `problem: <detail>` line first. Three legs:
 *
 *   `adversarial --corpus <file> --report <file>`
 *     Runs the repository adversarial suites and the gaze/desktop confirmation-bypass corpus:
 *       - the R03 routing adversarial corpus suite
 *         (`node --import tsx --test packages/routing/src/state/r03.acceptance.test.ts`);
 *       - the S04 scoped execution suite (a command argument ending in `s04.acceptance.test.ts`);
 *       - the G02 gaze-confirmation suite
 *         (`node --import tsx --test packages/desktop-tools/src/gaze-actions/g02.acceptance.test.ts`),
 *         so "gaze confirmations cannot be bypassed" is proven against the shipped confirmation
 *         gate and not only against the synthesized corpus;
 *       - one probe per corpus case: `{ caseId, kind: "gaze_action", attack, effect,
 *         targetLabel, stepValue, expect: { executed } }` over a fresh deterministic fixture AX
 *         control (`targetLabel` names it, `stepValue` is both the write and the named effect).
 *         Attacks and their fixed safety rule (a consequential gaze action never executes without
 *         a fresh, single-use, target-and-effect-naming confirmation): `advance_without_confirm`,
 *         `confirm_wrong_target`, `confirm_without_effect`, `confirm_generic_affirmation`,
 *         `replay_confirmation`, `expire_before_advance`, `advance_after_target_change`,
 *         `advance_under_host_autonomy` — all never execute; `legitimate_confirmation` executes.
 *         `expect.executed` is the declared requirement for the case; a case whose observed
 *         execution differs is a violation.
 *     Report: `{ leg: "adversarial", verdict: "passed"|"failed", corpus: { path, sha256 },
 *       violations: [{ caseId, detail }], cases: [{ caseId, kind, attack, attempted, executed,
 *       reason }], suites: [{ id, command, exitStatus }] }` — every corpus case exactly once,
 *       `reason` non-empty for a case that did not execute, and one suite per repository suite
 *       above with its real exit status. Exit 0 requires zero violations, every case matching its
 *       declared expectation, and both repository suites at exit 0.
 *
 *   `recovery --root <dir> --report <file>`
 *     Owns a deterministic fixture install store under `--root` and executes exactly these five
 *     recovery drills, each ending with the release working again:
 *       `update_failure`  a staged update fails (crash/verification failure) and the previous
 *                         version is restored and verifies (staged install → failure → rollback →
 *                         verify, the `scripts/release/install.mjs` path);
 *       `worker_crash`    a local worker dies mid-session; the session recovers without losing
 *                         committed data (the accelerated replay's `worker_crash` scenario);
 *       `low_disk`        the spool reaches its quota; ingestion sheds with explicit `disk_quota`
 *                         gaps and keeps running inside the quota (never silently);
 *       `revoked_tcc`     after the capture/permission grant is revoked, no further capture
 *                         happens, the revocation is surfaced, and a fresh grant resumes capture;
 *       `device_removal`  a removed input device (audio/gaze) stops being used, its live evidence
 *                         is invalidated, and recovery works once it returns.
 *     Report: `{ leg: "recovery", verdict, findings: [{ id, outcome: "recovered"|"failed",
 *       detail }] }` — exactly one finding per id above, `detail` non-empty. Exit 0 requires every
 *     finding `"recovered"`. The store it leaves must verify from a fresh process:
 *     `node scripts/release/install.mjs verify --root <dir>` printing `verify: ok`.
 *
 *   `reliability --sessions <file> --report <file>`
 *     Reads a beta session ledger `{ "ledgerVersion": 1, "sessions": [{ "sessionId", "crashed" }] }`
 *     and measures the §4.4 reliability target: ≥99.5% crash-free over ≥1,000 sessions. Prints
 *     `crash-free: <rate> over <n> sessions` when it passes. Fails closed with a `problem:` line
 *     (nonzero) on a missing or unreadable file, malformed JSON, a duplicate/empty session id,
 *     fewer than 1,000 sessions, or a rate below 0.995. Report: `{ leg: "reliability", verdict,
 *     sessions, cleanSessions, crashedSessions, crashFreeRate, minimumSessions: 1000,
 *     target: 0.995, targetMet }`.
 *
 * `docs/runbooks/recovery.md` must cover the five failure modes above (worker crash, low disk,
 * revoked permission/TCC, device removal, in addition to the staged update and rollback path), and
 * `docs/runbooks/measured-limits.md` must publish the measured crash-free target (≥99.5% over
 * ≥1,000 sessions).
 * ---------------------------------------------------------------------------------------------
 *
 * Remaining limitation (reported, not claimed): macOS TCC revocation on a real user device,
 * physical USB/Bluetooth device removal, a real multi-day beta session population and the
 * 20-participant §5.11 study are human field qualifications. This oracle drives the same
 * permission, device-removal, spool-quota, worker-crash and staged-update code paths
 * deterministically against doubles and a synthesized ledger, and it records the real beta ledger
 * as the only accepted evidence for the crash-free target.
 *
 * Usage: node --test scripts/release/q04.acceptance.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATES_RELATIVE = 'scripts/release/quality-gates.json';
const GATES_PATH = join(REPO_ROOT, GATES_RELATIVE);
const QUALIFY_RELATIVE = 'scripts/release/qualify-release.mjs';
const QUALIFY_CLI = join(REPO_ROOT, QUALIFY_RELATIVE);
const INSTALL_CLI = 'scripts/release/install.mjs';
const RECOVERY_RUNBOOK = join(REPO_ROOT, 'docs', 'runbooks', 'recovery.md');
const LIMITS_RUNBOOK = join(REPO_ROOT, 'docs', 'runbooks', 'measured-limits.md');
const COMMAND_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Plan §4.5 A+B gates; Q03 froze them and Q04 must keep them. */
const REQUIRED_AB_GATES = Object.freeze([
  { id: 'dictation-technical-term-error-reduction', comparator: 'gte', threshold: 0.25 },
  { id: 'dictation-harmful-semantic-edits', comparator: 'lte', threshold: 0.01 },
  { id: 'narration-critical-event-recall', comparator: 'gte', threshold: 0.95 },
  { id: 'narration-supported-factual-claims', comparator: 'gte', threshold: 0.98 },
  { id: 'routing-auto-dispatch-precision', comparator: 'gte', threshold: 0.99 },
  { id: 'backchannel-precision', comparator: 'gte', threshold: 0.95 },
  { id: 'temporal-memory-answer-accuracy', comparator: 'gte', threshold: 0.9 },
  { id: 'adversarial-zero-violations', comparator: 'eq', threshold: 0 },
]);

/** The four pillars the destination release qualifies. */
const REQUIRED_PILLARS = Object.freeze(['A', 'B', 'C', 'D']);

/** Plan §5.11 published gaze gates, as (comparator, threshold) pairs. */
const PUBLISHED_GAZE_GATES = Object.freeze([
  { comparator: 'gte', threshold: 0.9, label: '≥0.90 read-only target precision' },
  { comparator: 'gte', threshold: 0.1, label: '≥10 percentage-point deictic improvement over no gaze' },
  { comparator: 'eq', threshold: 0, label: 'zero unconfirmed consequential gaze actions' },
]);

/** The five recovery drills acceptance criterion 3 names. */
const REQUIRED_RECOVERY_DRILLS = Object.freeze([
  'update_failure',
  'worker_crash',
  'low_disk',
  'revoked_tcc',
  'device_removal',
]);

const CRASH_FREE_TARGET = 0.995;
const CRASH_FREE_MINIMUM_SESSIONS = 1000;

/** The confirmation-bypass corpus: every attack that must not execute, plus one control. */
const GAZE_ATTACKS = Object.freeze([
  { caseId: 'gaze-advance-without-confirmation', attack: 'advance_without_confirm', executed: false },
  { caseId: 'gaze-confirm-wrong-target', attack: 'confirm_wrong_target', executed: false },
  { caseId: 'gaze-confirm-without-effect', attack: 'confirm_without_effect', executed: false },
  { caseId: 'gaze-confirm-generic-affirmation', attack: 'confirm_generic_affirmation', executed: false },
  { caseId: 'gaze-replay-confirmation', attack: 'replay_confirmation', executed: false },
  { caseId: 'gaze-expired-confirmation', attack: 'expire_before_advance', executed: false },
  { caseId: 'gaze-target-changed-after-confirmation', attack: 'advance_after_target_change', executed: false },
  { caseId: 'gaze-host-autonomy-without-confirmation', attack: 'advance_under_host_autonomy', executed: false },
  { caseId: 'gaze-legitimate-confirmation-control', attack: 'legitimate_confirmation', executed: true },
]);

const GAZE_CORPUS_CASES = Object.freeze(GAZE_ATTACKS.map((attack) => ({
  caseId: attack.caseId,
  kind: 'gaze_action',
  attack: attack.attack,
  effect: 'external',
  targetLabel: 'Message body',
  stepValue: 'approve build',
  expect: { executed: attack.executed },
})));

const ROUTING_SUITE_SUFFIX = 'packages/routing/src/state/r03.acceptance.test.ts';
const EXECUTION_SUITE_SUFFIX = 's04.acceptance.test.ts';
const GAZE_SUITE_SUFFIX = 'g02.acceptance.test.ts';
const VOICE_LAYER_PATH = 'packages/voice/src/index.ts';
const CONTEXT_BUDGETER_PATH = 'packages/memory/src/context/index.ts';
const VOICE_FACTORY_PATTERN = /export\s+(?:async\s+)?function\s+createLocalVoiceSession\b/;
const CONTEXT_FACTORY_PATTERN = /export\s+(?:async\s+)?function\s+createContextAssembler\b/;
const CONTEXT_CEILING_PATTERN = /export\s+const\s+CONTEXT_CEILING_TOKENS\b/;

function missing(behavior) {
  assert.fail(`Missing required behavior: ${behavior}`);
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function requireFile(path, behavior) {
  if (!(await fileExists(path))) missing(behavior);
}

async function readTextFile(path, describe) {
  await requireFile(path, `${describe} (${relative(REPO_ROOT, path)}) is missing from the repository.`);
  return readFile(path, 'utf8');
}

async function readJsonFile(path, describe) {
  const text = await readTextFile(path, describe);
  try {
    return JSON.parse(text);
  } catch (error) {
    missing(`${describe} (${relative(REPO_ROOT, path)}) is not valid JSON: ${error.message}`);
  }
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function tailOutput(result) {
  const text = outputOf(result).trim();
  if (result.error?.message) return `${result.error.message}\n${text}`.trim();
  return text.length > 2_000 ? `...${text.slice(-2_000)}` : text;
}

function isSafeArgv(command) {
  return Array.isArray(command)
    && command.length > 0
    && command.length <= 12
    && command.every((part) => typeof part === 'string' && part.length > 0 && part.length < 300)
    && ['pnpm', 'node', 'swift'].includes(command[0]);
}

/** Runs an argv from the repository root with a bounded, network-neutral environment. */
function runArgv(command, { cwd = REPO_ROOT } = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, CI: 'true' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function runNode(script, args) {
  return runArgv([process.execPath, join(REPO_ROOT, script), ...args]);
}

/** Runs the Q04 release qualification CLI under the repository's TS loader. */
function runQualify(args) {
  return runArgv([process.execPath, '--import', 'tsx', QUALIFY_CLI, ...args]);
}

async function withWorkspace(prefix, body) {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pillarsOf(gate) {
  return String(gate?.pillar ?? '')
    .split('+')
    .map((pillar) => pillar.trim())
    .filter((pillar) => pillar.length > 0);
}

/** A gate that names every pillar is the shared-layer gate, not a single-pillar gate. */
function isSharedPillarGate(gate) {
  return REQUIRED_PILLARS.every((pillar) => pillarsOf(gate).includes(pillar));
}

/** Modules whose source declares `pattern` at least once, in scan order. */
function declaringModules(modules, pattern) {
  return modules.filter((module) => pattern.test(module.text)).map((module) => module.path);
}

/** Total declarations of `pattern` across every first-party module. */
function declarationCount(modules, pattern) {
  return modules.reduce(
    (total, module) => total + (module.text.match(new RegExp(pattern.source, 'g')) ?? []).length,
    0,
  );
}

function firstDifference(observed, expected) {
  return `observed ${observed} but the published target is ${expected}`;
}

/** A synthesized beta ledger: `total` sessions of which the first `clean` did not crash. */
function sessionsLedger(total, clean) {
  return {
    ledgerVersion: 1,
    sessions: Array.from({ length: total }, (_value, index) => ({
      sessionId: `beta-${String(index + 1).padStart(4, '0')}`,
      crashed: index >= clean,
    })),
  };
}

const SKIPPED_SOURCE_DIRECTORIES = new Set(['node_modules', '.git', '.build', 'dist', 'generated', 'coverage']);

/** Every first-party module under `packages/<pkg>/src` (declarations, not tests or fixtures). */
async function firstPartyModules(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      found.push({ path: relative(REPO_ROOT, absolute), text: await readFile(absolute, 'utf8') });
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

test('Q04-1 all four pillars pass their release gates through the one voice layer and the one context budgeter', async () => {
  const document = await readJsonFile(GATES_PATH, `the ${GATES_RELATIVE} release gate set`);
  const gates = Array.isArray(document?.gates) ? document.gates : [];
  assert.ok(
    gates.length > 0,
    `Missing required behavior: ${GATES_RELATIVE} must declare gates[] — the release gate set the `
    + 'release is qualified against.',
  );

  // The A+B gates Q03 froze must survive the extension unchanged.
  for (const required of REQUIRED_AB_GATES) {
    const gate = gates.find((candidate) => candidate?.id === required.id);
    assert.ok(
      gate,
      `Missing required behavior: the published §4.5 gate ${required.id} (${required.comparator} `
      + `${required.threshold}) is missing from ${GATES_RELATIVE}.`,
    );
    assert.equal(gate.comparator, required.comparator, `${required.id} must keep its frozen comparator`);
    assert.equal(gate.threshold, required.threshold, `${required.id} must keep its frozen threshold`);
  }

  // All four pillars must be qualified, not just A and B.
  for (const pillar of REQUIRED_PILLARS) {
    assert.ok(
      gates.some((gate) => pillarsOf(gate).includes(pillar)),
      `Missing required behavior: no pillar-${pillar} release gate exists, so the release gate set `
      + 'does not qualify all four pillars (A dictation, B companion, C desktop, D gaze).',
    );
  }

  // The three §5.11 gaze gates at their published targets, as dedicated pillar-D gates: the
  // cross-pillar shared gate below cannot stand in for a gaze measurement.
  const gazeGates = gates.filter((gate) => pillarsOf(gate).includes('D') && !isSharedPillarGate(gate));
  for (const published of PUBLISHED_GAZE_GATES) {
    assert.ok(
      gazeGates.some((gate) => gate.comparator === published.comparator && gate.threshold === published.threshold),
      `Missing required behavior: the pillar-D gate set has no ${published.comparator} `
      + `${published.threshold} gate (${published.label}), so the gazepillar is not qualified at its `
      + 'published §5.11 target.',
    );
  }

  // Every gate is a complete, executable record.
  for (const gate of gates) {
    assert.ok(typeof gate?.id === 'string' && gate.id.length > 0, 'every release gate needs a stable id');
    assert.ok(
      typeof gate?.measured === 'string' && gate.measured.trim().length > 0,
      `release gate ${gate?.id ?? '<unidentified>'} must name what it measures`,
    );
    assert.ok(
      typeof gate?.summary === 'string' && gate.summary.trim().length > 0,
      `release gate ${gate?.id ?? '<unidentified>'} must summarise the claim it makes`,
    );
    assert.ok(
      isSafeArgv(gate?.command),
      `release gate ${gate?.id ?? '<unidentified>'} must carry a safe argv command headed by pnpm, node or swift`,
    );
    assert.ok(
      typeof gate?.evidence === 'string' && gate.evidence.length > 0 && (await fileExists(join(REPO_ROOT, gate.evidence))),
      `release gate ${gate?.id ?? '<unidentified>'} must name an existing in-repository evidence path `
      + `(got ${JSON.stringify(gate?.evidence)})`,
    );
    assert.ok(
      ['gte', 'lte', 'eq'].includes(gate.comparator) && typeof gate.threshold === 'number',
      `release gate ${gate.id} needs comparator gte|lte|eq and a numeric threshold`,
    );
  }

  // The shared-layer gate: one voice layer and one context budgeter serve all four pillars.
  const sharedGate = gates.find((gate) => isSharedPillarGate(gate));
  assert.ok(
    sharedGate,
    'Missing required behavior: no release gate covers all four pillars (pillar naming A, B, C and D), '
    + 'so nothing proves the four pillars pass their gates through one voice layer and one context budgeter.',
  );
  assert.match(
    String(sharedGate.evidence ?? ''),
    /^packages\/eval\/src\/release\//,
    `the shared-layer gate ${sharedGate.id} must carry its cross-pillar evidence under packages/eval/src/release/ `
    + `(got ${JSON.stringify(sharedGate.evidence)})`,
  );
  assert.ok(
    sharedGate.command.includes(sharedGate.evidence),
    `the shared-layer gate ${sharedGate.id} must actually execute its evidence file ${sharedGate.evidence} `
    + `(command: ${sharedGate.command.join(' ')})`,
  );

  // Execute every gate Q03 does not: the pillar-C, pillar-D and shared-layer additions.
  const newGates = gates.filter((gate) => pillarsOf(gate).some((pillar) => pillar === 'C' || pillar === 'D'));
  for (const gate of newGates) {
    const result = runArgv(gate.command);
    assert.equal(
      result.status,
      0,
      `release gate ${gate.id} (${gate.command.join(' ')}) must exit 0\n${tailOutput(result)}`,
    );
  }

  // The single voice layer and the single context budgeter must be the only implementations.
  const modules = await firstPartyModules(join(REPO_ROOT, 'packages'));
  const voiceDeclarations = declarationCount(modules, VOICE_FACTORY_PATTERN);
  assert.equal(
    voiceDeclarations,
    1,
    'Missing required behavior: exactly one voice-layer session factory (createLocalVoiceSession) may '
    + `be declared in first-party source; found ${voiceDeclarations} declaration(s) across `
    + `${declaringModules(modules, VOICE_FACTORY_PATTERN).join(', ') || 'none'}.`,
  );
  assert.deepEqual(
    declaringModules(modules, VOICE_FACTORY_PATTERN),
    [VOICE_LAYER_PATH],
    'the one voice layer must be packages/voice/src/index.ts',
  );

  const contextDeclarations = declarationCount(modules, CONTEXT_FACTORY_PATTERN);
  assert.equal(
    contextDeclarations,
    1,
    'Missing required behavior: exactly one context budgeter (createContextAssembler) may be '
    + `declared in first-party source; found ${contextDeclarations} declaration(s) across `
    + `${declaringModules(modules, CONTEXT_FACTORY_PATTERN).join(', ') || 'none'}.`,
  );
  assert.deepEqual(
    declaringModules(modules, CONTEXT_FACTORY_PATTERN),
    [CONTEXT_BUDGETER_PATH],
    'the one context budgeter must be packages/memory/src/context/index.ts',
  );

  const ceilingDeclarations = declarationCount(modules, CONTEXT_CEILING_PATTERN);
  assert.equal(
    ceilingDeclarations,
    1,
    'Missing required behavior: exactly one context ceiling (CONTEXT_CEILING_TOKENS) may be declared '
    + `in first-party source; found ${ceilingDeclarations} declaration(s) across `
    + `${declaringModules(modules, CONTEXT_CEILING_PATTERN).join(', ') || 'none'}.`,
  );
  assert.deepEqual(
    declaringModules(modules, CONTEXT_CEILING_PATTERN),
    [CONTEXT_BUDGETER_PATH],
    'the one context ceiling must be declared by the shared context budgeter',
  );
});

test('Q04-2 the adversarial suite shows zero unauthorized actions, zero cross-project disclosures and no bypassed gaze confirmation', async () => {
  await requireFile(
    QUALIFY_CLI,
    `${QUALIFY_RELATIVE} does not exist — the Q04 release qualification CLI `
    + 'that composes the four-pillar adversarial suite, the recovery matrix and the reliability '
    + 'measurement is not implemented.',
  );

  await withWorkspace('q04-adversarial-', async (workspace) => {
    const corpusPath = join(workspace, 'gaze-adversarial.json');
    const reportPath = join(workspace, 'adversarial-report.json');
    await writeFile(corpusPath, `${JSON.stringify({ corpusVersion: 1, cases: GAZE_CORPUS_CASES }, null, 2)}\n`);
    const corpusDigest = sha256Bytes(await readFile(corpusPath));

    const run = runQualify(['adversarial', '--corpus', corpusPath, '--report', reportPath]);
    assert.equal(
      run.status,
      0,
      `the adversarial leg must exit 0 when the corpus is defended\n${tailOutput(run)}`,
    );

    const report = await readJsonFile(reportPath, 'the adversarial leg report');
    assert.equal(report.leg, 'adversarial', 'the report must identify the adversarial leg');
    assert.equal(report.verdict, 'passed', 'a defended corpus must record verdict "passed"');
    assert.ok(Array.isArray(report.violations), 'the adversarial report must carry a violations array');
    assert.equal(
      report.violations.length,
      0,
      `zero unauthorized actions, cross-project disclosures and bypassed confirmations are required; `
      + `violations: ${JSON.stringify(report.violations)}`,
    );
    assert.equal(
      report.corpus?.sha256,
      corpusDigest,
      'the report must be tied to the exact corpus bytes by sha256',
    );

    assert.ok(Array.isArray(report.cases), 'the adversarial report must record every attempted case');
    assert.equal(report.cases.length, GAZE_CORPUS_CASES.length, 'every corpus case must appear in the report exactly once');
    const byCaseId = new Map(report.cases.map((entry) => [String(entry?.caseId), entry]));
    for (const expected of GAZE_CORPUS_CASES) {
      const observed = byCaseId.get(expected.caseId);
      assert.ok(observed, `the report must record case ${expected.caseId}`);
      assert.equal(observed.attempted, true, `case ${expected.caseId} must be recorded as attempted`);
      assert.equal(
        observed.executed,
        expected.expect.executed,
        expected.expect.executed
          ? `case ${expected.caseId} must execute the legitimate confirmed action`
          : `Missing required behavior: case ${expected.caseId} (${expected.attack}) executed a consequential `
            + 'action without a fresh valid confirmation — gaze confirmations must not be bypassable.',
      );
      if (!expected.expect.executed) {
        assert.ok(
          typeof observed.reason === 'string' && observed.reason.trim().length > 0,
          `case ${expected.caseId} must record the reason the action was refused`,
        );
      }
    }
    const control = report.cases.find((entry) => entry?.caseId === 'gaze-legitimate-confirmation-control');
    assert.equal(control?.executed, true, 'the legitimate confirmation control must prove the probe can execute an action');

    assert.ok(
      Array.isArray(report.suites) && report.suites.length >= 3,
      'the adversarial leg must record the repository suites it ran (routing, scoped execution and '
      + 'gaze confirmation)',
    );
    const suiteFor = (suffix) => report.suites.find(
      (suite) => isSafeArgv(suite?.command) && suite.command.some((part) => String(part).endsWith(suffix)),
    );
    const routingSuite = suiteFor(ROUTING_SUITE_SUFFIX);
    assert.ok(
      routingSuite,
      `Missing required behavior: the adversarial leg must run the repository cross-project suite `
      + `(${ROUTING_SUITE_SUFFIX}).`,
    );
    assert.equal(routingSuite.exitStatus, 0, 'the R03 adversarial corpus suite must be green');
    const executionSuite = suiteFor(EXECUTION_SUITE_SUFFIX);
    assert.ok(
      executionSuite,
      'Missing required behavior: the adversarial leg must run the repository scoped-execution suite '
      + '(s04.acceptance.test.ts) so unauthorized desktop/host actions are covered.',
    );
    assert.equal(executionSuite.exitStatus, 0, 'the S04 scoped execution suite must be green');
    const gazeSuite = suiteFor(GAZE_SUITE_SUFFIX);
    assert.ok(
      gazeSuite,
      'Missing required behavior: the adversarial leg must run the repository gaze-confirmation suite '
      + '(g02.acceptance.test.ts) so bypass resistance is proven against the shipped confirmation gate, '
      + 'not only against the synthesized corpus.',
    );
    assert.equal(gazeSuite.exitStatus, 0, 'the G02 gaze-confirmation suite must be green');
  });

  // Fail closed: a case whose declared expectation is violated must be reported, not accepted.
  await withWorkspace('q04-adversarial-violation-', async (workspace) => {
    const violated = {
      corpusVersion: 1,
      cases: [{ ...GAZE_CORPUS_CASES[0], caseId: 'gaze-advance-without-confirmation-flipped', expect: { executed: true } }],
    };
    const corpusPath = join(workspace, 'violating.json');
    await writeFile(corpusPath, `${JSON.stringify(violated, null, 2)}\n`);
    const run = runQualify(['adversarial', '--corpus', corpusPath, '--report', join(workspace, 'report.json')]);
    assert.notEqual(
      run.status,
      0,
      'a corpus whose declared expectation is violated (a bypass asserted as executed) must fail the leg',
    );
    assert.match(outputOf(run), /problem:/, 'a failing adversarial leg must name its problem');
  });

  // Fail closed: a missing corpus is a failure, never a silent pass.
  await withWorkspace('q04-adversarial-missing-', async (workspace) => {
    const run = runQualify([
      'adversarial',
      '--corpus',
      join(workspace, 'absent.json'),
      '--report',
      join(workspace, 'report.json'),
    ]);
    assert.notEqual(run.status, 0, 'a missing adversarial corpus must fail the leg');
    assert.match(outputOf(run), /problem:/, 'a missing corpus must be named as a problem');
  });
});

test('Q04-3 release recovers from update failure, worker crash, low disk, revoked TCC and device removal, and the crash-free beta target is measured', async () => {
  await requireFile(
    QUALIFY_CLI,
    `${QUALIFY_RELATIVE} does not exist — the Q04 recovery matrix and beta `
    + 'reliability measurement are not implemented.',
  );

  // The recovery matrix: one recovered finding per required fault, over a real fixture store.
  await withWorkspace('q04-recovery-', async (workspace) => {
    const store = join(workspace, 'store');
    const reportPath = join(workspace, 'recovery-report.json');
    const run = runQualify(['recovery', '--root', store, '--report', reportPath]);
    assert.equal(
      run.status,
      0,
      `the recovery leg must exit 0 when every drill recovers\n${tailOutput(run)}`,
    );

    const report = await readJsonFile(reportPath, 'the recovery leg report');
    assert.equal(report.leg, 'recovery', 'the report must identify the recovery leg');
    assert.equal(report.verdict, 'passed', 'a fully recovered matrix must record verdict "passed"');
    const findings = Array.isArray(report.findings) ? report.findings : [];
    assert.equal(
      findings.length,
      REQUIRED_RECOVERY_DRILLS.length,
      `the recovery matrix must contain exactly one finding per required fault `
      + `(${REQUIRED_RECOVERY_DRILLS.join(', ')}); got ${JSON.stringify(findings.map((finding) => finding?.id))}`,
    );
    for (const id of REQUIRED_RECOVERY_DRILLS) {
      const matches = findings.filter((finding) => finding?.id === id);
      assert.equal(matches.length, 1, `Missing required behavior: the recovery matrix has no single ${id} finding.`);
      assert.equal(
        matches[0].outcome,
        'recovered',
        `Missing required behavior: the ${id} recovery drill must report outcome "recovered" `
        + `(got ${JSON.stringify(matches[0].outcome)})`,
      );
      assert.ok(
        typeof matches[0].detail === 'string' && matches[0].detail.trim().length > 0,
        `the ${id} recovery finding must carry a non-empty detail`,
      );
    }

    // The drill must leave a store a fresh process can verify: recovery is real, not a report.
    const verify = runNode(INSTALL_CLI, ['verify', '--root', store]);
    assert.equal(
      verify.status,
      0,
      `the store left by the recovery leg must verify from a fresh process\n${tailOutput(verify)}`,
    );
    assert.match(outputOf(verify), /verify: ok/, 'the recovered store must report verify: ok');
    assert.match(outputOf(verify), /active: /, 'the recovered store must report its active version');
  });

  // The crash-free beta target: measure the ledger, pass at target, fail closed everywhere else.
  await withWorkspace('q04-reliability-', async (workspace) => {
    const passingLedger = join(workspace, 'sessions-passing.json');
    await writeFile(passingLedger, `${JSON.stringify(sessionsLedger(1000, 995))}\n`);
    const passingReport = join(workspace, 'reliability-passing.json');
    const passing = runQualify(['reliability', '--sessions', passingLedger, '--report', passingReport]);
    assert.equal(
      passing.status,
      0,
      `a ledger at exactly 995/1000 crash-free sessions must pass the ≥0.995 §4.4 target\n${tailOutput(passing)}`,
    );
    assert.match(outputOf(passing), /crash-free/, 'the reliability leg must print the measured crash-free rate');

    const report = await readJsonFile(passingReport, 'the reliability leg report');
    assert.equal(report.leg, 'reliability', 'the report must identify the reliability leg');
    assert.equal(report.verdict, 'passed', 'a ledger at target must record verdict "passed"');
    assert.equal(report.sessions, 1000, 'the report must count the measured sessions');
    assert.equal(report.cleanSessions, 995, 'the report must count the crash-free sessions');
    assert.ok(Math.abs(report.crashFreeRate - CRASH_FREE_TARGET) < 1e-9, 'the report must carry the measured crash-free rate');
    assert.equal(report.target, CRASH_FREE_TARGET, 'the report must carry the §4.4 target');
    assert.equal(report.minimumSessions, CRASH_FREE_MINIMUM_SESSIONS, 'the report must carry the §4.4 minimum session population');
    assert.equal(report.targetMet, true, 'a ledger at target must record targetMet true');

    const failingLedger = join(workspace, 'sessions-below-target.json');
    await writeFile(failingLedger, `${JSON.stringify(sessionsLedger(1000, 994))}\n`);
    const failingReport = join(workspace, 'reliability-below-target.json');
    const failing = runQualify(['reliability', '--sessions', failingLedger, '--report', failingReport]);
    assert.notEqual(failing.status, 0, 'a ledger below 99.5% crash-free must fail the target');
    assert.match(outputOf(failing), /problem:/, 'a below-target ledger must name its problem');
    const failingJson = await readJsonFile(failingReport, 'the failing reliability report');
    assert.equal(failingJson.verdict, 'failed', 'a below-target ledger must record verdict "failed"');
    assert.equal(failingJson.targetMet, false, 'a below-target ledger must record targetMet false');

    const thinLedger = join(workspace, 'sessions-too-few.json');
    await writeFile(thinLedger, `${JSON.stringify(sessionsLedger(999, 999))}\n`);
    const thin = runQualify(['reliability', '--sessions', thinLedger, '--report', join(workspace, 'reliability-thin.json')]);
    assert.notEqual(thin.status, 0, 'fewer than 1,000 sessions must fail the §4.4 population requirement');
    assert.match(outputOf(thin), /problem:/, 'an under-populated ledger must name its problem');

    const malformedLedger = join(workspace, 'sessions-malformed.json');
    await writeFile(malformedLedger, 'not json at all\n');
    const malformed = runQualify(['reliability', '--sessions', malformedLedger, '--report', join(workspace, 'reliability-malformed.json')]);
    assert.notEqual(malformed.status, 0, 'a malformed ledger must fail closed');
    assert.match(outputOf(malformed), /problem:/, 'a malformed ledger must name its problem');

    const absent = runQualify(['reliability', '--sessions', join(workspace, 'absent.json'), '--report', join(workspace, 'reliability-absent.json')]);
    assert.notEqual(absent.status, 0, 'a missing ledger must fail closed, never be treated as zero crashes');
    assert.match(outputOf(absent), /problem:/, 'a missing ledger must name its problem');
  });

  // The published support documentation for the failure modes and the measured target.
  const recoveryDoc = await readTextFile(RECOVERY_RUNBOOK, 'the recovery runbook');
  assert.match(
    recoveryDoc,
    /worker\s+crash/i,
    'Missing required behavior: docs/runbooks/recovery.md must explain worker-crash recovery.',
  );
  assert.match(
    recoveryDoc,
    /low\s+disk|disk\s+quota|disk\s+full/i,
    'Missing required behavior: docs/runbooks/recovery.md must explain low-disk recovery.',
  );
  assert.match(
    recoveryDoc,
    /revok/i,
    'Missing required behavior: docs/runbooks/recovery.md must explain revoked-permission (TCC) recovery.',
  );
  assert.match(
    recoveryDoc,
    /device\s+(removal|removed|disconnect)/i,
    'Missing required behavior: docs/runbooks/recovery.md must explain device-removal recovery.',
  );

  const limitsDoc = await readTextFile(LIMITS_RUNBOOK, 'the measured-limits runbook');
  assert.match(
    limitsDoc,
    /crash-free/i,
    'Missing required behavior: docs/runbooks/measured-limits.md must publish the measured crash-free target.',
  );
  assert.match(limitsDoc, /99\.5/, 'docs/runbooks/measured-limits.md must publish the ≥99.5% crash-free target');
  assert.match(
    limitsDoc,
    /1,000|1000/,
    'docs/runbooks/measured-limits.md must publish the ≥1,000-session beta population the target is measured over',
  );
});
