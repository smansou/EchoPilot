/**
 * Focused regression tests for the M03 checkpoint protocol (not the acceptance oracle).
 *
 * The frozen acceptance test SIGKILLs a real child process, which can only land in one of the two
 * crash windows by chance. These tests pin both windows deterministically:
 *  - a kill between the pending-span write and the store commit (the store is behind the pending
 *    span, so the repair must insert the records);
 *  - a kill between the store commit and the checkpoint promotion (the store is ahead of the
 *    committed offset, so the repair must re-ingest without double-storing).
 * Both windows must resume with zero duplicated observations and exact capsule coverage.
 *
 * A third test pins the harder invariant the first two do not: the repaired span must commit
 * *identical* emissions — event id, fallback source event id, source sequence and ingest sequence —
 * to the ones the interrupted forward pass would have committed for the same bytes. Records without
 * their own id/seq derive that identity from the durable line ordinal and ingest sequence, so a
 * repair that restarted its counters at 1 instead of continuing from the checkpoint would store a
 * changed observation for every record of a mid-file pending span.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createContextAssembler } from '../context/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../consolidation/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../store/index.js';
import { createFileLogSource, type GenericLogSource } from '../../../harness-generic/src/index.js';
import { createMemoryImporter, type MemoryImporter } from './index.js';

const KEY = '6b1f0c9a4e7d2583b6a1c0f4d9e8b7023a5c1d6e8f0a2b4c6d8e0f2a4b6c8d0e';
const PROFILE_ID = 'profile-import';
const PROJECT_ID = 'project-atlas-cold';
const SESSION_ID = 'session-cold-1';
const CHUNK = 64 * 1024;

const assembler = createContextAssembler({
  tokenizer: { count: (text: string) => text.trim().split(/\s+/).filter((token) => token.length > 0).length },
  imageTokens: (image: { width: number; height: number }) => Math.ceil(image.width / 28) * Math.ceil(image.height / 28),
});

const reasoner = {
  async run(): Promise<unknown> {
    return { decisions: [], facts: [], summary: '' };
  },
};

type Stack = { store: MemoryStore; consolidator: MemoryConsolidator; close(): Promise<void> };

async function createStack(root: string): Promise<Stack> {
  const store = await createMemoryStore({ directory: join(root, 'store'), key: KEY, profileId: PROFILE_ID });
  const consolidator = await createMemoryConsolidator({
    projectId: PROJECT_ID,
    directory: join(root, 'memory'),
    store,
    reasoner,
    assembler,
    model: { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 },
  });
  return {
    store,
    consolidator,
    async close(): Promise<void> {
      await consolidator.close();
      await store.close();
    },
  };
}

async function writeLog(root: string, count: number): Promise<{ path: string; spans: Array<{ start: number; end: number }> }> {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const label = String(index).padStart(5, '0');
    lines.push(JSON.stringify({
      id: `resume-${label}`,
      seq: index + 1,
      kind: 'user_utterance',
      occurredAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1000).toISOString(),
      text: `Deterministic resume-window padding record ${label}.`,
    }));
  }
  const raw = `${lines.join('\n')}\n`;
  const path = join(root, 'resume-log.jsonl');
  await writeFile(path, raw, 'utf8');
  let offset = 0;
  const spans = lines.map((line) => {
    const span = { start: offset, end: offset + Buffer.byteLength(line, 'utf8') + 1 };
    offset = span.end;
    return span;
  });
  return { path, spans };
}

function importerFor(
  root: string,
  source: GenericLogSource,
  stack: Stack,
  store: MemoryStore = stack.store,
): Promise<MemoryImporter> {
  return createMemoryImporter({
    directory: join(root, 'import-state'),
    source,
    format: 'jsonl',
    scope: { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, sensitivity: 'normal' },
    store,
    consolidator: stack.consolidator,
  });
}

/** Records every ingested batch so a repair can be compared with the forward pass. */
function recordingStore(inner: MemoryStore): { store: MemoryStore; batches: NormalizedBatch[] } {
  const batches: NormalizedBatch[] = [];
  const store = {
    ingest: async (batch: NormalizedBatch) => {
      batches.push(batch);
      return inner.ingest(batch);
    },
  } as unknown as MemoryStore;
  return { store, batches };
}

type EmissionProjection = {
  eventId: string;
  sourceEventId: string;
  sourceSequence: number;
  ingestSequence: number;
  kind: string;
  contentHash: string;
};

/** Everything about one emission that is a pure property of the source bytes plus its counters. */
function projectBatch(batch: NormalizedBatch | undefined): EmissionProjection[] {
  return (batch?.events ?? []).map((event) => ({
    eventId: event.eventId,
    sourceEventId: event.sourceEventId,
    sourceSequence: event.sourceSequence,
    ingestSequence: event.ingestSequence,
    kind: event.kind,
    contentHash: event.contentHash,
  }));
}

