/**
 * Live segment extraction for M02.
 *
 * The store's timeline is the raw log: each capsule summary is a pure function of the stored event
 * and its payload, and the capsule id is the source event id. Segments chunk that log into pieces
 * that fit the shared bounded context, and every extraction request travels through the Reasoner
 * contract with the measured AssembledContext as its second argument.
 */

import type { TimelineItem } from '../store/index.js';
import { sourceKey, stableHash, type DecisionRecord, type FactRecord } from './state.js';

/** Segment packing: bounded event count and a conservative word budget per request. */
export const SEGMENT_MAX_EVENTS = 32;
export const SEGMENT_MAX_WORDS = 1400;

export interface SegmentPlan {
  id: string;
  startedAt: string;
  endedAt: string;
  items: TimelineItem[];
}

export interface ExtractionOutput {
  decisions: DecisionRecord[];
  facts: FactRecord[];
  summary?: string;
}

export const EXTRACTION_INSTRUCTION = [
  'You are the EchoPilot memory extractor.',
  'Read the bounded evidence for one live segment of a project session and return structured memory.',
  'Only cite source event ids that appear in the provided evidence; never invent ids or text.',
  'Return decisions only for recorded decisions and facts only for durable project facts.',
].join(' ');

export const ANSWER_INSTRUCTION = [
  'You are the EchoPilot project memory answerer.',
  'Answer the dated project question using only the bounded evidence bundle and the project card.',
  'Cite the evidence ids you used and never cite an id that was not presented.',
  'If the evidence does not support an answer, say so instead of guessing.',
].join(' ');

export const EXTRACTION_SCHEMA: Readonly<Record<string, unknown>> = {
  title: 'memory.extraction',
  type: 'object',
  additionalProperties: false,
  required: ['decisions', 'facts', 'summary'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'choice', 'sourceEventIds'],
        properties: {
          question: { type: 'string' },
          choice: { type: 'string' },
          status: { type: 'string', enum: ['active', 'superseded'] },
          sourceEventIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['subject', 'predicate', 'object', 'sourceEventIds'],
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          status: { type: 'string', enum: ['active', 'superseded'] },
          sourceEventIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string' },
  },
};

export const ANSWER_SCHEMA: Readonly<Record<string, unknown>> = {
  title: 'memory.answer',
  type: 'object',
  additionalProperties: false,
  required: ['text', 'evidenceIds'],
  properties: {
    text: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
  },
};

export const MEMORY_TOOL = {
  name: 'memory_query',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['projectId'],
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

export function isEventCapsule(item: TimelineItem): boolean {
  return item.kind !== 'task';
}

/** Deterministic chunking: same log in, same segments out, every request inside the segment bound. */
export function segmentTimeline(items: readonly TimelineItem[]): SegmentPlan[] {
  const segments: SegmentPlan[] = [];
  let current: TimelineItem[] = [];
  let currentWords = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    segments.push({
      id: `seg-${stableHash(`${first.id}|${last.id}|${String(current.length)}`)}`,
      startedAt: first.occurredAt,
      endedAt: last.occurredAt,
      items: current,
    });
    current = [];
    currentWords = 0;
  };
  for (const item of items) {
    const itemWords = wordCount(item.summary);
    if (
      current.length > 0
      && (current.length >= SEGMENT_MAX_EVENTS || currentWords + itemWords > SEGMENT_MAX_WORDS)
    ) {
      flush();
    }
    current.push(item);
    currentWords += itemWords;
  }
  flush();
  return segments;
}

/** The store's capsule summary for a decision is `question — choice` (§5.8 show-your-work). */
export function splitDecisionSummary(summary: string): { question: string; choice: string } {
  const separator = summary.indexOf(' — ');
  if (separator <= 0) return { question: 'Decision', choice: summary.trim() };
  const question = summary.slice(0, separator).trim();
  const choice = summary.slice(separator + 3).trim();
  if (question.length === 0 || choice.length === 0) return { question: 'Decision', choice: summary.trim() };
  return { question, choice };
}

/** Deterministic local extraction: recorded decision events become decisions without the model. */
export function deterministicDecision(item: TimelineItem): DecisionRecord | undefined {
  if (item.kind !== 'decision') return undefined;
  const { question, choice } = splitDecisionSummary(item.summary);
  return {
    id: `dec-${stableHash(`${question}|${choice}|${item.id}`)}`,
    question,
    choice,
    status: 'active',
    sourceEventIds: [item.id],
  };
}

