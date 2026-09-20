/**
 * M04 acceptance test — inspect/correct a memory → updated temporal state → different evidence-backed
 * answer (ticket M04; IMPLEMENTATION_PLAN.md §3.2 M-F4/M-F5, §4.2 Memory, §5.8 memory schema and
 * evidence hierarchy).
 *
 * Red baseline: packages/memory/src/records/index.ts does not exist yet, so this file reports the
 * missing behavior as explicit named assertions instead of failing as a bare module-resolution
 * crash, exactly like the M01/M02/M03 red baselines. No model, network, or hardware call is made:
 * the derived-record seam is exercised by a deterministic fixture stand-in.
 *
 * Frozen contract
 * ---------------
 * packages/memory/src/records/index.ts
 *
 *   createMemoryRecords({ projectId, directory, store, source, extractionVersion }) -> Promise<MemoryRecords>
 *     store             — the M01 MemoryStore. Its raw normalized events (kind, trust, occurredAt)
 *                         and its deterministically reduced task records are the only source of
 *                         observed receipts; a reopened store returns identical evidence.
 *     source            — the derived-record seam. The M02 MemoryConsolidator is structurally
 *                         compatible; the oracle passes a deterministic stand-in so no model call is
 *                         needed:
 *                           facts()     -> [{ id, subject, predicate, object, sourceEventIds }]
 *                           decisions() -> [{ id, question, choice, sourceEventIds }]
 *                           coverage()  -> { semantic: 'complete' | 'partial', failedJobs }
 *     extractionVersion — non-empty label of the extractor/model+prompt version that produced the
 *                         derived records; every displayed summary and every answer reports it.
 *     Records-owned durable state (corrections, validity, disputed/superseded status) lives under
 *     `directory` and survives close/reopen; it never rewrites the M01 schema or its events.
 *
 *   MemoryRecords:
 *     summaries() -> MemorySummary[] — one displayed row per derived fact, derived decision, and
 *         observed task (never a duplicate row for the same record), including superseded and
 *         disputed rows so history stays inspectable:
 *           { id, kind: 'fact' | 'decision' | 'task', text, status: 'active' | 'disputed' | 'superseded',
 *             trust: 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported',
 *             question?, choice?, subject?, predicate?, object?,
 *             taskStatus?: 'running' | 'passed' | 'failed' | 'unknown',
 *             sources: string[],                      // raw event ids, never empty
 *             provenance: MemorySourceRef[],          // exactly one entry per source
 *             extractionVersion: string,              // === the configured version, never empty
 *             coverage: { semantic, failedJobs },     // the source's coverage, partial or complete
 *             validFrom: string, validTo?: string, supersedesId?: string }
 *           MemorySourceRef = { eventId, kind, trust, occurredAt, rawAvailability }
 *             rawAvailability 'available' when the store still holds the raw event, otherwise
 *             'expired' with trust 'imported' and kind 'unknown'; an unavailable source is labeled
 *             instead of hidden or crashed on.
 *         A task summary carries subject = the external task id, taskStatus/status from the M01
 *         receipt reduction, and trust computed from its receipt events.
 *
 *     summary(id) -> MemorySummary | undefined — navigates to history by id.
 *
 *     answer({ question, asOf? }) -> { question, asOf, text, supported, evidenceIds, conflicts,
 *         coverage, extractionVersion }
 *         Selects the displayed summaries whose question (decisions) or subject (facts/tasks) is
 *         referenced by the request, filters them by validity at `asOf` (default: now) and reports:
 *           - the updated answer after a correction,
 *           - the preserved historical answer for an `asOf` inside the superseded record's interval,
 *           - `text` includes the text of every summary it reports,
 *           - `evidenceIds` drawn only from the reported records' sources,
 *           - `conflicts` containing the ids of disputed records that bear on the question,
 *           - `supported: false` with no evidence when no record matches,
 *           - coverage and extractionVersion propagated from the displayed summaries.
 *
 *     reviseDecision({ decisionId, choice, rationale?, actor: 'user', occurredAt? }) -> MemorySummary
 *         Records the correction as a new explicit normalized `decision` event (trust
 *         'user_explicit') in the M01 store — never an in-place rewrite: the replaced record becomes
 *         'superseded' with validTo set, the returned record is 'active' with supersedesId pointing
 *         at it, and the original raw event remains stored and historically answerable.
 *
 *     coverage() -> { semantic, failedJobs };  close() -> Promise<void>
 *
 * Evidence hierarchy (§5.8): user_explicit > tool_observed > agent_reported > imported. A derived
 * claim that collides with a stronger record (same subject+predicate for facts, same question for
 * decisions, or a subject equal to an observed task id) is 'disputed' and can never overwrite the
 * stronger active record. A later user correction supersedes the earlier interpretation while
 * keeping its historical validity. "No evidence" is never stated as verified.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMemoryStore, type MemoryStore } from '../store/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/memory/temporal/temporal-corrections.json', import.meta.url);
const PROFILE_ID = 'profile-temporal';
const PROJECT_ID = 'project-temporal';
/** Synthetic key material; the fixture and this store are the only data involved. */
const STORE_KEY = '3d9c1b7a5e2f40689b1d3c5e7a90b2d4f6c8e0a2b4d6f8c0e2a4b6d8f0c2e4a6';
/** The extractor label every displayed summary and answer must reveal. */
const EXTRACTION_VERSION = 'qwen3.5-4b-q4/memory.extraction@1';
/** An instant inside the original decision's validity interval, before the recorded reversal. */
const HISTORICAL_AS_OF = '2026-09-11T00:00:00.000Z';
const ORIGINAL_DECISION_EVENT = 'evt-temporal-decision-001';
const USER_FACT_EVENT = 'evt-temporal-user-fact-004';
const AGENT_FACT_CLAIM_EVENT = 'evt-temporal-agent-fact-claim-005';
const RECEIPT_EVENT = 'evt-temporal-receipt-002';
const AGENT_TASK_CLAIM_EVENT = 'evt-temporal-agent-task-claim-003';
const TASK_ID = 'task-atlas-temporal-smoke';
const ORIGINAL_DECISION_RECORD = 'decision-atlas-polling';
const USER_FACT_RECORD = 'fact-atlas-durable-memory-user';
const AGENT_FACT_CLAIM_RECORD = 'fact-atlas-durable-memory-agent-claim';
const AGENT_TASK_CLAIM_RECORD = 'fact-atlas-smoke-agent-claim';
const EXPIRED_SOURCE_RECORD = 'fact-atlas-legacy-exporter';

