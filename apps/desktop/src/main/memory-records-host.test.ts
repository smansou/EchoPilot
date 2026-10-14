import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../../../../packages/memory/src/store/index';
import { createMemoryRecordsHost } from './memory-records-host';

test('explicit user note and source correction survive encrypted store restart with history and lineage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-note-')); let instant = 1_800_000_000_000;
  let store = await createMemoryStore({ directory, key: '3'.repeat(64), profileId: 'local' });
  const host = createMemoryRecordsHost({ activeProjectId: () => 'project', store: async () => store, now: () => instant });
  try {
    let preview = await host.preview('project', 'Use SQLite for local state', null); const note = await host.confirm('project', preview.id);
    instant += 1_000; preview = await host.preview('project', 'Use encrypted SQLite for local state', note.eventId); const correction = await host.confirm('project', preview.id);
    await store.close(); store = await createMemoryStore({ directory, key: '3'.repeat(64), profileId: 'local' });
    const records = await host.list('project'); assert.equal(records.length, 2);
    assert.equal(records.find(row => row.id === note.eventId)?.supersededBy, correction.eventId);
    assert.equal(records.find(row => row.id === correction.eventId)?.revisionOf, note.eventId);
    assert.ok(records.every(row => row.trust === 'user_explicit'));
    assert.equal((await store.timeline({ projectId: 'other' })).length, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('forgotten source and stale project review cannot be corrected; private notes never persist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-note-')); const store = await createMemoryStore({ directory, key: '4'.repeat(64), profileId: 'local' });
  let active = 'project'; const host = createMemoryRecordsHost({ activeProjectId: () => active, store: async () => store });
  try {
    let preview = await host.preview('project', 'Original note', null); const note = await host.confirm('project', preview.id);
    preview = await host.preview('project', 'Wrong project correction', note.eventId); active = 'other'; await assert.rejects(host.confirm('project', preview.id), /active project/); active = 'project';
    preview = await host.preview('project', 'Forgotten correction', note.eventId); await store.privacy.forget({ eventIds: [note.eventId] }); await assert.rejects(host.confirm('project', preview.id), /forgotten/);
    store.privacy.privateSessions.begin({ sessionId: 'private' }); preview = await host.preview('project', 'Private canary', null); const saved = await host.confirm('project', preview.id);
    assert.equal(saved.private, true); assert.equal((await store.timeline({ projectId: 'project' })).length, 0);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('privacy invalidation cancels an already reviewed note and an awaiting confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-note-clear-')); const store = await createMemoryStore({ directory, key: '8'.repeat(64), profileId: 'local' });
  let hold: (() => void) | undefined; let delayed = false;
  const host = createMemoryRecordsHost({ activeProjectId: () => 'project', store: async () => { if (delayed) await new Promise<void>(resolve => { hold = resolve; }); return store; } });
  try {
    const preview = await host.preview('project', 'Do not persist after clearing', null);
    delayed = true; const confirming = host.confirm('project', preview.id); host.clear(); hold!();
    await assert.rejects(confirming, /Privacy changed/);
    assert.equal((await store.timeline({ projectId: 'project' })).length, 0);
    await assert.rejects(host.confirm('project', preview.id), /no longer pending/);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
