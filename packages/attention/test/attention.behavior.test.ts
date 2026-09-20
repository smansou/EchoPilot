/**
 * Focused behavior tests for the shared attention policy (R02, plan §5.7). The frozen acceptance
 * oracle (`r02.acceptance.test.ts`) pins the held-out pillar stream; this file documents the corners
 * it deliberately leaves unpinned: the preset tables, a raised `eventPriorities` override, live
 * replacement of a stale turn summary, the mute queue, and the exact-lease authority rule.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_LEASE_MS,
  createAttentionPolicy,
  type AttentionDecision,
  type AttentionEventClass,
  type AttentionPolicy,
  type AttentionSettings,
  type SpeechCandidate,
} from '../src/index.js';
import type { SpeechLease } from '../../contracts/src/index.js';

const CLOCK_START = '2026-09-21T09:00:00.000Z';

function fakeClock(startIso: string): Readonly<{ now: () => Date; set(iso: string): void; advance(ms: number): void }> {
  let current = new Date(startIso);
  return {
    now: () => current,
    set: (iso) => { current = new Date(iso); },
    advance: (ms) => { current = new Date(current.getTime() + ms); },
  };
}

function policy(
  clock: Readonly<{ now: () => Date }>,
  settings?: Partial<AttentionSettings>,
): AttentionPolicy {
  return settings === undefined
    ? createAttentionPolicy({ now: clock.now })
    : createAttentionPolicy({ now: clock.now, settings });
}

function candidate(
  candidateId: string,
  sourceId: string,
  eventClass: AttentionEventClass,
  extra: Readonly<{ sessionId?: string; turnId?: string }> = {},
): SpeechCandidate {
  return { candidateId, sourceId, eventClass, eventId: `ev-${candidateId}`, ...extra };
}

function only(receipts: ReadonlyArray<AttentionDecision>, candidateId: string): AttentionDecision {
  const matches = receipts.filter((receipt) => receipt.candidateId === candidateId);
  assert.equal(matches.length, 1, `expected exactly one receipt for ${candidateId}, got ${matches.length}`);
  return matches[0]!;
}

function latest(current: AttentionPolicy, candidateId: string): AttentionDecision {
  const matches = current.decisions().filter((receipt) => receipt.candidateId === candidateId);
  const last = matches.at(-1);
  assert.ok(last, `no receipt exists for ${candidateId}`);
  return last;
}

function spoken(receipt: AttentionDecision): SpeechLease {
  assert.equal(receipt.outcome, 'spoken', `${receipt.candidateId}: ${receipt.explanation}`);
  assert.ok(receipt.lease, `${receipt.candidateId} must carry a lease`);
  assert.ok(receipt.explanation.trim().length > 0);
  return receipt.lease;
}

test('R02 behavior: presets decide which classes may speak at all', () => {
  const focused = policy(fakeClock(CLOCK_START));
  const badge = only(focused.submit(candidate('bg', 'desktop', 'background-session')), 'bg');
  assert.equal(badge.outcome, 'visual', 'focused-work keeps background sessions visual');
  assert.equal(badge.reason, 'preset-visual-only');
  assert.equal(badge.setting, 'preset');
  assert.equal(badge.lease, undefined);
  assert.match(badge.explanation, /focused-work/i);

  const handsFree = policy(fakeClock(CLOCK_START), { preset: 'hands-free' });
  const announced = only(handsFree.submit(candidate('bg', 'desktop', 'background-session')), 'bg');
  assert.equal(announced.outcome, 'spoken', 'hands-free announces what focused-work badges');
  assert.equal(announced.reason, 'routine-digest');
  assert.ok(announced.lease);

  const presentation = policy(fakeClock(CLOCK_START), { preset: 'presentation' });
  const reply = only(presentation.submit(candidate('reply', 'voice', 'user-requested')), 'reply');
  assert.equal(reply.outcome, 'visual', 'presentation is visual-only for every class');
  assert.equal(reply.reason, 'preset-visual-only');
  assert.equal(reply.setting, 'preset');
  assert.match(reply.explanation, /presentation/i);

  const critical = policy(fakeClock(CLOCK_START), { preset: 'critical-only' });
  assert.equal(only(critical.submit(candidate('digest', 'harness', 'routine-progress')), 'digest').outcome, 'visual');
  assert.equal(only(critical.submit(candidate('perm', 'capture', 'blocking')), 'perm').outcome, 'spoken');
});

test('R02 behavior: a raised override preempts routine speech and cites eventPriorities', () => {
  const clock = fakeClock(CLOCK_START);
  const current = policy(clock, { eventPriorities: { 'background-session': 'blocking' } });
  const routineLease = spoken(only(current.submit(candidate('digest', 'harness', 'routine-progress')), 'digest'));

  clock.advance(5_000);
  const raised = only(current.submit(candidate('bg', 'desktop', 'background-session')), 'bg');
  assert.equal(raised.outcome, 'spoken', 'the override raises the class into a speaking bucket');
  assert.equal(raised.setting, 'eventPriorities');
  assert.match(raised.explanation, /priority/i);
  const interrupted = latest(current, 'digest');
  assert.equal(interrupted.outcome, 'interrupted', 'the live routine utterance is interrupted, not overlapped');
  assert.equal(interrupted.reason, 'interrupted-by-background-session');
  assert.equal(current.canSpeak(routineLease), false);
});

test('R02 behavior: a newer summary for the same turn replaces a live stale one', () => {
  const clock = fakeClock(CLOCK_START);
  const current = policy(clock);
  const staleLease = spoken(only(
    current.submit(candidate('summary-stale', 'narration', 'turn-complete', { turnId: 'turn-4' })),
    'summary-stale',
  ));
  clock.advance(1_000);
  const receipts = current.submit(candidate('summary-new', 'narration', 'turn-complete', { turnId: 'turn-4' }));
  const replaced = only(receipts, 'summary-stale');
  assert.equal(replaced.outcome, 'replaced');
  assert.equal(replaced.reason, 'replaced-stale-completion');
  assert.equal(current.canSpeak(staleLease), false, 'the stale grant dies with the replacement');
  assert.equal(latest(current, 'summary-new').outcome, 'spoken');
  assert.equal(current.pending().length, 0);
});

test('R02 behavior: mute revokes live grants and drops queued deferrals', () => {
  const clock = fakeClock(CLOCK_START);
  const current = policy(clock);
  const announceLease = spoken(only(current.submit(candidate('announce', 'desktop', 'blocking')), 'announce'));
  assert.equal(current.canSpeak(announceLease), true);

  current.userSpeechStarted();
  const deferred = only(current.submit(candidate('perm', 'capture', 'blocking')), 'perm');
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(current.pending().length, 1);

  current.updateSettings({ muted: true });
  assert.equal(current.canSpeak(announceLease), false, 'mute revokes the live grant immediately');
  assert.equal(current.pending().length, 0, 'mute does not hold a queue');
  current.userSpeechEnded();
  clock.advance(10_000);
  assert.deepEqual(current.tick(), []);
  current.updateSettings({ muted: false });
  clock.advance(10_000);
  assert.deepEqual(current.tick(), [], 'nothing resurfaces once muting dropped the queue');
  assert.equal(latest(current, 'perm').outcome, 'deferred');
  assert.equal(only(current.submit(candidate('reply', 'voice', 'user-requested')), 'reply').outcome, 'spoken');
});

test('R02 behavior: only the exact issued lease speaks, and it expires on the injected clock', () => {
  const clock = fakeClock(CLOCK_START);
  const current = policy(clock);
  const receipt = only(current.submit(candidate('perm', 'gaze', 'blocking')), 'perm');
  const lease = spoken(receipt);
  const expires = new Date(Date.parse(receipt.decidedAt) + MAX_LEASE_MS).toISOString();
  assert.equal(lease.expiresAt, expires, 'a grant is bounded by the 30 s lease window');

  const issued = current.requestSpeech('ev-perm', expires);
  assert.equal(issued, lease, 'the §5.3 seam hands back the grant itself');
  assert.equal(current.canSpeak({ ...lease }), false, 'a reconstructed lease is inert');
  assert.equal(current.requestSpeech('ev-unknown', expires), null);
  current.revokeSpeech('user-stop');
  assert.equal(current.canSpeak(lease), false, 'revokeSpeech invalidates the live grant');

  const expiryClock = fakeClock(CLOCK_START);
  const expiryPolicy = policy(expiryClock);
  const expiring = spoken(only(expiryPolicy.submit(candidate('expire', 'gaze', 'blocking')), 'expire'));
  expiryClock.set(new Date(Date.parse(expiring.expiresAt)).toISOString());
  assert.equal(expiryPolicy.canSpeak(expiring), false, 'a lease is invalid at its expiry');
  assert.equal(expiryPolicy.requestSpeech('ev-expire', expiring.expiresAt), null);
});

test('R02 behavior: the policy surface exposes no direct speech shortcut', () => {
  const current = policy(fakeClock(CLOCK_START)) as unknown as Record<string, unknown>;
  for (const name of ['speak', 'speakNow', 'play', 'emit', 'say', 'announce']) {
    assert.notEqual(typeof current[name], 'function', `attention must not expose a direct ${name}() shortcut`);
  }
});
