/**
 * R02 acceptance oracle — events from any pillar → one attention policy → speech / suppression /
 * resumption receipt (IMPLEMENTATION_PLAN.md §5.7 attention policy; §5.3 SpeechLease; BACKLOG R02).
 *
 * `packages/attention/src/index.ts` must export (this file freezes these names):
 *
 *   createAttentionPolicy({ now?, settings? }) → AttentionPolicy
 *
 *     now — optional deterministic clock (defaults to the system clock; every scenario here injects
 *       a fake one, and every receipt's `decidedAt` must come from it).
 *     settings — { preset, outputSilence, muted, eventPriorities?, cooldownSeconds? }, defaulting to
 *       { preset: 'focused-work', outputSilence: false, muted: false }:
 *         preset      'focused-work' | 'hands-free' | 'critical-only' | 'presentation'
 *         outputSilence  explicit output silence; independent of `muted`; never bypassed.
 *         muted       the stop/mute control; nothing speaks and nothing queues while it is on.
 *         eventPriorities  user raise/lower of one class ('blocking' | 'important' | 'routine' |
 *                     'visual'); 'visual' means that class is never spoken.
 *         cooldownSeconds  user override of the routine-progress digest cooldown.
 *
 *     The policy is the only granter of proactive speech. The returned object exposes no
 *     speak/say/play/emit shortcut: audio is authorized only by a §5.3 `SpeechLease` that a
 *     'spoken' decision attached, or that `requestSpeech` still returns for that decision.
 *
 *     submit(candidate) → AttentionDecision[]
 *       candidate: { candidateId, sourceId, eventClass, eventId, sessionId?, turnId?, contentKey? }
 *       eventClass: 'user-requested' | 'blocking' | 'important-failure' | 'turn-complete'
 *                 | 'routine-progress' | 'background-session'
 *       sourceId is the producing pillar/module ('capture', 'harness', 'memory', 'narration',
 *       'desktop', 'gaze', 'voice', …); no source is special-cased and none may speak on its own.
 *       Returns the receipts this call produced, including receipts for other candidates whose
 *       disposition it changed (a replaced or interrupted peer).
 *     tick() → AttentionDecision[]
 *       Re-evaluates deferred candidates against the injected clock. Appends nothing while a
 *       candidate stays deferred; a receipt marks every change of disposition.
 *     userSpeechStarted() / userSpeechEnded()
 *       The user's ongoing utterance. While it is open no candidate may receive a lease; the end of
 *       the utterance starts the quiet-gap and safe-gap clocks.
 *     updateSettings(patch) — applies the settings above at the next decision.
 *     requestSpeech(eventId, expiresAt) → SpeechLease | null
 *       The §5.3 seam for a producer holding a durable event id. Returns a lease only while the
 *       policy has authorized speech for exactly that event (its latest disposition is 'spoken'
 *       with a live grant); null for deferred, suppressed, replaced or unknown events, and null
 *       while muted or silent.
 *     canSpeak(lease) → boolean
 *       True only for a lease this policy issued that is neither revoked, superseded nor expired.
 *       A structurally equal copy of a lease is not that lease.
 *     revokeSpeech(reason) — invalidates the live grants immediately.
 *     decisions() → AttentionDecision[] — the ordered receipt trail.
 *     pending() → PendingCandidate[] — { candidateId, eventId, eventClass, reason, deferredAt }.
 *
 * Receipt shape: { candidateId, eventId, sourceId, eventClass, outcome, reason, explanation,
 * setting, decidedAt, lease? }
 *
 *   - outcome: 'spoken' | 'deferred' | 'suppressed' | 'visual' | 'coalesced' | 'replaced'
 *     | 'interrupted'. `lease` is present exactly when outcome === 'spoken', and it expires after
 *     `decidedAt` and at most 30 s later.
 *   - reason is a stable token; explanation is a human-readable sentence naming the rule or setting
 *     that governed the decision; setting names the settings key that supplied that rule
 *     ('preset' | 'outputSilence' | 'muted' | 'eventPriorities' | 'cooldownSeconds') or null when
 *     no settings value governed it.
 *   - The trail is append-only: a deferred candidate that is later spoken keeps both receipts, so a
 *     suppression or a resumption stays auditable instead of being overwritten.
 *
 * Rules pinned here (IMPLEMENTATION_PLAN.md §5.7):
 *   - Only a live lease authorizes audio. Mute and revokeSpeech invalidate live grants immediately
 *     and late audio is dropped; an expired lease is dropped the same way.
 *   - Blocking and important-failure candidates speak at the next safe gap: immediately when the
 *     user is not speaking, and within 3 s of `userSpeechEnded()`. They preempt routine-class
 *     speech (turn-complete, routine-progress, background-session) by interrupting it.
 *   - While the user's utterance is open nothing speaks; a blocking candidate waits and is spoken
 *     only once the gap opens.
 *   - Explicit output silence cannot be bypassed: a blocking event is suppressed, never granted a
 *     lease, exactly like a user-requested reply.
 *   - Routine progress digests obey their cooldown (focused-work 120 s, hands-free 30 s,
 *     `cooldownSeconds` override); a digest suppressed by the cooldown is visual, not queued.
 *   - Turn-complete summaries wait for a 750 ms quiet gap, and a newer summary for the same turn
 *     replaces one that has not been spoken yet.
 *   - The presentation preset is visual-only for every class until the user changes the preset;
 *     presets and `eventPriorities` are settings the receipts must cite.
 *
 * Deterministic scope: `fixtures/attention/r02-pillar-stream.json` is the synthetic step stream —
 * candidates from every pillar source, user-speech boundaries and settings changes — replayed twice
 * under the fake clock. The oracle's audio probe is the §5.3 rule that every speech adapter checks
 * `canSpeak` before each output chunk (the real V02 playback session does); TTS, audio devices,
 * microphone capture and V03 duplex barge-in are covered by their own oracles, and the fixture keeps
 * every floor-sensitive step at least the 30 s lease bound apart so unpinned floor interactions are
 * never asserted.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { SpeechLease } from '../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../fixtures/attention/r02-pillar-stream.json', import.meta.url);
/** §5.7: leases are bounded grants — every decision lease expires within 30 s of the decision. */
const MAX_LEASE_MS = 30_000;
const QUIET_GAP_MS = 750;
const SAFE_GAP_MS = 3_000;
const CLOCK_START = '2026-09-21T09:00:00.000Z';

