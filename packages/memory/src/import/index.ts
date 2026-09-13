/**
 * M03 — unseen historical log → resumable bootstrap → the same useful memory as live ingestion.
 *
 * The importer is the cold-start half of the same pipeline live events use: it never writes its own
 * memory. It streams the H03 read-only `GenericLogSource` in ≤64 KiB reads, parses each JSONL/text
 * record into an H03 imported envelope whose payload is the record's own fields, hands the envelopes
 * to the M01 `MemoryStore` exactly like live ingestion would, consolidates them through the shared
 * M02 `MemoryConsolidator`, and commits a durable byte-offset checkpoint in `directory` so a killed
 * run resumes after the last committed record instead of replaying the file or dropping bytes.
 *
 * Resumability contract:
 *  - `committedOffset` is the offset after the last record whose observations are durably stored;
 *    `coverage.processedBytes` always equals it and `complete` is true only when every byte of the
 *    measured source has been processed.
 *  - a batch is marked `pending` before it is ingested and promoted after the store commit, so a
 *    SIGKILL at any instant leaves either a consistent checkpoint or a pending span that the next
 *    construction repairs by re-ingesting it (the store deduplicates by `(sourceId, sourceEventId)`).
 *  - every call re-measures the source, so records appended after a completed import are picked up
 *    on the next call, and a re-delivered record is counted in `coverage.duplicates` instead of
 *    being stored twice.
 *
 * Imported content is untrusted evidence only: every envelope carries trust `imported`, an
 * authorization-shaped record keeps the generic adapter's display-only `unsupported` kind, and the
 * importer exposes no send/grant/approval surface at all.
 */
import { mkdir } from 'node:fs/promises';

import { GENERIC_FORMAT_VERSION } from '../../../harness-generic/src/envelope.js';
import { DEFAULT_PREVIEW_LIMIT, normalizePreviewLimit } from '../../../harness-generic/src/limits.js';
import { BoundedLineScanner, READ_CHUNK_BYTES } from '../../../harness-generic/src/scanner.js';
import type { LineScan } from '../../../harness-generic/src/scanner.js';
import type {
  GenericCapabilityDescriptor,
  GenericFormat,
  GenericLogSource,
  GenericPreviewEvent,
  GenericScope,
} from '../../../harness-generic/src/types.js';
import type { MemoryConsolidator } from '../consolidation/index.js';
import { ImportCheckpointStore, type ImportCheckpoint } from '../jobs/index.js';
import type { MemoryStore, NormalizedBatch } from '../store/index.js';
import { readTailLines } from './reader.js';
import { buildEmission, oversizedRecord, parseLine, type LineSpan, type ParsedRecord } from './records.js';

/** One committed batch covers at most one §5.8 64 KiB read buffer. */
export const IMPORT_BATCH_BYTES = READ_CHUNK_BYTES;

export type ImportCoverage = {
  processedBytes: number;
  totalBytes: number;
  complete: boolean;
  importedEvents: number;
  duplicates: number;
};

export type ImportRunResult = {
  sourceId: string;
  generation: number;
  committedOffset: number;
  coverage: ImportCoverage;
};

export type ImportStatus = ImportRunResult & { totalBytes: number };

export type ImportPreview = {
  events: GenericPreviewEvent[];
  coverage: ImportCoverage;
};

export interface MemoryImporter {
  bootstrap(options?: { signal?: AbortSignal }): Promise<ImportRunResult>;
  preview(options?: { limit?: number }): Promise<ImportPreview>;
  status(): Promise<ImportStatus>;
  capabilities(): Promise<GenericCapabilityDescriptor>;
  close(): Promise<void>;
}

export interface MemoryImporterOptions {
  /** Durable import state (byte-offset checkpoint plus coverage); created if missing. */
  directory: string;
  /** The H03 read-only log source; the importer never writes to it. */
  source: GenericLogSource;
  format: GenericFormat;
  scope: GenericScope;
  store: MemoryStore;
  consolidator: MemoryConsolidator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error('the memory import was aborted before the source was fully processed');
  error.name = 'AbortError';
  return error;
}

