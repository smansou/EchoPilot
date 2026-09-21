/**
 * S03 production-wiring oracle — the desktop control drives the real profile service.
 *
 * The ticket's frozen oracles predate the privacy/deletion modules and pin the ticket's outcome
 * with hand-rolled purges and file copies, so they cannot show that the delivered seams actually
 * run. This oracle is that other half: every path below goes through the production APIs the
 * ticket ships, with no double anywhere —
 *
 *   - `createProfilePrivacyHost` builds the renderer's `PrivacyOperations` from a real
 *     `createMemoryStore` profile (its own `privacy` handle) and the passphrase-sealed
 *     `exportProfile`/`importProfile` pair from `@echopilot/security`;
 *   - `createPrivacyControl` stages and confirms what the user chose, exactly as `main.tsx` does;
 *   - the ordinary store and the ordinary `createMemoryImporter` are used unmodified, so
 *     "a re-import cannot resurrect a forgotten record" is the store's own ingest guard;
 *   - the retrieval checks read the real M02 consolidator and M04 records surfaces.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { createFileLogSource } from '../../../../../../packages/harness-generic/src/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../../../../../../packages/memory/src/consolidation/index.js';
import { createContextAssembler, type ImageDescriptor, type ModelDescriptor } from '../../../../../../packages/memory/src/context/index.js';
import { createMemoryImporter } from '../../../../../../packages/memory/src/import/index.js';
import { createMemoryRecords, type MemoryRecords } from '../../../../../../packages/memory/src/records/index.js';
import type { EventScope, NormalizedEvent } from '../../../../../../packages/memory/src/reducers/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../../../../../../packages/memory/src/store/index.js';
import { createPrivacyControl } from './index.js';
import { createProfilePrivacyHost, type ProfilePrivacyHost } from './profile-host.js';

const PROFILE_ID = 'profile-s03-control';
const PROJECT_ID = 'project-s03-control';
const NEIGHBOUR_PROJECT_ID = 'project-s03-control-neighbour';
const KEY = '7b2d40685a1c3e5f7091b2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f6071';
const PASSPHRASE = 'correct horse battery staple';
const WRONG_PASSPHRASE = 'incorrect horse battery staple';
/** Content canaries only: never part of an id or a file name, so raw-byte checks stay meaningful. */
const CANARY = 'sunlitcontrol5';
const KEPT = 'sunlitkept5';
const CANARY_QUESTION = `Should we route ${CANARY} through the private lane?`;
const CANARY_CHOICE = `Route ${CANARY} through the private lane.`;
const KEPT_QUESTION = `Should we keep ${KEPT} widgets?`;
const KEPT_CHOICE = `Keep ${KEPT} widgets.`;
const OCCURRED_AT = '2026-09-05T09:00:00.000Z';
const MODEL: ModelDescriptor = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };

const SCOPE = { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: 'session-s03-control', sensitivity: 'normal' } as const;

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

function batchOf(seeds: readonly Seed[], scope: EventScope = SCOPE, sourceId = 's03:control-live'): NormalizedBatch {
  const payloads: Record<string, unknown> = {};
  const events = seeds.map((seed, index): NormalizedEvent => {
    const payloadRef = `memory://s03-control/${seed.eventId}`;
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
      scope,
      kind: 'decision',
      payloadRef,
      contentHash: `sha256:${seed.eventId}`,
      trust: 'user_explicit',
    };
  });
  return { events, payloads };
}

type Readers = Readonly<{ consolidator: MemoryConsolidator; records: MemoryRecords }>;

/** The production M02 + M04 readers, built over the host's own profile directory and store. */
async function openReaders(directory: string, store: MemoryStore): Promise<Readers> {
  const consolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory, store, reasoner, assembler, model: MODEL });
  const records = await createMemoryRecords({ projectId: PROJECT_ID, directory, store, source: consolidator, extractionVersion: 's03-control-v1' });
  return { consolidator, records };
}

async function closeReaders(readers: Readers): Promise<void> {
  await readers.records.close();
  await readers.consolidator.close();
}

