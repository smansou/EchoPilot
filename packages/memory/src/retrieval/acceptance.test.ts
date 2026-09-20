/**
 * M05 acceptance oracle — "Large multi-day project → hybrid retrieval → bounded, correct temporal
 * answer" (ticket M05; IMPLEMENTATION_PLAN.md §4.4 "Retrieval" release gate, §4.5 temporal-memory
 * release gate, §5.8 "Retrieval" and "Retention and deletion").
 *
 * Test-role owned: the implementer never edits this file; it is the frozen oracle the M05
 * implementation must satisfy. packages/memory/src/retrieval/index.ts does not exist yet, so the
 * red baseline reports the missing behavior as a named assertion instead of a module-resolution
 * crash. No model, network, or hardware call is made: the corpus is a deterministic synthetic
 * stand-in for the encrypted store, and embeddings come from a local stand-in provider.
 *
 * Frozen contract
 * ---------------
 * packages/memory/src/retrieval/index.ts
 *
 *   createMemoryRetrieval(options) -> Promise<MemoryRetrieval>
 *     options = {
 *       projectId: string,                  the active project every request defaults to
 *       grantedProjectIds?: string[],       explicit cross-project grants (§5.8); nothing else is
 *                                           ever read or disclosed
 *       directory: string,                  durable retrieval-owned state
 *       source: { page({ projectId, cursor?, limit? }) -> Promise<{ records, cursor? }>,
 *                 coverage?() -> Promise<{ semantic: 'complete'|'partial', failedJobs }> }
 *                                           bounded paging over one project's memory records plus the
 *                                           consolidation coverage that produced them (the M02/M04
 *                                           source seam); a failed summary job is reported, never
 *                                           smoothed over
 *       embeddings?: { modelId, dimensions, embed(texts) -> Promise<Float32Array[]> }
 *                                           optional local embedding provider (MiniLM seam)
 *       tokenizer?: { count(text): number } defaults to whitespace tokens
 *       now?: () => Date                    defaults to the real clock
 *       limits?: Partial<{ lexicalCandidates: 100, embeddingCandidates: 5000, evidenceItems: 12,
 *                          evidenceTokens: 1536 }>
 *     }
 *
 *   RetrievalRecord = { id, projectId, kind: 'fact'|'decision'|'task'|'observation'|'summary',
 *     text, trust: 'user_explicit'|'tool_observed'|'agent_reported'|'imported',
 *     status?: 'active'|'disputed'|'superseded', occurredAt, validFrom?, validTo?,
 *     entities?: string[], sourceEventIds: string[], rawAvailable: boolean,
 *     capsule?: { id, bytes } }
 *
 *   MemoryRetrieval:
 *     index() -> { indexed, generation, coverage }   indexes the active project plus granted
 *         projects through source.page(); `indexed` counts the records it paged.
 *     search(request) -> {
 *       query, asOf, historical, mode: 'lexical'|'enriched', items, tokens, denied, counters,
 *       coverage }
 *       request = { query, projectIds?, asOf?, timeRange?: {start?, end?}, entities?,
 *                   mode?: 'auto'|'lexical'|'enriched', limit? }
 *     answer({ question, ...same options }) -> search result plus { text, supported, evidenceIds }.
 *         `text` is composed only from the selected evidence; with no evidence it says so instead of
 *         inventing an answer (`supported: false`, `evidenceIds: []`).
 *     coverage() -> RetrievalCoverage;  close() -> Promise<void>
 *
 *   EvidenceItem = { id, projectId, kind, text, trust, status?, occurredAt, validFrom?, validTo?,
 *     score, tokens, sources: { eventId, kind, trust, occurredAt, rawAvailability }[],
 *     capsule?: { id, bytes } }
 *
 * Frozen behavior (each assertion below names the clause it enforces):
 *   1. Scope is applied first. A record is readable only from the active project or an explicitly
 *      granted project; a request naming anything else is denied with
 *      { projectId, reason: 'cross_project_denied' } and contributes no item, never a silent
 *      answer and never a disclosure. The default request scope is the active project.
 *   2. Bounded work: at most `limits.lexicalCandidates` (100) lexical candidates, at most
 *      `limits.embeddingCandidates` (5000) vectors scored from SQL-filtered candidates, at most
 *      `limits.evidenceItems` (12) items and at most `limits.evidenceTokens` (1536) tokens per
 *      result. A 'lexical' request scores no embeddings.
 *   3. Hybrid fusion: structured/lexical candidates plus optional embedding expansion are fused
 *      (reciprocal rank fusion), boosted for current validity and explicit user evidence,
 *      deduplicated by record id, and returned with their raw source ids.
 *   4. Time: an item is eligible only when its [validFrom, validTo] interval contains the requested
 *      instant (default now). An explicit past instant or past range is `historical`: it answers
 *      from what was true then, is unaffected by later records, and is the same whether or not
 *      later records exist in the corpus. Current-validity/recency boosts apply to current
 *      questions only.
 *   5. Raw availability: an item whose raw sources are gone keeps its retained decision text and
 *      small capsule, reports rawAvailability 'expired' for those sources, and raises a
 *      'raw_source_expired' coverage gap. Raw text is never invented.
 *   6. A source that reports failed summary jobs makes every result's coverage 'partial', names the
 *      jobs in `failedJobs`, and raises a 'summary_failed' gap: the answer path must never present a
 *      partially consolidated memory as complete. A source that reports no failures stays 'complete'.
 *   7. Repeated identical requests return identical items/tokens (no context growth).
 *
 * The only non-deterministic assertion is the §4.4 wall-clock latency gate (structured/lexical
 * ≤150 ms p95 and enriched ≤400 ms p95 over 100,000 records): it is measured after warmup as a p95
 * over 200 local queries and re-measured once when the first pass misses, precisely because the
 * number is machine-dependent. The bounded-candidate assertions are the deterministic part of the
 * same gate, and the measured p50/p95 is reported as a test diagnostic either way.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

type Trust = 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
type RecordKind = 'fact' | 'decision' | 'task' | 'observation' | 'summary';
type RecordStatus = 'active' | 'disputed' | 'superseded';
type RetrievalMode = 'auto' | 'lexical' | 'enriched';

interface CapsuleRef {
  id: string;
  bytes: number;
}

interface RetrievalRecord {
  id: string;
  projectId: string;
  kind: RecordKind;
  text: string;
  trust: Trust;
  status?: RecordStatus;
  occurredAt: string;
  validFrom?: string;
  validTo?: string;
  entities?: readonly string[];
  sourceEventIds: readonly string[];
  rawAvailable: boolean;
  capsule?: CapsuleRef;
}

interface RetrievalPage {
  records: readonly RetrievalRecord[];
  cursor?: string;
}

interface MemoryRetrievalSource {
  page(request: { projectId: string; cursor?: string; limit?: number }): Promise<RetrievalPage>;
  coverage?(): Promise<{ semantic: 'complete' | 'partial'; failedJobs: readonly string[] }>;
}

interface LocalEmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

interface EvidenceSourceRef {
  eventId: string;
  kind: string;
  trust: string;
  occurredAt: string;
  rawAvailability: 'available' | 'expired';
}

interface EvidenceItem {
  id: string;
  projectId: string;
  kind: RecordKind;
  text: string;
  trust: Trust;
  status?: RecordStatus;
  occurredAt: string;
  validFrom?: string;
  validTo?: string;
  score: number;
  tokens: number;
  sources: readonly EvidenceSourceRef[];
  capsule?: CapsuleRef;
}

interface RetrievalGap {
  kind: string;
  detail: string;
  recordIds?: readonly string[];
  jobIds?: readonly string[];
}

interface RetrievalCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
  gaps: readonly RetrievalGap[];
}

interface RetrievalCounters {
  structuredCandidates: number;
  lexicalCandidates: number;
  embeddingCandidates: number;
  fusedCandidates: number;
  droppedForScope: number;
  deduplicated: number;
}

interface RetrievalResult {
  query: string;
  asOf: string;
  historical: boolean;
  mode: 'lexical' | 'enriched';
  items: readonly EvidenceItem[];
  tokens: number;
  denied: readonly { projectId: string; reason: string }[];
  counters: RetrievalCounters;
  coverage: RetrievalCoverage;
}

interface RetrievalAnswer extends RetrievalResult {
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
}

interface SearchRequest {
  query: string;
  projectIds?: readonly string[];
  asOf?: string;
  timeRange?: { start?: string; end?: string };
  entities?: readonly string[];
  mode?: RetrievalMode;
  limit?: number;
}

interface AnswerRequest {
  question: string;
  projectIds?: readonly string[];
  asOf?: string;
  timeRange?: { start?: string; end?: string };
  entities?: readonly string[];
  mode?: RetrievalMode;
  limit?: number;
}

interface MemoryRetrieval {
  index(options?: { signal?: AbortSignal }): Promise<{ indexed: number; generation: string; coverage: RetrievalCoverage }>;
  search(request: SearchRequest): Promise<RetrievalResult>;
  answer(request: AnswerRequest): Promise<RetrievalAnswer>;
  coverage(): Promise<RetrievalCoverage>;
  close(): Promise<void>;
}

interface RetrievalOptions {
  projectId: string;
  grantedProjectIds?: readonly string[];
  directory: string;
  source: MemoryRetrievalSource;
  embeddings?: LocalEmbeddingProvider;
  tokenizer?: { count(text: string): number };
  now?: () => Date;
  limits?: Partial<{
    lexicalCandidates: number;
    embeddingCandidates: number;
    evidenceItems: number;
    evidenceTokens: number;
  }>;
}

interface RetrievalModule {
  createMemoryRetrieval(options: RetrievalOptions): Promise<MemoryRetrieval>;
}

const ACTIVE_PROJECT = 'project-atlas';
const BOREALIS_PROJECT = 'project-borealis';
const CYGNUS_PROJECT = 'project-cygnus';
const BOREALIS_CANARY = 'BOREALIS-ONLY-CANARY';
/** §4.4: the retrieval gate is measured over 100,000 memory records. */
const ACTIVE_RECORD_COUNT = 100_000;
const LEXICAL_GATE_MS = 150;
const ENRICHED_GATE_MS = 400;
const LATENCY_SAMPLES = 200;
const LATENCY_WARMUP = 20;
const EVIDENCE_ITEM_CAP = 12;
const EVIDENCE_TOKEN_CAP = 1536;

