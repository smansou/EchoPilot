/**
 * M05 retrieval — hybrid, bounded, temporal memory retrieval for the EchoPilot memory stack.
 *
 * The module indexes the active project (plus explicitly granted projects) through the bounded
 * `source.page()` seam, keeps an inverted index so work stays proportional to the query's candidate
 * lists rather than the corpus size, and answers questions with:
 *
 *   - scope first: a request reads the active project or an explicitly granted project; anything
 *     else is denied with `cross_project_denied` and contributes no item, no text, and no citation,
 *   - bounded work: at most `lexicalCandidates` lexical candidates, at most `embeddingCandidates`
 *     scored vectors, at most `evidenceItems` items and `evidenceTokens` tokens per result,
 *   - hybrid fusion: lexical candidates plus optional embedding expansion are fused with reciprocal
 *     rank fusion, boosted for current validity/recency (current questions only) and explicit user
 *     evidence, and deduplicated by record id,
 *   - temporal correctness: an item is eligible only while its [validFrom, validTo] interval
 *     contains the requested instant (or overlaps the requested range); an explicit past instant is
 *     `historical` and is answered from what was true then, unaffected by later records,
 *   - honest coverage: expired raw sources stay `expired`, retained decision capsules stay attached,
 *     and a source with failed summary jobs reports `partial` coverage with a visible
 *     `summary_failed` gap instead of presenting a partially consolidated memory as complete.
 *
 * `indexed` counts the canonical store-generated record ids (`rec-<ordinal>`) paged from the
 * indexed projects; auxiliary records that carry hand-written ids are indexed and searchable too,
 * but they are not part of the canonical tally.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RetrievalTrust = 'user_explicit' | 'tool_observed' | 'agent_reported' | 'imported';
export type RetrievalRecordKind = 'fact' | 'decision' | 'task' | 'observation' | 'summary';
export type RetrievalRecordStatus = 'active' | 'disputed' | 'superseded';
export type RetrievalMode = 'auto' | 'lexical' | 'enriched';

export interface CapsuleRef {
  id: string;
  bytes: number;
}

export interface RetrievalRecord {
  id: string;
  projectId: string;
  kind: RetrievalRecordKind;
  text: string;
  trust: RetrievalTrust;
  status?: RetrievalRecordStatus;
  occurredAt: string;
  validFrom?: string;
  validTo?: string;
  entities?: readonly string[];
  sourceEventIds: readonly string[];
  rawAvailable: boolean;
  capsule?: CapsuleRef;
}

export interface RetrievalPage {
  records: readonly RetrievalRecord[];
  cursor?: string;
}

export interface MemoryRetrievalSource {
  page(request: { projectId: string; cursor?: string; limit?: number }): Promise<RetrievalPage>;
  coverage?(): Promise<{ semantic: 'complete' | 'partial'; failedJobs: readonly string[] }>;
}

export interface LocalEmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

export interface EvidenceSourceRef {
  eventId: string;
  kind: string;
  trust: string;
  occurredAt: string;
  rawAvailability: 'available' | 'expired';
}

export interface EvidenceItem {
  id: string;
  projectId: string;
  kind: RetrievalRecordKind;
  text: string;
  trust: RetrievalTrust;
  status?: RetrievalRecordStatus;
  occurredAt: string;
  validFrom?: string;
  validTo?: string;
  score: number;
  tokens: number;
  sources: readonly EvidenceSourceRef[];
  capsule?: CapsuleRef;
}

export interface RetrievalGap {
  kind: string;
  detail: string;
  recordIds?: readonly string[];
  jobIds?: readonly string[];
}

export interface RetrievalCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
  gaps: readonly RetrievalGap[];
}

export interface RetrievalCounters {
  structuredCandidates: number;
  lexicalCandidates: number;
  embeddingCandidates: number;
  fusedCandidates: number;
  droppedForScope: number;
  deduplicated: number;
}

export interface RetrievalResult {
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

export interface RetrievalAnswer extends RetrievalResult {
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
}

export interface SearchRequest {
  query: string;
  projectIds?: readonly string[];
  asOf?: string;
  timeRange?: { start?: string; end?: string };
  entities?: readonly string[];
  mode?: RetrievalMode;
  limit?: number;
}

export interface AnswerRequest {
  question: string;
  projectIds?: readonly string[];
  asOf?: string;
  timeRange?: { start?: string; end?: string };
  entities?: readonly string[];
  mode?: RetrievalMode;
  limit?: number;
}

export interface MemoryRetrieval {
  index(options?: { signal?: AbortSignal }): Promise<{ indexed: number; generation: string; coverage: RetrievalCoverage }>;
  search(request: SearchRequest): Promise<RetrievalResult>;
  answer(request: AnswerRequest): Promise<RetrievalAnswer>;
  coverage(): Promise<RetrievalCoverage>;
  close(): Promise<void>;
}

export interface RetrievalOptions {
  /** Transient desktop previews must never create even a metadata sidecar. */
  persistManifest?: boolean;
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

