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
  const calls: { forget: PrivacyForgetSelection[]; export: string[]; imports: { archive: string; passphrase: string }[] } = {
    forget: [],
    export: [],
    imports: [],
  };
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
  assert.equal(instance.beginPrivateSession().private, true, 'a private session must be visible while it runs');
  assert.equal(instance.state().privateLabel, PRIVATE_SESSION_LABEL);
  assert.equal(instance.endPrivateSession().private, false, 'ending the session must turn the indicator off');

  const exported = await instance.exportProfile({ passphrase: PASSPHRASE });
  assert.deepEqual(calls.export, [PASSPHRASE], 'the passphrase must reach the operation exactly once');
  assert.ok(exported.export.kind === 'succeeded' && exported.export.detail.includes('2 files'), 'the export must report what it sealed');
  assert.ok(!JSON.stringify(exported).includes(PASSPHRASE), 'the passphrase must never survive in renderer state');
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
