/**
 * Focused N01 unit checks beyond the frozen acceptance oracle: turn deduplication across repeated
 * `turn/completed` events, receipt-only reduction for agent-reported exit codes, the blocking gap
 * announcement, and the durable heard receipts written through the M01 memory sink.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DurableCursor,
  EventEnvelope,
  SpeechLease,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../contracts/src/index.js';
import { createNarrationTracer } from './index.js';

const NOW = new Date('2026-09-13T10:00:00.000Z');

type EnvelopeInput = Readonly<{
  eventId: string;
  kind: EventEnvelope['kind'];
  turnId?: string;
  trust?: EventEnvelope['trust'];
  sessionId?: string;
}>;

function envelope(input: EnvelopeInput): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    sourceId: 'test-source',
    sourceEventId: `source#${input.eventId}`,
    sourceSequence: 1,
    ingestSequence: 1,
    occurredAt: '2026-09-13T09:59:59.000Z',
    observedAt: '2026-09-13T09:59:59.100Z',
    scope: { profileId: 'profile-test', sessionId: input.sessionId ?? 'session-test', sensitivity: 'normal' },
    kind: input.kind,
    payloadRef: `fixture://test/${input.eventId}`,
    contentHash: `sha256:${input.eventId}`,
    trust: input.trust ?? 'tool_observed',
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
}

function attentionDouble(mode: 'grant' | 'muted'): Readonly<{
  issued: Set<SpeechLease>;
  requests: string[];
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
}> {
  const issued = new Set<SpeechLease>();
  const requests: string[] = [];
  return {
    issued,
    requests,
    requestSpeech(eventId, expiresAt) {
      requests.push(eventId);
      if (mode === 'muted') return null;
      const lease: SpeechLease = { eventId, epoch: 1, expiresAt };
      issued.add(lease);
      return lease;
    },
  };
}

type Submission = Readonly<{ plan: SpeechPlan; lease: SpeechLease; audible: boolean }>;

function voiceDouble(attention: Readonly<{ issued: Set<SpeechLease> }>): Readonly<{
  submissions: Submission[];
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}> {
  const submissions: Submission[] = [];
  return {
    submissions,
    async submitSpeech(plan, lease) {
      const audible = attention.issued.has(lease)
        && lease.epoch === plan.epoch
        && Date.parse(lease.expiresAt) > NOW.getTime();
      submissions.push({ plan, lease, audible });
      if (!audible) return [];
      return plan.segments.map((segment) => ({
        planId: plan.planId,
        segmentId: segment.id,
        positionMs: Math.round(segment.maxSeconds * 1_000),
        status: 'completed' as const,
      }));
    },
  };
}

function memoryDouble(): Readonly<{
  batches: Array<ReadonlyArray<EventEnvelope>>;
  ingest(batch: ReadonlyArray<EventEnvelope>): Promise<DurableCursor>;
}> {
  const batches: Array<ReadonlyArray<EventEnvelope>> = [];
  return {
    batches,
    async ingest(batch) {
      batches.push(batch);
      return { value: `cursor:${batches.length}` };
    },
  };
}

async function completeTurn(
  tracer: Readonly<{ ingest(input: Readonly<{ event: EventEnvelope; payload: unknown }>): Promise<unknown> }>,
  turnId: string,
  receipt: Readonly<{ eventId: string; exitCode: number; output: string }>,
): Promise<void> {
  const common = { taskId: 'task-test', command: 'node fixtures/narration/basic/check-readonly-suite.mjs --read-only' };
  await tracer.ingest({
    event: envelope({ eventId: `${turnId}-start`, kind: 'tool_started', turnId }),
    payload: { ...common, receiptId: `receipt-${turnId}` },
  });
  await tracer.ingest({
    event: envelope({ eventId: receipt.eventId, kind: 'tool_completed', turnId }),
    payload: { ...common, receiptId: `receipt-${turnId}`, exitCode: receipt.exitCode, output: receipt.output },
  });
  await tracer.ingest({
    event: envelope({ eventId: `${turnId}-turn-completed`, kind: 'session_state', turnId }),
    payload: { method: 'turn/completed', status: 'completed' },
  });
}

test('N01 unit: a turn speaks once, repeats stay silent, and a new turn speaks again', async () => {
  const attention = attentionDouble('grant');
  const voice = voiceDouble(attention);
  const tracer = createNarrationTracer({ attention, voice, now: () => NOW });

  await completeTurn(tracer, 'turn-1', { eventId: 'turn-1-complete', exitCode: 0, output: '24 checks, 24 passed, 0 failed\n' });
  assert.equal(voice.submissions.length, 1, 'one finished turn is one completion plan');
  const first = voice.submissions[0];
  assert.ok(first);
  assert.equal(first.plan.priority, 'completion');
  assert.equal(first.plan.sessionId, 'session-test');
  assert.equal(first.plan.segments.length, 1);
  assert.deepEqual(first.plan.segments[0]?.evidenceIds, [
    'turn-1-start',
    'turn-1-complete',
    'turn-1-turn-completed',
  ]);
  const firstText = first.plan.segments[0]?.text ?? '';
  assert.ok(firstText.includes('passed'), firstText);
  assert.ok(!firstText.includes('N01-LOG-'), 'log lines are never recited');

  const repeat = await tracer.ingest({
    event: envelope({ eventId: 'turn-1-turn-completed', kind: 'session_state', turnId: 'turn-1' }),
    payload: { method: 'turn/completed', status: 'completed' },
  });
  assert.equal(repeat.submitted, false, 'a repeated turn/completed must not speak twice');
  assert.equal(voice.submissions.length, 1);

  await completeTurn(tracer, 'turn-2', { eventId: 'turn-2-complete', exitCode: 2, output: 'boom\n' });
  assert.equal(voice.submissions.length, 2, 'a new turn gets its own single outcome');
  const second = voice.submissions[1];
  assert.ok(second);
  assert.equal(second.plan.priority, 'completion');
  const secondText = second.plan.segments[0]?.text ?? '';
  assert.ok(secondText.includes('exit code 2'), secondText);

  const replay = await tracer.replay();
  assert.equal(replay.length, 2, 'both audible outcomes are replayable, newest last');
  assert.equal(replay[0]?.planId, first.plan.planId);
  assert.equal(replay[1]?.planId, second.plan.planId);
  assert.equal(replay[1]?.sessionId, 'session-test');
  assert.ok(replay[1]?.evidenceIds.includes('turn-2-complete'));
});

test('N01 unit: an agent-reported exit code is context, never a receipt', async () => {
  const attention = attentionDouble('grant');
  const voice = voiceDouble(attention);
  const tracer = createNarrationTracer({ attention, voice, now: () => NOW });

  const claimed = await tracer.ingest({
    event: envelope({ eventId: 'claim-1', kind: 'tool_completed', turnId: 'turn-1', trust: 'agent_reported' }),
    payload: { taskId: 'task-test', exitCode: 0, output: '24 checks, 24 passed, 0 failed\n' },
  });
  assert.equal(claimed.outcome, null, 'an agent report must not become an observed outcome');

  const finished = await tracer.ingest({
    event: envelope({ eventId: 'turn-1-turn-completed', kind: 'session_state', turnId: 'turn-1' }),
    payload: { method: 'turn/completed', status: 'completed' },
  });
  assert.equal(finished.submitted, false, 'without a receipt there is nothing to confirm');
  assert.equal(voice.submissions.length, 0);
  assert.deepEqual([...(await tracer.replay())], []);
});

test('N01 unit: a receipt whose check summary contradicts its exit code omits the counts', async () => {
  const attention = attentionDouble('grant');
  const voice = voiceDouble(attention);
  const tracer = createNarrationTracer({ attention, voice, now: () => NOW });

  await completeTurn(tracer, 'turn-1', {
    eventId: 'turn-1-complete',
    exitCode: 1,
    output: 'N01-LOG-0022 not ok 22\n24 checks, 24 passed, 0 failed\n',
  });
  assert.equal(voice.submissions.length, 1);
  const failedText = voice.submissions[0]?.plan.segments[0]?.text ?? '';
  assert.equal(failedText, 'check-readonly-suite failed: exit code 1.');

  await completeTurn(tracer, 'turn-2', {
    eventId: 'turn-2-complete',
    exitCode: 0,
    output: '24 checks, 21 passed, 3 failed\n',
  });
  assert.equal(voice.submissions.length, 2);
  const passedText = voice.submissions[1]?.plan.segments[0]?.text ?? '';
  assert.equal(passedText, 'check-readonly-suite passed: exit code 0.');
});

test('N01 unit: a recorded evidence gap is announced once as a blocking outcome', async () => {
  const attention = attentionDouble('grant');
  const voice = voiceDouble(attention);
  const tracer = createNarrationTracer({ attention, voice, now: () => NOW });
  const gap = envelope({ eventId: 'gap-1', kind: 'gap', trust: 'imported' });

  const first = await tracer.ingest({ event: gap, payload: { reason: 'backpressure_spool_lost' } });
  assert.equal(first.submitted, true);
  assert.equal(voice.submissions.length, 1);
  const plan = voice.submissions[0]?.plan;
  assert.ok(plan);
  assert.equal(plan.priority, 'blocking');
  assert.deepEqual(plan.segments[0]?.evidenceIds, ['gap-1']);
  assert.ok(plan.dedupeKey.length > 0);

  const repeat = await tracer.ingest({ event: gap, payload: { reason: 'backpressure_spool_lost' } });
  assert.equal(repeat.submitted, false, 'the same gap is announced once');
  assert.equal(voice.submissions.length, 1);
  assert.equal((await tracer.replay()).length, 1);
});

test('N01 unit: heard receipts are persisted, and muted output is neither spoken nor persisted', async () => {
  const attention = attentionDouble('grant');
  const memory = memoryDouble();
  const tracer = createNarrationTracer({ attention, voice: voiceDouble(attention), now: () => NOW, memory });
  await completeTurn(tracer, 'turn-1', { eventId: 'turn-1-complete', exitCode: 1, output: '24 checks, 21 passed, 3 failed\n' });
  assert.equal(memory.batches.length, 1, 'one heard segment is one persisted batch');
  const batch = memory.batches[0] ?? [];
  assert.equal(batch.length, 1);
  const receipt = batch[0];
  assert.ok(receipt);
  assert.equal(receipt.kind, 'delivery_receipt');
  assert.equal(receipt.trust, 'tool_observed');
  assert.equal(receipt.scope.sessionId, 'session-test');
  assert.match(receipt.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(receipt.payloadRef.includes('narration://heard/'));

  const mutedAttention = attentionDouble('muted');
  const mutedMemory = memoryDouble();
  const muted = createNarrationTracer({
    attention: mutedAttention,
    voice: voiceDouble(mutedAttention),
    now: () => NOW,
    memory: mutedMemory,
  });
  await completeTurn(muted, 'turn-1', { eventId: 'turn-1-complete', exitCode: 1, output: '24 checks, 21 passed, 3 failed\n' });
  assert.deepEqual([...(await muted.replay())], [], 'muted output leaves nothing to replay');
  assert.equal(mutedMemory.batches.length, 0, 'nothing unheard is persisted as heard');
});
