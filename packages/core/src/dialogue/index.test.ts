/**
 * Focused behavior tests for the dialogue session (plan §5.6): grounded answers, observed
 * delivery acknowledgments, concise clarifications, and silent holds. The frozen R01 acceptance
 * oracle covers the end-to-end path; these tests pin the individual rules.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EventEnvelope,
  HarnessAdapter,
  HarnessCapability,
  HarnessDeliveryReceipt,
  Memory,
  Scope,
  SpeechPlan,
  VoiceOutputEvent,
} from '@echopilot/contracts';

import { createAddresseeRouter, type ManagedSession } from '../../../routing/src/index.js';
import { createDialogueSession, stripAddressee, type DialogueSession } from './index.js';

const SCOPE: Scope = { profileId: 'r01-profile', projectId: 'atlas', sensitivity: 'normal' };

const SESSIONS: ReadonlyArray<ManagedSession> = [
  { sessionId: 'codex-parser', harness: 'codex', label: 'Codex: parser', projectId: 'atlas', active: true },
  { sessionId: 'codex-tests', harness: 'codex', label: 'Codex: tests', projectId: 'atlas', active: true },
  { sessionId: 'claude-docs', harness: 'claude', label: 'Claude: docs', projectId: 'atlas', active: true },
];

/** One Codex and one Claude session: "Tell Codex" uniquely names codex-parser. */
const UNIQUE_SESSIONS: ReadonlyArray<ManagedSession> = SESSIONS.filter((session) => session.sessionId !== 'codex-tests');

const SUMMARY = 'Codex: parser ran the parser test suite: 3 of 42 parser tests failed with exit code 1.';

type LogEntry = Readonly<{ kind: 'send' | 'speak'; detail: string }>;

type SendRecord = Readonly<{
  sessionId: string;
  instruction: string;
  deliveryId: string;
  outboxAtSend: ReadonlyArray<Readonly<{ deliveryId: string; state: string }>>;
}>;

function createMemoryDouble(
  evidenceIds: ReadonlyArray<string> = ['event-1', 'event-2'],
  summary: string = SUMMARY,
): Readonly<{ memory: Memory; queries: Array<Readonly<{ query: string; budget: number }>> }> {
  const queries: Array<Readonly<{ query: string; budget: number }>> = [];
  const memory: Memory = {
    async ingest() {
      return { value: 'synthetic-cursor' };
    },
    async query(query, _scope, budget) {
      queries.push({ query, budget });
      return { evidenceIds: [...evidenceIds], summary };
    },
    async consolidate(cursor) {
      return { checkpoint: cursor.value };
    },
    async forget() {
      return { deleted: 0 };
    },
  };
  return { memory, queries };
}

function createAdapterDouble(options: Readonly<{
  sessionId: string;
  status: HarnessDeliveryReceipt['status'];
  log: LogEntry[];
  outboxAtSend: () => ReadonlyArray<Readonly<{ deliveryId: string; state: string }>>;
}>): Readonly<{ adapter: HarnessAdapter; sends: SendRecord[] }> {
  const sends: SendRecord[] = [];
  const capabilities: ReadonlySet<HarnessCapability> = new Set<HarnessCapability>(['observe', 'send']);
  const adapter: HarnessAdapter = {
    async capabilities() {
      return capabilities;
    },
    async start(): Promise<void> {},
    async *observe(): AsyncIterable<EventEnvelope> {},
    async send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
      sends.push({ sessionId: options.sessionId, instruction, deliveryId, outboxAtSend: options.outboxAtSend() });
      options.log.push({ kind: 'send', detail: `${options.sessionId} ${instruction}` });
      return { deliveryId, status: options.status };
    },
    async interrupt(): Promise<void> {},
    async respondApproval(): Promise<void> {},
    async resume(): Promise<void> {},
    async close(): Promise<void> {},
  };
  return { adapter, sends };
}

function createSpeakDouble(log: LogEntry[]): Readonly<{ speak: (plan: SpeechPlan) => Promise<ReadonlyArray<VoiceOutputEvent>>; plans: SpeechPlan[] }> {
  const plans: SpeechPlan[] = [];
  const speak = async (plan: SpeechPlan): Promise<ReadonlyArray<VoiceOutputEvent>> => {
    plans.push(plan);
    log.push({ kind: 'speak', detail: plan.segments.map((segment) => segment.text).join(' ') });
    return plan.segments.map((segment) => ({
      planId: plan.planId,
      segmentId: segment.id,
      positionMs: 0,
      status: 'completed' as const,
    }));
  };
  return { speak, plans };
}

