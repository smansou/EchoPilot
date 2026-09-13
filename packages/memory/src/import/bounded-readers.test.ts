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
  MAX_LINE_BYTES,
  createFileLogSource,
  READ_CHUNK_BYTES,
  type GenericLogSource,
} from '../../../harness-generic/src/index.js';
import { BoundedLineScanner } from '../../../harness-generic/src/scanner.js';
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

test('the tail walk reconstructs the newest records from a source that serves short reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-short-read-'));
  const stack = await createStack(root);
  let importer: MemoryImporter | undefined;
  try {
    const records = [1, 2, 3, 4, 5, 6].map((index) => JSON.stringify({
      id: `short-${String(index).padStart(4, '0')}`,
      seq: index,
      kind: 'user_utterance',
      occurredAt: new Date(Date.parse('2026-09-06T00:00:00.000Z') + index * 1000).toISOString(),
      text: `Short-read record ${index}.`,
    }));
    const path = join(root, 'short-read.jsonl');
    await writeFile(path, `${records.join('\n')}\n`, 'utf8');
    // A read cap of seven bytes is far below the requested window: only a repeated-read fill loop can
    // reconstruct the tail instead of mistaking the short read for the end of the source.
    const base = createFileLogSource(path);
    const capped: GenericLogSource = {
      identity: () => base.identity(),
      size: () => base.size(),
      read: (offset: number, maxBytes: number) => base.read(offset, Math.min(maxBytes, 7)),
    };
    const totalBytes = await base.size();
    const lines = await readTailLines(capped, totalBytes, 3);
    assert.deepEqual(
      lines.map((line) => Buffer.from(line.bytes).toString('utf8')),
      records.slice(-3),
      'the backwards walk keeps filling its window when the source serves fewer bytes than asked',
    );
    importer = await importerFor(root, capped, stack);
    const preview = await importer.preview({ limit: 3 });
    assert.deepEqual(
      preview.events.map((event) => event.event.sourceEventId),
      ['short-0004', 'short-0005', 'short-0006'],
      'a short-reading source still yields the exact newest records in the preview',
    );
    const run = await importer.bootstrap();
    assert.equal(run.coverage.importedEvents, records.length, 'every record is imported exactly once');
  } finally {
    await importer?.close().catch(() => undefined);
    await stack.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the tail walk keeps its record count across blank lines that span several read windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-preview-windows-'));
  const stack = await createStack(root);
  let importer: MemoryImporter | undefined;
  try {
    // Wide records put consecutive record ends in different 64 KiB windows, and blank lines sit both
    // between the newest records and at the end of the file: the walk must cross windows and keep
    // replenishing the scan instead of stopping at the first skipped line (or at `limit + 1` newlines).
    const records = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => JSON.stringify({
      id: `window-${String(index).padStart(4, '0')}`,
      seq: index,
      kind: 'user_utterance',
      occurredAt: new Date(Date.parse('2026-09-07T00:00:00.000Z') + index * 1000).toISOString(),
      text: `Wide preview record ${index}. ${'wide '.repeat(index >= 6 ? 20_000 : 4)}`,
    }));
    const lines = records.flatMap((record, index) => (index % 2 === 0 ? [record, ''] : [record, '   ']));
    const raw = `${lines.join('\n')}\n\n\n`;
    const path = join(root, 'windowed-blank-lines.jsonl');
    await writeFile(path, raw, 'utf8');
    const source = createFileLogSource(path);
    const totalBytes = await source.size();
    assert.ok(totalBytes > 4 * READ_CHUNK_BYTES, 'the fixture must span several 64 KiB read windows');

    const expectedNewest = records.slice(-3);
    const tail = await readTailLines(source, totalBytes, 3);
    assert.deepEqual(
      tail.map((line) => Buffer.from(line.bytes).toString('utf8')),
      expectedNewest,
      'the backward walk crosses windows and keeps going past blank lines until it has three records',
    );
    assert.deepEqual(
      tail.map((line) => line.end - line.start),
      expectedNewest.map((line) => Buffer.byteLength(line, 'utf8') + 1),
      'each returned span covers exactly one complete line, terminator included',
    );

    importer = await importerFor(root, source, stack);
    const preview = await importer.preview({ limit: 3 });
    assert.deepEqual(
      preview.events.map((event) => event.event.sourceEventId),
      ['window-0006', 'window-0007', 'window-0008'],
      'preview returns the newest three records even though blank lines sit among them',
    );
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

test('the tail walk classifies an over-buffer line exactly as the bounded scanner does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-boundary-'));
  try {
    const recordLine = (id: string, contentBytes: number): string => {
      const record = JSON.stringify({
        id,
        kind: 'user_utterance',
        occurredAt: '2026-09-08T00:00:00.000Z',
        text: 'Boundary classification padding.',
      });
      const padding = contentBytes - Buffer.byteLength(record, 'utf8');
      assert.ok(padding >= 0, 'the boundary record must fit inside its content length');
      return `${record}${' '.repeat(padding)}`;
    };
    // One line exactly at the §5.8 buffer and one just over it: the forward scanner only drops a line
    // once its bytes are still newline-free as the buffer passes MAX_LINE_BYTES, so "longer than
    // MAX_LINE_BYTES" is not by itself an oversized line. The tail walk must use the same classifier.
    const lines = [
      recordLine('boundary-exact', MAX_LINE_BYTES),
      recordLine('boundary-over', MAX_LINE_BYTES + 1),
      recordLine('boundary-tail', 256),
    ];
    const path = join(root, 'boundary.jsonl');
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    const source = createFileLogSource(path);
    const totalBytes = await source.size();

    const scanner = new BoundedLineScanner(source, 0);
    const forwardTypes: string[] = [];
    for (let index = 0; index < lines.length; index += 1) forwardTypes.push((await scanner.next()).type);
    assert.deepEqual(
      forwardTypes,
      ['line', 'line', 'line'],
      'the forward scanner keeps both boundary lines, so the preview must not turn one into a gap',
    );

    const spans = await readTailLines(source, totalBytes, lines.length, () => true);
    assert.deepEqual(
      spans.map((span) => (span.oversized === true ? 'oversized' : 'line')),
      forwardTypes,
      'every tail span is classified exactly as the forward scanner classifies the same line',
    );
    assert.equal(spans[0]?.bytes.byteLength, MAX_LINE_BYTES, 'the buffer-sized line keeps its bytes');
    assert.equal(
      spans[1]?.bytes.byteLength,
      MAX_LINE_BYTES + 1,
      'a line just over the buffer keeps the scanner line classification and its bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tail-first preview reports an oversized tail line as the display-only gap bootstrap commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'm03-preview-oversized-'));
  const forwardRoot = await mkdtemp(join(tmpdir(), 'm03-preview-oversized-forward-'));
  const stack = await createStack(root);
  const forwardStack = await createStack(forwardRoot);
  let previewed: MemoryImporter | undefined;
  let forward: MemoryImporter | undefined;
  try {
    const log = createOversizedLineSource();
    previewed = await importerFor(root, log.source, stack);
    const preview = await previewed.preview({ limit: TAIL_RECORD_COUNT + 1 });
    assert.equal(
      preview.events.length,
      TAIL_RECORD_COUNT + 1,
      'the oversized line consumes one preview slot exactly like the gap bootstrap commits',
    );
    const gap = preview.events[0];
    assert.ok(gap !== undefined);
    assert.equal(gap.event.kind, 'gap', 'an oversized tail line is never parsed into a user_utterance record');
    assert.equal(
      gap.event.contentHash,
      EMPTY_HASH,
      'the preview never materialized the oversized line: its raw bytes stay empty',
    );
    assert.equal(gap.diagnostic, 'malformed_json', 'the preview carries the same display-only gap diagnostic');
    assert.equal(gap.cursor.offset, log.giantEnd, 'the gap covers the byte span the forward pass commits');
    assert.equal(gap.event.sourceSequence, 1, 'the oversized line keeps the line ordinal of the source');
    assert.deepEqual(
      preview.events.slice(1).map((event) => event.event.sourceEventId),
      ['tail-0001', 'tail-0002', 'tail-0003', 'tail-0004'],
      'the records after the oversized line still preview in chronological order',
    );
    assert.equal(
      preview.events.some((event) => event.event.sourceEventId === 'giant-0000'),
      false,
      'the oversized line never becomes a record with its own sourceEventId',
    );
    assert.ok(
      log.stats.maxRequestedBytes <= READ_CHUNK_BYTES,
      `the preview keeps the 64 KiB read buffer (asked for ${log.stats.maxRequestedBytes} bytes)`,
    );

    // Forward parity: bootstrap over the same bytes commits the identical gap, so the tail-first
    // preview and the final import describe the same records.
    const forwardRecording = recordingStore(forwardStack.store);
    forward = await importerFor(forwardRoot, createOversizedLineSource().source, forwardStack, forwardRecording.store);
    await forward.bootstrap();
    const forwardEvents = forwardRecording.batches.flatMap((batch) => batch.events);
    const forwardGap = forwardEvents.find((event) => event.kind === 'gap');
    assert.ok(forwardGap !== undefined, 'a clean forward run commits the oversized line as a gap');
    assert.equal(gap.event.eventId, forwardGap.eventId, 'preview and bootstrap derive the same gap event id');
    assert.equal(
      gap.event.sourceEventId,
      forwardGap.sourceEventId,
      'preview and bootstrap synthesize the same gap identity from the byte span',
    );
    assert.equal(gap.event.payloadRef, forwardGap.payloadRef, 'preview and bootstrap agree on the gap span');
    for (const event of preview.events.slice(1)) {
      const match = forwardEvents.find((candidate) => candidate.sourceEventId === event.event.sourceEventId);
      assert.ok(match !== undefined, `the forward run must commit ${event.event.sourceEventId}`);
      assert.equal(event.event.eventId, match.eventId, `preview and bootstrap agree on ${event.event.sourceEventId}`);
    }
  } finally {
    await previewed?.close().catch(() => undefined);
    await forward?.close().catch(() => undefined);
    await stack.close();
    await forwardStack.close();
    await rm(root, { recursive: true, force: true });
    await rm(forwardRoot, { recursive: true, force: true });
  }
});
