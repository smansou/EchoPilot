// Pure decision policy for the EchoPilot autonomous loop.
//
// This module performs no IO, no process spawning and no network access, so every
// rule below is deterministic and unit-testable (scripts/loop-policy.test.mjs).
// scripts/loop.mjs is the runner: it owns state files, git, agents and repositories
// and delegates every judgement call to this module.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- constants
export const PHASES = Object.freeze(['test', 'implement', 'checks', 'review', 'integrate', 'publish']);
export const DEFAULT_INTEGRATION_BRANCH = 'codex/bootstrap';
export const CHECK_COMMANDS = Object.freeze([
  Object.freeze(['pnpm', 'typecheck']),
  Object.freeze(['pnpm', 'test']),
  Object.freeze(['pnpm', 'build']),
]);

export const FINDING_SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'security', 'nit']);
export const FINDING_CATEGORIES = Object.freeze(['ticket', 'shared', 'oracle', 'followup']);
export const FINDING_STATUSES = Object.freeze(['open', 'verified', 'deferred']);
export const BLOCKING_SEVERITIES = Object.freeze(['blocker', 'major', 'security']);

export const MAX_FINDINGS = 200;
// Durable finding text is kept in full; this is only a memory guard for pathological input.
export const MAX_FINDING_DESCRIPTION = 20_000;
// `lastFailure` is a log/state summary only - durable detail lives in record.findings.
export const LAST_FAILURE_LIMIT = 400;
export const MAX_FINGERPRINTS = 8;
export const MAX_TEST_HASH_HISTORY = 8;

export const MAX_PROVIDER_RETRIES = 4;
export const MAX_SUBSTANTIVE_FAILURES = 3;
export const MAX_ORACLE_REPAIRS = 2;
export const MAX_MERGE_REPAIRS = 2;
export const MAX_BOOTSTRAP_RETRIES = 2;
export const PROVIDER_BACKOFF_BASE_MS = 30_000;
export const PROVIDER_BACKOFF_MAX_MS = 15 * 60_000;

export const MAX_CHECK_ARGV = 12;
export const ALLOWED_COMMAND_HEADS = Object.freeze(['pnpm', 'node', 'swift']);

export const FORBIDDEN_PATHS = Object.freeze([
  '.git', '.github', '.loop', '.runner', '.agents', '.codex',
  'scripts/loop.mjs', 'scripts/loop-policy.mjs', 'scripts/loop-policy.test.mjs',
  'backlog.json', 'BACKLOG.json', 'loop-contracts.json', 'scripts/loop-gates.mjs', 'scripts/start-autonomous.mjs', 'scripts/test-project.mjs', 'scripts/validate-release.mjs', 'scripts/loop-agent-call.mjs',
]);

export const EXPECTED_ORIGIN_LABEL = 'smansou/EchoPilot';
export const DEFAULT_ORIGIN = 'https://github.com/smansou/EchoPilot.git';

export const WORKER_DEFAULTS = Object.freeze({
  model: 'deepseek-flash',
  effort: 'max',
  codexHome: '/Users/sobhi/.codex-deepseek-worker',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  approveForMe: true,
});
export const REVIEW_DEFAULTS = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'high',
  codexHome: '/Users/sobhi/.codex',
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  approveForMe: false,
});

const ROLE_ALIASES = Object.freeze({ worker: 'worker', implementer: 'worker', test: 'test', tests: 'test', oracle: 'test', reviewer: 'reviewer', review: 'reviewer' });
const REVIEW_MODEL_PATTERN = /sol|^gpt-/i;
const APPROVE_VERDICTS = new Set(['approve', 'approved', 'lgtm']);

// ---------------------------------------------------------------- primitives
export function digest(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function boundedText(text, { max = MAX_FINDING_DESCRIPTION } = {}) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(0, max);
}