type AttentionPreset = 'focused-work' | 'hands-free' | 'critical-only' | 'presentation';
type AttentionEventClass =
  | 'user-requested'
  | 'blocking'
  | 'important-failure'
  | 'turn-complete'
  | 'routine-progress'
  | 'background-session';
type AttentionPriority = 'blocking' | 'important' | 'routine' | 'visual';
type AttentionSettingKey = 'preset' | 'outputSilence' | 'muted' | 'eventPriorities' | 'cooldownSeconds';

type AttentionSettings = Readonly<{
  preset: AttentionPreset;
  outputSilence: boolean;
  muted: boolean;
  eventPriorities?: Readonly<Partial<Record<AttentionEventClass, AttentionPriority>>>;
  cooldownSeconds?: number;
}>;

type SpeechCandidate = Readonly<{
  candidateId: string;
  sourceId: string;
  eventClass: AttentionEventClass;
  eventId: string;
  sessionId?: string;
  turnId?: string;
  contentKey?: string;
}>;

type AttentionOutcome =
  | 'spoken'
  | 'deferred'
  | 'suppressed'
  | 'visual'
  | 'coalesced'
  | 'replaced'
  | 'interrupted';

type AttentionDecision = Readonly<{
  candidateId: string;
  eventId: string;
  sourceId: string;
  eventClass: AttentionEventClass;
  outcome: AttentionOutcome;
  reason: string;
  explanation: string;
  setting?: AttentionSettingKey | null;
  decidedAt: string;
  lease?: SpeechLease;
}>;

type PendingCandidate = Readonly<{
  candidateId: string;
  eventId: string;
  eventClass: AttentionEventClass;
  reason: string;
  deferredAt: string;
}>;

type AttentionPolicy = Readonly<{
  updateSettings(patch: Partial<AttentionSettings>): void;
  submit(candidate: SpeechCandidate): ReadonlyArray<AttentionDecision>;
  tick(): ReadonlyArray<AttentionDecision>;
  userSpeechStarted(): void;
  userSpeechEnded(): void;
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
  canSpeak(lease: SpeechLease): boolean;
  revokeSpeech(reason: string): void;
  decisions(): ReadonlyArray<AttentionDecision>;
  pending(): ReadonlyArray<PendingCandidate>;
}>;

type AttentionModule = Readonly<{
  createAttentionPolicy(options: Readonly<{ now?: () => Date; settings?: Partial<AttentionSettings> }>): AttentionPolicy;
}>;

