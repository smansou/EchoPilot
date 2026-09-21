/**
 * S03 deletion seam tests: the production `forget` path — lineage rows, derived state, tombstones
 * — against the real M01/M02/M03/M04 stack.
 *
 * The frozen S03 acceptance oracle (`s03.acceptance.test.ts`) pins the *effect* the ticket owes;
 * these tests pin the API that produces it, so the two halves stay honest: the oracle must keep
 * passing if this module is replaced by an equal implementation, and this module must not be a
 * test-only helper.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFileLogSource } from '../../../harness-generic/src/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../consolidation/index.js';
import { statePath } from '../consolidation/state.js';
import { createContextAssembler, type ImageDescriptor, type ModelDescriptor } from '../context/index.js';
import { createMemoryImporter } from '../import/index.js';
import { createMemoryRecords, type MemoryRecords } from '../records/index.js';
import type { NormalizedEvent } from '../reducers/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../store/index.js';
import { createMemoryDeletion, type MemoryDeletion } from './index.js';

const PROFILE_ID = 'profile-s03-deletion';
const PROJECT_ID = 'project-s03-deletion';
const NEIGHBOUR_PROJECT_ID = 'project-s03-deletion-neighbour';
const KEY = '9c1e7b2d40685a1c3e5f7091b2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f6';
const CANARY = 'harvestcanary4';
const KEPT = 'harvestkept4';
const OCCURRED_AT = '2026-09-02T09:00:00.000Z';
const MODEL: ModelDescriptor = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };
const SCOPE = { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: 'session-s03-deletion', sensitivity: 'normal' } as const;

const assembler = createContextAssembler({
  tokenizer: { count: (text: string) => text.trim().split(/\s+/).filter((token) => token.length > 0).length },
  imageTokens: (image: ImageDescriptor) => Math.ceil(image.width / 28) * Math.ceil(image.height / 28),
});
const reasoner = {
  async run(): Promise<unknown> {
    throw new Error('deterministic fallback only');
  },
};

function batchOf(seeds: readonly { eventId: string; question: string; choice: string }[], sourceId = 's03:deletion'): NormalizedBatch {
  const payloads: Record<string, unknown> = {};
  const events = seeds.map((seed, index): NormalizedEvent => {
    const payloadRef = `memory://s03-deletion/${seed.eventId}`;
    payloads[payloadRef] = { question: seed.question, choice: seed.choice };
    return {
      schemaVersion: 1,
      eventId: seed.eventId,
      sourceId,
      sourceEventId: seed.eventId,
      sourceSequence: index + 1,
      ingestSequence: index + 1,
      occurredAt: OCCURRED_AT,
      observedAt: OCCURRED_AT,
      scope: SCOPE,
      kind: 'decision',
      payloadRef,
      contentHash: `sha256:${seed.eventId}`,
      trust: 'user_explicit',
    };
  });
  return { events, payloads };
}

type Stack = Readonly<{ consolidator: MemoryConsolidator; records: MemoryRecords }>;

async function openStack(directory: string, store: MemoryStore): Promise<Stack> {
  const consolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory, store, reasoner, assembler, model: MODEL });
  const records = await createMemoryRecords({ projectId: PROJECT_ID, directory, store, source: consolidator, extractionVersion: 's03-deletion-v1' });
  return { consolidator, records };
}

async function closeStack(stack: Stack): Promise<void> {
  await stack.records.close();
  await stack.consolidator.close();
}

async function surfaces(stack: Stack, token: string): Promise<string> {
  const question = `Should we ${token}?`;
  const [facts, decisions, card, answer, summaries, recordsAnswer] = await Promise.all([
    stack.consolidator.facts(),
    stack.consolidator.decisions(),
    stack.consolidator.card('project'),
    stack.consolidator.answer({ question }),
    stack.records.summaries(),
    stack.records.answer({ question }),
  ]);
  return [
    ...facts.map((fact) => fact.object),
    ...decisions.map((choice) => choice.choice),
    card ?? '',
    answer.text,
    ...summaries.map((summary) => summary.text),
    recordsAnswer.text,
  ].join('\n');
}

test('forget removes the lineage, condenses derived state and leaves the rest of the profile intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-deletion-'));
  const store = await createMemoryStore({ directory: root, key: KEY, profileId: PROFILE_ID });
  try {
    const stack = await openStack(root, store);
    await store.ingest(batchOf([
      { eventId: 'evt-canary', question: `Should we ${CANARY} the field?`, choice: `Harvest ${CANARY} tonight.` },
      { eventId: 'evt-kept', question: `Should we keep ${KEPT}?`, choice: `Keep ${KEPT} for now.` },
    ]));
    await stack.consolidator.consolidate();
    assert.ok((await surfaces(stack, CANARY)).includes(CANARY), 'the decision must be visible before the forget');

    const decision = (await stack.consolidator.decisions()).find((entry) => entry.choice.includes(CANARY));
    assert.ok(decision, 'the consolidator must display the decision before the forget');
    const eventIds = decision.sourceEventIds;
    assert.ok(eventIds.length > 0, 'the displayed decision must carry its raw lineage');

    await closeStack(stack);
    const deletion = await createMemoryDeletion({ directory: root });
    const receipt = await deletion.forget({ eventIds });
    assert.ok(receipt.deleted >= 4, `the forget must remove durable rows (removed ${receipt.deleted})`);
    assert.deepEqual(receipt.forgotten.map((entry) => entry.sourceId), ['s03:deletion'], 'the forget must record the lineage it removed');
    assert.deepEqual(receipt.projects, [PROJECT_ID], 'the forget must condense the project it touched');
    assert.ok(receipt.condensed >= 1, 'the forget must report the derived entries it condensed');
    assert.equal(await deletion.isSuppressed({ sourceId: 's03:deletion', sourceEventId: 'evt-canary' }), true, 'the forgotten record must be suppressed');
    assert.equal(await deletion.isSuppressed({ sourceId: 's03:deletion', sourceEventId: 'evt-kept' }), false, 'an unrelated record of the same source must stay importable');

    const state = JSON.parse(await readFile(statePath(root, PROJECT_ID), 'utf8')) as { decisions: { choice: string }[]; cards: Record<string, unknown> };
    assert.ok(!JSON.stringify(state).includes(CANARY), 'the derived state must not keep the forgotten decision');
    assert.deepEqual(state.cards, {}, 'the card cache must be dropped so it is rebuilt from surviving evidence');

    const rebuilt = await openStack(root, store);
    await rebuilt.consolidator.consolidate();
    const after = await surfaces(rebuilt, CANARY);
    assert.ok(!after.includes(CANARY), 'no rebuilt surface may serve the forgotten decision');
    assert.ok((await surfaces(rebuilt, KEPT)).includes(KEPT), 'the unrelated decision must survive on the same surfaces');
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'lexical search must not serve the forgotten record');
    await closeStack(rebuilt);
    await deletion.close();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('the guarded store refuses to resurrect a forgotten source while another project imports the same bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-deletion-import-'));
  const store = await createMemoryStore({ directory: root, key: KEY, profileId: PROFILE_ID });
  const neighbourDirectory = join(root, 'neighbour');
  const neighbourStore = await createMemoryStore({ directory: neighbourDirectory, key: KEY, profileId: PROFILE_ID });
  try {
    const sourcePath = join(root, 'field-session.jsonl');
    await writeFile(sourcePath, [
      JSON.stringify({ id: 'd-0001', seq: 1, kind: 'decision', occurredAt: OCCURRED_AT, question: `Should we ${CANARY}?`, choice: `Harvest ${CANARY}.` }),
      JSON.stringify({ id: 'd-0002', seq: 2, kind: 'decision', occurredAt: OCCURRED_AT, question: `Should we keep ${KEPT}?`, choice: `Keep ${KEPT}.` }),
      '',
    ].join('\n'), 'utf8');

    const deletion = await createMemoryDeletion({ directory: root });
    const stack = await openStack(root, store);
    const importer = await createMemoryImporter({
      directory: join(root, 'import-state-1'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store: deletion.guard(store),
      consolidator: stack.consolidator,
    });
    const first = await importer.bootstrap();
    await importer.close();
    assert.equal(first.coverage.importedEvents, 2, 'the first import must store both records');

    const item = (await store.timeline({ projectId: PROJECT_ID, text: CANARY }))[0];
    assert.ok(item, 'the imported decision must be retrievable');
    const eventIds = item.sourceEventIds;
    const receipt = await deletion.forget({ eventIds });
    assert.ok(receipt.deleted >= 1, 'the forget must remove the imported lineage');

    const reimport = await createMemoryImporter({
      directory: join(root, 'import-state-2'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store: deletion.guard(store),
      consolidator: stack.consolidator,
    });
    const second = await reimport.bootstrap();
    await reimport.close();
    assert.equal(second.coverage.importedEvents, 0, 're-importing the forgotten source must not resurrect the selected record');
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the re-import must not put the forgotten record back');
    assert.equal((await store.timeline({ projectId: PROJECT_ID, text: KEPT })).length, 1, 'the unrelated record of that source must survive');

    // The same bytes at another path are a different import source, and a different project is a
    // different scope: neither may be blocked by this profile's choice.
    const copyPath = join(root, 'neighbour-copy.jsonl');
    await writeFile(copyPath, await readFile(sourcePath, 'utf8'), 'utf8');
    const neighbourStack = await openStack(neighbourDirectory, neighbourStore);
    const neighbourImporter = await createMemoryImporter({
      directory: join(neighbourDirectory, 'import-state'),
      source: createFileLogSource(copyPath),
      format: 'jsonl',
      scope: { ...SCOPE, projectId: NEIGHBOUR_PROJECT_ID, sessionId: 'session-s03-deletion-neighbour' },
      store: deletion.guard(neighbourStore),
      consolidator: neighbourStack.consolidator,
    });
    const neighbour = await neighbourImporter.bootstrap();
    await neighbourImporter.close();
    assert.equal(neighbour.coverage.importedEvents, 2, 'an unrelated project importing the same bytes must not be blocked');
    assert.equal((await neighbourStore.timeline({ projectId: NEIGHBOUR_PROJECT_ID, text: CANARY })).length, 1, 'the unrelated project must keep its own record');

    // Forgetting the whole source suppresses every record of it, not only the selected one.
    const sourceWide = await deletion.forget({ sources: [{ sourceId: first.sourceId, sourceEventIds: [] }] });
    assert.ok(sourceWide.deleted >= 1, 'a source-wide forget must remove the remaining lineage of that source');
    assert.equal(await deletion.isSuppressed({ sourceId: first.sourceId, sourceEventId: 'd-0002' }), true, 'every record of a forgotten source must be suppressed');
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID }), [], 'a source-wide forget must leave no record of that source');
    assert.equal((await neighbourStore.timeline({ projectId: NEIGHBOUR_PROJECT_ID })).length, 2, 'the source-wide forget must not touch another profile');

    // A choice made before the records exist still holds: a later import of that source is refused
    // rather than silently accepted, which is what makes "forget" durable against a re-import.
    const earlyChoice = await createMemoryDeletion({ directory: join(root, 'pre-forgotten') });
    const identity = await createFileLogSource(sourcePath).identity();
    const beforeImport = await earlyChoice.forget({ sources: [{ sourceId: identity, sourceEventIds: [] }] });
    assert.equal(beforeImport.deleted, 0, 'a forget before the import deletes nothing because nothing is stored yet');
    assert.equal(await earlyChoice.isSuppressed({ sourceId: identity, sourceEventId: 'd-0001' }), true, 'the choice must still be recorded');
    await earlyChoice.close();

    await deletion.close();
    await closeStack(neighbourStack);
    await closeStack(stack);
  } finally {
    await neighbourStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
