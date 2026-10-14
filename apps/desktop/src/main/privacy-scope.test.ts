import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryStore } from '../../../../packages/memory/src/store/index';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';
import { createProcessPrivacyScope } from './privacy-scope';

function batch(id: string, sessionId: string, sourceId = 'managed:test') {
  const instant = new Date().toISOString();
  const event: EventEnvelope = { schemaVersion: 1, eventId: id, sourceId, sourceEventId: id, sourceSequence: 1, ingestSequence: 1,
    occurredAt: instant, observedAt: instant, scope: { profileId: 'local', projectId: 'project', sessionId, sensitivity: 'normal' },
    kind: 'agent_message', trust: 'agent_reported', payloadRef: `test://${id}`, contentHash: id };
  return { events: [event], payloads: { [event.payloadRef]: { text: `Content ${id}` } } };
}

test('global private scope covers unrelated real UUIDs and new sessions without rewriting source envelopes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-process-'));
  let store = await createMemoryStore({ directory, key: '6'.repeat(64), profileId: 'local' });
  const privacy = createProcessPrivacyScope(); privacy.bind(store);
  try {
    store.privacy.privateSessions.begin({ sessionId: 'private-ui' }); privacy.begin('private-ui');
    const first = batch('first-private', '70cafc42-0c5f-408f-9adf-a85e119523c5');
    const original = JSON.stringify(first);
    await store.ingest(first);
    await store.ingest(batch('new-session-private', '94929958-123f-4b8d-8b67-fdfcf48420f5', 'managed:claude'));
    assert.equal(JSON.stringify(first), original);
    assert.equal((await store.timeline({ projectId: 'project' })).length, 0);
    assert.equal(store.privacy.privateSessions.get('private-ui')?.transcript().length, 2);
    const captured = privacy.capture();
    store.privacy.privateSessions.get('private-ui')!.end(); privacy.end('private-ui');
    await store.ingest(batch('late-private', 'another-real-session'), { privateSessionId: captured });
    await store.ingest(batch('public-after-end', 'public-session'));
    await store.close(); store = await createMemoryStore({ directory, key: '6'.repeat(64), profileId: 'local' });
    const timeline = await store.timeline({ projectId: 'project' });
    assert.equal(timeline.length, 1); assert.equal(timeline[0]?.id, 'public-after-end');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent forget and ingest cannot resurrect forgotten identities; independent source still writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forget-race-'));
  const store = await createMemoryStore({ directory, key: '7'.repeat(64), profileId: 'local' });
  try {
    const record = batch('forgotten', 'real-session'); await store.ingest(record);
    await Promise.all([store.privacy.forget({ eventIds: ['forgotten'] }), store.ingest(record)]);
    assert.equal((await store.timeline({ projectId: 'project' })).length, 0);
    await store.ingest(batch('independent', 'other-session', 'other-source'));
    assert.equal((await store.timeline({ projectId: 'project' }))[0]?.id, 'independent');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