/** Every durable surface S03 names, read through the production readers. */
async function surfaceText(readers: Readers, store: MemoryStore, token: string, question: string): Promise<Record<string, string>> {
  const [timeline, facts, decisions, card, consolidated, summaries, answer] = await Promise.all([
    store.timeline({ projectId: PROJECT_ID, text: token }),
    readers.consolidator.facts(),
    readers.consolidator.decisions(),
    readers.consolidator.card('project'),
    readers.consolidator.answer({ question }),
    readers.records.summaries(),
    readers.records.answer({ question }),
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

async function hostFor(root: string, name: string): Promise<ProfilePrivacyHost> {
  return createProfilePrivacyHost({
    directory: join(root, `${name}-profile`),
    key: KEY,
    profileId: PROFILE_ID,
    archivePath: join(root, `${name}.echopilot`),
    restoreDirectory: join(root, `${name}-restored`),
  });
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

async function treeDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  for (const file of await filesUnder(root)) {
    digest.update(file);
    digest.update('\u0000');
    digest.update(await readFile(join(root, file)));
    digest.update('\u0000');
  }
  return digest.digest('hex');
}

test('S03 control: a confirmed forget through the desktop control clears every retrieval surface and survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-control-forget-'));
  const host = await hostFor(root, 'forget');
  try {
    await host.store.ingest(batchOf([
      { eventId: 'ctl-canary', question: CANARY_QUESTION, choice: CANARY_CHOICE },
      { eventId: 'ctl-kept', question: KEPT_QUESTION, choice: KEPT_CHOICE },
    ]));
    let readers = await openReaders(host.directory, host.store);
    await readers.consolidator.consolidate();

    const before = await surfaceText(readers, host.store, CANARY, CANARY_QUESTION);
    for (const [surface, text] of Object.entries(before)) {
      assert.ok(text.includes(CANARY), `${surface} must hold the decision before the forget`);
    }
    const decision = (await readers.consolidator.decisions()).find((entry) => entry.choice.includes(CANARY));
    assert.ok(decision, 'the consolidator must display the decision before the forget');
    const eventIds = decision.sourceEventIds;
    assert.ok(eventIds.length > 0, 'the displayed decision must carry its raw lineage');
    await closeReaders(readers);

    const control = createPrivacyControl(host.operations);
    const staged = control.requestForget({ eventIds }, 'the field decision');
    assert.equal(staged.pendingForget?.label, 'the field decision');
    assert.equal((await host.store.timeline({ projectId: PROJECT_ID, text: CANARY })).length, 1, 'staging a forget must not delete anything');

    const confirmed = await control.confirmForget();
    assert.ok(confirmed.forget.kind === 'succeeded', `the control's confirmed forget must run the profile service (${JSON.stringify(confirmed.forget)})`);
    assert.deepEqual(await host.store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the forgotten decision must leave lexical search');
    assert.ok((await host.snapshot()).forgotten.some((identity) => identity.sourceEventIds.length > 0), 'the profile must durably record the forgotten identity');

    readers = await openReaders(host.directory, host.store);
    await readers.consolidator.consolidate();
    const after = await surfaceText(readers, host.store, CANARY, CANARY_QUESTION);
    for (const [surface, text] of Object.entries(after)) {
      assert.ok(!text.includes(CANARY), `${surface} still serves the forgotten decision after the forget`);
    }
    const kept = await surfaceText(readers, host.store, KEPT, KEPT_QUESTION);
    for (const surface of ['facts', 'decisions', 'record summaries', 'answer (spoken) text']) {
      assert.ok((kept[surface] ?? '').includes(KEPT), `${surface} must keep the unrelated decision after the forget`);
    }
    await closeReaders(readers);

    // The readers rebuild from durable derivation state, so a forget that only cleaned the live
    // readers would resurrect the decision right here.
    await host.close();
    const reopened = await createMemoryStore({ directory: host.directory, key: KEY, profileId: PROFILE_ID });
    try {
      const recovered = await openReaders(host.directory, reopened);
      await recovered.consolidator.consolidate();
      const restarted = await surfaceText(recovered, reopened, CANARY, CANARY_QUESTION);
      for (const [surface, text] of Object.entries(restarted)) {
        assert.ok(!text.includes(CANARY), `${surface} resurrected the forgotten decision after a restart`);
      }
      const keptAfterRestart = await surfaceText(recovered, reopened, KEPT, KEPT_QUESTION);
      for (const surface of ['facts', 'decisions', 'record summaries', 'answer (spoken) text']) {
        assert.ok((keptAfterRestart[surface] ?? '').includes(KEPT), `${surface} must keep the unrelated decision after a restart`);
      }
      await closeReaders(recovered);
    } finally {
      await reopened.close();
    }
  } finally {
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S03 control: an ordinary import cannot resurrect a forgotten record, and an unrelated project importing the same bytes still can', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-control-reimport-'));
  const host = await hostFor(root, 'reimport');
  const neighbour = await hostFor(root, 'neighbour');
  try {
    const sourcePath = join(root, 'atlas-session.jsonl');
    await writeFile(sourcePath, [
      JSON.stringify({ id: 'a-0001', seq: 1, kind: 'decision', occurredAt: OCCURRED_AT, question: CANARY_QUESTION, choice: CANARY_CHOICE }),
      JSON.stringify({ id: 'a-0002', seq: 2, kind: 'decision', occurredAt: OCCURRED_AT, question: KEPT_QUESTION, choice: KEPT_CHOICE }),
      '',
    ].join('\n'), 'utf8');

    const readers = await openReaders(host.directory, host.store);
    const importer = await createMemoryImporter({
      directory: join(root, 'import-state-1'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store: host.store,
      consolidator: readers.consolidator,
    });
    const first = await importer.bootstrap();
    await importer.close();
    assert.equal(first.coverage.importedEvents, 2, 'the ordinary import must store both records');
    await readers.consolidator.consolidate();

    const item = (await host.store.timeline({ projectId: PROJECT_ID, text: CANARY }))[0];
    assert.ok(item, 'the imported decision must be retrievable');
    const eventId = item.sourceEventIds[0];
    assert.ok(eventId, 'the retrieved decision must expose its raw event id');
    await closeReaders(readers);

    const control = createPrivacyControl(host.operations);
    control.requestForget({ eventIds: [eventId] }, 'the imported field decision');
    const confirmed = await control.confirmForget();
    assert.ok(confirmed.forget.kind === 'succeeded', 'the imported record must be forgettable through the control');
    assert.deepEqual(await host.store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the forget must remove the imported record');

    const survivors = await openReaders(host.directory, host.store);
    // The store here is the ordinary `createMemoryStore` store, never a wrapper: the guard that
    // must stop the re-import is the store's own ingest boundary.
    const reimport = await createMemoryImporter({
      directory: join(root, 'import-state-2'),
      source: createFileLogSource(sourcePath),
      format: 'jsonl',
      scope: SCOPE,
      store: host.store,
      consolidator: survivors.consolidator,
    });
    const second = await reimport.bootstrap();
    await reimport.close();
    assert.equal(second.coverage.importedEvents, 0, 're-importing the forgotten source must not resurrect the selected record');
    assert.deepEqual(await host.store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the re-import must not put the forgotten record back');
    assert.equal((await host.store.timeline({ projectId: PROJECT_ID, text: KEPT })).length, 1, 'the unrelated record of the same source must survive');
    await closeReaders(survivors);

    await neighbour.store.ingest(batchOf([{ eventId: 'neighbour-ordinary', question: KEPT_QUESTION, choice: KEPT_CHOICE }], { ...SCOPE, projectId: NEIGHBOUR_PROJECT_ID, sessionId: 'session-s03-control-neighbour' }));
    const copyPath = join(root, 'atlas-session-copy.jsonl');
    await writeFile(copyPath, await readFile(sourcePath, 'utf8'), 'utf8');
    const neighbourReaders = await openReaders(neighbour.directory, neighbour.store);
    const neighbourImport = await createMemoryImporter({
      directory: join(root, 'neighbour-import-state'),
      source: createFileLogSource(copyPath),
      format: 'jsonl',
      scope: { ...SCOPE, projectId: NEIGHBOUR_PROJECT_ID, sessionId: 'session-s03-control-neighbour' },
      store: neighbour.store,
      consolidator: neighbourReaders.consolidator,
    });
    const copied = await neighbourImport.bootstrap();
    await neighbourImport.close();
    assert.equal(copied.coverage.importedEvents, 2, 'an unrelated project must import the same bytes in full');
    assert.equal((await neighbour.store.timeline({ projectId: NEIGHBOUR_PROJECT_ID, text: CANARY })).length, 1, 'the unrelated project must keep its own record');
    assert.deepEqual(await host.store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'the unrelated import must not touch the forgetting profile');
    await closeReaders(neighbourReaders);
  } finally {
    await neighbour.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S03 control: export seals the profile, a wrong passphrase leaves the destination untouched, and the restore carries the evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-control-export-'));
  const host = await hostFor(root, 'export');
  try {
    await host.store.ingest(batchOf([
      { eventId: 'ctl-export-canary', question: CANARY_QUESTION, choice: CANARY_CHOICE },
      { eventId: 'ctl-export-kept', question: KEPT_QUESTION, choice: KEPT_CHOICE },
    ]));
    const readers = await openReaders(host.directory, host.store);
    await readers.consolidator.consolidate();
    const exportedTimeline = await host.store.timeline({ projectId: PROJECT_ID });
    assert.equal(exportedTimeline.length, 2, 'the profile must hold the evidence before the export');
    await closeReaders(readers);

    const control = createPrivacyControl(host.operations);
    const exported = await control.exportProfile({ passphrase: PASSPHRASE });
    assert.ok(exported.export.kind === 'succeeded', `the export must succeed (${JSON.stringify(exported.export)})`);
    const archive = join(root, 'export.echopilot');
    assert.ok((await stat(archive)).isFile(), 'the export must land at the host-configured archive path');
    const bytes = await readFile(archive);
    for (const plaintext of [CANARY, CANARY_CHOICE]) {
      assert.ok(!bytes.includes(Buffer.from(plaintext, 'utf8')), 'the export must not ship decision text in plaintext');
    }

    const restoreDirectory = join(root, 'export-restored');
    const wrong = await control.importProfile({ archive, passphrase: WRONG_PASSPHRASE });
    assert.ok(wrong.import.kind === 'failed', 'a wrong passphrase must fail the restore');
    assert.ok(wrong.import.kind === 'failed' && wrong.import.reason.endsWith('The destination was not modified.'), 'a failed restore must say the destination was untouched');
    await assert.rejects(() => stat(restoreDirectory), 'a failed restore must not create the destination');
    assert.deepEqual((await readdir(root)).filter((name) => name.includes('.restore-')), [], 'a failed restore must not leave staging debris');

    // The empty archive argument exercises the host's configured default for a one-shot restore.
    const restored = await control.importProfile({ archive: '', passphrase: PASSPHRASE });
    assert.ok(restored.import.kind === 'succeeded', `the correct passphrase must restore (${JSON.stringify(restored.import)})`);

    const restoredStore = await createMemoryStore({ directory: restoreDirectory, key: KEY, profileId: PROFILE_ID });
    try {
      assert.deepEqual(await restoredStore.timeline({ projectId: PROJECT_ID }), exportedTimeline, 'the restored profile must reproduce the exported timeline');
      const restoredReaders = await openReaders(restoreDirectory, restoredStore);
      await restoredReaders.consolidator.consolidate();
      assert.ok((await restoredReaders.consolidator.facts()).some((fact) => fact.object.includes(CANARY)), 'the restored profile must re-derive the decision fact');
      const answer = await restoredReaders.records.answer({ question: CANARY_QUESTION });
      assert.equal(answer.supported, true, 'the restored profile must answer from restored evidence');
      assert.ok(answer.text.includes(CANARY), 'the restored answer must cite the restored decision');
      await closeReaders(restoredReaders);
    } finally {
      await restoredStore.close();
    }

    const digestBefore = await treeDigest(restoreDirectory);
    const again = await control.importProfile({ archive, passphrase: PASSPHRASE });
    assert.ok(again.import.kind === 'failed', 'a restore must refuse a destination that already exists');
    assert.equal(await treeDigest(restoreDirectory), digestBefore, 'the refused restore must not modify the existing profile');
  } finally {
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S03 control: a private session opened through the control keeps captures out of durable storage, and ending it hands the transcript back once', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-control-private-'));
  const host = await hostFor(root, 'private');
  try {
    const control = createPrivacyControl(host.operations);
    const began = await control.beginPrivateSession();
    assert.equal(began.private, true, 'the indicator must turn on for the session the profile registry opened');
    const sessionId = began.privateSessionId;
    assert.ok(sessionId, 'the storage boundary needs the session id the host opened');
    assert.deepEqual((await host.snapshot()).openSessions, [sessionId], 'the profile registry must hold exactly the session the control opened');

    const diverted = await host.store.ingest(batchOf([{ eventId: 'ctl-private', question: CANARY_QUESTION, choice: CANARY_CHOICE }], { ...SCOPE, sessionId }));
    assert.equal(diverted.inserted, 0, 'a private capture must never reach the store');
    assert.deepEqual(await host.store.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'a private capture must not be retrievable');

    const ended = await control.endPrivateSession();
    assert.equal(ended.private, false, 'ending the session must turn the indicator off');
    assert.equal(ended.privateTranscript.length, 1, 'the profile must hand the transcript back exactly once');
    assert.ok(ended.privateTranscript[0]?.text.includes(CANARY), 'the transcript is what the UI may show for the session');
    assert.deepEqual((await host.snapshot()).openSessions, [], 'the registry must drop the session when it ends');

    const late = await host.store.ingest(batchOf([{ eventId: 'ctl-private-late', question: CANARY_QUESTION, choice: CANARY_CHOICE }], { ...SCOPE, sessionId }));
    assert.equal(late.inserted, 0, 'a stale batch carrying an ended session id must be dropped, never stored');
    const ordinary = await host.store.ingest(batchOf([{ eventId: 'ctl-ordinary', question: KEPT_QUESTION, choice: KEPT_CHOICE }]));
    assert.equal(ordinary.inserted, 1, 'an ordinary capture must still reach the store');

    await host.close();
    const reopened = await createMemoryStore({ directory: host.directory, key: KEY, profileId: PROFILE_ID });
    try {
      assert.deepEqual(await reopened.timeline({ projectId: PROJECT_ID, text: CANARY }), [], 'a private capture must not survive a restart');
      assert.equal((await reopened.timeline({ projectId: PROJECT_ID, text: KEPT })).length, 1, 'the ordinary capture must survive the restart');
    } finally {
      await reopened.close();
    }
  } finally {
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
