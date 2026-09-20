/**
 * Displayed-summary builder (M04).
 *
 * Turns the three evidence planes into the rows an inspector shows — every derived fact, every
 * derived decision, every observed task, plus every recorded correction — and decides, per row:
 *
 *   - status: `active`, `disputed` (a weaker derivation collides with a stronger record), or
 *     `superseded` (a later user correction replaced it, which always keeps its own interval),
 *   - trust: the strongest trust of the raw events that back it, `imported` when none is recoverable,
 *   - provenance: one `MemorySourceRef` per source, with a removed raw event labeled `expired`
 *     (kind `unknown`, trust `imported`) instead of hidden,
 *   - validity: `validFrom` from the oldest surviving source time, and `validTo` when a correction
 *     superseded it.
 *
 * A record that has no source event ids has no provenance anchor and is therefore not displayed: it
 * could only be shown as unsourced certainty, which §5.8 forbids. The build is pure; the caller
 * persists the returned first-seen anchors and merges them into the next build.
 */
import {
  asEvidenceTrust,
  copyCoverage,
  isTaskStatus,
  strongestTrust,
  trustRank,
  type DerivedDecisionClaim,
  type DerivedFactClaim,
  type EvidenceTrust,
  type MemoryCoverage,
  type MemorySourceRef,
  type MemorySummary,
  type SummaryKind,
  type SummaryStatus,
  type TaskStatus,
} from './model.js';
import { normalizeKey } from './matching.js';
import type { CorrectionRecord } from './state.js';

export interface CapsuleView {
  kind: string;
  trust: string;
  occurredAt: string;
  summary: string;
}

export interface TaskView {
  id: string;
  status?: string;
  summary: string;
  sourceEventIds: readonly string[];
}

export interface SummaryBuildInputs {
  facts: readonly DerivedFactClaim[];
  decisions: readonly DerivedDecisionClaim[];
  tasks: readonly TaskView[];
  capsules: ReadonlyMap<string, CapsuleView>;
  corrections: readonly CorrectionRecord[];
  coverage: MemoryCoverage;
  extractionVersion: string;
  firstSeenAt: Readonly<Record<string, string>>;
  /** Clock for records that have no recoverable source time; the caller persists the anchor. */
  now: string;
}

export interface SummaryBuildResult {
  summaries: readonly MemorySummary[];
  /** Record ids anchored at `now` by this build because no source time was recoverable. */
  firstSeen: Readonly<Record<string, string>>;
}

interface DraftRow {
  id: string;
  kind: SummaryKind;
  text: string;
  status: SummaryStatus;
  trust: EvidenceTrust;
  question?: string;
  choice?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  taskStatus?: TaskStatus;
  sources: string[];
  provenance: MemorySourceRef[];
  extractionVersion: string;
  coverage: MemoryCoverage;
  validFrom: string;
  validTo?: string;
  supersedesId?: string;
  collisionKey: string;
}

const STATUS_PRECEDENCE: Readonly<Record<SummaryStatus, number>> = { active: 0, disputed: 1, superseded: 2 };

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}

function earliest(times: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const time of times) {
    const ms = Date.parse(time);
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = time;
  }
  return best;
}

function sourceRef(eventId: string, capsules: ReadonlyMap<string, CapsuleView>): MemorySourceRef {
  const capsule = capsules.get(eventId);
  if (capsule === undefined) {
    return { eventId, kind: 'unknown', trust: 'imported', occurredAt: '', rawAvailability: 'expired' };
  }
  return {
    eventId,
    kind: capsule.kind.length > 0 ? capsule.kind : 'unknown',
    trust: asEvidenceTrust(capsule.trust),
    occurredAt: capsule.occurredAt,
    rawAvailability: 'available',
  };
}

interface Anchor {
  trust: EvidenceTrust;
  validFrom: string;
  provenance: MemorySourceRef[];
}

/**
 * Resolves one record's provenance anchor. An expired source keeps the record's best-known time,
 * because the raw occurrence time is gone with the raw event; a record with no recoverable source
 * time at all is anchored at first display instead of pretending to know when it became true.
 */
function anchorFor(
  id: string,
  sources: readonly string[],
  inputs: SummaryBuildInputs,
  firstSeen: Record<string, string>,
): Anchor {
  const provenance = sources.map((eventId) => sourceRef(eventId, inputs.capsules));
  const availableTimes = provenance
    .filter((ref) => ref.rawAvailability === 'available')
    .map((ref) => ref.occurredAt)
    .filter((time) => time.length > 0);
  const trust = strongestTrust(provenance.map((ref) => ref.trust));
  let validFrom = earliest(availableTimes);
  if (validFrom === undefined) {
    const remembered = inputs.firstSeenAt[id];
    if (typeof remembered === 'string' && remembered.length > 0) {
      validFrom = remembered;
    } else {
      validFrom = inputs.now;
      firstSeen[id] = inputs.now;
    }
  }
  const resolved = validFrom;
  return {
    trust,
    validFrom: resolved,
    provenance: provenance.map((ref) => (ref.occurredAt.length > 0 ? ref : { ...ref, occurredAt: resolved })),
  };
}

