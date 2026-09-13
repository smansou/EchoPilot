#!/usr/bin/env node
/**
 * M02 acceptance oracle — "Live event batch → local extraction → bounded context → grounded answer"
 * (ticket M02; IMPLEMENTATION_PLAN.md §5.8 / §6). Test-role owned; never edited by the implementer.
 *
 * Run:  node packages/memory/src/consolidation/test/check.mjs
 *
 * Finding f-4a271ed5a779 recorded an oracle run that aborted with
 * "the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'": an oracle that
 * re-entered an agent CLI with incompatible flags, before one behavioral assertion could run.
 * This oracle starts no agent CLI and takes no sandbox/approval flags. Its only child processes are
 *
 *   * `node --import tsx --test` over the frozen node:test suites, and
 *   * `swiftc` compiling the production Sources/Reasoner sources plus the test-owned native oracle;
 *
 * and `runChild` refuses any argv that mentions an agent CLI, a sandbox mode or an approval flag
 * before a process starts, so the recorded failure cannot recur silently.
 *
 * Layers, all of which must pass (exit 0):
 *  1. In-process acceptance checks over the real store + consolidation + context modules:
 *     AC1 a multi-turn live batch answers a dated project question after a restart without
 *         rereading the full raw log (bounded reads, raw-log canary never in a bounded prompt);
 *     AC2 every Reasoner request obeys B = min(8192, floor(0.25 * C)) with a reserved output
 *         allowance, tools/images charged, including a deliberately failed compaction;
 *     AC3 failed JSON and model crashes keep deterministic state and mark semantic coverage
 *         partial, across repeated calls and a restart.
 *  2. The frozen node:test suites
 *     (packages/memory/src/consolidation/acceptance.test.ts,
 *      packages/memory/src/context/context-invariants.test.ts): exit 0, zero failures and the
 *     documented test titles still present, so gutting or deleting them fails this oracle.
 *  3. The native oracle (native/macos/Sources/Reasoner/test/main.swift) compiled against the
 *     production Reasoner sources: budget math, exact tokenizer accounting, image-token
 *     accounting, the assembler invariant and the stdio worker's bounded, grounded replies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const SWIFTC = process.env.SWIFTC ?? 'swiftc';
const AGENT_CLI_ARG = /codex|--sandbox|--approve-for-me|--dangerously-bypass/i;

assert.deepEqual(
  process.argv.slice(2).filter((part) => AGENT_CLI_ARG.test(part)),
  [],
  'the M02 oracle is invoked without agent CLI, sandbox or approval flags (finding f-4a271ed5a779)',
);

/** Runs one child process, refusing any argv that could re-enter an agent CLI (finding f-4a271ed5a779). */
function runChild(argv, { allowBinary } = {}) {
  const forbidden = argv.filter((part) => AGENT_CLI_ARG.test(String(part)));
  assert.deepEqual(
    forbidden,
    [],
    `the M02 oracle must not re-enter an agent CLI: ${forbidden.join(' ')}`,
  );
  const safeHead = argv[0] === process.execPath || argv[0] === SWIFTC || argv[0] === allowBinary;
  assert.ok(safeHead, `unexpected oracle child head: ${argv[0]}`);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  assert.equal(result.error, undefined, `${argv[0]} failed to start: ${result.error?.message}`);
  return result;
}

// ---------------------------------------------------------------- in-process acceptance checks
const contextModule = await tsImport('../../context/index.ts', import.meta.url);
const consolidationModule = await tsImport('../index.ts', import.meta.url);
const storeModule = await tsImport('../../store/index.ts', import.meta.url);

const FIXTURE_PATH = join(REPO_ROOT, 'fixtures', 'memory', 'live', 'atlas-session.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
/** Synthetic key material; the same one the frozen suite uses for the store. */
const STORE_KEY = '5f0e1d2c3b4a59687f6e5d4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908';
const MODEL = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };
/** An answer may inspect a bounded evidence set; the 300-turn raw log must stay out of it. */
const ANSWER_READ_BOUND = 32;

