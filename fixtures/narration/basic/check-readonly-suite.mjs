#!/usr/bin/env node
/**
 * N01 read-only fixture suite — deterministic, offline, and side-effect free.
 *
 * `fixtures/narration/basic/managed-readonly-tests.json` is the normalized journal of a managed
 * read-only Codex app-server session that ran this file as its test command. The script prints one
 * line per check to stdout and exits nonzero when at least one check fails: that observed exit code
 * (and never the agent's own wording) is what a narration outcome must be reduced from.
 *
 * It reads no user data, writes no files, opens no socket, and needs no key or model.
 *
 * Usage: node fixtures/narration/basic/check-readonly-suite.mjs [--read-only] [--clean]
 */
const CHECKS = [
  'event ids stay unique',
  'source order is preserved',
  'exit codes stay authoritative',
  'log lines are never spoken',
  'evidence ids point at durable events',
  'leases gate every utterance',
  'replay keeps its session',
  'spoken text stays concise',
];
const TOTAL = 24;
/** The read-only fixture run that the journal records: checks 22–24 fail, everything else passes. */
const FAILING_CHECKS = new Set([22, 23, 24]);
const clean = process.argv.includes('--clean');
let passed = 0;
for (let index = 1; index <= TOTAL; index += 1) {
  const id = String(index).padStart(4, '0');
  const ok = clean || !FAILING_CHECKS.has(index);
  if (ok) passed += 1;
  const name = CHECKS[(index - 1) % CHECKS.length];
  process.stdout.write(`N01-LOG-${id} ${ok ? 'ok' : 'not ok'} ${index} - read-only assertion: ${name}\n`);
}
const failed = TOTAL - passed;
process.stdout.write(`${TOTAL} checks, ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