// Short one-line summary for state.detail / record.lastFailure / logs.
export function summarize(text, { max = LAST_FAILURE_LIMIT } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function normalizeDescription(description) {
  return String(description ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeFingerprintText(text) {
  return String(text ?? '')
    .replace(/\b[0-9a-f]{7,}\b/gi, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function cleanPath(path) {
  return String(path ?? '').replace(/\/\*\*$/, '').replace(/\/$/, '');
}

export function overlaps(a, b) {
  const left = cleanPath(a);
  const right = cleanPath(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function conflicts(pathsA = [], pathsB = []) {
  return pathsA.some(a => pathsB.some(b => overlaps(a, b)));
}

export function isPathAllowed(file, paths, { forbidden = FORBIDDEN_PATHS } = {}) {
  if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) return false;
  const lower = String(file).toLowerCase();
  if (forbidden.some(entry => lower === entry.toLowerCase() || lower.startsWith(`${entry.toLowerCase()}/`))) return false;
  return (paths ?? []).some(path => {
    const base = cleanPath(path);
    return file === base || file.startsWith(`${base}/`);
  });
}

export function testFilePath(file) {
  return /(^|\/)(test|tests|fixtures?)\//i.test(file)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file)
    || /^scripts\/(check|test|smoke)[^/]*\.[cm]?[jt]s$/i.test(file);
}

const ASSERTION_PATTERN = /assert|expect|should|\.is\(|\.equal|toMatch|toThrow|throws|rejects|strictEqual|deepEqual|strict/i;
export function looksLikeAssertions(source) {
  return ASSERTION_PATTERN.test(String(source ?? ''));
}

// ---------------------------------------------------------------- agents/routes
export function canonicalRole(role) {
  return ROLE_ALIASES[String(role ?? '').toLowerCase()] ?? 'worker';
}

export function isReviewerRole(role) {
  return canonicalRole(role) === 'reviewer';
}

export function roleDefaults(role) {
  return isReviewerRole(role) ? REVIEW_DEFAULTS : WORKER_DEFAULTS;
}

// Per-role route: model, reasoning effort and the CODEX_HOME the agent runs under.
// The reviewer (e.g. gpt-5.6-sol) is never routed through the DeepSeek worker home,
// even when the legacy LOOP_CODEX_HOME override is set.
export function routeFor(role, env = process.env) {
  const reviewer = isReviewerRole(role);
  const defaults = roleDefaults(role);
  const key = String(role ?? '').toUpperCase();
  const model = (reviewer ? env.LOOP_REVIEW_MODEL : undefined) ?? env[`LOOP_${key}_MODEL`] ?? defaults.model;
  const effort = (reviewer ? env.LOOP_REVIEW_EFFORT : undefined) ?? env[`LOOP_${key}_EFFORT`] ?? defaults.effort;
  const roleHome = env[`LOOP_${key}_CODEX_HOME`];
  let codexHome;
  if (reviewer) {
    codexHome = env.LOOP_REVIEW_CODEX_HOME ?? REVIEW_DEFAULTS.codexHome;
  } else if (REVIEW_MODEL_PATTERN.test(model)) {
    codexHome = env.LOOP_REVIEW_CODEX_HOME ?? REVIEW_DEFAULTS.codexHome;
  } else {
    codexHome = roleHome ?? env.LOOP_CODEX_HOME ?? WORKER_DEFAULTS.codexHome;
  }
  return { role: canonicalRole(role), model, effort, codexHome };
}

// Sandbox/approval flags per role: worker and test may be user-authorized to approve
// for themselves (they need to modify the candidate), the reviewer is always
// read-only with approvals disabled.
export function approvalFlags(role, { env = {} } = {}) {
  if (isReviewerRole(role)) {
    return { sandbox: REVIEW_DEFAULTS.sandboxMode, approvalPolicy: 'never', approveForMe: false, dangerouslyBypass: false, network: false };
  }
  if (env.LOOP_WORKER_FULL_ACCESS === '1') {
    return { sandbox: WORKER_DEFAULTS.sandboxMode, approvalPolicy: 'never', approveForMe: false, dangerouslyBypass: true, network: false };
  }
  return {
    sandbox: WORKER_DEFAULTS.sandboxMode,
    approvalPolicy: env.LOOP_WORKER_APPROVAL_POLICY ?? WORKER_DEFAULTS.approvalPolicy,
    approveForMe: env.LOOP_APPROVE_FOR_ME !== '0',
    dangerouslyBypass: false,
    network: true,
  };
}

export function agentArgv(role, { cwd, model, effort, schemaPath, resultPath, env = {} } = {}) {
  const approval = approvalFlags(role, { env });
  const args = ['exec'];
  if (approval.approveForMe) args.push('--approve-for-me');
  if (approval.dangerouslyBypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('-c', `approval_policy=${JSON.stringify(approval.approvalPolicy)}`);
  if (approval.network) args.push('-c', 'sandbox_workspace_write.network_access=true');
  args.push(
    '-s', approval.sandbox,
    '-C', cwd,
    '-m', model,
    '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '--ephemeral', '--json',
    '--output-schema', schemaPath,
    '-o', resultPath,
    '-',
  );
  return args;
}

const FINDING_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
    category: { type: 'string', enum: [...FINDING_CATEGORIES] },
    description: { type: 'string' },
    status: { type: 'string', enum: ['open', 'deferred'] },
  },
  required: ['severity', 'category', 'description'],
  additionalProperties: false,
});

export const AGENT_SCHEMAS = Object.freeze({
  test: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['completed', 'not_applicable', 'blocked'] },
      summary: { type: 'string' },
      testFiles: { type: 'array', items: { type: 'string' } },
      testCommand: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['outcome', 'summary', 'testFiles', 'testCommand', 'evidence'],
    additionalProperties: false,
  },
  worker: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['completed', 'blocked'] },
      summary: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
    },
    required: ['outcome', 'summary', 'evidence', 'risks'],
    additionalProperties: false,
  },
  reviewer: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'request_changes'] },
      summary: { type: 'string' },
      findings: { type: 'array', items: FINDING_SCHEMA },
      resolvedFindingIds: { type: 'array', items: { type: 'string' } },
      issues: { type: 'array', items: { type: 'string' } },
      testIssue: { type: 'boolean' },
    },
    required: ['verdict', 'summary', 'findings', 'resolvedFindingIds', 'issues', 'testIssue'],
    additionalProperties: false,
  },
});

