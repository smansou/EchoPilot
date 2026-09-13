/**
 * M03 acceptance test — unseen historical log → resumable bootstrap → same useful memory as live
 * ingestion (IMPLEMENTATION_PLAN.md §5.8 "Cold-start/import path", §5.12 generic adapter; ticket M03).
 *
 * No implementation exists yet in packages/memory/src/import/, so this red baseline reports the
 * missing behavior as a named assertion instead of failing as a bare module-resolution crash,
 * exactly like the M01/M02/Q01/S01 red baselines.
 *
 * Frozen contract
 * ---------------
 * packages/memory/src/import/index.ts
 *   createMemoryImporter(options) → Promise<MemoryImporter>
 *     options = {
 *       directory,    — durable import state (byte-offset checkpoint plus coverage), created if
 *                       missing; survives a kill
 *       source,       — the H03 read-only GenericLogSource (identity/size/read); never written to
 *       format,       — 'jsonl' | 'text' (the declared source format)
 *       scope,        — profileId/projectId/sessionId/sensitivity every imported envelope carries
 *       store,        — the M01 MemoryStore: the same ingestion path live events use
 *       consolidator, — the M02 MemoryConsolidator the imported log is consolidated through
 *     }
 *
 *   MemoryImporter:
 *     bootstrap({ signal? }) → Promise<{ sourceId, generation, committedOffset, coverage }>
 *       Streams the source from the committed byte offset in ≤64 KiB reads (§5.8), parses each
 *       JSONL record, and ingests it through `store.ingest` with the record's own fields as the
 *       payload — a `decision` record keeps question/choice, a `tool_completed` record keeps its
 *       receipt fields, and the H03 envelope rules supply sourceEventId (record id), sourceSequence
 *       (record seq) and occurredAt — then consolidates through the shared M02 consolidator and
 *       resolves with the exact final coverage. The checkpoint commits atomically with the events
 *       it covers, so a killed run resumes at the byte offset after the last committed record:
 *       no observation is duplicated and none is skipped. Every call re-measures the source, so
 *       records appended after a completed import are picked up on the next call, with a repeated
 *       (sourceId, sourceEventId) counted in `coverage.duplicates` instead of being stored twice.
 *       An aborted run may reject; the durable checkpoint is what the next call reads.
 *       `coverage.importedEvents` and `coverage.duplicates` count what this call did; the byte
 *       counters always describe the durable state.
 *
 *     preview({ limit? }) → Promise<{ events, coverage }>
 *       Tail-first and exact: the newest `limit` records of the current generation, parsed but not
 *       committed, in chronological order, each in the H03 GenericPreviewEvent shape, together
 *       with the exact byte coverage committed so far. `coverage.complete` is false until bootstrap
 *       has processed every byte of the source.
 *
 *     status() → Promise<{ sourceId, generation, committedOffset, totalBytes, coverage }>
 *       The durable checkpoint plus exact processed coverage: `coverage.processedBytes` equals
 *       `committedOffset` and `coverage.complete` is true only when every byte is processed.
 *
 *     capabilities() → Promise<GenericCapabilityDescriptor>
 *       The H03 descriptor for the source: observe true; send, interrupt, approvalResponse,
 *       toolResults and artifactDiffs false. Imported content is untrusted evidence: an
 *       authorization-shaped record keeps the generic adapter's display-only 'unsupported'
 *       representation and can never become a task, decision, tool receipt, instruction, or grant.
 *       The importer exposes no send/grant surface at all.
 *
 * The fixtures are synthetic: fixtures/memory/import/cold-export.jsonl is one September export that
 * interleaves two sessions (so the later decision reversal is written before the decision it
 * reverses) and carries an approval-shaped line, tool receipts, and a failed-lint receipt followed
 * by an agent message that claims success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createContextAssembler, type ImageDescriptor, type ModelDescriptor } from '../context/index.js';
import { createMemoryConsolidator, type MemoryConsolidator } from '../consolidation/index.js';
import { summarizeEvent, type NormalizedEvent } from '../reducers/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch, type TimelineItem } from '../store/index.js';
import {
  createFileLogSource,
  type GenericCapabilityDescriptor,
  type GenericLogSource,
  type GenericPreviewEvent,
} from '../../../harness-generic/src/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/memory/import/cold-export.jsonl', import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const PROFILE_ID = 'profile-import';
const PROJECT_ID = 'project-atlas-cold';
const SESSION_ID = 'session-cold-1';
/** Synthetic key material; the synthetic fixtures are the only thing the store ever sees. */
const STORE_KEY = '6b1f0c9a4e7d2583b6a1c0f4d9e8b7023a5c1d6e8f0a2b4c6d8e0f2a4b6c8d0e';
const MODEL: ModelDescriptor = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };
/** §5.8: imported logs stream through a 64 KiB read buffer, never a whole-file string. */
const READ_CHUNK_BYTES = 64 * 1024;
const QUESTION = 'Where does Atlas keep durable project memory?';
const SUPERSEDED_CHOICE = 'Keep durable project memory in the hosted Postgres cluster.';
const REVERSAL_CHOICE = 'Move durable project memory to the local encrypted store.';
const TASK_IDS = ['task-atlas-0104', 'task-atlas-0105'];

