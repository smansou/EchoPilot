/**
 * C04 — a day of scoped desktop activity → compact project context → useful later recall
 * (IMPLEMENTATION_PLAN.md §7.2 C04; BACKLOG C04 acceptance criteria 1-3).
 *
 * `createDesktopHistoryService({ scope, now, config, capture, memory, reasoner })` is the opt-in,
 * event-triggered history seam: one desktop observation at a time, one semantic record per admitted
 * change, and nothing at all for a no-change period.
 *
 * - Scope is required at construction. Every ingest batch and every recall query carries
 *   `scope.projectId`, so a scope-less, window-title-similarity query can never be issued and a
 *   near-duplicate note from another project can never be retrieved.
 * - Refusal order is fixed: an excluded bundle id is refused before the raw boundary is asked (a raw
 *   producer would happily hand back an excluded app's window); a tick outside every explicit work
 *   session is refused (history is off by default); a revoked or private session is refused; only an
 *   admissible tick reaches the capture sampler, so a refused tick consumes no budget and can never
 *   become a model call.
 * - The identity signature is `app.bundleId | documentRef | focusedControl | windowTitle |
 *   contentRevision`; the sampler (packages/capture/src/sampling/) decides changed / unchanged /
 *   throttled on top of the frequency and energy budgets, so a no-change period makes no capture and
 *   no model call, and a deferred change is retried when a budget frees.
 * - A changed tick captures the window, makes exactly one summarize model call whose bounded context
 *   carries the capture as `desk:capture:<snapshotId>`, and appends one pending semantic record whose
 *   source capsule is its own. Raw frames are not retained by default: the frame reference and the
 *   frame-only bytes are read transiently and persisted neither in the record, nor in memory, nor in
 *   an export — only `config.retainRawFrames === true` keeps a reference (never the bytes).
 * - `flush()` ingests the pending records into memory as one batch of `capture` EventEnvelopes
 *   scoped to `scope`, each carrying its capsule as `payloadRef`; ingested records stay exportable.
 * - `recall({ question })` makes exactly one scoped `memory.query` and one reasoner call, and the
 *   answer keeps only the evidence ids the retrieved bundle actually contains — an invented id is
 *   dropped before the answer is returned. Recall never captures and never ingests.
 * - `revoke({ reason })` and `enterPrivateMode()` stop capture and purge the pending unsaved records
 *   (with any retained frame reference) before a future export; a purged record is gone from the
 *   export and never reaches memory afterwards. Revocation is permanent; private mode resumes
 *   capture on `exitPrivateMode()`.
 * - Every timestamp the service writes comes from the injected `now` clock.
 *
 * The service drives the frozen service seam only; real ScreenCaptureKit/AX capture, TCC consent and
 * OS-level energy metering live behind `capture` and are not claimed here.
 */
import type {
  BoundedContext,
  EventEnvelope,
  EvidenceBundle,
  Memory,
  Reasoner,
  Scope,
} from '../../../contracts/src/index.js';
import { createCaptureSampler, type SamplingPolicy } from '../../../capture/src/sampling/index.js';

export type DesktopObservation = Readonly<{
  app: Readonly<{ bundleId: string; name: string }>;
  windowTitle: string;
  documentRef: string;
  focusedControl: string;
  contentRevision: string;
}>;

/** One raw window read. `frameRef`/`frameText` are the raw-frame handle and the frame-only bytes. */
export type WindowCapture = Readonly<{
  snapshotId: string;
  capturedAt: string;
  frameRef: string;
  axText: ReadonlyArray<string>;
  frameText: ReadonlyArray<string>;
}>;

/** The raw desktop boundary: a producer that would happily hand back an excluded app's window. */
export type DesktopCaptureBoundary = Readonly<{
  captureWindow(request: Readonly<{ observation: DesktopObservation }>): Promise<WindowCapture>;
}>;

export type HistoryObservationReason =
  | 'changed' | 'unchanged' | 'throttled' | 'excluded' | 'outside_work_session' | 'stopped' | 'private';

export type HistoryObservation = Readonly<{
  captured: boolean;
  reason: HistoryObservationReason;
  budget?: 'frequency' | 'energy';
  recordId?: string;
}>;

/** One retained semantic history record and the source capsule that holds its evidence. */
export type RetainedRecord = Readonly<{
  recordId: string;
  text: string;
  capsuleRef: string;
  capturedAt: string;
}>;

/** What a future export ships: the retained records plus the raw frame refs, if any were kept. */
export type DesktopHistoryExport = Readonly<{
  records: ReadonlyArray<RetainedRecord>;
  frameRefs: ReadonlyArray<string>;
}>;

export type DesktopRecall = Readonly<{ text: string; evidenceIds: ReadonlyArray<string> }>;

export type DesktopHistoryConfig = Readonly<{
  /** The capture budget; the same shape the sampler oracle freezes. */
  policy: SamplingPolicy;
  /** The explicit work sessions. History is off by default outside them. */
  workSessions: ReadonlyArray<Readonly<{ beginsAt: string; endsAt: string }>>;
  /** Applications whose content is never captured, summarized, or ingested. */
  excludedBundleIds: ReadonlyArray<string>;
  /**
   * Explicit opt-in for raw-frame retention. Default false: the frame reference and the frame-only
   * bytes are read transiently and never persisted. Even when true only the reference is kept.
   */
  retainRawFrames?: boolean;
}>;