function claimStatus(value: string | undefined): SummaryStatus | undefined {
  const status = (value ?? '').trim().toLowerCase();
  if (status === 'disputed' || status === 'conflict' || status === 'conflicted') return 'disputed';
  if (status === 'superseded' || status === 'retracted' || status === 'replaced') return 'superseded';
  if (status === 'active' || status === 'current') return 'active';
  return undefined;
}

function supersededIdsOf(correction: CorrectionRecord): string[] {
  const ids = uniqueStrings(correction.supersededIds);
  if (ids.length > 0) return ids;
  return correction.supersedesId === undefined ? [] : [correction.supersedesId];
}

/** Drops duplicate derivations so each record is displayed exactly once. */
function dedupeClaims<T extends { id: string; sourceEventIds: readonly string[] }>(
  claims: readonly T[],
  extraKey: (claim: T) => string,
): T[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: T[] = [];
  for (const claim of claims) {
    const id = typeof claim?.id === 'string' ? claim.id : '';
    if (id.length === 0) continue;
    const key = `${id}\u0000${[...(claim.sourceEventIds ?? [])].map(String).sort().join('|')}\u0000${extraKey(claim)}`;
    if (seenIds.has(id) || seenKeys.has(key)) continue;
    seenIds.add(id);
    seenKeys.add(key);
    out.push(claim);
  }
  return out;
}