function createHarness(options: Readonly<{ status?: HarnessDeliveryReceipt['status']; sessions?: ReadonlyArray<ManagedSession> }> = {}): Readonly<{
  session: DialogueSession;
  sends: () => ReadonlyArray<SendRecord>;
  plans: () => ReadonlyArray<SpeechPlan>;
  queries: () => ReadonlyArray<Readonly<{ query: string; budget: number }>>;
  log: LogEntry[];
}> {
  const sessions = options.sessions ?? SESSIONS;
  const log: LogEntry[] = [];
  const { memory, queries } = createMemoryDouble();
  const { speak, plans } = createSpeakDouble(log);
  const doubles: Array<Readonly<{ adapter: HarnessAdapter; sends: SendRecord[] }>> = [];
  const adapters = new Map<string, HarnessAdapter>();
  let session: DialogueSession | undefined;
  for (const entry of sessions) {
    const double = createAdapterDouble({
      sessionId: entry.sessionId,
      status: options.status ?? 'acknowledged',
      log,
      outboxAtSend: () => session?.outbox() ?? [],
    });
    doubles.push(double);
    adapters.set(entry.sessionId, double.adapter);
  }
  session = createDialogueSession({
    router: createAddresseeRouter({ sessions }),
    memory,
    adapters,
    speak,
    scope: SCOPE,
    now: () => new Date('2026-09-13T09:20:00.000Z'),
  });
  return {
    session,
    sends: () => doubles.flatMap((double) => double.sends),
    plans: () => plans,
    queries: () => queries,
    log,
  };
}

function planText(plan: SpeechPlan): string {
  return plan.segments.map((segment) => segment.text).join(' ').trim();
}

test('answers a companion question from memory, cites the evidence, and stays local', async () => {
  const harness = createHarness({ sessions: UNIQUE_SESSIONS });
  const turn = await harness.session.handleUtterance({
    utteranceId: 'q1',
    text: 'What happened in the last session?',
    asrConfidence: 0.97,
  });
  assert.equal(turn.decision.destination, 'companion');
  assert.equal(harness.sends().length, 0);
  assert.equal(harness.session.outbox().length, 0);
  assert.deepEqual(harness.queries().map((entry) => entry.query), ['What happened in the last session?']);
  assert.ok((harness.queries()[0]?.budget ?? 0) > 0);
  const plan = harness.plans()[0];
  assert.ok(plan);
  assert.equal(planText(plan), SUMMARY);
  assert.deepEqual([...plan.segments[0]!.evidenceIds], ['event-1', 'event-2']);
});

test('delivers a named-agent instruction after persisting it and acknowledges the receipt', async () => {
  const harness = createHarness({ sessions: UNIQUE_SESSIONS });
  const turn = await harness.session.handleUtterance({
    utteranceId: 'i1',
    text: 'Tell Codex to add a regression test',
    asrConfidence: 0.98,
  });
  assert.equal(turn.decision.targetSessionId, 'codex-parser');
  const send = harness.sends()[0];
  assert.ok(send);
  assert.equal(harness.sends().length, 1, 'only the named session is addressed');
  assert.equal(send.sessionId, 'codex-parser');
  assert.equal(send.instruction, 'add a regression test');
  assert.ok(
    send.outboxAtSend.some((record) => record.deliveryId === send.deliveryId && record.state === 'prepared'),
    'the outbox record must exist, prepared, before the adapter send',
  );
  assert.equal(turn.dispatch?.deliveryId, send.deliveryId);
  assert.equal(turn.receipt?.status, 'acknowledged');
  const record = harness.session.outbox().find((entry) => entry.deliveryId === send.deliveryId);
  assert.equal(record?.state, 'acknowledged');
  assert.ok((record?.idempotencyKey.length ?? 0) > 0);

  const acknowledgment = harness.plans()[0];
  assert.ok(acknowledgment);
  assert.ok(planText(acknowledgment).length <= 240);
  assert.match(planText(acknowledgment).toLowerCase(), /codex/);
  const sendIndex = harness.log.findIndex((entry) => entry.kind === 'send');
  const speakIndex = harness.log.findIndex((entry) => entry.kind === 'speak');
  assert.ok(speakIndex > sendIndex, 'the acknowledgment follows the observed delivery');
});

