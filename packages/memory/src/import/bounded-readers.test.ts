/**
 * Focused regressions for the two bounded-reader edges of the M03 importer (not the acceptance
 * oracle):
 *
 *  - tail-first preview never returns fewer than `limit` records because blank lines sit among the
 *    newest lines: `readTailLines` keeps walking older windows until it has `limit` non-blank
 *    complete lines;
 *  - a pending repair span that contains an over-long line is re-scanned through the same bounded
 *    `BoundedLineScanner` the forward pass used: the oversized line stays a display-only gap with
 *    empty raw bytes, no read ever materializes it, and the repaired emissions are identical to the
 *    ones the forward pass commits.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createContextAssembler } from '../context/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../consolidation/index.js';
import { type NormalizedEvent } from '../reducers/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../store/index.js';
import {
  createFileLogSource,
  READ_CHUNK_BYTES,
  type GenericLogSource,
} from '../../../harness-generic/src/index.js';
import { createMemoryImporter, type MemoryImporter } from './index.js';
import { readTailLines } from './reader.js';

const KEY = '6b1f0c9a4e7d2583b6a1c0f4d9e8b7023a5c1d6e8f0a2b4c6d8e0f2a4b6c8d0e';
const PROFILE_ID = 'profile-import';
const PROJECT_ID = 'project-atlas-cold';
const SESSION_ID = 'session-cold-1';
const SCOPE = { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, sensitivity: 'normal' as const };
const EMPTY_HASH = `sha256:${createHash('sha256').update(new Uint8Array(0)).digest('hex')}`;

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
    scope: SCOPE,
    store,
    consolidator: stack.consolidator,
  });
}

/** Records every ingested batch so the repair's emissions can be compared with the forward pass. */
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

type EventProjection = {
  eventId: string;
  sourceEventId: string;
  sourceSequence: number;
  kind: string;
  contentHash: string;
};

/**
 * Everything about one ingested envelope that is a pure property of the source bytes. The event id
 * covers the byte span, kind and diagnostic, so parity here means the repair committed exactly what
 * the forward pass would have committed.
 */
function project(events: readonly NormalizedEvent[]): EventProjection[] {
  return events.map((event) => ({
    eventId: event.eventId,
    sourceEventId: event.sourceEventId,
    sourceSequence: event.sourceSequence,
    kind: event.kind,
    contentHash: event.contentHash,
  }));
}

test('readTailLines keeps walking past blank lines until it has limit records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-tail-'));
  try {
    const path = join(root, 'tail.txt');
    await writeFile(path, 'a\n\nb\nc\n', 'utf8');
    const source = createFileLogSource(path);
    const bytes = await source.size();
    const text = async (limit: number): Promise<string[]> => {
      const lines = await readTailLines(source, bytes, limit);
      return lines.map((line) => Buffer.from(line.bytes).toString('utf8'));
    };
    assert.deepEqual(
      await text(3),
      ['a', 'b', 'c'],
      'the newest three non-blank lines include the older a even though the newest lines contain a blank one',
    );
    assert.deepEqual(await text(1), ['c'], 'a limit of one returns the single newest non-blank line');
    assert.deepEqual(await text(5), ['a', 'b', 'c'], 'the walk stops at the start of the file, not at a blank line');
    assert.deepEqual(await text(0), [], 'a zero limit returns nothing');

    const trailing = join(root, 'trailing.txt');
    await writeFile(trailing, 'x\ny\n\n\n\n', 'utf8');
    const trailingSource = createFileLogSource(trailing);
    const trailingLines = await readTailLines(trailingSource, await trailingSource.size(), 2);
    assert.deepEqual(
      trailingLines.map((line) => Buffer.from(line.bytes).toString('utf8')),
      ['x', 'y'],
      'trailing blank lines are skipped instead of consuming the requested record count',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tail-first preview returns the requested newest records across blank lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-preview-blank-'));
  const stack = await createStack(root);
  let importer: MemoryImporter | undefined;
  try {
    const records = [1, 2, 3, 4, 5].map((index) => JSON.stringify({
      id: `blank-${String(index).padStart(4, '0')}`,
      seq: index,
      kind: 'user_utterance',
      occurredAt: new Date(Date.parse('2026-09-05T00:00:00.000Z') + index * 1000).toISOString(),
      text: `Preview record ${index}.`,
    }));
    const path = join(root, 'blank-lines.jsonl');
    // Blank lines interleave the records and end the file, exactly like a hand-edited export.
    await writeFile(path, `${records[0]}\n\n${records[1]}\n\n\n${records[2]}\n${records[3]}\n${records[4]}\n\n\n`, 'utf8');
    importer = await importerFor(root, createFileLogSource(path), stack);
    const preview = await importer.preview({ limit: 3 });
    assert.deepEqual(
      preview.events.map((event) => event.event.sourceEventId),
      ['blank-0003', 'blank-0004', 'blank-0005'],
      'the newest three records are returned even though blank lines sit among the newest lines',
    );
    assert.equal(preview.events.length, 3, 'blank lines never shrink the preview below the requested limit');
    const single = await importer.preview({ limit: 1 });
    assert.deepEqual(single.events.map((event) => event.event.sourceEventId), ['blank-0005']);
  } finally {
    await importer?.close().catch(() => undefined);
    await stack.close();
    await rm(root, { recursive: true, force: true });
  }
});

