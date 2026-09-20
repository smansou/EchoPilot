/**
 * N03 — overlapping sessions and interrupted summaries → relevant resumed digest
 * (IMPLEMENTATION_PLAN.md §7.2 N03, §5.7 narration stages 4–6, §5.3 SpeechPlan/SpeechLease).
 *
 * `createNarrationQueue({ attention, voice, now })` is the arbitration stage between the N02
 * compiled digests and the V02 playback seam: several sessions close turns at the same moment and
 * only the shared §5.7 speech lease plus the §5.7 speech budget decide which digest ever reaches
 * the speaker. The queue owns no authority of its own — every utterance asks attention first, and
 * heard state comes only from the playback events the voice layer reports (§ V-F3): speech that was
 * generated but never reported as completed was never heard.
 *
 * The behavior the N03 acceptance oracle pins:
 *
 * - Batching is per session, not per arrival. The newest pending digest of a session replaces the
 *   older pending ones (`coalesced`); a submission at or below the newest revision the session has
 *   already heard is never narrated (`superseded` / `deduplicated`); a `user-requested` digest is
 *   never coalesced away and takes the first opportunity ahead of the background backlog.
 * - One utterance is one logical digest (chapter). A mid-chapter stop preserves only the unheard
 *   tail: `resume()` narrates exactly that remainder through a fresh lease and a fresh plan, so an
 *   already-heard approval is never repeated. A remainder the session has since out-heard (a newer
 *   revision was heard) is discarded instead of resurrected.
 * - Background speech is paced at most one start per `NARRATION_BACKGROUND_MIN_GAP_MS`, so a
 *   three-session burst cannot stack back-to-back speech, and an undeliverable pending digest
 *   expires instead of becoming hours of stale queued speech.
 */
import type { SpeechLease, SpeechPlan, VoiceOutputEvent } from '../../../contracts/src/index.js';
import { wordCount } from '../format.js';

export type NarrationQueueKind =
  | 'turn-complete'
  | 'important-failure'
  | 'user-requested'
  | 'background-session'
  | 'routine-progress';

export type NarrationQueueSegment = Readonly<{
  id: string;
  text: string;
  evidenceIds: ReadonlyArray<string>;
  maxSeconds: number;
}>;

export type NarrationQueueChapter = Readonly<{
  id: string;
  segments: ReadonlyArray<NarrationQueueSegment>;
}>;

export type NarrationQueueSubmission = Readonly<{
  sessionId: string;
  sessionName: string;
  turnId: string;
  /** Monotonic per-session digest revision; a revision at or below the heard one is stale. */
  revision: number;
  eventId: string;
  contentKey: string;
  kind: NarrationQueueKind;
  chapters: ReadonlyArray<NarrationQueueChapter>;
}>;

export type NarrationQueueOutcome =
  | 'spoken'
  | 'deferred'
  | 'superseded'
  | 'coalesced'
  | 'deduplicated'
  | 'interrupted'
  | 'resumed'
  | 'discarded';

export type NarrationQueueReceipt = Readonly<{
  sessionId: string;
  eventId: string;
  outcome: NarrationQueueOutcome;
  reason: string;
  planId?: string;
  segmentIds?: ReadonlyArray<string>;
}>;

export type NarrationQueuePendingDigest = Readonly<{
  sessionId: string;
  eventId: string;
  kind: NarrationQueueKind;
}>;

/** The shared §5.7 speech-lease granter. `null` means the digest stays deferred, never dropped. */
export type NarrationQueueAttention = Readonly<{
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
}>;