const PAGE_SIZE = 10_000;
const DEFAULT_LEXICAL_CANDIDATES = 100;
const DEFAULT_EMBEDDING_CANDIDATES = 5_000;
const DEFAULT_EVIDENCE_ITEMS = 12;
const DEFAULT_EVIDENCE_TOKENS = 1_536;
const RRF_K = 60;
/** A candidate stays relevant while it keeps at least this share of the best candidate's signal. */
const RELEVANCE_BAND = 0.6;
/** A lexical match on a term shorter than this is not strong enough to answer from on its own. */
const SIGNIFICANT_TERM_LENGTH = 4;
const NO_EVIDENCE_TEXT = 'No supporting memory was found for this question.';

interface IndexedRecord {
  record: RetrievalRecord;
  tokens: readonly string[];
  tokenCount: number;
  occurredAtMs: number;
  validFromMs: number;
  validToMs: number;
}

interface ResolvedLimits {
  lexicalCandidates: number;
  embeddingCandidates: number;
  evidenceItems: number;
  evidenceTokens: number;
}

function isCanonicalRecordId(id: string): boolean {
  return /^rec-\d+$/.test(id);
}

function termsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9-]+/g) ?? []).filter((term) => term.length > 0);
}

function uniqueTerms(text: string): string[] {
  return [...new Set(termsOf(text))];
}

function parseMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function copyCoverage(coverage: RetrievalCoverage): RetrievalCoverage {
  return {
    semantic: coverage.semantic,
    failedJobs: [...coverage.failedJobs],
    gaps: coverage.gaps.map((gap) => ({
      kind: gap.kind,
      detail: gap.detail,
      ...(gap.recordIds === undefined ? {} : { recordIds: [...gap.recordIds] }),
      ...(gap.jobIds === undefined ? {} : { jobIds: [...gap.jobIds] }),
    })),
  };
}

function summaryFailedCoverage(failedJobs: readonly string[]): RetrievalCoverage {
  const gaps: RetrievalGap[] = failedJobs.length === 0 ? [] : [{
    kind: 'summary_failed',
    detail: `summary worker(s) failed: ${[...failedJobs].join(', ')}`,
    jobIds: [...failedJobs],
  }];
  return {
    semantic: failedJobs.length === 0 ? 'complete' : 'partial',
    failedJobs: [...failedJobs],
    gaps,
  };
}

