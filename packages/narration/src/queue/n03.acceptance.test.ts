/**
 * N03 acceptance oracle — overlapping sessions and interrupted summaries → relevant resumed digest
 * (IMPLEMENTATION_PLAN.md §7.2 N03, §5.7 narration stages 4–6, §5.3 SpeechPlan/SpeechLease;
 * BACKLOG N03).
 *
 * `packages/narration/src/queue/index.ts` must export (this file freezes these names; they are the
 * N03 seam between the N02 compiled digests and the shared speech-lease/V02 playback contracts):
 *
 *   createNarrationQueue({ attention, voice, now }) → NarrationQueue
 *
 *     attention — the shared §5.7 speech-lease granter, exactly as N01 consumes it:
 *       requestSpeech(eventId, expiresAt) → SpeechLease | null
 *         The queue asks for a lease at speak time, for the durable event of the digest it intends
 *         to narrate. `null` means the digest stays deferred (never dropped, never spoken).
 *
 *     voice — the V02 playback seam:
 *       submitSpeech(plan, lease) → Promise<VoiceOutputEvent[]>
 *         The returned events are the *actual* playback progress: a `completed` segment was heard,
 *         a `cancelled` segment (or a segment with no event) was not. Generated-but-unheard speech
 *         is never heard speech (§ V-F3).
 *
 *     now — optional deterministic clock (defaults to the system clock).
 *
 *     queue:
 *       submit(submission) → Promise<QueueReceipt[]>
 *         submission: { sessionId, sessionName, turnId, revision, eventId, contentKey, kind,
 *         chapters: [{ id, segments: [{ id, text, evidenceIds, maxSeconds }] }] }
 *           kind      'turn-complete' | 'important-failure' | 'user-requested' | 'background-session'
 *           revision  monotonic per-session digest revision
 *         Batching is per session, not by arrival order: the newest pending digest of a session
 *         replaces older pending ones, and a submission below the newest revision already heard for
 *         its session is superseded. A `user-requested` digest is never coalesced away. Background
 *         digests start at most one per budgets.backgroundMinGapMs; the foreground reply speaks at
 *         the first opportunity and is never starved.
 *       tick() → Promise<QueueReceipt[]>
 *         Re-evaluates pending digests against the injected clock and speaks what the attention
 *         policy and the speech budget now allow.
 *       interrupt(reason) → void
 *         Playback stopped mid-chapter (barge-in/stop). Only segments the voice layer reported as
 *         completed count as heard; the unheard remainder of the newest relevant chapter stays
 *         resumable, while a remainder superseded by a newer heard outcome is discarded.
 *       resume(sessionId?) → Promise<QueueReceipt[]>
 *         Speaks the preserved unheard remainder through a fresh lease; nothing already heard is
 *         repeated, and a stale remainder produces no audio.
 *       pending() → ReadonlyArray<{ sessionId, eventId, kind }> — digests waiting for their first
 *         utterance.
 *       receipts() → ReadonlyArray<QueueReceipt>
 *         QueueReceipt: { sessionId, eventId, outcome, reason, planId?, segmentIds? } with
 *         outcome ∈ 'spoken' | 'deferred' | 'superseded' | 'coalesced' | 'deduplicated'
 *         | 'interrupted' | 'resumed' | 'discarded'.
 *
 * Deterministic scope: `fixtures/narration/concurrent/check-concurrent-sessions.mjs` builds the
 * synthetic concurrent stream offline and the oracle freezes its digest, so the fixture cannot be
 * reshaped to fit an implementation. The labels the oracle asserts against (which phrase belongs to
 * which digest, when each submission arrives) live only in the fixture and are never handed to the
 * queue. The oracle drives every scenario with a fake clock and deterministic attention/voice
 * doubles and decides all three acceptance criteria from the *audible* record the voice double
 * reports plus the queue's receipt trail.
 *
 * Remaining limitation: this is a deterministic simulation of the arbitration seams, not live TTS
 * playback. Real barge-in timing, microphone capture and audio rendering stay covered by the V02/V03
 * oracles; every acceptance criterion here is decided offline from frozen evidence.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SpeechLease, SpeechPlan, VoiceOutputEvent } from '../../../contracts/src/index.js';

const FIXTURE_SCRIPT = fileURLToPath(
  new URL('../../../../fixtures/narration/concurrent/check-concurrent-sessions.mjs', import.meta.url),
);
/** Frozen with `node fixtures/narration/concurrent/check-concurrent-sessions.mjs --summary`. */
const FIXTURE_DIGEST = 'sha256:6a04697b2d8a18fddab24c5e20a0eb3aa0bd03d95b8c46dd5656956a6d05a350';
/** §5.7 speech budgets the queue must obey under three-session burst traffic. */
const BACKGROUND_MIN_GAP_MS = 3_000;
const MAX_DIGEST_WORDS = 50;
const MAX_DIGEST_SECONDS = 20;