test('reports an unobserved handoff honestly instead of claiming success', async () => {
  const harness = createHarness({ status: 'unsupported', sessions: UNIQUE_SESSIONS });
  const turn = await harness.session.handleUtterance({
    utteranceId: 'i2',
    text: 'Ask Claude docs to document the retry policy',
    asrConfidence: 0.97,
  });
  assert.equal(turn.receipt?.status, 'unsupported');
  const record = harness.session.outbox()[0];
  assert.equal(record?.state, 'failed');
  const spoken = harness.plans().map(planText).join(' ').toLowerCase();
  assert.match(spoken, /could not deliver/);
  assert.doesNotMatch(spoken, /acknowledged/);
});

test('asks one concise question for an ambiguous destination and dispatches nothing', async () => {
  const harness = createHarness();
  const turn = await harness.session.handleUtterance({
    utteranceId: 'a1',
    text: 'Tell Codex to add a regression test',
    asrConfidence: 0.97,
  });
  assert.equal(turn.decision.requiresClarification, true);
  assert.equal(harness.sends().length, 0);
  assert.equal(harness.session.outbox().length, 0);
  assert.equal(harness.queries().length, 0);
  assert.equal(harness.plans().length, 1);
  const question = harness.plans()[0];
  assert.ok(question);
  assert.equal(question.segments.length, 1);
  assert.ok(planText(question).length <= 240);
  assert.match(planText(question).toLowerCase(), /codex/);
  assert.equal(turn.clarification, planText(question));
});

test('holds partial ASR and ambient acknowledgments without speaking or dispatching', async () => {
  const harness = createHarness({ sessions: UNIQUE_SESSIONS });
  const partial = await harness.session.handleUtterance({
    utteranceId: 'p1',
    text: 'Tell Codex to add a regression test',
    asrConfidence: 0.93,
    partial: true,
  });
  assert.equal(partial.decision.requiresClarification, false);
  assert.equal(harness.sends().length, 0);
  for (const text of ['yes', 'okay', 'go ahead']) {
    const turn = await harness.session.handleUtterance({ utteranceId: `h:${text}`, text, asrConfidence: 0.95 });
    assert.equal(turn.decision.destination, 'companion');
  }
  assert.equal(harness.sends().length, 0);
  assert.equal(harness.session.outbox().length, 0);
  assert.equal(harness.plans().length, 0, 'holds are silent');
  assert.equal(harness.queries().length, 0, 'holds never query memory');
});

test('a replayed instruction is not delivered twice', async () => {
  const harness = createHarness({ sessions: UNIQUE_SESSIONS });
  const first = await harness.session.handleUtterance({
    utteranceId: 'r1',
    text: 'Tell Codex to add a regression test',
    asrConfidence: 0.98,
  });
  const second = await harness.session.handleUtterance({
    utteranceId: 'r1',
    text: 'Tell Codex to add a regression test',
    asrConfidence: 0.98,
  });
  assert.equal(harness.sends().length, 1);
  assert.equal(harness.session.outbox().length, 1);
  assert.equal(second.dispatch?.deliveryId, first.dispatch?.deliveryId);
  assert.equal(second.receipt?.status, 'acknowledged');
  assert.match(harness.log.filter((entry) => entry.kind === 'speak').at(-1)?.detail ?? '', /already acknowledged/i);
});

test('stripAddressee removes only the leading addressee', () => {
  assert.equal(stripAddressee('Tell Codex to add a regression test', 'codex-parser'), 'add a regression test');
  assert.equal(
    stripAddressee('please ask the Codex parser session to bump the lockfile', 'codex-parser'),
    'bump the lockfile',
  );
  assert.equal(
    stripAddressee('Tell Codex to add a test to the parser suite', 'codex-parser'),
    'add a test to the parser suite',
  );
  assert.equal(
    stripAddressee('harness: Codex parser add a regression test', 'codex-parser'),
    'add a regression test',
  );
});