type ImportCoverage = {
  processedBytes: number;
  totalBytes: number;
  complete: boolean;
  importedEvents: number;
  duplicates: number;
};

type ImportRunResult = {
  sourceId: string;
  generation: number;
  committedOffset: number;
  coverage: ImportCoverage;
};

type ImportStatus = ImportRunResult & { totalBytes: number };

type ImportPreview = {
  events: GenericPreviewEvent[];
  coverage: ImportCoverage;
};

type MemoryImporter = {
  bootstrap(options?: { signal?: AbortSignal }): Promise<ImportRunResult>;
  preview(options?: { limit?: number }): Promise<ImportPreview>;
  status(): Promise<ImportStatus>;
  capabilities(): Promise<GenericCapabilityDescriptor>;
  close(): Promise<void>;
};

type MemoryImporterOptions = {
  directory: string;
  source: GenericLogSource;
  format: 'jsonl' | 'text';
  scope: {
    profileId: string;
    projectId?: string;
    sessionId?: string;
    sensitivity: 'normal' | 'private' | 'secret';
  };
  store: MemoryStore;
  consolidator: MemoryConsolidator;
};

type ImportModule = {
  createMemoryImporter(options: MemoryImporterOptions): Promise<MemoryImporter>;
};

type MemoryStack = {
  store: MemoryStore;
  consolidator: MemoryConsolidator;
  close(): Promise<void>;
};

type LogRecord = {
  id: string;
  seq: number;
  kind: string;
  occurredAt: string;
  text?: string;
  question?: string;
  choice?: string;
  tool?: string;
  command?: string;
  taskId?: string;
  title?: string;
  exitCode?: number;
  receiptId?: string;
  requestId?: string;
};

const tokenizer = {
  count(text: string): number {
    return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
  },
};

const assembler = createContextAssembler({
  tokenizer,
  imageTokens: (image: ImageDescriptor): number => Math.ceil(image.width / 28) * Math.ceil(image.height / 28),
});

/**
 * Scripted Reasoner stand-in: valid empty extraction (the deterministic reducers still keep every
 * recorded decision) and no answer model, so `answer()` must return the grounded deterministic
 * template. Live and imported runs then differ only by the pipeline under test.
 */
const scriptedReasoner = {
  async run(task: { readonly taskId: string }): Promise<unknown> {
    if (task.taskId.startsWith('memory.extraction.')) return { decisions: [], facts: [], summary: '' };
    throw new Error('the M03 oracle reads the deterministic grounded answer');
  },
};

/** Loads the yet-to-be-implemented importer, turning "module missing" into a named failure. */
async function loadImportModule(): Promise<ImportModule> {
  // A non-literal specifier keeps the missing implementation a runtime failure with a name instead
  // of a compile-time TS2307 that would only say "module not found".
  const specifier = './index.js';
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/memory/src/import/index.ts must export '
        + 'createMemoryImporter({ directory, source, format, scope, store, consolidator }) with '
        + 'bootstrap(), preview(), status(), capabilities(), and close().',
      );
    }
    throw error;
  }
  assert.equal(
    typeof loaded.createMemoryImporter,
    'function',
    'packages/memory/src/import must export createMemoryImporter({ directory, source, format, scope, store, consolidator })',
  );
  return loaded as unknown as ImportModule;
}