type EvidenceTrust = 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
type SummaryKind = 'fact' | 'decision' | 'task';
type SummaryStatus = 'active' | 'disputed' | 'superseded';
type Coverage = { semantic: 'complete' | 'partial'; failedJobs: readonly string[] };

type MemorySourceRef = {
  eventId: string;
  kind: string;
  trust: EvidenceTrust;
  occurredAt: string;
  rawAvailability: 'available' | 'expired';
};

type MemorySummary = {
  id: string;
  kind: SummaryKind;
  text: string;
  status: SummaryStatus;
  trust: EvidenceTrust;
  question?: string;
  choice?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  taskStatus?: 'running' | 'passed' | 'failed' | 'unknown';
  sources: readonly string[];
  provenance: readonly MemorySourceRef[];
  extractionVersion: string;
  coverage: Coverage;
  validFrom: string;
  validTo?: string;
  supersedesId?: string;
};

type TemporalAnswer = {
  question: string;
  asOf: string;
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
  conflicts: readonly string[];
  coverage: Coverage;
  extractionVersion: string;
};

type DerivedFactClaim = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  status?: string;
  sourceEventIds: readonly string[];
};

type DerivedDecisionClaim = {
  id: string;
  question: string;
  choice: string;
  status?: string;
  sourceEventIds: readonly string[];
};

type DerivedMemorySource = {
  facts(): Promise<readonly DerivedFactClaim[]>;
  decisions(): Promise<readonly DerivedDecisionClaim[]>;
  coverage(): Promise<Coverage>;
};