const NOW = new Date('2026-09-21T12:00:00.000Z');
const clock = (): Date => new Date(NOW.getTime());

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

const tokenizer = {
  count(text: string): number {
    return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
  },
};

const VOCABULARY = [
  'scheduler', 'telemetry', 'parser', 'exporter', 'runner', 'buffer', 'arena', 'spool',
  'ledger', 'cursor', 'batches', 'checkpoint', 'retries', 'backlog', 'quota', 'shard',
  'replica', 'gateway', 'digest', 'manifest', 'sandbox', 'fixture', 'journal', 'snapshot',
] as const;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random: () => number): string {
  return VOCABULARY[Math.floor(random() * VOCABULARY.length)] ?? 'scheduler';
}

/** Deterministic local embedding stand-in: hashed tokens plus a hand-written synonym concept. */
const EMBEDDING_DIMENSIONS = 56;
const BALANCED_DIMENSIONS = 48;
const CONCEPT_PHRASES: readonly (readonly string[])[] = [
  ['backoff allowance', 'retry budget'],
];

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function embedText(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  const lower = text.toLowerCase();
  for (const token of lower.match(/[a-z0-9-]+/g) ?? []) {
    vector[fnv1a(token) % BALANCED_DIMENSIONS] = (vector[fnv1a(token) % BALANCED_DIMENSIONS] ?? 0) + 1;
  }
  CONCEPT_PHRASES.forEach((phrases, concept) => {
    if (phrases.some((phrase) => lower.includes(phrase))) {
      const slot = BALANCED_DIMENSIONS + concept;
      vector[slot] = (vector[slot] ?? 0) + 2;
    }
  });
  let norm = 0;
  for (const value of vector) norm += value * value;
  const length = Math.sqrt(norm);
  if (length > 0) for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / length;
  return vector;
}