// ---------------------------------------------------------------- commands
export function validCommand(command, { heads = ALLOWED_COMMAND_HEADS, maxArgs = MAX_CHECK_ARGV } = {}) {
  return Array.isArray(command)
    && command.length > 0
    && command.length <= maxArgs
    && command.every(part => typeof part === 'string' && part.length > 0 && part.length < 300)
    && heads.includes(command[0]);
}

export function commandLabel(command) {
  return Array.isArray(command) ? command.join(' ') : String(command ?? '');
}

export function normalizeCollectChecks(raw) {
  const commands = Array.isArray(raw?.commands) ? raw.commands.filter(command => validCommand(command)).map(command => [...command]) : [];
  const coverage = {
    testFiles: Array.isArray(raw?.coverage?.testFiles) ? raw.coverage.testFiles.filter(value => typeof value === 'string') : [],
    nativePackages: Array.isArray(raw?.coverage?.nativePackages) ? raw.coverage.nativePackages.filter(value => typeof value === 'string') : [],
  };
  const missing = Array.isArray(raw?.missing) ? raw.missing.filter(value => typeof value === 'string') : [];
  return { commands, coverage, missing };
}

export function expectedNativePackages(ticket) {
  const packages = (ticket?.files ?? [])
    .map(file => /^native\/([^/]+)\//.exec(String(file))?.[1])
    .filter(Boolean);
  return [...new Set(packages)];
}

// Coverage claims from loop-gates are advisory: report gaps so the runner can also
// run its own frozen test, but never invent failures from an empty coverage list.
export function coverageGaps(coverage = {}, record = {}, ticket = {}) {
  const coveredTestFiles = coverage.testFiles ?? [];
  const coveredNative = coverage.nativePackages ?? [];
  const missingTestFiles = coveredTestFiles.length
    ? (record.testFiles ?? []).filter(file => !coveredTestFiles.includes(file))
    : [];
  const missingNativePackages = coveredNative.length
    ? expectedNativePackages(ticket).filter(name => !coveredNative.includes(name))
    : [];
  return { testFiles: missingTestFiles, nativePackages: missingNativePackages };
}

const MANIFEST_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-workspace\.ya?ml$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)npm-shrinkwrap\.json$/,
];
export function isManifestPath(file) {
  return MANIFEST_PATTERNS.some(pattern => pattern.test(String(file ?? '')));
}

