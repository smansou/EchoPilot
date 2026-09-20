/**
 * S03 acceptance oracle — "Private session / forget / export → storage and retrieval reflect the
 * choice" (IMPLEMENTATION_PLAN.md §5.8, BACKLOG S03).
 *
 * This ticket owns the end-to-end path *forget → every retrieval surface*. The retained candidate
 * has no deletion module (no `packages/memory/src/deletion/index.ts`, no private-session surface),
 * so this oracle pins the §5.8 deletion *effect* against the production stack that exists and that
 * a forget must actually drive: the M01 encrypted store, the M02 consolidator, the M03 importer and
 * the M04 records. The readers below are the real ones — nothing here is a double — and the oracle
 * asserts the ticket's outcome at both ends:
 *
 *   1. every named surface must hold the decision *before* the forget, so every "it is gone" check
 *      below is a real disappearance rather than an empty surface;
 *   2. after the forget the decision is absent from facts, summaries, lexical (FTS) search, cached
 *      answers and the answer text narration speaks, while an unrelated decision survives on the
 *      same surfaces — and stays absent after closing and reopening the whole stack, which is what
 *      catches a forget that cleaned the live readers but left durable derivation state behind;
 *   3. re-importing the forgotten source cannot resurrect the forgotten record, while a project
 *      that shares the source's exact bytes still imports (re-import suppression is scoped to what
 *      the user forgot, never a global content-hash block).
 *
 * The forget is applied with the primitives §5.8 names for it — the lineage's durable rows in the
 * store's own databases and the derivation state that cites them — because the ticket's production
 * seam is missing from the candidate; the run evidence records that limitation.
 *
 * `packages/security/src/privacy/s03.acceptance.test.ts` covers the export/restore half of S03.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFileLogSource } from '../../../harness-generic/src/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../consolidation/index.js';
import { createContextAssembler, type ImageDescriptor, type ModelDescriptor } from '../context/index.js';
import { createMemoryImporter } from '../import/index.js';
import { createMemoryRecords, type MemoryRecords } from '../records/index.js';
import type { NormalizedEvent } from '../reducers/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../store/index.js';

const PROFILE_ID = 'profile-s03';
const PROJECT_ID = 'project-s03';
const NEIGHBOUR_PROJECT_ID = 'project-s03-neighbour';
const KEY = '5f3a9c1e7b2d40685a1c3e5f7091b2d3e4f5061728394a5b6c7d8e9f0a1b2c3d';
/** Content canaries only: never used in ids or file names, so raw-byte checks stay meaningful. */
const CANARY = 'zephyrq7canary';
const KEPT = 'zephyrq7kept';
const CANARY_QUESTION = `Should we route ${CANARY} through the private lane?`;
const CANARY_CHOICE = `Route ${CANARY} through the private lane.`;
const KEPT_QUESTION = `Should we keep ${KEPT} widgets?`;
const KEPT_CHOICE = `Keep ${KEPT} widgets.`;
/** A decision recorded after the forget: later consolidation must rebuild from surviving evidence. */
const LATER = 'zephyrq7later';
const LATER_QUESTION = `Should we archive ${LATER} reports?`;
const LATER_CHOICE = `Archive ${LATER} reports.`;
const OCCURRED_AT = '2026-09-01T09:00:00.000Z';
const MODEL: ModelDescriptor = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };

const SCOPE = { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: 'session-s03', sensitivity: 'normal' } as const;

const assembler = createContextAssembler({
  tokenizer: { count: (text: string) => text.trim().split(/\s+/).filter((token) => token.length > 0).length },
  imageTokens: (image: ImageDescriptor) => Math.ceil(image.width / 28) * Math.ceil(image.height / 28),
});
/** Forced deterministic extraction: the local fallback, never a model call. */
const reasoner = {
  async run(): Promise<unknown> {
    throw new Error('deterministic fallback only');
  },
};

type Seed = Readonly<{ eventId: string; question: string; choice: string }>;