const embeddings: LocalEmbeddingProvider = {
  modelId: 'echopilot-minilm-standin-v1',
  dimensions: EMBEDDING_DIMENSIONS,
  async embed(texts) {
    return texts.map((text) => embedText(text));
  },
};

function makeRecord(record: RetrievalRecord): RetrievalRecord {
  return record;
}

/** The 100,000-record active project plus smaller neighbour projects and the special records. */
function buildBigCorpus(): RetrievalRecord[] {
  const random = mulberry32(0x5eed);
  const records: RetrievalRecord[] = [];
  for (let index = 0; index < ACTIVE_RECORD_COUNT; index += 1) {
    const occurredAt = daysBefore(index % 45);
    records.push(makeRecord({
      id: `rec-${String(index).padStart(6, '0')}`,
      projectId: ACTIVE_PROJECT,
      kind: index % 11 === 0 ? 'decision' : index % 5 === 0 ? 'task' : 'observation',
      text: `${pick(random)} ${pick(random)} ${pick(random)} ${pick(random)} for component-${index % 500}`,
      trust: index % 11 === 0 ? 'user_explicit' : index % 5 === 0 ? 'tool_observed' : 'agent_reported',
      occurredAt,
      validFrom: occurredAt,
      entities: [`component-${index % 500}`],
      sourceEventIds: [`evt-${index}`],
      rawAvailable: true,
    }));
  }
  records.push(
    makeRecord({
      id: 'rec-a-nightly-old',
      projectId: ACTIVE_PROJECT,
      kind: 'observation',
      text: 'Incident: the nightly smoke suite flakes on the shared runner.',
      trust: 'tool_observed',
      occurredAt: daysBefore(40),
      validFrom: daysBefore(40),
      sourceEventIds: ['evt-nightly-old'],
      rawAvailable: true,
    }),
    makeRecord({
      id: 'rec-z-nightly-new',
      projectId: ACTIVE_PROJECT,
      kind: 'observation',
      text: 'Incident: the nightly smoke suite flakes on the shared runner.',
      trust: 'tool_observed',
      occurredAt: daysBefore(2),
      validFrom: daysBefore(2),
      sourceEventIds: ['evt-nightly-new'],
      rawAvailable: true,
    }),
    makeRecord({
      id: 'rec-quartzite',
      projectId: ACTIVE_PROJECT,
      kind: 'decision',
      text: 'Component quartzite keeps its backoff allowance in the local store.',
      trust: 'user_explicit',
      occurredAt: daysBefore(2),
      validFrom: daysBefore(2),
      entities: ['component-quartzite'],
      sourceEventIds: ['evt-quartzite'],
      rawAvailable: true,
    }),
  );
  records.push(
    makeRecord({
      id: 'rec-borealis-1',
      projectId: BOREALIS_PROJECT,
      kind: 'observation',
      text: `The borealis deployment token lives in the shared staging bucket. ${BOREALIS_CANARY}`,
      trust: 'agent_reported',
      occurredAt: daysBefore(4),
      validFrom: daysBefore(4),
      sourceEventIds: ['evt-borealis-1'],
      rawAvailable: true,
    }),
    makeRecord({
      id: 'rec-cygnus-1',
      projectId: CYGNUS_PROJECT,
      kind: 'observation',
      text: 'The cygnus deployment token lives in the shared staging bucket.',
      trust: 'agent_reported',
      occurredAt: daysBefore(4),
      validFrom: daysBefore(4),
      sourceEventIds: ['evt-cygnus-1'],
      rawAvailable: true,
    }),
  );
  return records;
}