/**
 * A log of records without their own id or seq: the H03 envelope falls back to the byte span plus
 * the importer's line ordinal, so the durable counters are the record's identity.
 */
async function writeAnonymousLog(root: string, count: number): Promise<{ path: string; spans: Array<{ start: number; end: number }> }> {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const label = String(index).padStart(5, '0');
    lines.push(JSON.stringify({
      kind: 'user_utterance',
      occurredAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1000).toISOString(),
      text: `Anonymous resume-window record ${label}: its identity is the byte span and the durable line ordinal.`,
    }));
  }
  const raw = `${lines.join('\n')}\n`;
  const path = join(root, 'anonymous-log.jsonl');
  await writeFile(path, raw, 'utf8');
  let offset = 0;
  const spans = lines.map((line) => {
    const span = { start: offset, end: offset + Buffer.byteLength(line, 'utf8') + 1 };
    offset = span.end;
    return span;
  });
  return { path, spans };
}

async function capsules(store: MemoryStore): Promise<number> {
  return (await store.timeline({ projectId: PROJECT_ID })).filter((item) => item.kind !== 'task').length;
}

/** Source wrapper that trips an AbortController once it has served `bytes` in this run. */
function abortableSource(path: string, bytes: number): { source: GenericLogSource; signal: AbortSignal } {
  const base = createFileLogSource(path);
  const controller = new AbortController();
  let served = 0;
  return {
    signal: controller.signal,
    source: {
      identity: () => base.identity(),
      size: () => base.size(),
      read: async (offset: number, maxBytes: number) => {
        const chunk = await base.read(offset, maxBytes);
        served += chunk.byteLength;
        if (served >= bytes) controller.abort();
        return chunk;
      },
    },
  };
}

test('a kill between the pending-span write and the store commit repairs forward without duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-window-a-'));
  const stack = await createStack(root);
  try {
    const log = await writeLog(root, 200);
    let calls = 0;
    const dyingStore = {
      ingest: async (batch: Parameters<MemoryStore['ingest']>[0]) => {
        calls += 1;
        if (calls === 1) throw new Error('simulated kill before the store commit');
        return stack.store.ingest(batch);
      },
    } as unknown as MemoryStore;
    const dying = await createMemoryImporter({
      directory: join(root, 'import-state'),
      source: createFileLogSource(log.path),
      format: 'jsonl',
      scope: { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, sensitivity: 'normal' },
      store: dyingStore,
      consolidator: stack.consolidator,
    });
    await dying.bootstrap().then(
      () => assert.fail('the simulated kill must surface'),
      (error: Error) => assert.equal(error.message, 'simulated kill before the store commit'),
    );
    const checkpoint = JSON.parse(await readFile(join(root, 'import-state', 'import-checkpoint.json'), 'utf8'));
    assert.ok(checkpoint.pendingOffset > checkpoint.committedOffset, 'the dying run leaves a pending span');
    assert.equal(await capsules(stack.store), 0, 'nothing reached the store before the simulated kill');

    const reopened = await importerFor(root, createFileLogSource(log.path), stack);
    const recovered = await reopened.status();
    assert.equal(recovered.committedOffset, checkpoint.pendingOffset, 'the repair promotes the pending span');
    const covered = log.spans.filter((span) => span.end <= recovered.committedOffset).length;
    assert.equal(await capsules(stack.store), covered, 'the repaired span is stored exactly once');

    const resumed = await reopened.bootstrap();
    assert.equal(resumed.coverage.complete, true);
    assert.equal(resumed.coverage.duplicates, 0, 'the repair is not charged to the resumed run');
    assert.equal(resumed.coverage.importedEvents, log.spans.length - covered);
    assert.equal(await capsules(stack.store), log.spans.length);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await stack.close();
  }
});

test('a kill between the store commit and the checkpoint promotion re-ingests without double-storing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-window-b-'));
  const stack = await createStack(root);
  try {
    const log = await writeLog(root, 2000);
    const first = abortableSource(log.path, CHUNK);
    const firstImporter = await importerFor(root, first.source, stack);
    await firstImporter.bootstrap({ signal: first.signal }).catch(() => undefined);
    const boundaryOne = (await firstImporter.status()).committedOffset;
    assert.ok(boundaryOne > 0);
    await firstImporter.close();

    const second = abortableSource(log.path, CHUNK);
    const secondImporter = await importerFor(root, second.source, stack);
    await secondImporter.bootstrap({ signal: second.signal }).catch(() => undefined);
    const boundaryTwo = (await secondImporter.status()).committedOffset;
    assert.ok(boundaryTwo > boundaryOne);
    await secondImporter.close();

    // Simulate the SIGKILL window: the store holds every record up to boundaryTwo, but the
    // promotion never landed, so the checkpoint still names boundaryOne with boundaryTwo pending.
    const statePath = join(root, 'import-state', 'import-checkpoint.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.committedOffset, boundaryTwo);
    await writeFile(statePath, `${JSON.stringify({ ...state, committedOffset: boundaryOne, pendingOffset: boundaryTwo })}\n`);
    const storedBefore = await capsules(stack.store);
    assert.equal(storedBefore, log.spans.filter((span) => span.end <= boundaryTwo).length);

    const reopened = await importerFor(root, createFileLogSource(log.path), stack);
    assert.equal((await reopened.status()).committedOffset, boundaryTwo, 'the repair promotes past the committed span');
    assert.equal(await capsules(stack.store), storedBefore, 'the repair never stores a record twice');
    const resumed = await reopened.bootstrap();
    assert.equal(resumed.coverage.duplicates, 0, 'repaired duplicates are not charged to the resumed run');
    assert.equal(resumed.coverage.complete, true);
    assert.equal(await capsules(stack.store), log.spans.length);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await stack.close();
  }
});