type ReviseDecisionRequest = {
  decisionId: string;
  choice: string;
  rationale?: string;
  actor: 'user';
  occurredAt?: string;
};

type MemoryRecords = {
  summaries(): Promise<readonly MemorySummary[]>;
  summary(id: string): Promise<MemorySummary | undefined>;
  answer(request: { question: string; asOf?: string }): Promise<TemporalAnswer>;
  reviseDecision(request: ReviseDecisionRequest): Promise<MemorySummary>;
  coverage(): Promise<Coverage>;
  close(): Promise<void>;
};

type RecordsModule = {
  createMemoryRecords(options: {
    projectId: string;
    directory: string;
    store: MemoryStore;
    source: DerivedMemorySource;
    extractionVersion: string;
  }): Promise<MemoryRecords>;
};

type FixtureEvent = {
  schemaVersion: 1;
  eventId: string;
  sourceId: string;
  sourceEventId: string;
  sourceSequence: number;
  ingestSequence: number;
  occurredAt: string;
  observedAt: string;
  scope: {
    profileId: string;
    projectId?: string;
    worktreeId?: string;
    sessionId?: string;
    sensitivity: 'normal' | 'private' | 'secret';
  };
  kind: string;
  payloadRef: string;
  contentHash: string;
  trust: EvidenceTrust;
};

type TemporalFixture = {
  contractVersion: number;
  fixtureId: string;
  profileId: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
  canaries: {
    originalChoice: string;
    revisedChoice: string;
    userFact: string;
    agentClaim: string;
    failedReceipt: string;
    expiredSource: string;
  };
  questions: { polling: string; memory: string; unrelated: string };
  reversal: {
    decisionId: string;
    question: string;
    choice: string;
    rationale: string;
    actor: 'user';
    occurredAt: string;
  };
  events: FixtureEvent[];
  payloads: Record<string, unknown>;
  derived: {
    facts: DerivedFactClaim[];
    decisions: DerivedDecisionClaim[];
    coverage: { semantic: 'complete' | 'partial'; failedJobs: string[] };
  };
};

/**
 * Loads the yet-to-be-implemented records module. The specifier is computed so a module that does
 * not exist yet surfaces as the named assertion below instead of a TypeScript resolution error in
 * the red baseline.
 */
async function loadRecordsModule(): Promise<RecordsModule> {
  const specifier = './index.js';
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/memory/src/records/index.ts must export '
        + 'createMemoryRecords({ projectId, directory, store, source, extractionVersion }) with '
        + 'summaries(), summary(id), answer({ question, asOf? }), reviseDecision(), coverage(), close().',
      );
    }
    throw error;
  }
  assert.equal(
    typeof loaded.createMemoryRecords,
    'function',
    'packages/memory/src/records must export createMemoryRecords({ projectId, directory, store, source, extractionVersion })',
  );
  return loaded as unknown as RecordsModule;
}

async function loadTemporalFixture(): Promise<TemporalFixture> {
  const raw = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as TemporalFixture;
  assert.equal(raw.contractVersion, 1, 'the checked-in fixture uses the v1 normalized-event contract');
  assert.equal(raw.profileId, PROFILE_ID, 'the fixture profile must match the store profile under test');
  assert.equal(raw.projectId, PROJECT_ID, 'the fixture project must match the project under test');
  assert.ok(raw.events.length >= 6, 'the fixture must contain the reversal, receipt, and conflicting-claim events');
  const serialized = JSON.stringify(raw);
  for (const [name, canary] of Object.entries(raw.canaries)) {
    assert.ok(serialized.includes(canary), `the fixture must carry the ${name} canary`);
  }
  for (const event of raw.events) {
    assert.ok(event.payloadRef in raw.payloads, `fixture payload ${event.payloadRef} is missing`);
    assert.equal(event.scope.profileId, PROFILE_ID, `event ${event.eventId} belongs to the fixture profile`);
  }
  assert.equal(
    raw.derived.facts.some((fact) => fact.sourceEventIds.includes('evt-temporal-expired-raw-000')),
    true,
    'the fixture must keep one record whose raw source no longer exists',
  );
  assert.equal(
    raw.events.some((event) => event.eventId === 'evt-temporal-expired-raw-000'),
    false,
    'the expired raw source must genuinely be absent from the stored events',
  );
  return raw;
}