interface Harness {
  retrieval: MemoryRetrieval;
  records: readonly RetrievalRecord[];
  pageCalls: { count: number };
  directory: string;
}

const temporaryDirectories: string[] = [];

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

function memorySource(
  records: readonly RetrievalRecord[],
  pageCalls: { count: number },
  coverage?: { semantic: 'complete' | 'partial'; failedJobs: readonly string[] },
): MemoryRetrievalSource {
  const source: MemoryRetrievalSource = {
    async page(request) {
      assert.ok(
        request.limit === undefined || (Number.isInteger(request.limit) && request.limit > 0 && request.limit <= 10_000),
        `source.page must be asked for a bounded page, received limit=${String(request.limit)}`,
      );
      pageCalls.count += 1;
      const projectRecords = records.filter((record) => record.projectId === request.projectId);
      const start = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
      assert.ok(Number.isInteger(start) && start >= 0, `source.page received an invalid cursor ${String(request.cursor)}`);
      const requested = request.limit ?? 1_000;
      const slice = projectRecords.slice(start, start + Math.min(requested, 10_000));
      const next = start + slice.length < projectRecords.length ? String(start + slice.length) : undefined;
      return next === undefined ? { records: slice } : { records: slice, cursor: next };
    },
  };
  if (coverage !== undefined) {
    source.coverage = async () => ({ semantic: coverage.semantic, failedJobs: [...coverage.failedJobs] });
  }
  return source;
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  const message = String((error as Error | undefined)?.message ?? '');
  return code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(message);
}

const MISSING_MODULE_MESSAGE = 'Missing required behavior: packages/memory/src/retrieval/index.ts must export '
  + 'createMemoryRetrieval({ projectId, grantedProjectIds?, directory, source, embeddings?, tokenizer?, now?, limits? }) '
  + 'returning index(), search(), answer(), coverage() and close().';

async function loadRetrievalModule(): Promise<RetrievalModule> {
  const specifier = './index.js';
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    if (isModuleNotFound(error)) assert.fail(MISSING_MODULE_MESSAGE);
    throw error;
  }
  assert.equal(typeof loaded.createMemoryRetrieval, 'function', MISSING_MODULE_MESSAGE);
  return loaded as unknown as RetrievalModule;
}

async function openHarness(input: {
  records: readonly RetrievalRecord[];
  grantedProjectIds?: readonly string[];
  embeddings?: LocalEmbeddingProvider;
  limits?: RetrievalOptions['limits'];
  coverage?: { semantic: 'complete' | 'partial'; failedJobs: readonly string[] };
  index?: boolean;
}): Promise<Harness> {
  const module = await loadRetrievalModule();
  const directory = await makeDirectory('m05-retrieval-');
  const pageCalls = { count: 0 };
  const options: RetrievalOptions = {
    projectId: ACTIVE_PROJECT,
    directory,
    source: memorySource(input.records, pageCalls, input.coverage),
    tokenizer,
    now: clock,
  };
  if (input.grantedProjectIds !== undefined) options.grantedProjectIds = input.grantedProjectIds;
  if (input.embeddings !== undefined) options.embeddings = input.embeddings;
  if (input.limits !== undefined) options.limits = input.limits;
  const retrieval = await module.createMemoryRetrieval(options);
  if (input.index !== false) await retrieval.index();
  return { retrieval, records: input.records, pageCalls, directory };
}

let bigHarness: Promise<Harness & { indexResult: IndexResult }> | undefined;
function bigRetrieval(): Promise<Harness & { indexResult: IndexResult }> {
  bigHarness ??= openIndexedHarness({ records: buildBigCorpus(), embeddings });
  return bigHarness;
}

function itemIds(result: { items: readonly EvidenceItem[] }): string[] {
  return result.items.map((item) => item.id);
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(fraction * samples.length) - 1));
  return samples[index] ?? Number.POSITIVE_INFINITY;
}

async function measurePass(
  retrieval: MemoryRetrieval,
  queries: readonly string[],
  mode: 'lexical' | 'enriched',
): Promise<{ p50: number; p95: number; max: number }> {
  for (const query of queries.slice(0, LATENCY_WARMUP)) {
    await retrieval.search({ query, mode });
  }
  const samples: number[] = [];
  for (const query of queries) {
    const started = performance.now();
    await retrieval.search({ query, mode });
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples[samples.length - 1] ?? Number.POSITIVE_INFINITY,
  };
}

function latencyQueries(): string[] {
  const random = mulberry32(0x1a7e);
  const queries: string[] = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    queries.push(`${pick(random)} ${pick(random)}`);
  }
  return queries;
}

interface IndexResult {
  indexed: number;
  generation: string;
  coverage: RetrievalCoverage;
}

type HarnessInput = Parameters<typeof openHarness>[0];

async function openIndexedHarness(input: HarnessInput): Promise<Harness & { indexResult: IndexResult }> {
  const harness = await openHarness({ ...input, index: false });
  const indexResult = await harness.retrieval.index();
  return { ...harness, indexResult };
}