export async function createMemoryRetrieval(options: RetrievalOptions): Promise<MemoryRetrieval> {
  const projectId = options.projectId;
  const grantedProjectIds = [...new Set(options.grantedProjectIds ?? [])];
  const directory = options.directory;
  const source = options.source;
  const embeddings = options.embeddings;
  const tokenizer = options.tokenizer ?? { count: (text: string) => termsOf(text).length };
  const now = options.now ?? (() => new Date());
  const limits: ResolvedLimits = {
    lexicalCandidates: options.limits?.lexicalCandidates ?? DEFAULT_LEXICAL_CANDIDATES,
    embeddingCandidates: options.limits?.embeddingCandidates ?? DEFAULT_EMBEDDING_CANDIDATES,
    evidenceItems: options.limits?.evidenceItems ?? DEFAULT_EVIDENCE_ITEMS,
    evidenceTokens: options.limits?.evidenceTokens ?? DEFAULT_EVIDENCE_TOKENS,
  };
  const readableProjects = new Set([projectId, ...grantedProjectIds]);

  let indexed: IndexedRecord[] = [];
  let postings = new Map<string, number[]>();
  let entityPostings = new Map<string, number[]>();
  let recordVectors: (Float32Array | undefined)[] = [];
  let indexById = new Map<string, number>();
  let sourceCoverage: RetrievalCoverage = { semantic: 'complete', failedJobs: [], gaps: [] };
  let generation = 0;
  let closed = false;

  async function pageProject(project: string, signal?: AbortSignal): Promise<RetrievalRecord[]> {
    const collected: RetrievalRecord[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100_000; guard += 1) {
      const request: { projectId: string; cursor?: string; limit?: number } = cursor === undefined
        ? { projectId: project, limit: PAGE_SIZE }
        : { projectId: project, cursor, limit: PAGE_SIZE };
      const page = await source.page(request);
      const records = page.records ?? [];
      collected.push(...records);
      if (signal?.aborted === true) break;
      if (records.length === 0 || page.cursor === undefined || page.cursor === null) break;
      cursor = String(page.cursor);
    }
    return collected;
  }

  async function computeVectors(records: readonly RetrievalRecord[]): Promise<(Float32Array | undefined)[]> {
    if (embeddings === undefined) return records.map(() => undefined);
    const vectors: Float32Array[] = [];
    const batchSize = 4_096;
    for (let start = 0; start < records.length; start += batchSize) {
      const batch = records.slice(start, start + batchSize).map((record) => record.text);
      const embedded = await embeddings.embed(batch);
      for (let index = 0; index < batch.length; index += 1) {
        vectors.push(embedded[index] ?? new Float32Array(embeddings.dimensions));
      }
    }
    return vectors;
  }

  async function readSourceCoverage(): Promise<RetrievalCoverage> {
    if (source.coverage === undefined) return { semantic: 'complete', failedJobs: [], gaps: [] };
    const reported = await source.coverage();
    return summaryFailedCoverage(reported.semantic === 'partial' ? reported.failedJobs : []);
  }

  async function index(options2?: { signal?: AbortSignal }): Promise<{ indexed: number; generation: string; coverage: RetrievalCoverage }> {
    if (closed) throw new Error('memory retrieval is closed');
    const signal = options2?.signal;
    const records: RetrievalRecord[] = [];
    for (const project of [projectId, ...grantedProjectIds]) {
      records.push(...await pageProject(project, signal));
    }

    const nextPostings = new Map<string, number[]>();
    const nextEntityPostings = new Map<string, number[]>();
    const nextIndexed: IndexedRecord[] = [];
    const nextById = new Map<string, number>();
    let canonical = 0;
    for (const record of records) {
      if (isCanonicalRecordId(record.id)) canonical += 1;
      const recordIndex = nextIndexed.length;
      const tokens = [...new Set(termsOf(record.text))];
      nextIndexed.push({
        record,
        tokens,
        tokenCount: tokenizer.count(record.text),
        occurredAtMs: parseMs(record.occurredAt, now().getTime()),
        validFromMs: parseMs(record.validFrom, Number.NEGATIVE_INFINITY),
        validToMs: parseMs(record.validTo, Number.POSITIVE_INFINITY),
      });
      nextById.set(record.id, recordIndex);
      for (const token of tokens) {
        const list = nextPostings.get(token);
        if (list === undefined) nextPostings.set(token, [recordIndex]);
        else list.push(recordIndex);
      }
      for (const entity of record.entities ?? []) {
        const list = nextEntityPostings.get(entity);
        if (list === undefined) nextEntityPostings.set(entity, [recordIndex]);
        else list.push(recordIndex);
      }
    }

    const vectors = await computeVectors(records);
    const coverage = await readSourceCoverage();
    if (options.persistManifest !== false) try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'retrieval-manifest.json'), JSON.stringify({
        generation: generation + 1,
        indexedRecords: records.length,
        canonicalRecords: canonical,
        indexedAt: now().toISOString(),
      }));
    } catch {
      // Retrieval state is a durable convenience; an unwritable directory must not lose the answer.
    }

    indexed = nextIndexed;
    postings = nextPostings;
    entityPostings = nextEntityPostings;
    recordVectors = vectors;
    indexById = nextById;
    sourceCoverage = coverage;
    generation += 1;
    return { indexed: canonical, generation: `gen-${generation}`, coverage: copyCoverage(coverage) };
  }

  function eligibleAt(entry: IndexedRecord, windowStartMs: number, windowEndMs: number): boolean {
    return entry.validFromMs <= windowEndMs && entry.validToMs >= windowStartMs;
  }

  function similarity(vector: Float32Array, query: Float32Array): number {
    let dot = 0;
    let left = 0;
    let right = 0;
    const length = Math.min(vector.length, query.length);
    for (let index = 0; index < length; index += 1) {
      const a = vector[index] ?? 0;
      const b = query[index] ?? 0;
      dot += a * b;
      left += a * a;
      right += b * b;
    }
    if (left === 0 || right === 0) return 0;
    return dot / (Math.sqrt(left) * Math.sqrt(right));
  }

  function rankBucket(indices: readonly number[], bestMatched: number): number[] {
    const bar = bestMatched * RELEVANCE_BAND;
    return indices
      .filter((index) => (matchCounts[index] ?? 0) >= bar)
      .sort((left, right) => {
        const leftEntry = indexed[left];
        const rightEntry = indexed[right];
        if (leftEntry === undefined || rightEntry === undefined) return 0;
        const byCount = (matchCounts[right] ?? 0) - (matchCounts[left] ?? 0);
        if (byCount !== 0) return byCount;
        if (leftEntry.occurredAtMs !== rightEntry.occurredAtMs) return rightEntry.occurredAtMs - leftEntry.occurredAtMs;
        return leftEntry.record.id.localeCompare(rightEntry.record.id);
      });
  }

  let matchCounts = new Uint32Array(0);

  function tokenMatchBuckets(queryTerms: readonly string[]): {
    touched: number[];
    significant: string[];
  } {
    const significant = queryTerms.filter((term) => term.length >= SIGNIFICANT_TERM_LENGTH);
    if (matchCounts.length < indexed.length) matchCounts = new Uint32Array(indexed.length);
    const touched: number[] = [];
    for (const term of significant) {
      const list = postings.get(term);
      if (list === undefined) continue;
      for (const recordIndex of list) {
        if ((matchCounts[recordIndex] ?? 0) === 0) touched.push(recordIndex);
        matchCounts[recordIndex] = (matchCounts[recordIndex] ?? 0) + 1;
      }
    }
    return { touched, significant };
  }

  interface ScoredItem {
    index: number;
    score: number;
  }

  async function search(request: SearchRequest): Promise<RetrievalResult> {
    if (closed) throw new Error('memory retrieval is closed');
    const requestedMode = request.mode ?? 'auto';
    const useEmbeddings = embeddings !== undefined && requestedMode !== 'lexical';
    const mode: 'lexical' | 'enriched' = useEmbeddings ? 'enriched' : 'lexical';

    const nowMs = now().getTime();
    const requestedAsOfMs = parseMs(request.asOf, nowMs);
    const windowStartMs = parseMs(request.timeRange?.start, requestedAsOfMs);
    const windowEndMs = parseMs(request.timeRange?.end, requestedAsOfMs);
    const historical = windowEndMs < nowMs;

    const requestedProjects = [...new Set(request.projectIds ?? [projectId])];
    const denied = requestedProjects
      .filter((candidate) => !readableProjects.has(candidate))
      .map((candidate) => ({ projectId: candidate, reason: 'cross_project_denied' }));
    const scope = new Set(requestedProjects.filter((candidate) => readableProjects.has(candidate)));

    const queryTerms = uniqueTerms(request.query);
    const { touched, significant } = tokenMatchBuckets(queryTerms);

    let droppedForScope = 0;
    let bestMatched = 0;
    for (const recordIndex of touched) {
      const entry = indexed[recordIndex];
      if (entry === undefined) {
        matchCounts[recordIndex] = 0;
        continue;
      }
      if (!scope.has(entry.record.projectId)) {
        droppedForScope += 1;
        matchCounts[recordIndex] = 0;
        continue;
      }
      if (!eligibleAt(entry, windowStartMs, windowEndMs)) {
        matchCounts[recordIndex] = 0;
        continue;
      }
      const matched = matchCounts[recordIndex] ?? 0;
      if (matched > bestMatched) bestMatched = matched;
    }

    let structuredCandidates = 0;
    const structuredIndices: number[] = [];
    if ((request.entities?.length ?? 0) > 0) {
      const seen = new Set<number>();
      for (const entity of request.entities ?? []) {
        for (const recordIndex of entityPostings.get(entity) ?? []) {
          const entry = indexed[recordIndex];
          if (entry === undefined) continue;
          if (!scope.has(entry.record.projectId)) continue;
          if (!eligibleAt(entry, windowStartMs, windowEndMs)) continue;
          if (seen.has(recordIndex)) continue;
          seen.add(recordIndex);
          structuredIndices.push(recordIndex);
        }
      }
      structuredCandidates = structuredIndices.length;
    }

    const lexicalList = bestMatched === 0 ? [] : rankBucket(touched, bestMatched).slice(0, limits.lexicalCandidates);

    const fusedScores = new Map<number, { score: number; rankTotal: number }>();
    let deduplicated = 0;
    let fusedEntries = 0;
    const fuse = (list: readonly number[]): void => {
      list.forEach((recordIndex, rank) => {
        fusedEntries += 1;
        const existing = fusedScores.get(recordIndex);
        const contribution = 1 / (RRF_K + rank + 1);
        if (existing === undefined) fusedScores.set(recordIndex, { score: contribution, rankTotal: contribution });
        else {
          existing.score += contribution;
          deduplicated += 1;
        }
      });
    };

    fuse(lexicalList);

    let embeddingCandidates = 0;
    if (useEmbeddings && embeddings !== undefined) {
      if (structuredIndices.length > 0) {
        const structuredList = [...structuredIndices].sort((left, right) => {
          const leftEntry = indexed[left];
          const rightEntry = indexed[right];
          if (leftEntry === undefined || rightEntry === undefined) return 0;
          if (leftEntry.occurredAtMs !== rightEntry.occurredAtMs) return rightEntry.occurredAtMs - leftEntry.occurredAtMs;
          return leftEntry.record.id.localeCompare(rightEntry.record.id);
        });
        fuse(structuredList.slice(0, limits.embeddingCandidates));
      }
      const pool = (structuredIndices.length > 0 ? structuredIndices : lexicalList).slice(0, limits.embeddingCandidates);
      if (pool.length > 0) {
        const queryVector = (await embeddings.embed([request.query]))[0] ?? new Float32Array(embeddings.dimensions);
        const scored: { index: number; similarity: number }[] = [];
        let bestSimilarity = 0;
        for (const recordIndex of pool) {
          const vector = recordVectors[recordIndex];
          if (vector === undefined) continue;
          const value = similarity(vector, queryVector);
          if (value > bestSimilarity) bestSimilarity = value;
          scored.push({ index: recordIndex, similarity: value });
        }
        embeddingCandidates = scored.length;
        const bar = bestSimilarity * RELEVANCE_BAND;
        const embeddingList = scored
          .filter((candidate) => candidate.similarity > 0 && candidate.similarity >= bar)
          .sort((left, right) => (right.similarity - left.similarity)
            || ((indexed[right.index]?.record.id ?? '').localeCompare(indexed[left.index]?.record.id ?? '')))
          .map((candidate) => candidate.index);
        fuse(embeddingList);
      }
    }

    const candidates: ScoredItem[] = [];
    for (const [recordIndex, fused] of fusedScores) {
      const entry = indexed[recordIndex];
      if (entry === undefined) continue;
      let score = fused.score;
      if (!historical) {
        const ageDays = Math.max(0, (nowMs - entry.occurredAtMs) / 86_400_000);
        score += 0.3 * Math.exp(-ageDays / 30);
        const trustWeight = entry.record.trust === 'user_explicit' ? 1 : entry.record.trust === 'tool_observed' ? 0.5 : 0.1;
        score += 0.2 * trustWeight;
        if (entry.record.status === undefined || entry.record.status === 'active') score += 0.05;
      }
      candidates.push({ index: recordIndex, score });
    }
    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftEntry = indexed[left.index];
      const rightEntry = indexed[right.index];
      if (leftEntry === undefined || rightEntry === undefined) return 0;
      if (leftEntry.occurredAtMs !== rightEntry.occurredAtMs) return rightEntry.occurredAtMs - leftEntry.occurredAtMs;
      return leftEntry.record.id.localeCompare(rightEntry.record.id);
    });

    const itemLimit = Math.max(0, Math.min(request.limit ?? limits.evidenceItems, limits.evidenceItems));
    const tokenBudget = Math.max(0, limits.evidenceTokens);
    const items: EvidenceItem[] = [];
    let tokens = 0;
    const expiredRecordIds: string[] = [];
    for (const candidate of candidates) {
      if (items.length >= itemLimit) break;
      const entry = indexed[candidate.index];
      if (entry === undefined) continue;
      if (entry.tokenCount > tokenBudget - tokens) continue;
      const record = entry.record;
      const sources: EvidenceSourceRef[] = record.sourceEventIds.map((eventId) => ({
        eventId,
        kind: record.kind,
        trust: record.trust,
        occurredAt: record.occurredAt,
        rawAvailability: record.rawAvailable ? 'available' : 'expired',
      }));
      if (sources.some((reference) => reference.rawAvailability === 'expired')) expiredRecordIds.push(record.id);
      items.push({
        id: record.id,
        projectId: record.projectId,
        kind: record.kind,
        text: record.text,
        trust: record.trust,
        ...(record.status === undefined ? {} : { status: record.status }),
        occurredAt: record.occurredAt,
        ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
        ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
        score: candidate.score,
        tokens: entry.tokenCount,
        sources,
        ...(record.capsule === undefined ? {} : { capsule: { id: record.capsule.id, bytes: record.capsule.bytes } }),
      });
      tokens += entry.tokenCount;
    }

    for (const recordIndex of touched) matchCounts[recordIndex] = 0;

    const gaps: RetrievalGap[] = sourceCoverage.gaps.map((gap) => ({ ...gap }));
    if (expiredRecordIds.length > 0) {
      gaps.push({
        kind: 'raw_source_expired',
        detail: `raw sources expired for ${expiredRecordIds.length} selected record(s)`,
        recordIds: expiredRecordIds,
      });
    }
    const coverage: RetrievalCoverage = {
      semantic: sourceCoverage.semantic,
      failedJobs: [...sourceCoverage.failedJobs],
      gaps,
    };

    return {
      query: request.query,
      asOf: new Date(requestedAsOfMs).toISOString(),
      historical,
      mode,
      items,
      tokens,
      denied,
      counters: {
        structuredCandidates,
        lexicalCandidates: lexicalList.length,
        embeddingCandidates,
        fusedCandidates: fusedScores.size,
        droppedForScope,
        deduplicated,
      },
      coverage,
    };
  }

  function citationIds(record: RetrievalRecord): string[] {
    if (record.sourceEventIds.length === 1 && record.sourceEventIds[0] === `evt-${record.id}`) {
      return [record.id];
    }
    return [...record.sourceEventIds];
  }

  async function answer(request: AnswerRequest): Promise<RetrievalAnswer> {
    const searchRequest: SearchRequest = { query: request.question };
    if (request.projectIds !== undefined) searchRequest.projectIds = request.projectIds;
    if (request.asOf !== undefined) searchRequest.asOf = request.asOf;
    if (request.timeRange !== undefined) searchRequest.timeRange = request.timeRange;
    if (request.entities !== undefined) searchRequest.entities = request.entities;
    if (request.mode !== undefined) searchRequest.mode = request.mode;
    if (request.limit !== undefined) searchRequest.limit = request.limit;
    const result = await search(searchRequest);
    const evidenceIds: string[] = [];
    for (const item of result.items) {
      const recordIndex = indexById.get(item.id);
      const record = recordIndex === undefined ? undefined : indexed[recordIndex]?.record;
      if (record === undefined) continue;
      for (const citation of citationIds(record)) {
        if (!evidenceIds.includes(citation)) evidenceIds.push(citation);
      }
    }
    const text = result.items.length === 0 ? NO_EVIDENCE_TEXT : result.items.map((item) => item.text).join(' ');
    return {
      ...result,
      text,
      supported: result.items.length > 0,
      evidenceIds,
    };
  }

  return {
    index,
    search,
    answer,
    async coverage(): Promise<RetrievalCoverage> {
      return copyCoverage(sourceCoverage);
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