type QueueKind =
  | 'turn-complete'
  | 'important-failure'
  | 'user-requested'
  | 'background-session'
  | 'routine-progress';

type QueueSegment = Readonly<{ id: string; text: string; evidenceIds: ReadonlyArray<string>; maxSeconds: number }>;
type QueueChapter = Readonly<{ id: string; segments: ReadonlyArray<QueueSegment> }>;

type QueueSubmission = Readonly<{
  sessionId: string;
  sessionName: string;
  turnId: string;
  revision: number;
  eventId: string;
  contentKey: string;
  kind: QueueKind;
  chapters: ReadonlyArray<QueueChapter>;
}>;

type QueueReceipt = Readonly<{
  sessionId: string;
  eventId: string;
  outcome: string;
  reason: string;
  planId?: string;
  segmentIds?: ReadonlyArray<string>;
}>;

type PendingDigest = Readonly<{ sessionId: string; eventId: string; kind: string }>;

type NarrationQueue = Readonly<{
  submit(submission: QueueSubmission): Promise<ReadonlyArray<QueueReceipt>>;
  tick(): Promise<ReadonlyArray<QueueReceipt>>;
  interrupt(reason: string): void;
  resume(sessionId?: string): Promise<ReadonlyArray<QueueReceipt>>;
  pending(): ReadonlyArray<PendingDigest>;
  receipts(): ReadonlyArray<QueueReceipt>;
}>;

type QueueAttention = Readonly<{ requestSpeech(eventId: string, expiresAt: string): SpeechLease | null }>;
type QueueVoice = Readonly<{
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;

type CreateNarrationQueue = (
  options: Readonly<{ attention: QueueAttention; voice: QueueVoice; now?: () => Date }>,
) => NarrationQueue;

async function queueFactory(): Promise<CreateNarrationQueue> {
  const fail = (detail: string): never => assert.fail(
    'N03 required narration behavior is not implemented yet: packages/narration/src/queue/index.ts must '
    + 'export createNarrationQueue({ attention, voice, now }) with submit/tick/interrupt/resume/pending/'
    + `receipts so overlapping sessions coalesce, stale summaries are invalidated, and interrupted `
    + `chapters resume with only their unheard remainder. ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists the import resolves to
  // nothing, and that is reported below as the missing behavior instead of a resolution crash.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return fail(`importing packages/narration/src/queue/${specifier.slice(2)} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createNarrationQueue !== 'function') {
    return fail('createNarrationQueue({ attention, voice, now }) is not exported');
  }
  return loaded.createNarrationQueue as CreateNarrationQueue;
}

type FixtureSegment = Readonly<{ id: string; text: string; evidenceIds: ReadonlyArray<string>; maxSeconds: number }>;
type FixtureChapter = Readonly<{ id: string; segments: ReadonlyArray<FixtureSegment> }>;
type FixtureSubmission = Readonly<{
  sessionId: string;
  sessionName: string;
  turnId: string;
  revision: number;
  eventId: string;
  contentKey: string;
  kind: string;
  atMs: number;
  phrase: string;
  chapters: ReadonlyArray<FixtureChapter>;
}>;

type FixtureBudgets = Readonly<{
  backgroundMinGapMs: number;
  maxDigestWords: number;
  maxDigestSeconds: number;
  staleAfterMs: number;
}>;

type FixtureDocument = Readonly<{
  contractVersion: number;
  fixtureId: string;
  consent: string;
  seed: string;
  clockStart: string;
  budgets: FixtureBudgets;
  scenarios: Readonly<{
    supersession: Readonly<{
      sessionId: string;
      sessionName: string;
      taskId: string;
      stale: FixtureSubmission;
      newer: FixtureSubmission;
      lateDuplicateOf: string;
    }>;
    interrupt: Readonly<{
      sessionId: string;
      sessionName: string;
      taskId: string;
      digest: FixtureSubmission;
      approvalSegmentId: string;
      approvalPhrase: string;
      heardSegmentIds: ReadonlyArray<string>;
      remainderSegmentIds: ReadonlyArray<string>;
      superseding: FixtureSubmission;
    }>;
    burst: Readonly<{
      sessions: ReadonlyArray<Readonly<{ sessionId: string; sessionName: string }>>;
      schedule: ReadonlyArray<FixtureSubmission>;
      foreground: FixtureSubmission;
      tickTimesMs: ReadonlyArray<number>;
    }>;
  }>;
  digest: string;
  stats: Readonly<{ submissions: number; segments: number; sessions: number; burstSubmissions: number }>;
}>;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      ordered[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return ordered;
  }
  return value;
}