test('indexes 100,000 project records and keeps every candidate and evidence bound', async (t) => {
  const harness = await bigRetrieval();
  assert.equal(harness.indexResult.indexed, ACTIVE_RECORD_COUNT,
    'index() must page and index every active-project record');
  assert.equal(harness.indexResult.coverage.semantic, 'complete',
    'a fully indexed corpus must report complete coverage');
  assert.ok(harness.indexResult.generation.length > 0, 'index() must report a generation label');
  assert.ok(harness.pageCalls.count > 1,
    '100,000 records must be paged through source.page instead of one unbounded materialization');

  const coverage = await harness.retrieval.coverage();
  assert.equal(coverage.semantic, 'complete');

  const query = 'scheduler telemetry';
  const matching = harness.records.filter((record) => record.projectId === ACTIVE_PROJECT
    && record.text.includes('scheduler') && record.text.includes('telemetry')).length;
  assert.ok(matching > 100,
    `the fixture must hold more lexical matches than the candidate cap (found ${matching})`);

  const lexical = await harness.retrieval.search({ query, mode: 'lexical' });
  assert.equal(lexical.mode, 'lexical');
  assert.equal(lexical.counters.embeddingCandidates, 0, 'a lexical request must not score embeddings');
  assert.ok(lexical.counters.lexicalCandidates <= 100,
    `lexical candidates must be capped at 100, saw ${lexical.counters.lexicalCandidates}`);
  assert.ok(lexical.items.length <= EVIDENCE_ITEM_CAP,
    `at most ${EVIDENCE_ITEM_CAP} evidence items may be selected, saw ${lexical.items.length}`);
  assert.ok(lexical.tokens <= EVIDENCE_TOKEN_CAP,
    `at most ${EVIDENCE_TOKEN_CAP} evidence tokens may be selected, saw ${lexical.tokens}`);
  assert.equal(lexical.items.reduce((total, item) => total + item.tokens, 0), lexical.tokens,
    'result.tokens must equal the sum of the selected item token counts');
  assert.ok(lexical.items.every((item) => item.sources.length > 0),
    'every evidence item must carry the raw source ids it came from');
  assert.equal(new Set(itemIds(lexical)).size, lexical.items.length, 'items must be deduplicated by record id');

  const enriched = await harness.retrieval.search({ query, mode: 'enriched' });
  assert.equal(enriched.mode, 'enriched');
  assert.ok(enriched.counters.embeddingCandidates > 0, 'the enriched path must score local embeddings');
  assert.ok(enriched.counters.embeddingCandidates <= 5000,
    `embedding scoring is capped at 5,000 candidates, saw ${enriched.counters.embeddingCandidates}`);
  assert.ok(enriched.items.length <= EVIDENCE_ITEM_CAP);
  assert.ok(enriched.tokens <= EVIDENCE_TOKEN_CAP);
  t.diagnostic(`indexed ${harness.indexResult.indexed} records in ${harness.pageCalls.count} pages; `
    + `lexical candidates ${lexical.counters.lexicalCandidates}, enriched candidates ${enriched.counters.embeddingCandidates}`);
});

test('structured/lexical and enriched retrieval meet the section 4.4 latency gate over 100,000 records', async (t) => {
  const harness = await bigRetrieval();
  const queries = latencyQueries();

  const lexicalFirst = await measurePass(harness.retrieval, queries, 'lexical');
  const lexical = lexicalFirst.p95 <= LEXICAL_GATE_MS
    ? lexicalFirst
    : await measurePass(harness.retrieval, queries, 'lexical');
  t.diagnostic(`lexical p50=${lexical.p50.toFixed(1)}ms p95=${lexical.p95.toFixed(1)}ms `
    + `(first pass p95=${lexicalFirst.p95.toFixed(1)}ms) gate ≤${LEXICAL_GATE_MS}ms over ${LATENCY_SAMPLES} queries`);
  assert.ok(lexical.p95 <= LEXICAL_GATE_MS,
    `structured/lexical retrieval must stay ≤${LEXICAL_GATE_MS} ms p95 over 100,000 records; `
    + `measured p50=${lexical.p50.toFixed(1)}ms p95=${lexical.p95.toFixed(1)}ms max=${lexical.max.toFixed(1)}ms`);

  const enrichedFirst = await measurePass(harness.retrieval, queries, 'enriched');
  const enriched = enrichedFirst.p95 <= ENRICHED_GATE_MS
    ? enrichedFirst
    : await measurePass(harness.retrieval, queries, 'enriched');
  t.diagnostic(`enriched p50=${enriched.p50.toFixed(1)}ms p95=${enriched.p95.toFixed(1)}ms `
    + `(first pass p95=${enrichedFirst.p95.toFixed(1)}ms) gate ≤${ENRICHED_GATE_MS}ms over ${LATENCY_SAMPLES} queries`);
  assert.ok(enriched.p95 <= ENRICHED_GATE_MS,
    `enriched retrieval must stay ≤${ENRICHED_GATE_MS} ms p95 over 100,000 records; `
    + `measured p50=${enriched.p50.toFixed(1)}ms p95=${enriched.p95.toFixed(1)}ms max=${enriched.max.toFixed(1)}ms`);
});