async function createStack(root: string): Promise<MemoryStack> {
  const store = await createMemoryStore({ directory: join(root, 'store'), key: STORE_KEY, profileId: PROFILE_ID });
  const consolidator = await createMemoryConsolidator({
    projectId: PROJECT_ID,
    directory: join(root, 'memory'),
    store,
    reasoner: scriptedReasoner,
    assembler,
    model: MODEL,
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

async function createImporter(
  module: ImportModule,
  stack: MemoryStack,
  directory: string,
  source: GenericLogSource,
): Promise<MemoryImporter> {
  return module.createMemoryImporter({
    directory,
    source,
    format: 'jsonl',
    scope: { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, sensitivity: 'normal' },
    store: stack.store,
    consolidator: stack.consolidator,
  });
}

function parseRecords(raw: string): LogRecord[] {
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogRecord);
}

function recordById(records: readonly LogRecord[], id: string): LogRecord {
  const record = records.find((candidate) => candidate.id === id);
  assert.ok(record !== undefined, `the fixture must contain record ${id}`);
  return record;
}

const LIVE_TRUST: Record<string, string> = {
  user_utterance: 'user_explicit',
  decision: 'user_explicit',
  agent_message: 'agent_reported',
  tool_started: 'tool_observed',
  tool_completed: 'tool_observed',
  approval_requested: 'imported',
};

/** Authorization-shaped kinds stay display-only data; the H03 adapter maps them to `unsupported`. */
const AUTHORIZATION_SHAPED = /^(approval|authorization|permission)/i;

/** The live reference event for one record: the payload carries the record's own fields. */
function liveEventFor(record: LogRecord, index: number): { event: NormalizedEvent; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = { ...record };
  const event: NormalizedEvent = {
    schemaVersion: 1,
    eventId: `evt-${record.id}`,
    sourceId: 'source-live-atlas',
    sourceEventId: record.id,
    sourceSequence: record.seq,
    ingestSequence: index + 1,
    occurredAt: record.occurredAt,
    observedAt: record.occurredAt,
    scope: { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: SESSION_ID, sensitivity: 'normal' },
    kind: record.kind,
    payloadRef: `fixture://memory-import/${record.id}`,
    contentHash: `sha256:${record.id}`,
    trust: LIVE_TRUST[record.kind] ?? 'imported',
  };
  return { event, payload };
}

function liveBatch(records: readonly LogRecord[]): NormalizedBatch {
  const payloads: Record<string, unknown> = {};
  const events = records.map((record, index): NormalizedEvent => {
    const { event, payload } = liveEventFor(record, index);
    payloads[event.payloadRef] = payload;
    return event;
  });
  return { events, payloads };
}

function decisionProjection(decisions: readonly { question: string; choice: string; status: string }[]): string[] {
  return decisions.map((decision) => `${decision.question}|${decision.choice}|${decision.status}`);
}

function taskProjection(timeline: readonly TimelineItem[]): string[] {
  return timeline
    .filter((item) => item.kind === 'task')
    .map((item) => `${item.id}|${item.status ?? ''}|${item.summary}`)
    .sort();
}

function capsules(timeline: readonly TimelineItem[]): TimelineItem[] {
  return timeline.filter((item) => item.kind !== 'task');
}

/**
 * The M01 capsule reduction is the frozen upstream contract: importing a record must land exactly
 * the summary the same normalized event produces on the live path, once, with nothing collapsed.
 */
function expectedSummaries(records: readonly LogRecord[]): Map<string, string> {
  const expected = new Map<string, string>();
  records.forEach((record, index) => {
    if (AUTHORIZATION_SHAPED.test(record.kind)) return;
    const { event, payload } = liveEventFor(record, index);
    expected.set(record.id, summarizeEvent(event, payload));
  });
  return expected;
}

function assertExactCapsuleCoverage(timeline: readonly TimelineItem[], records: readonly LogRecord[], label: string): void {
  const stored = capsules(timeline);
  assert.equal(stored.length, records.length, `${label}: one source capsule per imported record, no losses and no duplicates`);
  const summaries = stored.map((item) => item.summary);
  assert.equal(new Set(summaries).size, summaries.length, `${label}: no two records may collapse into one capsule`);
  for (const [id, summary] of expectedSummaries(records)) {
    assert.equal(
      summaries.filter((candidate) => candidate === summary).length,
      1,
      `${label}: record ${id} must be stored exactly once`,
    );
  }
  for (const record of records) {
    if (!AUTHORIZATION_SHAPED.test(record.kind)) continue;
    const marker = record.text ?? record.id;
    assert.equal(
      summaries.filter((summary) => summary.includes(marker)).length,
      1,
      `${label}: display-only record ${record.id} must be stored exactly once`,
    );
  }
}

async function materializeFixture(root: string): Promise<string> {
  const path = join(root, 'cold-export.jsonl');
  await writeFile(path, await readFile(FIXTURE_URL, 'utf8'), 'utf8');
  return path;
}

type GeneratedLog = {
  path: string;
  records: LogRecord[];
  /** Byte span of each record's line, `end` being the commit point after it. */
  spans: Array<{ start: number; end: number }>;
};

/** Deterministic multi-chunk log for the killed-import test: wide lines, chronological records. */
async function writeGeneratedLog(root: string, count: number): Promise<GeneratedLog> {
  const startedAt = Date.parse('2026-09-02T00:00:00.000Z');
  assert.ok(Number.isFinite(startedAt));
  const records: LogRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const label = String(index).padStart(6, '0');
    if (index === 100 || index === 400) {
      records.push({
        id: `cold-dec-${label}`,
        seq: index + 1,
        kind: 'decision',
        occurredAt: new Date(startedAt + index * 1000).toISOString(),
        text: `Cold import decision ${label}.`,
        question: `Cold import decision ${label}: what keeps this import resumable?`,
        choice: `Only a committed byte offset, checkpoint ${label}.`,
      });
      continue;
    }
    records.push({
      id: `cold-pad-${label}`,
      seq: index + 1,
      kind: 'user_utterance',
      occurredAt: new Date(startedAt + index * 1000).toISOString(),
      text: `Deterministic cold-import padding record ${label}. ${'padding '.repeat(70)}`,
    });
  }
  const lines = records.map((record) => JSON.stringify(record));
  const raw = `${lines.join('\n')}\n`;
  const path = join(root, 'cold-import.jsonl');
  await writeFile(path, raw, 'utf8');
  let offset = 0;
  const spans = lines.map((line) => {
    const length = Buffer.byteLength(line, 'utf8') + 1;
    const span = { start: offset, end: offset + length };
    offset += length;
    return span;
  });
  assert.equal(offset, Buffer.byteLength(raw, 'utf8'), 'the generated line spans must cover the file exactly');
  assert.equal(offset, (await stat(path)).size, 'the generated file size must match the record spans');
  return { path, records, spans };
}

const HUGE_LINE_BYTES = 512;
const HUGE_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const HUGE_MAX_SERVE_BYTES = 1024 * 1024;
const HUGE_HARD_CAP_BYTES = 8 * 1024 * 1024;

type HugeRead = { phase: number; offset: number; maxBytes: number; served: number };

type HugeSourceStats = {
  reads: HugeRead[];
  maxRequestedBytes: number;
  servedTotal: number;
  phase: number;
  phaseServed: number;
  overrunBytes: number;
  onPhaseServed: ((servedThisPhase: number) => void) | undefined;
  markPhase(): void;
};

/**
 * A 10 GiB source that is generated lazily: identical fixed-size records, no file, no whole-file
 * buffer. It reports its real 10 GiB size, serves at most 1 MiB per call whatever is requested, and
 * makes the run fail if it streams past the hard cap because an abort was ignored.
 */
function createHugeSource(): { source: GenericLogSource; stats: HugeSourceStats } {
  const stats: HugeSourceStats = {
    reads: [],
    maxRequestedBytes: 0,
    servedTotal: 0,
    phase: 1,
    phaseServed: 0,
    overrunBytes: 0,
    onPhaseServed: undefined,
    markPhase(): void {
      stats.phase += 1;
      stats.phaseServed = 0;
      stats.onPhaseServed = undefined;
    },
  };
  let cachedIndex = -1;
  let cachedLine: Buffer = Buffer.alloc(0);
  const lineFor = (index: number): Buffer => {
    if (index === cachedIndex) return cachedLine;
    const label = String(index).padStart(8, '0');
    const occurredAt = new Date(Date.parse('2026-09-03T00:00:00.000Z') + index * 1000).toISOString();
    const record = JSON.stringify({
      id: `huge-${label}`,
      seq: index + 1,
      kind: 'user_utterance',
      occurredAt,
      text: `Deterministic 10 GB cold-import padding record ${label}.`,
    });
    const padding = HUGE_LINE_BYTES - 1 - Buffer.byteLength(record, 'utf8');
    const line = Buffer.from(`${record}${' '.repeat(padding)}\n`, 'utf8');
    assert.equal(line.byteLength, HUGE_LINE_BYTES, 'the generated 10 GB records must keep a fixed line size');
    cachedIndex = index;
    cachedLine = line;
    return line;
  };
  const source: GenericLogSource = {
    async identity(): Promise<string> {
      return 'file:cold-huge.bench:0:0';
    },
    async size(): Promise<number> {
      return HUGE_TOTAL_BYTES;
    },
    async read(offset: number, maxBytes: number): Promise<Uint8Array> {
      // After the hard cap the source only reports EOF, so a swallowed overrun error cannot hang.
      if (stats.overrunBytes !== 0) return new Uint8Array(0);
      const start = Math.max(0, Math.trunc(offset));
      if (start >= HUGE_TOTAL_BYTES) return new Uint8Array(0);
      const wanted = Math.max(0, Math.min(Math.trunc(maxBytes), HUGE_MAX_SERVE_BYTES));
      const end = Math.min(HUGE_TOTAL_BYTES, start + wanted);
      const size = end - start;
      if (size <= 0) return new Uint8Array(0);
      const chunk = Buffer.allocUnsafe(size);
      let written = 0;
      let cursor = start;
      while (written < size) {
        const line = lineFor(Math.floor(cursor / HUGE_LINE_BYTES));
        const lineOffset = cursor % HUGE_LINE_BYTES;
        const take = Math.min(line.byteLength - lineOffset, size - written);
        line.copy(chunk, written, lineOffset, lineOffset + take);
        written += take;
        cursor += take;
      }
      stats.reads.push({ phase: stats.phase, offset: start, maxBytes, served: size });
      stats.maxRequestedBytes = Math.max(stats.maxRequestedBytes, maxBytes);
      stats.servedTotal += size;
      stats.phaseServed += size;
      stats.onPhaseServed?.(stats.phaseServed);
      if (stats.servedTotal > HUGE_HARD_CAP_BYTES) {
        stats.overrunBytes = stats.servedTotal;
        throw new Error('the importer kept streaming after the abort; the 10 GB source refused to serve more');
      }
      return chunk;
    },
  };
  return { source, stats };
}

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/**
 * The killed-import harness: a real child process that imports the log, announces through its own
 * source wrapper once it has both read past the threshold and committed a checkpoint, and is then
 * SIGKILLed — no close(), no flush, a rollback journal left on disk.
 */
function childHarnessScript(): string {
  const storeUrl = new URL('../store/index.ts', import.meta.url).href;
  const consolidationUrl = new URL('../consolidation/index.ts', import.meta.url).href;
  const contextUrl = new URL('../context/index.ts', import.meta.url).href;
  const genericUrl = new URL('../../../harness-generic/src/index.ts', import.meta.url).href;
  const importUrl = new URL('./index.ts', import.meta.url).href;
  return [
    `const { createMemoryStore } = await import(${JSON.stringify(storeUrl)});`,
    `const { createMemoryConsolidator } = await import(${JSON.stringify(consolidationUrl)});`,
    `const { createContextAssembler } = await import(${JSON.stringify(contextUrl)});`,
    `const { createFileLogSource } = await import(${JSON.stringify(genericUrl)});`,
    `const { createMemoryImporter } = await import(${JSON.stringify(importUrl)});`,
    'const root = process.env.M03_ROOT;',
    'const base = createFileLogSource(process.env.M03_SOURCE);',
    'const threshold = Number(process.env.M03_KILL_AFTER_BYTES);',
    'let served = 0;',
    'let announced = false;',
    'let importer;',
    'const source = {',
    '  identity: () => base.identity(),',
    '  size: () => base.size(),',
    '  read: async (offset, maxBytes) => {',
    '    const chunk = await base.read(offset, maxBytes);',
    '    served += chunk.byteLength;',
    '    if (!announced && served >= threshold) {',
    '      let status;',
    '      try { status = await importer.status(); } catch { status = undefined; }',
    '      if (status !== undefined && status.committedOffset > 0) {',
    '        announced = true;',
    "        process.stdout.write('M03_CHILD_CHECKPOINTED\\n');",
    '      }',
    '    }',
    '    return chunk;',
    '  },',
    '};',
    'const store = await createMemoryStore({ directory: root + "/store", key: process.env.M03_KEY, profileId: process.env.M03_PROFILE });',
    'const assembler = createContextAssembler({',
    '  tokenizer: { count: (text) => text.trim().split(/\\s+/).filter((token) => token.length > 0).length },',
    '  imageTokens: (image) => Math.ceil(image.width / 28) * Math.ceil(image.height / 28),',
    '});',
    "const reasoner = { async run() { throw new Error('the M03 oracle reads the deterministic grounded answer'); } };",
    'const consolidator = await createMemoryConsolidator({',
    '  projectId: process.env.M03_PROJECT,',
    '  directory: root + "/memory",',
    '  store,',
    '  reasoner,',
    '  assembler,',
    "  model: { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 },",
    '});',
    'importer = await createMemoryImporter({',
    '  directory: root + "/import-state",',
    '  source,',
    "  format: 'jsonl',",
    '  scope: {',
    '    profileId: process.env.M03_PROFILE,',
    '    projectId: process.env.M03_PROJECT,',
    '    sessionId: process.env.M03_SESSION,',
    "    sensitivity: 'normal',",
    '  },',
    '  store,',
    '  consolidator,',
    '});',
    'await importer.bootstrap({});',
    "process.stdout.write('M03_CHILD_FINISHED\\n');",
  ].join('\n');
}

function runChildHarness(script: string, env: Record<string, string>): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`the killed-import child never reached a committed checkpoint within 60s: ${stderr.slice(0, 600)}`));
    }, 60_000);
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (!settled && stdout.includes('M03_CHILD_CHECKPOINTED')) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('an unseen historical log yields the same current decisions, tasks, and supported answers as live ingestion', async () => {
  const module = await loadImportModule();
  const records = parseRecords(await readFile(FIXTURE_URL, 'utf8'));
  assert.ok(records.length >= 12, 'the fixture must carry a meaningful multi-record export');
  assert.equal(new Set(records.map((record) => record.id)).size, records.length, 'fixture record ids must be unique');
  const reversal = recordById(records, 'cold-0002');
  const original = recordById(records, 'cold-0003');
  assert.ok(
    records.indexOf(reversal) < records.indexOf(original) && Date.parse(reversal.occurredAt) > Date.parse(original.occurredAt),
    'the export writes the later reversal before the earlier decision: import order differs from occurrence time',
  );

  const liveRoot = await mkdtemp(join(tmpdir(), 'm03-live-'));
  const importRoot = await mkdtemp(join(tmpdir(), 'm03-import-'));
  const live = await createStack(liveRoot);
  const imported = await createStack(importRoot);
  let importer: MemoryImporter | undefined;
  try {
    const ingested = await live.store.ingest(liveBatch(records));
    assert.equal(ingested.inserted, records.length, 'the live reference ingests every fixture event once');
    await live.consolidator.consolidate();
    const liveTimeline = await live.store.timeline({ projectId: PROJECT_ID });
    const liveDecisions = await live.consolidator.decisions();
    const liveAnswer = await live.consolidator.answer({ question: QUESTION });

    const logPath = await materializeFixture(importRoot);
    importer = await createImporter(module, imported, join(importRoot, 'import-state'), createFileLogSource(logPath));
    const run = await importer.bootstrap();
    assert.equal(run.coverage.complete, true, 'a bootstrap that reached the end of the source reports complete coverage');
    assert.equal(run.coverage.processedBytes, (await stat(logPath)).size, 'coverage must be exact: every source byte processed');
    assert.equal(run.coverage.importedEvents, records.length, 'every record is imported exactly once');
    assert.equal(run.coverage.duplicates, 0, 'a first import contains no duplicates');
    const importedTimeline = await imported.store.timeline({ projectId: PROJECT_ID });
    const importedDecisions = await imported.consolidator.decisions();
    const importedAnswer = await imported.consolidator.answer({ question: QUESTION });

    assert.deepEqual(
      decisionProjection(importedDecisions),
      decisionProjection(liveDecisions),
      'imported and live event sequences must yield equivalent current decisions',
    );
    assert.deepEqual(
      taskProjection(importedTimeline),
      taskProjection(liveTimeline),
      'imported and live event sequences must yield equivalent current tasks',
    );
    const order = decisionProjection(importedDecisions);
    assert.equal(order.length, 2, 'both decision records are consolidated');
    assert.ok(order[0]?.includes(SUPERSEDED_CHOICE) === true, 'the earlier decision stays first chronologically');
    assert.ok(order[1]?.includes(REVERSAL_CHOICE) === true, 'the later reversal stays after it despite the reversed import order');
    assert.equal(
      taskProjection(importedTimeline).find((task) => task.startsWith('task-atlas-0105'))?.includes('failed'),
      true,
      'the observed failed receipt stays failed even though the imported agent message claims success',
    );
    assert.equal(importedAnswer.supported, true, 'the imported log supports the dated historical question');
    assert.ok(importedAnswer.text.includes(REVERSAL_CHOICE), 'the supported answer carries the imported reversal');
    assert.equal(liveAnswer.supported, true, 'the live reference supports the same historical question');
    assertExactCapsuleCoverage(importedTimeline, records, 'imported store');
  } finally {
    await importer?.close().catch(() => undefined);
    await live.close();
    await imported.close();
    await rm(liveRoot, { recursive: true, force: true });
    await rm(importRoot, { recursive: true, force: true });
  }
});