const GIANT_LINE_BYTES = 5 * 1024 * 1024;
const TAIL_RECORD_COUNT = 4;

type OversizedSourceStats = {
  reads: Array<{ phase: number; offset: number; maxBytes: number; served: number }>;
  maxRequestedBytes: number;
  phase: number;
  markPhase(): void;
};

/**
 * A source whose first line is a 5 MiB line that is *valid JSON* but far beyond `MAX_LINE_BYTES`,
 * followed by a few ordinary records. It serves at most one 64 KiB read per call and refuses any
 * bigger request, so a repair that re-read the pending span as one buffer or parsed its oversized
 * line cannot pass unnoticed: the forward scanner commits that line as a display-only gap.
 */
function createOversizedLineSource(): {
  source: GenericLogSource;
  stats: OversizedSourceStats;
  giantEnd: number;
  totalBytes: number;
} {
  const startedAt = Date.parse('2026-09-04T00:00:00.000Z');
  const giantRecord = JSON.stringify({
    id: 'giant-0000',
    seq: 1,
    kind: 'user_utterance',
    occurredAt: new Date(startedAt).toISOString(),
    text: 'Oversized first line of the pending span; it must stay a display-only gap.',
  });
  const giant = Buffer.from(
    `${giantRecord}${' '.repeat(GIANT_LINE_BYTES - 1 - Buffer.byteLength(giantRecord, 'utf8'))}\n`,
    'utf8',
  );
  assert.equal(giant.byteLength, GIANT_LINE_BYTES, 'the oversized line keeps its exact byte size');
  const tailLines: string[] = [];
  for (let index = 1; index <= TAIL_RECORD_COUNT; index += 1) {
    tailLines.push(JSON.stringify({
      id: `tail-${String(index).padStart(4, '0')}`,
      seq: index + 1,
      kind: 'user_utterance',
      occurredAt: new Date(startedAt + index * 1000).toISOString(),
      text: `Tail record ${index} after the oversized line.`,
    }));
  }
  const tail = Buffer.from(`${tailLines.join('\n')}\n`, 'utf8');
  const totalBytes = giant.byteLength + tail.byteLength;
  const sourceBytes = Buffer.concat([giant, tail]);
  const stats: OversizedSourceStats = {
    reads: [],
    maxRequestedBytes: 0,
    phase: 1,
    markPhase(): void {
      stats.phase += 1;
    },
  };
  const source: GenericLogSource = {
    async identity(): Promise<string> {
      return 'file:cold-oversized.jsonl:0:0';
    },
    async size(): Promise<number> {
      return totalBytes;
    },
    async read(offset: number, maxBytes: number): Promise<Uint8Array> {
      assert.ok(
        maxBytes <= READ_CHUNK_BYTES,
        `one read request must stay inside the §5.8 64 KiB buffer (asked for ${maxBytes} bytes)`,
      );
      const start = Math.max(0, Math.trunc(offset));
      if (start >= totalBytes) return new Uint8Array(0);
      const wanted = Math.max(0, Math.min(Math.trunc(maxBytes), READ_CHUNK_BYTES));
      const end = Math.min(totalBytes, start + wanted);
      const chunk = sourceBytes.subarray(start, end);
      stats.reads.push({ phase: stats.phase, offset: start, maxBytes, served: chunk.byteLength });
      stats.maxRequestedBytes = Math.max(stats.maxRequestedBytes, maxBytes);
      return chunk;
    },
  };
  return { source, stats, giantEnd: giant.byteLength, totalBytes };
}

