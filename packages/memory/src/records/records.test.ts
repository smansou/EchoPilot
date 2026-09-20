/**
 * Focused tests for the M04 records layer beyond the frozen acceptance oracle: matching precision
 * (a shared topic word must not drag an unrelated decision into an answer), revision chains where a
 * second correction supersedes the first, the display anchor for a record whose raw source is gone,
 * unsourced derivations, and the loud-failure guards.
 *
 * The M01 store is replaced by a deterministic in-memory double so these tests exercise the records
 * layer itself; the acceptance oracle covers the same seam against the real encrypted store.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { MemoryStore, NormalizedBatch, TimelineItem, TimelineQuery } from '../store/index.js';
import type { NormalizedEvent } from '../store/types.js';
import { createMemoryRecords } from './index.js';
import { bearsOnQuestion, contentTokens } from './matching.js';
import { recordsStatePath } from './state.js';
import { buildSummaries, type CapsuleView } from './summaries.js';
import type { DerivedDecisionClaim, DerivedFactClaim, DerivedMemorySource, MemoryCoverage } from './model.js';

const EXTRACTION_VERSION = 'qwen3.5-4b-q4/memory.extraction@1';
const COVERAGE: MemoryCoverage = { semantic: 'partial', failedJobs: ['segment-2'] };
const PROJECT_ID = 'project-records-test';

type Seeded = { event: NormalizedEvent; payload: Record<string, unknown> };

function event(overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind' | 'trust' | 'occurredAt'>): NormalizedEvent {
  return {
    schemaVersion: 1,
    sourceId: 'fixture',
    sourceEventId: overrides.eventId,
    sourceSequence: 1,
    ingestSequence: 1,
    observedAt: overrides.occurredAt,
    payloadRef: `fixture://${overrides.eventId}`,
    contentHash: `sha256:${overrides.eventId}`,
    scope: { profileId: 'profile-records-test', projectId: PROJECT_ID, sensitivity: 'normal' },
    ...overrides,
  };
}

class FakeStore implements MemoryStore {
  readonly profileId = 'profile-records-test';
  readonly seeded = new Map<string, Seeded>();
  readonly ingested: NormalizedEvent[] = [];

  seed(entries: readonly Seeded[]): void {
    for (const entry of entries) this.seeded.set(entry.event.eventId, entry);
  }

  async ingest(batch: NormalizedBatch): Promise<{ durableCursor: string; inserted: number; duplicates: number }> {
    let inserted = 0;
    let duplicates = 0;
    for (const candidate of batch.events as readonly NormalizedEvent[]) {
      if (this.seeded.has(candidate.eventId)) {
        duplicates += 1;
        continue;
      }
      this.seeded.set(candidate.eventId, {
        event: candidate,
        payload: (batch.payloads?.[candidate.payloadRef] ?? {}) as Record<string, unknown>,
      });
      this.ingested.push(candidate);
      inserted += 1;
    }
    return { durableCursor: 'fake-cursor', inserted, duplicates };
  }

  async timeline(query: TimelineQuery): Promise<TimelineItem[]> {
    assert.equal(query.projectId, PROJECT_ID);
    return [...this.seeded.values()]
      .map(({ event: stored, payload }) => ({
        id: stored.eventId,
        kind: stored.kind,
        summary: typeof payload.text === 'string'
          ? payload.text
          : `${String(payload.question ?? 'Decision')} — ${String(payload.choice ?? 'no recorded choice')}`,
        sourceEventIds: [stored.eventId],
        occurredAt: stored.occurredAt,
        trust: stored.trust,
      }))
      .sort((left, right) => (left.occurredAt < right.occurredAt ? -1 : left.occurredAt > right.occurredAt ? 1 : 0));
  }

  async durableCursor(): Promise<string> {
    return 'fake-cursor';
  }

  async close(): Promise<void> {}
}

function sourceOf(options: {
  facts?: readonly DerivedFactClaim[];
  decisions?: readonly DerivedDecisionClaim[];
  coverage?: MemoryCoverage;
}): DerivedMemorySource {
  return {
    async facts() { return options.facts ?? []; },
    async decisions() { return options.decisions ?? []; },
    async coverage() { return options.coverage ?? COVERAGE; },
  };
}

const DECISION: DerivedDecisionClaim = {
  id: 'decision-polling',
  question: 'What polling interval should the widget use?',
  choice: 'Thirty seconds between polls.',
  sourceEventIds: ['evt-decision-1'],
};

function seededDecision(): Seeded {
  return {
    event: event({
      eventId: 'evt-decision-1',
      kind: 'decision',
      trust: 'user_explicit',
      occurredAt: '2026-09-10T09:05:00.000Z',
    }),
    payload: { question: DECISION.question, choice: DECISION.choice, decidingActor: 'user' },
  };
}

test('matching requires a real reference, not a shared topic word', () => {
  assert.deepEqual(contentTokens('What polling interval should the Atlas widget use?'), ['polling', 'interval', 'atlas', 'widget']);
  const decisionKey = DECISION.question;
  const memoryFactKey = 'Atlas durable memory';
  assert.equal(bearsOnQuestion('What polling interval should the Atlas widget use?', [decisionKey]), true);
  assert.equal(bearsOnQuestion('Where does Atlas durable memory live?', [memoryFactKey]), true);
  assert.equal(
    bearsOnQuestion('Where does Atlas durable memory live?', [decisionKey]),
    false,
    'sharing only the word "atlas" must not pull the polling decision into a memory answer',
  );
  assert.equal(bearsOnQuestion('Did task-atlas-smoke pass?', ['task-atlas-smoke']), true);
  assert.equal(bearsOnQuestion('Which color should the zebra dashboard use?', [decisionKey, memoryFactKey]), false);
  assert.equal(bearsOnQuestion('what is it', [decisionKey]), false, 'a question with no content tokens matches nothing');
});

test('a weaker derivation is disputed, an expired source is labeled, and unsourced claims stay hidden', () => {
  const capsules = new Map<string, CapsuleView>([
    ['evt-user-fact', { kind: 'user_utterance', trust: 'user_explicit', occurredAt: '2026-09-10T10:00:00.000Z', summary: 'durable memory' }],
    ['evt-agent-claim', { kind: 'agent_message', trust: 'agent_reported', occurredAt: '2026-09-10T10:05:00.000Z', summary: 'shared database' }],
    ['evt-receipt', { kind: 'tool_completed', trust: 'tool_observed', occurredAt: '2026-09-10T09:30:00.000Z', summary: 'pnpm failed' }],
  ]);
  const facts: DerivedFactClaim[] = [
    { id: 'fact-user', subject: 'Atlas durable memory', predicate: 'storage', object: 'one database per project', sourceEventIds: ['evt-user-fact'] },
    { id: 'fact-agent', subject: 'Atlas durable memory', predicate: 'storage', object: 'one shared database', sourceEventIds: ['evt-agent-claim'] },
    { id: 'fact-task-claim', subject: 'task-smoke', predicate: 'outcome', object: 'passed', sourceEventIds: ['evt-agent-claim'] },
    { id: 'fact-expired', subject: 'Atlas exporter', predicate: 'retention', object: 'ninety days', sourceEventIds: ['evt-removed-1'] },
    { id: 'fact-unsourced', subject: 'Atlas noise', predicate: 'state', object: 'unknown', sourceEventIds: [] },
  ];
  const { summaries, firstSeen } = buildSummaries({
    facts,
    decisions: [],
    tasks: [{ id: 'task-smoke', status: 'failed', summary: 'Task task-smoke failed on the latest pnpm receipt (exit 1)', sourceEventIds: ['evt-receipt'] }],
    capsules,
    corrections: [],
    coverage: COVERAGE,
    extractionVersion: EXTRACTION_VERSION,
    firstSeenAt: {},
    now: '2026-09-21T00:00:00.000Z',
  });
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  assert.equal(byId.size, 5, 'every sourced record is displayed exactly once');
  assert.equal(byId.get('fact-unsourced'), undefined, 'a derivation with no source ids has no provenance anchor and is not displayed');
  assert.equal(byId.get('fact-user')?.status, 'active');
  assert.equal(byId.get('fact-agent')?.status, 'disputed', 'the weaker agent claim never becomes current');
  assert.equal(byId.get('fact-agent')?.object, 'one shared database', 'the disputed claim stays inspectable');
  assert.equal(byId.get('fact-task-claim')?.status, 'disputed', 'a claim about an observed task id is disputed');
  assert.equal(byId.get('task-smoke')?.taskStatus, 'failed');
  assert.equal(byId.get('task-smoke')?.trust, 'tool_observed');
  assert.equal(byId.get('task-smoke')?.status, 'active');

  const expired = byId.get('fact-expired');
  assert.equal(expired?.trust, 'imported');
  const expiredRef = expired?.provenance[0];
  assert.equal(expiredRef?.rawAvailability, 'expired');
  assert.equal(expiredRef?.kind, 'unknown');
  assert.equal(expiredRef?.trust, 'imported');
  assert.ok((expiredRef?.occurredAt.length ?? 0) > 0, 'an unavailable source still carries a non-empty time anchor');
  assert.deepEqual(firstSeen, { 'fact-expired': '2026-09-21T00:00:00.000Z' }, 'the anchor is reported so the caller can persist it');

  const remembered = buildSummaries({
    facts: [facts[3] as DerivedFactClaim],
    decisions: [],
    tasks: [],
    capsules,
    corrections: [],
    coverage: COVERAGE,
    extractionVersion: EXTRACTION_VERSION,
    firstSeenAt: { 'fact-expired': '2026-09-11T00:00:00.000Z' },
    now: '2026-09-21T00:00:00.000Z',
  });
  assert.equal(remembered.summaries[0]?.validFrom, '2026-09-11T00:00:00.000Z');
  assert.deepEqual(remembered.firstSeen, {}, 'a persisted anchor is not re-anchored on later builds');
});

test('reversing a decision twice chains the corrections and answers each interval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m04-chain-'));
  try {
    const store = new FakeStore();
    store.seed([seededDecision()]);
    const source = sourceOf({ decisions: [DECISION] });
    const records = await createMemoryRecords({ projectId: PROJECT_ID, directory, store, source, extractionVersion: EXTRACTION_VERSION });
    try {
      const original = await records.summary(DECISION.id);
      if (original === undefined) assert.fail('the derived decision must be displayed');
      assert.equal(original.status, 'active');

      const first = await records.reviseDecision({
        decisionId: DECISION.id,
        choice: 'Five seconds between polls.',
        actor: 'user',
        occurredAt: '2026-09-12T10:00:00.000Z',
      });
      assert.equal(first.status, 'active');
      assert.equal(first.supersedesId, DECISION.id);
      assert.equal(first.trust, 'user_explicit');
      assert.equal((await records.summary(DECISION.id))?.status, 'superseded');

      const second = await records.reviseDecision({
        decisionId: DECISION.id,
        choice: 'Fifteen seconds between polls.',
        actor: 'user',
        occurredAt: '2026-09-14T08:00:00.000Z',
      });
      assert.equal(second.status, 'active');
      assert.equal(second.supersedesId, first.id, 'the second correction replaces the first, not the original');
      assert.equal(second.validFrom, '2026-09-14T08:00:00.000Z');

      const firstAfter = await records.summary(first.id);
      assert.equal(firstAfter?.status, 'superseded');
      assert.equal(firstAfter?.validTo, '2026-09-14T08:00:00.000Z');
      assert.equal(firstAfter?.choice, 'Five seconds between polls.', 'the superseded correction is not rewritten');

      const between = await records.answer({ question: DECISION.question, asOf: '2026-09-13T00:00:00.000Z' });
      assert.equal(between.supported, true);
      assert.ok(between.text.includes('Five seconds between polls.'));
      assert.equal(between.text.includes('Fifteen seconds'), false);

      const current = await records.answer({ question: DECISION.question });
      assert.ok(current.text.includes('Fifteen seconds between polls.'));
      assert.equal(current.text.includes('Thirty seconds'), false);
      assert.equal(current.evidenceIds.includes(first.sources[0] ?? ''), false, 'the current answer cites only current evidence');

      const correctionEvents = store.ingested.filter((entry) => entry.kind === 'decision');
      assert.equal(correctionEvents.length, 2, 'each reversal is a new stored event, never an in-place edit');
      assert.equal(correctionEvents[0]?.trust, 'user_explicit');
      assert.equal(correctionEvents[0]?.scope.projectId, PROJECT_ID);
      assert.notEqual(correctionEvents[0]?.eventId, correctionEvents[1]?.eventId);

      const persisted = JSON.parse(await readFile(recordsStatePath(directory, PROJECT_ID), 'utf8')) as {
        corrections: readonly { recordId: string; supersededBy?: string }[];
      };
      assert.equal(persisted.corrections.length, 2);
      assert.equal(persisted.corrections[0]?.supersededBy, persisted.corrections[1]?.recordId);
    } finally {
      await records.close();
    }

    const reopened = await createMemoryRecords({ projectId: PROJECT_ID, directory, store, source, extractionVersion: EXTRACTION_VERSION });
    try {
      const current = await reopened.answer({ question: DECISION.question });
      assert.ok(current.text.includes('Fifteen seconds between polls.'), 'the corrected answer survives a reopen');
      const historical = await reopened.answer({ question: DECISION.question, asOf: '2026-09-11T00:00:00.000Z' });
      assert.ok(historical.text.includes('Thirty seconds between polls.'), 'the historical answer survives a reopen');
      assert.equal(historical.text.includes('Fifteen seconds'), false);
      const superseded = await reopened.summary(DECISION.id);
      assert.equal(superseded?.validTo, '2026-09-12T10:00:00.000Z');
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('records reject unsupported edits, unknown decisions, and use after close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m04-guards-'));
  try {
    const store = new FakeStore();
    store.seed([seededDecision()]);
    const records = await createMemoryRecords({
      projectId: PROJECT_ID,
      directory,
      store,
      source: sourceOf({ decisions: [DECISION] }),
      extractionVersion: EXTRACTION_VERSION,
    });
    await assert.rejects(
      () => records.reviseDecision({ decisionId: DECISION.id, choice: 'Five seconds.', actor: 'agent' as unknown as 'user' }),
      /actor 'user'/,
      'only an explicit user edit may reverse a decision',
    );
    await assert.rejects(
      () => records.reviseDecision({ decisionId: DECISION.id, choice: '   ', actor: 'user' }),
      /corrected choice/,
    );
    await assert.rejects(
      () => records.reviseDecision({ decisionId: 'decision-missing', choice: 'Five seconds.', actor: 'user' }),
      /no decision record/,
    );
    await assert.rejects(() => records.answer({ question: '   ' }), /requires a question/);
    await assert.rejects(() => records.answer({ question: DECISION.question, asOf: 'not-a-time' }), /valid instant/);
    assert.equal(store.ingested.length, 0, 'a rejected edit never reaches the store');
    assert.equal((await records.coverage()).semantic, 'partial');
    await records.close();
    await assert.rejects(() => records.summaries(), /closed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a corrupt or foreign records state file fails loudly instead of resetting history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m04-state-'));
  try {
    const path = recordsStatePath(directory, PROJECT_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{not json', { encoding: 'utf8' });
    const store = new FakeStore();
    await assert.rejects(
      () => createMemoryRecords({ projectId: PROJECT_ID, directory, store, source: sourceOf({ decisions: [DECISION] }), extractionVersion: EXTRACTION_VERSION }).then((records) => records.summaries()),
      /corrupt/,
    );
    await writeFile(path, JSON.stringify({ version: 1, projectId: 'someone-else', corrections: [] }), { encoding: 'utf8' });
    const foreign = await createMemoryRecords({ projectId: PROJECT_ID, directory, store, source: sourceOf({ decisions: [DECISION] }), extractionVersion: EXTRACTION_VERSION });
    await assert.rejects(() => foreign.summaries(), /not a supported v1 state file/);
    await foreign.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
