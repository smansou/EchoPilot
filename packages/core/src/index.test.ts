import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand } from '@echopilot/contracts';
import { BOOTSTRAP_EVENT, createCoordinator, parseJournal, serializeJournal } from './index.js';

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