test('embedding expansion finds the semantic match that lexical search misses, without duplicating it', async () => {
  const harness = await bigRetrieval();
  const query = 'Which vault holds our retry budget?';
  const lexical = await harness.retrieval.search({ query, mode: 'lexical', entities: ['component-quartzite'] });
  assert.ok(!itemIds(lexical).includes('rec-quartzite'),
    'the query shares no lexical token with the quartzite decision, so the lexical path must not return it');

  const enriched = await harness.retrieval.search({ query, mode: 'enriched', entities: ['component-quartzite'] });
  const ids = itemIds(enriched);
  assert.ok(ids.includes('rec-quartzite'),
    `the embedding expansion must surface the semantically matching decision, saw ${ids.join(', ') || '(no items)'}`);
  assert.equal(ids.filter((id) => id === 'rec-quartzite').length, 1,
    'fusion must deduplicate a record that arrived through more than one candidate list');
  const item = enriched.items.find((candidate) => candidate.id === 'rec-quartzite');
  assert.ok(item !== undefined);
  assert.deepEqual(item.sources.map((source) => source.eventId), ['evt-quartzite']);
  assert.equal(item.kind, 'decision');
  assert.equal(item.trust, 'user_explicit');
});

const TIMELINE_QUESTION = 'How often does the telemetry exporter batch writes?';
const TIMELINE_EARLY_TEXT = 'Decision: the telemetry exporter batches writes every fifteen minutes.';
const TIMELINE_EARLY = makeRecord({
  id: 'rec-timeline-early',
  projectId: ACTIVE_PROJECT,
  kind: 'decision',
  text: TIMELINE_EARLY_TEXT,
  trust: 'user_explicit',
  occurredAt: daysBefore(20),
  validFrom: daysBefore(20),
  validTo: daysBefore(3),
  status: 'superseded',
  sourceEventIds: ['evt-timeline-early'],
  rawAvailable: true,
});
const TIMELINE_LATE = makeRecord({
  id: 'rec-timeline-late',
  projectId: ACTIVE_PROJECT,
  kind: 'decision',
  text: 'Decision: the telemetry exporter batches writes every five minutes.',
  trust: 'user_explicit',
  occurredAt: daysBefore(3),
  validFrom: daysBefore(3),
  sourceEventIds: ['evt-timeline-late'],
  rawAvailable: true,
});
/** The same early decision in a corpus where no later decision exists, so it is still the active one. */
const TIMELINE_EARLY_ACTIVE_ONLY = makeRecord({
  id: 'rec-timeline-early',
  projectId: ACTIVE_PROJECT,
  kind: 'decision',
  text: TIMELINE_EARLY_TEXT,
  trust: 'user_explicit',
  occurredAt: daysBefore(20),
  validFrom: daysBefore(20),
  sourceEventIds: ['evt-timeline-early'],
  rawAvailable: true,
});

test('explicit historical questions answer from that instant and are unaffected by later records', async () => {
  const full = await openIndexedHarness({ records: [TIMELINE_EARLY, TIMELINE_LATE] });
  const past = await openIndexedHarness({ records: [TIMELINE_EARLY_ACTIVE_ONLY] });
  const historicalAsOf = daysBefore(10);

  const fullAnswer = await full.retrieval.answer({ question: TIMELINE_QUESTION, asOf: historicalAsOf });
  const pastAnswer = await past.retrieval.answer({ question: TIMELINE_QUESTION, asOf: historicalAsOf });
  assert.equal(fullAnswer.historical, true, 'an instant before now is an explicitly historical question');
  assert.deepEqual(itemIds(fullAnswer), ['rec-timeline-early'],
    'the historical answer must come from the record that was valid at that instant');
  assert.deepEqual(fullAnswer.evidenceIds.map((id) => id), ['evt-timeline-early']);
  assert.match(fullAnswer.text, /fifteen minutes/);
  assert.doesNotMatch(fullAnswer.text, /five minutes/, 'a later decision must not leak into the historical answer');
  assert.deepEqual(itemIds(pastAnswer), itemIds(fullAnswer),
    'the historical answer must be identical whether or not later records exist in the corpus');
  assert.deepEqual(pastAnswer.evidenceIds.map((id) => id), fullAnswer.evidenceIds.map((id) => id));
  assert.equal(pastAnswer.tokens, fullAnswer.tokens);

  const fullCurrent = await full.retrieval.answer({ question: TIMELINE_QUESTION });
  const pastCurrent = await past.retrieval.answer({ question: TIMELINE_QUESTION });
  assert.equal(fullCurrent.historical, false);
  assert.deepEqual(itemIds(fullCurrent), ['rec-timeline-late']);
  assert.match(fullCurrent.text, /five minutes/);
  assert.deepEqual(itemIds(pastCurrent), ['rec-timeline-early']);
  assert.match(pastCurrent.text, /fifteen minutes/);
});