test('a pending span with an oversized line repairs through the bounded scanner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-oversized-'));
  const forwardRoot = await mkdtemp(join(tmpdir(), 'm03-oversized-forward-'));
  const stack = await createStack(root);
  const forwardStack = await createStack(forwardRoot);
  let repaired: MemoryImporter | undefined;
  let forward: MemoryImporter | undefined;
  try {
    const log = createOversizedLineSource();
    // Window A: the pending span is durable, the store commit never happened.
    const dyingStore = {
      async ingest(): Promise<never> {
        throw new Error('simulated kill before the store commit');
      },
    } as unknown as MemoryStore;
    const dying = await importerFor(root, log.source, stack, dyingStore);
    await dying.bootstrap().then(
      () => assert.fail('the simulated kill must surface'),
      (error: Error) => assert.equal(error.message, 'simulated kill before the store commit'),
    );
    const checkpoint = JSON.parse(await readFile(join(root, 'import-state', 'import-checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.committedOffset, 0, 'the dying run committed nothing');
    assert.equal(checkpoint.pendingOffset, log.giantEnd, 'the pending span is exactly the oversized line');

    // Reopen: the repair must re-scan the pending span, not read it as one buffer.
    log.stats.markPhase();
    const recording = recordingStore(stack.store);
    repaired = await importerFor(root, log.source, stack, recording.store);
    const repairedStatus = await repaired.status();
    assert.equal(repairedStatus.committedOffset, log.giantEnd, 'the repair promotes the pending span');
    assert.equal(repairedStatus.coverage.processedBytes, log.giantEnd, 'processed coverage is the promoted offset');

    assert.equal(recording.batches.length, 1, 'the repair ingests the pending span as one batch');
    const repairedEvents = recording.batches.flatMap((batch) => project(batch.events));
    assert.equal(repairedEvents.length, 1, 'the whole oversized line stays one display-only event');
    const giantEvent = repairedEvents[0];
    assert.ok(giantEvent !== undefined);
    assert.equal(giantEvent.kind, 'gap', 'an oversized line is never parsed into a user_utterance event');
    assert.equal(giantEvent.contentHash, EMPTY_HASH, 'the repair never materialized the 5 MiB line: raw bytes stay empty');
    assert.ok(
      giantEvent.sourceEventId.endsWith(`:1:0-${log.giantEnd}:1`),
      `the repaired gap keeps the forward byte span and ordinal (got ${giantEvent.sourceEventId})`,
    );
    assert.equal(
      repairedEvents.some((event) => event.sourceEventId === 'giant-0000'),
      false,
      'the oversized line never becomes a record with its own sourceEventId',
    );

    const repairReads = log.stats.reads.filter((read) => read.phase === 2);
    assert.ok(repairReads.length > 1, 'the repair streams the span in bounded reads');
    assert.ok(
      log.stats.maxRequestedBytes <= READ_CHUNK_BYTES,
      `the repair keeps the 64 KiB read buffer (asked for ${log.stats.maxRequestedBytes} bytes)`,
    );
    const repairedServed = repairReads.reduce((total, read) => total + read.served, 0);
    assert.ok(
      repairedServed <= log.giantEnd + READ_CHUNK_BYTES,
      `the repair reads only the pending span (served ${repairedServed} bytes for a ${log.giantEnd} byte span)`,
    );
    const repairedTimeline = await stack.store.timeline({ projectId: PROJECT_ID });
    assert.equal(repairedTimeline.length, 1, 'the repair stores the pending span exactly once');
    assert.equal(repairedTimeline[0]?.kind, 'gap', 'no imported observation is invented for the oversized line');
    assert.equal(repairedTimeline[0]?.trust, 'imported');

    const resumed = await repaired.bootstrap();
    assert.equal(resumed.coverage.complete, true, 'the resumed run reaches the end of the source');
    assert.equal(resumed.coverage.duplicates, 0, 'the repair is not charged to the resumed run');
    assert.equal(resumed.coverage.importedEvents, TAIL_RECORD_COUNT, 'only the tail records follow the repair');

    // Forward parity: a clean run over the same bytes must commit the same emissions.
    const forwardRecording = recordingStore(forwardStack.store);
    forward = await importerFor(forwardRoot, createOversizedLineSource().source, forwardStack, forwardRecording.store);
    await forward.bootstrap();
    const forwardEvents = forwardRecording.batches.flatMap((batch) => project(batch.events));
    assert.deepEqual(
      repairedEvents.concat(recording.batches.slice(1).flatMap((batch) => project(batch.events))),
      forwardEvents,
      'the repaired sequence commits byte-identical emissions to the forward pass',
    );
    const capsuleSet = async (store: MemoryStore): Promise<string[]> =>
      (await store.timeline({ projectId: PROJECT_ID })).map((item) => `${item.kind}|${item.summary}`).sort();
    assert.deepEqual(
      await capsuleSet(stack.store),
      await capsuleSet(forwardStack.store),
      'the repaired store holds the same capsules as the forward pass',
    );
  } finally {
    await repaired?.close().catch(() => undefined);
    await forward?.close().catch(() => undefined);
    await stack.close();
    await forwardStack.close();
    await rm(root, { recursive: true, force: true });
    await rm(forwardRoot, { recursive: true, force: true });
  }
});