/** The V02 playback seam; only its reported events decide what was heard. */
export type NarrationQueueVoice = Readonly<{
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;

export type NarrationQueueOptions = Readonly<{
  attention: NarrationQueueAttention;
  voice: NarrationQueueVoice;
  /** Deterministic clock; defaults to the system clock. */
  now?: () => Date;
}>;

export type NarrationQueue = Readonly<{
  submit(submission: NarrationQueueSubmission): Promise<ReadonlyArray<NarrationQueueReceipt>>;
  tick(): Promise<ReadonlyArray<NarrationQueueReceipt>>;
  interrupt(reason: string): void;
  resume(sessionId?: string): Promise<ReadonlyArray<NarrationQueueReceipt>>;
  pending(): ReadonlyArray<NarrationQueuePendingDigest>;
  receipts(): ReadonlyArray<NarrationQueueReceipt>;
}>;

/** At most one background digest starts per this safe gap, no matter how many sessions burst. */
export const NARRATION_BACKGROUND_MIN_GAP_MS = 3_000;
/** §5.7 concise budget per logical update (one digest). */
export const NARRATION_MAX_DIGEST_WORDS = 50;
/** §5.7 turn-complete summary bound. */
export const NARRATION_MAX_DIGEST_SECONDS = 20;
/** Matches N01's default lease window (§5.7); the voice layer still re-checks the lease. */
const LEASE_TTL_MS = 30_000;
/** A pending digest that cannot be delivered this long is dropped instead of queued forever. */
const PENDING_STALE_AFTER_MS = 90_000;
/** Bounded receipt retention for a long-lived process. */
const MAX_RECEIPTS = 2_000;

/** Background arbitration order: the foreground reply first, failing turns next, chatter last. */
const KIND_RANK: Readonly<Record<string, number>> = {
  'user-requested': 0,
  'important-failure': 1,
  'turn-complete': 2,
  'routine-progress': 3,
  'background-session': 4,
};

const kindRank = (kind: NarrationQueueKind): number => KIND_RANK[kind] ?? 2;

const priorityFor = (kind: NarrationQueueKind): SpeechPlan['priority'] =>
  kind === 'user-requested' || kind === 'important-failure' ? 'blocking'
    : kind === 'routine-progress' ? 'progress'
      : 'completion';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Digest = {
  submission: NarrationQueueSubmission;
  segments: ReadonlyArray<NarrationQueueSegment>;
  queuedAtMs: number;
  sequence: number;
};

type Remainder = {
  submission: NarrationQueueSubmission;
  /** The chapter's segments minus every segment the voice layer reported as completed. */
  segments: ReadonlyArray<NarrationQueueSegment>;
  interruptedPlanId: string | null;
  /** The operator's barge-in reason once `interrupt()` was called for this remainder. */
  interruptReason: string | null;
  resumeRequested: boolean;
};

type SessionState = {
  sessionId: string;
  sessionName: string;
  pending: Digest | null;
  remainder: Remainder | null;
  /** Newest revision heard back from the voice layer; 0 means nothing was heard yet. */
  heardRevision: number;
  /** Content keys of digests that were heard in full; a redelivery is `deduplicated`. */
  heardContentKeys: Set<string>;
};

type SpeakAttempt = Readonly<{
  deferred: boolean;
  planId: string | null;
  heard: ReadonlyArray<NarrationQueueSegment>;
  unheard: ReadonlyArray<NarrationQueueSegment>;
  failure: string | null;
}>;

function flattenSegments(submission: NarrationQueueSubmission): ReadonlyArray<NarrationQueueSegment> {
  return submission.chapters.flatMap((chapter) =>
    chapter.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      evidenceIds: [...segment.evidenceIds],
      maxSeconds: segment.maxSeconds,
    })));
}

/**
 * One utterance is one logical update: the segment list stays inside the §5.7 concise budget so a
 * mis-compiled digest cannot turn into minutes of queue. The first segment is always kept — an
 * empty plan would silently swallow the update instead of narrating it.
 */
function boundedSegments(
  segments: ReadonlyArray<NarrationQueueSegment>,
): ReadonlyArray<NarrationQueueSegment> {
  const chosen: NarrationQueueSegment[] = [];
  let words = 0;
  let seconds = 0;
  for (const segment of segments) {
    const segmentWords = wordCount(segment.text);
    if (
      chosen.length > 0
      && (words + segmentWords > NARRATION_MAX_DIGEST_WORDS
        || seconds + segment.maxSeconds > NARRATION_MAX_DIGEST_SECONDS)
    ) {
      break;
    }
    chosen.push(segment);
    words += segmentWords;
    seconds += segment.maxSeconds;
  }
  return chosen;
}

