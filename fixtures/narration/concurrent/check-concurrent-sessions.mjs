#!/usr/bin/env node
/**
 * N03 concurrent-sessions fixture — a deterministic, synthetic, offline stream of overlapping
 * session digests, an interrupted chapter, and a three-session burst plus a foreground reply.
 *
 * Nothing here touches the network, the clock, the filesystem, or user data: every id, text and
 * timestamp is derived from constants, so `node check-concurrent-sessions.mjs --json` is
 * byte-stable. The N03 oracle in `packages/narration/src/queue/n03.acceptance.test.ts` freezes the
 * digest of that output, then drives the narration-queue seam with the returned scenarios.
 *
 * What the queue consumes for one submission (labels are never handed to the queue):
 *
 *   { sessionId, sessionName, turnId, revision, eventId, contentKey, kind, chapters }
 *     sessionId    the producing session (multi-session coalescing keys on it)
 *     sessionName  display name announced when more than one session is speaking
 *     turnId       the turn the digest closes
 *     revision     monotonic per-session digest revision; a submission below the newest heard
 *                  revision of its session is stale and must never be narrated
 *     eventId      the durable turn-closing event the digest was reduced from
 *     contentKey   identical content key = same digest redelivered
 *     kind         'turn-complete' | 'important-failure' | 'user-requested' | 'background-session'
 *     chapters     [{ id, segments: [{ id, text, evidenceIds, maxSeconds }] }]
 *
 * Ground truth held only by this fixture (the oracle asserts against it; the queue never sees it):
 *   phrase       a substring that appears in exactly this submission's chapters and nowhere else
 *   atMs         submission time relative to `clockStart` (the burst instant / foreground arrival)
 *
 * Scenarios:
 *   supersession — one session: a pending failure digest (revision 2) is superseded by the newer
 *                  passing digest (revision 3); a redelivery of the failure arrives after the
 *                  newer outcome has been heard and must never be narrated.
 *   interrupt    — one session: a three-segment chapter whose first segment carries an approval
 *                  request; playback is interrupted after the first segment. `remainderSegmentIds`
 *                  is the only relevant unheard remainder, and `approvalPhrase` may be heard once.
 *                  `superseding` is the newer outcome that arrives while the chapter is
 *                  interrupted: once it has been heard, the stale remainder must be discarded.
 *   burst        — three sessions each producing four rapid turn completions (12 interleaved
 *                  submissions at the burst instant) plus one `user-requested` foreground reply
 *                  arriving while background digests are still pending. Budgets in `budgets` are
 *                  the §5.7 speech-budget bounds the queue must honor.
 *
 * Usage: node fixtures/narration/concurrent/check-concurrent-sessions.mjs [--json|--summary]
 *   --json     print the fixture document plus its digest and validation stats
 *   --summary  print counts, scenario shape, and the digest (default)
 * Exit code is nonzero when the fixture fails self-validation.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CONCURRENT_CONTRACT_VERSION = 1;
export const CONCURRENT_FIXTURE_ID = 'narration-concurrent-multisession';
export const CONCURRENT_CONSENT = 'synthetic';
export const CONCURRENT_SEED = 'n03-concurrent-2026-09-21';
export const CONCURRENT_CLOCK_START = '2026-09-21T06:00:00.000Z';

/** §5.7 speech budgets plus the burst pacing the queue must honor. */
export const CONCURRENT_BUDGETS = Object.freeze({
  /** At most one background utterance starts per 3 s safe gap, no matter how many sessions burst. */
  backgroundMinGapMs: 3_000,
  /** §5.7 concise budget per logical update (a digest chapter). */
  maxDigestWords: 50,
  /** §5.7 turn-complete summary bound. */
  maxDigestSeconds: 20,
  /** Stale pending digests expire instead of becoming hours of queued speech. */
  staleAfterMs: 90_000,
});

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function wordCount(text) {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort()) ordered[key] = canonicalize(value[key]);
    return ordered;
  }
  return value;
}

function segment(id, text, evidenceIds, maxSeconds) {
  return { id, text, evidenceIds, maxSeconds };
}

function chapter(id, segments) {
  return { id, segments };
}

function submission(sessionId, sessionName, turnId, revision, eventId, contentKey, kind, atMs, phrase, chapters) {
  return { sessionId, sessionName, turnId, revision, eventId, contentKey, kind, atMs, phrase, chapters };
}

const QUILL = 'session-n03-quill';
const EMBER = 'session-n03-ember';

