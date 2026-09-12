// Focused unit tests for scripts/loop-policy.mjs (pure decisions) plus an import
// safety check for scripts/loop.mjs. No repository, network, agent or state access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SCHEMAS, CHECK_COMMANDS, FINDING_CATEGORIES, LAST_FAILURE_LIMIT, MAX_FINDINGS,
  MAX_ORACLE_REPAIRS, MAX_PROVIDER_RETRIES, agentArgv, approvalFlags, applyResolvedIds,
  beginMergeRepair, beginOracleRepair, boundedText, canReconcileLockfile, capFindings,
  checkCommandsFor, classifyFailure, conflicts, coverageGaps, deferredFindings, digest,
  doneDecision, emptyContracts, expectedNativePackages, findingFingerprint, hashedFindingId,
  includesSharedBlocking, integratedTicketTitle, isManifestPath, isPathAllowed, isUnchangedRerun,
  legacyIssueFindings, loadContracts, looksLikeAssertions, makeFinding, mergeFindings,
  normalizeCollectChecks, openBlocking, originRepository, parseStructuredResult, phaseFor,
  planTicket, providerBackoffMs, pushTargetAllowed, recoveryPlan, rememberRepairFingerprint,
  repairFingerprint, repetitionBlocked, reviewDecision, routeFor, sanitizeReviewFindings,
  summarize, testFilePath, testPolicy, ticketPaths, validCommand, WORKER_DEFAULTS, REVIEW_DEFAULTS,
} from './loop-policy.mjs';

// ---------------------------------------------------------------- routing / homes
test('worker and test roles default to the DeepSeek home; reviewer to the Codex home', () => {
  const worker = routeFor('worker', {});
  const tester = routeFor('test', {});
  const reviewer = routeFor('reviewer', {});
  assert.equal(worker.model, 'deepseek-flash');
  assert.equal(worker.effort, 'max');
  assert.equal(worker.codexHome, WORKER_DEFAULTS.codexHome);
  assert.equal(tester.model, 'deepseek-flash');
  assert.equal(tester.codexHome, WORKER_DEFAULTS.codexHome);
  assert.equal(reviewer.model, 'gpt-5.6-sol');
  assert.equal(reviewer.effort, 'high');
  assert.equal(reviewer.codexHome, REVIEW_DEFAULTS.codexHome);
  assert.notEqual(worker.codexHome, reviewer.codexHome);
});

test('sol is never routed through the DeepSeek worker home', () => {
  // Legacy single-home override must not capture the reviewer...
  assert.equal(routeFor('reviewer', { LOOP_CODEX_HOME: '/tmp/deepseek-home' }).codexHome, REVIEW_DEFAULTS.codexHome);
  // ...and a worker configured with a sol model moves to the review home too.
  assert.equal(routeFor('worker', { LOOP_WORKER_MODEL: 'gpt-5.6-sol' }).codexHome, REVIEW_DEFAULTS.codexHome);
  assert.equal(routeFor('worker', { LOOP_WORKER_MODEL: 'gpt-5.6-sol' }).model, 'gpt-5.6-sol');
});

test('per-role env overrides stay independent', () => {
  const env = { LOOP_WORKER_MODEL: 'deepseek-pro', LOOP_WORKER_EFFORT: 'high', LOOP_TEST_MODEL: 'deepseek-flash', LOOP_TEST_EFFORT: 'low', LOOP_REVIEWER_MODEL: 'gpt-5.6', LOOP_REVIEWER_EFFORT: 'medium', LOOP_REVIEW_CODEX_HOME: '/tmp/review-home', LOOP_WORKER_CODEX_HOME: '/tmp/worker-home' };
  assert.deepEqual(routeFor('worker', env), { role: 'worker', model: 'deepseek-pro', effort: 'high', codexHome: '/tmp/worker-home' });
  assert.deepEqual(routeFor('test', env), { role: 'test', model: 'deepseek-flash', effort: 'low', codexHome: WORKER_DEFAULTS.codexHome });
  assert.deepEqual(routeFor('reviewer', env), { role: 'reviewer', model: 'gpt-5.6', effort: 'medium', codexHome: '/tmp/review-home' });
});

