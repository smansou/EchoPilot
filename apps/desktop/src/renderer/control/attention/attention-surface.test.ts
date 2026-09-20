import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttentionPolicy } from '../../../../../../packages/attention/src/index.js';
import type { SpeechCandidate } from '../../../../../../packages/attention/src/index.js';
import {
  createAttentionSurface,
  currentReceipt,
  explainReceipt,
  resumptionReceipt,
} from './attention-surface.js';

const CLOCK_START = '2026-09-21T09:00:00.000Z';
const SAFE_GAP_MS = 3_000;

function fakeClock(start: string): Readonly<{ now: () => Date; advance: (ms: number) => void }> {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function candidate(
  candidateId: string,
  eventClass: SpeechCandidate['eventClass'],
  eventId: string,
): SpeechCandidate {
  return { candidateId, sourceId: 'narration', eventClass, eventId, turnId: `turn-${candidateId}` };
}

test('R02 surface: a spoken row carries the policy explanation and its governing setting, not the lease', () => {
  const clock = fakeClock(CLOCK_START);
  const surface = createAttentionSurface(createAttentionPolicy({ now: clock.now }));

  const [spoken] = surface.submit(candidate('surface-1', 'turn-complete', 'ev-surface-1'));
  assert.equal(spoken?.outcome, 'spoken');
  assert.equal(spoken?.reason, 'turn-complete-quiet-gap');
  assert.equal(spoken?.setting, null, 'a turn summary inside the quiet gap cites no setting');
  assert.equal(
    Object.hasOwn(spoken ?? {}, 'lease'),
    false,
    'renderer state must never hold speech authority',
  );
  assert.equal(spoken?.decidedAt, CLOCK_START);
  assert.equal(explainReceipt(spoken!), spoken?.explanation);
  assert.equal(surface.view().settings.preset, 'focused-work', 'defaults come from the policy');
});

test('R02 surface: mute renders from settings and the suppression row explains itself after unmute', () => {
  const clock = fakeClock(CLOCK_START);
  const policy = createAttentionPolicy({ now: clock.now });
  const surface = createAttentionSurface(policy);

  assert.equal(surface.updateSettings({ muted: true }).settings.muted, true);
  const [suppressed] = surface.submit(candidate('surface-mute', 'blocking', 'ev-surface-mute'));
  assert.equal(suppressed?.outcome, 'suppressed');
  assert.equal(suppressed?.setting, 'muted');
  assert.match(explainReceipt(suppressed!), /governed by setting: muted/);
  assert.equal(surface.view().pending.length, 0, 'mute drops the queue instead of deferring');

  const reopened = surface.updateSettings({ muted: false });
  assert.equal(reopened.settings.muted, false);
  assert.equal(
    currentReceipt(reopened, 'surface-mute')?.outcome,
    'suppressed',
    'the append-only trail still explains why that update stayed silent',
  );
});

test('R02 surface: a deferral and the spoken receipt that resumed it are paired and both notified', () => {
  const clock = fakeClock(CLOCK_START);
  const policy = createAttentionPolicy({ now: clock.now });
  const surface = createAttentionSurface(policy);
  const notified: Array<Readonly<{ candidateId: string; outcome: string }>> = [];
  const unsubscribe = surface.subscribe((receipt) => {
    notified.push({ candidateId: receipt.candidateId, outcome: receipt.outcome });
  });

  policy.userSpeechStarted();
  const [deferred] = surface.submit(candidate('surface-resume', 'blocking', 'ev-surface-resume'));
  assert.equal(deferred?.outcome, 'deferred');
  assert.equal(surface.view().pending.length, 1);
  assert.equal(resumptionReceipt(surface.view(), 'surface-resume'), null, 'still waiting');

  policy.userSpeechEnded();
  clock.advance(SAFE_GAP_MS + 500);
  const [resumed] = surface.tick();
  assert.equal(resumed?.outcome, 'spoken');
  assert.equal(resumed?.reason, 'blocking-safe-gap');

  const pair = resumptionReceipt(surface.view(), 'surface-resume');
  assert.equal(pair?.deferred.outcome, 'deferred');
  assert.equal(pair?.resolved.outcome, 'spoken');
  assert.deepEqual(notified, [
    { candidateId: 'surface-resume', outcome: 'deferred' },
    { candidateId: 'surface-resume', outcome: 'spoken' },
  ]);

  unsubscribe();
  clock.advance(60_000);
  surface.submit(candidate('surface-2', 'important-failure', 'ev-surface-2'));
  assert.equal(notified.length, 2, 'unsubscribe stops the notifications');
});

test('R02 surface: the trail is bounded and newest-first across every pillar source', () => {
  const clock = fakeClock(CLOCK_START);
  const surface = createAttentionSurface(createAttentionPolicy({ now: clock.now }), { receiptLimit: 2 });

  surface.submit(candidate('surface-a', 'blocking', 'ev-surface-a'));
  clock.advance(60_000);
  surface.submit({ ...candidate('surface-b', 'important-failure', 'ev-surface-b'), sourceId: 'memory' });
  clock.advance(60_000);
  surface.submit({ ...candidate('surface-c', 'routine-progress', 'ev-surface-c'), sourceId: 'harness' });

  const view = surface.view();
  assert.deepEqual(
    view.receipts.map((receipt) => receipt.candidateId),
    ['surface-c', 'surface-b'],
    'newest first, older rows dropped once the bound is reached',
  );
  assert.deepEqual(
    [...new Set(view.receipts.map((receipt) => receipt.sourceId))],
    ['harness', 'memory'],
    'no pillar is special-cased: receipts keep the producing source',
  );
});