/** Recomputes the fixture digest exactly like `check-concurrent-sessions.mjs` does. */
function fixtureDigest(document: FixtureDocument): string {
  const base = {
    contractVersion: document.contractVersion,
    fixtureId: document.fixtureId,
    consent: document.consent,
    seed: document.seed,
    clockStart: document.clockStart,
    budgets: document.budgets,
    scenarios: document.scenarios,
  };
  return `sha256:${sha256(JSON.stringify(canonicalize(base)))}`;
}

function loadFixture(): FixtureDocument {
  const result = spawnSync(process.execPath, [FIXTURE_SCRIPT, '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `the N03 concurrent fixture must self-validate:\n${result.stderr ?? ''}`);
  const document = JSON.parse(result.stdout) as FixtureDocument;
  assert.equal(document.contractVersion, 1, 'the N03 fixture must speak contract version 1');
  assert.equal(document.consent, 'synthetic', 'the N03 fixture must stay synthetic');
  assert.equal(document.stats.submissions, 17, 'the N03 fixture must materialize 17 submissions');
  assert.equal(document.stats.segments, 20, 'the N03 fixture must materialize 20 spoken segments');
  assert.equal(fixtureDigest(document), FIXTURE_DIGEST, 'the frozen N03 fixture changed');
  assert.equal(document.digest, FIXTURE_DIGEST, 'the fixture must report its own frozen digest');
  return document;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
}

function spokenTextOf(entry: FixtureSubmission): string {
  return entry.chapters.flatMap((chapter) => chapter.segments.map((segment) => segment.text)).join(' ');
}

function segmentIdsOf(entry: FixtureSubmission): ReadonlyArray<string> {
  return entry.chapters.flatMap((chapter) => chapter.segments.map((segment) => segment.id));
}

function totalSecondsOf(entry: FixtureSubmission): number {
  return entry.chapters.flatMap((chapter) => chapter.segments).reduce((total, segment) => total + segment.maxSeconds, 0);
}

/** The queue consumes the projection without the fixture's ground-truth labels. */
function submissionInput(entry: FixtureSubmission): QueueSubmission {
  return {
    sessionId: entry.sessionId,
    sessionName: entry.sessionName,
    turnId: entry.turnId,
    revision: entry.revision,
    eventId: entry.eventId,
    contentKey: entry.contentKey,
    kind: entry.kind as QueueKind,
    chapters: entry.chapters.map((chapter) => ({
      id: chapter.id,
      segments: chapter.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        evidenceIds: segment.evidenceIds,
        maxSeconds: segment.maxSeconds,
      })),
    })),
  };
}

function fixtureSubmissions(document: FixtureDocument): ReadonlyArray<FixtureSubmission> {
  const { supersession, interrupt, burst } = document.scenarios;
  return [
    supersession.stale,
    supersession.newer,
    interrupt.digest,
    interrupt.superseding,
    ...burst.schedule,
    burst.foreground,
  ];
}

type FakeClock = Readonly<{
  now(): Date;
  at(atMs: number): void;
  /** Milliseconds since the fixture clock start, the time base receipts and playback use. */
  atMsForTest(): number;
}>;

function fakeClock(startIso: string): FakeClock {
  const start = Date.parse(startIso);
  let current = start;
  return {
    now: () => new Date(current),
    at(atMs) {
      current = start + atMs;
    },
    atMsForTest: () => current - start,
  };
}