function count(text) {
  return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
}

const tokenizer = { count: (text) => count(text) };

/** The processor's own image-token calculation; M02 must charge it, never zero. */
function imageTokens(image) {
  return Math.ceil(image.width / 28) * Math.ceil(image.height / 28);
}

function paddingBatch(liveFixture) {
  const events = [];
  const payloads = {};
  const startedAt = Date.parse(liveFixture.padding.startedAt);
  for (let index = 0; index < liveFixture.padding.turns; index += 1) {
    const sequence = liveFixture.padding.sourceSequenceBase + index;
    const label = String(index).padStart(4, '0');
    const payloadRef = `${liveFixture.padding.payloadRefPrefix}-${label}`;
    const blocks = Array.from(
      { length: 14 },
      (_, block) => `${liveFixture.padding.sentence} Block ${block + 1} of padding turn ${index + 1} carries no decision value.`,
    );
    payloads[payloadRef] = { text: `Canary ${liveFixture.padding.canary}. ${blocks.join(' ')}` };
    events.push({
      schemaVersion: 1,
      eventId: `${liveFixture.padding.eventIdPrefix}-${label}`,
      sourceId: 'source-atlas-live',
      sourceEventId: `atlas-pad-${sequence}`,
      sourceSequence: sequence,
      ingestSequence: sequence,
      occurredAt: new Date(startedAt + index * 60_000).toISOString(),
      observedAt: new Date(startedAt + index * 60_000 + 250).toISOString(),
      scope: {
        profileId: liveFixture.profileId,
        projectId: liveFixture.projectId,
        worktreeId: liveFixture.worktreeId,
        sessionId: liveFixture.sessionId,
        sensitivity: 'normal',
      },
      kind: index % 2 === 0 ? 'user_utterance' : 'agent_message',
      payloadRef,
      contentHash: `sha256:atlas-pad-${sequence}`,
      trust: index % 2 === 0 ? 'user_explicit' : 'agent_reported',
    });
  }
  return { events, payloads };
}

const padding = paddingBatch(fixture);
const totalEvents = fixture.events.length + padding.events.length;
const liveBatch = {
  events: [...fixture.events, ...padding.events],
  payloads: { ...fixture.payloads, ...padding.payloads },
};

function timelineSpy(inner) {
  const stats = { calls: 0, items: 0 };
  return {
    stats,
    store: {
      ingest: (batch, options) => inner.ingest(batch, options),
      durableCursor: () => inner.durableCursor(),
      close: () => inner.close(),
      timeline: async (query) => {
        const items = await inner.timeline(query);
        stats.calls += 1;
        stats.items += items.length;
        return items;
      },
    },
  };
}

/**
 * Scripted stand-in for the bundled Reasoner: it only emits the Atlas decision when the request it
 * was handed actually carried the decision event and its text, so a grounded answer proves the
 * evidence reached the model. Every call is recorded and re-checked against B afterwards.
 */
