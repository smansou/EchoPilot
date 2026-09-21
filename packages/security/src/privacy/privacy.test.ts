/**
 * S03 privacy tests: the passphrase-sealed export, the restore-into-a-new-profile path, and the
 * private session that must never reach durable storage.
 *
 * `s03.acceptance.test.ts` pins the export *effect* on the M01 encrypted store pack; these tests
 * pin the production API that produces it, including the failure path the acceptance names: a wrong
 * passphrase must leave the destination exactly as it was.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { createMemoryConsolidator } from '../../../memory/src/consolidation/index.js';
import { createContextAssembler, type ImageDescriptor, type ModelDescriptor } from '../../../memory/src/context/index.js';
import { createMemoryRecords } from '../../../memory/src/records/index.js';
import type { NormalizedEvent } from '../../../memory/src/reducers/index.js';
import { createMemoryStore, type NormalizedBatch } from '../../../memory/src/store/index.js';
import { createPrivateSession, discardProfile, exportProfile, importProfile } from './index.js';

const PROFILE_ID = 'profile-s03-privacy';
const PROJECT_ID = 'project-s03-privacy';
const KEY = '3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c';
const PASSPHRASE = 'correct horse battery staple';
const WRONG_PASSPHRASE = 'incorrect horse battery staple';
const CANARY = 'lumenpass7';
const QUESTION = `Should we keep ${CANARY} on device?`;
const CHOICE = `Keep ${CANARY} on device.`;
const OCCURRED_AT = '2026-09-03T09:00:00.000Z';
const MODEL: ModelDescriptor = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };
const SCOPE = { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: 'session-s03-privacy', sensitivity: 'normal' } as const;

const assembler = createContextAssembler({
  tokenizer: { count: (text: string) => text.trim().split(/\s+/).filter((token) => token.length > 0).length },
  imageTokens: (image: ImageDescriptor) => Math.ceil(image.width / 28) * Math.ceil(image.height / 28),
});
const reasoner = {
  async run(): Promise<unknown> {
    throw new Error('deterministic fallback only');
  },
};

function decisionBatch(): NormalizedBatch {
  const payloadRef = 'memory://s03-privacy/decision-1';
  const events: NormalizedEvent[] = [{
    schemaVersion: 1,
    eventId: 'evt-s03-privacy-1',
    sourceId: 's03:privacy',
    sourceEventId: 'privacy-1',
    sourceSequence: 1,
    ingestSequence: 1,
    occurredAt: OCCURRED_AT,
    observedAt: OCCURRED_AT,
    scope: SCOPE,
    kind: 'decision',
    payloadRef,
    contentHash: 'sha256:s03-privacy-1',
    trust: 'user_explicit',
  }];
  return { events, payloads: { [payloadRef]: { question: QUESTION, choice: CHOICE } } };
}

async function seedProfile(directory: string): Promise<void> {
  const store = await createMemoryStore({ directory, key: KEY, profileId: PROFILE_ID });
  const consolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory, store, reasoner, assembler, model: MODEL });
  const records = await createMemoryRecords({ projectId: PROJECT_ID, directory, store, source: consolidator, extractionVersion: 's03-privacy-v1' });
  await store.ingest(decisionBatch());
  await consolidator.consolidate();
  await records.close();
  await consolidator.close();
  await store.close();
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await filesUnder(root)) {
    hash.update(file);
    hash.update(await readFile(join(root, file)));
  }
  return hash.digest('hex');
}

test('an encrypted export restores into a new profile with the evidence intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-privacy-export-'));
  const profile = join(root, 'profile');
  const archive = join(root, 'export.echopilot');
  const restored = join(root, 'restored');
  try {
    await seedProfile(profile);
    const exported = await exportProfile({ directory: profile, destination: archive, passphrase: PASSPHRASE });
    assert.ok(exported.files.includes('profile.db'), 'the export must carry the profile database');
    assert.ok(exported.files.some((file) => file.startsWith('projects/')), 'the export must carry the project database');
    assert.ok(exported.files.some((file) => file.endsWith('.m02.json')), 'the export must carry the derived state');

    const bytes = await readFile(archive);
    assert.ok(!bytes.includes(Buffer.from(CANARY, 'utf8')), 'the archive must not ship the decision text in plaintext');
    assert.ok(!bytes.includes(Buffer.from('processedEventIds', 'utf8')), 'the archive must not ship the plaintext derivation sidecar');
    await assert.rejects(
      () => exportProfile({ directory: profile, destination: join(profile, 'export.echopilot'), passphrase: PASSPHRASE }),
      /must not live inside the exported directory/,
      'an export must refuse to seal its destination into itself',
    );

    const imported = await importProfile({ archive, directory: restored, passphrase: PASSPHRASE });
    assert.deepEqual(imported.files, exported.files, 'the restore must reproduce every exported file');
    assert.deepEqual(await filesUnder(restored), [...exported.files].sort(), 'the restored profile must hold exactly the exported tree');

    const store = await createMemoryStore({ directory: restored, key: KEY, profileId: PROFILE_ID });
    const consolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory: restored, store, reasoner, assembler, model: MODEL });
    const records = await createMemoryRecords({ projectId: PROJECT_ID, directory: restored, store, source: consolidator, extractionVersion: 's03-privacy-v1' });
    await consolidator.consolidate();
    assert.equal((await store.timeline({ projectId: PROJECT_ID, text: CANARY })).length, 1, 'the restored profile must serve the decision');
    assert.ok((await consolidator.decisions()).some((entry) => entry.choice.includes(CANARY)), 'the restored profile must re-derive the decision');
    assert.equal((await records.answer({ question: QUESTION })).supported, true, 'the restored profile must answer from restored evidence');
    await records.close();
    await consolidator.close();
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a wrong passphrase fails without modifying the destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-privacy-passphrase-'));
  const profile = join(root, 'profile');
  const archive = join(root, 'export.echopilot');
  const restored = join(root, 'restored');
  const wrongPassphraseDestination = join(root, 'wrong-passphrase-destination');
  try {
    await seedProfile(profile);
    await exportProfile({ directory: profile, destination: archive, passphrase: PASSPHRASE });
    await importProfile({ archive, directory: restored, passphrase: PASSPHRASE });
    const filesBefore = await filesUnder(restored);
    const digestBefore = await treeDigest(restored);

    await assert.rejects(
      () => importProfile({ archive, directory: restored, passphrase: PASSPHRASE }),
      /must be a new, absent profile directory/,
      'a restore must refuse to overlay an existing profile',
    );
    assert.deepEqual(await filesUnder(restored), filesBefore, 'an occupied destination must remain unchanged');
    assert.equal(await treeDigest(restored), digestBefore, 'an occupied destination must not be overwritten');

    await assert.rejects(
      () => importProfile({ archive, directory: wrongPassphraseDestination, passphrase: WRONG_PASSPHRASE }),
      /could not be decrypted with the provided passphrase/,
      'a wrong passphrase must fail the archive key check',
    );
    assert.equal(await stat(wrongPassphraseDestination).then(() => true).catch(() => false), false, 'a wrong passphrase must not create the destination');

    // A damaged archive is refused the same way: authentication precedes every write.
    const tampered = join(root, 'tampered.echopilot');
    const bytes = Buffer.from(await readFile(archive));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await writeFile(tampered, bytes);
    const fresh = join(root, 'fresh-destination');
    await assert.rejects(
      () => importProfile({ archive: tampered, directory: fresh, passphrase: PASSPHRASE }),
      /could not be decrypted with the provided passphrase/,
      'a damaged archive must fail before the destination is touched',
    );
    assert.equal(await stat(fresh).then(() => true).catch(() => false), false, 'a refused restore must not create the destination');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a private session buffers in memory only and drops its transcript on end', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-privacy-session-'));
  try {
    const session = await createPrivateSession({ scope: { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: 'private-1' } });
    assert.equal(session.active(), true, 'a private session starts active while the indicator is on');
    session.record({ kind: 'utterance', text: `Remember ${CANARY} privately.` });
    session.record({ kind: 'observation', text: 'Screen shows the vault.' });
    assert.equal(session.transcript().length, 2, 'the private transcript is available while the session runs');

    const ended = session.end();
    assert.equal(session.active(), false, 'ending the session turns the indicator off');
    assert.equal(ended.length, 2, 'the caller receives the transcript once, to display and discard');
    assert.deepEqual(session.transcript(), [], 'the private buffer must be dropped when the session ends');
    assert.throws(() => session.record({ kind: 'utterance', text: 'late' }), /already ended/, 'an ended session accepts nothing');

    assert.deepEqual(await readdir(root), [], 'a private session must write nothing to disk');
    await discardProfile(join(root, 'never-restored'));
    assert.deepEqual(await readdir(root), [], 'discarding an absent profile is a no-op');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
