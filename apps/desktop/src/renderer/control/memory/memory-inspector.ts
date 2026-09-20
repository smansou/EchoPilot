/**
 * Renderer-side view of the M04 records inspector (ticket path: inspect/correct a memory →
 * updated temporal state → a different evidence-backed answer).
 *
 * The renderer never re-derives memory: it renders the `MemorySummary` rows and the
 * `TemporalAnswer` the records layer already computed, and keeps the two UI invariants visible:
 *
 *   - Every displayed row carries a `reveal` bundle — its sources, its extraction version, and its
 *     coverage — by construction, so no row can be painted without a way to disclose them, and an
 *     `expired` raw source is labeled rather than dropped.
 *   - A row that is `disputed` or `superseded` is never `citable`: it stays inspectable, but the UI
 *     must render it as a conflict/history row instead of evidence. A reversal therefore only
 *     travels through `decisionRevisionRequest()`, which throws unless an explicit user edit made
 *     the request, so agent text can never render its way into a correction.
 */
import type {
  EvidenceTrust,
  MemoryCoverage,
  MemorySummary,
  ReviseDecisionRequest,
  SummaryKind,
  SummaryStatus,
  TemporalAnswer,
} from '../../../../../../packages/memory/src/records/model.js';

export type MemorySourceLine = Readonly<{
  eventId: string;
  kind: string;
  trust: EvidenceTrust;
  occurredAt: string;
  availability: 'available' | 'expired';
  /** Disclosure line; an unavailable raw source says so instead of disappearing. */
  label: string;
}>;

export type MemoryCoverageView = Readonly<{
  semantic: 'complete' | 'partial';
  failedJobs: readonly string[];
  label: string;
}>;

/** The disclosure bundle every displayed row can show when the user asks where it came from. */
export type MemoryReveal = Readonly<{
  sources: readonly MemorySourceLine[];
  extractionVersion: string;
  coverage: MemoryCoverageView;
}>;

export type MemorySummaryRow = Readonly<{
  id: string;
  kind: SummaryKind;
  text: string;
  status: SummaryStatus;
  trust: EvidenceTrust;
  /** Explanation of `status`, so the UI never has to invent one. */
  statusNote: string;
  /** False for disputed/superseded rows: inspectable, never presentable as evidence. */
  citable: boolean;
  reveal: MemoryReveal;
  validFrom: string;
  validTo?: string;
  supersedesId?: string;
  taskStatus?: MemorySummary['taskStatus'];
}>;

export type MemoryAnswerView = Readonly<{
  question: string;
  asOf: string;
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
  conflicts: readonly string[];
  extractionVersion: string;
  coverage: MemoryCoverageView;
  /** One line stating what backs the answer, including the conflicts it refuses to cite. */
  disclosure: string;
}>;

export type MemoryInspectorView = Readonly<{
  rows: readonly MemorySummaryRow[];
  selectedId: string | null;
  answer: MemoryAnswerView | null;
}>;

/** An edit the user made; the renderer cannot invent `confirmedByUser` on its own. */
export type DecisionRevisionIntent = Readonly<{
  recordId: string;
  choice: string;
  rationale?: string;
  /** Only an explicit user edit sets this; an agent suggestion leaves it false and is rejected. */
  confirmedByUser: boolean;
}>;

function coverageView(coverage: MemoryCoverage): MemoryCoverageView {
  const failedJobs = Array.isArray(coverage?.failedJobs) ? coverage.failedJobs.map((job) => String(job)) : [];
  const partial = coverage?.semantic === 'partial';
  const jobs = failedJobs.length > 0 ? failedJobs.join(', ') : 'unspecified job';
  return {
    semantic: partial ? 'partial' : 'complete',
    failedJobs,
    label: partial
      ? `coverage: partial — ${String(failedJobs.length)} failed job(s): ${jobs}`
      : 'coverage: complete',
  };
}

function sourceLine(
  eventId: string,
  provenance: MemorySummary['provenance'][number] | undefined,
): MemorySourceLine {
  const availability = provenance?.rawAvailability === 'expired' ? 'expired' : 'available';
  const kind = typeof provenance?.kind === 'string' && provenance.kind.length > 0 ? provenance.kind : 'unknown';
  const trust: EvidenceTrust = availability === 'expired' ? 'imported' : (provenance?.trust ?? 'imported');
  const occurredAt = typeof provenance?.occurredAt === 'string' ? provenance.occurredAt : '';
  const when = occurredAt.length > 0 ? occurredAt : 'time unknown';
  return {
    eventId,
    kind,
    trust,
    occurredAt,
    availability,
    label: availability === 'expired'
      ? `${eventId} · raw source unavailable (expired) · not trusted evidence`
      : `${eventId} · ${kind} · ${trust} · ${when}`,
  };
}