test('current questions boost the newer of two equally matching memories', async () => {
  const harness = await bigRetrieval();
  const result = await harness.retrieval.search({ query: 'nightly smoke suite flakes', mode: 'lexical' });
  const newer = result.items.find((item) => item.id === 'rec-z-nightly-new');
  const older = result.items.find((item) => item.id === 'rec-a-nightly-old');
  assert.ok(newer !== undefined && older !== undefined,
    `both nightly records must be retrievable, saw ${itemIds(result).join(', ')}`);
  assert.equal(result.items[0]?.id, 'rec-z-nightly-new',
    'a current question must boost the newer evidence; the older record sorts first by id, so a plain id tie-break would fail this');
  assert.ok(newer.score > older.score,
    `the newer memory must score above the older one (${newer.score} vs ${older.score})`);
});

const SCOPE_RECORDS: readonly RetrievalRecord[] = [
  makeRecord({
    id: 'rec-atlas-scope',
    projectId: ACTIVE_PROJECT,
    kind: 'observation',
    text: 'Atlas keeps the deployment token in the encrypted project store.',
    trust: 'tool_observed',
    occurredAt: daysBefore(6),
    validFrom: daysBefore(6),
    sourceEventIds: ['evt-atlas-1'],
    rawAvailable: true,
  }),
  makeRecord({
    id: 'rec-borealis-scope',
    projectId: BOREALIS_PROJECT,
    kind: 'observation',
    text: `Borealis keeps the deployment token in the shared staging bucket. ${BOREALIS_CANARY}`,
    trust: 'agent_reported',
    occurredAt: daysBefore(6),
    validFrom: daysBefore(6),
    sourceEventIds: ['evt-borealis-1'],
    rawAvailable: true,
  }),
];

test('cross-project requests are denied explicitly and never disclose another project', async () => {
  const ungranted = await openIndexedHarness({ records: SCOPE_RECORDS });
  const defaultSearch = await ungranted.retrieval.search({ query: 'deployment token' });
  assert.ok(defaultSearch.items.length > 0, 'the active project keeps its own matching memory');
  assert.ok(defaultSearch.items.every((item) => item.projectId === ACTIVE_PROJECT),
    'the default request scope is the active project');
  assert.ok(!JSON.stringify(defaultSearch.items).includes(BOREALIS_CANARY),
    'an ungranted project must never contribute text to an active-project result');

  const denied = await ungranted.retrieval.search({ query: 'deployment token', projectIds: [BOREALIS_PROJECT] });
  assert.equal(denied.items.length, 0, 'a non-granted project must contribute no evidence');
  assert.deepEqual(denied.denied.map((entry) => entry.projectId), [BOREALIS_PROJECT],
    'the denial must be explicit, not a silent empty answer');
  assert.equal(denied.denied[0]?.reason, 'cross_project_denied');

  const deniedAnswer = await ungranted.retrieval.answer({
    question: 'Where does borealis keep the deployment token?',
    projectIds: [BOREALIS_PROJECT],
  });
  assert.equal(deniedAnswer.supported, false);
  assert.equal(deniedAnswer.evidenceIds.length, 0);
  assert.ok(!deniedAnswer.text.includes(BOREALIS_CANARY));
  assert.ok(!deniedAnswer.text.includes('staging bucket'), 'a denied request must not paraphrase the other project');
  await ungranted.retrieval.close();

  const granted = await openIndexedHarness({ records: SCOPE_RECORDS, grantedProjectIds: [BOREALIS_PROJECT] });
  const other = await granted.retrieval.search({ query: 'deployment token', projectIds: [BOREALIS_PROJECT] });
  assert.ok(other.items.length > 0, 'an explicitly granted project is searchable');
  assert.ok(other.items.every((item) => item.projectId === BOREALIS_PROJECT));
  assert.equal(other.denied.length, 0);

  const active = await granted.retrieval.search({ query: 'deployment token' });
  assert.ok(active.items.every((item) => item.projectId === ACTIVE_PROJECT),
    'a grant does not widen the default scope');
  assert.ok(active.counters.droppedForScope >= 1,
    'matches from the granted-but-not-requested project must be counted as dropped for scope');

  const missing = await granted.retrieval.answer({ question: 'deployment token', projectIds: [CYGNUS_PROJECT] });
  assert.equal(missing.supported, false);
  assert.deepEqual(missing.denied.map((entry) => entry.projectId), [CYGNUS_PROJECT]);
});

const LEGACY_DECISION = makeRecord({
  id: 'rec-legacy-decision',
  projectId: ACTIVE_PROJECT,
  kind: 'decision',
  text: 'Decision: the legacy exporter keeps its checkpoint in the abandoned spool.',
  trust: 'user_explicit',
  occurredAt: daysBefore(60),
  validFrom: daysBefore(60),
  sourceEventIds: ['evt-legacy-raw', 'evt-legacy-confirm'],
  rawAvailable: false,
  capsule: { id: 'capsule-legacy', bytes: 480 },
});
const LIVE_DECISION = makeRecord({
  id: 'rec-live-decision',
  projectId: ACTIVE_PROJECT,
  kind: 'decision',
  text: 'Decision: the live exporter keeps its checkpoint in the sealed journal.',
  trust: 'user_explicit',
  occurredAt: daysBefore(6),
  validFrom: daysBefore(6),
  sourceEventIds: ['evt-live-raw'],
  rawAvailable: true,
});
const EXPIRED_RECORDS: readonly RetrievalRecord[] = [
  LEGACY_DECISION,
  LIVE_DECISION,
  makeRecord({
    id: 'rec-unrelated',
    projectId: ACTIVE_PROJECT,
    kind: 'observation',
    text: 'Unrelated note: the sandbox fixture rebuilds nightly.',
    trust: 'agent_reported',
    occurredAt: daysBefore(8),
    validFrom: daysBefore(8),
    sourceEventIds: ['evt-unrelated'],
    rawAvailable: true,
  }),
];