function scriptedReasoner(mode) {
  const calls = [];
  const faults = [];
  const decision = {
    eventId: fixture.question.expectedEvidenceEventId,
    canary: fixture.question.expectedAnswerCanary,
  };
  return {
    calls,
    faults,
    async run(task, boundedContext, outputSchema) {
      const context = boundedContext ?? {};
      const call = {
        taskId: task.taskId,
        schemaTitle: outputSchema?.title,
        prompt: context.prompt,
        maxTokens: context.maxTokens,
        outputReservation: context.outputReservation,
        inputTokens: context.inputTokens,
        totalTokens: context.totalTokens,
        accounting: context.accounting,
        evidenceIds: context.evidenceIds,
      };
      calls.push(call);
      if (mode === 'crash') throw new Error('scripted model crash');
      if (mode === 'invalid-json') return '{"decisions": [ this is not valid JSON';
      const grounded = (call.evidenceIds ?? []).includes(decision.eventId)
        && (call.prompt ?? '').includes(decision.canary);
      if (call.schemaTitle === 'memory.extraction') {
        return grounded
          ? {
              decisions: [{
                question: 'Where does Atlas keep durable project memory?',
                choice: `One encrypted database per project. Canary ${decision.canary} marks this decision.`,
                sourceEventIds: [decision.eventId],
              }],
              facts: [{
                subject: 'atlas',
                predicate: 'memory.backend',
                object: `per-project encrypted database (${decision.canary})`,
                sourceEventIds: [decision.eventId],
              }],
              summary: `Segment carrying the Atlas storage decision ${decision.canary}.`,
            }
          : { decisions: [], facts: [], summary: 'Segment with no decision to extract.' };
      }
      if (call.schemaTitle === 'memory.answer') {
        return grounded
          ? { text: `On 2026-09-08 Atlas decided: ${decision.canary}.`, evidenceIds: [decision.eventId] }
          : { text: 'No supporting evidence was available.', evidenceIds: [] };
      }
      faults.push(`unexpected outputSchema title: ${JSON.stringify(call.schemaTitle)}`);
      return { decisions: [], facts: [], summary: '' };
    },
  };
}

const ACCOUNTING_SECTIONS = [
  'system', 'request', 'cards', 'dialogue', 'evidence', 'images', 'tools', 'reserve', 'output',
];

/** Asserts one Reasoner request obeyed the shared bounded-context invariant from §5.8. */
function assertBoundedCall(call, budget) {
  assert.equal(typeof call.maxTokens, 'number', `${call.taskId}: maxTokens must be measured`);
  assert.ok(call.maxTokens > 0 && call.maxTokens <= budget.ceiling, `${call.taskId}: maxTokens inside B`);
  assert.equal(typeof call.totalTokens, 'number', `${call.taskId}: totalTokens must be measured`);
  assert.ok(call.totalTokens <= call.maxTokens, `${call.taskId}: totalTokens must stay inside B`);
  assert.equal(typeof call.inputTokens, 'number', `${call.taskId}: inputTokens must be measured`);
  assert.equal(typeof call.outputReservation, 'number', `${call.taskId}: the output allowance must be reserved`);
  assert.ok(call.outputReservation > 0, `${call.taskId}: the output allowance is never zero`);
  assert.equal(
    call.totalTokens,
    call.inputTokens + call.outputReservation,
    `${call.taskId}: totalTokens must equal counted input plus the reservation`,
  );
  assert.ok(call.inputTokens <= budget.input, `${call.taskId}: input must stay inside the input cap`);
  assert.ok(typeof call.prompt === 'string' && call.prompt.length > 0, `${call.taskId}: the exact prompt travels`);
  assert.ok(call.accounting, `${call.taskId}: the context accounting travels`);
  for (const section of ACCOUNTING_SECTIONS) {
    assert.equal(typeof call.accounting[section], 'number', `${call.taskId}: accounting.${section} must be counted`);
  }
  const sum = Object.values(call.accounting).reduce((total, tokens) => total + tokens, 0);
  assert.equal(sum, call.totalTokens, `${call.taskId}: totalTokens must equal the sum of the accounting sections`);
}

function assembler() {
  return contextModule.createContextAssembler({ tokenizer, imageTokens: (image) => imageTokens(image) });
}

const contextBudget = contextModule.boundedBudget(MODEL);
assert.equal(contextBudget.ceiling, 8192, 'B = min(8192, floor(0.25 * 32768)) = 8192');
assert.equal(contextBudget.outputReservation, 2048, 'the 32K route reserves 2,048 output tokens');
assert.equal(contextBudget.input, 6144, 'the 32K route caps input at 6,144 tokens');
assert.equal(
  contextBudget.input + contextBudget.outputReservation,
  contextBudget.ceiling,
  'input plus output reservation must be exactly B',
);
assert.throws(
  () => contextModule.boundedBudget({ modelId: 'undeclared-capacity', contextCapacity: 0 }),
  'a model without a declared positive capacity must be rejected',
);