/**
 * Maps one bounded scanner result to the span and record both the forward pass and the pending-span
 * repair commit. An `oversized` scan is display-only: its raw bytes are never materialized (the
 * scanner dropped them after MAX_LINE_BYTES) and it is never parsed, so a multi-gigabyte line stays
 * a gap with empty raw bytes and empty payload on every pass.
 */
function scannedRecord(
  scan: LineScan,
  format: GenericFormat,
  lineOrdinal: number,
): { span: LineSpan; record: ParsedRecord | undefined } {
  if (scan.type === 'oversized') {
    return {
      span: { start: scan.start, end: scan.end, bytes: new Uint8Array(0) },
      record: oversizedRecord(format, lineOrdinal),
    };
  }
  if (scan.type !== 'line') {
    throw new Error(`cannot map a '${scan.type}' scan to an imported record`);
  }
  const span: LineSpan = { start: scan.start, end: scan.end, bytes: scan.bytes };
  return { span, record: parseLine(span, format, lineOrdinal) };
}

/**
 * Opens the resumable importer for one source. The durable directory is repaired here (not in
 * `bootstrap`) so a crash between the store commit and the checkpoint promotion can never be
 * mistaken for "this run imported these records": the resumed run's own coverage counters describe
 * only what it did.
 */
export async function createMemoryImporter(options: MemoryImporterOptions): Promise<MemoryImporter> {
  if (!isRecord(options)) {
    throw new TypeError('createMemoryImporter requires { directory, source, format, scope, store, consolidator }');
  }
  const directory = typeof options.directory === 'string' ? options.directory.trim() : '';
  if (directory.length === 0) throw new TypeError('createMemoryImporter requires a durable directory');
  const format = options.format;
  if (format !== 'jsonl' && format !== 'text') {
    throw new TypeError("createMemoryImporter requires a format of 'jsonl' or 'text'");
  }
  const source = options.source;
  if (
    !isRecord(source)
    || typeof source.identity !== 'function'
    || typeof source.size !== 'function'
    || typeof source.read !== 'function'
  ) {
    throw new TypeError('createMemoryImporter requires the H03 GenericLogSource');
  }
  const scope = options.scope;
  if (!isRecord(scope) || typeof scope.profileId !== 'string' || scope.profileId.length === 0) {
    throw new TypeError('createMemoryImporter requires a scope with a profileId');
  }
  if (scope.sensitivity !== 'normal' && scope.sensitivity !== 'private' && scope.sensitivity !== 'secret') {
    throw new TypeError('createMemoryImporter requires a scope sensitivity of normal, private or secret');
  }
  const store = options.store;
  if (!isRecord(store) || typeof store.ingest !== 'function') {
    throw new TypeError('createMemoryImporter requires the M01 MemoryStore');
  }
  const consolidator = options.consolidator;
  if (!isRecord(consolidator) || typeof consolidator.consolidate !== 'function') {
    throw new TypeError('createMemoryImporter requires the M02 MemoryConsolidator');
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const checkpointStore = new ImportCheckpointStore(directory);
  let checkpoint: ImportCheckpoint = await checkpointStore.load()
    ?? { version: 1, sourceId: '', generation: 0, committedOffset: 0, pendingOffset: null };
  let closed = false;

  const coverageOf = (totalBytes: number, importedEvents: number, duplicates: number): ImportCoverage => ({
    processedBytes: checkpoint.committedOffset,
    totalBytes,
    complete: checkpoint.committedOffset >= totalBytes,
    importedEvents,
    duplicates,
  });

  const ingestEmissions = async (
    emissions: readonly GenericPreviewEvent[],
    payloads: Readonly<Record<string, unknown>>,
  ): Promise<{ inserted: number; duplicates: number }> => {
    if (emissions.length === 0) return { inserted: 0, duplicates: 0 };
    const batch: NormalizedBatch = { events: emissions.map((emission) => emission.event), payloads };
    const result = await store.ingest(batch);
    return { inserted: result.inserted, duplicates: result.duplicates };
  };

  /**
   * Repair of a span that was handed to the store but never promoted. Re-ingesting it is safe in
   * both crash windows: records the store already committed come back as duplicates, records it
   * never committed are inserted, and only then is the checkpoint promoted past them.
   *
   * The repair re-scans the pending span through the same bounded `BoundedLineScanner` the forward
   * pass used, so an over-long line inside the span is classified exactly as the forward pass
   * classified it (a display-only gap with empty raw bytes) instead of being re-read whole and
   * parsed as an ordinary record: a 10 GiB source with a multi-gigabyte line resumes inside the
   * §5.8 64 KiB working set, and the repaired events are identical to the committed ones.
   */
  const repairPending = async (): Promise<void> => {
    const from = checkpoint.committedOffset;
    const to = checkpoint.pendingOffset;
    if (to === null || to <= from) return;
    const scanner = new BoundedLineScanner(source, from);
    const emissions: GenericPreviewEvent[] = [];
    const payloads: Record<string, unknown> = {};
    let ordinal = 0;
    let ingestSequence = 0;
    while (scanner.offset < to) {
      const scan = await scanner.next();
      if (scan.type === 'eof' || scan.type === 'partial' || scan.end > to) {
        // The pending checkpoint is not a whole number of complete lines: refuse instead of
        // committing a span the forward pass never described.
        throw new Error(`memory import cannot re-read its pending checkpoint span [${from}, ${to})`);
      }
      ordinal += 1;
      const { span, record } = scannedRecord(scan, format, ordinal);
      if (record === undefined) continue;
      ingestSequence += 1;
      const emission = buildEmission(record, {
        sourceId: checkpoint.sourceId,
        generation: checkpoint.generation,
        ingestSequence,
        scope,
        span,
      });
      emissions.push(emission);
      payloads[emission.event.payloadRef] = record.payload;
    }
    if (scanner.offset !== to) {
      throw new Error(`memory import cannot re-read its pending checkpoint span [${from}, ${to})`);
    }
    await ingestEmissions(emissions, payloads);
    checkpoint = { ...checkpoint, committedOffset: to, pendingOffset: null };
    await checkpointStore.save(checkpoint);
  };

  const assertOpen = (): void => {
    if (closed) throw new Error('the memory importer is closed');
  };

  /**
   * Re-measures the source and binds the checkpoint to its current generation. A rotated or
   * shortened source is a new generation starting at byte zero (the old offsets describe bytes that
   * no longer exist); an intact pending span is repaired before anything else can observe it.
   */
  const bindCurrentSource = async (): Promise<number> => {
    const identity = await source.identity();
    const totalBytes = await source.size();
    const pendingUnreachable = checkpoint.pendingOffset !== null && totalBytes < checkpoint.pendingOffset;
    if (
      checkpoint.sourceId.length > 0
      && (identity !== checkpoint.sourceId || totalBytes < checkpoint.committedOffset || pendingUnreachable)
    ) {
      checkpoint = {
        version: 1,
        sourceId: identity,
        generation: checkpoint.generation + 1,
        committedOffset: 0,
        pendingOffset: null,
      };
      await checkpointStore.save(checkpoint);
      return totalBytes;
    }
    if (checkpoint.sourceId.length === 0) {
      checkpoint = { version: 1, sourceId: identity, generation: 1, committedOffset: 0, pendingOffset: null };
      return totalBytes;
    }
    await repairPending();
    return totalBytes;
  };

  await bindCurrentSource();

  return {
    async bootstrap(runOptions?: { signal?: AbortSignal }): Promise<ImportRunResult> {
      assertOpen();
      const signal = runOptions?.signal;
      await bindCurrentSource();

      let inserted = 0;
      let duplicates = 0;
      let ingestSequence = 0;
      let ordinal = 0;
      const emissions: GenericPreviewEvent[] = [];
      const payloads: Record<string, unknown> = {};
      const scanner = new BoundedLineScanner(source, checkpoint.committedOffset);

      const flush = async (): Promise<void> => {
        const pendingOffset = scanner.offset;
        if (pendingOffset <= checkpoint.committedOffset) return;
        // Step 1: the pending span is durable before the store sees it.
        checkpoint = { ...checkpoint, pendingOffset };
        await checkpointStore.save(checkpoint);
        // Step 2: one store transaction per batch, exactly like a live batch.
        if (emissions.length > 0) {
          const result = await ingestEmissions(emissions, payloads);
          inserted += result.inserted;
          duplicates += result.duplicates;
          emissions.length = 0;
          for (const key of Object.keys(payloads)) delete payloads[key];
        }
        // Step 3: promote the commit point past the durably stored records.
        checkpoint = { ...checkpoint, committedOffset: pendingOffset, pendingOffset: null };
        await checkpointStore.save(checkpoint);
      };

      for (;;) {
        if (signal?.aborted === true) break;
        const scan = await scanner.next();
        if (scan.type === 'eof' || scan.type === 'partial') break;
        ordinal += 1;
        const { span, record } = scannedRecord(scan, format, ordinal);
        if (record !== undefined) {
          ingestSequence += 1;
          const emission = buildEmission(record, {
            sourceId: checkpoint.sourceId,
            generation: checkpoint.generation,
            ingestSequence,
            scope,
            span,
          });
          emissions.push(emission);
          payloads[emission.event.payloadRef] = record.payload;
        }
        if (scanner.offset - checkpoint.committedOffset >= IMPORT_BATCH_BYTES) await flush();
      }
      await flush();
      if (signal?.aborted === true) throw abortError();

      // The same M02 consolidator live events use: imported evidence becomes memory through one
      // path, so the decisions, tasks and answers match live ingestion instead of a second pipeline.
      await consolidator.consolidate();

      const totalBytes = await source.size();
      return {
        sourceId: checkpoint.sourceId,
        generation: checkpoint.generation,
        committedOffset: checkpoint.committedOffset,
        coverage: coverageOf(totalBytes, inserted, duplicates),
      };
    },

    async preview(previewOptions?: { limit?: number }): Promise<ImportPreview> {
      assertOpen();
      const limit = normalizePreviewLimit(previewOptions?.limit ?? DEFAULT_PREVIEW_LIMIT);
      const identity = await source.identity();
      const totalBytes = await source.size();
      const rotated = identity !== checkpoint.sourceId;
      const lines = await readTailLines(source, totalBytes, limit);
      const events: GenericPreviewEvent[] = [];
      let ordinal = 0;
      let ingestSequence = 0;
      for (const span of lines) {
        ordinal += 1;
        const record = parseLine(span, format, ordinal);
        if (record === undefined) continue;
        ingestSequence += 1;
        events.push(buildEmission(record, {
          sourceId: rotated ? identity : checkpoint.sourceId,
          generation: rotated ? checkpoint.generation + 1 : checkpoint.generation,
          ingestSequence,
          scope,
          span,
        }));
      }
      return { events, coverage: coverageOf(totalBytes, 0, 0) };
    },

    async status(): Promise<ImportStatus> {
      assertOpen();
      const totalBytes = await source.size();
      return {
        sourceId: checkpoint.sourceId,
        generation: checkpoint.generation,
        committedOffset: checkpoint.committedOffset,
        totalBytes,
        coverage: coverageOf(totalBytes, 0, 0),
      };
    },

    async capabilities(): Promise<GenericCapabilityDescriptor> {
      return {
        observe: true,
        send: false,
        interrupt: false,
        resume: true,
        approvalResponse: false,
        toolResults: false,
        artifactDiffs: false,
        format,
        formatVersion: GENERIC_FORMAT_VERSION,
      };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
