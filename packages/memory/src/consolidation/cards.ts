/**
 * Deterministic segment/session/project cards (§5.8 caps: 500 / 800 / 1200 tokens).
 *
 * Cards are pure functions of the persisted derived state, so duplicate jobs cannot rewrite them
 * and a restart reproduces byte-identical text. The project card leads with decisions so a bounded
 * truncation can never drop the decisions that ground a dated answer.
 */

import { boundCardText, type CardRecord, type DecisionRecord, type DurableConsolidationState, type FactRecord, type SegmentRecord } from './state.js';

export const SEGMENT_CARD_TOKENS = 500;
export const SESSION_CARD_TOKENS = 800;
export const PROJECT_CARD_TOKENS = 1200;
export const SESSION_GAP_MS = 30 * 60 * 1000;

function decisionLines(decisions: readonly DecisionRecord[]): string[] {
  return decisions.map((decision) => `- ${decision.question} -> ${decision.choice}`);
}

function factLines(facts: readonly FactRecord[]): string[] {
  return facts.map((fact) => `- ${fact.subject} ${fact.predicate} ${fact.object}`);
}

function occurredAtOf(segment: SegmentRecord, value: 'startedAt' | 'endedAt'): number {
  const parsed = Date.parse(segment[value]);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Contiguous runs of segments separated by a session-sized time gap, newest last. */
export function sessionWindows(segments: readonly SegmentRecord[]): SegmentRecord[][] {
  const windows: SegmentRecord[][] = [];
  let current: SegmentRecord[] = [];
  for (const segment of segments) {
    const previous = current[current.length - 1];
    if (previous !== undefined && occurredAtOf(segment, 'startedAt') - occurredAtOf(previous, 'endedAt') > SESSION_GAP_MS) {
      windows.push(current);
      current = [];
    }
    current.push(segment);
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

function buildSegmentCard(
  segments: readonly SegmentRecord[],
  projectId: string,
  count: (value: string) => number,
): string | undefined {
  const latest = segments[segments.length - 1];
  if (latest === undefined) return undefined;
  return boundCardText([
    `Segment memory card for ${projectId} (${latest.id}, ${latest.startedAt} -> ${latest.endedAt})`,
    `Summary: ${latest.summary}`,
    `Events: ${String(latest.eventIds.length)}`,
  ].join('\n'), SEGMENT_CARD_TOKENS, count);
}

function buildSessionCard(
  state: DurableConsolidationState,
  count: (value: string) => number,
): string | undefined {
  const windows = sessionWindows(state.segments);
  if (windows.length === 0) return undefined;
  // Prefer the newest session that actually carries a decision or fact.
  let chosen = windows[windows.length - 1];
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index];
    if (window === undefined) continue;
    const eventIds = new Set(window.flatMap((segment) => [...segment.eventIds]));
    const carriesRecords = [...state.decisions, ...state.facts].some(
      (record) => record.sourceEventIds.length > 0 && record.sourceEventIds.every((id) => eventIds.has(id)),
    );
    if (carriesRecords) {
      chosen = window;
      break;
    }
  }
  const window = chosen ?? [];
  const eventIds = new Set(window.flatMap((segment) => [...segment.eventIds]));
  const decisions = state.decisions.filter((record) => record.sourceEventIds.every((id) => eventIds.has(id)));
  const facts = state.facts.filter((record) => record.sourceEventIds.every((id) => eventIds.has(id)));
  const first = window[0];
  const last = window[window.length - 1];
  const lines = [
    `Session memory card for ${state.projectId} (${first?.startedAt ?? ''} -> ${last?.endedAt ?? ''})`,
    `Decisions (${String(decisions.length)}):`,
    ...decisionLines(decisions),
    `Facts (${String(facts.length)}):`,
    ...factLines(facts),
    `Segments: ${String(window.length)}`,
  ];
  return boundCardText(lines.join('\n'), SESSION_CARD_TOKENS, count);
}

function buildProjectCard(
  state: DurableConsolidationState,
  count: (value: string) => number,
): string | undefined {
  if (state.decisions.length === 0 && state.facts.length === 0 && state.segments.length === 0) return undefined;
  const lines = [
    `Project memory card for ${state.projectId}`,
    `Decisions (${String(state.decisions.length)}):`,
    ...decisionLines(state.decisions),
    `Facts (${String(state.facts.length)}):`,
    ...factLines(state.facts),
    `Segments consolidated: ${String(state.segments.length)}`,
    `Coverage: ${state.coverage.semantic}`,
  ];
  return boundCardText(lines.join('\n'), PROJECT_CARD_TOKENS, count);
}

/**
 * Cards are bounded with the tokenizer the context owner hands over, so a 500/800/1,200-token
 * card is measured in the same tokens the bounded request will be charged.
 */
export function buildCards(
  state: DurableConsolidationState,
  count?: (value: string) => number,
): CardRecord {
  const measure = count ?? ((value: string) => value.split(/\s+/).filter((word) => word.length > 0).length);
  const cards: CardRecord = {};
  const segment = buildSegmentCard(state.segments, state.projectId, measure);
  if (segment !== undefined) cards.segment = segment;
  const session = buildSessionCard(state, measure);
  if (session !== undefined) cards.session = session;
  const project = buildProjectCard(state, measure);
  if (project !== undefined) cards.project = project;
  return cards;
}