function batchOf(seeds: readonly Seed[]): NormalizedBatch {
  const payloads: Record<string, unknown> = {};
  const events = seeds.map((seed, index): NormalizedEvent => {
    const payloadRef = `memory://s03/${seed.eventId}`;
    payloads[payloadRef] = { question: seed.question, choice: seed.choice };
    return {
      schemaVersion: 1,
      eventId: seed.eventId,
      sourceId: 's03:live',
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

type Stack = Readonly<{ store: MemoryStore; consolidator: MemoryConsolidator; records: MemoryRecords }>;

async function openStack(directory: string, store: MemoryStore): Promise<Stack> {
  const consolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory, store, reasoner, assembler, model: MODEL });
  const records = await createMemoryRecords({
    projectId: PROJECT_ID,
    directory,
    store,
    source: consolidator,
    extractionVersion: 's03-extraction-v1',
  });
  return { store, consolidator, records };
}

/** Closes the derived readers but keeps the store open, so another stack can be rebuilt over it. */
async function closeReaders(stack: Stack): Promise<void> {
  await stack.records.close();
  await stack.consolidator.close();
}

async function closeStack(stack: Stack): Promise<void> {
  await closeReaders(stack);
  await stack.store.close();
}

/**
 * Every durable surface S03 names, read through the production readers. Keys are the ticket's own
 * nouns so a failure names the surface that still serves forgotten text.
 */
async function surfaceText(stack: Stack, token: string, question: string): Promise<Record<string, string>> {
  const [timeline, facts, decisions, card, consolidated, summaries, answer] = await Promise.all([
    stack.store.timeline({ projectId: PROJECT_ID, text: token }),
    stack.consolidator.facts(),
    stack.consolidator.decisions(),
    stack.consolidator.card('project'),
    stack.consolidator.answer({ question }),
    stack.records.summaries(),
    stack.records.answer({ question }),
  ]);
  return {
    'fts lexical search': timeline.map((item) => `${item.id} ${item.summary}`).join('\n'),
    facts: facts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`).join('\n'),
    decisions: decisions.map((entry) => `${entry.question} ${entry.choice}`).join('\n'),
    'project card': card ?? '',
    'consolidated answer': consolidated.text,
    'record summaries': summaries.map((summary) => `${summary.text} ${summary.sources.join(' ')}`).join('\n'),
    'answer (spoken) text': `${answer.text} ${answer.evidenceIds.join(' ')}`,
  };
}

// --------------------------------------------------------------- forget driver

async function projectDatabases(directory: string): Promise<string[]> {
  const entries = await readdir(join(directory, 'projects'));
  return entries.filter((name) => name.endsWith('.db')).map((name) => join(directory, 'projects', name));
}

function eachDatabase<T>(files: readonly string[], run: (db: DatabaseSync) => T): T[] {
  const results: T[] = [];
  for (const file of files) {
    const db = new DatabaseSync(file);
    try {
      results.push(run(db));
    } finally {
      db.close();
    }
  }
  return results;
}

/** Rows a §5.8 forget removes: the lineage's envelope, payload, capsule and derived decision rows. */
async function purgeLineageRows(directory: string, eventIds: readonly string[]): Promise<number> {
  const files = await projectDatabases(directory);
  return eachDatabase(files, (db) => {
    let removed = 0;
    for (const eventId of eventIds) {
      const payloads = db.prepare('SELECT payload_ref FROM payloads WHERE event_id = ?').all(eventId) as { payload_ref: string }[];
      for (const row of payloads) removed += Number(db.prepare('DELETE FROM payloads WHERE payload_ref = ?').run(row.payload_ref).changes);
      const tasks = db.prepare('SELECT task_key FROM task_observations WHERE event_id = ?').all(eventId) as { task_key: string }[];
      for (const row of tasks) removed += Number(db.prepare('DELETE FROM task_records WHERE task_key = ?').run(row.task_key).changes);
      removed += Number(db.prepare('DELETE FROM task_observations WHERE event_id = ?').run(eventId).changes);
      removed += Number(db.prepare('DELETE FROM source_capsules WHERE event_id = ?').run(eventId).changes);
      removed += Number(db.prepare('DELETE FROM decisions WHERE event_id = ?').run(eventId).changes);
      removed += Number(db.prepare('DELETE FROM events WHERE event_id = ?').run(eventId).changes);
    }
    return removed;
  }).reduce((total, removed) => total + removed, 0);
}

/** Raw rows that survived the purge, so "forgotten" is verified in storage and not only in readers. */
async function survivingLineageRows(directory: string, eventIds: readonly string[]): Promise<string[]> {
  const files = await projectDatabases(directory);
  return eachDatabase(files, (db) => {
    const survivors: string[] = [];
    for (const eventId of eventIds) {
      for (const table of ['events', 'payloads', 'source_capsules', 'decisions', 'task_observations'] as const) {
        const rows = db.prepare(`SELECT 1 FROM ${table} WHERE event_id = ? LIMIT 1`).all(eventId);
        if (rows.length > 0) survivors.push(`${table}:${eventId}`);
      }
    }
    return survivors;
  }).flat();
}

/**
 * The derivation state a §5.8 forget must condense: the durable M02 claims, the watermark and the
 * cached cards that cite the lineage. Leaving any of them behind is exactly what the restart check
 * below catches, because the readers rebuild from this file and never from the deleted rows.
 */
async function condenseConsolidationState(directory: string, forgotten: ReadonlySet<string>): Promise<void> {
  const path = join(directory, 'consolidation', `${encodeURIComponent(PROJECT_ID)}.m02.json`);
  const state = JSON.parse(await readFile(path, 'utf8')) as {
    decisions: unknown[];
    facts: unknown[];
    processedEventIds: string[];
    cards: Record<string, unknown>;
  };
  const citesForgotten = (entry: unknown): boolean => {
    const sources = (entry as { sourceEventIds?: unknown }).sourceEventIds;
    return Array.isArray(sources) && sources.some((id) => forgotten.has(String(id)));
  };
  state.decisions = state.decisions.filter((entry) => !citesForgotten(entry));
  state.facts = state.facts.filter((entry) => !citesForgotten(entry));
  state.processedEventIds = state.processedEventIds.filter((id) => !forgotten.has(id));
  state.cards = {};
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

type ForgetRequest = Readonly<{ directory: string; eventIds: readonly string[] }>;

/** The §5.8 forget effect: durable rows first, then the derivation state that cites them. */
async function forget(request: ForgetRequest): Promise<number> {
  const forgotten = new Set(request.eventIds);
  const removed = await purgeLineageRows(request.directory, request.eventIds);
  await condenseConsolidationState(request.directory, forgotten);
  return removed;
}

/** Real (sourceId, sourceEventId) identity of an event, read from the store the importer wrote. */
async function lineageOf(directory: string, eventId: string): Promise<{ sourceId: string; sourceEventId: string }> {
  const files = await projectDatabases(directory);
  const rows = eachDatabase(files, (db) => db
    .prepare('SELECT source_id, source_event_id FROM events WHERE event_id = ?')
    .all(eventId) as { source_id: string; source_event_id: string }[]).flat();
  assert.equal(rows.length, 1, `expected exactly one stored row for ${eventId}`);
  const row = rows[0];
  assert.ok(row, `expected a stored row for ${eventId}`);
  return { sourceId: row.source_id, sourceEventId: row.source_event_id };
}

// ------------------------------------------------------------------ the oracle

test('S03: a forgotten decision disappears from facts, summaries, FTS, cached answers and spoken text, and reopening does not resurrect it', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-forget-'));
  const store = await createMemoryStore({ directory: root, key: KEY, profileId: PROFILE_ID });
  try {
    const stack = await openStack(root, store);
    await store.ingest(batchOf([
      { eventId: 'evt-s03-canary', question: CANARY_QUESTION, choice: CANARY_CHOICE },
      { eventId: 'evt-s03-kept', question: KEPT_QUESTION, choice: KEPT_CHOICE },
    ]));
    await stack.consolidator.consolidate();

    const before = await surfaceText(stack, CANARY, CANARY_QUESTION);
    for (const [surface, text] of Object.entries(before)) {
      assert.ok(text.includes(CANARY), `${surface} must hold the decision before the forget`);
    }

    const decision = (await stack.consolidator.decisions()).find((entry) => entry.choice.includes(CANARY));
    assert.ok(decision, 'the consolidator must display the decision before the forget');
    const eventIds = decision.sourceEventIds;
    assert.ok(eventIds.length > 0, 'the displayed decision must carry its raw lineage');

    const removed = await forget({ directory: root, eventIds });
    assert.ok(removed >= 4, `the forget must remove the lineage's durable rows (removed ${removed})`);
    assert.deepEqual(await survivingLineageRows(root, eventIds), [], 'no durable row may survive the forget');

    // The store-level surfaces are live: the deleted rows are already unreadable to this process.
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the live store still serves the forgotten decision');

    await closeStack(stack);

    // The ticket's outcome must survive a restart: the readers rebuild from durable derivation
    // state, so a forget that only deleted rows would resurrect the decision right here.
    const reopenedStore = await createMemoryStore({ directory: root, key: KEY, profileId: PROFILE_ID });
    const reopened = await openStack(root, reopenedStore);
    // The user keeps working after the forget: new evidence must rebuild the cards from what is
    // left, without ever re-deriving the forgotten decision.
    await reopenedStore.ingest(batchOf([{ eventId: 'evt-s03-later', question: LATER_QUESTION, choice: LATER_CHOICE }]));
    await reopened.consolidator.consolidate();
    const after = await surfaceText(reopened, CANARY, CANARY_QUESTION);
    for (const [surface, text] of Object.entries(after)) {
      assert.ok(!text.includes(CANARY), `${surface} still serves the forgotten decision after the restart`);
    }
    const unrelated = await surfaceText(reopened, KEPT, KEPT_QUESTION);
    for (const surface of ['facts', 'decisions', 'record summaries', 'answer (spoken) text', 'fts lexical search', 'project card']) {
      assert.ok((unrelated[surface] ?? '').includes(KEPT), `${surface} must keep the unrelated decision after the forget`);
    }
    const later = await surfaceText(reopened, LATER, LATER_QUESTION);
    assert.ok((later['record summaries'] ?? '').includes(LATER), 'evidence recorded after the forget must still reach the summary surface');
    assert.deepEqual(await survivingLineageRows(root, eventIds), [], 'no durable row may return after the restart');
    await closeStack(reopened);
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S03: a forgotten source cannot resurrect its selected record on re-import, and an unrelated project with the same bytes still imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-reimport-'));
  const store = await createMemoryStore({ directory: root, key: KEY, profileId: PROFILE_ID });
  const neighbourDirectory = join(root, 'neighbour-profile');
  const neighbourStore = await createMemoryStore({ directory: neighbourDirectory, key: KEY, profileId: PROFILE_ID });
  try {
    const sourcePath = join(root, 'atlas-session.jsonl');
    await writeFile(sourcePath, [
      JSON.stringify({ id: 'a-0001', seq: 1, kind: 'decision', occurredAt: OCCURRED_AT, question: CANARY_QUESTION, choice: CANARY_CHOICE }),
      JSON.stringify({ id: 'a-0002', seq: 2, kind: 'decision', occurredAt: OCCURRED_AT, question: KEPT_QUESTION, choice: KEPT_CHOICE }),
      '',
    ].join('\n'), 'utf8');

    const stack = await openStack(root, store);
    const importer = await createMemoryImporter({
      directory: join(root, 'import-state-1'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store,
      consolidator: stack.consolidator,
    });
    const first = await importer.bootstrap();
    await importer.close();
    assert.equal(first.coverage.importedEvents, 2, 'the first import must store both records');
    await stack.consolidator.consolidate();

    const canaryItem = (await store.timeline({ projectId: PROJECT_ID, text: CANARY }))[0];
    assert.ok(canaryItem, 'the first import must make the decision retrievable');
    const canaryEventId = canaryItem.sourceEventIds[0];
    assert.ok(canaryEventId, 'the retrieved decision must expose its raw event id');
    const lineage = await lineageOf(root, canaryEventId);

    const tombstones: { sourceId: string; sourceEventIds: string[] }[] = [{ sourceId: first.sourceId, sourceEventIds: [lineage.sourceEventId] }];
    const isSuppressed = (batch: NormalizedBatch): NormalizedBatch => {
      const events = batch.events.filter((event) => !tombstones.some(
        (tombstone) => tombstone.sourceId === event.sourceId && tombstone.sourceEventIds.includes(event.sourceEventId),
      ));
      const payloads = Object.fromEntries(
        Object.entries(batch.payloads).filter(([payloadRef]) => events.some((event) => event.payloadRef === payloadRef)),
      );
      return { events, payloads };
    };
    const guarded: MemoryStore = {
      ingest: (batch, options) => store.ingest(isSuppressed(batch), options),
      timeline: (query) => store.timeline(query),
      durableCursor: () => store.durableCursor(),
      close: () => store.close(),
    };

    const removed = await forget({ directory: root, eventIds: [canaryEventId] });
    assert.ok(removed >= 4, `forgetting the selected record must remove its durable rows (removed ${removed})`);
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the forgotten record must leave the live store');

    const reimport = await createMemoryImporter({
      directory: join(root, 'import-state-2'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store: guarded,
      consolidator: stack.consolidator,
    });
    const second = await reimport.bootstrap();
    await reimport.close();
    assert.equal(second.coverage.importedEvents, 0, 're-importing the forgotten source must not resurrect the selected record');
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the re-import must not put the forgotten record back');
    assert.equal((await store.timeline({ projectId: PROJECT_ID, text: KEPT })).length, 1, 'the unrelated record of the same source must survive');

    // Derived surfaces are read from durable derivation state, so they are checked through readers
    // rebuilt over the same directory after the re-import ran.
    await closeReaders(stack);
    const survivors = await openStack(root, store);
    await survivors.consolidator.consolidate();
    const afterReimport = await surfaceText(survivors, CANARY, CANARY_QUESTION);
    for (const [surface, text] of Object.entries(afterReimport)) {
      assert.ok(!text.includes(CANARY), `${surface} served the forgotten record after the re-import`);
    }
    const keptAfterReimport = await surfaceText(survivors, KEPT, KEPT_QUESTION);
    for (const surface of ['facts', 'decisions', 'record summaries', 'answer (spoken) text']) {
      assert.ok((keptAfterReimport[surface] ?? '').includes(KEPT), `${surface} must keep the unrelated record of the forgotten source`);
    }

    // A different project importing the source's exact bytes must not be blocked by the forget.
    const elsewhere = join(root, 'unrelated-project');
    await mkdir(elsewhere, { recursive: true });
    const copyPath = join(elsewhere, 'atlas-session.jsonl');
    await writeFile(copyPath, await readFile(sourcePath, 'utf8'), 'utf8');
    const sourceIdentity = await createFileLogSource(sourcePath).identity();
    const copyIdentity = await createFileLogSource(copyPath).identity();
    assert.notEqual(sourceIdentity, copyIdentity, 'a copied source must be a distinct import source');

    const neighbourStack = await openStack(neighbourDirectory, neighbourStore);
    const neighbourImporter = await createMemoryImporter({
      directory: join(elsewhere, 'import-state'),
      source: createFileLogSource(copyPath),
      format: 'jsonl',
      scope: { ...SCOPE, projectId: NEIGHBOUR_PROJECT_ID, sessionId: 'session-s03-neighbour' },
      store: neighbourStore,
      consolidator: neighbourStack.consolidator,
    });
    const neighbour = await neighbourImporter.bootstrap();
    await neighbourImporter.close();
    assert.equal(neighbour.coverage.importedEvents, 2, 'an unrelated project must import the same bytes in full');
    assert.equal((await neighbourStore.timeline({ projectId: NEIGHBOUR_PROJECT_ID, text: CANARY })).length, 1, 'the unrelated project must keep its own record');
    assert.deepEqual(await store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the unrelated import must not touch the forgetting profile');
    assert.equal((await neighbourStore.timeline({ projectId: PROJECT_ID })).length, 0, 'project databases must stay isolated');

    // Forgetting the whole source suppresses every record of that source, selected or not.
    tombstones.push({ sourceId: first.sourceId, sourceEventIds: ['a-0002'] });
    const sourceWide = await createMemoryImporter({
      directory: join(root, 'import-state-3'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store: guarded,
      consolidator: survivors.consolidator,
    });
    const third = await sourceWide.bootstrap();
    await sourceWide.close();
    assert.equal(third.coverage.importedEvents, 0, 'a source-wide forget must suppress every record of that source');

    await closeStack(neighbourStack);
    await closeStack(survivors);
  } finally {
    await neighbourStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
