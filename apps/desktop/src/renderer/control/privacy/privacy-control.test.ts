/**
 * The privacy control's renderer invariants: forget is confirmed, the indicator is honest, the
 * passphrase is never kept, and a failure never reads like a success.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrivacyControl, NOT_PRIVATE_LABEL, PRIVATE_SESSION_LABEL, type PrivacyForgetSelection } from './index.js';

const PASSPHRASE = 'correct horse battery staple';
const CANARY = 'privacypass3';

function control(overrides: Partial<Parameters<typeof createPrivacyControl>[0]> = {}) {
  const calls: {
    forget: PrivacyForgetSelection[];
    export: string[];
    imports: { archive: string; passphrase: string }[];
    sessions: string[];
  } = { forget: [], export: [], imports: [], sessions: [] };
  const instance = createPrivacyControl({
    forget: async (request) => {
      calls.forget.push(request);
      return { deleted: 5, condensed: 2 };
    },
    exportProfile: async ({ passphrase }) => {
      calls.export.push(passphrase);
      return { files: ['profile.db', 'projects/p.db'] };
    },
    importProfile: async ({ archive, passphrase }) => {
      calls.imports.push({ archive, passphrase });
      return { files: ['profile.db'] };
    },
    // The indicator follows the host registry, so a control under test needs one to report on.
    beginPrivateSession: ({ sessionId }) => {
      calls.sessions.push(sessionId);
    },
    endPrivateSession: () => [{ sequence: 1, kind: 'utterance', text: 'shown once, never stored', at: '2026-09-05T09:00:00.000Z' }],
    ...overrides,
  });
  return { instance, calls };
}

test('a forget only runs after the user staged and confirmed the selection', async () => {
  const { instance, calls } = control();
  const refused = await instance.confirmForget();
  assert.equal(refused.forget.kind, 'failed', 'a forget without a staged selection must fail');
  assert.equal(calls.forget.length, 0, 'the renderer must not run a forget it never staged');

  const staged = instance.requestForget({ eventIds: ['evt-1'], sources: [{ sourceId: 'src-1', sourceEventIds: [] }] }, 'the vault note');
  assert.equal(staged.pendingForget?.label, 'the vault note', 'the selection must be shown back before anything is deleted');
  assert.equal(calls.forget.length, 0, 'staging a selection must not delete anything');

  const confirmed = await instance.confirmForget();
  assert.equal(calls.forget.length, 1, 'confirming must run exactly the staged forget');
  assert.deepEqual(calls.forget[0], { eventIds: ['evt-1'], sources: [{ sourceId: 'src-1', sourceEventIds: [] }] });
  assert.equal(confirmed.pendingForget, null, 'the staged selection is cleared once it ran');
  assert.ok(confirmed.forget.kind === 'succeeded' && confirmed.forget.detail.includes('5 stored rows'), 'the receipt must report what was actually removed');
});

test('the private indicator is honest and the passphrase is never kept', async () => {
  const { instance, calls } = control();
  assert.equal(instance.state().privateLabel, NOT_PRIVATE_LABEL);
  const began = await instance.beginPrivateSession();
  assert.equal(began.private, true, 'a private session must be visible while it runs');
  assert.ok(began.privateSessionId, 'the storage boundary needs the session id the host opened');
  assert.deepEqual(calls.sessions, [began.privateSessionId], 'the private choice must reach the host registry');
  assert.equal(instance.state().privateLabel, PRIVATE_SESSION_LABEL);
  const ended = await instance.endPrivateSession();
  assert.equal(ended.private, false, 'ending the session must turn the indicator off');
  assert.equal(ended.privateSessionId, null, 'an ended session id must not keep claiming the private label');

  const exported = await instance.exportProfile({ passphrase: PASSPHRASE });
  assert.deepEqual(calls.export, [PASSPHRASE], 'the passphrase must reach the operation exactly once');
  assert.ok(exported.export.kind === 'succeeded' && exported.export.detail.includes('2 files'), 'the export must report what it sealed');
  assert.ok(!JSON.stringify(exported).includes(PASSPHRASE), 'the passphrase must never survive in renderer state');
});

test('the private indicator follows the host registry, and a host that refuses cannot fake it', async () => {
  const opened: string[] = [];
  const wired = control({
    beginPrivateSession: ({ sessionId }) => { opened.push(sessionId); },
    endPrivateSession: () => [{ sequence: 1, kind: 'utterance', text: 'spoken but never stored', at: '2026-09-04T09:00:00.000Z' }],
  });
  const began = await wired.instance.beginPrivateSession();
  assert.equal(opened.length, 1, 'the private choice must reach the host registry');
  assert.equal(began.privateSessionId, opened[0], 'the indicator must carry the id the registry opened');
  const ended = await wired.instance.endPrivateSession();
  assert.equal(ended.private, false, 'ending the session must turn the indicator off');
  assert.equal(ended.privateTranscript.length, 1, 'the transcript the host handed back once must be shown');
  assert.equal(ended.privateTranscript[0]?.text, 'spoken but never stored');

  const offline = control({
    beginPrivateSession: async () => { throw new Error('private-session registry is offline'); },
  });
  const refused = await offline.instance.beginPrivateSession();
  assert.equal(refused.private, false, 'the indicator must not claim privacy the storage boundary refused');
  assert.ok(refused.privateError?.includes('registry is offline'), 'the refusal must reach the user');

  const bare = createPrivacyControl({
    forget: async () => ({ deleted: 0, condensed: 0 }),
    exportProfile: async () => ({ files: [] }),
    importProfile: async () => ({ files: [] }),
  });
  const withoutRegistry = await bare.beginPrivateSession();
  assert.equal(withoutRegistry.private, false, 'a host without a registry cannot open a private session');
  assert.equal(withoutRegistry.bound, true, 'the profile itself is still bound; only the session hook is missing');
});

test('a failed export or import never claims success', async () => {
  const failing = control({
    exportProfile: async () => {
      throw new Error('private export requires a passphrase of at least 12 characters');
    },
    importProfile: async () => {
      throw new Error(`private export could not be decrypted with the provided passphrase ${CANARY}`);
    },
  });
  const failedExport = await failing.instance.exportProfile({ passphrase: PASSPHRASE });
  assert.equal(failedExport.export.kind, 'failed', 'a failing export must not report success');
  assert.ok(failedExport.export.kind === 'failed' && failedExport.export.reason.includes('at least 12'), 'the reason must reach the user');

  const failedImport = await failing.instance.importProfile({ archive: '/tmp/export.echopilot', passphrase: PASSPHRASE });
  assert.equal(failedImport.import.kind, 'failed', 'a failing import must not report success');
  assert.ok(
    failedImport.import.kind === 'failed' && failedImport.import.reason.endsWith('The destination was not modified.'),
    'a failed restore must say that the destination was untouched',
  );
  assert.ok(!JSON.stringify(failedImport).includes(PASSPHRASE), 'a failure must not keep the passphrase either');
});
