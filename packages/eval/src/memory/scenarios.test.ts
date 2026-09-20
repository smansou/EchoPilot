/**
 * M05 acceptance oracle — the 100-scenario memory QA gate (ticket M05 acceptance criterion 1;
 * IMPLEMENTATION_PLAN.md §4.5 "Use a consented evaluation corpus with ... 100 temporal-memory
 * scenarios ... ≥90% correct temporal-memory answers with source support; zero unauthorized actions
 * or cross-project disclosures in the adversarial suite", and §6 "The assistant must expose the
 * incomplete coverage when answering about that interval").
 *
 * Test-role owned: the implementer never edits this file. It drives the frozen
 * packages/memory/src/retrieval/index.ts contract (documented in
 * packages/memory/src/retrieval/acceptance.test.ts) over a deterministic 100-scenario corpus:
 * 70 current answers, 15 explicit historical answers, 8 cross-project denial cases, 4 retained
 * decisions whose raw source expired, and 3 summaries degraded by a failed worker. No model,
 * network, or hardware call is made; the corpus is generated from a fixed seed and the answers are
 * composed only from the scenario records.
 *
 * The gate is stated the way §4.5 states it: at least 90% of the answerable scenarios must produce
 * the correct temporal answer with source support, and every cross-project scenario must be denied
 * explicitly with zero disclosure. Fabricated completeness fails: any scenario that cannot be
 * answered must come back unsupported with no evidence rather than an invented answer, and restored
 * coverage must never be claimed while a summary job is still failing.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

type Trust = 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
type RecordKind = 'fact' | 'decision' | 'task' | 'observation' | 'summary';

interface CapsuleRef {
  id: string;
  bytes: number;
}

interface RetrievalRecord {
  id: string;
  projectId: string;
  kind: RecordKind;
  text: string;
  trust: Trust;
  status?: 'active' | 'disputed' | 'superseded';
  occurredAt: string;
  validFrom?: string;
  validTo?: string;
  entities?: readonly string[];
  sourceEventIds: readonly string[];
  rawAvailable: boolean;
  capsule?: CapsuleRef;
}

interface RetrievalPage {
  records: readonly RetrievalRecord[];
  cursor?: string;
}

interface SourceCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
}

interface MemoryRetrievalSource {
  page(request: { projectId: string; cursor?: string; limit?: number }): Promise<RetrievalPage>;
  coverage?(): Promise<SourceCoverage>;
}

interface EvidenceSourceRef {
  eventId: string;
  kind: string;
  trust: string;
  occurredAt: string;
  rawAvailability: 'available' | 'expired';
}

interface EvidenceItem {
  id: string;
  projectId: string;
  kind: RecordKind;
  text: string;
  trust: Trust;
  score: number;
  tokens: number;
  sources: readonly EvidenceSourceRef[];
  capsule?: CapsuleRef;
}

interface RetrievalGap {
  kind: string;
  detail: string;
  recordIds?: readonly string[];
  jobIds?: readonly string[];
}

interface RetrievalCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
  gaps: readonly RetrievalGap[];
}

interface RetrievalAnswer {
  query: string;
  asOf: string;
  historical: boolean;
  items: readonly EvidenceItem[];
  tokens: number;
  denied: readonly { projectId: string; reason: string }[];
  coverage: RetrievalCoverage;
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
}

interface AnswerRequest {
  question: string;
  projectIds?: readonly string[];
  asOf?: string;
  limit?: number;
}

interface MemoryRetrieval {
  index(): Promise<{ indexed: number; generation: string }>;
  answer(request: AnswerRequest): Promise<RetrievalAnswer>;
  coverage(): Promise<RetrievalCoverage>;
  close(): Promise<void>;
}

interface RetrievalOptions {
  projectId: string;
  directory: string;
  source: MemoryRetrievalSource;
  grantedProjectIds?: readonly string[];
  tokenizer?: { count(text: string): number };
  now?: () => Date;
}

interface RetrievalModule {
  createMemoryRetrieval(options: RetrievalOptions): Promise<MemoryRetrieval>;
}

const ACTIVE_PROJECT = 'project-atlas';
const CORPUS_SIZE = 100;
const ACCURACY_GATE = 0.9;
const EVIDENCE_ITEM_CAP = 12;
const EVIDENCE_TOKEN_CAP = 1536;
const CAPSULE_LIMIT = 4096;
const NOW = new Date('2026-09-21T12:00:00.000Z');

const clock = (): Date => new Date(NOW.getTime());

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

const tokenizer = {
  count(text: string): number {
    return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
  },
};

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  const message = String((error as Error | undefined)?.message ?? '');
  return code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(message);
}

const MISSING_MODULE_MESSAGE = 'Missing required behavior: packages/memory/src/retrieval/index.ts must export '
  + 'createMemoryRetrieval({ projectId, grantedProjectIds?, directory, source, tokenizer?, now? }) with '
  + 'index(), answer(), coverage() and close(), so the 100-scenario memory QA gate can run.';

async function loadRetrievalModule(): Promise<RetrievalModule> {
  const specifier = '../../../memory/src/retrieval/index.js';
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    if (isModuleNotFound(error)) assert.fail(MISSING_MODULE_MESSAGE);
    throw error;
  }
  assert.equal(typeof loaded.createMemoryRetrieval, 'function', MISSING_MODULE_MESSAGE);
  return loaded as unknown as RetrievalModule;
}

const temporaryDirectories: string[] = [];

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPIC_HEADS = [
  'gateway-timeout', 'ledger-retry', 'parser-shard', 'telemetry-batch', 'exporter-spool',
  'scheduler-arena', 'replica-digest', 'sandbox-journal', 'cursor-checkpoint', 'manifest-replica',
] as const;

function hex(random: () => number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) out += '0123456789abcdef'[Math.floor(random() * 16)];
  return out;
}

type ScenarioKind = 'current' | 'historical' | 'cross_project' | 'expired_raw' | 'worker_failure';

interface QaScenario {
  id: string;
  kind: ScenarioKind;
  topic: string;
  records: readonly RetrievalRecord[];
  question: string;
  asOf?: string;
  projectIds?: readonly string[];
  grantedProjectIds?: readonly string[];
  coverage?: SourceCoverage;
  expectedEvidenceIds: readonly string[];
  expectedFacts: readonly string[];
  expectedForbiddenTexts: readonly string[];
  expectedDeniedProjectIds?: readonly string[];
  expectedGaps?: readonly string[];
  expectedFailedJobs?: readonly string[];
  expectedCoverage?: 'complete' | 'partial';
  requiresCapsule?: boolean;
}

function record(input: {
  id: string;
  projectId?: string;
  kind?: RecordKind;
  text: string;
  trust?: Trust;
  status?: 'active' | 'disputed' | 'superseded';
  daysAgo: number;
  validToDaysAgo?: number;
  rawAvailable?: boolean;
  capsuleBytes?: number;
}): RetrievalRecord {
  const entry: RetrievalRecord = {
    id: input.id,
    projectId: input.projectId ?? ACTIVE_PROJECT,
    kind: input.kind ?? 'decision',
    text: input.text,
    trust: input.trust ?? 'user_explicit',
    occurredAt: daysBefore(input.daysAgo),
    validFrom: daysBefore(input.daysAgo),
    sourceEventIds: [`evt-${input.id}`],
    rawAvailable: input.rawAvailable ?? true,
  };
  if (input.status !== undefined) entry.status = input.status;
  if (input.validToDaysAgo !== undefined) entry.validTo = daysBefore(input.validToDaysAgo);
  if (input.capsuleBytes !== undefined) entry.capsule = { id: `capsule-${input.id}`, bytes: input.capsuleBytes };
  return entry;
}

function buildQaCorpus(): { scenarios: QaScenario[]; byKind: Record<ScenarioKind, QaScenario[]> } {
  const random = mulberry32(0x4d05);
  const scenarios: QaScenario[] = [];

  for (let index = 0; index < 70; index += 1) {
    const id = `memqa-current-${String(index).padStart(3, '0')}`;
    const topic = `${TOPIC_HEADS[index % TOPIC_HEADS.length]}-${hex(random, 6)}`;
    const oldValue = `VALUE-${id}-BEFORE-${hex(random, 8)}`;
    const currentValue = `VALUE-${id}-NOW-${hex(random, 8)}`;
    scenarios.push({
      id,
      kind: 'current',
      topic,
      records: [
        record({
          id: `rec-${id}-old`,
          text: `Earlier note: ${topic} was set to ${oldValue}.`,
          trust: 'agent_reported',
          status: 'superseded',
          daysAgo: 30,
          validToDaysAgo: 5,
        }),
        record({
          id: `rec-${id}-now`,
          text: `Settled: ${topic} is now set to ${currentValue}.`,
          daysAgo: 5,
        }),
      ],
      question: `What did we settle for ${topic}?`,
      expectedEvidenceIds: [`rec-${id}-now`],
      expectedFacts: [currentValue],
      expectedForbiddenTexts: [oldValue],
      expectedCoverage: 'complete',
    });
  }

  for (let index = 0; index < 15; index += 1) {
    const id = `memqa-historical-${String(index).padStart(3, '0')}`;
    const topic = `${TOPIC_HEADS[(index + 3) % TOPIC_HEADS.length]}-${hex(random, 6)}`;
    const oldValue = `VALUE-${id}-THEN-${hex(random, 8)}`;
    const currentValue = `VALUE-${id}-LATER-${hex(random, 8)}`;
    scenarios.push({
      id,
      kind: 'historical',
      topic,
      records: [
        record({
          id: `rec-${id}-old`,
          text: `Settled: ${topic} was set to ${oldValue}.`,
          status: 'superseded',
          daysAgo: 40,
          validToDaysAgo: 4,
        }),
        record({
          id: `rec-${id}-now`,
          text: `Settled: ${topic} is now set to ${currentValue}.`,
          daysAgo: 4,
        }),
      ],
      question: `What did we settle for ${topic}?`,
      asOf: daysBefore(20),
      expectedEvidenceIds: [`rec-${id}-old`],
      expectedFacts: [oldValue],
      expectedForbiddenTexts: [currentValue],
      expectedCoverage: 'complete',
    });
  }

  for (let index = 0; index < 8; index += 1) {
    const id = `memqa-cross-project-${String(index).padStart(3, '0')}`;
    const topic = `${TOPIC_HEADS[(index + 6) % TOPIC_HEADS.length]}-${hex(random, 6)}`;
    const foreignProjectId = `project-borealis-${index}`;
    const foreignValue = `${id.toUpperCase()}-CANARY-${hex(random, 8)}`;
    const activeValue = `VALUE-${id}-ATLAS-${hex(random, 8)}`;
    scenarios.push({
      id,
      kind: 'cross_project',
      topic,
      records: [
        record({ id: `rec-${id}-atlas`, text: `Settled: ${topic} is set to ${activeValue}.`, daysAgo: 6 }),
        record({
          id: `rec-${id}-foreign`,
          projectId: foreignProjectId,
          text: `Borealis secret: ${topic} is set to ${foreignValue}.`,
          trust: 'agent_reported',
          daysAgo: 5,
        }),
      ],
      question: `What did we settle for ${topic}?`,
      projectIds: [foreignProjectId],
      expectedEvidenceIds: [],
      expectedFacts: [],
      expectedForbiddenTexts: [foreignValue, `${id.toUpperCase()}-CANARY`],
      expectedDeniedProjectIds: [foreignProjectId],
      expectedCoverage: 'complete',
    });
  }

  for (let index = 0; index < 4; index += 1) {
    const id = `memqa-expired-raw-${String(index).padStart(3, '0')}`;
    const topic = `${TOPIC_HEADS[(index + 1) % TOPIC_HEADS.length]}-${hex(random, 6)}`;
    const value = `SEALED-${id}-${hex(random, 8)}`;
    scenarios.push({
      id,
      kind: 'expired_raw',
      topic,
      records: [
        record({
          id: `rec-${id}`,
          text: `Decision: ${topic} keeps its checkpoint in the ${value} journal.`,
          daysAgo: 5,
          rawAvailable: false,
          capsuleBytes: 2048,
        }),
      ],
      question: `Where does ${topic} keep its checkpoint?`,
      expectedEvidenceIds: [`rec-${id}`],
      expectedFacts: [value],
      expectedForbiddenTexts: [],
      expectedGaps: ['raw_source_expired'],
      requiresCapsule: true,
    });
  }

  for (let index = 0; index < 3; index += 1) {
    const id = `memqa-worker-failure-${String(index).padStart(3, '0')}`;
    const topic = `${TOPIC_HEADS[(index + 8) % TOPIC_HEADS.length]}-${hex(random, 6)}`;
    const value = `VALUE-${id}-PARTIAL-${hex(random, 8)}`;
    scenarios.push({
      id,
      kind: 'worker_failure',
      topic,
      records: [
        record({ id: `rec-${id}`, text: `Settled: ${topic} is set to ${value}.`, daysAgo: 3 }),
      ],
      question: `What did we settle for ${topic}?`,
      coverage: { semantic: 'partial', failedJobs: [`job-${id}`] },
      expectedEvidenceIds: [`rec-${id}`],
      expectedFacts: [value],
      expectedForbiddenTexts: [],
      expectedGaps: ['summary_failed'],
      expectedFailedJobs: [`job-${id}`],
      expectedCoverage: 'partial',
    });
  }

  const byKind: Record<ScenarioKind, QaScenario[]> = {
    current: [],
    historical: [],
    cross_project: [],
    expired_raw: [],
    worker_failure: [],
  };
  for (const scenario of scenarios) byKind[scenario.kind].push(scenario);
  return { scenarios, byKind };
}

function recordsSource(records: readonly RetrievalRecord[], coverage?: SourceCoverage): MemoryRetrievalSource {
  const source: MemoryRetrievalSource = {
    async page(request) {
      assert.ok(
        request.limit === undefined || (Number.isInteger(request.limit) && request.limit > 0),
        `the evaluation source must be asked for a bounded page, received limit=${String(request.limit)}`,
      );
      const projectRecords = records.filter((entry) => entry.projectId === request.projectId);
      const start = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
      assert.ok(Number.isInteger(start) && start >= 0, `invalid evaluation cursor ${String(request.cursor)}`);
      const requested = request.limit ?? 1_000;
      const slice = projectRecords.slice(start, start + requested);
      const next = start + slice.length < projectRecords.length ? String(start + slice.length) : undefined;
      return next === undefined ? { records: slice } : { records: slice, cursor: next };
    },
  };
  if (coverage !== undefined) {
    source.coverage = async () => ({ semantic: coverage.semantic, failedJobs: [...coverage.failedJobs] });
  }
  return source;
}

interface ScenarioOutcome {
  id: string;
  kind: ScenarioKind;
  passed: boolean;
  detail: string;
}

function scoreScenario(scenario: QaScenario, answer: RetrievalAnswer): ScenarioOutcome {
  const problems: string[] = [];
  const serialized = JSON.stringify(answer);
  for (const forbidden of scenario.expectedForbiddenTexts) {
    if (serialized.includes(forbidden)) problems.push(`disclosed ${forbidden}`);
  }

  if (scenario.kind === 'cross_project') {
    if (answer.items.length !== 0) problems.push(`a denied request returned ${answer.items.length} items`);
    if (answer.evidenceIds.length !== 0) problems.push('a denied request returned evidence ids');
    if (answer.supported) problems.push('a denied request was answered as supported');
    const deniedIds = answer.denied.map((entry) => entry.projectId);
    for (const expected of scenario.expectedDeniedProjectIds ?? []) {
      if (!deniedIds.includes(expected)) problems.push(`no explicit denial for ${expected}`);
    }
    if (answer.denied.some((entry) => entry.reason !== 'cross_project_denied')) {
      problems.push('every denial must carry the cross_project_denied reason');
    }
    return { id: scenario.id, kind: scenario.kind, passed: problems.length === 0, detail: problems.join('; ') };
  }

  if (!answer.supported) problems.push('the scenario is answerable, so the answer must be supported');
  const cited = new Set(answer.evidenceIds);
  const itemIds = new Set(answer.items.map((item) => item.id));
  for (const expected of scenario.expectedEvidenceIds) {
    if (!cited.has(expected)) problems.push(`missing evidence ${expected}`);
    if (!itemIds.has(expected)) problems.push(`missing item ${expected}`);
  }
  for (const fact of scenario.expectedFacts) {
    if (!answer.text.includes(fact)) problems.push(`the answer text omits ${fact}`);
  }
  for (const gapKind of scenario.expectedGaps ?? []) {
    if (!answer.coverage.gaps.some((gap) => gap.kind === gapKind)) problems.push(`missing ${gapKind} gap`);
  }
  for (const jobId of scenario.expectedFailedJobs ?? []) {
    if (!answer.coverage.failedJobs.includes(jobId)) problems.push(`missing failed job ${jobId}`);
  }
  if (scenario.expectedCoverage !== undefined && answer.coverage.semantic !== scenario.expectedCoverage) {
    problems.push(`coverage ${answer.coverage.semantic} does not match expected ${scenario.expectedCoverage}`);
  }
  if (scenario.requiresCapsule === true) {
    const item = answer.items.find((candidate) => candidate.capsule !== undefined);
    if (item?.capsule === undefined) {
      problems.push('a retained decision must keep its small supporting capsule');
    } else {
      if (item.capsule.bytes <= 0 || item.capsule.bytes > CAPSULE_LIMIT) {
        problems.push(`capsule size ${item.capsule.bytes} is outside the 1..${CAPSULE_LIMIT} bound`);
      }
      if (item.sources.length === 0 || item.sources.some((source) => source.rawAvailability !== 'expired')) {
        problems.push('an expired raw source must be labeled unavailable on every source');
      }
    }
  }
  if (answer.tokens > EVIDENCE_TOKEN_CAP) problems.push(`the answer used ${answer.tokens} tokens over the ${EVIDENCE_TOKEN_CAP} cap`);
  if (answer.items.length > EVIDENCE_ITEM_CAP) problems.push(`the answer selected ${answer.items.length} items over the ${EVIDENCE_ITEM_CAP} cap`);
  return { id: scenario.id, kind: scenario.kind, passed: problems.length === 0, detail: problems.join('; ') };
}

async function runScenario(module: RetrievalModule, scenario: QaScenario, index: number): Promise<ScenarioOutcome> {
  const directory = await makeDirectory(`m05-memqa-${String(index).padStart(3, '0')}-`);
  const options: RetrievalOptions = {
    projectId: ACTIVE_PROJECT,
    directory,
    source: recordsSource(scenario.records, scenario.coverage),
    tokenizer,
    now: clock,
  };
  if (scenario.grantedProjectIds !== undefined) options.grantedProjectIds = scenario.grantedProjectIds;
  const retrieval = await module.createMemoryRetrieval(options);
  try {
    await retrieval.index();
    const request: AnswerRequest = { question: scenario.question };
    if (scenario.asOf !== undefined) request.asOf = scenario.asOf;
    if (scenario.projectIds !== undefined) request.projectIds = scenario.projectIds;
    const answer = await retrieval.answer(request);
    return scoreScenario(scenario, answer);
  } finally {
    await retrieval.close();
  }
}

function failureLines(outcomes: readonly ScenarioOutcome[], limit: number): string[] {
  return outcomes.filter((outcome) => !outcome.passed)
    .map((outcome) => `${outcome.id}: ${outcome.detail}`)
    .slice(0, limit);
}

test('the 100-scenario memory QA corpus meets the section 4.5 temporal-answer gate with source support', async (t) => {
  const module = await loadRetrievalModule();
  const { scenarios, byKind } = buildQaCorpus();
  assert.equal(scenarios.length, CORPUS_SIZE,
    'the memory evaluation must run the 100 temporal-memory scenarios §4.5 requires');
  assert.ok(byKind.current.length >= 60, 'the corpus is mostly current questions');
  assert.ok(byKind.historical.length >= 15, 'the corpus must include explicit historical queries');
  assert.ok(byKind.cross_project.length >= 8, 'the corpus must include adversarial cross-project denials');
  assert.ok(byKind.expired_raw.length >= 4, 'the corpus must include expired raw sources');
  assert.ok(byKind.worker_failure.length >= 3, 'the corpus must include a failed summary worker');

  const outcomes: ScenarioOutcome[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    outcomes.push(await runScenario(module, scenario, index));
  }
  const answerable = outcomes.filter((outcome) => outcome.kind !== 'cross_project');
  const correct = answerable.filter((outcome) => outcome.passed);
  const accuracy = correct.length / answerable.length;
  t.diagnostic(`temporal-memory answers ${correct.length}/${answerable.length} `
    + `(${(accuracy * 100).toFixed(1)}%) over ${scenarios.length} scenarios`);
  assert.ok(accuracy >= ACCURACY_GATE,
    `the section 4.5 gate requires ≥${ACCURACY_GATE * 100}% correct temporal answers with source support; `
    + `measured ${(accuracy * 100).toFixed(1)}% — first failures: ${failureLines(answerable, 3).join(' | ') || '(none)'}`);
});

test('cross-project denial holds across the adversarial suite with zero disclosures', async (t) => {
  const module = await loadRetrievalModule();
  const { byKind } = buildQaCorpus();
  const outcomes: ScenarioOutcome[] = [];
  for (const [index, scenario] of byKind.cross_project.entries()) {
    outcomes.push(await runScenario(module, scenario, 120 + index));
  }
  const failed = outcomes.filter((outcome) => !outcome.passed);
  t.diagnostic(`cross-project denial ${outcomes.length - failed.length}/${outcomes.length} without disclosure`);
  assert.deepEqual(failureLines(outcomes, outcomes.length), [],
    'every adversarial cross-project request must be denied explicitly with zero disclosure');

  const sample = byKind.cross_project[0];
  assert.ok(sample !== undefined, 'the adversarial suite must contain a cross-project scenario');
  const foreignProjectId = sample.expectedDeniedProjectIds?.[0];
  assert.ok(foreignProjectId !== undefined, 'the sample scenario must name the foreign project');
  const foreignRecords = sample.records.filter((entry) => entry.projectId === foreignProjectId);
  assert.ok(foreignRecords.length > 0, 'the sample scenario must hold foreign project records');
  const directory = await makeDirectory('m05-memqa-granted-');
  const granted = await module.createMemoryRetrieval({
    projectId: ACTIVE_PROJECT,
    directory,
    source: recordsSource(foreignRecords),
    grantedProjectIds: [foreignProjectId],
    tokenizer,
    now: clock,
  });
  try {
    await granted.index();
    const grantedAnswer = await granted.answer({ question: sample.question, projectIds: [foreignProjectId] });
    assert.equal(grantedAnswer.supported, true,
      'an explicitly granted project is searchable; denial is about scope, not about the query');
    assert.ok(grantedAnswer.items.length > 0);
    assert.ok(grantedAnswer.items.every((item) => item.projectId === foreignProjectId));
    assert.deepEqual([...grantedAnswer.denied], []);
  } finally {
    await granted.close();
  }
});

test('an unsupported question is reported unsupported with no evidence instead of an invented answer', async () => {
  const module = await loadRetrievalModule();
  const directory = await makeDirectory('m05-memqa-unsupported-');
  const unrelated = record({
    id: 'rec-unrelated-eval',
    text: 'Unrelated note: the sandbox fixture rebuilds nightly and the manifest is regenerated.',
    daysAgo: 8,
  });
  const retrieval = await module.createMemoryRetrieval({
    projectId: ACTIVE_PROJECT,
    directory,
    source: recordsSource([unrelated]),
    tokenizer,
    now: clock,
  });
  try {
    await retrieval.index();
    const question = 'What is the deployment key for component-unknown-zzz?';
    const first = await retrieval.answer({ question });
    assert.equal(first.supported, false, 'no evidence must never be answered as verified');
    assert.deepEqual([...first.evidenceIds], []);
    assert.deepEqual(first.items.map((item) => item.id), []);
    assert.ok(!first.text.includes(unrelated.text),
      'an unsupported answer must not quote unrelated memory as if it answered the question');
    assert.ok(!first.text.includes('manifest is regenerated'));
    for (let run = 0; run < 3; run += 1) {
      const next = await retrieval.answer({ question });
      assert.equal(next.text, first.text, 'repeated unsupported answers must stay identical');
      assert.equal(next.tokens, first.tokens);
      assert.ok(next.tokens <= EVIDENCE_TOKEN_CAP);
    }
  } finally {
    await retrieval.close();
  }
});

test('expired raw sources and failed summary workers stay visible instead of fabricating completeness', async (t) => {
  const module = await loadRetrievalModule();
  const { byKind } = buildQaCorpus();
  const scenarios = [...byKind.expired_raw, ...byKind.worker_failure];
  const outcomes: ScenarioOutcome[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    outcomes.push(await runScenario(module, scenario, 200 + index));
  }
  const failed = outcomes.filter((outcome) => !outcome.passed);
  t.diagnostic(`degraded scenarios reported their gap ${scenarios.length - failed.length}/${scenarios.length}`);
  assert.deepEqual(failureLines(outcomes, outcomes.length), [],
    'a retained decision with expired raw sources and a failed summary worker must both stay visible as gaps');
});