/** Deterministic fallback fact, derived from a recorded decision, when extraction could not run. */
export function deterministicFact(item: TimelineItem, projectId: string): FactRecord | undefined {
  if (item.kind !== 'decision') return undefined;
  const { question, choice } = splitDecisionSummary(item.summary);
  return {
    id: `fact-${stableHash(`${projectId}|decision|${choice}|${item.id}`)}`,
    subject: projectId,
    predicate: 'decision',
    object: choice.length > 0 ? `${question} -> ${choice}` : question,
    status: 'active',
    sourceEventIds: [item.id],
  };
}

export function deterministicSegmentSummary(items: readonly TimelineItem[], projectId: string): string {
  const decisions = items.filter((item) => item.kind === 'decision').length;
  const tools = items.filter((item) => item.kind === 'tool_completed' || item.kind === 'tool_started').length;
  const first = items[0];
  const last = items[items.length - 1];
  return [
    `Segment of ${String(items.length)} events for ${projectId}`,
    first !== undefined && last !== undefined ? `from ${first.occurredAt} to ${last.occurredAt}` : '',
    `with ${String(decisions)} recorded decision(s) and ${String(tools)} tool receipt(s).`,
  ].filter((part) => part.length > 0).join(' ');
}

/** Model output may arrive parsed or as raw text; invalid JSON stays invalid after one repair. */
export function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/**
 * Normalizes model extraction output. Records citing evidence that was not presented in the
 * bounded context are dropped: the model can only ground what it was actually shown.
 */
export function normalizeExtraction(
  parsed: Record<string, unknown>,
  presentedEvidenceIds: readonly string[],
): ExtractionOutput | undefined {
  const decisionsRaw = parsed.decisions;
  const factsRaw = parsed.facts;
  if (!Array.isArray(decisionsRaw) || !Array.isArray(factsRaw)) return undefined;
  const presented = new Set(presentedEvidenceIds);
  const cited = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (ids.length === 0 || !ids.every((id) => presented.has(id))) return undefined;
    return ids;
  };
  const decisions: DecisionRecord[] = [];
  for (const entry of decisionsRaw) {
    if (!isRecord(entry)) continue;
    const question = textOf(entry.question);
    const choice = textOf(entry.choice);
    const sourceEventIds = cited(entry.sourceEventIds);
    if (question === undefined || choice === undefined || sourceEventIds === undefined) continue;
    decisions.push({
      id: `dec-${stableHash(`${question}|${choice}|${sourceKey(sourceEventIds)}`)}`,
      question,
      choice,
      status: entry.status === 'superseded' ? 'superseded' : 'active',
      sourceEventIds,
    });
  }
  const facts: FactRecord[] = [];
  for (const entry of factsRaw) {
    if (!isRecord(entry)) continue;
    const subject = textOf(entry.subject);
    const predicate = textOf(entry.predicate);
    const object = textOf(entry.object);
    const sourceEventIds = cited(entry.sourceEventIds);
    if (subject === undefined || predicate === undefined || object === undefined || sourceEventIds === undefined) continue;
    facts.push({
      id: `fact-${stableHash(`${subject}|${predicate}|${object}|${sourceKey(sourceEventIds)}`)}`,
      subject,
      predicate,
      object,
      status: entry.status === 'superseded' ? 'superseded' : 'active',
      sourceEventIds,
    });
  }
  const summary = textOf(parsed.summary);
  return summary === undefined ? { decisions, facts } : { decisions, facts, summary };
}

export interface AnswerDraft {
  text: string;
  evidenceIds: string[];
}

/** Model answer output, rejected wholesale when it is unparseable, empty, or ungrounded. */
export function normalizeAnswer(
  parsed: Record<string, unknown> | undefined,
  presentedEvidenceIds: readonly string[],
): AnswerDraft | undefined {
  if (parsed === undefined) return undefined;
  const text = textOf(parsed.text);
  if (text === undefined) return undefined;
  const evidenceRaw = parsed.evidenceIds;
  if (!Array.isArray(evidenceRaw)) return undefined;
  const presented = new Set(presentedEvidenceIds);
  const evidenceIds = evidenceRaw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (evidenceIds.length === 0) return undefined;
  if (!evidenceIds.every((id) => presented.has(id))) return undefined;
  return { text, evidenceIds };
}