/** Deterministic stand-in for the M02 consolidator: same structural seam, no model call. */
function temporalSource(fixture: TemporalFixture): DerivedMemorySource {
  return {
    async facts() {
      return fixture.derived.facts.map((fact) => ({ ...fact, sourceEventIds: [...fact.sourceEventIds] }));
    },
    async decisions() {
      return fixture.derived.decisions.map((decision) => ({ ...decision, sourceEventIds: [...decision.sourceEventIds] }));
    },
    async coverage() {
      return { semantic: fixture.derived.coverage.semantic, failedJobs: [...fixture.derived.coverage.failedJobs] };
    },
  };
}

async function openStore(directory: string): Promise<MemoryStore> {
  return createMemoryStore({ directory, key: STORE_KEY, profileId: PROFILE_ID });
}

async function openRecords(
  recordsModule: RecordsModule,
  fixture: TemporalFixture,
  directory: string,
): Promise<{ store: MemoryStore; records: MemoryRecords }> {
  const store = await openStore(directory);
  await store.ingest({ events: fixture.events, payloads: fixture.payloads });
  const records = await recordsModule.createMemoryRecords({
    projectId: fixture.projectId,
    directory,
    store,
    source: temporalSource(fixture),
    extractionVersion: EXTRACTION_VERSION,
  });
  return { store, records };
}

function indexSummaries(summaries: readonly MemorySummary[]): Map<string, MemorySummary> {
  return new Map(summaries.map((summary) => [summary.id, summary]));
}

function requireSummaryIn(summaries: ReadonlyMap<string, MemorySummary>, id: string): MemorySummary {
  const summary = summaries.get(id);
  if (summary === undefined) assert.fail(`summary ${id} must be displayed by the inspector`);
  return summary;
}