/** Supersession: the stale failure is pending while the newer pass arrives and is heard. */
const supersessionScenario = {
  sessionId: QUILL,
  sessionName: 'Quill',
  taskId: 'task-n03-quill',
  stale: submission(
    QUILL, 'Quill', 'turn-n03-quill-2', 2,
    'event-n03-quill-2-turn-complete', 'quill-digest-run-2', 'turn-complete', 0,
    'parser deadlock',
    [chapter('quill-run-2-outcome', [
      segment(
        'quill-2-seg-1',
        'Quill run two is blocked: the migration check failed with a parser deadlock and the observed exit code was 1.',
        ['event-n03-quill-2-tool'], 9,
      ),
      segment(
        'quill-2-seg-2',
        'The failure repeated, so the schema review stays pending until the deadlock clears.',
        ['event-n03-quill-2-tool'], 6,
      ),
    ])],
  ),
  newer: submission(
    QUILL, 'Quill', 'turn-n03-quill-3', 3,
    'event-n03-quill-3-turn-complete', 'quill-digest-run-3', 'turn-complete', 1_000,
    'schema review cleared',
    [chapter('quill-run-3-outcome', [
      segment(
        'quill-3-seg-1',
        'Quill run three passes now: the schema review cleared the deadlock and all nine receipts report exit code 0.',
        ['event-n03-quill-3-tool'], 9,
      ),
    ])],
  ),
  /** A redelivery of the stale turn's durable event, arriving after the newer outcome was heard. */
  lateDuplicateOf: 'stale',
};

/** Interrupt: a chapter whose first segment carries the approval; only the tail stays resumable. */
const interruptScenario = {
  sessionId: EMBER,
  sessionName: 'Ember',
  taskId: 'task-n03-ember',
  digest: submission(
    EMBER, 'Ember', 'turn-n03-ember-7', 7,
    'event-n03-ember-7-turn-complete', 'ember-digest-run-7', 'turn-complete', 0,
    'retry confirmed the parser fix',
    [chapter('ember-run-7-chapter', [
      segment(
        'ember-7-seg-1',
        'Ember needs approval to promote the migration; playback is paused until you allow it.',
        ['event-n03-ember-7-approval'], 7,
      ),
      segment(
        'ember-7-seg-2',
        'While waiting, Ember retried the failing shard and the retry confirmed the parser fix.',
        ['event-n03-ember-7-tool'], 7,
      ),
      segment(
        'ember-7-seg-3',
        'Two verification receipts are outstanding and Ember listed them.',
        ['event-n03-ember-7-tool-2'], 6,
      ),
    ])],
  ),
  approvalSegmentId: 'ember-7-seg-1',
  approvalPhrase: 'needs approval to promote',
  heardSegmentIds: ['ember-7-seg-1'],
  remainderSegmentIds: ['ember-7-seg-2', 'ember-7-seg-3'],
  superseding: submission(
    EMBER, 'Ember', 'turn-n03-ember-8', 8,
    'event-n03-ember-8-turn-complete', 'ember-digest-run-8', 'turn-complete', 6_000,
    'promote step finished cleanly',
    [chapter('ember-run-8-outcome', [
      segment(
        'ember-8-seg-1',
        'Ember run eight completed: the promote step finished cleanly and no receipts are outstanding.',
        ['event-n03-ember-8-tool'], 8,
      ),
    ])],
  ),
};

function burstSession(sessionId, sessionName, texts) {
  const revisions = texts.map((entry, index) => submission(
    sessionId, sessionName, `turn-${sessionId}-${index + 1}`, index + 1,
    `event-${sessionId}-${index + 1}-turn-complete`, `${sessionId}-digest-run-${index + 1}`,
    'turn-complete', 0, entry.phrase,
    [chapter(`${sessionId}-run-${index + 1}-outcome`, [
      segment(`${sessionId.replace('session-n03-', '')}-${index + 1}-seg-1`, entry.text, [`event-${sessionId}-${index + 1}-tool`], entry.maxSeconds),
    ])],
  ));
  return { sessionId, sessionName, submissions: revisions };
}

