import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemorySummary, TemporalAnswer } from '../../../../../../packages/memory/src/records/model.js';
import {
  applyAnswer,
  applySummaries,
  decisionRevisionRequest,
  initialInspectorView,
  projectAnswer,
  projectSummary,
  selectMemoryRow,
} from './memory-inspector.js';

const EXTRACTION_VERSION = 'qwen3.5-4b-q4/memory.extraction@1';
const PARTIAL = { semantic: 'partial', failedJobs: ['segment-2'] } as const;

function summary(overrides: Partial<MemorySummary> & Pick<MemorySummary, 'id' | 'kind' | 'text'>): MemorySummary {
  return {
    status: 'active',
    trust: 'agent_reported',
    sources: [],
    provenance: [],
    extractionVersion: EXTRACTION_VERSION,
    coverage: PARTIAL,
    validFrom: '2026-09-10T09:00:00.000Z',
    ...overrides,
  } as MemorySummary;
}

function userFact(): MemorySummary {
  return summary({
    id: 'fact-atlas-durable-memory-user',
    kind: 'fact',
    text: 'Atlas keeps durable memory',
    trust: 'user_explicit',
    subject: 'atlas-durable-memory',
    sources: ['evt-temporal-user-fact-004'],
    provenance: [{
      eventId: 'evt-temporal-user-fact-004',
      kind: 'fact',
      trust: 'user_explicit',
      occurredAt: '2026-09-10T09:10:00.000Z',
      rawAvailability: 'available',
    }],
  });
}

function answer(overrides: Partial<TemporalAnswer> = {}): TemporalAnswer {
  return {
    question: 'Does Atlas keep durable memory?',
    asOf: '2026-09-12T00:00:00.000Z',
    text: 'Atlas keeps durable memory',
    supported: true,
    evidenceIds: ['evt-temporal-user-fact-004'],
    conflicts: ['fact-atlas-durable-memory-agent-claim'],
    coverage: PARTIAL,
    extractionVersion: EXTRACTION_VERSION,
    ...overrides,
  } as TemporalAnswer;
}

test('a displayed row always reveals its sources, extraction version, and partial coverage', () => {
  const fact = userFact();
  const row = projectSummary(fact);

  assert.equal(row.reveal.sources.length, 1, 'every displayed row resolves at least one source');
  assert.equal(row.reveal.sources.length, fact.provenance.length, 'one disclosure line per provenance entry');
  assert.equal(row.reveal.sources.length, fact.sources.length, 'one disclosure line per source id');
  assert.equal(row.reveal.sources[0]?.eventId, 'evt-temporal-user-fact-004');
  assert.equal(row.reveal.sources[0]?.trust, 'user_explicit');
  assert.equal(row.reveal.extractionVersion, EXTRACTION_VERSION, 'the row reveals the extraction version');
  assert.equal(row.reveal.coverage.semantic, 'partial', 'partial coverage is never displayed as complete');
  assert.deepEqual([...row.reveal.coverage.failedJobs], ['segment-2']);
  assert.match(row.reveal.coverage.label, /partial/);
  assert.match(row.reveal.coverage.label, /segment-2/);
  assert.equal(row.citable, true, 'an active row backed by an explicit user fact is citable');
  assert.equal(row.reveal.sources[0]?.label.includes('evt-temporal-user-fact-004'), true);
});

test('a disputed or superseded row stays inspectable but is never citable', () => {
  const disputed = projectSummary(summary({
    id: 'fact-atlas-durable-memory-agent-claim',
    kind: 'fact',
    text: 'Atlas forgets durable memory',
    status: 'disputed',
    trust: 'agent_reported',
    sources: ['evt-temporal-agent-fact-claim-005'],
    provenance: [{
      eventId: 'evt-temporal-agent-fact-claim-005',
      kind: 'fact',
      trust: 'agent_reported',
      occurredAt: '2026-09-11T08:00:00.000Z',
      rawAvailability: 'available',
    }],
  }));
  const superseded = projectSummary(summary({
    id: 'decision-atlas-polling',
    kind: 'decision',
    text: 'Poll Atlas every 30 seconds — 30 seconds',
    status: 'superseded',
    trust: 'user_explicit',
    validTo: '2026-09-11T09:00:00.000Z',
    sources: ['evt-temporal-decision-001'],
    provenance: [{
      eventId: 'evt-temporal-decision-001',
      kind: 'decision',
      trust: 'user_explicit',
      occurredAt: '2026-09-10T09:05:00.000Z',
      rawAvailability: 'available',
    }],
  }));

  assert.equal(disputed.citable, false, 'a conflicting agent claim is displayed but never evidence');
  assert.match(disputed.statusNote, /not evidence/);
  assert.equal(disputed.reveal.sources.length, 1, 'the disputed row still reveals what it came from');
  assert.equal(superseded.citable, false, 'the replaced decision keeps its history as a non-citable row');
  assert.match(superseded.statusNote, /superseded/);
  assert.equal(superseded.validTo, '2026-09-11T09:00:00.000Z', 'the historical interval is preserved');
});

