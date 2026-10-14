import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../../../../packages/memory/src/store/index';
import { createDialogueMemory } from './dialogue-memory';
test('paired bounded dialogue survives encrypted restart, is scoped and obeys forget/private exclusion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dialogue-memory-')); const key = '8'.repeat(64);
  let store = await createMemoryStore({ directory, key, profileId: 'local' }); let privateId: string | null = null; let clock = 1_800_000_000_000;
  const helper = createDialogueMemory({ projectId: () => 'project', privateSessionId: () => privateId, privacyGeneration: () => 0, store: async () => store, now: () => clock++ });
  try {
    for (let i = 0; i < 5; i++) await helper.persist('project', `question canary ${i}`, `answer canary ${i}`);
    assert.equal((await helper.recent('project')).length, 4); assert.deepEqual(await helper.recent('other'), []);
    const timeline = await store.timeline({ projectId: 'project' }); assert.ok(timeline.every(row => row.summary.length <= 400));
    await store.close(); store = await createMemoryStore({ directory, key, profileId: 'local' });
    let rows = await helper.recent('project'); assert.equal(rows.length, 4); assert.equal(rows[3]!.question, 'question canary 4');
    await store.privacy.forget({ eventIds: [rows[3]!.id] }); rows = await helper.recent('project'); assert.ok(rows.every(row => row.question !== 'question canary 4'));
    privateId = 'private'; store.privacy.privateSessions.begin({ sessionId: privateId }); await helper.persist('project', 'private canary', 'private reply'); assert.deepEqual(await helper.recent('project'), []);
    store.privacy.privateSessions.get(privateId)!.end(); privateId = null;
    assert.ok((await helper.recent('project')).every(row => row.question !== 'private canary'));
    for (const file of await readdir(directory, { recursive: true })) {
      if (!file.endsWith('.db')) continue;
      const bytes = await readFile(join(directory, file));
      assert.equal(bytes.includes(Buffer.from('question canary')), false);
      assert.equal(bytes.includes(Buffer.from('answer canary')), false);
      assert.equal(bytes.includes(Buffer.from('private canary')), false);
    }
    await assert.rejects(store.readDialogue!('project', { limit: 5, maxQuestionChars: 1000, maxAnswerChars: 2000 }), /bound/);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('pending persistence captures privacy before await and refuses invalidation', async () => {
  let release: () => void = () => {}; let generation = 0;
  const helper = createDialogueMemory({ projectId: () => 'project', privateSessionId: () => null, privacyGeneration: () => generation, store: () => new Promise(resolve => { release = () => resolve({} as never); }) });
  const saving = helper.persist('project', 'question', 'answer'); generation++; release(); await assert.rejects(saving, /privacy scope/);
});
