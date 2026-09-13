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
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createContextAssembler } from '../context/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../consolidation/index.js';
import { createMemoryStore, type MemoryStore } from '../store/index.js';
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

function importerFor(root: string, source: GenericLogSource, stack: Stack): Promise<MemoryImporter> {
  return createMemoryImporter({
    directory: join(root, 'import-state'),
    source,
    format: 'jsonl',
    scope: { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, sensitivity: 'normal' },
    store: stack.store,
    consolidator: stack.consolidator,
  });
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