// AC1 + AC2: a grounded answer after a restart, every request inside B, no raw-log canary in a prompt.
const liveDirectory = mkdtempSync(join(tmpdir(), 'echopilot-m02-oracle-live-'));
try {
  const store = await storeModule.createMemoryStore({
    directory: liveDirectory,
    key: STORE_KEY,
    profileId: fixture.profileId,
  });
  const spy = timelineSpy(store);
  await spy.store.ingest(liveBatch);
  const reasoner = scriptedReasoner('ok');
  const consolidator = await consolidationModule.createMemoryConsolidator({
    projectId: fixture.projectId,
    directory: liveDirectory,
    store: spy.store,
    reasoner,
    assembler: assembler(),
    model: MODEL,
  });

  const consolidated = await consolidator.consolidate();
  assert.equal(consolidated.coverage.semantic, 'complete', 'a healthy model consolidates the live batch');
  assert.ok(spy.stats.items >= totalEvents, `consolidation must read the ingested events (read ${spy.stats.items})`);
  assert.ok(
    reasoner.calls.some((call) => call.schemaTitle === 'memory.extraction'),
    'live extraction must run through the Reasoner contract',
  );
  assert.equal(reasoner.faults.length, 0, `extraction requests violated the contract: ${reasoner.faults.join('; ')}`);
  for (const call of reasoner.calls) assertBoundedCall(call, contextBudget);

  const decision = (await consolidator.decisions()).find(
    (entry) => entry.sourceEventIds.includes(fixture.question.expectedEvidenceEventId),
  );
  assert.ok(decision, 'the extracted decision must keep its source event');
  assert.ok(decision.choice.includes(fixture.question.expectedAnswerCanary), 'the decision text is preserved');
  const projectCard = await consolidator.card('project');
  assert.ok(projectCard.includes(fixture.question.expectedAnswerCanary), 'the project card carries the decision');
  assert.ok(count(projectCard) <= 1200, 'the project card stays bounded');
  await consolidator.close();
  await spy.store.close();

  const restartedStore = await storeModule.createMemoryStore({
    directory: liveDirectory,
    key: STORE_KEY,
    profileId: fixture.profileId,
  });
  const restartSpy = timelineSpy(restartedStore);
  const restartReasoner = scriptedReasoner('ok');
  const restarted = await consolidationModule.createMemoryConsolidator({
    projectId: fixture.projectId,
    directory: liveDirectory,
    store: restartSpy.store,
    reasoner: restartReasoner,
    assembler: assembler(),
    model: MODEL,
  });
  assert.equal(restartReasoner.calls.length, 0, 'reopening a consolidated project must load persisted state');
  assert.equal(await restarted.card('project'), projectCard, 'the project card survives a restart unchanged');

  const answer = await restarted.answer({ question: fixture.question.text });
  assert.ok(
    restartSpy.stats.items <= ANSWER_READ_BOUND,
    `the answer must inspect at most ${ANSWER_READ_BOUND} bounded items, not the ${totalEvents}-event raw log `
      + `(read ${restartSpy.stats.items})`,
  );
  assert.equal(answer.supported, true, 'the dated question returns a supported answer after a restart');
  assert.ok(
    answer.evidenceIds.includes(fixture.question.expectedEvidenceEventId),
    'the supported answer cites the decision it was derived from',
  );
  assert.ok(answer.text.includes(fixture.question.expectedAnswerCanary), 'the answer is grounded in the decision');
  assert.ok(answer.usedTokens <= answer.maxTokens && answer.maxTokens <= contextBudget.ceiling, 'the answer obeys B');
  assert.equal(answer.coverage.semantic, 'complete', 'a supported answer over complete coverage says so');
  assert.ok(
    restartReasoner.calls.some((call) => call.schemaTitle === 'memory.answer'),
    'the grounded answer runs through the Reasoner contract',
  );
  for (const call of restartReasoner.calls) {
    assertBoundedCall(call, contextBudget);
    assert.equal(
      (call.prompt ?? '').includes(fixture.padding.canary),
      false,
      'a bounded request must not carry the raw log it never reread',
    );
  }
  assert.equal(restartReasoner.faults.length, 0, `answer requests violated the contract: ${restartReasoner.faults.join('; ')}`);
  await restarted.close();
  await restartSpy.store.close();
} finally {
  rmSync(liveDirectory, { recursive: true, force: true });
}