test('worker/test may approve for themselves; reviewer is read-only with approvals never', () => {
  const worker = approvalFlags('worker', { env: {} });
  const tester = approvalFlags('test', { env: {} });
  const reviewer = approvalFlags('reviewer', { env: {} });
  assert.deepEqual([worker.sandbox, worker.approvalPolicy, worker.approveForMe], ['workspace-write', 'on-request', true]);
  assert.deepEqual([tester.sandbox, tester.approvalPolicy, tester.approveForMe], ['workspace-write', 'on-request', true]);
  assert.deepEqual([reviewer.sandbox, reviewer.approvalPolicy, reviewer.approveForMe], ['read-only', 'never', false]);
});

test('agent argv carries the right sandbox/approval flags per role', () => {
  const common = { cwd: '/repo', schemaPath: '/tmp/s.json', resultPath: '/tmp/r.json' };
  const worker = agentArgv('worker', { ...common, model: 'deepseek-flash', effort: 'max' });
  const reviewer = agentArgv('reviewer', { ...common, model: 'gpt-5.6-sol', effort: 'high' });
  assert.ok(worker.includes('--approve-for-me'));
  assert.ok(worker.includes('approval_policy="on-request"'));
  assert.ok(worker.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(worker.includes('workspace-write'));
  assert.ok(!reviewer.includes('--approve-for-me'));
  assert.ok(reviewer.includes('approval_policy="never"'));
  assert.ok(reviewer.includes('read-only'));
  assert.ok(!reviewer.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(reviewer.includes('gpt-5.6-sol'));
});

test('reviewer schema is a compatible superset of the legacy verdict summary issues testIssue shape', () => {
  const schema = AGENT_SCHEMAS.reviewer;
  for (const key of ['verdict', 'summary', 'findings', 'resolvedFindingIds', 'issues', 'testIssue']) {
    assert.ok(schema.required.includes(key), `reviewer schema requires ${key}`);
  }
  assert.equal(AGENT_SCHEMAS.reviewer.properties.findings.items.properties.status.enum.join(','), 'open,deferred');
});

// ---------------------------------------------------------------- durable findings
test('durable findings are never truncated and re-reporting keeps id/full description', () => {
  const long = `${'Security defect in shared parser. '.repeat(300)}end-marker-${'y'.repeat(500)}`;
  assert.ok(long.length > 9000);
  const review = {
    verdict: 'request_changes',
    summary: 'blocking defects',
    findings: [{ severity: 'security', category: 'ticket', description: long }],
    resolvedFindingIds: [],
    issues: [],
    testIssue: false,
  };
  const first = reviewDecision({}, review, { head: 'head-1', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.decision, 'repair');
  assert.equal(first.blocking.length, 1);
  assert.equal(first.blocking[0].description, long);
  assert.equal(first.findings[0].introducedAt, '2026-01-01T00:00:00.000Z');

  const second = reviewDecision({ findings: first.findings }, review, { head: 'head-2' });
  assert.equal(second.findings.length, 1, 'the same finding must not duplicate');
  assert.equal(second.blocking[0].id, first.blocking[0].id, 'finding ids are stable');
  assert.equal(second.blocking[0].description, long, 'the full description survives a second review');
});

test('only a short summary is derived for lastFailure/logs', () => {
  const long = 'x'.repeat(5000);
  const summary = summarize(long, { max: LAST_FAILURE_LIMIT });
  assert.equal(summary.length, LAST_FAILURE_LIMIT);
  assert.equal(boundedText(long, { max: 100 }).length, 100);
  assert.equal(boundedText('short', { max: 100 }), 'short');
});

test('legacy issues arrays migrate to stable hashed ids and dedupe on re-report', () => {
  const issues = ['Renderer can reach Node APIs', 'IPC payload validation is missing'];
  const first = legacyIssueFindings(issues, { testIssue: false });
  const second = legacyIssueFindings(issues, { testIssue: false });
  assert.deepEqual(first.map(finding => finding.id), second.map(finding => finding.id));
  assert.equal(first[0].id, hashedFindingId(issues[0]));
  assert.deepEqual(first.map(finding => finding.category), ['ticket', 'ticket']);
  assert.ok(first.every(finding => finding.severity === 'major' && finding.status === 'open'));
  const oracle = legacyIssueFindings(['test asserts nothing'], { testIssue: true });
  assert.deepEqual([oracle[0].category, oracle[0].severity], ['oracle', 'blocker']);

  const merged = mergeFindings(first, first, {});
  assert.equal(merged.findings.length, issues.length);
});

test('review decisions accept structured findings and keep deferred/followup visible but non-blocking', () => {
  const review = {
    verdict: 'request_changes',
    summary: 'one real blocker plus unrelated notes',
    findings: [
      { severity: 'blocker', category: 'ticket', description: 'acceptance criterion 2 not implemented' },
      { severity: 'minor', category: 'followup', description: 'unrelated architecture cleanup for a later ticket' },
      { severity: 'major', category: 'followup', description: 'repo-wide lint debt outside this diff' },
      { severity: 'nit', category: 'ticket', description: 'rename a local variable', status: 'deferred' },
    ],
    resolvedFindingIds: [],
    issues: [],
    testIssue: false,
  };
  const decision = reviewDecision({}, review, { head: 'h' });
  assert.equal(decision.structured, true);
  assert.equal(decision.decision, 'repair');
  assert.equal(decision.repairRole, 'worker');
  assert.equal(decision.phase, 'implement');
  assert.equal(decision.blocking.length, 1);
  assert.equal(decision.blocking[0].category, 'ticket');
  assert.equal(decision.deferred.length, 1);
  // The followup is still recorded durably for later work.
  assert.equal(decision.findings.filter(finding => finding.category === 'followup').length, 2);

  const followupOnly = reviewDecision({}, { ...review, findings: review.findings.filter(finding => finding.category === 'followup') }, { head: 'h' });
  assert.equal(followupOnly.blocking.length, 0, 'unrelated followups never block a correct ticket');
});

test('approval requires every blocking finding resolved at the current head', () => {
  const blocker = makeFinding({ severity: 'blocker', category: 'ticket', description: 'silent data loss on resume' });
  const stillBlocked = reviewDecision({ findings: [blocker] }, {
    verdict: 'approve',
    summary: 'looks fine to me',
    findings: [],
    resolvedFindingIds: [],
    issues: [],
    testIssue: false,
  }, { head: 'head-9' });
  assert.equal(stillBlocked.decision, 'repair', 'an approve verdict must not override an open blocker');
  assert.equal(stillBlocked.blocking[0].id, blocker.id);

  const resolved = reviewDecision({ findings: [blocker] }, {
    verdict: 'approve',
    summary: 'blocker fixed by the new diff',
    findings: [],
    resolvedFindingIds: [blocker.id],
    issues: [],
    testIssue: false,
  }, { head: 'head-9' });
  assert.equal(resolved.decision, 'approve');
  assert.equal(resolved.resolvedCount, 1);
  assert.equal(resolved.findings[0].status, 'verified');
  assert.equal(resolved.findings[0].verifiedHead, 'head-9');
});

test('open blockers always reach the prompt text in full', () => {
  const description = `${'Long blocker detail. '.repeat(200)}tail`;
  const findings = [
    makeFinding({ severity: 'blocker', category: 'ticket', description }),
    makeFinding({ severity: 'security', category: 'shared', description: 'shared parser allows prototype pollution' }),
    makeFinding({ severity: 'major', category: 'followup', description: 'unrelated' }),
  ];
  const blocking = openBlocking(findings);
  assert.equal(blocking.length, 2);
  assert.deepEqual(blocking.map(finding => finding.description), [description, 'shared parser allows prototype pollution']);
  assert.equal(includesSharedBlocking(blocking), true);
});

test('verified and deferred findings are preserved; caps only evict closed entries', () => {
  const open = Array.from({ length: 3 }, (_, index) => makeFinding({ severity: 'blocker', description: `open ${index}` }));
  const verified = applyResolvedIds(open, [open[0].id], { head: 'h' });
  assert.equal(verified.verified, 1);
  assert.equal(verified.findings[0].status, 'verified');
  const capped = capFindings([...verified.findings, ...Array.from({ length: MAX_FINDINGS + 10 }, (_, index) => makeFinding({ severity: 'nit', description: `closed ${index}`, status: 'verified' }))]);
  assert.equal(capped.length, MAX_FINDINGS);
  assert.ok(capped.some(finding => finding.status === 'open'), 'open findings are never evicted');
});

test('finding fingerprints are stable across reviews and ignore commit hashes', () => {
  const a = repairFingerprint({ phase: 'implement', message: 'Check failed at commit 9f8a7b6c5d4e' });
  const b = repairFingerprint({ phase: 'implement', message: 'Check failed at commit abcdef1234567' });
  assert.equal(a, b);
  assert.notEqual(a, repairFingerprint({ phase: 'implement', message: 'Frozen test failed' }));
  const findings = [makeFinding({ severity: 'blocker', description: 'x' })];
  assert.equal(findingFingerprint(findings), findingFingerprint(findings));
  assert.equal(findingFingerprint(findings).length, 64);
});

test('identical fingerprints after two recorded repair attempts block only that ticket', () => {
  const record = { repairFingerprints: rememberRepairFingerprint({}, 'same'), repairs: 1 };
  assert.equal(repetitionBlocked(record), false);
  record.repairFingerprints = [...record.repairFingerprints, 'same'];
  assert.equal(repetitionBlocked(record), true);
  assert.equal(repetitionBlocked({ repairFingerprints: ['a', 'b'] }), false);
  const capped = rememberRepairFingerprint({ repairFingerprints: Array.from({ length: 20 }, (_, index) => `f${index}`) }, 'newest');
  assert.equal(capped.length, 8);
  assert.equal(capped.at(-1), 'newest');
});

test('unchanged rerun is detected from the repair head', () => {
  assert.equal(isUnchangedRerun({ repairHead: 'abc' }, 'abc'), true);
  assert.equal(isUnchangedRerun({ repairHead: 'abc' }, 'def'), false);
  assert.equal(isUnchangedRerun({}, undefined), false);
});

// ---------------------------------------------------------------- oracle reroute
test('oracle-only objections reroute to the independent test role', () => {
  const decision = reviewDecision({}, {
    verdict: 'request_changes',
    summary: 'the acceptance test asserts nothing meaningful',
    findings: [{ severity: 'blocker', category: 'oracle', description: 'test asserts nothing meaningful' }],
    resolvedFindingIds: [],
    issues: [],
    testIssue: false,
  }, { head: 'h1' });
  assert.equal(decision.decision, 'repair');
  assert.equal(decision.repairRole, 'test');
  assert.equal(decision.phase, 'oracle-repair');
});

test('mixed ticket+oracle objections route to the implementer, oracle alone never does', () => {
  const mixed = reviewDecision({}, {
    verdict: 'request_changes',
    summary: 'implementation and oracle defects',
    findings: [
      { severity: 'blocker', category: 'oracle', description: 'oracle defect' },
      { severity: 'major', category: 'ticket', description: 'implementation defect' },
    ],
    resolvedFindingIds: [],
    issues: [],
    testIssue: false,
  }, { head: 'h' });
  assert.equal(mixed.repairRole, 'worker');
  assert.equal(mixed.phase, 'implement');
  assert.equal(mixed.blocking.length, 2);
});

test('legacy testIssue=true reroutes to the test role even with an approve verdict', () => {
  const decision = reviewDecision({}, {
    verdict: 'approve',
    summary: 'cannot trust the oracle',
    findings: [],
    resolvedFindingIds: [],
    issues: [],
    testIssue: true,
  }, { head: 'h' });
  assert.equal(decision.decision, 'repair');
  assert.equal(decision.repairRole, 'test');
  assert.equal(decision.phase, 'oracle-repair');
  assert.equal(decision.approved, false);
});

test('oracle repairs are bounded to two attempts, then that ticket blocks', () => {
  assert.deepEqual(beginOracleRepair({ oracleRepairs: 0 }), { allowed: true, used: 0, oracleRepairs: 1 });
  assert.deepEqual(beginOracleRepair({ oracleRepairs: 1 }), { allowed: true, used: 1, oracleRepairs: 2 });
  const exhausted = beginOracleRepair({ oracleRepairs: MAX_ORACLE_REPAIRS });
  assert.equal(exhausted.allowed, false);
  const plan = recoveryPlan('oracle', { oracleRepairs: MAX_ORACLE_REPAIRS });
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.phase, 'review');
  assert.equal(recoveryPlan('oracle', { oracleRepairs: 0 }).repairRole, 'test');
});

test('merge repairs are bounded and routed to the candidate-conflict worker', () => {
  assert.equal(beginMergeRepair({ mergeRepairs: 0 }).mergeRepairs, 1);
  assert.equal(beginMergeRepair({ mergeRepairs: 2 }).allowed, false);
  const plan = recoveryPlan('merge', { mergeRepairs: 0 });
  assert.deepEqual([plan.action, plan.phase, plan.repairRole], ['repair', 'merge-repair', 'worker']);
});

// ---------------------------------------------------------------- recovery/backoff
test('provider failures use an exponential run-level cooldown bounded at 15 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 20].map(providerBackoffMs), [30_000, 60_000, 120_000, 240_000, 900_000]);
  const first = recoveryPlan('provider', { providerRetries: 0 }, { now: 1_000 });
  assert.deepEqual([first.action, first.providerRetries, first.retryAt], ['cooldown', 1, 31_000]);
  const fourth = recoveryPlan('provider', { providerRetries: MAX_PROVIDER_RETRIES - 1 }, { now: 0 });
  assert.deepEqual([fourth.action, fourth.retryAt], ['cooldown', 240_000]);
  const terminal = recoveryPlan('provider', { providerRetries: MAX_PROVIDER_RETRIES });
  assert.deepEqual([terminal.action, terminal.terminal], ['stop', true]);
});

test('provider and auth failures never burn coding repair counts', () => {
  const provider = recoveryPlan('provider', { providerRetries: 0, substantiveFailures: 9, oracleRepairs: 5 });
  assert.equal(provider.action, 'cooldown');
  assert.equal(provider.substantiveFailures, undefined);
  assert.equal(provider.oracleRepairs, undefined);
  const auth = recoveryPlan('auth', { substantiveFailures: 9 }, {});
  assert.deepEqual([auth.action, auth.terminal], ['stop', true]);
  const user = recoveryPlan('user', {}, {});
  assert.deepEqual([user.action, user.terminal], ['stop', true]);
});

test('bootstrap retries are bounded and reconcile-only failures never loop forever', () => {
  const retry = recoveryPlan('bootstrap', { bootstrapRetries: 0 }, { now: 5_000, phase: 'checks' });
  assert.deepEqual([retry.action, retry.retryAt, retry.phase], ['retry', 35_000, 'checks']);
  const blocked = recoveryPlan('bootstrap', { bootstrapRetries: 2 }, {});
  assert.equal(blocked.action, 'blocked');
});

test('implementation/review failures consume a bounded number of repairs', () => {
  assert.equal(recoveryPlan('implementation', { substantiveFailures: 0 }).action, 'repair');
  assert.equal(recoveryPlan('implementation', { substantiveFailures: 2 }).action, 'repair');
  assert.equal(recoveryPlan('implementation', { substantiveFailures: 3 }).action, 'blocked');
  const review = recoveryPlan('review', { substantiveFailures: 0 });
  assert.deepEqual([review.action, review.phase, review.repairRole], ['repair', 'implement', 'worker']);
});

test('failure classification routes by cause and current phase, not by keywords alone', () => {
  assert.equal(classifyFailure('429 Too Many Requests'), 'provider');
  assert.equal(classifyFailure('the agent request timed out'), 'provider');
  assert.equal(classifyFailure('401 Unauthorized: missing API key'), 'auth');
  assert.equal(classifyFailure('needs user input before continuing'), 'user');
  assert.equal(classifyFailure('ERR_PNPM frozen-lockfile install failed'), 'bootstrap');
  assert.equal(classifyFailure('MODULE_NOT_FOUND'), 'bootstrap');
  assert.equal(classifyFailure('CONFLICT (content): Merge conflict in packages/a/x.ts', { phase: 'integrate' }), 'merge');
  assert.equal(classifyFailure('the test oracle is a tautology', { phase: 'review' }), 'oracle');
  assert.equal(classifyFailure('Outside ticket ownership: packages/b/x.ts', { phase: 'implement' }), 'implementation');
  assert.equal(classifyFailure('no idea what happened', { phase: 'oracle-repair' }), 'oracle');
  assert.equal(classifyFailure('no idea what happened', { phase: 'implement' }), 'implementation');
});

// ---------------------------------------------------------------- done / phases
test('done is never inferred from feat(ID) titles', () => {
  assert.deepEqual(integratedTicketTitle('a5b57cdace8026f4a31a7f7b5f51fbc23acb0731\tfeat(F01): complete shared contracts'), {
    commit: 'a5b57cdace8026f4a31a7f7b5f51fbc23acb0731',
    id: 'F01',
  });
  assert.equal(integratedTicketTitle('abc1234\ttest(F01): red baseline'), undefined);
  assert.equal(integratedTicketTitle('abc1234\tfix(H01): repair harness'), undefined);
  assert.equal(integratedTicketTitle('not a commit line'), undefined);
});

test('doneDecision reconciles only approvedHead + same-head gate evidence + ancestor + publication marker', () => {
  const marker = { approvedHead: 'approved-1', integratedHead: 'merged-1' };
  const gateEvidence = { head: 'approved-1', base: 'base-1', commands: ['pnpm test'] };
  assert.equal(doneDecision({}, { approvedHeadAncestor: true, publicationSatisfied: true }), 'legacy-unverified');
  assert.equal(doneDecision({ approvedHead: 'approved-1', publication: marker }, { approvedHeadAncestor: true, publicationSatisfied: true }), 'legacy-unverified', 'gate evidence is required at the approved head');
  assert.equal(doneDecision({ approvedHead: 'approved-1', gateEvidence, publication: marker }, { approvedHeadAncestor: false, publicationSatisfied: true }), 'legacy-unverified');
  assert.equal(doneDecision({ approvedHead: 'approved-1', gateEvidence, publication: { ...marker, approvedHead: 'other' } }, { approvedHeadAncestor: true, publicationSatisfied: true }), 'legacy-unverified', 'publication must reference the same approved head');
  assert.equal(doneDecision({ approvedHead: 'approved-1', gateEvidence, publication: marker }, { approvedHeadAncestor: true, publicationSatisfied: true }), 'verified');
  assert.equal(doneDecision({ approvedHead: 'approved-1', gateEvidence, publication: marker }, { approvedHeadAncestor: true, publicationSatisfied: false }), 'publish-pending');
});

test('planTicket reruns only the necessary phase and never reimplements a merged ticket', () => {
  assert.deepEqual(planTicket({}, { hasCandidate: false }), { action: 'run', phase: 'test', skipRebase: false, skipGates: false, skipReview: false });
  const gateEvidence = { head: 'a', base: 'base', commands: ['pnpm test'] };
  assert.equal(planTicket({ approvedHead: 'a', gateEvidence, publication: { approvedHead: 'a', integratedHead: 'm' } }, { approvedHeadAncestor: true, publicationSatisfied: true }).action, 'done');
  // An approved head that is no longer an ancestor (rewritten history) must not jump
  // straight to publication; it falls back to a normal run that re-verifies the diff.
  const notAncestor = planTicket({ approvedHead: 'a', publication: { approvedHead: 'a', integratedHead: 'm' } }, { approvedHeadAncestor: false, publicationSatisfied: false });
  assert.deepEqual([notAncestor.action, notAncestor.phase], ['run', 'test']);
  const mergedNotPushed = planTicket({ approvedHead: 'a', publication: { approvedHead: 'a', integratedHead: 'm' } }, { approvedHeadAncestor: true, publicationSatisfied: false });
  assert.deepEqual([mergedNotPushed.action, mergedNotPushed.phase], ['run', 'publish'], 'push failures resume publication only');
  const approvedUnmerged = planTicket({ approvedHead: 'a' }, { approvedHeadCurrent: true, gateEvidenceCurrent: true });
  assert.deepEqual([approvedUnmerged.phase, approvedUnmerged.skipReview, approvedUnmerged.skipRebase], ['integrate', true, true]);
  const gatesDone = planTicket({ phase: 'implement' }, { hasCandidate: true, gateEvidenceCurrent: true });
  assert.deepEqual([gatesDone.phase, gatesDone.skipRebase, gatesDone.skipGates], ['integrate', true, true]);
  const retained = planTicket({ phase: 'test', testHashes: { 'a.test.ts': 'deadbeef' } }, { hasCandidate: true });
  assert.equal(retained.phase, 'implement');
  // A pending repair must run before cached gate evidence can send the ticket back
  // to review unchanged (worker repair and independent oracle repair respectively).
  const workerRepair = planTicket({ phase: 'implement', repairPending: true }, { hasCandidate: true, gateEvidenceCurrent: true });
  assert.deepEqual([workerRepair.phase, workerRepair.skipGates], ['implement', false]);
  const oracleRepair = planTicket({ phase: 'oracle-repair', repairPending: true }, { hasCandidate: true, gateEvidenceCurrent: true });
  assert.deepEqual([oracleRepair.phase, oracleRepair.skipGates], ['oracle-repair', false]);
});

test('phases persist across the test/implement/checks/review/integrate/publish set', () => {
  for (const phase of ['test', 'implement', 'checks', 'review', 'integrate', 'publish']) {
    assert.equal(phaseFor({ phase }), phase);
  }
  assert.equal(phaseFor({ phase: 'done' }), 'test');
  assert.equal(phaseFor({ phase: 'oracle-repair' }), 'test');
  assert.equal(phaseFor({}), 'test');
});

test('testPolicy only demands a red baseline before any candidate exists', () => {
  assert.equal(testPolicy({ hasCandidate: false }).requiresRed, true);
  assert.equal(testPolicy({ hasCandidate: true }).requiresRed, false);
  assert.equal(testPolicy({ hasCandidate: true }).freezeExistingOnNotApplicable, true);
  assert.equal(testPolicy({ hasCandidate: false }).freezeExistingOnNotApplicable, false);
});

// ---------------------------------------------------------------- publication safety
test('publication only ever accepts the exact origin and a codex/* branch', () => {
  assert.equal(originRepository('https://github.com/smansou/EchoPilot.git'), 'smansou/EchoPilot');
  assert.equal(originRepository('git@github.com:smansou/EchoPilot.git'), 'smansou/EchoPilot');
  assert.equal(pushTargetAllowed('codex/bootstrap', 'https://github.com/smansou/EchoPilot.git').ok, true);
  assert.equal(pushTargetAllowed('codex/bootstrap', 'git@github.com:smansou/EchoPilot.git').ok, true);
  assert.equal(pushTargetAllowed('codex/bootstrap', 'https://github.com/someone/EchoPilot.git').ok, false);
  assert.equal(pushTargetAllowed('codex/bootstrap', '').ok, false);
  assert.equal(pushTargetAllowed('main', 'https://github.com/smansou/EchoPilot.git').ok, false);
  assert.equal(pushTargetAllowed('master', 'https://github.com/smansou/EchoPilot.git').ok, false);
  assert.equal(pushTargetAllowed('feature/x', 'https://github.com/smansou/EchoPilot.git').ok, false);
});

// ---------------------------------------------------------------- contracts/gates
test('contracts load conservatively and extend ownership explicitly', () => {
  const contracts = loadContracts({
    sharedPaths: ['packages/contracts/', '../escape'],
    tickets: { A: { ownedPaths: ['pnpm-lock.yaml'], checks: [['pnpm', 'test'], ['rm', '-rf', '/']], nonBlocking: ['docs typo'] } },
  });
  assert.deepEqual(contracts.sharedPaths, ['packages/contracts/']);
  assert.deepEqual(contracts.tickets.A.ownedPaths, ['pnpm-lock.yaml']);
  assert.deepEqual(contracts.tickets.A.checks, [['pnpm', 'test']]);
  assert.equal(loadContracts(undefined).sharedPaths.length, 0);
  assert.throws(() => loadContracts('nope'));
  assert.deepEqual(emptyContracts(), { sharedPaths: [], tickets: {} });
  const paths = ticketPaths({ id: 'A', files: ['packages/a/'] }, { extraPaths: { A: ['extra/'] }, contracts });
  assert.deepEqual(paths, ['packages/a/', 'extra/', 'pnpm-lock.yaml']);
  assert.deepEqual(checkCommandsFor({ id: 'A' }, { contracts }), [['pnpm', 'test']]);
  assert.deepEqual(checkCommandsFor({ id: 'B' }, { contracts }), CHECK_COMMANDS.map(command => [...command]));
});

test('lockfile reconciliation is allowed only for explicitly owned or shared manifests', () => {
  assert.equal(isManifestPath('packages/a/package.json'), true);
  assert.equal(isManifestPath('pnpm-lock.yaml'), true);
  assert.equal(isManifestPath('packages/a/src/index.ts'), false);
  const denied = canReconcileLockfile(['package.json'], ['packages/a/']);
  assert.deepEqual([denied.allowed, denied.offenders], [false, ['package.json']]);
  const allowed = canReconcileLockfile(['packages/a/package.json', 'packages/a/pnpm-lock.yaml'], ['packages/a']);
  assert.equal(allowed.allowed, true);
  assert.equal(canReconcileLockfile([], ['packages/a']).allowed, false);
  assert.deepEqual(canReconcileLockfile(['README.md'], ['packages/a']).offenders, []);
});

test('collectChecks output is normalised defensively and coverage gaps stay advisory', () => {
  const collected = normalizeCollectChecks({
    commands: [['pnpm', 'test'], ['rm', '-rf', '/'], 'nonsense', ['pnpm', 'typecheck']],
    coverage: { testFiles: ['apps/desktop/a.test.ts'], nativePackages: ['macos'] },
    missing: ['fixtures/bootstrap'],
  });
  assert.deepEqual(collected.commands, [['pnpm', 'test'], ['pnpm', 'typecheck']]);
  assert.deepEqual(collected.coverage.testFiles, ['apps/desktop/a.test.ts']);
  assert.deepEqual(collected.missing, ['fixtures/bootstrap']);
  assert.deepEqual(normalizeCollectChecks(undefined), { commands: [], coverage: { testFiles: [], nativePackages: [] }, missing: [] });

  assert.deepEqual(expectedNativePackages({ files: ['native/macos/', 'native/windows/x', 'packages/a/'] }), ['macos', 'windows']);
  const gaps = coverageGaps({ testFiles: ['apps/desktop/a.test.ts'], nativePackages: [] }, { testFiles: ['apps/desktop/a.test.ts', 'apps/desktop/b.test.ts'] }, { files: ['native/macos/'] });
  assert.deepEqual(gaps.testFiles, ['apps/desktop/b.test.ts']);
  assert.deepEqual(gaps.nativePackages, [], 'an empty coverage list is not treated as a gap');
  const nativeGap = coverageGaps({ testFiles: [], nativePackages: ['other'] }, {}, { files: ['native/macos/'] });
  assert.deepEqual(nativeGap.nativePackages, ['macos']);
});

// ---------------------------------------------------------------- paths/commands
test('ownership rules reject forbidden, absolute and escaping paths', () => {
  assert.equal(isPathAllowed('packages/a/src/index.ts', ['packages/a/']), true);
  assert.equal(isPathAllowed('packages/b/src/index.ts', ['packages/a/']), false);
  assert.equal(isPathAllowed('.loop/state.json', ['.loop']), false);
  assert.equal(isPathAllowed('scripts/loop.mjs', ['scripts/']), false);
  assert.equal(isPathAllowed('/etc/passwd', ['etc/']), false);
  assert.equal(isPathAllowed('../outside.ts', ['packages/a/']), false);
  assert.equal(conflicts(['packages/a/'], ['packages/a/b/']), true);
  assert.equal(conflicts(['packages/a/'], ['packages/b/']), false);
});

test('test command argv validation and file heuristics', () => {
  assert.equal(validCommand(['pnpm', 'test']), true);
  assert.equal(validCommand(['node', '--test', 'scripts/x.test.mjs']), true);
  assert.equal(validCommand(['rm', '-rf', '/']), false);
  assert.equal(validCommand([]), false);
  assert.equal(validCommand(['pnpm', ...Array.from({ length: 12 }, () => 'x')]), false);
  assert.equal(validCommand(['pnpm', 5]), false);
  assert.equal(testFilePath('apps/desktop/src/x.test.ts'), true);
  assert.equal(testFilePath('tests/foo.ts'), true);
  assert.equal(testFilePath('scripts/check-contracts.ts'), true);
  assert.equal(testFilePath('apps/desktop/src/index.ts'), false);
  assert.equal(looksLikeAssertions('expect(value).toBe(1)'), true);
  assert.equal(looksLikeAssertions('const value = 1'), false);
});

test('structured agent output parsing tolerates fences and rejects noise', () => {
  assert.deepEqual(parseStructuredResult('{"verdict":"approve"}'), { verdict: 'approve' });
  assert.deepEqual(parseStructuredResult('```json\n{"verdict":"approve"}\n```'), { verdict: 'approve' });
  assert.deepEqual(parseStructuredResult('prose {"ok":true} trailing'), { ok: true });
  assert.throws(() => parseStructuredResult('no json here'));
});

test('reviewer finding sanitisation ignores malformed items without crashing', () => {
  const sanitized = sanitizeReviewFindings([
    null,
    42,
    { severity: 'weird', category: 'nope', description: 'keeps a real description' },
    { description: '   ' },
    { severity: 'security', category: 'shared', description: 'shared path injection', status: 'deferred' },
  ], { head: 'h' });
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].severity, 'major');
  assert.equal(sanitized[0].category, 'ticket');
  assert.equal(sanitized[1].status, 'deferred');
  assert.ok(FINDING_CATEGORIES.includes(sanitized[0].category));
});

test('digest-based ids are stable and independent of whitespace noise', () => {
  assert.equal(hashedFindingId('Broken  IPC validation'), hashedFindingId(' broken ipc validation '));
  assert.equal(digest('x').length, 64);
  assert.equal(deferredFindings([makeFinding({ description: 'a', status: 'deferred' })]).length, 1);
});

// ---------------------------------------------------------------- import safety
test('loop.mjs can be imported without running the runner', async () => {
  const module = await import('./loop.mjs');
  assert.equal(typeof module.main, 'function');
});
