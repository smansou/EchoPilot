/**
 * M04 memory records — inspect or correct a memory, then answer from the updated temporal state.
 *
 * Every answer this module returns is assembled from displayed summaries, never from a fresh model
 * call: a request selects the summaries that reference its question (a decision's question, a fact's
 * subject, an observed task's id), keeps the ones valid at the requested instant, and reports their
 * text, their raw source ids, the ids of disputed claims that bear on the question, the extraction
 * version, and the source's coverage — including `partial` with the failed jobs behind it.
 *
 * Two invariants make the temporal behavior real:
 *
 *   - A reversal is a *new explicit user decision event* ingested into the M01 store (trust
 *     `user_explicit`); the replaced record keeps its own interval and is displayed as `superseded`,
 *     so an `asOf` inside that interval still returns the historical answer unchanged, while the
 *     current answer reports the correction. Reopening the store and records reproduces both.
 *   - A derived claim that collides with stronger evidence (same subject+predicate, same decision
 *     question, or a subject equal to an observed task id) is `disputed`: it stays inspectable, it is
 *     named in `conflicts`, and it is never cited as evidence — so an agent narration can never
 *     overwrite a user-confirmed fact or an observed tool receipt.
 *
 * Record ids are the derived claim ids (or the task id) that the source and the M01 reduction
 * already use; a correction gets `<decisionId>#revision-<n>`.
 */
import { stableDigest, stableHash, RecordsStateStore, type CorrectionRecord, type RecordsStateView } from './state.js';
import { bearsOnQuestion, normalizeKey } from './matching.js';
import { buildSummaries, type CapsuleView, type TaskView } from './summaries.js';
import {
  copyCoverage,
  type CreateMemoryRecordsOptions,
  type DerivedFactClaim,
  type DerivedDecisionClaim,
  type DerivedMemorySource,
  type MemoryCoverage,
  type MemoryRecords,
  type MemorySummary,
  type ReviseDecisionRequest,
  type TemporalAnswer,
} from './model.js';
import type { MemoryStore, TimelineItem } from '../store/index.js';
import type { NormalizedEvent } from '../store/types.js';

export * from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(message);
  return value;
}

function parseInstant(value: unknown, label: string): string {
  const text = requireText(value, `${label} must be a non-empty ISO instant`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new TypeError(`${label} is not a valid instant: ${text}`);
  return new Date(ms).toISOString();
}

function isValidAt(summary: MemorySummary, asOf: string): boolean {
  const start = Date.parse(summary.validFrom);
  const at = Date.parse(asOf);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return false;
  const end = summary.validTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(summary.validTo);
  return start <= at && at < end;
}

/**
 * The M01 store validates every ingested envelope against its own profile identity, and its public
 * `MemoryStore` contract does not expose that identity. The records layer therefore reads the field
 * the store already owns and validates against, and fails loudly instead of guessing if a future
 * store stops exposing it: a correction must never be ingested under the wrong profile.
 */
function profileIdOf(store: MemoryStore): string {
  const candidate = (store as unknown as { readonly profileId?: unknown }).profileId;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error('createMemoryRecords cannot determine the profile identity of this M01 memory store');
  }
  return candidate;
}

function splitTimeline(items: readonly TimelineItem[]): { capsules: Map<string, CapsuleView>; tasks: TaskView[] } {
  const capsules = new Map<string, CapsuleView>();
  const tasks: TaskView[] = [];
  for (const item of items) {
    const sourceEventIds = Array.isArray(item.sourceEventIds) ? item.sourceEventIds.map((value) => String(value)) : [];
    const isCapsule = sourceEventIds.length === 1 && sourceEventIds[0] === item.id;
    if (isCapsule) {
      capsules.set(item.id, {
        kind: typeof item.kind === 'string' ? item.kind : '',
        trust: typeof item.trust === 'string' ? item.trust : '',
        occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
        summary: typeof item.summary === 'string' ? item.summary : '',
      });
      continue;
    }
    if (item.kind === 'task') {
      tasks.push({
        id: item.id,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        summary: typeof item.summary === 'string' ? item.summary : '',
        sourceEventIds,
      });
    }
  }
  return { capsules, tasks };
}

interface CorrectionEventInput {
  projectId: string;
  profileId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  question: string;
  choice: string;
  rationale?: string;
}

