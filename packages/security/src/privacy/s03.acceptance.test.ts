/**
 * S03 acceptance oracle — "Private session / forget / export → storage and retrieval reflect the
 * choice" (IMPLEMENTATION_PLAN.md §5.8, BACKLOG S03), export half.
 *
 * Acceptance: "Encrypted export restores into a new profile with evidence intact; wrong passphrase
 * fails without modifying the destination." The retained candidate has no `exportProfile` /
 * `importProfile` / `createPrivateSession` surface in this package, so this oracle pins the same
 * outcome against the production storage an export must carry — the M01 encrypted store pack — and
 * the production readers that must still answer from the restored copy:
 *
 *   1. the pack an export ships is encrypted at rest: no shipped byte contains the decision text;
 *   2. restoring that pack into a new profile directory and opening it with the passphrase
 *      reproduces the exported timeline *and* re-derives the same facts, summaries and grounded
 *      answer from the restored evidence alone — nothing derived has to travel with the export;
 *   3. a wrong passphrase is refused by the store's key check instead of re-initializing the
 *      destination, the destination is byte-for-byte unchanged afterwards, no file appears, and
 *      the correct passphrase still opens exactly the evidence that was there before.
 *
 * Scope note the run evidence repeats: the export here is the encrypted store pack
 * (`profile.db` plus `projects/*.db`). The M02/M04 derivation sidecars next to it are plain JSON
 * today, so a production `exportProfile` must exclude or seal them — this oracle therefore proves
 * the encrypted evidence restores and re-derives, never that the whole directory is ciphertext.
 *
 * The forget/re-import half of S03 is pinned in
 * `packages/memory/src/deletion/s03.acceptance.test.ts`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import { createMemoryConsolidator } from '../../../memory/src/consolidation/index.js';
import { createContextAssembler, type ImageDescriptor, type ModelDescriptor } from '../../../memory/src/context/index.js';
import { createMemoryRecords } from '../../../memory/src/records/index.js';
import type { NormalizedEvent } from '../../../memory/src/reducers/index.js';
import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../../../memory/src/store/index.js';

const PROFILE_ID = 'profile-s03-export';
const OTHER_PROFILE_ID = 'profile-s03-export-other';
const PROJECT_ID = 'project-s03-export';
/** The passphrase a user would type; it is the store's key material, never written to disk. */
const PASSPHRASE = 'a4c1f7e2b9d3068517ae2c4f6b8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70819';
const WRONG_PASSPHRASE = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const CANARY = 'quartzpass1';
const QUESTION = `Should we keep ${CANARY} in the vault?`;
const CHOICE = `Keep ${CANARY} in the vault for ninety days.`;
const OCCURRED_AT = '2026-09-01T09:00:00.000Z';
const MODEL: ModelDescriptor = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };

const SCOPE = { profileId: PROFILE_ID, projectId: PROJECT_ID, sessionId: 'session-s03-export', sensitivity: 'normal' } as const;

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
  const payloadRef = 'memory://s03-export/decision-1';
  const events: NormalizedEvent[] = [{
    schemaVersion: 1,
    eventId: 'evt-s03-export-1',
    sourceId: 's03:export',
    sourceEventId: 'export-1',
    sourceSequence: 1,
    ingestSequence: 1,
    occurredAt: OCCURRED_AT,
    observedAt: OCCURRED_AT,
    scope: SCOPE,
    kind: 'decision',
    payloadRef,
    contentHash: 'sha256:s03-export-1',
    trust: 'user_explicit',
  }];
  return { events, payloads: { [payloadRef]: { question: QUESTION, choice: CHOICE } } };
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
}

/** The encrypted store pack an export ships: the profile database and one database per project. */
async function encryptedPackFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  if ((await readdir(root)).includes('profile.db')) files.push('profile.db');
  const projects = await readdir(join(root, 'projects')).catch(() => [] as string[]);
  for (const name of projects) if (name.endsWith('.db')) files.push(`projects/${name}`);
  return files.sort();
}

/** Content digest over every file, so "unchanged" covers names, sizes and bytes. */
async function treeDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  for (const file of await filesUnder(root)) {
    digest.update(file);
    digest.update('\u0000');
    digest.update(await readFile(join(root, file)));
    digest.update('\u0000');
  }
  return digest.digest('hex');
}

async function copyFiles(from: string, to: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const destination = join(to, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(from, file), destination);
  }
}