// The coordinator may run `pnpm install --lockfile-only --ignore-scripts` only when
// every manifest/lockfile it would touch is explicitly owned or explicitly shared.
export function canReconcileLockfile(manifestFiles = [], allowedPaths = []) {
  const files = [...new Set(manifestFiles.filter(isManifestPath))];
  if (!files.length) return { allowed: false, offenders: [] };
  const offenders = files.filter(file => !isPathAllowed(file, allowedPaths));
  return { allowed: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------- contracts
const EMPTY_CONTRACTS = Object.freeze({ sharedPaths: [], tickets: {} });
export function emptyContracts() {
  return { sharedPaths: [], tickets: {} };
}

function isPathSpec(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 400
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

export function loadContracts(raw) {
  if (raw === undefined || raw === null) return emptyContracts();
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('loop-contracts.json must be a JSON object');
  const sharedPaths = Array.isArray(raw.sharedPaths) ? raw.sharedPaths.filter(isPathSpec) : [];
  const tickets = {};
  for (const [id, value] of Object.entries(raw.tickets ?? {})) {
    if (!value || typeof value !== 'object') continue;
    tickets[id] = {
      ownedPaths: Array.isArray(value.ownedPaths) ? value.ownedPaths.filter(isPathSpec) : [],
      checks: Array.isArray(value.checks) ? value.checks.filter(command => validCommand(command)).map(command => [...command]) : [],
      nonBlocking: Array.isArray(value.nonBlocking) ? value.nonBlocking.map(String) : [],
    };
  }
  return { sharedPaths, tickets };
}

export function ticketPaths(ticket, { extraPaths = {}, contracts = EMPTY_CONTRACTS } = {}) {
  return [...new Set([
    ...(ticket?.files ?? []),
    ...(extraPaths?.[ticket?.id] ?? []),
    ...(contracts?.tickets?.[ticket?.id]?.ownedPaths ?? []),
  ])];
}

export function checkCommandsFor(ticket, { contracts = EMPTY_CONTRACTS, fallback = CHECK_COMMANDS } = {}) {
  const configured = contracts?.tickets?.[ticket?.id]?.checks ?? [];
  return configured.length ? configured.map(command => [...command]) : fallback.map(command => [...command]);
}

// ---------------------------------------------------------------- findings
export function hashedFindingId(description) {
  return `f-${digest(normalizeDescription(description)).slice(0, 12)}`;
}

export function makeFinding(input, { now, head } = {}) {
  const description = boundedText(String(input?.description ?? input?.summary ?? '').trim());
  if (!description) throw new Error('finding requires a description');
  const severity = FINDING_SEVERITIES.includes(input?.severity) ? input.severity : 'major';
  const category = FINDING_CATEGORIES.includes(input?.category) ? input.category : 'ticket';
  const status = FINDING_STATUSES.includes(input?.status) ? input.status : 'open';
  const finding = {
    id: typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : hashedFindingId(description),
    severity,
    category,
    description,
    status,
    introducedAt: input?.introducedAt ?? now ?? new Date().toISOString(),
  };
  if (status === 'verified') finding.verifiedHead = input?.verifiedHead ?? head;
  if (status === 'deferred' && input?.deferredReason) finding.deferredReason = boundedText(String(input.deferredReason));
  return finding;
}

function findingKey(finding) {
  return `id:${finding.id}`;
}

export function mergeFindings(existing = [], incoming = [], { now, head } = {}) {
  const map = new Map();
  for (const raw of existing) {
    try {
      const finding = makeFinding(raw, { now, head });
      map.set(findingKey(finding), finding);
    } catch {}
  }
  const added = [];
  const updated = [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    if (!String(raw.description ?? '').trim()) continue;
    let finding;
    try {
      finding = makeFinding(raw, { now, head });
    } catch {
      continue;
    }
    const key = findingKey(finding);
    const prior = map.get(key);
    if (!prior) {
      map.set(key, finding);
      added.push(finding);
      continue;
    }
    const merged = {
      ...prior,
      description: finding.description,
      severity: finding.severity,
      category: FINDING_CATEGORIES.includes(raw.category) ? raw.category : prior.category,
    };
    if (prior.status === 'verified' || prior.status === 'deferred') {
      merged.status = prior.status;
      if (prior.verifiedHead) merged.verifiedHead = prior.verifiedHead;
      if (prior.deferredReason) merged.deferredReason = prior.deferredReason;
    }
    map.set(key, merged);
    updated.push(merged);
  }
  return { findings: [...map.values()], added, updated };
}

export function applyResolvedIds(findings = [], ids = [], { head } = {}) {
  const wanted = new Set((ids ?? []).map(String));
  let verified = 0;
  const out = findings.map(finding => {
    if (!wanted.has(finding.id)) return finding;
    if (finding.status === 'verified' && finding.verifiedHead === head) return finding;
    verified += 1;
    return { ...finding, status: 'verified', verifiedHead: head };
  });
  return { findings: out, verified };
}

export function openBlocking(findings = []) {
  // Followups are explicitly out of scope for approval: a correct ticket is never
  // blocked by an unrelated problem the reviewer noticed next door.
  return findings.filter(finding => finding.status === 'open'
    && finding.category !== 'followup'
    && BLOCKING_SEVERITIES.includes(finding.severity));
}

export function deferredFindings(findings = []) {
  return findings.filter(finding => finding.status === 'deferred');
}

// Bound the finding log by dropping the oldest closed entries first; open blockers
// are never evicted.
export function capFindings(findings = [], { max = MAX_FINDINGS } = {}) {
  if (findings.length <= max) return [...findings];
  const open = findings.filter(finding => finding.status === 'open');
  const closed = findings.filter(finding => finding.status !== 'open');
  if (open.length >= max) return open.slice(0, max);
  return [...open, ...closed.slice(0, max - open.length)];
}

export function findingFingerprint(findings = []) {
  const parts = findings
    .map(finding => `${finding.id}:${finding.severity}:${normalizeDescription(finding.description)}`)
    .sort();
  return digest(parts.join('\n'));
}

export function repairFingerprint({ phase, message } = {}) {
  return digest(`${phase ?? ''}\n${normalizeFingerprintText(message)}`);
}

export function rememberRepairFingerprint(record = {}, fingerprint, { max = MAX_FINGERPRINTS } = {}) {
  return [...(record.repairFingerprints ?? []), fingerprint].slice(-max);
}

// An identical fingerprint surviving two distinct repair attempts blocks that one
// ticket; other ready tickets keep running.
export function repetitionBlocked(record = {}) {
  const list = record.repairFingerprints ?? [];
  return list.length >= 2 && list[list.length - 1] === list[list.length - 2];
}

export function sanitizeReviewFindings(raw, { head, now } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const description = String(item.description ?? item.issue ?? item.summary ?? '').trim();
    if (!description) continue;
    try {
      out.push(makeFinding({
        id: item.id,
        severity: item.severity,
        category: item.category,
        description,
        status: item.status === 'deferred' ? 'deferred' : 'open',
        verifiedHead: item.verifiedHead,
      }, { now, head }));
    } catch {}
  }
  return out;
}

// Old reviewer output (plain `issues` strings) migrates to stable hashed IDs so a
// repeated complaint maps to the same durable finding instead of a new one.
export function legacyIssueFindings(issues, { testIssue, head, now } = {}) {
  if (!Array.isArray(issues)) return [];
  return issues
    .map(issue => String(issue ?? '').trim())
    .filter(Boolean)
    .map(description => makeFinding({
      id: hashedFindingId(description),
      severity: testIssue ? 'blocker' : 'major',
      category: testIssue ? 'oracle' : 'ticket',
      description,
    }, { now, head }));
}

export const UNRELATED_CATEGORIES = Object.freeze(['followup', 'shared']);
export function includesSharedBlocking(blocking = []) {
  return blocking.some(finding => finding.category === 'shared');
}

// Review decision: approve only when every blocking finding is resolved; oracle-only
// objections reroute to the independent test role; unrelated problems are followups.
export function reviewDecision(record = {}, review = {}, { head, now } = {}) {
  const structured = Array.isArray(review?.findings) && review.findings.length > 0;
  const incoming = [
    ...sanitizeReviewFindings(review?.findings, { head, now }),
    ...legacyIssueFindings(review?.issues, { testIssue: review?.testIssue, head, now }),
  ];
  const merged = mergeFindings(record.findings ?? [], incoming, { head, now });
  const resolved = applyResolvedIds(merged.findings, review?.resolvedFindingIds ?? [], { head });
  let findings = capFindings(resolved.findings);
  let blocking = openBlocking(findings);
  if (!blocking.length && review?.testIssue === true) {
    const extra = makeFinding({ severity: 'blocker', category: 'oracle', description: String(review?.summary ?? 'reviewer reported a test-oracle defect') }, { head, now });
    findings = capFindings(mergeFindings(findings, [extra], { head, now }).findings);
    blocking = openBlocking(findings);
  }
  const approved = APPROVE_VERDICTS.has(String(review?.verdict ?? '').toLowerCase()) && !review?.testIssue;
  const base = {
    findings,
    blocking,
    deferred: deferredFindings(findings),
    structured,
    resolvedCount: resolved.verified,
    approved,
  };
  if (approved && !blocking.length) return { ...base, decision: 'approve', fingerprint: findingFingerprint([]), short: summarize(review?.summary) };
  const repairPhase = blocking.some(finding => finding.category === 'oracle') && blocking.every(finding => finding.category === 'oracle')
    ? 'oracle-repair'
    : 'implement';
  const repairRole = repairPhase === 'oracle-repair' ? 'test' : 'worker';
  return {
    ...base,
    decision: 'repair',
    repairRole,
    phase: repairPhase,
    sharedRepair: includesSharedBlocking(blocking),
    fingerprint: blocking.length ? findingFingerprint(blocking) : repairFingerprint({ phase: repairPhase, message: `${review?.verdict} ${review?.summary}` }),
    short: summarize(blocking.length
      ? blocking.map(finding => `[${finding.id}] ${finding.severity}/${finding.category}: ${finding.description}`).join(' | ')
      : `${review?.verdict ?? 'request_changes'}: ${review?.summary ?? ''}`),
  };
}

// ---------------------------------------------------------------- recovery
export const FAILURE_CLASSES = Object.freeze(['provider', 'auth', 'user', 'bootstrap', 'oracle', 'implementation', 'review', 'merge']);

const AUTH_PATTERN = /\b(401|403)\b|invalid[_ -]?api[_ -]?key|missing (api )?key|no api key|not (logged|signed) in|unauthenticated|unauthorized|authentication|credentials?\b/i;
const USER_PATTERN = /needs? user|requires? user|user input|approval required|requested approval|permission denied by user/i;
const PROVIDER_PATTERN = /rate.?limit|quota|429|too many requests|overload|temporar|unavailable|\b(500|502|503|504)\b|ECONN|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang ?up|network|connection (refused|reset|failed|closed)|could not resolve host|timed? ?out|stalled/i;
const BOOTSTRAP_PATTERN = /frozen.?lockfile|lockfile|ERR_PNPM|dependency install|install failed|MODULE_NOT_FOUND|cannot find module|ENOENT/i;
const ORACLE_PATTERN = /test oracle|testIssue|oracle|acceptance test (fails|still|is)|no assertions?|tautolog/i;
const MERGE_PATTERN = /non-?fast-?forward|rebase|merge conflict|CONFLICT \(|would be overwritten/i;
const REVIEW_PATTERN = /review (requested|rejected|found)|request_changes|blocking finding/i;

export function classifyFailure(message, { phase } = {}) {
  const text = String(message ?? '');
  if (AUTH_PATTERN.test(text)) return 'auth';
  if (USER_PATTERN.test(text)) return 'user';
  if (PROVIDER_PATTERN.test(text)) return 'provider';
  if (BOOTSTRAP_PATTERN.test(text)) return 'bootstrap';
  if (phase === 'oracle-repair' || ORACLE_PATTERN.test(text)) return 'oracle';
  if (MERGE_PATTERN.test(text)) return 'merge';
  if (phase === 'review' || REVIEW_PATTERN.test(text)) return 'review';
  return 'implementation';
}

export function providerBackoffMs(retries) {
  const step = Math.max(0, Number(retries ?? 1) - 1);
  return Math.min(PROVIDER_BACKOFF_MAX_MS, PROVIDER_BACKOFF_BASE_MS * 2 ** step);
}

function substantiveRepair(record, { phase, reason }) {
  const substantiveFailures = (record.substantiveFailures ?? 0) + 1;
  if (substantiveFailures > MAX_SUBSTANTIVE_FAILURES) {
    return { action: 'blocked', failureClass: 'implementation', substantiveFailures, phase, repairRole: 'worker', reason: `${reason}: repair limit reached` };
  }
  return { action: 'repair', failureClass: 'implementation', substantiveFailures, phase, repairRole: 'worker', reason };
}

// Recovery routing. Provider rate/quota failures use a run-level cooldown and never
// consume coding repair counts; auth/user problems stop the run instead of looping.
export function recoveryPlan(failureClass, record = {}, { phase, now = Date.now(), reason } = {}) {
  switch (failureClass) {
    case 'auth':
      return { action: 'stop', terminal: true, failureClass, reason: reason ?? 'authentication credentials are missing or rejected' };
    case 'user':
      return { action: 'stop', terminal: true, failureClass, reason: reason ?? 'waiting for user input or approval' };
    case 'provider': {
      const providerRetries = (record.providerRetries ?? 0) + 1;
      if (providerRetries > MAX_PROVIDER_RETRIES) {
        return { action: 'stop', terminal: true, providerRetries, failureClass, reason: 'provider retries exhausted; credentials or quota need attention' };
      }
      const delay = providerBackoffMs(providerRetries);
      return {
        action: 'cooldown',
        providerRetries,
        retryAt: now + delay,
        failureClass,
        reason: `provider cooldown ${Math.round(delay / 1000)}s (attempt ${providerRetries}/${MAX_PROVIDER_RETRIES})`,
      };
    }
    case 'bootstrap': {
      const bootstrapRetries = (record.bootstrapRetries ?? 0) + 1;
      if (bootstrapRetries > MAX_BOOTSTRAP_RETRIES) {
        return { action: 'blocked', bootstrapRetries, failureClass, phase: phase ?? 'checks', reason: 'bootstrap failed after bounded retries' };
      }
      return {
        action: 'retry',
        bootstrapRetries,
        retryAt: now + providerBackoffMs(bootstrapRetries),
        failureClass,
        phase: phase ?? 'checks',
        reason: 'bootstrap retry (lockfile reconcile only)',
      };
    }
    case 'oracle': {
      const oracleRepairs = record.oracleRepairs ?? 0;
      if (oracleRepairs >= MAX_ORACLE_REPAIRS) {
        return { action: 'blocked', oracleRepairs, failureClass, phase: 'review', reason: 'oracle repair budget exhausted' };
      }
      return { action: 'repair', oracleRepairs, failureClass, phase: 'oracle-repair', repairRole: 'test', reason: 'independent oracle repair' };
    }
    case 'merge': {
      const mergeRepairs = record.mergeRepairs ?? 0;
      if (mergeRepairs >= MAX_MERGE_REPAIRS) {
        return { action: 'blocked', mergeRepairs, failureClass, phase: 'review', reason: 'merge repair budget exhausted' };
      }
      return { action: 'repair', mergeRepairs, failureClass, phase: 'merge-repair', repairRole: 'worker', reason: 'conflict repair in the retained candidate' };
    }
    case 'review':
      return substantiveRepair(record, { phase: 'implement', reason: reason ?? 'review findings need repair' });
    case 'implementation':
    default:
      return substantiveRepair(record, { phase: phase ?? 'implement', reason: reason ?? 'implementation repair' });
  }
}

export function isUnchangedRerun(record = {}, head) {
  return Boolean(head) && record.repairHead === head;
}

// Dispatch counters: `record.oracleRepairs` / `record.mergeRepairs` count repair
// attempts already made, so the budget check and the increment cannot drift apart.
export function beginOracleRepair(record = {}) {
  const used = record.oracleRepairs ?? 0;
  if (used >= MAX_ORACLE_REPAIRS) return { allowed: false, used, reason: 'oracle repair budget exhausted' };
  return { allowed: true, used, oracleRepairs: used + 1 };
}

export function beginMergeRepair(record = {}) {
  const used = record.mergeRepairs ?? 0;
  if (used >= MAX_MERGE_REPAIRS) return { allowed: false, used, reason: 'merge repair budget exhausted' };
  return { allowed: true, used, mergeRepairs: used + 1 };
}

// ---------------------------------------------------------------- phases/plan
export function phaseFor(record = {}) {
  return PHASES.includes(record?.phase) ? record.phase : 'test';
}

export function doneDecision(record = {}, facts = {}) {
  const marker = Boolean(record.publication?.approvedHead && record.publication?.integratedHead);
  if (record.approvedHead && record.gateEvidence?.head === record.approvedHead && record.gateEvidence?.commands?.length && record.publication?.approvedHead === record.approvedHead && facts.approvedHeadAncestor && marker) {
    return facts.publicationSatisfied === false ? 'publish-pending' : 'verified';
  }
  return 'legacy-unverified';
}

// A merged feat(ID) commit is history metadata, never proof of done: only
// record.approvedHead + same-head gate evidence + publication marker count.
export function planTicket(record = {}, facts = {}) {
  const phase = phaseFor(record);
  const marker = Boolean(record.publication?.approvedHead && record.publication?.integratedHead);
  if (doneDecision(record,facts)==='verified') return { action: 'done' };
  if (record.approvedHead && facts.approvedHeadAncestor) return { action: 'run', phase: 'publish', skipRebase: true, skipGates: true, skipReview: true };
  // A requested repair always runs before cached gate evidence can short-circuit it:
  // otherwise a rejected review would re-review the unchanged candidate forever.
  if (record.repairPending && record.phase === 'oracle-repair') {
    return { action: 'run', phase: 'oracle-repair', skipRebase: false, skipGates: false, skipReview: false };
  }
  if (record.repairPending) {
    return { action: 'run', phase: 'implement', skipRebase: false, skipGates: false, skipReview: false };
  }
  if (record.approvedHead && facts.approvedHeadCurrent) {
    return { action: 'run', phase: 'integrate', skipRebase: Boolean(facts.gateEvidenceCurrent), skipGates: Boolean(facts.gateEvidenceCurrent), skipReview: true };
  }
  if (facts.gateEvidenceCurrent) return { action: 'run', phase: 'integrate', skipRebase: true, skipGates: true, skipReview: false };
  if (facts.hasCandidate && record.testHashes && Object.keys(record.testHashes).length) {
    return { action: 'run', phase: phase === 'test' ? 'implement' : phase, skipRebase: false, skipGates: false, skipReview: false };
  }
  return { action: 'run', phase, skipRebase: false, skipGates: false, skipReview: false };
}

// First test authoring requires a red baseline; on a retained candidate the oracle is
// authored/kept and may already be green because the implementation exists.
export function testPolicy({ hasCandidate = false } = {}) {
  return {
    requiresRed: !hasCandidate,
    allowNotApplicable: true,
    authorMeaningfulTests: true,
    freezeExistingOnNotApplicable: hasCandidate,
  };
}

// ---------------------------------------------------------------- publication
export function originRepository(url) {
  const value = String(url ?? '').trim().replace(/\/+$/, '');
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^git:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return undefined;
}

export function pushTargetAllowed(branch, remoteUrl) {
  const name = String(branch ?? '');
  if (!/^codex\/[A-Za-z0-9._/-]+$/.test(name) || /(^|\/)(main|master)$/.test(name)) {
    return { ok: false, reason: `branch ${name || '(unset)'} is not a codex/* integration branch` };
  }
  const url = String(remoteUrl ?? '').trim();
  if (!url) return { ok: false, reason: 'origin remote is not configured' };
  const repository = originRepository(url);
  if (repository !== EXPECTED_ORIGIN_LABEL) {
    return { ok: false, reason: `origin ${url} is not ${EXPECTED_ORIGIN_LABEL}` };
  }
  return { ok: true, repository };
}

export function integratedTicketTitle(line) {
  const match = /^([0-9a-f]{7,40})\tfeat\(([A-Za-z]?\d+)\):/.exec(String(line ?? ''));
  return match ? { commit: match[1], id: match[2] } : undefined;
}

export function parseStructuredResult(text) {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  throw new Error(`Agent returned no valid structured result (${summarize(trimmed, { max: 120 })})`);
}