type FakeAttention = Readonly<{
  requests: Array<Readonly<{ eventId: string; atMs: number }>>;
  issued: Set<SpeechLease>;
  setClosed(closed: boolean): void;
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
}>;

/** The shared attention policy double: it only hands out leases it issued itself. */
function fakeAttention(clock: FakeClock): FakeAttention {
  const requests: Array<Readonly<{ eventId: string; atMs: number }>> = [];
  const issued = new Set<SpeechLease>();
  let closed = false;
  let epoch = 0;
  return {
    requests,
    issued,
    setClosed(value) {
      closed = value;
    },
    requestSpeech(eventId, expiresAt) {
      requests.push({ eventId, atMs: clock.now().getTime() });
      if (closed) return null;
      epoch += 1;
      const lease: SpeechLease = { eventId, epoch, expiresAt };
      issued.add(lease);
      return lease;
    },
  };
}

type AudibleUtterance = Readonly<{
  planId: string;
  sessionId: string;
  dedupeKey: string;
  atMs: number;
  segmentIds: ReadonlyArray<string>;
  texts: ReadonlyArray<string>;
  evidenceIds: ReadonlyArray<string>;
  maxSeconds: number;
  words: number;
}>;

type VoiceSubmission = Readonly<{
  plan: SpeechPlan;
  lease: SpeechLease;
  approved: boolean;
  reason: string | null;
  atMs: number;
}>;

type FakeVoice = {
  submissions: Array<VoiceSubmission>;
  audible: Array<AudibleUtterance>;
  violations: Array<string>;
  /** Complete this many segments, then report the next one cancelled and stop (null = play all). */
  cutAfterSegments: number | null;
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
};

/** The V02 boundary double: a lease must be live, and only play-reported segments count as heard. */
function fakeVoice(attention: FakeAttention, clock: FakeClock): FakeVoice {
  const submissions: Array<VoiceSubmission> = [];
  const audible: Array<AudibleUtterance> = [];
  const violations: Array<string> = [];
  const voice: FakeVoice = {
    submissions,
    audible,
    violations,
    cutAfterSegments: null,
    async submitSpeech(plan, lease) {
      const nowMs = clock.now().getTime();
      if (!attention.issued.has(lease)) {
        violations.push(`plan ${plan.planId} was submitted with a lease attention never issued`);
        return [];
      }
      const reasons: Array<string> = [];
      if (lease.epoch !== plan.epoch) reasons.push('lease epoch does not match the plan epoch');
      if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= nowMs) {
        reasons.push('lease expired');
      }
      if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= nowMs) {
        reasons.push('plan expired');
      }
      const approved = reasons.length === 0;
      submissions.push({ plan, lease, approved, reason: approved ? null : reasons.join('; '), atMs: clock.atMsForTest() });
      if (!approved) return [];
      const cut = voice.cutAfterSegments;
      const completed = cut === null || cut >= plan.segments.length
        ? plan.segments
        : plan.segments.slice(0, Math.max(0, cut));
      const events: Array<VoiceOutputEvent> = [];
      for (const segment of completed) {
        events.push({
          planId: plan.planId,
          segmentId: segment.id,
          positionMs: Math.round(segment.maxSeconds * 1_000),
          status: 'completed',
        });
      }
      if (completed.length < plan.segments.length) {
        const cancelled = plan.segments[completed.length];
        if (cancelled !== undefined) {
          events.push({ planId: plan.planId, segmentId: cancelled.id, positionMs: 0, status: 'cancelled' });
        }
      }
      if (completed.length > 0) {
        audible.push({
          planId: plan.planId,
          sessionId: plan.sessionId ?? '',
          dedupeKey: plan.dedupeKey,
          atMs: clock.atMsForTest(),
          segmentIds: completed.map((segment) => segment.id),
          texts: completed.map((segment) => segment.text),
          evidenceIds: completed.flatMap((segment) => [...segment.evidenceIds]),
          maxSeconds: completed.reduce((total, segment) => total + segment.maxSeconds, 0),
          words: completed.reduce((total, segment) => total + wordCount(segment.text), 0),
        });
      }
      return events;
    },
  };
  return voice;
}

function audibleText(utterance: AudibleUtterance): string {
  return utterance.texts.join(' ');
}

function allAudibleText(voice: FakeVoice): string {
  return voice.audible.map((utterance) => audibleText(utterance)).join(' ');
}

