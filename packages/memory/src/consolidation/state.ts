/**
 * Durable consolidation state (M02).
 *
 * The M01 store owns the raw log; this module owns the *derived* state that makes an answer
 * possible after a restart without rereading that log: extracted facts/decisions, the
 * segment/session/project cards, semantic coverage, and the consolidation watermark.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FactRecord {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  status: string;
  sourceEventIds: readonly string[];
}

export interface DecisionRecord {
  id: string;
  question: string;
  choice: string;
  status: string;
  sourceEventIds: readonly string[];
}

export interface SegmentRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  eventIds: readonly string[];
  summary: string;
  derivedFromModel: boolean;
}

export interface CoverageRecord {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
}

export interface CardRecord {
  segment?: string;
  session?: string;
  project?: string;
}

export interface DurableConsolidationState {
  version: 1;
  projectId: string;
  /** Durable store cursor observed at the end of the last consolidation. */
  watermark: string | null;
  /** Source event ids already folded into the derived state (newest last). */
  processedEventIds: string[];
  segments: SegmentRecord[];
  facts: FactRecord[];
  decisions: DecisionRecord[];
  cards: CardRecord;
  coverage: CoverageRecord;
}

export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function sourceKey(sourceEventIds: readonly string[]): string {
  return [...sourceEventIds].sort().join('|');
}

export function emptyState(projectId: string): DurableConsolidationState {
  return {
    version: 1,
    projectId,
    watermark: null,
    processedEventIds: [],
    segments: [],
    facts: [],
    decisions: [],
    cards: {},
    coverage: { semantic: 'complete', failedJobs: [] },
  };
}

export function statePath(directory: string, projectId: string): string {
  return join(directory, 'consolidation', `${encodeURIComponent(projectId)}.m02.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeState(value: unknown, projectId: string): DurableConsolidationState {
  if (!isRecord(value) || value.version !== 1 || value.projectId !== projectId) {
    throw new Error(`memory consolidation state for ${projectId} is not a supported v1 state file`);
  }
  const state = emptyState(projectId);
  state.watermark = typeof value.watermark === 'string' ? value.watermark : null;
  state.processedEventIds = stringArray(value.processedEventIds);
  state.segments = Array.isArray(value.segments)
    ? value.segments.filter(isRecord).map((segment) => ({
      id: String(segment.id),
      startedAt: typeof segment.startedAt === 'string' ? segment.startedAt : '',
      endedAt: typeof segment.endedAt === 'string' ? segment.endedAt : '',
      eventIds: stringArray(segment.eventIds),
      summary: typeof segment.summary === 'string' ? segment.summary : '',
      derivedFromModel: segment.derivedFromModel === true,
    }))
    : [];
  state.facts = Array.isArray(value.facts)
    ? value.facts.filter(isRecord).map((fact) => ({
      id: String(fact.id),
      subject: String(fact.subject),
      predicate: String(fact.predicate),
      object: String(fact.object),
      status: typeof fact.status === 'string' ? fact.status : 'active',
      sourceEventIds: stringArray(fact.sourceEventIds),
    }))
    : [];
  state.decisions = Array.isArray(value.decisions)
    ? value.decisions.filter(isRecord).map((decision) => ({
      id: String(decision.id),
      question: String(decision.question),
      choice: String(decision.choice),
      status: typeof decision.status === 'string' ? decision.status : 'active',
      sourceEventIds: stringArray(decision.sourceEventIds),
    }))
    : [];
  state.cards = isRecord(value.cards)
    ? {
      ...(typeof value.cards.segment === 'string' ? { segment: value.cards.segment } : {}),
      ...(typeof value.cards.session === 'string' ? { session: value.cards.session } : {}),
      ...(typeof value.cards.project === 'string' ? { project: value.cards.project } : {}),
    }
    : {};
  state.coverage = isRecord(value.coverage)
    ? {
      semantic: value.coverage.semantic === 'partial' ? 'partial' : 'complete',
      failedJobs: stringArray(value.coverage.failedJobs),
    }
    : { semantic: 'complete', failedJobs: [] };
  return state;
}

export async function loadState(directory: string, projectId: string): Promise<DurableConsolidationState> {
  const path = statePath(directory, projectId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return emptyState(projectId);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`memory consolidation state for ${projectId} is corrupt (invalid JSON)`);
  }
  return normalizeState(parsed, projectId);
}

/** Atomic write: a crash mid-save can never leave a half-written state file behind. */
export async function saveState(directory: string, state: DurableConsolidationState): Promise<void> {
  const path = statePath(directory, state.projectId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export function checkpointOf(state: DurableConsolidationState): string {
  const last = state.processedEventIds[state.processedEventIds.length - 1] ?? 'empty';
  return `m02:${String(state.processedEventIds.length)}:${last}`;
}

export function cloneCoverage(coverage: CoverageRecord): CoverageRecord {
  return { semantic: coverage.semantic, failedJobs: [...coverage.failedJobs] };
}

/**
 * Deterministic token bound for the §5.8 cards. Word counting is exact for whitespace
 * tokenizers and a lower bound for BPE tokenizers, so a bounded card never exceeds its allowance.
 */
export function boundCardText(text: string, maxTokens: number): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= maxTokens) return text;
  return `${words.slice(0, Math.max(1, maxTokens - 1)).join(' ')} …`;
}