async function loadAttentionModule(): Promise<AttentionModule> {
  const fail = (detail: string): never => assert.fail(
    'R02 required attention behavior is not implemented yet: packages/attention/src/index.ts must '
    + 'export createAttentionPolicy({ now, settings }) returning the shared §5.7 policy with '
    + 'submit, tick, updateSettings, userSpeechStarted, userSpeechEnded, requestSpeech, canSpeak, '
    + `revokeSpeech, decisions and pending. ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists this resolves to
  // nothing, and that is reported below as the missing behavior instead of an import crash.
  const specifier = ['..', 'src', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createAttentionPolicy !== 'function') return fail('createAttentionPolicy is not exported');
  return loaded as unknown as AttentionModule;
}

const attention = await loadAttentionModule();

type FakeClock = Readonly<{ now: () => Date; set(iso: string): void; advance(ms: number): void }>;

function fakeClock(startIso: string): FakeClock {
  let current = new Date(startIso);
  return {
    now: () => current,
    set: (iso) => { current = new Date(iso); },
    advance: (ms) => { current = new Date(current.getTime() + ms); },
  };
}

function newPolicy(clock: FakeClock, settings?: Partial<AttentionSettings>): AttentionPolicy {
  return attention.createAttentionPolicy(settings === undefined ? { now: clock.now } : { now: clock.now, settings });
}

/** The audio sink double: it mirrors the §5.3 rule that every chunk is checked against canSpeak. */
type AudioProbe = Readonly<{
  emitted: Array<Readonly<{ eventId: string; text: string }>>;
  play(lease: SpeechLease, eventId: string, text: string): boolean;
}>;

function audioProbe(policy: AttentionPolicy): AudioProbe {
  const emitted: Array<Readonly<{ eventId: string; text: string }>> = [];
  return {
    emitted,
    play(lease, eventId, text) {
      if (!policy.canSpeak(lease)) return false;
      emitted.push({ eventId, text });
      return true;
    },
  };
}

function candidate(
  candidateId: string,
  sourceId: string,
  eventClass: AttentionEventClass,
  eventId: string,
  extra: Readonly<{ sessionId?: string; turnId?: string; contentKey?: string }> = {},
): SpeechCandidate {
  return { candidateId, sourceId, eventClass, eventId, ...extra };
}

function only(receipts: ReadonlyArray<AttentionDecision>, candidateId: string): AttentionDecision {
  const matches = receipts.filter((receipt) => receipt.candidateId === candidateId);
  assert.equal(matches.length, 1, `expected exactly one receipt for ${candidateId}, got ${matches.length}`);
  return matches[0]!;
}

function latest(policy: AttentionPolicy, candidateId: string): AttentionDecision {
  const matches = policy.decisions().filter((receipt) => receipt.candidateId === candidateId);
  const last = matches.at(-1);
  assert.ok(last, `no receipt exists for ${candidateId}`);
  return last;
}

function assertSpoken(receipt: AttentionDecision, reason?: string): SpeechLease {
  assert.equal(receipt.outcome, 'spoken', `${receipt.candidateId} must be spoken: ${receipt.explanation}`);
  if (reason !== undefined) assert.equal(receipt.reason, reason, `${receipt.candidateId} spoke for the wrong reason`);
  assert.ok(receipt.lease, `${receipt.candidateId} must speak with a lease`);
  assert.ok(receipt.explanation.trim().length > 0, `${receipt.candidateId} must explain why it spoke`);
  return receipt.lease;
}

type FixtureReceipt = Readonly<{
  candidateId: string;
  outcome: AttentionOutcome;
  reason: string;
  setting?: AttentionSettingKey | null;
}>;

type FixtureStep = Readonly<{
  id: string;
  at: string;
  kind: 'candidate' | 'tick' | 'user-speaking-start' | 'user-speaking-end' | 'settings';
  intent?: string;
  candidate?: SpeechCandidate;
  settings?: Partial<AttentionSettings>;
  expect: ReadonlyArray<FixtureReceipt>;
}>;

type StreamFixture = Readonly<{
  id: string;
  version: number;
  ticket: string;
  consent: string;
  description: string;
  clockStart: string;
  pillarSources: ReadonlyArray<string>;
  steps: ReadonlyArray<FixtureStep>;
}>;

type StreamRun = Readonly<{ receipts: ReadonlyArray<AttentionDecision>; policy: AttentionPolicy }>;

const SPOKEN_REASONS = new Set([
  'turn-complete-quiet-gap',
  'routine-digest',
  'important-failure-decision',
  'blocking-safe-gap',
  'user-requested-reply',
]);
const OTHER_REASONS = new Set([
  'user-speaking-safe-gap',
  'quiet-gap-not-elapsed',
  'cooldown-active',
  'explicit-output-silence',
  'muted',
  'preset-visual-only',
  'priority-override-visual',
  'replaced-stale-completion',
  'interrupted-by-blocking',
  'interrupted-by-important-failure',
]);

function describeReceipts(receipts: ReadonlyArray<AttentionDecision>): string {
  return receipts
    .map((receipt) => `${receipt.candidateId}:${receipt.outcome}/${receipt.reason}`)
    .join(', ');
}

function assertStepReceipts(step: FixtureStep, actual: ReadonlyArray<AttentionDecision>): void {
  assert.equal(
    actual.length,
    step.expect.length,
    `${step.id} (${step.intent ?? step.kind}): ${actual.length} receipt(s) returned, expected ${step.expect.length}: ${describeReceipts(actual)}`,
  );
  const unmatched = [...actual];
  for (const want of step.expect) {
    const index = unmatched.findIndex((receipt) => receipt.candidateId === want.candidateId);
    assert.ok(index >= 0, `${step.id}: no receipt for ${want.candidateId}: ${describeReceipts(actual)}`);
    const receipt = unmatched.splice(index, 1)[0]!;
    assert.equal(receipt.outcome, want.outcome, `${step.id}/${want.candidateId}: outcome ${receipt.outcome} (${receipt.explanation})`);
    assert.equal(receipt.reason, want.reason, `${step.id}/${want.candidateId}: reason ${receipt.reason} (${receipt.explanation})`);
    if (Object.hasOwn(want, 'setting')) {
      assert.equal(
        receipt.setting ?? null,
        want.setting ?? null,
        `${step.id}/${want.candidateId}: the receipt must cite the setting that governed it`,
      );
    }
  }
}

function requireCandidate(step: FixtureStep): SpeechCandidate {
  assert.ok(step.candidate, `${step.id}: a candidate step must carry a candidate`);
  return step.candidate;
}

/** Replays the fixture stream under a fresh fake clock, asserting the expected receipts at each step. */
function runStream(fixture: StreamFixture): StreamRun {
  const clock = fakeClock(fixture.clockStart);
  const policy = newPolicy(clock);
  for (const step of fixture.steps) {
    clock.set(step.at);
    let produced: ReadonlyArray<AttentionDecision> = [];
    switch (step.kind) {
      case 'candidate':
        produced = policy.submit(requireCandidate(step));
        break;
      case 'tick':
        produced = policy.tick();
        break;
      case 'settings':
        policy.updateSettings(step.settings ?? {});
        break;
      case 'user-speaking-start':
        policy.userSpeechStarted();
        break;
      case 'user-speaking-end':
        policy.userSpeechEnded();
        break;
    }
    assertStepReceipts(step, produced);
    for (const receipt of produced) {
      assert.equal(receipt.decidedAt, step.at, `${step.id}/${receipt.candidateId}: decidedAt must come from the injected clock`);
      if (receipt.outcome === 'spoken') {
        const lease = receipt.lease;
        assert.ok(lease, `${step.id}/${receipt.candidateId}: a spoken receipt must carry a lease`);
        assert.equal(policy.canSpeak(lease), true, `${step.id}/${receipt.candidateId}: its lease must be live at the decision`);
        const issued = Date.parse(receipt.decidedAt);
        const expires = Date.parse(lease.expiresAt);
        assert.ok(
          Number.isFinite(expires) && expires > issued && expires - issued <= MAX_LEASE_MS,
          `${step.id}/${receipt.candidateId}: a grant must expire after the decision and within ${MAX_LEASE_MS} ms`,
        );
      } else {
        assert.equal(receipt.lease, undefined, `${step.id}/${receipt.candidateId}: only spoken receipts carry a lease`);
      }
    }
    if (step.kind === 'candidate') {
      const submitted = requireCandidate(step);
      const primary = produced.find((receipt) => receipt.candidateId === submitted.candidateId);
      assert.ok(primary, `${step.id}: the submitted candidate produced no receipt`);
      assert.equal(primary.sourceId, submitted.sourceId, `${step.id}: the receipt must name its source`);
      assert.equal(primary.eventClass, submitted.eventClass, `${step.id}: the receipt must name the event class`);
      assert.equal(primary.eventId, submitted.eventId, `${step.id}: the receipt must cite the durable event`);
    }
  }
  return { receipts: policy.decisions(), policy };
}

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as StreamFixture;
assert.equal(fixture.version, 1, 'the R02 stream fixture must speak version 1');
assert.equal(fixture.consent, 'synthetic', 'the R02 stream fixture must be synthetic');

test('R02: every pillar speaks only through a policy-issued lease', () => {
  const clock = fakeClock(CLOCK_START);
  const matrix: ReadonlyArray<Readonly<{ sourceId: string; eventClass: AttentionEventClass }>> = [
    { sourceId: 'narration', eventClass: 'turn-complete' },
    { sourceId: 'harness', eventClass: 'routine-progress' },
    { sourceId: 'memory', eventClass: 'important-failure' },
    { sourceId: 'capture', eventClass: 'blocking' },
    { sourceId: 'desktop', eventClass: 'blocking' },
    { sourceId: 'gaze', eventClass: 'blocking' },
    { sourceId: 'voice', eventClass: 'user-requested' },
  ];
  for (const [index, entry] of matrix.entries()) {
    const policy = newPolicy(clock);
    const probe = audioProbe(policy);
    const receipt = only(
      policy.submit(candidate(`lease-${index}`, entry.sourceId, entry.eventClass, `ev-lease-${index}`)),
      `lease-${index}`,
    );
    const lease = assertSpoken(receipt);
    assert.equal(policy.canSpeak(lease), true, `${entry.sourceId} must hold a live lease to speak`);
    assert.equal(probe.play(lease, receipt.eventId, 'authorized audio'), true);
    assert.equal(policy.canSpeak({ ...lease }), false, `${entry.sourceId} must not speak with a reconstructed lease`);
    assert.equal(probe.play({ ...lease }, receipt.eventId, 'late audio'), false);
    assert.equal(probe.emitted.length, 1, `${entry.sourceId}: only the authorized chunk may become audio`);
  }

  const policy = newPolicy(fakeClock(CLOCK_START));
  const surface = policy as unknown as Record<string, unknown>;
  for (const name of ['speak', 'speakNow', 'play', 'emit', 'say', 'announce']) {
    assert.notEqual(typeof surface[name], 'function', `attention must not expose a direct ${name}() shortcut`);
  }
});

test('R02: revoked and expired leases silence late audio', () => {
  const clock = fakeClock(CLOCK_START);
  const policy = newPolicy(clock);
  const probe = audioProbe(policy);
  const lease = assertSpoken(only(
    policy.submit(candidate('revoke-1', 'capture', 'blocking', 'ev-revoke-1')),
    'revoke-1',
  ));
  assert.equal(probe.play(lease, 'ev-revoke-1', 'permission needed'), true);

  policy.updateSettings({ muted: true });
  assert.equal(policy.canSpeak(lease), false, 'mute must revoke live grants immediately');
  assert.equal(probe.play(lease, 'ev-revoke-1', 'late permission audio'), false, 'late audio after revocation is dropped');
  const suppressed = only(
    policy.submit(candidate('revoke-2', 'capture', 'blocking', 'ev-revoke-2')),
    'revoke-2',
  );
  assert.equal(suppressed.outcome, 'suppressed');
  assert.equal(suppressed.reason, 'muted');
  assert.equal(suppressed.setting, 'muted');
  assert.equal(suppressed.lease, undefined);
  assert.match(suppressed.explanation, /mute/i);
  assert.equal(probe.emitted.length, 1, 'nothing may be spoken while muted');

  const revokeClock = fakeClock(CLOCK_START);
  const revokePolicy = newPolicy(revokeClock);
  const revokeProbe = audioProbe(revokePolicy);
  const revoked = assertSpoken(only(
    revokePolicy.submit(candidate('revoke-3', 'desktop', 'important-failure', 'ev-revoke-3')),
    'revoke-3',
  ));
  revokePolicy.revokeSpeech('user-stop');
  assert.equal(revokePolicy.canSpeak(revoked), false, 'revokeSpeech must invalidate the live grant');
  assert.equal(revokeProbe.play(revoked, 'ev-revoke-3', 'late failure audio'), false);

  const expiryClock = fakeClock(CLOCK_START);
  const expiryPolicy = newPolicy(expiryClock);
  const expiryProbe = audioProbe(expiryPolicy);
  const expiring = assertSpoken(only(
    expiryPolicy.submit(candidate('expire-1', 'gaze', 'blocking', 'ev-expire-1')),
    'expire-1',
  ));
  expiryClock.set(new Date(Date.parse(expiring.expiresAt) + 1).toISOString());
  assert.equal(expiryPolicy.canSpeak(expiring), false, 'a lease is invalid at its expiry');
  assert.equal(expiryProbe.play(expiring, 'ev-expire-1', 'late gaze audio'), false);

  const requestClock = fakeClock(CLOCK_START);
  const requestPolicy = newPolicy(requestClock);
  const future = new Date(requestClock.now().getTime() + 5_000).toISOString();
  assert.equal(requestPolicy.requestSpeech('ev-unknown', future), null, 'an unknown event has no authority');
  requestPolicy.userSpeechStarted();
  const deferred = only(
    requestPolicy.submit(candidate('request-1', 'capture', 'blocking', 'ev-request-1')),
    'request-1',
  );
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(requestPolicy.requestSpeech('ev-request-1', future), null, 'a deferred candidate has no lease yet');
  requestPolicy.userSpeechEnded();
  requestClock.advance(SAFE_GAP_MS + 500);
  const resumed = assertSpoken(only(requestPolicy.tick(), 'request-1'), 'blocking-safe-gap');
  const issued = requestPolicy.requestSpeech('ev-request-1', future);
  assert.ok(issued, 'the §5.3 seam must hand back the live grant for a spoken event');
  assert.equal(requestPolicy.canSpeak(issued), true);
  assert.equal(resumed.eventId, 'ev-request-1');
  requestPolicy.updateSettings({ muted: true });
  assert.equal(requestPolicy.requestSpeech('ev-request-1', future), null, 'mute closes the seam');
});

test('R02: blocking events preempt routine assistant speech', () => {
  const clock = fakeClock(CLOCK_START);
  const policy = newPolicy(clock);
  const probe = audioProbe(policy);
  const routine = assertSpoken(only(
    policy.submit(candidate('preempt-routine', 'harness', 'routine-progress', 'ev-progress-9')),
    'preempt-routine',
  ), 'routine-digest');
  const routineProbe = audioProbe(policy);
  clock.advance(2_000);
  const blocking = assertSpoken(only(
    policy.submit(candidate('preempt-blocking', 'capture', 'blocking', 'ev-permission-9')),
    'preempt-blocking',
  ), 'blocking-safe-gap');

  assert.equal(policy.canSpeak(routine), false, 'the routine utterance must be interrupted, not overlapped');
  assert.equal(routineProbe.play(routine, 'ev-progress-9', 'late routine audio'), false);
  const interrupted = latest(policy, 'preempt-routine');
  assert.equal(interrupted.outcome, 'interrupted');
  assert.equal(interrupted.reason, 'interrupted-by-blocking');
  assert.equal(interrupted.lease, undefined);
  assert.equal(probe.play(blocking, 'ev-permission-9', 'permission needed'), true);

  const summaryClock = fakeClock(CLOCK_START);
  const summaryPolicy = newPolicy(summaryClock);
  const summary = assertSpoken(only(
    summaryPolicy.submit(candidate('preempt-summary', 'narration', 'turn-complete', 'ev-turn-9')),
    'preempt-summary',
  ), 'turn-complete-quiet-gap');
  assertSpoken(only(
    summaryPolicy.submit(candidate('preempt-failure', 'memory', 'important-failure', 'ev-failure-9')),
    'preempt-failure',
  ), 'important-failure-decision');
  assert.equal(summaryPolicy.canSpeak(summary), false, 'an important failure interrupts the summary');
  assert.equal(latest(summaryPolicy, 'preempt-summary').reason, 'interrupted-by-important-failure');
});

test('R02: explicit output silence is never overridden by a blocking event', () => {
  const clock = fakeClock(CLOCK_START);
  const silent = newPolicy(clock, { outputSilence: true });
  const probe = audioProbe(silent);
  const suppressed = only(
    silent.submit(candidate('silent-blocking', 'capture', 'blocking', 'ev-permission-s')),
    'silent-blocking',
  );
  assert.equal(suppressed.outcome, 'suppressed', 'a blocking event may not bypass explicit silence');
  assert.equal(suppressed.reason, 'explicit-output-silence');
  assert.equal(suppressed.setting, 'outputSilence');
  assert.equal(suppressed.lease, undefined);
  assert.match(suppressed.explanation, /silence/i);
  assert.equal(probe.emitted.length, 0);
  assert.equal(
    silent.requestSpeech('ev-permission-s', new Date(clock.now().getTime() + 5_000).toISOString()),
    null,
    'no lease may be minted while silence is explicit',
  );
  const reply = only(
    silent.submit(candidate('silent-reply', 'voice', 'user-requested', 'ev-answer-s')),
    'silent-reply',
  );
  assert.equal(reply.reason, 'explicit-output-silence', 'user-requested replies obey explicit silence too');

  const control = newPolicy(fakeClock(CLOCK_START));
  assertSpoken(only(
    control.submit(candidate('open-blocking', 'capture', 'blocking', 'ev-permission-o')),
    'open-blocking',
  ), 'blocking-safe-gap');
});

test('R02: nothing talks over the user utterance and the blocking event resumes at the safe gap', () => {
  const clock = fakeClock(CLOCK_START);
  const policy = newPolicy(clock);
  const probe = audioProbe(policy);
  policy.userSpeechStarted();
  const deferred = only(
    policy.submit(candidate('talk-1', 'capture', 'blocking', 'ev-permission-t')),
    'talk-1',
  );
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(deferred.reason, 'user-speaking-safe-gap');
  assert.equal(deferred.setting ?? null, null);
  assert.equal(deferred.lease, undefined);
  assert.match(deferred.explanation, /user|utterance|speaking|talk/i);
  const pending = policy.pending();
  assert.equal(pending.length, 1, 'the deferred blocking request stays pending');
  assert.equal(pending[0]!.candidateId, 'talk-1');
  assert.equal(pending[0]!.reason, 'user-speaking-safe-gap');
  assert.equal(pending[0]!.deferredAt, CLOCK_START);

  clock.advance(1_500);
  assert.deepEqual(policy.tick(), [], 'a tick while the utterance is open changes nothing');
  assert.equal(policy.pending().length, 1);
  assert.deepEqual(probe.emitted, [], 'nothing may be spoken over the user');

  policy.userSpeechEnded();
  clock.advance(SAFE_GAP_MS + 500);
  const resumed = assertSpoken(only(policy.tick(), 'talk-1'), 'blocking-safe-gap');
  assert.equal(probe.play(resumed, 'ev-permission-t', 'Permission needed.'), true);
  assert.equal(policy.pending().length, 0, 'the resumption clears the pending record');
  const trail = policy.decisions().filter((receipt) => receipt.candidateId === 'talk-1').map((receipt) => receipt.outcome);
  assert.deepEqual(trail, ['deferred', 'spoken'], 'the deferral and the resumption stay auditable');

  const otherClock = fakeClock(CLOCK_START);
  const other = newPolicy(otherClock);
  other.userSpeechStarted();
  const important = only(
    other.submit(candidate('talk-2', 'memory', 'important-failure', 'ev-failure-t')),
    'talk-2',
  );
  assert.equal(important.outcome, 'deferred', 'an important failure never talks over the user either');
  assert.equal(important.lease, undefined);
});

test('R02: turn-complete summaries wait for the quiet gap and are replaced per turn', () => {
  const clock = fakeClock(CLOCK_START);
  const policy = newPolicy(clock);
  policy.userSpeechStarted();
  clock.advance(1_000);
  policy.userSpeechEnded();
  clock.advance(300);
  const early = only(
    policy.submit(candidate('summary-1', 'narration', 'turn-complete', 'ev-turn-a', { turnId: 'turn-7' })),
    'summary-1',
  );
  assert.equal(early.outcome, 'deferred');
  assert.equal(early.reason, 'quiet-gap-not-elapsed');
  assert.equal(early.lease, undefined);
  clock.advance(QUIET_GAP_MS - 350);
  assert.deepEqual(policy.tick(), [], `less than ${QUIET_GAP_MS} ms of quiet must not speak`);
  clock.advance(150);
  assertSpoken(only(policy.tick(), 'summary-1'), 'turn-complete-quiet-gap');

  const replaceClock = fakeClock(CLOCK_START);
  const replacePolicy = newPolicy(replaceClock);
  const probe = audioProbe(replacePolicy);
  replacePolicy.userSpeechStarted();
  const stale = only(
    replacePolicy.submit(candidate('summary-stale', 'narration', 'turn-complete', 'ev-turn-b', { turnId: 'turn-8' })),
    'summary-stale',
  );
  assert.equal(stale.outcome, 'deferred');
  const newer = only(
    replacePolicy.submit(candidate('summary-new', 'narration', 'turn-complete', 'ev-turn-c', { turnId: 'turn-8' })),
    'summary-new',
  );
  assert.equal(newer.outcome, 'deferred');
  const replaced = latest(replacePolicy, 'summary-stale');
  assert.equal(replaced.outcome, 'replaced');
  assert.equal(replaced.reason, 'replaced-stale-completion');
  assert.equal(replaced.lease, undefined);
  replacePolicy.userSpeechEnded();
  replaceClock.advance(QUIET_GAP_MS + 250);
  const spoken = assertSpoken(only(replacePolicy.tick(), 'summary-new'), 'turn-complete-quiet-gap');
  assert.equal(probe.play(spoken, 'ev-turn-c', 'Turn two finished.'), true);
  assert.equal(
    replacePolicy.decisions().filter((receipt) => receipt.candidateId === 'summary-stale' && receipt.outcome === 'spoken').length,
    0,
    'the stale summary must never be spoken',
  );
  assert.ok(!replacePolicy.pending().some((entry) => entry.candidateId === 'summary-stale'));
});

test('R02: presets and event priority overrides explain what may speak', () => {
  const focusedClock = fakeClock(CLOCK_START);
  const focused = newPolicy(focusedClock);
  assertSpoken(only(
    focused.submit(candidate('preset-f1', 'harness', 'routine-progress', 'ev-preset-f1')),
    'preset-f1',
  ), 'routine-digest');
  const handsFreeClock = fakeClock(CLOCK_START);
  const handsFree = newPolicy(handsFreeClock, { preset: 'hands-free' });
  assertSpoken(only(
    handsFree.submit(candidate('preset-h1', 'harness', 'routine-progress', 'ev-preset-h1')),
    'preset-h1',
  ), 'routine-digest');

  focusedClock.advance(40_000);
  const stillCooling = only(
    focused.submit(candidate('preset-f2', 'harness', 'routine-progress', 'ev-preset-f2')),
    'preset-f2',
  );
  assert.equal(stillCooling.outcome, 'suppressed', 'focused-work keeps the 120 s cooldown');
  assert.equal(stillCooling.reason, 'cooldown-active');
  assert.equal(stillCooling.setting, 'preset');
  assert.match(stillCooling.explanation, /cooldown/i);
  handsFreeClock.advance(40_000);
  assertSpoken(only(
    handsFree.submit(candidate('preset-h2', 'harness', 'routine-progress', 'ev-preset-h2')),
    'preset-h2',
  ), 'routine-digest');

  focused.updateSettings({ preset: 'hands-free' });
  focusedClock.advance(35_000);
  assertSpoken(only(
    focused.submit(candidate('preset-f3', 'harness', 'routine-progress', 'ev-preset-f3')),
    'preset-f3',
  ), 'routine-digest');

  const presentation = newPolicy(fakeClock(CLOCK_START), { preset: 'presentation' });
  const still = only(
    presentation.submit(candidate('preset-p1', 'capture', 'blocking', 'ev-preset-p1')),
    'preset-p1',
  );
  assert.equal(still.outcome, 'visual', 'presentation mode is visual-only, blocking included');
  assert.equal(still.reason, 'preset-visual-only');
  assert.equal(still.setting, 'preset');
  assert.match(still.explanation, /presentation/i);
  presentation.updateSettings({ preset: 'focused-work' });
  assertSpoken(only(
    presentation.submit(candidate('preset-p2', 'capture', 'blocking', 'ev-preset-p2')),
    'preset-p2',
  ), 'blocking-safe-gap');

  const critical = newPolicy(fakeClock(CLOCK_START), { preset: 'critical-only' });
  const criticalRoutine = only(
    critical.submit(candidate('preset-c1', 'harness', 'routine-progress', 'ev-preset-c1')),
    'preset-c1',
  );
  assert.equal(criticalRoutine.outcome, 'visual');
  assert.equal(criticalRoutine.setting, 'preset');
  assert.match(criticalRoutine.explanation, /critical/i);
  assertSpoken(only(
    critical.submit(candidate('preset-c2', 'capture', 'blocking', 'ev-preset-c2')),
    'preset-c2',
  ), 'blocking-safe-gap');

  const overridden = newPolicy(fakeClock(CLOCK_START), {
    eventPriorities: { 'routine-progress': 'visual', 'background-session': 'blocking' },
  });
  const lowered = only(
    overridden.submit(candidate('override-1', 'harness', 'routine-progress', 'ev-override-1')),
    'override-1',
  );
  assert.equal(lowered.outcome, 'visual');
  assert.equal(lowered.reason, 'priority-override-visual');
  assert.equal(lowered.setting, 'eventPriorities');
  assert.match(lowered.explanation, /priority|override/i);
  const raised = only(
    overridden.submit(candidate('override-2', 'desktop', 'background-session', 'ev-override-2')),
    'override-2',
  );
  assert.equal(raised.outcome, 'spoken', 'a raised priority may speak');
  assert.equal(raised.setting, 'eventPriorities');
  assert.match(raised.explanation, /priority|override/i);

  const cooldownClock = fakeClock(CLOCK_START);
  const cooldownPolicy = newPolicy(cooldownClock, { cooldownSeconds: 45 });
  assertSpoken(only(
    cooldownPolicy.submit(candidate('cooldown-1', 'harness', 'routine-progress', 'ev-cooldown-1')),
    'cooldown-1',
  ), 'routine-digest');
  cooldownClock.advance(40_000);
  const overrideCooling = only(
    cooldownPolicy.submit(candidate('cooldown-2', 'harness', 'routine-progress', 'ev-cooldown-2')),
    'cooldown-2',
  );
  assert.equal(overrideCooling.reason, 'cooldown-active');
  assert.equal(overrideCooling.setting, 'cooldownSeconds');
  cooldownClock.advance(10_000);
  assertSpoken(only(
    cooldownPolicy.submit(candidate('cooldown-3', 'harness', 'routine-progress', 'ev-cooldown-3')),
    'cooldown-3',
  ), 'routine-digest');
});

test('R02: the same event stream yields identical decisions under a fake clock', () => {
  const first = runStream(fixture);
  const second = runStream(fixture);
  assert.deepEqual(second.receipts, first.receipts, 'replaying the same synthetic stream must reproduce the same receipts');
  assert.ok(first.receipts.length > 0, 'the stream must produce receipts');
  const sources = new Set(first.receipts.map((receipt) => receipt.sourceId));
  for (const source of fixture.pillarSources) {
    assert.ok(sources.has(source), `no receipt explains a candidate from pillar source ${source}`);
  }
  for (const receipt of first.receipts) {
    if (receipt.outcome === 'spoken') {
      assert.ok(receipt.lease, `${receipt.candidateId} spoke without a lease`);
    } else {
      assert.equal(receipt.lease, undefined, `${receipt.candidateId} holds a lease while ${receipt.outcome}`);
    }
  }
});

test('R02: every receipt explains why an update was spoken, suppressed or deferred', () => {
  const run = runStream(fixture);
  for (const receipt of run.receipts) {
    assert.ok(receipt.reason.length > 0, `${receipt.candidateId} needs a stable reason token`);
    assert.ok(
      SPOKEN_REASONS.has(receipt.reason) || OTHER_REASONS.has(receipt.reason),
      `${receipt.candidateId}: undocumented reason ${receipt.reason}`,
    );
    assert.ok(receipt.explanation.trim().length > 0, `${receipt.candidateId} must explain ${receipt.outcome}`);
  }
  const latestFor = (candidateId: string): AttentionDecision => {
    const matches = run.receipts.filter((receipt) => receipt.candidateId === candidateId);
    assert.ok(matches.length > 0, `no receipt for ${candidateId}`);
    return matches.at(-1)!;
  };

  const silenced = latestFor('stream-c2');
  assert.equal(silenced.reason, 'explicit-output-silence');
  assert.equal(silenced.setting, 'outputSilence');
  assert.match(silenced.explanation, /silence/i, 'the explanation must name explicit output silence');
  const muted = latestFor('stream-c3');
  assert.equal(muted.reason, 'muted');
  assert.equal(muted.setting, 'muted');
  assert.match(muted.explanation, /mute/i);
  const cooldown = latestFor('stream-h2');
  assert.equal(cooldown.reason, 'cooldown-active');
  assert.equal(cooldown.setting, 'preset');
  assert.match(cooldown.explanation, /cooldown/i);
  const visual = latestFor('stream-b1');
  assert.equal(visual.reason, 'preset-visual-only');
  assert.equal(visual.setting, 'preset');
  assert.match(visual.explanation, /focused.work/i, 'the explanation must name the focused-work preset');
  const deferral = run.receipts.find((receipt) => receipt.candidateId === 'stream-c1' && receipt.outcome === 'deferred');
  assert.ok(deferral, 'the blocking candidate must have a deferral receipt');
  assert.match(deferral.explanation, /user|utterance|speaking/i, 'the deferral must name the user utterance');
  const resumed = latestFor('stream-c1');
  assert.equal(resumed.outcome, 'spoken');
  assert.equal(resumed.reason, 'blocking-safe-gap');
});
