/**
 * Focused regression for the S01 reviewer finding: the native helper lookup must work from any
 * launch directory and must never execute a binary outside the app/repo tree.
 */
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import test from 'node:test';

import { nativeHelperCandidates, resolveNativeHelperPath } from '../src/helper-path.js';

const REPO_BUNDLE_DIR = resolve('/repo/checkout', 'dist/main');
const PACKAGED_BUNDLE_DIR = resolve('/Applications/EchoPilot.app/Contents/Resources/app', 'dist/main');

function underRoot(candidate: string, bundleDir: string): boolean {
  const root = resolve(bundleDir, '../..');
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

test('repo checkouts resolve the helper relative to the bundle, independent of the process cwd', () => {
  const release = resolve(REPO_BUNDLE_DIR, '../../native/macos/.build/release/echopilot-secrets');
  const debug = resolve(REPO_BUNDLE_DIR, '../../native/macos/.build/debug/echopilot-secrets');

  assert.equal(resolveNativeHelperPath({ bundleDir: REPO_BUNDLE_DIR, exists: (c) => c === release }), release);
  assert.equal(resolveNativeHelperPath({ bundleDir: REPO_BUNDLE_DIR, exists: (c) => c === debug }), debug);
  for (const candidate of nativeHelperCandidates({ bundleDir: REPO_BUNDLE_DIR })) {
    assert.ok(underRoot(candidate, REPO_BUNDLE_DIR), `candidate escapes the repo tree: ${candidate}`);
    assert.equal(candidate.includes(process.cwd()), false, `candidate depends on the process cwd: ${candidate}`);
  }
});

test('bundled apps resolve the helper under dist/native, matching the native-host convention', () => {
  const bundled = resolve(PACKAGED_BUNDLE_DIR, '../native/macos/.build/release/echopilot-secrets');
  assert.equal(resolveNativeHelperPath({ bundleDir: PACKAGED_BUNDLE_DIR, exists: (c) => c === bundled }), bundled);
  for (const candidate of nativeHelperCandidates({ bundleDir: PACKAGED_BUNDLE_DIR })) {
    assert.ok(underRoot(candidate, PACKAGED_BUNDLE_DIR), `candidate escapes the app tree: ${candidate}`);
  }
});

test('a missing helper fails loudly instead of falling back to a cwd-relative name', () => {
  assert.throws(
    () => resolveNativeHelperPath({ bundleDir: REPO_BUNDLE_DIR, exists: () => false }),
    /native secrets helper 'echopilot-secrets' was not found/,
  );
});
