/**
 * M02 memory consolidator — live event batch → local extraction → bounded context → grounded answer.
 *
 * The M01 store holds the raw log; this module turns it into durable, restartable memory: segment
 * extraction jobs run through the F01 Reasoner contract with the context module's AssembledContext
 * as their bounded second argument, structured facts/decisions and the three card levels are
 * persisted next to the store, and answers are grounded in that consolidated state instead of
 * rereading the raw log.
 *
 * Failure behavior (§5.8 / ticket M02): invalid JSON gets its one repair attempt, a model crash or a
 * failed repair falls back to the deterministic local extraction, semantic coverage becomes
 * `partial`, and repeated calls over unchanged state return identical results across a restart.
 */

import {
  boundedBudget,
  type AssembledContext,
  type AssembleRequest,
  type ContextAssembler,
  type EvidenceItem,
  type ModelDescriptor,
} from '../context/index.js';
import type { MemoryStore, TimelineItem } from '../store/index.js';
import { buildCards } from './cards.js';
import {
  ANSWER_INSTRUCTION,
  ANSWER_SCHEMA,
  EXTRACTION_INSTRUCTION,
  EXTRACTION_SCHEMA,
  MEMORY_TOOL,
  deterministicDecision,
  deterministicFact,
  deterministicSegmentSummary,
  isEventCapsule,
  normalizeAnswer,
  normalizeExtraction,
  parseJsonObject,
  segmentTimeline,
  type ExtractionOutput,
  type SegmentPlan,
} from './extraction.js';
import {
  checkpointOf,
  cloneCoverage,
  loadState,
  saveState,
  sourceKey,
  stableHash,
  type CoverageRecord,
  type DecisionRecord,
  type DurableConsolidationState,
  type FactRecord,
} from './state.js';

export const ANSWER_EVIDENCE_LIMIT = 32;

export interface ReasoningTask {
  readonly taskId: string;
  readonly instruction: string;
}

/**
 * The F01 Reasoner contract as this feature consumes it: the second argument is always the context
 * module's AssembledContext, so every request carries its measured accounting and can be checked
 * against B.
 */