// AC3: failed JSON and model crashes keep deterministic state and mark semantic coverage partial.
for (const mode of ['invalid-json', 'crash']) {
  const directory = mkdtempSync(join(tmpdir(), `echopilot-m02-oracle-${mode}-`));
  try {
    const store = await storeModule.createMemoryStore({
      directory,
      key: STORE_KEY,
      profileId: fixture.profileId,
    });
    await store.ingest({ events: fixture.events, payloads: fixture.payloads });
    const reasoner = scriptedReasoner(mode);
    const consolidator = await consolidationModule.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store,
      reasoner,
      assembler: assembler(),
      model: MODEL,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.coverage.semantic, 'partial', `${mode}: a failed extraction marks coverage partial`);
    assert.ok(result.coverage.failedJobs.length > 0, `${mode}: the failed job is reported`);
    assert.equal((await consolidator.coverage()).semantic, 'partial', `${mode}: coverage stays partial until repaired`);
    const first = await consolidator.answer({ question: fixture.question.text });
    const second = await consolidator.answer({ question: fixture.question.text });
    assert.ok(
      first.text.includes(fixture.question.expectedAnswerCanary),
      `${mode}: an outage still produces a deterministic, evidence-backed answer`,
    );
    assert.ok(
      first.evidenceIds.includes(fixture.question.expectedEvidenceEventId),
      `${mode}: the fallback answer cites the stored decision`,
    );
    assert.equal(first.coverage.semantic, 'partial', `${mode}: the fallback discloses partial coverage`);
    assert.ok(first.usedTokens <= first.maxTokens, `${mode}: the fallback answer stays inside B`);
    assert.equal(second.text, first.text, `${mode}: repeated answers over unchanged state are identical`);
    assert.deepEqual([...second.evidenceIds], [...first.evidenceIds], `${mode}: repeated citations are identical`);
    await consolidator.close();
    await store.close();

    const restartedStore = await storeModule.createMemoryStore({
      directory,
      key: STORE_KEY,
      profileId: fixture.profileId,
    });
    const restarted = await consolidationModule.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store: restartedStore,
      reasoner: scriptedReasoner(mode),
      assembler: assembler(),
      model: MODEL,
    });
    assert.equal((await restarted.coverage()).semantic, 'partial', `${mode}: partial coverage survives a restart`);
    const afterRestart = await restarted.answer({ question: fixture.question.text });
    assert.equal(afterRestart.text, first.text, `${mode}: the deterministic answer survives a restart unchanged`);
    assert.deepEqual([...afterRestart.evidenceIds], [...first.evidenceIds], `${mode}: restart keeps the citations`);
    await restarted.close();
    await restartedStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- frozen node:test suites