async function openPassphraseStore(directory: string, passphrase: string, profileId = PROFILE_ID): Promise<MemoryStore> {
  return createMemoryStore({ directory, key: passphrase, profileId });
}

test('S03: an encrypted export restores into a new profile with its evidence intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-export-'));
  const profile = join(root, 'profile');
  const restored = join(root, 'restored-profile');
  const store = await openPassphraseStore(profile, PASSPHRASE);
  try {
    await store.ingest(decisionBatch());
    const consolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory: profile, store, reasoner, assembler, model: MODEL });
    await consolidator.consolidate();
    const before = await store.timeline({ projectId: PROJECT_ID });
    assert.equal(before.length, 1, 'the profile must hold the decision before the export');
    await consolidator.close();
    await store.close();

    const pack = await encryptedPackFiles(profile);
    assert.ok(pack.length >= 2, `the export must carry the profile database and its project database (found ${pack.join(', ')})`);
    await copyFiles(profile, restored, pack);

    // An export ships ciphertext: the decision text must not be readable in any shipped byte.
    for (const file of await filesUnder(restored)) {
      const bytes = await readFile(join(restored, file));
      assert.ok(!bytes.includes(Buffer.from(CANARY, 'utf8')), `${file} ships the decision text in plaintext`);
      assert.ok(!bytes.includes(Buffer.from(CHOICE, 'utf8')), `${file} ships the decision text in plaintext`);
    }

    // Restoring into a new profile must bring the raw evidence back...
    const restoredStore = await openPassphraseStore(restored, PASSPHRASE);
    const restoredTimeline = await restoredStore.timeline({ projectId: PROJECT_ID });
    assert.deepEqual(restoredTimeline, before, 'the restored profile must reproduce the exported timeline');

    // ... and the restored evidence must still support the same derived answers on its own.
    const restoredConsolidator = await createMemoryConsolidator({ projectId: PROJECT_ID, directory: restored, store: restoredStore, reasoner, assembler, model: MODEL });
    const records = await createMemoryRecords({ projectId: PROJECT_ID, directory: restored, store: restoredStore, source: restoredConsolidator, extractionVersion: 's03-extraction-v1' });
    await restoredConsolidator.consolidate();
    assert.ok((await restoredConsolidator.facts()).some((fact) => fact.object.includes(CANARY)), 'the restored profile must re-derive the fact');
    assert.ok((await restoredConsolidator.decisions()).some((entry) => entry.choice.includes(CANARY)), 'the restored profile must re-derive the decision');
    assert.ok((await records.summaries()).some((summary) => summary.text.includes(CANARY)), 'the restored profile must re-derive the summary');
    const answer = await records.answer({ question: QUESTION });
    assert.equal(answer.supported, true, 'the restored profile must answer from restored evidence');
    assert.ok(answer.text.includes(CANARY), 'the restored answer must cite the restored decision');

    // The export is bound to the profile identity that owns the key material.
    await assert.rejects(
      () => openPassphraseStore(restored, PASSPHRASE, OTHER_PROFILE_ID),
      /could not be decrypted with the provided key/,
      'a restored profile must not open under another profile identity',
    );

    await records.close();
    await restoredConsolidator.close();
    await restoredStore.close();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S03: a wrong passphrase fails without modifying the destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 's03-passphrase-'));
  const profile = join(root, 'profile');
  const destination = join(root, 'destination');
  const store = await openPassphraseStore(profile, PASSPHRASE);
  try {
    await store.ingest(decisionBatch());
    await store.close();
    await copyFiles(profile, destination, await encryptedPackFiles(profile));
    const filesBefore = await filesUnder(destination);
    const digestBefore = await treeDigest(destination);

    await assert.rejects(
      () => openPassphraseStore(destination, WRONG_PASSPHRASE),
      /could not be decrypted with the provided key/,
      'a wrong passphrase must fail with the store key check, never re-initialize the destination',
    );

    assert.deepEqual(await filesUnder(destination), filesBefore, 'the failed restore must not add or remove files');
    assert.equal(await treeDigest(destination), digestBefore, 'the failed restore must not rewrite the destination');

    // The destination still holds the evidence, and the correct passphrase still opens it.
    const reopened = await openPassphraseStore(destination, PASSPHRASE);
    const timeline = await reopened.timeline({ projectId: PROJECT_ID });
    assert.equal(timeline.length, 1, 'the failed attempt must leave the exported evidence intact');
    assert.ok((timeline[0]?.summary ?? '').includes(CANARY), 'the surviving evidence must still be readable');
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