function statusNote(status: SummaryStatus): string {
  switch (status) {
    case 'disputed':
      return 'disputed: a stronger record makes the same claim, so this row is not evidence';
    case 'superseded':
      return 'superseded: a later explicit user correction replaced it; the historical answer is kept';
    default:
      return 'active: the strongest record for this claim at its validity interval';
  }
}

/** Projects one displayed summary; sources, extraction version, and coverage always travel with it. */
export function projectSummary(summary: MemorySummary): MemorySummaryRow {
  const sources = summary.sources.map((eventId, index) => sourceLine(String(eventId), summary.provenance[index]));
  return {
    id: summary.id,
    kind: summary.kind,
    text: summary.text,
    status: summary.status,
    trust: summary.trust,
    statusNote: statusNote(summary.status),
    citable: summary.status === 'active',
    reveal: {
      sources,
      extractionVersion: summary.extractionVersion,
      coverage: coverageView(summary.coverage),
    },
    validFrom: summary.validFrom,
    ...(summary.validTo === undefined ? {} : { validTo: summary.validTo }),
    ...(summary.supersedesId === undefined ? {} : { supersedesId: summary.supersedesId }),
    ...(summary.taskStatus === undefined ? {} : { taskStatus: summary.taskStatus }),
  };
}

export function projectSummaries(summaries: readonly MemorySummary[]): readonly MemorySummaryRow[] {
  return summaries.map((summary) => projectSummary(summary));
}

export function projectAnswer(answer: TemporalAnswer): MemoryAnswerView {
  const coverage = coverageView(answer.coverage);
  const conflicts = answer.conflicts.length > 0 ? `; refuses to cite: ${answer.conflicts.join(', ')}` : '';
  return {
    question: answer.question,
    asOf: answer.asOf,
    text: answer.text,
    supported: answer.supported,
    evidenceIds: [...answer.evidenceIds],
    conflicts: [...answer.conflicts],
    extractionVersion: answer.extractionVersion,
    coverage,
    disclosure: answer.supported
      ? `${String(answer.evidenceIds.length)} source(s) · extraction ${answer.extractionVersion} · ${coverage.label}${conflicts}`
      : `no evidence-backed answer · extraction ${answer.extractionVersion} · ${coverage.label}${conflicts}`,
  };
}

export function initialInspectorView(): MemoryInspectorView {
  return { rows: [], selectedId: null, answer: null };
}

/** Replaces the displayed rows; a selection that is no longer displayed is dropped, never faked. */
export function applySummaries(
  view: MemoryInspectorView,
  summaries: readonly MemorySummary[],
): MemoryInspectorView {
  const rows = projectSummaries(summaries);
  const selectedId = view.selectedId !== null && rows.some((row) => row.id === view.selectedId)
    ? view.selectedId
    : null;
  return { ...view, rows, selectedId };
}

/** Selecting an id that is not displayed leaves the view untouched. */
export function selectMemoryRow(view: MemoryInspectorView, id: string): MemoryInspectorView {
  if (!view.rows.some((row) => row.id === id)) return view;
  return { ...view, selectedId: id };
}

export function applyAnswer(view: MemoryInspectorView, answer: TemporalAnswer): MemoryInspectorView {
  return { ...view, answer: projectAnswer(answer) };
}

/**
 * Builds the records-layer request for a reversal. Throws unless a user edit made the request, so a
 * click handler that only holds an agent suggestion can never rewrite a decision.
 */
export function decisionRevisionRequest(intent: DecisionRevisionIntent): ReviseDecisionRequest {
  if (intent.confirmedByUser !== true) {
    throw new TypeError('a decision reversal requires an explicit user edit');
  }
  const decisionId = intent.recordId?.trim() ?? '';
  if (decisionId.length === 0) throw new TypeError('a decision reversal requires the record it replaces');
  const choice = intent.choice?.trim() ?? '';
  if (choice.length === 0) throw new TypeError('a decision reversal requires the corrected choice');
  const rationale = intent.rationale?.trim() ?? '';
  return {
    decisionId,
    choice,
    actor: 'user',
    ...(rationale.length === 0 ? {} : { rationale }),
  };
}