const fern = burstSession('session-n03-fern', 'Fern', [
  { text: 'Fern started run one and is rebuilding the component index.', phrase: 'rebuilding the component index', maxSeconds: 6 },
  { text: 'Fern run two reached the middle of the snapshot comparison.', phrase: 'snapshot comparison', maxSeconds: 6 },
  { text: 'Fern run three found one flaky layout test and is rerunning it.', phrase: 'flaky layout test', maxSeconds: 6 },
  { text: 'Fern finished run four: the responsive layout test passed and the design review note is the only open item.', phrase: 'responsive layout test passed', maxSeconds: 9 },
]);
const reed = burstSession('session-n03-reed', 'Reed', [
  { text: 'Reed started run one and is reconciling the quota ledger.', phrase: 'quota ledger', maxSeconds: 6 },
  { text: 'Reed run two is replaying the currency rounding fixtures.', phrase: 'currency rounding', maxSeconds: 6 },
  { text: 'Reed run three found a stubborn invoice mismatch and is retrying it.', phrase: 'stubborn invoice mismatch', maxSeconds: 6 },
  { text: 'Reed finished run four: the settlement batch passed and the audit export is queued.', phrase: 'settlement batch passed', maxSeconds: 7 },
]);
const moss = burstSession('session-n03-moss', 'Moss', [
  { text: 'Moss started run one and is rebalancing the storage shard.', phrase: 'rebalancing the storage shard', maxSeconds: 6 },
  { text: 'Moss run two is warming the cold tier cache.', phrase: 'cold tier cache', maxSeconds: 6 },
  { text: 'Moss run three rebuilt the search index and is verifying the result.', phrase: 'rebuilt the search index', maxSeconds: 6 },
  { text: 'Moss finished run four: the index rebuild completed and the benchmark sits inside the frozen budget.', phrase: 'index rebuild completed', maxSeconds: 8 },
]);

/** Interleaved arrival order: the burst is three sessions, not one session's four turns. */
const burstSchedule = [];
for (let revisionIndex = 0; revisionIndex < 4; revisionIndex += 1) {
  burstSchedule.push(fern.submissions[revisionIndex], reed.submissions[revisionIndex], moss.submissions[revisionIndex]);
}

const foreground = submission(
  'session-n03-companion', 'Companion', 'turn-n03-foreground-1', 1,
  'event-n03-foreground-1', 'foreground-digest-1', 'user-requested', 1_000,
  'queue drain finished',
  [chapter('foreground-answer', [
    segment(
      'foreground-1-seg-1',
      'Here is the answer you asked for: the queue drain finished and all three sessions are still observing.',
      ['event-n03-foreground-1-receipt'], 8,
    ),
  ])],
);

const burstScenario = {
  sessions: [fern, reed, moss].map(({ sessionId, sessionName }) => ({ sessionId, sessionName })),
  schedule: burstSchedule,
  foreground,
  /** Every second of the burst window is ticked; budgets decide when speech is allowed. */
  tickTimesMs: [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000],
};

export function buildConcurrentFixture() {
  return {
    contractVersion: CONCURRENT_CONTRACT_VERSION,
    fixtureId: CONCURRENT_FIXTURE_ID,
    consent: CONCURRENT_CONSENT,
    seed: CONCURRENT_SEED,
    clockStart: CONCURRENT_CLOCK_START,
    budgets: { ...CONCURRENT_BUDGETS },
    scenarios: {
      supersession: supersessionScenario,
      interrupt: interruptScenario,
      burst: burstScenario,
    },
  };
}