test('expired raw sources stay visibly unavailable and keep bounded capsules', async () => {
  const harness = await openIndexedHarness({ records: EXPIRED_RECORDS });
  const answer = await harness.retrieval.answer({ question: 'legacy exporter checkpoint spool' });
  assert.equal(answer.supported, true, 'the retained decision text still answers the question');
  assert.deepEqual(itemIds(answer), ['rec-legacy-decision']);
  const item = answer.items[0];
  assert.ok(item !== undefined);
  assert.equal(item.text, LEGACY_DECISION.text,
    'the module must serve the retained decision text, never invent raw text that expired');
  assert.ok(item.sources.length >= 1);
  assert.ok(item.sources.every((source) => source.rawAvailability === 'expired'),
    'every raw source of an expired record must be labeled unavailable');
  assert.ok(item.capsule !== undefined && item.capsule.bytes > 0 && item.capsule.bytes <= 4096,
    'a retained decision keeps a small supporting capsule');
  assert.ok(answer.coverage.gaps.some((gap) => gap.kind === 'raw_source_expired'),
    'coverage must expose the expired raw source instead of hiding it');
  assert.deepEqual([...answer.evidenceIds].sort(), [...LEGACY_DECISION.sourceEventIds].sort());

  const live = await harness.retrieval.answer({ question: 'live exporter checkpoint sealed journal' });
  const liveItem = live.items.find((candidate) => candidate.id === 'rec-live-decision');
  assert.ok(liveItem !== undefined, 'the live decision is retrievable');
  assert.ok(liveItem.sources.every((source) => source.rawAvailability === 'available'));
  assert.ok(!live.coverage.gaps.some((gap) => gap.kind === 'raw_source_expired'));

  const unknown = await harness.retrieval.answer({ question: 'what is the deployment key for component-unknown-zzz' });
  assert.equal(unknown.supported, false, 'no evidence must never be answered as verified');
  assert.equal(unknown.evidenceIds.length, 0);
  assert.equal(unknown.items.length, 0);
  for (const record of EXPIRED_RECORDS) {
    assert.ok(!unknown.text.includes(record.text),
      'an unsupported answer must not quote unrelated memory as if it answered the question');
  }
});

test('a failed summary worker is reported as partial coverage and never as a complete memory', async () => {
  const degraded = await openIndexedHarness({
    records: EXPIRED_RECORDS,
    coverage: { semantic: 'partial', failedJobs: ['summary-job-42'] },
  });
  const answer = await degraded.retrieval.answer({ question: 'live exporter checkpoint sealed journal' });
  assert.equal(answer.coverage.semantic, 'partial',
    'a source with a failed summary worker must report partial coverage');
  assert.deepEqual([...answer.coverage.failedJobs], ['summary-job-42'],
    'the answer must name the failed summary job instead of implying a complete memory');
  const summaryGap = answer.coverage.gaps.find((candidate) => candidate.kind === 'summary_failed');
  assert.ok(summaryGap !== undefined, 'the failed summary job must surface as a visible summary_failed gap');
  assert.deepEqual([...(summaryGap.jobIds ?? [])], ['summary-job-42']);
  const degradedCoverage = await degraded.retrieval.coverage();
  assert.equal(degradedCoverage.semantic, 'partial');
  assert.deepEqual([...degradedCoverage.failedJobs], ['summary-job-42']);
  await degraded.retrieval.close();

  const complete = await openIndexedHarness({ records: EXPIRED_RECORDS });
  const completeAnswer = await complete.retrieval.answer({ question: 'live exporter checkpoint sealed journal' });
  assert.equal(completeAnswer.coverage.semantic, 'complete',
    'a source that reports no failed job must still report complete coverage');
  assert.deepEqual([...completeAnswer.coverage.failedJobs], []);
  assert.ok(!completeAnswer.coverage.gaps.some((candidate) => candidate.kind === 'summary_failed'),
    'no summary_failed gap may be invented when every worker succeeded');
  await complete.retrieval.close();
});

test('repeated identical answers stay bounded and identical, without growing model context', async () => {
  const harness = await bigRetrieval();
  const request = { question: 'nightly smoke suite flakes', mode: 'lexical' as const };
  const first = await harness.retrieval.answer(request);
  assert.ok(first.tokens <= EVIDENCE_TOKEN_CAP);
  for (let run = 0; run < 9; run += 1) {
    const next = await harness.retrieval.answer(request);
    assert.ok(next.tokens <= EVIDENCE_TOKEN_CAP,
      `repeated answers must stay within the evidence budget, saw ${next.tokens}`);
    assert.deepEqual(itemIds(next), itemIds(first), 'repeated answers must select the same evidence');
    assert.deepEqual(next.evidenceIds.map((id) => id), first.evidenceIds.map((id) => id));
    assert.equal(next.tokens, first.tokens);
    assert.equal(next.text, first.text);
  }
});