const FROZEN_SUITES = [
  {
    path: join(REPO_ROOT, 'packages', 'memory', 'src', 'consolidation', 'acceptance.test.ts'),
    titles: [
      'bounded context budgeting obeys B=min(8192, floor(0.25*C)) and survives deliberately failed compaction',
      'a multi-turn live batch answers a dated project question after restart without the full raw log',
      'failed JSON and model crashes keep deterministic state and mark semantic coverage partial',
      'duplicate consolidation jobs neither re-run the model nor duplicate records',
      'an answer whose citations were never presented is replaced by the grounded fallback',
    ],
  },
  {
    path: join(REPO_ROOT, 'packages', 'memory', 'src', 'context', 'context-invariants.test.ts'),
    titles: [
      'a formatting overhead larger than the nominal allowance is measured exactly and never breaks B',
      'admitted images travel with the context they were charged for',
      'a deliberately failed compaction still leaves an exactly measured prompt',
    ],
  },
];
for (const suite of FROZEN_SUITES) {
  assert.ok(existsSync(suite.path), `the frozen suite must exist: ${suite.path}`);
  const source = readFileSync(suite.path, 'utf8');
  for (const title of suite.titles) {
    assert.ok(source.includes(title), `the frozen suite must keep its "${title}" test`);
  }
}
const expectedTitles = FROZEN_SUITES.reduce((total, suite) => total + suite.titles.length, 0);
assert.ok(expectedTitles >= 8, 'the frozen suite must keep its acceptance and invariant tests');

const suite = runChild([
  process.execPath,
  '--import',
  'tsx',
  '--test',
  '--test-reporter=tap',
  ...FROZEN_SUITES.map((entry) => entry.path),
]);
assert.equal(suite.status, 0, `the frozen node:test suite must pass:\n${suite.stdout}\n${suite.stderr}`);
assert.equal(/^not ok /m.test(suite.stdout), false, 'the frozen node:test suite must not report a failing test');
const passLines = suite.stdout.match(/^# pass \d+$/gm) ?? [];
const failLines = suite.stdout.match(/^# fail \d+$/gm) ?? [];
const passedTests = passLines.reduce((total, line) => total + Number(line.split(' ')[2]), 0);
const failedTests = failLines.reduce((total, line) => total + Number(line.split(' ')[2]), 0);
assert.equal(failedTests, 0, `the frozen node:test suite must have zero failures (${failedTests})`);
assert.ok(
  passedTests >= expectedTitles,
  `the frozen node:test suite must run all ${expectedTitles} tests (passed ${passedTests})`,
);

// ---------------------------------------------------------------- native oracle
const reasonerDirectory = join(REPO_ROOT, 'native', 'macos', 'Sources', 'Reasoner');
const nativeOracleMain = join(reasonerDirectory, 'test', 'main.swift');
assert.ok(existsSync(nativeOracleMain), `the native oracle must exist: ${nativeOracleMain}`);
const reasonerSources = readdirSync(reasonerDirectory)
  .filter((name) => name.endsWith('.swift') && name !== 'main.swift')
  .sort()
  .map((name) => join(reasonerDirectory, name));
assert.ok(reasonerSources.length >= 8, 'the production Reasoner sources must still be present');

const nativeBuild = mkdtempSync(join(tmpdir(), 'echopilot-m02-native-oracle-'));
try {
  const nativeBinary = join(nativeBuild, 'm02-native-oracle');
  const compile = runChild(
    [SWIFTC, '-module-cache-path', join(nativeBuild, 'module-cache'), '-o', nativeBinary, ...reasonerSources, nativeOracleMain],
  );
  assert.equal(compile.status, 0, `the native oracle must compile against the Reasoner sources:\n${compile.stderr}`);
  const native = runChild([nativeBinary], { allowBinary: nativeBinary });
  assert.equal(native.status, 0, `the native oracle must pass:\n${native.stdout}\n${native.stderr}`);
  const nativeChecks = (native.stdout.match(/^oracle ok: /gm) ?? []).length;
  assert.ok(nativeChecks >= 40, `the native oracle must run its checks (ran ${nativeChecks})`);
  assert.ok(
    native.stdout.includes('M02 native oracle ok'),
    'the native oracle must report success rather than exiting early',
  );
  console.log(`M02 oracle: frozen node:test suite passed (${passedTests} tests), native oracle passed (${nativeChecks} checks)`);
} finally {
  rmSync(nativeBuild, { recursive: true, force: true });
}

console.log('M02 oracle: all checks passed');
