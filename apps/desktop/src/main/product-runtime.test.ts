import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductRuntime } from './product-runtime';

test('profile choices persist while an imported privileged value remains only a proposal', () => {
  const userData = mkdtempSync(join(tmpdir(), 'echopilot-settings-'));
  try {
    const first = createProductRuntime(userData, process.cwd());
    first.setSetting('voice.preset', 'anna');
    const reopened = createProductRuntime(userData, process.cwd());
    assert.equal(reopened.settings().find((entry) => entry.key === 'voice.preset')?.value, 'anna');
    const report = reopened.importSettings(JSON.stringify({ version: 1, values: {
      'voice.preset': 'jean',
      'context.cloudExport': 'project-export',
      'unknown.privileged': 'on',
    } }));
    assert.deepEqual(report.staged, ['voice.preset']);
    assert.equal(report.proposals[0]?.key, 'context.cloudExport');
    assert.equal(report.rejected[0]?.key, 'unknown.privileged');
    const afterImport = createProductRuntime(userData, process.cwd());
    assert.equal(afterImport.settings().find((entry) => entry.key === 'voice.preset')?.value, 'jean');
    assert.equal(afterImport.settings().find((entry) => entry.key === 'context.cloudExport')?.value, 'off');
    afterImport.resetFamily('voice');
    assert.equal(createProductRuntime(userData, process.cwd()).settings().find((entry) => entry.key === 'voice.preset')?.value, 'alba');
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