function receiptFor(queue: NarrationQueue, eventId: string, outcomes: ReadonlyArray<string>, since = 0): QueueReceipt {
  const matches = queue.receipts().slice(since).filter(
    (receipt) => receipt.eventId === eventId && outcomes.includes(receipt.outcome),
  );
  const found = matches[0];
  assert.ok(
    found,
    `${eventId} must produce a receipt with outcome ${outcomes.join('|')} after index ${since}; trail: `
    + JSON.stringify(queue.receipts().slice(since)),
  );
  assert.ok(typeof found.reason === 'string' && found.reason.length > 0, `${eventId}: a receipt must explain itself`);
  return found;
}

const fixture = loadFixture();

test('N03 fixture: the concurrent stream is deterministic, synthetic, and internally consistent', () => {
  assert.equal(fixture.seed, 'n03-concurrent-2026-09-21');
  assert.deepEqual(fixture.budgets, {
    backgroundMinGapMs: BACKGROUND_MIN_GAP_MS,
    maxDigestWords: MAX_DIGEST_WORDS,
    maxDigestSeconds: MAX_DIGEST_SECONDS,
    staleAfterMs: 90_000,
  });

  const submissions = fixtureSubmissions(fixture);
  const phrases = submissions.map((entry) => entry.phrase);
  assert.equal(new Set(phrases).size, phrases.length, 'every digest phrase must be globally unique');
  assert.equal(new Set(submissions.map((entry) => entry.eventId)).size, submissions.length, 'event ids must be unique');
  for (const entry of submissions) {
    const text = spokenTextOf(entry);
    assert.ok(text.includes(entry.phrase), `${entry.eventId}: its phrase must be part of its own digest`);
    assert.ok(wordCount(text) <= MAX_DIGEST_WORDS, `${entry.eventId}: the digest exceeds the concise word budget`);
    assert.ok(totalSecondsOf(entry) <= MAX_DIGEST_SECONDS, `${entry.eventId}: the digest exceeds the turn-complete second budget`);
    for (const segment of entry.chapters.flatMap((chapter) => chapter.segments)) {
      assert.ok(segment.evidenceIds.length > 0, `${segment.id}: spoken segments cite durable evidence`);
    }
  }

  const { supersession, interrupt, burst } = fixture.scenarios;
  assert.ok(supersession.stale.revision < supersession.newer.revision, 'the newer outcome must carry the higher revision');
  assert.equal(supersession.lateDuplicateOf, 'stale');

  const interruptSegments = segmentIdsOf(interrupt.digest);
  assert.deepEqual(
    [...interrupt.heardSegmentIds, ...interrupt.remainderSegmentIds],
    interruptSegments,
    'the heard + remainder segments must cover the interrupted chapter exactly once',
  );
  assert.equal(interruptSegments[0], interrupt.approvalSegmentId, 'the approval segment is the chapter opening');
  assert.ok(spokenTextOf(interrupt.digest).includes(interrupt.approvalPhrase), 'the approval phrase must be spoken');
  assert.ok(
    spokenTextOf(interrupt.digest).includes(interrupt.digest.phrase),
    'the resumable remainder must carry the digest phrase',
  );

  assert.equal(burst.sessions.length, 3, 'a burst is three sessions');
  assert.equal(burst.schedule.length, 12, 'the burst is twelve rapid submissions');
  assert.equal(new Set(burst.schedule.map((entry) => entry.sessionId)).size, 3, 'the burst interleaves three sessions');
  for (const session of burst.sessions) {
    const revisions = burst.schedule.filter((entry) => entry.sessionId === session.sessionId).map((entry) => entry.revision);
    assert.deepEqual(revisions, [1, 2, 3, 4], `${session.sessionId} must burst four monotonic revisions`);
  }
  assert.equal(burst.foreground.kind, 'user-requested');
  assert.ok(
    burst.foreground.atMs > 0 && burst.foreground.atMs < BACKGROUND_MIN_GAP_MS,
    'the foreground reply must arrive while the background backlog cannot all have been spoken',
  );
  assert.ok(burst.tickTimesMs.length >= 8, 'the burst window is ticked across several seconds');
});

