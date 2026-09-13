/**
 * Focused N01 checks for the spoken-formatting rules: literals (path/URL/code) become words, the
 * completion template stays concise and factual, and the fixture's check summary is only trusted
 * when it is self-consistent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { completionSpokenText, spokenArtifactName, spokenLiteral, truncateToWords, wordCount } from './format.js';
import { countChecks } from './outcome.js';

test('N01 format: paths, URLs and code tokens are spoken as words', () => {
  assert.equal(spokenLiteral('/tmp/a.ts'), 'slash tmp slash a dot ts');
  assert.equal(spokenLiteral('getContext'), 'get Context');
  assert.equal(spokenLiteral('https://example.com/a?b=1'), 'https colon slash slash example dot com slash a question mark b equals 1');
  assert.equal(spokenLiteral('run(a,b)'), 'run open paren a comma b close paren');
});

test('N01 format: the spoken subject is the artifact the command ran', () => {
  assert.equal(
    spokenArtifactName('node fixtures/narration/basic/check-readonly-suite.mjs --read-only'),
    'check-readonly-suite',
  );
  assert.equal(spokenArtifactName('python3 tools/check_report.py --strict'), 'check_report');
  assert.equal(spokenArtifactName('pnpm test'), 'test');
  assert.equal(spokenArtifactName('node'), null);
  assert.equal(spokenArtifactName(null), null);
});

test('N01 format: the completion template is concise, factual and within budget', () => {
  const failed = completionSpokenText({
    status: 'failed',
    exitCode: 1,
    counts: { total: 24, passed: 21, failed: 3 },
    artifact: 'check-readonly-suite',
  });
  assert.equal(failed, 'check-readonly-suite failed: 3 of 24 checks failed, exit code 1.');
  assert.ok(wordCount(failed) <= 50);

  const passed = completionSpokenText({
    status: 'passed',
    exitCode: 0,
    counts: { total: 24, passed: 24, failed: 0 },
    artifact: null,
  });
  assert.equal(passed, 'The managed test passed: 24 of 24 checks passed, exit code 0.');
  assert.ok(wordCount(passed) <= 50);

  const unknownCounts = completionSpokenText({ status: 'failed', exitCode: 7, counts: null, artifact: 'suite' });
  assert.equal(unknownCounts, 'suite failed: exit code 7.');
});

test('N01 format: only a self-consistent check summary is accepted', () => {
  assert.deepEqual(countChecks('noise\n24 checks, 21 passed, 3 failed\n'), { total: 24, passed: 21, failed: 3 });
  assert.deepEqual(countChecks('1 check, 1 passed, 0 failed'), { total: 1, passed: 1, failed: 0 });
  assert.equal(countChecks('24 checks, 20 passed, 3 failed'), null, 'inconsistent summaries are not trusted');
  assert.equal(countChecks('all good'), null);
  assert.equal(countChecks(null), null);
});

test('N01 format: a summary is trusted only when its failures agree with the observed exit code', () => {
  assert.deepEqual(countChecks('24 checks, 24 passed, 0 failed\n', 0), { total: 24, passed: 24, failed: 0 });
  assert.deepEqual(countChecks('24 checks, 21 passed, 3 failed\n', 1), { total: 24, passed: 21, failed: 3 });
  assert.equal(
    countChecks('24 checks, 24 passed, 0 failed\n', 1),
    null,
    'a summary denying the nonzero exit code is not trusted',
  );
  assert.equal(
    countChecks('24 checks, 21 passed, 3 failed\n', 0),
    null,
    'a summary claiming failures under a zero exit code is not trusted',
  );
});

test('N01 format: counts contradicting the exit code are never recited', () => {
  const falseGreen = completionSpokenText({
    status: 'failed',
    exitCode: 1,
    counts: { total: 24, passed: 24, failed: 0 },
    artifact: 'check-readonly-suite',
  });
  assert.equal(falseGreen, 'check-readonly-suite failed: exit code 1.');

  const falseRed = completionSpokenText({
    status: 'passed',
    exitCode: 0,
    counts: { total: 24, passed: 21, failed: 3 },
    artifact: 'check-readonly-suite',
  });
  assert.equal(falseRed, 'check-readonly-suite passed: exit code 0.');
});

test('N01 format: long text is truncated inside the concise budget', () => {
  const long = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
  const clipped = truncateToWords(long);
  assert.equal(wordCount(clipped), 50, 'the marker rides the last kept word, it does not add one');
  assert.ok(clipped.endsWith('…'));
});