function correctionEvent(input: CorrectionEventInput): { event: NormalizedEvent; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {
    question: input.question,
    choice: input.choice,
    decidingActor: 'user',
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    correctionOf: input.eventId,
  };
  const event: NormalizedEvent = {
    schemaVersion: 1,
    eventId: input.eventId,
    sourceId: 'records:m04',
    sourceEventId: stableHash(`${input.projectId}|${input.eventId}`),
    sourceSequence: input.sequence,
    ingestSequence: input.sequence,
    occurredAt: input.occurredAt,
    observedAt: new Date().toISOString(),
    scope: { profileId: input.profileId, projectId: input.projectId, sensitivity: 'normal' },
    kind: 'decision',
    payloadRef: `records:m04://${encodeURIComponent(input.projectId)}/correction/${input.eventId}`,
    contentHash: `sha256:${stableDigest(JSON.stringify(payload))}`,
    trust: 'user_explicit',
  };
  return { event, payload };
}

export async function createMemoryRecords(options: CreateMemoryRecordsOptions): Promise<MemoryRecords> {
  if (!isRecord(options)) {
    throw new TypeError('createMemoryRecords requires { projectId, directory, store, source, extractionVersion }');
  }
  const projectId = requireText(options.projectId, 'createMemoryRecords requires a projectId');
  const directory = requireText(options.directory, 'createMemoryRecords requires a durable directory');
  const extractionVersion = requireText(
    options.extractionVersion,
    'createMemoryRecords requires a non-empty extractionVersion: every summary must reveal it',
  );
  const store = options.store as MemoryStore;
  if (typeof store?.ingest !== 'function' || typeof store?.timeline !== 'function') {
    throw new TypeError('createMemoryRecords requires the M01 MemoryStore');
  }
  const source = options.source as DerivedMemorySource;
  if (typeof source?.facts !== 'function' || typeof source?.decisions !== 'function' || typeof source?.coverage !== 'function') {
    throw new TypeError('createMemoryRecords requires a derived-record source with facts(), decisions(), coverage()');
  }
  const profileId = profileIdOf(store);
  const durable = new RecordsStateStore(directory, projectId, extractionVersion);
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error('memory records are closed');
  }

  async function readDerived(): Promise<{
    facts: readonly DerivedFactClaim[];
    decisions: readonly DerivedDecisionClaim[];
    coverage: MemoryCoverage;
  }> {
    const [facts, decisions, coverage] = await Promise.all([source.facts(), source.decisions(), source.coverage()]);
    return { facts, decisions, coverage };
  }

  async function buildFrom(state: RecordsStateView): Promise<{
    summaries: readonly MemorySummary[];
    firstSeen: Readonly<Record<string, string>>;
  }> {
    const [timeline, derived] = await Promise.all([store.timeline({ projectId }), readDerived()]);
    const { capsules, tasks } = splitTimeline(timeline);
    return buildSummaries({
      facts: derived.facts,
      decisions: derived.decisions,
      tasks,
      capsules,
      corrections: state.corrections,
      coverage: derived.coverage,
      extractionVersion,
      firstSeenAt: state.firstSeenAt,
      now: new Date().toISOString(),
    });
  }

  /**
   * Records whose raw source is gone have no recoverable time, so the first display anchors them;
   * the anchor is persisted and the rows are rebuilt from it, which keeps `validFrom` stable across
   * calls and restarts instead of drifting with the clock.
   */
  async function collectSummaries(): Promise<readonly MemorySummary[]> {
    assertOpen();
    const state = await durable.snapshot();
    const first = await buildFrom(state);
    if (Object.keys(first.firstSeen).length === 0) return first.summaries;
    await durable.mutate((mutable) => {
      for (const [id, at] of Object.entries(first.firstSeen)) {
        if (mutable.firstSeenAt[id] === undefined) mutable.firstSeenAt[id] = at;
      }
    });
    return (await buildFrom(await durable.snapshot())).summaries;
  }

  async function summaries(): Promise<readonly MemorySummary[]> {
    return collectSummaries();
  }

  async function summary(id: string): Promise<MemorySummary | undefined> {
    assertOpen();
    const wanted = requireText(id, 'summary requires a record id');
    const rows = await collectSummaries();
    return rows.find((row) => row.id === wanted);
  }

  async function answer(request: { question: string; asOf?: string }): Promise<TemporalAnswer> {
    assertOpen();
    const asked = requireText(isRecord(request) ? request.question : undefined, 'answer requires a question').trim();
    const asOf = request.asOf === undefined ? new Date().toISOString() : parseInstant(request.asOf, 'answer asOf');
    const rows = await collectSummaries();
    const bearing = rows.filter((row) => {
      const key = row.kind === 'decision' ? row.question : row.subject;
      return bearsOnQuestion(asked, [key]);
    });
    const conflicts = bearing
      .filter((row) => row.status === 'disputed')
      .map((row) => row.id)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const reported = bearing.filter((row) => row.status !== 'disputed' && isValidAt(row, asOf));
    const evidenceIds: string[] = [];
    for (const row of reported) {
      for (const sourceId of row.sources) if (!evidenceIds.includes(sourceId)) evidenceIds.push(sourceId);
    }
    const lines = reported.map((row) => row.text);
    if (conflicts.length > 0) lines.push(`Conflicting claims (not evidence): ${conflicts.join(', ')}`);
    const coverage = reported.length > 0 ? (reported[0]?.coverage ?? await source.coverage()) : await source.coverage();
    return {
      question: asked,
      asOf,
      text: lines.length > 0 ? lines.join('\n') : 'No supported evidence for that question.',
      supported: reported.length > 0,
      evidenceIds,
      conflicts,
      coverage: copyCoverage(coverage),
      extractionVersion,
    };
  }

  async function reviseDecision(request: ReviseDecisionRequest): Promise<MemorySummary> {
    assertOpen();
    if (!isRecord(request)) throw new TypeError('reviseDecision requires { decisionId, choice, actor: \'user\' }');
    const decisionId = requireText(request.decisionId, 'reviseDecision requires the id of the decision it replaces').trim();
    const choice = requireText(request.choice, 'reviseDecision requires the corrected choice').trim();
    if (request.actor !== 'user') {
      throw new TypeError("reviseDecision requires actor 'user': only an explicit user edit may reverse a decision");
    }
    const rationale = typeof request.rationale === 'string' && request.rationale.trim().length > 0 ? request.rationale : undefined;
    const requestedAt = request.occurredAt === undefined ? undefined : parseInstant(request.occurredAt, 'reviseDecision occurredAt');

    const revisedId = await durable.mutate(async (state) => {
      const { summaries: rows, firstSeen } = await buildFrom(state);
      for (const [id, at] of Object.entries(firstSeen)) {
        if (state.firstSeenAt[id] === undefined) state.firstSeenAt[id] = at;
      }
      const target = rows.find((row) => row.id === decisionId && row.kind === 'decision');
      if (target === undefined) throw new TypeError(`reviseDecision found no decision record ${decisionId}`);
      const question = target.question ?? target.text;
      const occurredAt = requestedAt ?? new Date().toISOString();
      const ordinal = state.corrections.filter((correction) => correction.decisionId === decisionId).length + 1;
      const recordId = `${decisionId}#revision-${String(ordinal)}`;
      const eventId = `evt-m04-correction-${stableHash(`${projectId}|${decisionId}|${occurredAt}|${choice}`)}`;
      const existing = state.corrections.find((correction) => correction.eventId === eventId);
      if (existing !== undefined) return existing.recordId;

      const questionKey = normalizeKey(question);
      const replaceable = rows.filter(
        (row) => row.kind === 'decision' && row.status === 'active' && normalizeKey(row.question ?? row.text) === questionKey,
      );
      const supersededIds = replaceable.length > 0 ? replaceable.map((row) => row.id) : [decisionId];
      const mostRecent = [...replaceable].sort((left, right) => {
        const elapsed = Date.parse(left.validFrom) - Date.parse(right.validFrom);
        if (Number.isFinite(elapsed) && elapsed !== 0) return elapsed;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
      const supersedesId = mostRecent[mostRecent.length - 1]?.id ?? decisionId;

      const { event, payload } = correctionEvent({
        projectId,
        profileId,
        eventId,
        sequence: ordinal,
        occurredAt,
        question,
        choice,
        ...(rationale === undefined ? {} : { rationale }),
      });
      await store.ingest({ events: [event], payloads: { [event.payloadRef]: payload } });

      const correction: CorrectionRecord = {
        recordId,
        decisionId,
        question,
        choice,
        ...(rationale === undefined ? {} : { rationale }),
        actor: 'user',
        occurredAt,
        eventId,
        supersedesId,
        supersededIds,
      };
      state.corrections.push(correction);
      for (const entry of state.corrections) {
        if (entry.recordId !== recordId && supersededIds.includes(entry.recordId)) entry.supersededBy = recordId;
      }
      return recordId;
    });

    const revised = (await collectSummaries()).find((row) => row.id === revisedId);
    if (revised === undefined) throw new Error(`memory records lost the corrected decision ${revisedId}`);
    return revised;
  }

  async function coverage(): Promise<MemoryCoverage> {
    assertOpen();
    return copyCoverage(await source.coverage());
  }

  async function close(): Promise<void> {
    await durable.settled();
    closed = true;
  }

  return { summaries, summary, answer, reviseDecision, coverage, close };
}

export { bearsOnQuestion, contentTokens, normalizeKey } from './matching.js';
export { recordsStatePath } from './state.js';
export type { CorrectionRecord, DurableRecordsState, RecordsStateView } from './state.js';
export type { CapsuleView, SummaryBuildInputs, SummaryBuildResult, TaskView } from './summaries.js';
export { buildSummaries } from './summaries.js';