test('N03: a superseded completion is never narrated after the newer outcome has been heard', async () => {
  const createNarrationQueue = await queueFactory();
  const { supersession } = fixture.scenarios;
  const clock = fakeClock(fixture.clockStart);
  const attention = fakeAttention(clock);
  const voice = fakeVoice(attention, clock);
  const queue = createNarrationQueue({ attention, voice, now: clock.now });

  // The failure is produced while the shared policy grants nothing: it must wait, not speak.
  attention.setClosed(true);
  clock.at(0);
  await queue.submit(submissionInput(supersession.stale));
  clock.at(500);
  await queue.tick();
  assert.equal(voice.audible.length, 0, 'nothing may be spoken while attention grants no lease');
  assert.ok(
    attention.requests.some((request) => request.eventId === supersession.stale.eventId),
    'the queue must ask the shared policy before speaking',
  );
  receiptFor(queue, supersession.stale.eventId, ['deferred', 'pending'], 0);

  // The newer outcome for the same session arrives before the failure ever spoke: it supersedes it.
  clock.at(1_000);
  await queue.submit(submissionInput(supersession.newer));
  clock.at(1_500);
  await queue.tick();
  assert.equal(voice.audible.length, 0, 'still no lease: neither digest may be narrated');
  receiptFor(queue, supersession.stale.eventId, ['superseded', 'coalesced']);

  attention.setClosed(false);
  clock.at(2_000);
  await queue.tick();
  assert.equal(voice.audible.length, 1, 'once a lease is granted, exactly the newest digest is narrated once');
  const heard = audibleText(voice.audible[0]!);
  assert.ok(heard.includes(supersession.newer.phrase), `the newer outcome must be narrated: ${heard}`);
  assert.ok(!heard.includes(supersession.stale.phrase), 'the superseded failure must not be narrated');
  assert.equal(voice.violations.length, 0, `every utterance needs a live lease: ${voice.violations.join('; ')}`);

  // A redelivery of the stale turn arrives after the newer outcome has been heard.
  const staleMark = queue.receipts().length;
  clock.at(3_000);
  await queue.submit(submissionInput(supersession.stale));
  clock.at(3_500);
  await queue.tick();
  assert.equal(
    voice.audible.length,
    1,
    'a superseded failure must never be narrated after the newer outcome has been heard',
  );
  assert.ok(!allAudibleText(voice).includes(supersession.stale.phrase));
  receiptFor(queue, supersession.stale.eventId, ['superseded', 'deduplicated'], staleMark);

  // The heard digest itself is deduplicated: heard state means never spoken twice.
  const newerMark = queue.receipts().length;
  clock.at(4_000);
  await queue.submit(submissionInput(supersession.newer));
  clock.at(4_500);
  await queue.tick();
  assert.equal(voice.audible.length, 1, 'a digest that was already heard must be deduplicated, not repeated');
  receiptFor(queue, supersession.newer.eventId, ['deduplicated', 'superseded'], newerMark);
  assert.deepEqual(voice.violations, []);
});

