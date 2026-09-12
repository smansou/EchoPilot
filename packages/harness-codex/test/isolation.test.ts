import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexHarnessAdapter } from '../src/index.js';

const scope = {
  profileId: 'h01-profile',
  projectId: 'echopilot',
  worktreeId: 'h01',
  sensitivity: 'normal' as const,
};

test('managed children use only the explicit Codex home and cannot resume foreign threads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h01-isolation-test-'));
  const codexHome = join(directory, 'managed-home');
  const journalPath = join(directory, 'journal.jsonl');
  const adapter = createCodexHarnessAdapter({
    command: process.execPath,
    args: [fileURLToPath(new URL('isolation-app-server.mjs', import.meta.url))],
    cwd: directory,
    codexHome,
    env: {
      CODEX_HOME: join(directory, 'ambient-home-that-must-not-win'),
      H01_ISOLATION_JOURNAL: journalPath,
    },
    scope,
  });

  try {
    await adapter.start();
    assert.equal((await stat(codexHome)).isDirectory(), true);
    await assert.rejects(
      adapter.resume('foreign-thread'),
      /did not create it/,
      'resume must reject an id that was not issued by this managed adapter instance',
    );

    const entriesBeforeSend = (await readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; codexHome: string });
    assert.ok(entriesBeforeSend.length > 0);
    assert.ok(entriesBeforeSend.every((entry) => entry.codexHome === codexHome));
    assert.equal(entriesBeforeSend.some((entry) => entry.method === 'thread/resume'), false);

    await adapter.send('read-only fixture request', 'delivery-isolation');
    await adapter.resume('managed-thread');
    const methods = (await readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { method: string }).method);
    assert.equal(methods.filter((method) => method === 'thread/resume').length, 1);
  } finally {
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('relative Codex home paths are rejected before a child is spawned', () => {
  assert.throws(
    () => createCodexHarnessAdapter({
      command: process.execPath,
      cwd: process.cwd(),
      codexHome: 'relative/codex-home',
      scope,
    }),
    /absolute path/,
  );
});