test('reversing a decision preserves its historical answer while updating the current answer', async () => {
  const recordsModule = await loadRecordsModule();
  const fixture = await loadTemporalFixture();
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m04-reversal-'));
  let revisedId = '';
  let correctionEventId = '';
  try {
    const first = await openRecords(recordsModule, fixture, directory);
    try {
      const before = await first.records.answer({ question: fixture.questions.polling, asOf: HISTORICAL_AS_OF });
      assert.equal(before.supported, true, 'the original decision must be answerable before the reversal');
      assert.ok(before.text.includes(fixture.canaries.originalChoice), 'the historical answer must name the original choice');
      assert.ok(before.evidenceIds.includes(ORIGINAL_DECISION_EVENT), 'the historical answer must cite the original decision event');
      assert.equal(before.text.includes(fixture.canaries.revisedChoice), false, 'the reversal cannot appear before it happened');

      const revised = await first.records.reviseDecision({
        decisionId: fixture.reversal.decisionId,
        choice: fixture.reversal.choice,
        rationale: fixture.reversal.rationale,
        actor: fixture.reversal.actor,
        occurredAt: fixture.reversal.occurredAt,
      });
      revisedId = revised.id;
      assert.equal(revised.kind, 'decision');
      assert.equal(revised.status, 'active', 'the correction becomes the current decision');
      assert.equal(revised.choice, fixture.reversal.choice, 'the current answer must use the corrected choice');
      assert.equal(revised.trust, 'user_explicit', 'a user edit is explicit evidence');
      assert.equal(revised.supersedesId, ORIGINAL_DECISION_RECORD, 'the correction must point at the record it replaces');
      assert.equal(revised.validFrom, fixture.reversal.occurredAt, 'validity starts when the correction was made');
      correctionEventId = revised.sources[0] ?? '';
      assert.ok(
        correctionEventId.length > 0 && correctionEventId !== ORIGINAL_DECISION_EVENT,
        'a user edit must be a new explicit event, not an in-place rewrite of the original decision',
      );

      const superseded = await first.records.summary(ORIGINAL_DECISION_RECORD);
      if (superseded === undefined) assert.fail('the replaced decision must stay inspectable by id');
      assert.equal(superseded.status, 'superseded', 'the replaced decision keeps its history as superseded');
      assert.equal(superseded.choice, fixture.derived.decisions[0]?.choice, 'the historical claim itself is not rewritten');
      assert.equal(superseded.validTo, fixture.reversal.occurredAt, 'validity ends when the correction supersedes it');
      assert.equal(superseded.validFrom, '2026-09-10T09:05:00.000Z', 'the original validity start must survive');
      assert.deepEqual([...superseded.sources], [ORIGINAL_DECISION_EVENT]);

      const after = await first.records.answer({ question: fixture.questions.polling });
      assert.equal(after.supported, true);
      assert.ok(after.text.includes(fixture.canaries.revisedChoice), 'the current answer must report the corrected choice');
      assert.equal(after.text.includes(fixture.canaries.originalChoice), false, 'the current answer must not present the reversed choice as current');
      assert.ok(after.evidenceIds.includes(correctionEventId), 'the current answer must cite the explicit correction event');
      assert.equal(after.evidenceIds.includes(ORIGINAL_DECISION_EVENT), false, 'the current answer must not cite the superseded decision');
      assert.equal(after.asOf >= fixture.reversal.occurredAt, true, 'the current answer is evaluated at or after the correction');

      const historical = await first.records.answer({ question: fixture.questions.polling, asOf: HISTORICAL_AS_OF });
      assert.equal(historical.text, before.text, 'the historical answer must be preserved without rewriting');
      assert.deepEqual([...historical.evidenceIds], [...before.evidenceIds], 'the historical citations must be preserved');

      const timeline = await first.store.timeline({ projectId: fixture.projectId });
      assert.ok(
        timeline.some((item) => item.id === correctionEventId),
        'the correction must be a stored normalized event the timeline can show',
      );
      const originalCapsule = timeline.find((item) => item.id === ORIGINAL_DECISION_EVENT);
      assert.ok(originalCapsule !== undefined, 'the original decision event must remain stored after the reversal');
      assert.ok(
        originalCapsule.summary.includes(fixture.canaries.originalChoice),
        'the original raw event must keep its original text',
      );
    } finally {
      await first.records.close();
      await first.store.close();
    }

    const restarted = await openRecords(recordsModule, fixture, directory);
    try {
      const current = await restarted.records.answer({ question: fixture.questions.polling });
      assert.ok(current.text.includes(fixture.canaries.revisedChoice), 'the corrected answer survives a restart');
      assert.ok(current.evidenceIds.includes(correctionEventId), 'the correction event stays the current evidence');
      const historical = await restarted.records.answer({ question: fixture.questions.polling, asOf: HISTORICAL_AS_OF });
      assert.ok(historical.text.includes(fixture.canaries.originalChoice), 'the historical answer survives a restart');
      assert.equal(historical.text.includes(fixture.canaries.revisedChoice), false);
      const superseded = await restarted.records.summary(ORIGINAL_DECISION_RECORD);
      assert.equal(superseded?.status, 'superseded', 'supersession survives a restart');
      assert.equal(superseded?.validTo, fixture.reversal.occurredAt);
      const active = await restarted.records.summary(revisedId);
      assert.equal(active?.status, 'active', 'the corrected decision survives a restart');
      assert.equal(active?.supersedesId, ORIGINAL_DECISION_RECORD);
    } finally {
      await restarted.records.close();
      await restarted.store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a conflicting agent claim cannot overwrite a user-confirmed fact or observed tool receipt', async () => {
  const recordsModule = await loadRecordsModule();
  const fixture = await loadTemporalFixture();
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m04-conflict-'));
  try {
    const { store, records } = await openRecords(recordsModule, fixture, directory);
    try {
      const summaries = await records.summaries();
      const byId = indexSummaries(summaries);

      const userFact = requireSummaryIn(byId, USER_FACT_RECORD);
      assert.equal(userFact.status, 'active', 'the user-confirmed fact stays current');
      assert.equal(userFact.trust, 'user_explicit');
      assert.deepEqual([...userFact.sources], [USER_FACT_EVENT]);

      const agentClaim = requireSummaryIn(byId, AGENT_FACT_CLAIM_RECORD);
      assert.equal(agentClaim.status, 'disputed', 'the conflicting agent claim must be disputed, never active');
      assert.equal(agentClaim.trust, 'agent_reported', 'the claim is labeled as agent-reported evidence');
      assert.ok(agentClaim.object?.includes(fixture.canaries.agentClaim), 'the disputed claim stays inspectable');

      const taskClaim = requireSummaryIn(byId, AGENT_TASK_CLAIM_RECORD);
      assert.equal(taskClaim.status, 'disputed', 'an agent claim about an observed task receipt must be disputed, never active');
      assert.equal(taskClaim.trust, 'agent_reported');

      const task = summaries.find((summary) => summary.kind === 'task');
      if (task === undefined) assert.fail('the observed task receipt must be displayed as a task summary');
      assert.equal(task.id, TASK_ID);
      assert.equal(task.taskStatus, 'failed', 'the failed receipt stays failed after the agent claims success');
      assert.equal(task.trust, 'tool_observed', 'the task status is trusted because a tool receipt observed it');
      assert.deepEqual([...task.sources], [RECEIPT_EVENT]);
      assert.equal(task.status, 'active');

      const factAnswer = await records.answer({ question: fixture.questions.memory });
      assert.equal(factAnswer.supported, true);
      assert.ok(factAnswer.text.includes(fixture.canaries.userFact), 'the answer must report the user-confirmed fact');
      assert.equal(factAnswer.text.includes(fixture.canaries.agentClaim), false, 'the answer must not present the agent claim as fact');
      assert.ok(factAnswer.evidenceIds.includes(USER_FACT_EVENT));
      assert.equal(factAnswer.evidenceIds.includes(AGENT_FACT_CLAIM_EVENT), false, 'a disputed claim is never evidence');
      assert.ok(
        factAnswer.conflicts.includes(AGENT_FACT_CLAIM_RECORD),
        'the answer must name the disputed claim instead of hiding the conflict',
      );
      assert.equal(factAnswer.coverage.semantic, 'partial');
      assert.equal(factAnswer.extractionVersion, EXTRACTION_VERSION);

      const taskAnswer = await records.answer({ question: `Did ${TASK_ID} pass?` });
      assert.equal(taskAnswer.supported, true);
      assert.ok(taskAnswer.text.includes(task.text), 'the answer must report the observed task summary');
      assert.equal(taskAnswer.text.includes('passed'), false, 'the observed failure is never narrated as a pass');
      assert.ok(taskAnswer.evidenceIds.includes(RECEIPT_EVENT));
      assert.equal(taskAnswer.evidenceIds.includes(AGENT_TASK_CLAIM_EVENT), false, 'the agent claim is never evidence for the receipt');
      assert.ok(
        taskAnswer.conflicts.includes(AGENT_TASK_CLAIM_RECORD),
        'the task answer must name the conflicting agent claim',
      );

      const afterRestartStore = await openStore(directory);
      try {
        const restarted = await recordsModule.createMemoryRecords({
          projectId: fixture.projectId,
          directory,
          store: afterRestartStore,
          source: temporalSource(fixture),
          extractionVersion: EXTRACTION_VERSION,
        });
        try {
          const restartedSummaries = indexSummaries(await restarted.summaries());
          assert.equal(restartedSummaries.get(USER_FACT_RECORD)?.status, 'active', 'the user-confirmed fact survives a restart');
          assert.equal(restartedSummaries.get(AGENT_FACT_CLAIM_RECORD)?.status, 'disputed', 'the dispute survives a restart');
          const restartedTask = [...restartedSummaries.values()].find((summary) => summary.kind === 'task');
          assert.equal(restartedTask?.taskStatus, 'failed', 'the failed receipt survives a restart');
        } finally {
          await restarted.close();
        }
      } finally {
        await afterRestartStore.close();
      }
    } finally {
      await records.close();
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every displayed summary reveals its sources, extraction version, and partial-coverage status', async () => {
  const recordsModule = await loadRecordsModule();
  const fixture = await loadTemporalFixture();
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m04-provenance-'));
  try {
    const { store, records } = await openRecords(recordsModule, fixture, directory);
    try {
      const summaries = await records.summaries();
      assert.equal(
        summaries.length,
        fixture.derived.facts.length + fixture.derived.decisions.length + 1,
        'every derived record and the observed task is displayed exactly once',
      );

      for (const summary of summaries) {
        assert.ok(summary.sources.length > 0, `${summary.id} must reveal at least one source`);
        assert.equal(summary.provenance.length, summary.sources.length, `${summary.id} must resolve every source`);
        assert.equal(summary.extractionVersion, EXTRACTION_VERSION, `${summary.id} must reveal its extraction version`);
        assert.equal(summary.coverage.semantic, 'partial', `${summary.id} must not display partial coverage as complete`);
        assert.deepEqual(
          [...summary.coverage.failedJobs],
          [...fixture.derived.coverage.failedJobs],
          `${summary.id} must name the failed jobs behind its partial coverage`,
        );
        assert.ok(summary.validFrom.length > 0, `${summary.id} must carry a validity interval`);
        for (const ref of summary.provenance) {
          assert.ok(summary.sources.includes(ref.eventId), `${summary.id} provenance must belong to its sources`);
          assert.ok(ref.kind.length > 0, `${summary.id} provenance must name the raw event kind`);
          assert.ok(ref.occurredAt.length > 0, `${summary.id} provenance must keep the raw occurrence time`);
          assert.ok(
            ref.rawAvailability === 'available' || ref.rawAvailability === 'expired',
            `${summary.id} provenance must label raw-source availability`,
          );
          if (ref.rawAvailability === 'expired') {
            assert.equal(ref.trust, 'imported', 'an unavailable raw source is not trusted evidence');
            assert.equal(ref.kind, 'unknown', 'an unavailable raw source has no readable kind');
          }
        }
      }

      const byId = indexSummaries(summaries);
      const userFact = requireSummaryIn(byId, USER_FACT_RECORD);
      assert.ok(
        userFact.provenance.every((ref) => ref.rawAvailability === 'available' && ref.trust === 'user_explicit'),
        'a stored user utterance must resolve to an available, user-explicit source',
      );
      const task = summaries.find((summary) => summary.kind === 'task');
      if (task === undefined) assert.fail('the observed task must be displayed');
      assert.ok(
        task.provenance.every((ref) => ref.rawAvailability === 'available' && ref.trust === 'tool_observed'),
        'the task provenance must resolve to the available tool receipt',
      );

      const expired = requireSummaryIn(byId, EXPIRED_SOURCE_RECORD);
      const expiredRef = expired.provenance[0];
      if (expiredRef === undefined) assert.fail('a record with a removed raw source must keep a provenance entry');
      assert.equal(expiredRef.rawAvailability, 'expired', 'a removed raw source must be labeled, never hidden');
      assert.equal(expiredRef.trust, 'imported');

      const coverage = await records.coverage();
      assert.equal(coverage.semantic, 'partial', 'partial semantic coverage must be visible to every surface');
      assert.deepEqual([...coverage.failedJobs], [...fixture.derived.coverage.failedJobs]);

      const unsupported = await records.answer({ question: fixture.questions.unrelated });
      assert.equal(unsupported.supported, false, 'no evidence means no supported answer');
      assert.deepEqual([...unsupported.evidenceIds], [], 'an unsupported answer must not cite evidence');
      assert.equal(unsupported.coverage.semantic, 'partial', 'coverage is reported even without an answer');
      assert.equal(unsupported.extractionVersion, EXTRACTION_VERSION, 'the answer reveals its extraction version');
    } finally {
      await records.close();
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