export function buildSummaries(inputs: SummaryBuildInputs): SummaryBuildResult {
  const firstSeen: Record<string, string> = {};
  const rows: DraftRow[] = [];

  for (const claim of dedupeClaims(inputs.facts, (fact) => normalizeKey(`${fact.subject}\u0000${fact.predicate}`))) {
    const sources = uniqueStrings(claim.sourceEventIds ?? []);
    if (sources.length === 0) continue;
    const anchor = anchorFor(claim.id, sources, inputs, firstSeen);
    const object = typeof claim.object === 'string' ? claim.object : '';
    const subject = typeof claim.subject === 'string' ? claim.subject : '';
    const predicate = typeof claim.predicate === 'string' ? claim.predicate : '';
    rows.push({
      id: claim.id,
      kind: 'fact',
      text: object.length > 0 ? object : [subject, predicate].filter((part) => part.length > 0).join(' '),
      status: claimStatus(claim.status) ?? 'active',
      trust: anchor.trust,
      subject,
      predicate,
      object,
      sources,
      provenance: anchor.provenance,
      extractionVersion: inputs.extractionVersion,
      coverage: copyCoverage(inputs.coverage),
      validFrom: anchor.validFrom,
      collisionKey: `fact\u0000${normalizeKey(subject)}\u0000${normalizeKey(predicate)}`,
    });
  }

  for (const claim of dedupeClaims(inputs.decisions, (decision) => normalizeKey(decision.question))) {
    const sources = uniqueStrings(claim.sourceEventIds ?? []);
    if (sources.length === 0) continue;
    const anchor = anchorFor(claim.id, sources, inputs, firstSeen);
    const question = typeof claim.question === 'string' ? claim.question : '';
    const choice = typeof claim.choice === 'string' ? claim.choice : '';
    const text = question.length > 0 && choice.length > 0 ? `${question} — ${choice}` : question.length > 0 ? question : choice;
    rows.push({
      id: claim.id,
      kind: 'decision',
      text,
      status: claimStatus(claim.status) ?? 'active',
      trust: anchor.trust,
      question,
      choice,
      sources,
      provenance: anchor.provenance,
      extractionVersion: inputs.extractionVersion,
      coverage: copyCoverage(inputs.coverage),
      validFrom: anchor.validFrom,
      collisionKey: question.length > 0 ? `decision\u0000${normalizeKey(question)}` : `decision\u0000#${claim.id}`,
    });
  }

  for (const task of inputs.tasks) {
    const sources = uniqueStrings(task.sourceEventIds ?? []);
    if (sources.length === 0) continue;
    const anchor = anchorFor(task.id, sources, inputs, firstSeen);
    rows.push({
      id: task.id,
      kind: 'task',
      text: typeof task.summary === 'string' && task.summary.length > 0 ? task.summary : task.id,
      status: 'active',
      trust: anchor.trust,
      subject: task.id,
      taskStatus: isTaskStatus(task.status) ? task.status : 'unknown',
      sources,
      provenance: anchor.provenance,
      extractionVersion: inputs.extractionVersion,
      coverage: copyCoverage(inputs.coverage),
      validFrom: anchor.validFrom,
      collisionKey: `task\u0000${normalizeKey(task.id)}`,
    });
  }

  // A correction is a new explicit user decision: it keeps its own interval and never rewrites the
  // record it replaced, which is instead closed at the correction's instant.
  const supersededAt = new Map<string, string>();
  for (const correction of inputs.corrections) {
    for (const id of supersededIdsOf(correction)) supersededAt.set(id, correction.occurredAt);
  }
  for (const row of rows) {
    const closedAt = supersededAt.get(row.id);
    if (closedAt !== undefined) {
      row.status = 'superseded';
      row.validTo = closedAt;
    }
  }
  for (const correction of inputs.corrections) {
    const sources = uniqueStrings([correction.eventId]);
    const anchor = anchorFor(correction.recordId, sources, inputs, firstSeen);
    const supersededBy = correction.supersededBy === undefined
      ? undefined
      : inputs.corrections.find((candidate) => candidate.recordId === correction.supersededBy);
    const question = correction.question ?? '';
    const choice = correction.choice;
    const replaced: DraftRow = {
      id: correction.recordId,
      kind: 'decision',
      text: question.length > 0 ? `${question} — ${choice}` : choice,
      status: supersededBy === undefined ? 'active' : 'superseded',
      trust: anchor.trust,
      question,
      choice,
      sources,
      provenance: anchor.provenance,
      extractionVersion: inputs.extractionVersion,
      coverage: copyCoverage(inputs.coverage),
      validFrom: correction.occurredAt,
      collisionKey: question.length > 0 ? `decision\u0000${normalizeKey(question)}` : `decision\u0000#${correction.recordId}`,
    };
    if (supersededBy !== undefined) replaced.validTo = supersededBy.occurredAt;
    if (correction.supersedesId !== undefined) replaced.supersedesId = correction.supersedesId;
    const existing = rows.findIndex((row) => row.id === correction.recordId);
    if (existing >= 0) rows[existing] = replaced;
    else rows.push(replaced);
  }

  // Evidence hierarchy: a fact about an observed task collides with that task, and a weaker claim in
  // a collision group is disputed; the strongest claim stays current.
  const taskKeys = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'task') taskKeys.set(normalizeKey(row.subject ?? row.id), row.collisionKey);
  }
  for (const row of rows) {
    if (row.kind !== 'fact') continue;
    const shared = taskKeys.get(normalizeKey(row.subject));
    if (shared !== undefined) row.collisionKey = shared;
  }
  const groups = new Map<string, DraftRow[]>();
  for (const row of rows) {
    const group = groups.get(row.collisionKey);
    if (group === undefined) groups.set(row.collisionKey, [row]);
    else group.push(row);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let strongest = 0;
    for (const row of group) strongest = Math.max(strongest, trustRank(row.trust));
    for (const row of group) {
      if (trustRank(row.trust) >= strongest) continue;
      if (STATUS_PRECEDENCE[row.status] >= STATUS_PRECEDENCE.disputed) continue;
      row.status = 'disputed';
    }
  }

  const summaries = rows
    .sort((left, right) => {
      const elapsed = Date.parse(left.validFrom) - Date.parse(right.validFrom);
      if (Number.isFinite(elapsed) && elapsed !== 0) return elapsed;
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .map((row): MemorySummary => ({
      id: row.id,
      kind: row.kind,
      text: row.text,
      status: row.status,
      trust: row.trust,
      ...(row.question === undefined ? {} : { question: row.question }),
      ...(row.choice === undefined ? {} : { choice: row.choice }),
      ...(row.subject === undefined ? {} : { subject: row.subject }),
      ...(row.predicate === undefined ? {} : { predicate: row.predicate }),
      ...(row.object === undefined ? {} : { object: row.object }),
      ...(row.taskStatus === undefined ? {} : { taskStatus: row.taskStatus }),
      sources: [...row.sources],
      provenance: row.provenance.map((ref) => ({ ...ref })),
      extractionVersion: row.extractionVersion,
      coverage: copyCoverage(row.coverage),
      validFrom: row.validFrom,
      ...(row.validTo === undefined ? {} : { validTo: row.validTo }),
      ...(row.supersedesId === undefined ? {} : { supersedesId: row.supersedesId }),
    }));

  return { summaries, firstSeen };
}
