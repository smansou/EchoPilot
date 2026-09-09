import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCommand, parseEventEnvelope, type EventEnvelope, type SpeechPlan } from '@echopilot/contracts';
import { BOOTSTRAP_EVENT, createCoordinator, createFakeMemory, createFakeVoiceSession, parseJournal, serializeJournal } from './index.js';

test('IPC rejects unknown commands and malformed or extra arguments', () => {
  assert.deepEqual(parseCommand({ type: 'set-muted', muted: true }), { type: 'set-muted', muted: true });
  for (const value of [null, [], { type: 'execute' }, { type: 'set-muted', muted: 'false' },
    { type: 'replay', script: 'malicious' }]) {
    assert.throws(() => parseCommand(value), TypeError);
  }
});

test('mute, interrupt, replacement, and replay invalidate speech authorization', () => {
  const coordinator = createCoordinator();
  coordinator.ingest(BOOTSTRAP_EVENT);
  const first = coordinator.requestSpeech(BOOTSTRAP_EVENT.id)!;
  assert.equal(coordinator.canSpeak(first), true);
  assert.equal(coordinator.canSpeak({ ...first }), false);
  coordinator.setMuted(true);
  assert.equal(coordinator.canSpeak(first), false);
  assert.equal(coordinator.requestSpeech(BOOTSTRAP_EVENT.id), null);
  coordinator.setMuted(false);
  assert.equal(coordinator.canSpeak(first), false);
  for (const revoke of [() => coordinator.interrupt(), () => coordinator.replay(),
    () => coordinator.ingest(BOOTSTRAP_EVENT)]) {
    const lease = coordinator.requestSpeech(BOOTSTRAP_EVENT.id)!;
    revoke();
    assert.equal(coordinator.canSpeak(lease), false);
  }
});

test('journal survives restart without changing identity or allowing state mutation', () => {
  const journal = serializeJournal([BOOTSTRAP_EVENT]);
  const event = parseJournal(journal)[0]!;
  const coordinator = createCoordinator({ muted: false, event });
  const external = coordinator.getState();
  external.event!.id = 'changed';
  assert.equal(coordinator.replay().event?.id, BOOTSTRAP_EVENT.id);
  assert.throws(() => parseJournal(journal + journal), /Duplicate/);
  assert.throws(() => parseJournal('{broken}'));
  assert.throws(() => parseJournal(journal.replace('2026-09-09', '2026-02-30')), /timestamp/);
});

test('the checked-in bootstrap journal is valid synthetic input with a stable ID', async () => {
  const journal = await readFile(new URL('../../../fixtures/bootstrap/session.jsonl', import.meta.url), 'utf8');
  assert.deepEqual(parseJournal(journal), [BOOTSTRAP_EVENT]);
});

test('v1 envelopes normalize newer event kinds but never accept another schema revision', async () => {
  const raw = {
    schemaVersion: 1, eventId: 'event-001', sourceId: 'fixture', sourceEventId: 'source-001', sourceSequence: 0, ingestSequence: 0,
    occurredAt: '2026-09-09T00:00:00.000Z', observedAt: '2026-09-09T00:00:01.000Z',
    scope: { profileId: 'fixture-profile', sensitivity: 'normal' }, kind: 'newer_event_kind', payloadRef: 'fixture://event-001', contentHash: 'abc', trust: 'imported',
    producerHint: 'ignored additive field',
  };
  const event = parseEventEnvelope(raw);
  assert.equal(event.kind, 'unsupported');
  assert.equal(event.unsupportedKind, 'newer_event_kind');
  assert.throws(() => parseEventEnvelope({ ...raw, schemaVersion: 2 }), /schema version/);
  const memory = createFakeMemory();
  await memory.ingest([event]);
  assert.deepEqual((await memory.query('synthetic', event.scope, 1)).evidenceIds, [event.eventId]);
});

test('the fake voice accepts speech only through a live attention lease', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const coordinator = createCoordinator({ muted: false, event: BOOTSTRAP_EVENT }, () => now);
  const voice = createFakeVoiceSession(coordinator);
  const plan: SpeechPlan = {
    planId: 'plan-001', epoch: 0, priority: 'completion', expiresAt: '2026-09-09T00:01:00.000Z', dedupeKey: 'fixture', resume: 'discard',
    segments: [{ id: 'segment-001', text: 'Synthetic output.', evidenceIds: [BOOTSTRAP_EVENT.id], exact: false, maxSeconds: 2 }],
  };
  const lease = coordinator.requestSpeech(BOOTSTRAP_EVENT.id, '2026-09-09T00:00:10.000Z')!;
  assert.equal((await voice.submitSpeech(plan, lease)).length, 1);
  coordinator.revokeSpeech('test');
  await assert.rejects(() => voice.submitSpeech(plan, lease), /lease/);
  const expiringLease = coordinator.requestSpeech(BOOTSTRAP_EVENT.id, '2026-09-09T00:00:10.000Z')!;
  now = new Date('2026-09-09T00:00:11.000Z');
  assert.equal(coordinator.canSpeak(expiringLease), false);
});
