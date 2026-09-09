import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerStore } from './store.js';
import { DEFAULT_CONFIG, chooseModel } from './policy.js';
import { normalizeReservation, selectReadyTickets, pathsOverlap } from './scheduler.js';
import type { Ticket } from './types.js';

const ticket = (id: string, files: string[], deps: string[] = [], block = id): Ticket => ({ id, files, deps, block, epic: 'E-TEST', kind: 'test', path: 'fixture', scope: 'fixture', accept: ['fixture'], judgment: 'fixture', days: 1, blocks: [] });

test('store enforces completion phases, serializes updates, and recovers interrupted work paused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-runner-'));
  try {
    const tickets = [ticket('F01', ['apps/desktop/'])];
    const store = new RunnerStore(root, tickets);
    assert.equal((await store.load()).tickets.F01?.status, 'pending');
    await assert.rejects(store.transition('F01', 'done'), /Invalid transition/);
    await store.setPaused(false);
    await store.transition('F01', 'running');
    await Promise.all([store.update('F01', { reason: 'working' }), store.update('F01', { branch: 'codex/test' })]);
    const reopened = new RunnerStore(root, tickets);
    const recovered = await reopened.load();
    assert.equal(recovered.paused, true);
    assert.equal(recovered.tickets.F01?.status, 'needs_attention');
    assert.equal(recovered.tickets.F01?.attempts, 1);
    assert.equal(recovered.tickets.F01?.branch, 'codex/test');
    await reopened.transition('F01', 'pending');
    await reopened.transition('F01', 'running');
    await reopened.transition('F01', 'checking');
    await reopened.transition('F01', 'reviewing');
    await reopened.transition('F01', 'integrating');
    assert.equal((await reopened.transition('F01', 'done')).tickets.F01?.attempts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scheduler respects dependencies, blocks, path locks, pause, and retry bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echopilot-scheduler-'));
  try {
    const tickets = [ticket('A', ['packages/a/']), ticket('B', ['packages/a/sub/']), ticket('C', ['packages/c/']), ticket('D', ['packages/d/'], ['A'])];
    const store = new RunnerStore(root, tickets); const snapshot = await store.load();
    assert.deepEqual(selectReadyTickets(tickets, snapshot, DEFAULT_CONFIG), []);
    snapshot.paused = false;
    assert.deepEqual(selectReadyTickets(tickets, snapshot, DEFAULT_CONFIG).map(t => t.id), ['A', 'C']);
    snapshot.tickets.A!.status = 'running';
    assert.deepEqual(selectReadyTickets(tickets, snapshot, DEFAULT_CONFIG).map(t => t.id), ['C']);
    snapshot.tickets.A!.status = 'done'; snapshot.tickets.B!.attempts = 2;
    assert.deepEqual(selectReadyTickets(tickets, snapshot, DEFAULT_CONFIG).map(t => t.id), ['C', 'D']);
    assert.equal(pathsOverlap('fixtures/', 'fixtures/audio/*.wav'), true);
    assert.equal(pathsOverlap('packages/foo', 'packages/foobar'), false);
    assert.throws(() => normalizeReservation('../secret'), /Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model policy has explicit overrides and no expensive lead model default', () => {
  assert.equal(chooseModel(ticket('S01', ['packages/security/'], [], 'BLOCK-SECURITY')).model, 'gpt-5.6-sol');
  assert.equal(chooseModel(ticket('V01', ['packages/voice/'], [], 'BLOCK-VOICE')).effort, 'high');
  assert.equal(chooseModel(ticket('Q01', ['packages/eval/'], [], 'BLOCK-EVAL')).model, 'gpt-5.6-luna');
  assert.equal(chooseModel(ticket('A', ['packages/a']), { ...DEFAULT_CONFIG, ticketOverrides: { A: { model: 'custom-model', effort: 'low' } } }).model, 'custom-model');
});