export type DesktopHistoryOptions = Readonly<{
  scope: Scope;
  now: () => Date;
  config: DesktopHistoryConfig;
  capture: DesktopCaptureBoundary;
  memory: Memory;
  reasoner: Reasoner;
}>;

export type DesktopHistoryService = Readonly<{
  observe(observation: DesktopObservation): Promise<HistoryObservation>;
  flush(): Promise<Readonly<{ ingested: number }>>;
  recall(request: Readonly<{ question: string }>): Promise<DesktopRecall>;
  revoke(request: Readonly<{ reason: string }>): Promise<Readonly<{ stopped: boolean; purged: number }>>;
  enterPrivateMode(): Promise<Readonly<{ purged: number }>>;
  exitPrivateMode(): Promise<void>;
  exportRecords(): Promise<DesktopHistoryExport>;
}>;

/** §5.4 deterministic context budget: a bounded context never exceeds this. */
export const MAX_BOUNDED_CONTEXT_TOKENS = 8_192;
/** At most this many in-project memory items enter a recall context. */
export const RECALL_EVIDENCE_BUDGET = 8;

const SUMMARIZE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

const RECALL_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'evidenceIds'],
  properties: {
    text: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
  },
};

/** Stable, dependency-free id material so a replay of the same day is byte-identical. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function estimateMaxTokens(charCount: number): number {
  const estimated = Math.ceil(Math.max(0, charCount) / 4) + 256;
  return Math.min(MAX_BOUNDED_CONTEXT_TOKENS, Math.max(1, estimated));
}

/** The observation identity the sampler decides on, and the only state a change is compared by. */
export function desktopObservationSignature(observation: DesktopObservation): string {
  return [
    observation.app.bundleId,
    observation.documentRef,
    observation.focusedControl,
    observation.windowTitle,
    observation.contentRevision,
  ].join('|');
}

/** The summarize contract: the semantic sentence, or nothing usable (never invented text). */
function parseSummaryText(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const text = (output as Record<string, unknown>).text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return text.trim();
}

/** The recall contract, bounded to the retrieved evidence: an invented citation is dropped. */
function parseGroundedRecall(output: unknown, knownEvidenceIds: ReadonlyArray<string>): DesktopRecall | null {
  if (typeof output !== 'object' || output === null) return null;
  const record = output as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (!Array.isArray(record.evidenceIds)) return null;
  const known = new Set(knownEvidenceIds);
  const evidenceIds: Array<string> = [];
  for (const entry of record.evidenceIds) {
    if (typeof entry !== 'string' || !known.has(entry) || evidenceIds.includes(entry)) continue;
    evidenceIds.push(entry);
  }
  return { text, evidenceIds };
}