test('N03: an interrupt preserves only the relevant unheard remainder and never repeats a heard approval', async () => {
  const createNarrationQueue = await queueFactory();
  const { interrupt } = fixture.scenarios;
  const digestSegments = segmentIdsOf(interrupt.digest);
  const remainderIds = [...interrupt.remainderSegmentIds];

  // Part A — interrupt mid-chapter, then resume: only the unheard tail is spoken.
  const clock = fakeClock(fixture.clockStart);
  const attention = fakeAttention(clock);
  const voice = fakeVoice(attention, clock);
  voice.cutAfterSegments = interrupt.heardSegmentIds.length;
  const queue = createNarrationQueue({ attention, voice, now: clock.now });

  clock.at(0);
  await queue.submit(submissionInput(interrupt.digest));
  clock.at(500);
  await queue.tick();
  assert.equal(voice.audible.length, 1, 'the chapter starts as one spoken plan');
  const firstPlan = voice.audible[0]!;
  assert.deepEqual(firstPlan.segmentIds, interrupt.heardSegmentIds, 'only the first segment finished before the interrupt');
  assert.ok(audibleText(firstPlan).includes(interrupt.approvalPhrase), 'the approval segment was heard once');

  queue.interrupt('user-speech');
  clock.at(2_000);
  voice.cutAfterSegments = null;
  const resumeMark = queue.receipts().length;
  await queue.resume(interrupt.sessionId);
  clock.at(2_500);
  await queue.tick();

  assert.equal(voice.audible.length, 2, 'the resume speaks exactly the preserved remainder');
  const resumed = voice.audible[1]!;
  assert.notEqual(resumed.planId, firstPlan.planId, 'a resume is a new plan for the remainder, not a replay of the old plan');
  assert.deepEqual(resumed.segmentIds, remainderIds, 'only the unheard remainder of the chapter may resume');
  assert.deepEqual(
    resumed.evidenceIds.slice().sort(),
    interrupt.digest.chapters
      .flatMap((chapter) => chapter.segments)
      .filter((segment) => remainderIds.includes(segment.id))
      .flatMap((segment) => [...segment.evidenceIds])
      .sort(),
    'the resumed segments keep citing the durable evidence of the remainder',
  );
  const heardText = allAudibleText(voice);
  const approvalOccurrences = heardText.split(interrupt.approvalPhrase).length - 1;
  assert.equal(approvalOccurrences, 1, 'an old, already-heard approval must never be spoken again');
  assert.equal(
    voice.audible.flatMap((utterance) => utterance.segmentIds).length,
    digestSegments.length,
    'every chapter segment is heard exactly once across the interrupt and the resume',
  );
  assert.deepEqual([...new Set(voice.audible.flatMap((utterance) => utterance.segmentIds))], digestSegments);
  assert.ok(
    queue.receipts().slice(resumeMark).some((receipt) => receipt.eventId === interrupt.digest.eventId),
    'the resume must be receipted against the interrupted digest',
  );
  assert.deepEqual(voice.violations, []);

  // Part B — the remainder loses its relevance while interrupted: the newer outcome is heard first,
  // so the stale tail must be discarded instead of resumed.
  const clockB = fakeClock(fixture.clockStart);
  const attentionB = fakeAttention(clockB);
  const voiceB = fakeVoice(attentionB, clockB);
  voiceB.cutAfterSegments = interrupt.heardSegmentIds.length;
  const queueB = createNarrationQueue({ attention: attentionB, voice: voiceB, now: clockB.now });

  clockB.at(0);
  await queueB.submit(submissionInput(interrupt.digest));
  clockB.at(500);
  await queueB.tick();
  queueB.interrupt('user-speech');
  assert.equal(voiceB.audible.length, 1, 'the chapter is interrupted after the approval segment');

  clockB.at(interrupt.superseding.atMs);
  await queueB.submit(submissionInput(interrupt.superseding));
  await queueB.tick();
  const superseding = voiceB.audible.find(
    (utterance) => utterance.segmentIds.includes(interrupt.superseding.chapters[0]!.segments[0]!.id),
  );
  assert.ok(superseding, 'a newer outcome supersedes the interrupted remainder and must be narrated');
  assert.ok(audibleText(superseding).includes(interrupt.superseding.phrase));

  clockB.at(interrupt.superseding.atMs + 1_000);
  await queueB.resume(interrupt.sessionId);
  await queueB.tick();
  assert.equal(voiceB.audible.length, 2, 'a superseded remainder is discarded, never resumed');
  assert.ok(
    !allAudibleText(voiceB).includes(interrupt.digest.phrase),
    'the stale remainder phrase must not be narrated once the newer outcome has been heard',
  );
  assert.equal(
    allAudibleText(voiceB).split(interrupt.approvalPhrase).length - 1,
    1,
    'the already-heard approval is not repeated by a discarded remainder',
  );
  assert.deepEqual(voiceB.violations, []);
});