test('an expired raw source is labeled instead of hidden', () => {
  const row = projectSummary(summary({
    id: 'fact-atlas-legacy-exporter',
    kind: 'fact',
    text: 'The Atlas exporter was removed',
    status: 'active',
    trust: 'imported',
    sources: ['evt-temporal-expired-raw-000'],
    provenance: [{
      eventId: 'evt-temporal-expired-raw-000',
      kind: 'unknown',
      trust: 'imported',
      occurredAt: '',
      rawAvailability: 'expired',
    }],
  }));
  const line = row.reveal.sources[0];

  assert.equal(row.reveal.sources.length, 1, 'a missing raw event still gets a provenance entry');
  assert.equal(line?.availability, 'expired');
  assert.equal(line?.kind, 'unknown');
  assert.equal(line?.trust, 'imported', 'an unavailable raw source is not trusted evidence');
  assert.match(line?.label ?? '', /unavailable/);
});

test('an answer reveals its evidence, extraction version, conflicts, and coverage', () => {
  const view = applyAnswer(initialInspectorView(), answer());
  const card = view.answer;

  assert.equal(card?.supported, true);
  assert.deepEqual([...card?.evidenceIds ?? []], ['evt-temporal-user-fact-004']);
  assert.deepEqual([...card?.conflicts ?? []], ['fact-atlas-durable-memory-agent-claim']);
  assert.match(card?.disclosure ?? '', /1 source/);
  assert.match(card?.disclosure ?? '', /qwen3\.5-4b-q4\/memory\.extraction@1/);
  assert.match(card?.disclosure ?? '', /partial/);
  assert.match(card?.disclosure ?? '', /refuses to cite: fact-atlas-durable-memory-agent-claim/);

  const unsupported = projectAnswer(answer({ supported: false, evidenceIds: [], conflicts: [], text: 'No supported evidence for that question.' }));
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.disclosure, /no evidence-backed answer/);
  assert.equal(view.rows.length, 0, 'an answer card does not fabricate rows');
});

test('a selection never points at a row that is no longer displayed', () => {
  let view = applySummaries(initialInspectorView(), [userFact()]);
  view = selectMemoryRow(view, 'fact-atlas-durable-memory-user');
  assert.equal(view.selectedId, 'fact-atlas-durable-memory-user');
  assert.equal(selectMemoryRow(view, 'fact-not-displayed').selectedId, 'fact-atlas-durable-memory-user', 'an unknown click is a no-op');

  view = applySummaries(view, []);
  assert.equal(view.selectedId, null, 'a row that disappears from the display clears the selection');
  assert.equal(view.rows.length, 0);
});

test('a decision reversal requires an explicit user edit', () => {
  assert.throws(
    () => decisionRevisionRequest({ recordId: 'decision-atlas-polling', choice: 'Poll every 5 minutes.', confirmedByUser: false }),
    /explicit user edit/,
  );
  assert.throws(
    () => decisionRevisionRequest({ recordId: 'decision-atlas-polling', choice: '   ', confirmedByUser: true }),
    /corrected choice/,
  );
  assert.throws(
    () => decisionRevisionRequest({ recordId: '  ', choice: 'Poll every 5 minutes.', confirmedByUser: true }),
    /record it replaces/,
  );

  const request = decisionRevisionRequest({
    recordId: ' decision-atlas-polling ',
    choice: ' Poll every 5 minutes. ',
    rationale: '  ',
    confirmedByUser: true,
  });
  assert.equal(request.decisionId, 'decision-atlas-polling');
  assert.equal(request.choice, 'Poll every 5 minutes.');
  assert.equal(request.actor, 'user', 'a reversal is only ever an explicit user edit');
  assert.equal('rationale' in request, false, 'a blank rationale is not sent as one');
});