export function createDesktopHistoryService(options: DesktopHistoryOptions): DesktopHistoryService {
  const { scope, now, config, capture, memory, reasoner } = options;
  const projectId = scope.projectId;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new TypeError(
      'C04: createDesktopHistoryService requires an explicit project scope (scope.projectId); a '
      + 'desktop history is never recorded or recalled through a scope-less memory query.',
    );
  }
  const excluded = new Set(
    config.excludedBundleIds.map((bundleId) => bundleId.trim().toLowerCase()).filter((bundleId) => bundleId.length > 0),
  );
  const workSessions = config.workSessions.map((session) => {
    const beginsAt = Date.parse(session.beginsAt);
    const endsAt = Date.parse(session.endsAt);
    if (!Number.isFinite(beginsAt) || !Number.isFinite(endsAt)) {
      throw new TypeError('C04: every work session needs a valid beginsAt and endsAt instant');
    }
    return { beginsAt, endsAt };
  });
  const retainRawFrames = config.retainRawFrames === true;
  const sampler = createCaptureSampler({ policy: config.policy });

  type HeldRecord = {
    record: RetainedRecord;
    sourceSequence: number;
    frameRef: string | null;
    saved: boolean;
  };
  const held: Array<HeldRecord> = [];
  const retainedFrameRefs: Array<Readonly<{ recordId: string; frameRef: string }>> = [];
  let recordSequence = 0;
  let ingestSequence = 0;
  let privateMode = false;
  let revoked = false;

  function inWorkSession(atMs: number): boolean {
    return workSessions.some((session) => atMs >= session.beginsAt && atMs < session.endsAt);
  }

  function dropFrameRef(recordId: string): void {
    for (let index = retainedFrameRefs.length - 1; index >= 0; index -= 1) {
      if (retainedFrameRefs[index]?.recordId === recordId) retainedFrameRefs.splice(index, 1);
    }
  }

  /** Purges the pending, unsaved records; ingested records stay exportable. */
  function purgePending(): number {
    let purged = 0;
    for (const entry of held) {
      if (entry.saved) continue;
      purged += 1;
      if (entry.frameRef !== null) dropFrameRef(entry.record.recordId);
    }
    const kept = held.filter((entry) => entry.saved);
    held.length = 0;
    held.push(...kept);
    return purged;
  }

  function eventEnvelopeFor(entry: HeldRecord): EventEnvelope {
    ingestSequence += 1;
    return {
      schemaVersion: 1,
      eventId: `desk-history:${entry.record.recordId}`,
      sourceId: 'desktop-history',
      sourceEventId: entry.record.recordId,
      sourceSequence: entry.sourceSequence,
      ingestSequence,
      occurredAt: entry.record.capturedAt,
      observedAt: entry.record.capturedAt,
      scope,
      kind: 'capture',
      payloadRef: entry.record.capsuleRef,
      contentHash: `fnv1a:${stableHash(entry.record.text)}`,
      trust: 'tool_observed',
    };
  }

  async function observe(observation: DesktopObservation): Promise<HistoryObservation> {
    const atMs = now().getTime();
    const at = new Date(atMs).toISOString();
    if (excluded.has(observation.app.bundleId.trim().toLowerCase())) return { captured: false, reason: 'excluded' };
    if (!inWorkSession(atMs)) return { captured: false, reason: 'outside_work_session' };
    if (privateMode) return { captured: false, reason: 'private' };
    if (revoked) return { captured: false, reason: 'stopped' };

    const decision = sampler.observe({ atMs, signature: desktopObservationSignature(observation) });
    if (!decision.capture) {
      return decision.budget === undefined
        ? { captured: false, reason: decision.reason }
        : { captured: false, reason: decision.reason, budget: decision.budget };
    }

    const window = await capture.captureWindow({ observation });
    const boundedContext: BoundedContext = {
      evidenceIds: [`desk:capture:${window.snapshotId}`],
      maxTokens: estimateMaxTokens(window.axText.join('\n').length + window.frameText.join('\n').length),
    };
    const output = await reasoner.run(
      {
        taskId: `desk-history:summarize:${window.snapshotId}`,
        instruction: 'Summarize the captured desktop state as one sentence of project work history '
          + 'for the user. Report only what the captured window shows; never invent identifiers, '
          + 'credentials, or control state.',
      },
      boundedContext,
      SUMMARIZE_SCHEMA,
      new AbortController().signal,
    );
    const text = parseSummaryText(output);
    if (text === null) {
      // A capture the summarizer cannot describe contributes no history record: no record is
      // retained, no frame is kept, and no unparsed or invented text is persisted.
      return { captured: false, reason: 'unchanged' };
    }

    recordSequence += 1;
    const record: RetainedRecord = {
      recordId: `desk:record:${recordSequence}`,
      text,
      capsuleRef: `desk:capsule:${recordSequence}`,
      capturedAt: at,
    };
    const frameRef = retainRawFrames ? window.frameRef : null;
    held.push({ record, sourceSequence: recordSequence, frameRef, saved: false });
    if (frameRef !== null) retainedFrameRefs.push({ recordId: record.recordId, frameRef });
    return { captured: true, reason: 'changed', recordId: record.recordId };
  }

  async function flush(): Promise<Readonly<{ ingested: number }>> {
    if (privateMode) return { ingested: 0 };
    const pending = held.filter((entry) => !entry.saved);
    if (pending.length === 0) return { ingested: 0 };
    await memory.ingest(pending.map((entry) => eventEnvelopeFor(entry)));
    for (const entry of pending) entry.saved = true;
    return { ingested: pending.length };
  }

  async function recall(request: Readonly<{ question: string }>): Promise<DesktopRecall> {
    const question = request.question;
    const bundle: EvidenceBundle = await memory.query(question, scope, RECALL_EVIDENCE_BUDGET);
    const evidenceIds = [...bundle.evidenceIds];
    const output = await reasoner.run(
      {
        taskId: `desk-history:recall:${stableHash(question)}`,
        instruction: 'Answer the later question from the recorded project history and the retrieved '
          + `in-project evidence only; cite only the provided evidence ids. Question: ${question}`,
      },
      { evidenceIds, maxTokens: estimateMaxTokens(bundle.summary.length) },
      RECALL_SCHEMA,
      new AbortController().signal,
    );
    // The retrieved bundle is the whole grounding: an id the model invents is dropped here.
    return parseGroundedRecall(output, evidenceIds) ?? { text: bundle.summary, evidenceIds };
  }

  return {
    observe,
    flush,
    recall,
    /** Every revocation reason has the same local effect: capture stops and pending work is purged. */
    async revoke(): Promise<Readonly<{ stopped: boolean; purged: number }>> {
      revoked = true;
      sampler.stop();
      return { stopped: true, purged: purgePending() };
    },
    async enterPrivateMode(): Promise<Readonly<{ purged: number }>> {
      privateMode = true;
      return { purged: purgePending() };
    },
    async exitPrivateMode(): Promise<void> {
      privateMode = false;
    },
    async exportRecords(): Promise<DesktopHistoryExport> {
      return {
        records: held.map((entry) => ({ ...entry.record })),
        frameRefs: retainedFrameRefs.map((entry) => entry.frameRef),
      };
    },
  };
}