test('N03: three-session bursts obey speech budgets and never starve the foreground reply', async () => {
  const createNarrationQueue = await queueFactory();
  const { burst } = fixture.scenarios;
  const clock = fakeClock(fixture.clockStart);
  const attention = fakeAttention(clock);
  const voice = fakeVoice(attention, clock);
  const queue = createNarrationQueue({ attention, voice, now: clock.now });

  // Twelve interleaved completions from three sessions arrive at the burst instant.
  for (const entry of burst.schedule) {
    clock.at(entry.atMs);
    await queue.submit(submissionInput(entry));
  }
  clock.at(0);
  await queue.tick();
  assert.equal(
    voice.audible.filter((utterance) => utterance.sessionId !== burst.foreground.sessionId).length,
    1,
    'a twelve-submission burst may start only one background digest at the burst instant',
  );
  assert.ok(queue.pending().length >= 2, 'the other sessions wait their turn instead of stacking back-to-back speech');

  // The user's requested reply arrives while the background backlog is still pending.
  clock.at(burst.foreground.atMs);
  assert.ok(queue.pending().length >= 2, 'the foreground reply arrives while background digests are still pending');
  await queue.submit(submissionInput(burst.foreground));
  await queue.tick();
  const foregroundUtterance = voice.audible.find((utterance) =>
    utterance.segmentIds.includes(burst.foreground.chapters[0]!.segments[0]!.id),
  );
  assert.ok(foregroundUtterance, 'the foreground reply must be spoken, never starved by background traffic');
  assert.ok(
    foregroundUtterance.atMs - burst.foreground.atMs < 1_000,
    `the foreground reply speaks at the first opportunity, not after the backlog: ${foregroundUtterance.atMs - burst.foreground.atMs}ms late`,
  );
  assert.equal(
    voice.audible.indexOf(foregroundUtterance),
    voice.audible.length - 1,
    'no background digest may jump ahead of the foreground reply',
  );

  // The remaining burst window: every second is ticked, and the speech budget decides.
  for (const atMs of burst.tickTimesMs) {
    if (atMs <= burst.foreground.atMs) continue;
    clock.at(atMs);
    await queue.tick();
  }

  const foregroundUtterances = voice.audible.filter((utterance) => utterance.sessionId === burst.foreground.sessionId);
  const backgroundUtterances = voice.audible.filter((utterance) => utterance.sessionId !== burst.foreground.sessionId);
  assert.equal(foregroundUtterances.length, 1, 'the foreground reply is spoken exactly once');
  assert.equal(backgroundUtterances.length, 3, 'coalescing means one digest per session, not one per submission');
  assert.equal(voice.audible.length, 4, 'the twelve-submission burst never becomes twelve utterances');

  const supersededIds = new Set(
    queue.receipts().filter((receipt) => receipt.outcome === 'superseded' || receipt.outcome === 'coalesced').map((receipt) => receipt.eventId),
  );
  for (const session of burst.sessions) {
    const heard = backgroundUtterances.filter((utterance) => utterance.sessionId === session.sessionId);
    assert.equal(heard.length, 1, `${session.sessionName} must be heard exactly once in the burst`);
    const utterance = heard[0]!;
    assert.ok(
      audibleText(utterance).toLowerCase().includes(session.sessionName.toLowerCase()),
      `${session.sessionName}'s digest must name its session when three sessions overlap: ${audibleText(utterance)}`,
    );
    assert.ok(wordCount(audibleText(utterance)) <= MAX_DIGEST_WORDS, `${session.sessionName}: exceeds the concise word budget`);
    assert.ok(utterance.maxSeconds <= MAX_DIGEST_SECONDS, `${session.sessionName}: exceeds the turn-complete second budget`);
    const ownSegments = new Set(burst.schedule.filter((entry) => entry.sessionId === session.sessionId).flatMap(segmentIdsOf));
    assert.ok(
      utterance.segmentIds.every((segmentId) => ownSegments.has(segmentId)),
      `${session.sessionName}: a digest may only speak its own session's segments`,
    );
  }
  for (const entry of burst.schedule) {
    if (!supersededIds.has(entry.eventId)) continue;
    if (entry.sessionId === burst.foreground.sessionId) continue;
    assert.ok(
      !allAudibleText(voice).includes(entry.phrase),
      `superseded digest ${entry.eventId} must never be narrated: ${entry.phrase}`,
    );
  }

  const startTimes = backgroundUtterances.map((utterance) => utterance.atMs).sort((left, right) => left - right);
  for (let index = 1; index < startTimes.length; index += 1) {
    assert.ok(
      startTimes[index]! - startTimes[index - 1]! >= BACKGROUND_MIN_GAP_MS,
      `background digests must respect the ${BACKGROUND_MIN_GAP_MS}ms speech budget: ${startTimes.join(', ')}`,
    );
  }
  assert.ok(
    startTimes.every((atMs) => atMs <= burst.tickTimesMs[burst.tickTimesMs.length - 1]!),
    'every session digest must be delivered within the burst window',
  );
  assert.equal(attention.requests.length > 0, true, 'burst speech still asks the shared policy for a lease');
  assert.deepEqual(voice.violations, []);
});