/** Digest of everything except `digest`/`stats`, so the frozen value covers every field. */
export function concurrentDigest(document) {
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

function allSubmissions(document) {
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

export function validateConcurrentFixture(document) {
  const problems = [];
  const submissions = allSubmissions(document);
  const phrases = new Map();
  let segmentCount = 0;

  for (const entry of submissions) {
    if (!entry.sessionId || !entry.sessionName || !entry.turnId || !entry.eventId) problems.push(`${entry.eventId}: incomplete submission identity`);
    if (!Number.isInteger(entry.revision) || entry.revision < 1) problems.push(`${entry.eventId}: revision must be a positive integer`);
    if (entry.kind !== 'user-requested' && entry.kind !== 'turn-complete' && entry.kind !== 'important-failure' && entry.kind !== 'background-session') {
      problems.push(`${entry.eventId}: unexpected kind ${entry.kind}`);
    }
    if (!Array.isArray(entry.chapters) || entry.chapters.length === 0) problems.push(`${entry.eventId}: a submission needs at least one chapter`);
    if (!phrases.has(entry.phrase)) phrases.set(entry.phrase, []);
    phrases.get(entry.phrase).push(entry.eventId);

    let words = 0;
    let seconds = 0;
    let digestText = '';
    for (const currentChapter of entry.chapters) {
      if (!currentChapter.id || !Array.isArray(currentChapter.segments) || currentChapter.segments.length === 0) problems.push(`${entry.eventId}: empty chapter`);
      for (const currentSegment of currentChapter.segments) {
        segmentCount += 1;
        const segmentWords = wordCount(currentSegment.text);
        words += segmentWords;
        seconds += currentSegment.maxSeconds;
        if (segmentWords < 3) problems.push(`${currentSegment.id}: segment is too small to be meaningful speech`);
        if (!(currentSegment.maxSeconds > 0) || currentSegment.maxSeconds > 40) problems.push(`${currentSegment.id}: maxSeconds must be within (0, 40]`);
        if (currentSegment.maxSeconds < segmentWords / 2.5) problems.push(`${currentSegment.id}: ${currentSegment.maxSeconds}s cannot cover ${segmentWords} words at the shared pacing`);
        if (!Array.isArray(currentSegment.evidenceIds) || currentSegment.evidenceIds.length === 0) problems.push(`${currentSegment.id}: every spoken segment cites durable evidence`);
        digestText += ` ${currentSegment.text}`;
      }
    }
    if (!digestText.includes(entry.phrase)) problems.push(`${entry.eventId}: phrase "${entry.phrase}" is not spoken by its own digest`);
    if (words > document.budgets.maxDigestWords) problems.push(`${entry.eventId}: ${words} words exceeds the ${document.budgets.maxDigestWords} word budget`);
    if (seconds > document.budgets.maxDigestSeconds) problems.push(`${entry.eventId}: ${seconds}s exceeds the ${document.budgets.maxDigestSeconds}s budget`);
  }

  for (const [phrase, owners] of phrases) {
    if (owners.length !== 1) problems.push(`phrase "${phrase}" is not unique: ${owners.join(', ')}`);
  }

  const { supersession, interrupt, burst } = document.scenarios;
  if (supersession.stale.revision >= supersession.newer.revision) problems.push('supersession: the newer digest must carry the higher revision');
  if (!interrupt.digest.chapters[0].segments[0].text.includes(interrupt.approvalPhrase)) problems.push('interrupt: the approval phrase must be spoken by the first segment');
  const digestSegmentIds = interrupt.digest.chapters.flatMap((currentChapter) => currentChapter.segments.map((currentSegment) => currentSegment.id));
  const accounted = [...interrupt.heardSegmentIds, ...interrupt.remainderSegmentIds];
  if (accounted.length !== digestSegmentIds.length || digestSegmentIds.some((id) => !accounted.includes(id))) problems.push('interrupt: heard + remainder segments must cover the chapter exactly once');
  if (!interrupt.digest.chapters[0].segments[1].text.includes(interrupt.digest.phrase)) problems.push('interrupt: the digest phrase must be spoken by the resumable remainder');

  if (burst.sessions.length !== 3) problems.push(`burst: expected three sessions, found ${burst.sessions.length}`);
  const perSessionRevisions = new Map();
  for (const entry of burst.schedule) perSessionRevisions.set(entry.sessionId, (perSessionRevisions.get(entry.sessionId) ?? 0) + 1);
  if (burst.schedule.length !== 12 || perSessionRevisions.size !== 3 || [...perSessionRevisions.values()].some((count) => count !== 4)) {
    problems.push('burst: expected 3 sessions x 4 rapid submissions');
  }
  for (let index = 0; index < burst.schedule.length; index += 1) {
    if (burst.schedule[index].revision !== Math.floor(index / 3) + 1) problems.push('burst: submissions must interleave the three sessions by revision');
  }
  if (!(burst.foreground.atMs > 0)) problems.push('burst: the foreground reply must arrive after the burst instant');
  if (burst.foreground.kind !== 'user-requested') problems.push('burst: the foreground reply must be user-requested');

  return { problems, stats: { submissions: submissions.length, segments: segmentCount, sessions: perSessionRevisions.size, burstSubmissions: burst.schedule.length } };
}

export function loadConcurrentFixture() {
  const document = buildConcurrentFixture();
  return { ...document, digest: concurrentDigest(document) };
}

function summarize(document, stats) {
  const lines = [
    `n03 concurrent fixture: ${stats.submissions} submissions, ${stats.segments} spoken segments, ${stats.sessions} burst sessions`,
    `burst: ${stats.burstSubmissions} interleaved submissions + 1 foreground reply at ${document.scenarios.burst.foreground.atMs}ms`,
    `budgets: gap ${document.budgets.backgroundMinGapMs}ms, ${document.budgets.maxDigestWords} words / ${document.budgets.maxDigestSeconds}s per digest`,
    `digest: ${document.digest}`,
  ];
  return lines.join('\n');
}

export function runCli(args) {
  const document = loadConcurrentFixture();
  const { problems, stats } = validateConcurrentFixture(document);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...document, stats })}\n`);
  } else {
    process.stdout.write(`${summarize(document, stats)}\n`);
    if (problems.length > 0) process.stdout.write(`${problems.map((problem) => `problem: ${problem}`).join('\n')}\n`);
  }
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