export function createNarrationQueue(options: NarrationQueueOptions): NarrationQueue {
  const { attention, voice } = options;
  const clock = options.now ?? ((): Date => new Date());
  const clockNow = (): number => clock().getTime();
  const sessions = new Map<string, SessionState>();
  const trail: NarrationQueueReceipt[] = [];
  /** Start time of the last background plan that actually reached the voice layer. */
  let lastBackgroundStartMs: number | null = null;
  let digestSequence = 0;
  let planSequence = 0;

  const emit = (receipt: NarrationQueueReceipt): NarrationQueueReceipt => {
    trail.push(receipt);
    if (trail.length > MAX_RECEIPTS) trail.splice(0, trail.length - MAX_RECEIPTS);
    return receipt;
  };

  const frame = (
    submission: NarrationQueueSubmission,
    outcome: NarrationQueueOutcome,
    reason: string,
    extra: Readonly<{ planId: string | null; segmentIds: ReadonlyArray<string> | null }> = { planId: null, segmentIds: null },
  ): NarrationQueueReceipt => ({
    sessionId: submission.sessionId,
    eventId: submission.eventId,
    outcome,
    reason,
    ...(extra.planId === null ? {} : { planId: extra.planId }),
    ...(extra.segmentIds === null ? {} : { segmentIds: extra.segmentIds }),
  });

  const sessionFor = (submission: NarrationQueueSubmission): SessionState => {
    const existing = sessions.get(submission.sessionId);
    if (existing !== undefined) {
      existing.sessionName = submission.sessionName;
      return existing;
    }
    const created: SessionState = {
      sessionId: submission.sessionId,
      sessionName: submission.sessionName,
      pending: null,
      remainder: null,
      heardRevision: 0,
      heardContentKeys: new Set<string>(),
    };
    sessions.set(submission.sessionId, created);
    return created;
  };

  const markHeard = (session: SessionState, submission: NarrationQueueSubmission): void => {
    session.heardRevision = Math.max(session.heardRevision, submission.revision);
    session.heardContentKeys.add(submission.contentKey);
  };

  const compareByQueueOrder = (left: SessionState, right: SessionState): number => {
    const leftDigest = left.pending;
    const rightDigest = right.pending;
    if (leftDigest === null || rightDigest === null) return 0;
    const rank = kindRank(leftDigest.submission.kind) - kindRank(rightDigest.submission.kind);
    if (rank !== 0) return rank;
    if (leftDigest.queuedAtMs !== rightDigest.queuedAtMs) {
      return leftDigest.queuedAtMs - rightDigest.queuedAtMs;
    }
    return leftDigest.sequence - rightDigest.sequence;
  };

  /**
   * One lease, one plan, one playback report. Nothing is spoken without a lease issued by the
   * shared policy, and only segments the voice layer reported as completed count as heard.
   */
  const attemptSpeak = async (
    submission: NarrationQueueSubmission,
    segments: ReadonlyArray<NarrationQueueSegment>,
    mode: 'speak' | 'resume',
  ): Promise<SpeakAttempt> => {
    const expiresAt = new Date(clockNow() + LEASE_TTL_MS).toISOString();
    const lease = attention.requestSpeech(submission.eventId, expiresAt);
    if (lease === null) {
      return { deferred: true, planId: null, heard: [], unheard: segments, failure: null };
    }
    planSequence += 1;
    const planId = `narration-queue:${submission.sessionId}:${submission.eventId}:${mode}:${planSequence}`;
    const plan: SpeechPlan = {
      planId,
      sessionId: submission.sessionId,
      epoch: lease.epoch,
      priority: priorityFor(submission.kind),
      expiresAt: lease.expiresAt,
      dedupeKey: `${submission.sessionId}:${submission.contentKey}:${submission.revision}:${mode}:${planSequence}`,
      segments: segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        evidenceIds: [...segment.evidenceIds],
        exact: false,
        maxSeconds: segment.maxSeconds,
      })),
      resume: mode === 'resume' ? 'automatic' : 'offer',
    };
    let output: ReadonlyArray<VoiceOutputEvent>;
    try {
      output = await voice.submitSpeech(plan, lease);
    } catch (error) {
      return {
        deferred: false,
        planId,
        heard: [],
        unheard: segments,
        failure: `the voice layer rejected playback: ${errorText(error)}`,
      };
    }
    const completed = new Set(
      output.filter((event) => event.status === 'completed').map((event) => event.segmentId),
    );
    return {
      deferred: false,
      planId,
      heard: segments.filter((segment) => completed.has(segment.id)),
      unheard: segments.filter((segment) => !completed.has(segment.id)),
      failure: null,
    };
  };

  /** Applies one playback report: heard state, the preserved remainder, and its receipt. */
  const applyAttempt = (
    session: SessionState,
    submission: NarrationQueueSubmission,
    planned: ReadonlyArray<NarrationQueueSegment>,
    attempt: SpeakAttempt,
    mode: 'speak' | 'resume',
    created: NarrationQueueReceipt[],
  ): void => {
    if (attempt.unheard.length === 0) {
      markHeard(session, submission);
      created.push(emit(frame(
        submission,
        mode === 'resume' ? 'resumed' : 'spoken',
        mode === 'resume'
          ? `the preserved unheard remainder was narrated through a fresh plan (${attempt.heard.length} segment(s))`
          : `the whole digest was heard (${attempt.heard.length} segment(s))`,
        { planId: attempt.planId, segmentIds: attempt.heard.map((segment) => segment.id) },
      )));
      return;
    }
    session.remainder = {
      submission,
      segments: attempt.unheard,
      interruptedPlanId: attempt.planId,
      interruptReason: null,
      resumeRequested: false,
    };
    created.push(emit(frame(
      submission,
      'interrupted',
      attempt.failure
        ?? `playback stopped after ${attempt.heard.length} of ${planned.length} segment(s); only the unheard remainder is preserved`,
      { planId: attempt.planId, segmentIds: attempt.unheard.map((segment) => segment.id) },
    )));
  };

  const speakFirst = async (
    session: SessionState,
    digest: Digest,
    created: NarrationQueueReceipt[],
  ): Promise<boolean> => {
    if (digest.segments.length === 0) {
      session.pending = null;
      created.push(emit(frame(digest.submission, 'discarded', 'the digest carried no speakable segment')));
      return false;
    }
    const attempt = await attemptSpeak(digest.submission, digest.segments, 'speak');
    if (attempt.deferred) {
      created.push(emit(frame(
        digest.submission,
        'deferred',
        'the shared speech policy granted no lease, so the digest stays pending',
        { planId: null, segmentIds: digest.segments.map((segment) => segment.id) },
      )));
      return false;
    }
    session.pending = null;
    applyAttempt(session, digest.submission, digest.segments, attempt, 'speak', created);
    return true;
  };

  const expireStalePendings = (created: NarrationQueueReceipt[]): void => {
    const currentMs = clockNow();
    for (const session of sessions.values()) {
      const pending = session.pending;
      if (pending === null) continue;
      if (currentMs - pending.queuedAtMs <= PENDING_STALE_AFTER_MS) continue;
      session.pending = null;
      created.push(emit(frame(
        pending.submission,
        'discarded',
        `the digest stayed unspeakable for ${currentMs - pending.queuedAtMs}ms and expired instead of queueing stale speech`,
        { planId: null, segmentIds: pending.segments.map((segment) => segment.id) },
      )));
    }
  };

  /** A pending digest whose session has since heard a newer (or the same) outcome never speaks. */
  const dropSupersededPendings = (created: NarrationQueueReceipt[]): void => {
    for (const session of sessions.values()) {
      const pending = session.pending;
      if (pending === null) continue;
      const outHeard = pending.submission.revision <= session.heardRevision;
      const duplicate = session.heardContentKeys.has(pending.submission.contentKey);
      if (!outHeard && !duplicate) continue;
      session.pending = null;
      created.push(emit(frame(
        pending.submission,
        outHeard ? 'superseded' : 'deduplicated',
        outHeard
          ? `a newer outcome of this session (heard revision ${session.heardRevision}) superseded it before it spoke`
          : 'the identical digest content was already heard and is never spoken twice',
        { planId: null, segmentIds: pending.segments.map((segment) => segment.id) },
      )));
    }
  };

  const pumpRemainders = async (created: NarrationQueueReceipt[]): Promise<void> => {
    for (const session of [...sessions.values()]) {
      const remainder = session.remainder;
      if (remainder === null || !remainder.resumeRequested) continue;
      const segmentIds = remainder.segments.map((segment) => segment.id);
      if (session.heardRevision >= remainder.submission.revision) {
        session.remainder = null;
        created.push(emit(frame(
          remainder.submission,
          'discarded',
          `a newer outcome of this session (heard revision ${session.heardRevision}) was heard, so the stale remainder was not resumed`,
          { planId: remainder.interruptedPlanId, segmentIds },
        )));
        continue;
      }
      const attempt = await attemptSpeak(remainder.submission, remainder.segments, 'resume');
      if (attempt.deferred) {
        created.push(emit(frame(
          remainder.submission,
          'deferred',
          'the resume found no speech lease, so the unheard remainder stays resumable',
          { planId: null, segmentIds },
        )));
        continue;
      }
      session.remainder = null;
      applyAttempt(session, remainder.submission, remainder.segments, attempt, 'resume', created);
    }
  };

  const speakForeground = async (created: NarrationQueueReceipt[]): Promise<void> => {
    const candidates = [...sessions.values()]
      .filter((session) => session.pending !== null && session.pending.submission.kind === 'user-requested')
      .sort(compareByQueueOrder);
    for (const session of candidates) {
      const digest = session.pending;
      if (digest === null) continue;
      await speakFirst(session, digest, created);
    }
  };

  const speakBackground = async (created: NarrationQueueReceipt[]): Promise<void> => {
    const currentMs = clockNow();
    if (
      lastBackgroundStartMs !== null
      && currentMs - lastBackgroundStartMs < NARRATION_BACKGROUND_MIN_GAP_MS
    ) {
      return;
    }
    const candidate = [...sessions.values()]
      .filter((session) => session.pending !== null && session.pending.submission.kind !== 'user-requested')
      .sort(compareByQueueOrder)[0];
    if (candidate === undefined) return;
    const digest = candidate.pending;
    if (digest === null) return;
    const started = await speakFirst(candidate, digest, created);
    if (started) {
      // Only a plan that reached the voice layer consumes the background budget; a deferred
      // attempt must not push the next one out by a whole gap.
      lastBackgroundStartMs = currentMs;
    }
  };

  const pump = async (created: NarrationQueueReceipt[]): Promise<void> => {
    expireStalePendings(created);
    dropSupersededPendings(created);
    await pumpRemainders(created);
    await speakForeground(created);
    await speakBackground(created);
  };

  const submit = async (
    submission: NarrationQueueSubmission,
  ): Promise<ReadonlyArray<NarrationQueueReceipt>> => {
    const session = sessionFor(submission);
    const created: NarrationQueueReceipt[] = [];

    if (submission.revision <= session.heardRevision) {
      const alreadyHeard = session.heardContentKeys.has(submission.contentKey)
        || submission.revision === session.heardRevision;
      created.push(emit(frame(
        submission,
        alreadyHeard ? 'deduplicated' : 'superseded',
        `this session already heard revision ${session.heardRevision}, so revision ${submission.revision} is never narrated`,
      )));
      return created;
    }
    if (session.heardContentKeys.has(submission.contentKey)) {
      created.push(emit(frame(
        submission,
        'deduplicated',
        'the identical digest content was already heard and is never spoken twice',
      )));
      return created;
    }

    const pending = session.pending;
    if (pending !== null) {
      if (submission.revision < pending.submission.revision) {
        created.push(emit(frame(
          submission,
          'superseded',
          `revision ${submission.revision} is older than this session's pending revision ${pending.submission.revision}`,
        )));
        return created;
      }
      if (
        submission.revision === pending.submission.revision
        || submission.contentKey === pending.submission.contentKey
      ) {
        created.push(emit(frame(
          submission,
          'deduplicated',
          `this session's pending digest already carries revision ${pending.submission.revision}`,
        )));
        return created;
      }
      created.push(emit(frame(
        pending.submission,
        'coalesced',
        `replaced by the newer revision ${submission.revision} of this session before it was heard`,
        { planId: null, segmentIds: pending.segments.map((segment) => segment.id) },
      )));
    }

    digestSequence += 1;
    session.pending = {
      submission,
      segments: boundedSegments(flattenSegments(submission)),
      queuedAtMs: clockNow(),
      sequence: digestSequence,
    };
    return created;
  };

  const tick = async (): Promise<ReadonlyArray<NarrationQueueReceipt>> => {
    const created: NarrationQueueReceipt[] = [];
    await pump(created);
    return created;
  };

  const interrupt = (reason: string): void => {
    for (const session of sessions.values()) {
      const remainder = session.remainder;
      if (remainder === null) continue;
      remainder.resumeRequested = false;
      if (remainder.interruptReason !== null) continue;
      remainder.interruptReason = reason;
      emit(frame(
        remainder.submission,
        'interrupted',
        `playback was interrupted (${reason}); the unheard remainder is preserved`,
        {
          planId: remainder.interruptedPlanId,
          segmentIds: remainder.segments.map((segment) => segment.id),
        },
      ));
    }
  };

  const resume = async (sessionId?: string): Promise<ReadonlyArray<NarrationQueueReceipt>> => {
    const created: NarrationQueueReceipt[] = [];
    if (sessionId === undefined) {
      for (const session of sessions.values()) {
        if (session.remainder !== null) session.remainder.resumeRequested = true;
      }
    } else {
      const session = sessions.get(sessionId);
      if (session === undefined || session.remainder === null) return created;
      session.remainder.resumeRequested = true;
    }
    await pump(created);
    return created;
  };

  const pending = (): ReadonlyArray<NarrationQueuePendingDigest> => {
    const waiting: NarrationQueuePendingDigest[] = [];
    for (const session of [...sessions.values()].sort(compareByQueueOrder)) {
      const digest = session.pending;
      if (digest === null) continue;
      waiting.push({
        sessionId: session.sessionId,
        eventId: digest.submission.eventId,
        kind: digest.submission.kind,
      });
    }
    return waiting;
  };

  return {
    submit,
    tick,
    interrupt,
    resume,
    pending,
    receipts: () => trail.slice(),
  };
}