test('a mid-file window-A repair commits exactly the emissions the forward pass would have', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-repair-parity-'));
  const forwardRoot = await mkdtemp(join(tmpdir(), 'm03-repair-forward-'));
  const stack = await createStack(root);
  const forwardStack = await createStack(forwardRoot);
  let reopened: MemoryImporter | undefined;
  let forward: MemoryImporter | undefined;
  try {
    const log = await writeAnonymousLog(root, 1200);

    // Forward reference: one clean run over the same bytes records what each batch must contain.
    const forwardRecording = recordingStore(forwardStack.store);
    forward = await importerFor(forwardRoot, createFileLogSource(log.path), forwardStack, forwardRecording.store);
    await forward.bootstrap();
    assert.ok(forwardRecording.batches.length > 1, 'the log must span several batches');

    // The killed run: the first batch commits, the second store call dies after the pending write.
    let dyingCalls = 0;
    const dyingStore = {
      ingest: async (batch: NormalizedBatch) => {
        if (dyingCalls === 2) throw new Error('simulated kill after the pending-span write');
        dyingCalls += 1;
        return stack.store.ingest(batch);
      },
    } as unknown as MemoryStore;
    const dying = await importerFor(root, createFileLogSource(log.path), stack, dyingStore);
    await dying.bootstrap().then(
      () => assert.fail('the simulated kill must surface'),
      (error: Error) => assert.equal(error.message, 'simulated kill after the pending-span write'),
    );
    await dying.close();
    const state = JSON.parse(await readFile(join(root, 'import-state', 'import-checkpoint.json'), 'utf8')) as {
      committedOffset: number;
      pendingOffset: number | null;
    };
    assert.ok(state.committedOffset > 0, 'the first batch committed before the kill');
    assert.ok(
      state.pendingOffset !== null && state.pendingOffset > state.committedOffset,
      'the killed run leaves a mid-file pending span',
    );

    // Reopen: construction repairs the pending span through the same bounded scanner.
    const repairedRecording = recordingStore(stack.store);
    reopened = await importerFor(root, createFileLogSource(log.path), stack, repairedRecording.store);
    const repairedStatus = await reopened.status();
    assert.equal(repairedStatus.committedOffset, state.pendingOffset, 'the repair promotes the pending span');
    assert.equal(repairedRecording.batches.length, 1, 'the repair re-ingests exactly the pending span as one batch');
    const repairedBatch = repairedRecording.batches[0];
    assert.ok(repairedBatch !== undefined && repairedBatch.events.length > 0, 'the pending span carries records');

    // Match the forward batch by the byte span its payloadRef encodes (not by a counter-dependent id).
    const pendingRef = repairedBatch.events[0]?.payloadRef;
    const forwardBatch = forwardRecording.batches.find((batch) => batch.events[0]?.payloadRef === pendingRef);
    assert.ok(
      forwardBatch !== undefined,
      `the forward pass has a batch for the pending span ${String(pendingRef)}`,
    );
    assert.deepEqual(
      projectBatch(repairedBatch),
      projectBatch(forwardBatch),
      'the repair commits the exact events the forward pass committed for the same bytes',
    );
    assert.ok(
      (repairedBatch.events[0]?.sourceSequence ?? 0) > 1,
      'the repaired span continues the durable line ordinal instead of restarting at 1',
    );

    const resumed = await reopened.bootstrap();
    assert.equal(resumed.coverage.duplicates, 0, 'the repair is not charged to the resumed run');
    assert.equal(resumed.coverage.complete, true, 'the resumed run reaches the end of the source');
    assert.equal(await capsules(stack.store), log.spans.length, 'every record is stored exactly once');
  } finally {
    await reopened?.close().catch(() => undefined);
    await forward?.close().catch(() => undefined);
    await stack.close();
    await forwardStack.close();
    await rm(root, { recursive: true, force: true });
    await rm(forwardRoot, { recursive: true, force: true });
  }
});
