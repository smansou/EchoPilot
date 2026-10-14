import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceRouting } from './voice-routing';
import type { ManagedWork, WorkSession } from './managed-work';

function fixture() {
  let time = 1_000;
  let sessions = [{ id: 'one', projectId: 'p1', label: 'parser', active: true, compatible: true, authenticated: true, currentTurnId: 'turn' }, { id: 'two', projectId: 'p2', label: 'web', active: true, compatible: true, authenticated: true, currentTurnId: null }] as WorkSession[];
  const sent: string[] = []; const interrupted: string[] = []; let speechStopped = 0; let listeningStopped = 0;
  let sendGate: Promise<void> = Promise.resolve();
  const work = { list: () => sessions, refreshAuth: async () => sessions, send: async (id: string, instruction: string) => { sent.push(`${id}:${instruction}`); await sendGate; return sessions[0]!; }, interrupt: async (id: string) => { interrupted.push(id); return sessions[0]!; } } as unknown as ManagedWork;
  const service = createVoiceRouting({ work, now: () => time, stopSpeech: () => { speechStopped++; }, stopListening: async () => { listeningStopped++; } });
  const say = (text: string, utteranceId = text) => service.transcript({ phase: 'final', text, utteranceId });
  return { service, say, sent, interrupted, expire: () => { time += 31_000; }, close: () => { sessions = sessions.filter(s => s.id !== 'one'); }, counts: () => ({ speechStopped, listeningStopped }), gate: (promise: Promise<void>) => { sendGate = promise; } };
}

test('default off, partial ASR, acknowledgments, quoted instructions and questions never dispatch', async () => {
  const f = fixture(); await f.say('tell parser to run tests'); assert.equal(f.service.snapshot().pending, null);
  f.service.configure('one', true);
  await f.service.transcript({ phase: 'partial', utteranceId: 'a', text: 'tell parser to delete files' });
  for (const text of ['yes', 'okay', '"tell parser to delete files"', 'what changed?']) await f.say(text);
  assert.equal(f.service.snapshot().pending, null); assert.deepEqual(f.sent, []);
});

test('final speech stages precise task and exact scope; confirmation consumes it once', async () => {
  const f = fixture(); f.service.configure('one', true);
  await f.say('tell parser to run tests', 'utterance'); const pending = f.service.snapshot().pending!;
  assert.equal(pending.instruction, 'run tests'); assert.equal(pending.sessionId, 'one'); assert.deepEqual(f.sent, []);
  await assert.rejects(f.service.confirm(pending.id, 'two'), /reviewed session/);
  await f.service.confirm(pending.id, 'one');
  await assert.rejects(f.service.confirm(pending.id, 'one'), /no longer pending/);
  await f.say('tell parser to run tests', 'utterance'); assert.deepEqual(f.sent, ['one:run tests']); assert.equal(f.service.snapshot().pending, null);
});

test('unknown targets require clarification without guessing the selected scope', async () => {
  const f = fixture(); f.service.configure('one', true); await f.say('tell codex to fix it');
  assert.equal(f.service.snapshot().pending?.sessionId, null); assert.deepEqual(f.sent, []);
  await f.say('tell web to change files'); assert.match(f.service.snapshot().message, /another session/); assert.deepEqual(f.sent, []);
});

test('stale review, closed scope and switching scope invalidate confirmation', async () => {
  for (const invalidate of ['expire', 'close', 'switch'] as const) {
    const f = fixture(); f.service.configure('one', true); await f.say('tell parser to edit code'); const id = f.service.snapshot().pending!.id;
    if (invalidate === 'switch') f.service.configure('two', true); else f[invalidate]();
    await assert.rejects(f.service.confirm(id, 'one')); assert.deepEqual(f.sent, []);
  }
});

test('speech stop is separate from selected agent interruption; mute releases listening', async () => {
  const f = fixture(); await f.say('stop speaking'); assert.deepEqual(f.interrupted, []);
  f.service.configure('one', true); await f.say('stop agent'); assert.deepEqual(f.interrupted, ['one']);
  await f.say('mute'); assert.equal(f.service.snapshot().enabled, false); assert.equal(f.counts().listeningStopped, 1);
});

test('concurrent confirmations produce only one acknowledged dispatch', async () => {
  const f = fixture(); let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  f.service.configure('one', true); await f.say('tell parser to edit code'); const id = f.service.snapshot().pending!.id;
  const first = f.service.confirm(id, 'one'); await assert.rejects(f.service.confirm(id, 'one')); release(); await first;
  assert.deepEqual(f.sent, ['one:edit code']);
});

test('explicit spoken confirmation works only for the live scoped review, never ambient yes', async () => {
  const f = fixture(); f.service.configure('one', true); await f.say('tell parser to edit code');
  await f.say('yes'); assert.deepEqual(f.sent, []);
  await f.say('confirm send request'); assert.deepEqual(f.sent, ['one:edit code']);
  await f.say('confirm send request', 'second-confirm'); assert.deepEqual(f.sent, ['one:edit code']);
});