export interface ReasonerContract {
  run(
    task: ReasoningTask,
    boundedContext: AssembledContext,
    outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown>;
}

export interface MemoryConsolidatorOptions {
  projectId: string;
  directory: string;
  store: MemoryStore;
  reasoner: ReasonerContract;
  assembler: ContextAssembler;
  model: ModelDescriptor;
}

export interface ConsolidationCoverage {
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
}

export interface ConsolidationResult {
  checkpoint: string;
  coverage: ConsolidationCoverage;
}

export interface GroundedAnswer {
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
  coverage: ConsolidationCoverage;
  maxTokens: number;
  usedTokens: number;
}

export interface MemoryConsolidator {
  consolidate(): Promise<ConsolidationResult>;
  facts(): Promise<readonly FactRecord[]>;
  decisions(): Promise<readonly DecisionRecord[]>;
  card(level: 'segment' | 'session' | 'project'): Promise<string | undefined>;
  coverage(): Promise<ConsolidationCoverage>;
  answer(request: { question: string }): Promise<GroundedAnswer>;
  close(): Promise<void>;
}

interface SegmentRun {
  output: ExtractionOutput;
  ok: boolean;
}

function upsertDecision(state: DurableConsolidationState, record: DecisionRecord): void {
  const key = sourceKey(record.sourceEventIds);
  const existing = state.decisions.some(
    (entry) => entry.id === record.id || (key.length > 0 && sourceKey(entry.sourceEventIds) === key),
  );
  if (!existing) state.decisions.push(record);
}

function upsertFact(state: DurableConsolidationState, record: FactRecord): void {
  const key = sourceKey(record.sourceEventIds);
  const existing = state.facts.some(
    (entry) => entry.id === record.id
      || (key.length > 0 && sourceKey(entry.sourceEventIds) === key && entry.predicate === record.predicate),
  );
  if (!existing) state.facts.push(record);
}

function occurredAtFor(state: DurableConsolidationState, eventId: string): string | undefined {
  for (const segment of state.segments) {
    if (segment.eventIds.includes(eventId)) return segment.startedAt;
  }
  return undefined;
}

export async function createMemoryConsolidator(options: MemoryConsolidatorOptions): Promise<MemoryConsolidator> {
  const projectId = typeof options?.projectId === 'string' ? options.projectId.trim() : '';
  if (projectId.length === 0) throw new TypeError('createMemoryConsolidator requires a projectId');
  const directory = typeof options?.directory === 'string' ? options.directory : '';
  if (directory.length === 0) throw new TypeError('createMemoryConsolidator requires a durable directory');
  const store = options?.store;
  if (store === undefined || typeof store.timeline !== 'function' || typeof store.durableCursor !== 'function') {
    throw new TypeError('createMemoryConsolidator requires the M01 MemoryStore');
  }
  const reasoner = options?.reasoner;
  if (reasoner === undefined || typeof reasoner.run !== 'function') {
    throw new TypeError('createMemoryConsolidator requires a Reasoner with run(task, boundedContext, outputSchema, signal)');
  }
  const assembler = options?.assembler;
  if (assembler === undefined || typeof assembler.assemble !== 'function') {
    throw new TypeError('createMemoryConsolidator requires the shared context assembler');
  }
  // Rejects a model without a declared, positive, finite capacity before any work happens.
  boundedBudget(options.model);

  const state = await loadState(directory, projectId);
  const processed = new Set(state.processedEventIds);
  const signal = new AbortController().signal;

  const runReasoner = async (
    task: ReasoningTask,
    bounded: AssembledContext,
    schema: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => reasoner.run(task, bounded, schema, signal);

  /** One live segment job: model extraction with its single repair attempt, else a recorded failure. */
  const extractSegment = async (segment: SegmentPlan): Promise<SegmentRun> => {
    const evidence: EvidenceItem[] = segment.items.map((item) => ({ id: item.id, text: item.summary }));
    const assembled = await assembler.assemble({
      model: options.model,
      instruction: EXTRACTION_INSTRUCTION,
      request: `Extract structured memory from segment ${segment.id} of ${projectId} `
        + `(${String(segment.items.length)} events, ${segment.startedAt} -> ${segment.endedAt}).`,
      evidence,
      tools: [MEMORY_TOOL],
    });
    const taskId = `memory.extraction.${projectId}.${segment.id}`;
    const task: ReasoningTask = { taskId, instruction: EXTRACTION_INSTRUCTION };
    let raw: unknown;
    try {
      raw = await runReasoner(task, assembled, EXTRACTION_SCHEMA);
    } catch {
      return { output: { decisions: [], facts: [] }, ok: false };
    }
    let parsed = parseJsonObject(raw);
    if (parsed === undefined) {
      // Failed JSON gets exactly one repair attempt against the same bounded context.
      try {
        raw = await runReasoner(
          { taskId: `${taskId}.repair`, instruction: `${EXTRACTION_INSTRUCTION} The previous reply was not valid JSON; reply with the JSON object only.` },
          assembled,
          EXTRACTION_SCHEMA,
        );
      } catch {
        return { output: { decisions: [], facts: [] }, ok: false };
      }
      parsed = parseJsonObject(raw);
    }
    if (parsed === undefined) return { output: { decisions: [], facts: [] }, ok: false };
    const normalized = normalizeExtraction(parsed, assembled.evidenceIds);
    if (normalized === undefined) return { output: { decisions: [], facts: [] }, ok: false };
    return { output: normalized, ok: true };
  };

  const mergeSegment = (segment: SegmentPlan, run: SegmentRun): void => {
    for (const decision of run.output.decisions) upsertDecision(state, decision);
    for (const fact of run.output.facts) upsertFact(state, fact);
    // Deterministic local extraction always keeps recorded decisions, model or not.
    for (const item of segment.items) {
      const decision = deterministicDecision(item);
      if (decision !== undefined) upsertDecision(state, decision);
    }
    if (!run.ok) {
      for (const item of segment.items) {
        const fact = deterministicFact(item, projectId);
        if (fact !== undefined) upsertFact(state, fact);
      }
    }
    state.segments.push({
      id: segment.id,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      eventIds: segment.items.map((item) => item.id),
      summary: run.output.summary ?? deterministicSegmentSummary(segment.items, projectId),
      derivedFromModel: run.ok,
    });
  };

  const buildAnswerEvidence = (): EvidenceItem[] => {
    const evidence: EvidenceItem[] = [];
    for (const decision of state.decisions) {
      const id = decision.sourceEventIds[0] ?? decision.id;
      evidence.push({ id, text: `Decision: ${decision.question} ${decision.choice}` });
    }
    for (const fact of state.facts) {
      const id = fact.sourceEventIds[0] ?? fact.id;
      evidence.push({ id, text: `Fact: ${fact.subject} ${fact.predicate} ${fact.object}` });
    }
    return evidence.slice(0, ANSWER_EVIDENCE_LIMIT);
  };

  const deterministicAnswer = (
    question: string,
  ): { text: string; supported: boolean; evidenceIds: readonly string[] } => {
    const decisions = state.decisions.slice(0, 3);
    const facts = state.facts.slice(0, 3);
    if (decisions.length === 0 && facts.length === 0) {
      return {
        text: `No consolidated project memory is available yet, so "${question}" cannot be answered from evidence.`,
        supported: false,
        evidenceIds: [],
      };
    }
    const parts: string[] = [];
    const evidenceIds: string[] = [];
    for (const decision of decisions) {
      const date = occurredAtFor(state, decision.sourceEventIds[0] ?? '') ?? 'an earlier session';
      parts.push(`On ${date} the project decided: ${decision.question} — ${decision.choice}`);
      for (const id of decision.sourceEventIds) evidenceIds.push(id);
    }
    for (const fact of facts) {
      parts.push(`Recorded fact: ${fact.subject} ${fact.predicate} ${fact.object}`);
      for (const id of fact.sourceEventIds) evidenceIds.push(id);
    }
    return {
      text: `From consolidated project memory for ${projectId}: ${parts.join(' ')}`,
      supported: true,
      evidenceIds: [...new Set(evidenceIds)],
    };
  };

  const consolidator: MemoryConsolidator = {
    async consolidate(): Promise<ConsolidationResult> {
      const cursor = await store.durableCursor();
      if (state.watermark === cursor) {
        return { checkpoint: checkpointOf(state), coverage: cloneCoverage(state.coverage) };
      }
      const timeline = await store.timeline({ projectId });
      const fresh = timeline.filter((item) => isEventCapsule(item) && !processed.has(item.id));
      if (fresh.length === 0) {
        state.watermark = cursor;
        await saveState(directory, state);
        return { checkpoint: checkpointOf(state), coverage: cloneCoverage(state.coverage) };
      }
      const segments = segmentTimeline(fresh);
      const failed: string[] = [];
      for (const segment of segments) {
        const run = await extractSegment(segment);
        if (!run.ok) failed.push(segment.id);
        mergeSegment(segment, run);
      }
      for (const item of fresh) {
        processed.add(item.id);
        state.processedEventIds.push(item.id);
      }
      state.watermark = cursor;
      if (failed.length > 0) {
        state.coverage = {
          semantic: 'partial',
          failedJobs: [...state.coverage.failedJobs, ...failed.filter((id) => !state.coverage.failedJobs.includes(id))],
        };
      }
      state.cards = buildCards(state);
      await saveState(directory, state);
      return { checkpoint: checkpointOf(state), coverage: cloneCoverage(state.coverage) };
    },

    async facts(): Promise<readonly FactRecord[]> {
      return state.facts.map((fact) => ({ ...fact, sourceEventIds: [...fact.sourceEventIds] }));
    },

    async decisions(): Promise<readonly DecisionRecord[]> {
      return state.decisions.map((decision) => ({ ...decision, sourceEventIds: [...decision.sourceEventIds] }));
    },

    async card(level: 'segment' | 'session' | 'project'): Promise<string | undefined> {
      if (level === 'segment') return state.cards.segment;
      if (level === 'session') return state.cards.session;
      if (level === 'project') return state.cards.project;
      throw new TypeError(`unknown card level: ${String(level)}`);
    },

    async coverage(): Promise<ConsolidationCoverage> {
      return cloneCoverage(state.coverage);
    },

    async answer({ question }: { question: string }): Promise<GroundedAnswer> {
      const asked = typeof question === 'string' ? question.trim() : '';
      if (asked.length === 0) throw new TypeError('answer requires a question');
      const evidence = buildAnswerEvidence();
      const assembleRequest: AssembleRequest = {
        model: options.model,
        instruction: ANSWER_INSTRUCTION,
        request: asked,
        evidence,
        tools: [MEMORY_TOOL],
      };
      const card = state.cards.project;
      if (card !== undefined) assembleRequest.card = card;
      const assembled = await assembler.assemble(assembleRequest);
      let draft: { text: string; evidenceIds: readonly string[] } | undefined;
      if (evidence.length > 0) {
        const taskId = `memory.answer.${projectId}.${stableHash(asked)}`;
        const task: ReasoningTask = { taskId, instruction: ANSWER_INSTRUCTION };
        let raw: unknown;
        try {
          raw = await runReasoner(task, assembled, ANSWER_SCHEMA);
        } catch {
          raw = undefined;
        }
        let parsed = parseJsonObject(raw);
        if (parsed === undefined) {
          try {
            raw = await runReasoner(
              { taskId: `${taskId}.repair`, instruction: `${ANSWER_INSTRUCTION} The previous reply was not valid JSON; reply with the JSON object only.` },
              assembled,
              ANSWER_SCHEMA,
            );
          } catch {
            raw = undefined;
          }
          parsed = parseJsonObject(raw);
        }
        draft = normalizeAnswer(parsed, assembled.evidenceIds);
      }
      if (draft !== undefined) {
        return {
          text: draft.text,
          supported: true,
          evidenceIds: draft.evidenceIds,
          coverage: cloneCoverage(state.coverage),
          maxTokens: assembled.maxTokens,
          usedTokens: assembled.totalTokens,
        };
      }
      // Unparseable, empty, or ungrounded model output is never returned: the deterministic
      // evidence-backed template takes over.
      const fallback = deterministicAnswer(asked);
      return {
        text: fallback.text,
        supported: fallback.supported,
        evidenceIds: fallback.evidenceIds,
        coverage: cloneCoverage(state.coverage),
        maxTokens: assembled.maxTokens,
        usedTokens: assembled.totalTokens,
      };
    },

    async close(): Promise<void> {
      // Derived state is persisted eagerly; closing needs no flush of its own.
    },
  };

  return consolidator;
}

export type {
  DecisionRecord,
  FactRecord,
  CoverageRecord,
  DurableConsolidationState,
  SegmentPlan,
  TimelineItem,
  ExtractionOutput,
};