test('a SIGKILLed cold import resumes at its committed byte offset without duplicating observations', { timeout: 120_000 }, async () => {
  const module = await loadImportModule();
  const root = await mkdtemp(join(tmpdir(), 'm03-kill-'));
  try {
    const generated = await writeGeneratedLog(root, 640);
    const exit = await runChildHarness(childHarnessScript(), {
      M03_ROOT: root,
      M03_SOURCE: generated.path,
      M03_KEY: STORE_KEY,
      M03_PROFILE: PROFILE_ID,
      M03_PROJECT: PROJECT_ID,
      M03_SESSION: SESSION_ID,
      M03_KILL_AFTER_BYTES: String(READ_CHUNK_BYTES),
    });
    assert.equal(
      exit.signal,
      'SIGKILL',
      'the import must be killed by SIGKILL after committing a checkpoint, never finished first: '
      + `${exit.stdout}${exit.stderr}`,
    );

    const stack = await createStack(root);
    let importer: MemoryImporter | undefined;
    try {
      importer = await createImporter(module, stack, join(root, 'import-state'), createFileLogSource(generated.path));
      const killed = await importer.status();
      assert.equal(killed.totalBytes, (await stat(generated.path)).size, 'status reports the exact source size');
      assert.ok(killed.committedOffset > 0, 'the killed run must leave a committed byte-offset checkpoint');
      assert.ok(killed.committedOffset < killed.totalBytes, 'the kill must land before the end of the source');
      assert.equal(killed.coverage.complete, false, 'a killed import reports incomplete coverage');
      assert.equal(killed.coverage.processedBytes, killed.committedOffset, 'processed coverage is the committed byte offset');
      const expectedCommitted = generated.spans.filter((span) => span.end <= killed.committedOffset).length;
      const partialTimeline = await stack.store.timeline({ projectId: PROJECT_ID });
      assert.equal(
        capsules(partialTimeline).length,
        expectedCommitted,
        'the killed run stores exactly the records its checkpoint covers (no torn or uncommitted record)',
      );

      const resumed = await importer.bootstrap();
      assert.equal(resumed.coverage.complete, true, 'the resumed run reaches the end of the source');
      assert.equal(resumed.coverage.processedBytes, (await stat(generated.path)).size, 'resumed coverage is exact');
      assert.equal(resumed.coverage.duplicates, 0, 'resuming from the committed offset never re-ingests a committed observation');
      assert.equal(resumed.coverage.importedEvents, generated.records.length - expectedCommitted, 'only the remaining records are imported');
      const timeline = await stack.store.timeline({ projectId: PROJECT_ID });
      assertExactCapsuleCoverage(timeline, generated.records, 'resumed store');
      assert.equal((await stack.consolidator.decisions()).length, 2, 'both decisions survive the kill and the resume');

      // Live tailing after the import deduplicates against the imported source ids.
      const last = generated.records[generated.records.length - 1];
      assert.ok(last !== undefined, 'the generated log keeps its last record');
      const tail = [
        JSON.stringify(last),
        JSON.stringify({
          id: 'cold-pad-tail',
          seq: generated.records.length + 1,
          kind: 'user_utterance',
          occurredAt: new Date(Date.parse(last.occurredAt) + 1000).toISOString(),
          text: 'Tail record appended after the first import completed.',
        }),
      ];
      await appendFile(generated.path, `${tail.join('\n')}\n`, 'utf8');
      const tailRun = await importer.bootstrap();
      assert.equal(tailRun.coverage.complete, true, 'a tail run reaches the new end of the source');
      assert.equal(tailRun.coverage.duplicates, 1, 'the re-delivered record is counted as a duplicate, not stored again');
      assert.equal(tailRun.coverage.importedEvents, 1, 'only the new tail record is imported');
      assert.equal(
        capsules(await stack.store.timeline({ projectId: PROJECT_ID })).length,
        generated.records.length + 1,
        'tail ingestion adds exactly one observation',
      );
    } finally {
      await importer?.close().catch(() => undefined);
      await stack.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a nominal 10 GB source streams through bounded reads and resumes at the committed byte offset', async () => {
  const module = await loadImportModule();
  const root = await mkdtemp(join(tmpdir(), 'm03-huge-'));
  const stack = await createStack(root);
  try {
    const huge = createHugeSource();
    const firstAbort = new AbortController();
    huge.stats.onPhaseServed = (servedThisPhase) => {
      if (servedThisPhase >= 256 * 1024) firstAbort.abort();
    };
    const first = await createImporter(module, stack, join(root, 'import-state'), huge.source);
    await first.bootstrap({ signal: firstAbort.signal }).catch(() => undefined);
    assert.equal(huge.stats.overrunBytes, 0, 'the importer must honour the abort instead of streaming on');
    assert.ok(huge.stats.reads.length > 1, 'a 10 GB source is read in many bounded chunks, never as one buffer');
    assert.ok(
      huge.stats.maxRequestedBytes <= READ_CHUNK_BYTES,
      `one read request must stay inside the §5.8 64 KiB buffer (asked for ${huge.stats.maxRequestedBytes} bytes)`,
    );
    const phase1Reads = huge.stats.reads.length;
    const killed = await first.status();
    assert.equal(killed.totalBytes, HUGE_TOTAL_BYTES, 'status reports the real 10 GB source size');
    assert.equal(killed.coverage.complete, false, 'a killed run reports incomplete coverage');
    assert.ok(killed.committedOffset > 0, 'the killed run must have committed a byte-offset checkpoint');
    assert.ok(killed.committedOffset < HUGE_TOTAL_BYTES, 'the checkpoint must stay inside the 10 GB source');
    assert.equal(killed.coverage.processedBytes, killed.committedOffset, 'processed coverage is the committed byte offset');

    // The killed process is gone: the state directory is all the resumed importer may read.
    huge.stats.markPhase();
    const secondAbort = new AbortController();
    huge.stats.onPhaseServed = (servedThisPhase) => {
      if (servedThisPhase >= READ_CHUNK_BYTES) secondAbort.abort();
    };
    const resumed = await createImporter(module, stack, join(root, 'import-state'), huge.source);
    await resumed.bootstrap({ signal: secondAbort.signal }).catch(() => undefined);
    assert.equal(huge.stats.overrunBytes, 0, 'the resumed run must also honour its abort');
    const resumedStatus = await resumed.status();
    assert.ok(resumedStatus.committedOffset > killed.committedOffset, 'the resumed run commits more records');
    assert.equal(resumedStatus.coverage.processedBytes, resumedStatus.committedOffset, 'resumed coverage stays exact');
    assert.equal(resumedStatus.coverage.complete, false, 'the second kill is also before the end of the source');
    const phase2 = huge.stats.reads.slice(phase1Reads);
    assert.ok(phase2.length > 0, 'the resumed run must read the source');
    const sniffedBelowCheckpoint = phase2
      .filter((read) => read.offset < killed.committedOffset)
      .reduce((total, read) => total + read.served, 0);
    assert.ok(
      sniffedBelowCheckpoint <= READ_CHUNK_BYTES,
      'a resumed run must not stream the 10 GB source again from byte zero',
    );
    const forward = phase2.filter((read) => read.offset >= killed.committedOffset);
    assert.equal(forward[0]?.offset, killed.committedOffset, 'a resumed run starts exactly at the committed byte offset');
    assert.ok(
      huge.stats.maxRequestedBytes <= READ_CHUNK_BYTES,
      `the resumed run keeps the 64 KiB read buffer (asked for ${huge.stats.maxRequestedBytes} bytes)`,
    );
  } finally {
    await stack.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('preview and final coverage are exact and imported instructions cannot call tools or modify grants', async () => {
  const module = await loadImportModule();
  const records = parseRecords(await readFile(FIXTURE_URL, 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'm03-preview-'));
  const stack = await createStack(root);
  let importer: MemoryImporter | undefined;
  try {
    const logPath = await materializeFixture(root);
    const size = (await stat(logPath)).size;
    importer = await createImporter(module, stack, join(root, 'import-state'), createFileLogSource(logPath));
    const capabilities = await importer.capabilities();
    assert.equal(capabilities.observe, true, 'an imported log is observable');
    assert.equal(capabilities.send, false, 'an imported log has no input path');
    assert.equal(capabilities.interrupt, false, 'an imported log cannot interrupt anything');
    assert.equal(capabilities.approvalResponse, false, 'imported content can never answer an approval');
    assert.equal(capabilities.toolResults, false, 'an imported log is not a tool-result channel');
    assert.equal(capabilities.artifactDiffs, false, 'an imported log cannot deliver diffs');
    const surface = importer as unknown as Record<string, unknown>;
    for (const forbidden of ['send', 'grant', 'approve', 'respondApproval']) {
      assert.equal(surface[forbidden], undefined, `the importer must expose no ${forbidden}() surface`);
    }

    const tail = records.slice(-3);
    const before = await importer.preview({ limit: 3 });
    assert.equal(before.events.length, 3, 'the tail-first preview returns the requested newest records');
    assert.deepEqual(
      before.events.map((event) => event.event.sourceEventId),
      tail.map((record) => record.id),
      'preview is tail-first: the newest records of the generation, in chronological order',
    );
    assert.equal(before.coverage.processedBytes, 0, 'nothing is committed before the historical scan runs');
    assert.equal(before.coverage.complete, false, 'a tail-first preview is incomplete until the scan reaches its watermark');
    assert.ok(before.events.every((event) => event.event.trust === 'imported'), 'previewed records are imported evidence');
    assert.ok(before.events.every((event) => event.cursor.offset > 0), 'previewed records carry their commit point');

    const run = await importer.bootstrap();
    assert.equal(run.coverage.complete, true, 'the final bootstrap reports complete coverage');
    assert.equal(run.coverage.processedBytes, size, 'the final result reports exact processed coverage');
    const after = await importer.preview({ limit: 3 });
    assert.deepEqual(
      after.events.map((event) => event.event.sourceEventId),
      tail.map((record) => record.id),
      'the completed preview still shows the newest records of the generation',
    );
    assert.equal(after.coverage.processedBytes, size, 'a completed preview reports the exact processed coverage');
    assert.equal(after.coverage.complete, true, 'a completed preview is labeled complete');
    const status = await importer.status();
    assert.equal(status.totalBytes, size, 'status reports the exact source size');
    assert.equal(status.committedOffset, size, 'the committed cursor reaches the exact end of the source');
    assert.equal(status.coverage.processedBytes, status.committedOffset, 'processed coverage equals the committed offset');

    const timeline = await stack.store.timeline({ projectId: PROJECT_ID });
    assertExactCapsuleCoverage(timeline, records, 'imported store');
    const injection = recordById(records, 'cold-0009');
    assert.ok(injection.text !== undefined, 'the fixture carries the injected instruction text');
    const injected = timeline.filter((item) => item.summary.includes(injection.text ?? injection.id));
    assert.equal(injected.length, 1, 'the injected instruction is preserved as display evidence only');
    assert.equal(injected[0]?.kind, 'unsupported', 'an authorization-shaped record keeps the display-only H03 representation');
    assert.equal(injected[0]?.trust, 'imported', 'imported content stays untrusted evidence');
    assert.equal(timeline.some((item) => /^approval/i.test(item.kind)), false, 'no imported record becomes an approval request');
    assert.deepEqual(
      timeline.filter((item) => item.kind === 'task').map((item) => item.id).sort(),
      [...TASK_IDS].sort(),
      'only observed tool receipts from the log can create tasks',
    );
    const decisions = await stack.consolidator.decisions();
    assert.equal(
      decisions.some((decision) => `${decision.question}${decision.choice}`.includes('rm -rf')),
      false,
      'an instruction embedded in the log never becomes a decision or a grant',
    );
  } finally {
    await importer?.close().catch(() => undefined);
    await stack.close();
    await rm(root, { recursive: true, force: true });
  }
});
