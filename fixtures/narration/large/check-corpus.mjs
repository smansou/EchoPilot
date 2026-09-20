/**
 * N02 large-corpus fixture — a deterministic, synthetic 200-run messy diff/log corpus plus the CLI
 * that proves the corpus is reproducible and internally consistent.
 *
 * Nothing here touches the network, the clock, the filesystem, or user data: every run is built
 * from index-derived values only, so `node check-corpus.mjs --json` is byte-stable, and the N02
 * acceptance oracle in `packages/narration/src/compiler/n02.acceptance.test.ts` freezes the digest
 * of that output before it drives the narration-compiler seam with the returned runs.
 *
 * What the compiler consumes for one run (labels are never handed to the compiler):
 *
 *   runId, sessionId, taskId,
 *   events:   normalized section 5.3 EventEnvelope records (mixed session_state / agent_message /
 *             tool_started / tool_completed / decision / artifact_changed / approval_requested /
 *             permission_changed / unsupported(log_line) kinds)
 *   payloads: keyed by the envelope's `payloadRef`, in the pinned shapes:
 *             tool_started        { taskId, command, title, receiptId }
 *             tool_completed      { taskId, command, receiptId, output, exitCode }
 *             unsupported/log_line{ stream: 'stdout'|'stderr', line }
 *             agent_message       { text }
 *             decision            { summary, rationale }
 *             artifact_changed    { path, change: 'created'|'modified' }
 *             approval_requested  { title, detail }
 *             permission_changed  { decision: 'granted'|'denied', detail }
 *             session_state       { method: 'thread/started'|'turn/completed', status }
 *
 * Ground truth for one run (labels):
 *   facts [{ id, kind, critical, supported, evidenceEventIds }]
 *     A fact is *covered* when a spoken claim with supported === true cites one of its
 *     evidenceEventIds. `supported: false` facts are prose assertions (agent_message) that must
 *     never be presented as verified. `critical: true` marks the events whose recall the ticket
 *     gates at 95% (failures, problems, decisions, approvals, retries).
 *   rawDetail { paths, urls, code }   exact raw strings ordinary spoken text must never recite.
 *   formattingSamples                 raw stream lines that carry those strings.
 *   duplicateRedraws                  repeated progress redraws the compiler must collapse.
 *   exactReading { text }             an explicit "read it exactly" request (verbatim, bounded).
 *   falseSuccessClaim { eventId, phrase }  agent prose contradicting the observed exit code.
 *   finalReceiptEventId / finalExitCode    the run's observed outcome (last tool_completed).
 *
 * Usage: node fixtures/narration/large/check-corpus.mjs [--json|--summary]
 *   --json     print the corpus document (plus its digest) for the oracle to consume
 *   --summary  print counts, archetypes, and the digest (default)
 * Exit code is nonzero when the corpus fails self-validation.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CORPUS_CONTRACT_VERSION = 1;
export const CORPUS_FIXTURE_ID = 'narration-large-messy-200';
export const CORPUS_CONSENT = 'synthetic';
export const CORPUS_SEED = 'n02-large-2026-09-14';
export const CORPUS_RUN_COUNT = 200;

const WORKSPACE = '/Users/sobhi/projects/echopilot';
const BASE_MS = Date.UTC(2026, 8, 14, 6, 0, 0);
const SCOPE = { profileId: 'profile-n2', projectId: 'project-n2', worktreeId: 'worktree-n2' };
const REDRAW_IDENTICAL = 12;
const REDRAW_DISTINCT = 8;

const ARCHETYPE_COUNTS = [
  ['clean-pass', 30],
  ['failed-checks', 40],
  ['build-error', 20],
  ['approval', 15],
  ['retry-flake', 20],
  ['progress-redraw', 25],
  ['diff-decision', 25],
  ['url-code', 15],
  ['mixed-long', 10],
];

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function wordCount(text) {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
}

/** Deterministic PRNG so the archetype schedule is shuffled the same way on every machine. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function schedule() {
  const names = [];
  for (const [name, count] of ARCHETYPE_COUNTS) {
    for (let index = 0; index < count; index += 1) names.push(name);
  }
  const random = mulberry32(Number.parseInt(sha256(CORPUS_SEED).slice(0, 8), 16));
  for (let index = names.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = names[index];
    names[index] = names[swapIndex];
    names[swapIndex] = current;
  }
  return names;
}

function createBuilder(index, archetype) {
  const runId = `n02-run-${pad(index, 3)}`;
  const sessionId = `session-n02-${pad(index, 3)}`;
  const taskId = `task-n02-${pad(index, 3)}`;
  const receiptId = `receipt-n02-${pad(index, 3)}`;
  const turnId = `turn-n02-${pad(index, 3)}`;
  const startMs = BASE_MS + index * 60_000;
  const events = [];
  const payloads = {};
  const facts = [];
  const redrawTexts = [];
  const labels = {
    rawDetail: { paths: [], urls: [], code: [] },
    formattingSamples: [],
    duplicateRedraws: 0,
    exactReading: null,
    falseSuccessClaim: null,
    finalReceiptEventId: null,
    finalExitCode: null,
  };
  let sequence = 0;

  function push(kind, payload, options = {}) {
    sequence += 1;
    const eventId = `evt-${runId}-${pad(sequence, 2)}`;
    const payloadRef = `fixture://n02/${runId}/${pad(sequence, 2)}`;
    const event = {
      schemaVersion: 1,
      eventId,
      sourceId: `source-${runId}`,
      sourceEventId: options.sourceEventId ?? `${kind}#${pad(sequence, 2)}`,
      sourceSequence: sequence,
      ingestSequence: sequence,
      occurredAt: iso(startMs + sequence * 1_000),
      observedAt: iso(startMs + sequence * 1_000 + 100),
      scope: { ...SCOPE, sessionId, sensitivity: 'normal' },
      turnId,
      kind,
      ...(options.unsupportedKind === undefined ? {} : { unsupportedKind: options.unsupportedKind }),
      payloadRef,
      contentHash: `sha256:n2-${runId}-${pad(sequence, 2)}`,
      trust: options.trust ?? 'tool_observed',
    };
    events.push(event);
    payloads[payloadRef] = payload;
    return event;
  }

  const builder = {
    index,
    archetype,
    runId,
    sessionId,
    taskId,
    receiptId,
    events,
    payloads,
    facts,
    labels,

    sessionState(method, status) {
      return push('session_state', { method, status }, { trust: 'tool_observed' });
    },
    agentMessage(text) {
      return push('agent_message', { text }, { trust: 'agent_reported' });
    },
    toolStarted(fields = {}) {
      return push('tool_started', {
        taskId,
        command: fields.command ?? null,
        title: fields.title ?? null,
        receiptId,
      });
    },
    toolCompleted(fields = {}) {
      return push('tool_completed', {
        taskId,
        command: fields.command ?? null,
        receiptId,
        output: fields.output ?? null,
        exitCode: fields.exitCode ?? null,
      });
    },
    logLine(line, stream = 'stdout') {
      return push('unsupported', { stream, line }, { unsupportedKind: 'log_line' });
    },
    redraw(line) {
      redrawTexts.push(line);
      return builder.logLine(line);
    },
    decision(summary, rationale) {
      return push('decision', { summary, rationale }, { trust: 'tool_observed' });
    },
    artifactChanged(path, change) {
      builder.addRawPath(path);
      return push('artifact_changed', { path, change });
    },
    approvalRequested(title, detail) {
      return push('approval_requested', { title, detail }, { trust: 'tool_observed' });
    },
    permissionChanged(decision, detail) {
      return push('permission_changed', { decision, detail });
    },
    addFact(event, kind, critical, evidenceEventIds = null) {
      const ids = evidenceEventIds ?? [event.eventId];
      const supported = ids.some((id) => {
        const cited = events.find((candidate) => candidate.eventId === id);
        return cited !== undefined && cited.kind !== 'agent_message';
      });
      facts.push({
        id: `fact-${runId}-${pad(facts.length + 1, 2)}`,
        kind,
        critical,
        supported,
        evidenceEventIds: ids,
      });
      return event;
    },
    addRawPath(path) {
      if (!labels.rawDetail.paths.includes(path)) labels.rawDetail.paths.push(path);
    },
    addRawUrl(url) {
      if (!labels.rawDetail.urls.includes(url)) labels.rawDetail.urls.push(url);
    },
    addRawCode(code) {
      if (!labels.rawDetail.code.includes(code)) labels.rawDetail.code.push(code);
    },
    addSample(line) {
      labels.formattingSamples.push(line);
    },
    finalize(extra = {}) {
      const duplicates = redrawTexts.length - new Set(redrawTexts).size;
      labels.duplicateRedraws = duplicates;
      labels.finalReceiptEventId = extra.receiptEventId ?? null;
      labels.finalExitCode = extra.exitCode ?? null;
      labels.exactReading = extra.exactReading ?? null;
      return { runId, sessionId, taskId, archetype, events, payloads, labels };
    },
  };

  return builder;
}

function rawBlockLines(builder, path, url, code) {
  const other = `${WORKSPACE}/packages/narration/src/compiler/chapters-${builder.index % 7}.ts`;
  const script = `${WORKSPACE}/fixtures/narration/large/check-corpus.mjs`;
  return [
    `N02-RAW inspect ${path} before the compiler reduces the stream into typed claims`,
    `N02-RAW see ${url} for the four verbosity budgets and their upper bounds`,
    `N02-RAW call ${code} against the frozen corpus and keep the evidence ids attached`,
    `N02-RAW compare ${path} with ${other} and report the touched behavior`,
    `N02-RAW render ${url.replace('https://', 'wss://')} as a site label rather than a raw address`,
    `N02-RAW keep ${code} out of ordinary spoken text unless the user reads it exactly`,
    `N02-RAW map ${script} into claims that cite the durable event they came from`,
    `N02-RAW checksum ${path} and compare the digest with the frozen fixture digest`,
    `N02-RAW coalesce repeated progress redraws so a long build never becomes a speech storm`,
    `N02-RAW keep ${other} chapter budgets bounded so thorough coverage stays under six hundred words`,
    `N02-RAW drop unsupported assertions and never upgrade agent prose into a verified result`,
    `N02-RAW preserve ${path} verbatim when an explicit exact reading is requested for one segment`,
    `N02-RAW record ${url} as the documentation source for the spoken formatting rules`,
    `N02-RAW summarize ${script} with the observed counts and the observed exit code only`,
    `N02-RAW verify ${path} still compiles after the claim kinds are narrowed to the frozen union`,
    `N02-RAW finish ${builder.runId} with a balanced digest of results decisions changes and problems`,
  ];
}

const ARCHETYPE_BUILDERS = {
  'clean-pass': (b) => {
    const checks = 12 + (b.index % 9);
    b.sessionState('thread/started', 'running');
    b.agentMessage(`Running the read-only suite with ${checks} checks for ${b.runId}.`);
    b.toolStarted({ command: `node fixtures/narration/large/check-corpus.mjs --run ${b.runId}`, title: 'run read-only suite' });
    const milestone = b.logLine(`N02-MILESTONE collected ${checks} checks for ${b.runId}`);
    b.addFact(milestone, 'progress', false);
    for (let step = 1; step <= 3; step += 1) {
      b.logLine(`N02-LOG ok ${b.runId}-case-${step} (${3 + step} ms)`);
    }
    const completed = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(completed, 'result', false);
    b.agentMessage('That should be fine, I think.');
    const summaryLine = `N02-SUMMARY ${checks} of ${checks} checks passed, 0 failed`;
    const summary = b.logLine(summaryLine);
    b.addSample(summaryLine);
    b.addFact(summary, 'verification', false);
    const artifact = b.artifactChanged(`${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.json`, 'created');
    b.addFact(artifact, 'change', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: completed.eventId, exitCode: 0 });
  },

  'failed-checks': (b) => {
    const checks = 10 + (b.index % 7);
    const failing = 2 + (b.index % 3);
    b.sessionState('thread/started', 'running');
    b.agentMessage(`Running ${checks} narration checks for ${b.runId}.`);
    b.toolStarted({ command: 'pnpm -C packages/narration test', title: 'run narration checks' });
    for (let step = 1; step <= failing; step += 1) {
      const failureLine = `N02-LOG FAIL ${b.runId}-case-${step} failed: expected ${step + 1} chapters received ${step - 1}`;
      const line = b.logLine(failureLine);
      if (step === 1) b.addSample(failureLine);
      b.addFact(line, 'problem', true);
    }
    b.logLine(`N02-PROGRESS ${b.runId} wrote ${checks - failing} passing results`);
    const completed = b.toolCompleted({ output: 'exit code 1', exitCode: 1 });
    b.addFact(completed, 'result', true);
    const phrase = `All ${checks} checks passed successfully`;
    const claim = b.agentMessage(phrase);
    b.labels.falseSuccessClaim = { eventId: claim.eventId, phrase };
    b.addFact(claim, 'verification', false);
    const artifact = b.artifactChanged(`${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.json`, 'modified');
    b.addFact(artifact, 'change', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: completed.eventId, exitCode: 1 });
  },

  'build-error': (b) => {
    const file = `packages/narration/src/compiler/parse-${b.index % 5}.ts`;
    const path = `${WORKSPACE}/${file}`;
    const errorLine = `N02-ERROR ${path}(41,7): error TS2322: Type 'string' is not assignable to type 'NarrationVerbosity'`;
    b.sessionState('thread/started', 'running');
    b.agentMessage(`Checking types in ${file}.`);
    b.toolStarted({ command: 'pnpm typecheck', title: 'typecheck' });
    const error = b.logLine(errorLine, 'stderr');
    b.addRawPath(path);
    b.addSample(errorLine);
    b.addFact(error, 'problem', true);
    const failed = b.toolCompleted({ output: 'exit code 2', exitCode: 2 });
    b.addFact(failed, 'result', true);
    const decision = b.decision(
      `Narrowed the claim kind union in ${file}`,
      'The compiler must accept only the frozen verbosity names, so the widened union was reverted.',
    );
    b.addFact(decision, 'decision', true);
    b.toolStarted({ command: 'pnpm typecheck', title: 'typecheck rerun' });
    const verified = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(verified, 'verification', true);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: verified.eventId, exitCode: 0 });
  },

  approval: (b) => {
    b.sessionState('thread/started', 'running');
    b.toolStarted({ command: 'pnpm build', title: 'build' });
    const approval = b.approvalRequested(
      'Write access to the narration fixture directory',
      `Build output for ${b.runId} needs to write fixtures/narration/large/reports.`,
    );
    b.addFact(approval, 'decision', true);
    b.agentMessage('Waiting for the approval before continuing.');
    const reportLine = `N02-LOG requested write access to ${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.json`;
    b.artifactChanged(`${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.json`, 'created');
    b.addSample(reportLine);
    b.logLine(reportLine);
    const resolution = b.permissionChanged('granted', `Approved writing reports for ${b.runId}`);
    b.addFact(resolution, 'decision', true);
    const completed = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(completed, 'result', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: completed.eventId, exitCode: 0 });
  },

  'retry-flake': (b) => {
    b.sessionState('thread/started', 'running');
    b.toolStarted({ command: 'pnpm -C packages/narration test', title: 'attempt 1' });
    const first = b.toolCompleted({ output: 'exit code 1', exitCode: 1 });
    b.addFact(first, 'result', true);
    b.logLine(`N02-LOG ${b.runId}-case-3 failed: expected 4 chapters received 3`);
    b.toolStarted({ command: 'pnpm -C packages/narration test', title: 'attempt 2' });
    const second = b.toolCompleted({ output: 'exit code 1', exitCode: 1 });
    b.addFact(second, 'result', true);
    const retryLine = `N02-RETRY ${b.runId} attempt 3 of 3 after two failures in ${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.log`;
    const retry = b.logLine(retryLine);
    b.addRawPath(`${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.log`);
    b.addSample(retryLine);
    b.addFact(retry, 'problem', true, [retry.eventId]);
    b.toolStarted({ command: 'pnpm -C packages/narration test', title: 'attempt 3' });
    const third = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(third, 'result', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: third.eventId, exitCode: 0 });
  },

  'progress-redraw': (b) => {
    b.sessionState('thread/started', 'running');
    b.toolStarted({ command: `node scripts/narration/emit-chapters.mjs --run ${b.runId}`, title: 'emit chapters' });
    for (let step = 0; step < REDRAW_IDENTICAL; step += 1) {
      b.redraw('N02-REDRAW building chapters 37% [====      ]');
    }
    for (let step = 0; step < REDRAW_DISTINCT; step += 1) {
      b.redraw(`N02-REDRAW building chapters ${40 + step * 5}% [======    ]`);
    }
    const wroteLine = `N02-LOG wrote ${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.json`;
    b.artifactChanged(`${WORKSPACE}/fixtures/narration/large/reports/${b.runId}.json`, 'created');
    b.addSample(wroteLine);
    b.logLine(wroteLine);
    const firstMilestone = b.logLine(`N02-MILESTONE emitted 3 of 8 chapters for ${b.runId}`);
    b.addFact(firstMilestone, 'progress', false);
    const secondMilestone = b.logLine(`N02-MILESTONE emitted 8 of 8 chapters for ${b.runId}`);
    b.addFact(secondMilestone, 'progress', false);
    const completed = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(completed, 'result', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: completed.eventId, exitCode: 0 });
  },

  'diff-decision': (b) => {
    const file = `packages/narration/src/formatting/spoken-${b.index % 4}.ts`;
    const path = `${WORKSPACE}/${file}`;
    const hunkLine = `N02-DIFF @@ ${file} +41 -7: urls render as their site label, paths as their basename`;
    b.sessionState('thread/started', 'running');
    b.toolStarted({ command: `git diff -- ${file}`, title: 'inspect diff' });
    const changed = b.artifactChanged(path, 'modified');
    b.addFact(changed, 'change', false);
    const hunk = b.logLine(hunkLine);
    b.addSample(hunkLine);
    b.addFact(hunk, 'change', true);
    const decision = b.decision(
      'Kept the concise budget as an upper bound',
      `The diff in ${file} only restructures spoken formatting; no verbosity budget changed.`,
    );
    b.addFact(decision, 'decision', true);
    b.logLine(`N02-LOG verified ${b.runId} diff applies cleanly`);
    const completed = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(completed, 'result', false);
    const summary = b.logLine('N02-SUMMARY 8 of 8 narration checks passed');
    b.addFact(summary, 'verification', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: completed.eventId, exitCode: 0 });
  },

  'url-code': (b) => {
    const path = `${WORKSPACE}/packages/narration/src/compiler/index-${b.index % 6}.ts`;
    const url = `https://docs.example.com/narration/verbosity#budgets-${b.index % 4}`;
    const code = `compileNarration({ verbosity: 'thorough', run: '${b.runId}' })`;
    const lines = rawBlockLines(b, path, url, code);
    b.sessionState('thread/started', 'running');
    b.toolStarted({ command: `node fixtures/narration/large/check-corpus.mjs --inspect ${b.runId}`, title: 'inspect raw stream' });
    const events = lines.map((line, lineIndex) => b.logLine(line, lineIndex % 3 === 0 ? 'stderr' : 'stdout'));
    b.addRawPath(path);
    b.addRawUrl(url);
    b.addRawCode(code);
    b.addSample(lines[0]);
    b.addSample(lines[1]);
    b.addSample(lines[2]);
    b.addFact(events[7], 'progress', false);
    b.addFact(events[13], 'verification', false);
    const completed = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(completed, 'result', false);
    b.sessionState('turn/completed', 'complete');
    b.finalize({
      receiptEventId: completed.eventId,
      exitCode: 0,
      exactReading: { text: lines.join('\n') },
    });
  },

  'mixed-long': (b) => {
    const file = `packages/narration/src/compiler/mixed-${b.index % 3}.ts`;
    const path = `${WORKSPACE}/${file}`;
    const failureLine = `N02-LOG FAIL ${b.runId}-case-1 failed: expected 6 segments received 1`;
    b.sessionState('thread/started', 'running');
    b.agentMessage(`Working on ${file} for ${b.runId}.`);
    b.toolStarted({ command: `node --test packages/narration/src/compiler/n02.test.ts`, title: 'run compiler checks' });
    const progress = b.logLine(`N02-PROGRESS ${b.runId} loaded 42 chapters from the raw stream`);
    b.addFact(progress, 'progress', false);
    const failure = b.logLine(failureLine, 'stderr');
    b.addSample(failureLine);
    b.addFact(failure, 'problem', true);
    const failed = b.toolCompleted({ output: 'exit code 1', exitCode: 1 });
    b.addFact(failed, 'result', true);
    const changed = b.artifactChanged(path, 'modified');
    b.addFact(changed, 'change', true);
    const decision = b.decision(
      'Split the exact reading into bounded segments',
      'A long exact request must not become one unbounded utterance, so the text is chunked at word boundaries.',
    );
    b.addFact(decision, 'decision', true);
    const phrase = 'Every narration check passed with no failures';
    const claim = b.agentMessage(phrase);
    b.labels.falseSuccessClaim = { eventId: claim.eventId, phrase };
    b.addFact(claim, 'verification', false);
    b.toolStarted({ command: `node --test packages/narration/src/compiler/n02.test.ts`, title: 'rerun compiler checks' });
    const verified = b.toolCompleted({ output: 'exit code 0', exitCode: 0 });
    b.addFact(verified, 'verification', true);
    b.sessionState('turn/completed', 'complete');
    b.finalize({ receiptEventId: verified.eventId, exitCode: 0 });
  },
};

function materializeRun(index, archetype) {
  const builder = createBuilder(index, archetype);
  const build = ARCHETYPE_BUILDERS[archetype];
  if (build === undefined) throw new Error(`Unknown N02 archetype ${archetype}`);
  build(builder);
  const { runId, sessionId, taskId, events, payloads, labels, facts } = builder;
  return { runId, sessionId, taskId, archetype, events, payloads, labels: { ...labels, facts } };
}

export function buildCorpus() {
  const names = schedule();
  const runs = names.map((name, index) => materializeRun(index, name));
  return {
    contractVersion: CORPUS_CONTRACT_VERSION,
    fixtureId: CORPUS_FIXTURE_ID,
    consent: CORPUS_CONSENT,
    seed: CORPUS_SEED,
    runCount: CORPUS_RUN_COUNT,
    runs,
  };
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort()) ordered[key] = canonicalize(value[key]);
    return ordered;
  }
  return value;
}

export function corpusDigest(document) {
  const { digest, ...rest } = document;
  return `sha256:${sha256(JSON.stringify(canonicalize(rest)))}`;
}

export function validateCorpus(document) {
  const problems = [];
  if (document.contractVersion !== CORPUS_CONTRACT_VERSION) problems.push('contractVersion must be 1');
  if (document.fixtureId !== CORPUS_FIXTURE_ID) problems.push(`fixtureId must be ${CORPUS_FIXTURE_ID}`);
  if (document.consent !== CORPUS_CONSENT) problems.push(`consent must be ${CORPUS_CONSENT}`);
  if (document.runs.length !== CORPUS_RUN_COUNT) problems.push(`expected ${CORPUS_RUN_COUNT} runs, found ${document.runs.length}`);

  const runIds = new Set();
  const eventIds = new Set();
  let facts = 0;
  let criticalFacts = 0;
  let unsupportedFacts = 0;
  let exactReadingRuns = 0;
  let falseClaimRuns = 0;
  let redrawRuns = 0;

  for (const run of document.runs) {
    if (runIds.has(run.runId)) problems.push(`duplicate run ${run.runId}`);
    runIds.add(run.runId);
    if (run.events.length < 6) problems.push(`${run.runId} must carry at least six events`);

    const kindById = new Map();
    const lineTexts = [];
    const payloadTexts = [];
    for (const event of run.events) {
      if (eventIds.has(event.eventId)) problems.push(`duplicate event ${event.eventId}`);
      eventIds.add(event.eventId);
      kindById.set(event.eventId, event.kind);
      if (!(event.payloadRef in run.payloads)) problems.push(`${event.eventId} has no payload`);
      const payload = run.payloads[event.payloadRef];
      for (const value of Object.values(payload)) {
        if (typeof value === 'string') payloadTexts.push(value);
      }
      if (event.kind === 'unsupported' && event.unsupportedKind === 'log_line') {
        if (typeof payload.line !== 'string' || payload.line.length === 0) problems.push(`${event.eventId} log line is empty`);
        else lineTexts.push(payload.line);
      }
    }

    const receipts = run.events.filter((event) => event.kind === 'tool_completed');
    if (receipts.length === 0) problems.push(`${run.runId} has no observed tool_completed receipt`);
    const finalReceipt = receipts.at(-1);
    if (finalReceipt === undefined || run.labels.finalReceiptEventId !== finalReceipt.eventId) {
      problems.push(`${run.runId} finalReceiptEventId must be the last tool_completed event`);
    }
    if (finalReceipt !== undefined) {
      const payload = run.payloads[finalReceipt.payloadRef];
      if (payload.exitCode !== run.labels.finalExitCode) problems.push(`${run.runId} finalExitCode must match its receipt`);
    }

    if (run.labels.facts.length === 0) problems.push(`${run.runId} has no facts`);
    for (const fact of run.labels.facts) {
      facts += 1;
      if (fact.critical) criticalFacts += 1;
      if (!fact.supported) unsupportedFacts += 1;
      if (fact.evidenceEventIds.length === 0) problems.push(`${fact.id} has no evidence events`);
      for (const id of fact.evidenceEventIds) {
        if (!kindById.has(id)) problems.push(`${fact.id} cites unknown event ${id}`);
      }
      const observed = fact.evidenceEventIds.some((id) => kindById.get(id) !== 'agent_message');
      if (fact.supported && !observed) problems.push(`${fact.id} claims support without an observed event`);
      if (!fact.supported && fact.evidenceEventIds.some((id) => kindById.get(id) !== 'agent_message')) {
        problems.push(`${fact.id} is unsupported but cites an observed event`);
      }
    }

    const streamText = lineTexts.join('\n');
    const payloadText = payloadTexts.join('\n');
    const { paths, urls, code } = run.labels.rawDetail;
    if (paths.length + urls.length + code.length === 0) problems.push(`${run.runId} must record raw detail`);
    for (const token of [...paths, ...urls, ...code]) {
      if (!payloadText.includes(token)) problems.push(`${run.runId} raw token ${token} is not in its stream`);
    }
    if (run.labels.formattingSamples.length === 0) problems.push(`${run.runId} has no formatting samples`);
    for (const sample of run.labels.formattingSamples) {
      if (!streamText.includes(sample)) problems.push(`${run.runId} formatting sample is not in its stream`);
    }

    if (run.labels.exactReading !== null) {
      exactReadingRuns += 1;
      const text = run.labels.exactReading.text;
      if (wordCount(text) < 200) problems.push(`${run.runId} exact reading must exceed 200 words`);
      for (const line of text.split('\n')) {
        if (!lineTexts.includes(line)) problems.push(`${run.runId} exact reading line is not in its stream`);
      }
    }
    if (run.labels.falseSuccessClaim !== null) {
      falseClaimRuns += 1;
      const failing = receipts.some((event) => run.payloads[event.payloadRef].exitCode !== 0);
      if (!failing) problems.push(`${run.runId} false claim needs a failing receipt in the same stream`);
      if (!kindById.has(run.labels.falseSuccessClaim.eventId)) problems.push(`${run.runId} false claim cites an unknown event`);
    }
    if (run.labels.duplicateRedraws > 0) redrawRuns += 1;
  }

  if (exactReadingRuns < 10) problems.push(`expected at least 10 exact-reading runs, found ${exactReadingRuns}`);
  if (falseClaimRuns < 30) problems.push(`expected at least 30 false-claim runs, found ${falseClaimRuns}`);
  if (redrawRuns < 10) problems.push(`expected at least 10 redraw-heavy runs, found ${redrawRuns}`);
  if (criticalFacts < 200) problems.push(`expected at least 200 critical facts, found ${criticalFacts}`);

  return { problems, stats: { runs: document.runs.length, events: eventIds.size, facts, criticalFacts, unsupportedFacts, exactReadingRuns, falseClaimRuns, redrawRuns } };
}

export function loadCorpus() {
  const document = buildCorpus();
  const digest = corpusDigest(document);
  return { ...document, digest };
}

function summarize(document, stats) {
  const archetypes = new Map();
  for (const run of document.runs) archetypes.set(run.archetype, (archetypes.get(run.archetype) ?? 0) + 1);
  const lines = [
    `n02 large corpus: ${stats.runs} runs, ${stats.events} events, ${stats.facts} facts (${stats.criticalFacts} critical, ${stats.unsupportedFacts} unsupported)`,
    `exact-reading runs: ${stats.exactReadingRuns}; false-claim runs: ${stats.falseClaimRuns}; redraw-heavy runs: ${stats.redrawRuns}`,
    `archetypes: ${[...archetypes.entries()].map(([name, count]) => `${name} ${count}`).join(', ')}`,
    `digest: ${document.digest}`,
  ];
  return lines.join('\n');
}

export function runCli(args) {
  const document = loadCorpus();
  const { problems, stats } = validateCorpus(document);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...document, stats })}\n`);
  } else {
    process.stdout.write(`${summarize(document, stats)}\n`);
    if (problems.length > 0) process.stdout.write(`${problems.map((problem) => `problem: ${problem}`).join('\n')}\n`);
  }
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
