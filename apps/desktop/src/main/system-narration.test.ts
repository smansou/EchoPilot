import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';
import { createSystemNarration } from './system-narration';

const at = '2026-09-29T09:00:00.000Z';

test('privacy stop forgets the cached reply before a later turn completion can speak it', () => {
  const spoken: string[] = [];
  const narration = createSystemNarration({ enabled: () => true, speak: plan => { spoken.push(plan.text); }, silence() {} });
  narration.ingest(event('agent_message', 'forgotten-message'), { text: 'Forgotten private canary' });
  narration.stop(); narration.ingest(event('session_state', 'later-completion'), { phase: 'completed' });
  assert.equal(spoken.length, 0);
});
function event(kind: EventEnvelope['kind'], id: string): EventEnvelope {
  return {
    schemaVersion: 1, eventId: id, sourceId: 'codex-test', sourceEventId: id,
    sourceSequence: 1, ingestSequence: 1, occurredAt: at, observedAt: at,
    scope: { profileId: 'local', projectId: 'project', sessionId: 'session', sensitivity: 'normal' },
    kind, payloadRef: `codex://${id}`, contentHash: id, trust: 'agent_reported', turnId: id,
  };
}

test('system narration speaks one bounded completion under the attention policy and obeys mute', () => {
  const spoken: string[] = [];
  let stopped = 0;
  const narration = createSystemNarration({
    enabled: () => true,
    speak: (plan) => spoken.push(plan.text),
    silence: () => { stopped += 1; },
    now: () => new Date(at),
  });
  narration.ingest(event('agent_message', 'message-1'), { text: 'The tests passed. ```secret code``` The result is ready.' });
  narration.ingest(event('session_state', 'complete-1'), { phase: 'completed' });
  assert.equal(spoken.length, 1);
  assert.match(spoken[0]!, /^Codex replied: The tests passed/);
  assert.doesNotMatch(spoken[0]!, /secret code/);

  narration.setMuted(true);
  narration.ingest(event('agent_message', 'message-2'), { text: 'A second result.' });
  narration.ingest(event('session_state', 'complete-2'), { phase: 'completed' });
  assert.equal(spoken.length, 1);
  assert.ok(stopped > 0);
});

test('narration uses live verbosity and persona without inventing success or leaking code', () => {
  const spoken: string[] = [];
  const narration = createSystemNarration({ enabled: () => true, speak: (plan) => spoken.push(plan.text),
    silence() {}, now: () => new Date(at), verbosity: () => 'concise', persona: () => 'engineering-direct' });
  narration.ingest(event('agent_message', 'message'), { text: Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') });
  narration.ingest(event('session_state', 'completed'), { phase: 'completed' });
  assert.match(spoken[0]!, /^Agent reported:/);
  assert.doesNotMatch(spoken[0]!, /word18/);
  assert.ok(spoken[0]!.length <= 500);
  narration.stop();
});

test('approval announcement requests review and never grants or claims authorization', () => {
  const spoken: string[] = [];
  const narration = createSystemNarration({ enabled: () => true, speak: (plan) => spoken.push(plan.text), silence() {}, now: () => new Date(at) });
  narration.ingest(event('approval_requested', 'approval'), {});
  assert.equal(spoken.length, 1);
  assert.match(spoken[0]!, /Review the exact request/);
  narration.stop();
});
