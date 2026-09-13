/**
 * N01 acceptance oracle — agent test result → durable event → concise spoken outcome → replay
 * (IMPLEMENTATION_PLAN.md §7.2 N01; §5.3 EventEnvelope/SpeechPlan/SpeechLease, §5.7 narration stages).
 *
 * `packages/narration/src/index.ts` must export (this file freezes these names; they are the N01
 * seam between normalized managed-session events and the shared speech-lease contract):
 *
 *   createNarrationTracer({ attention, voice, now }) → NarrationTracer
 *
 *     attention — the shared speech-lease granter (§5.7: only attention grants proactive speech):
 *       requestSpeech(eventId, expiresAt) → SpeechLease | null
 *         The tracer must ask for a lease for the outcome it intends to speak. `null` means muted,
 *         unleased or otherwise not allowed: the outcome stays silent and nothing is submitted.
 *
 *     voice — the V02 playback seam (`VoiceSession.submitSpeech`):
 *       submitSpeech(plan, lease) → VoiceOutputEvent[]
 *         `plan` is a §5.3 SpeechPlan. Only a lease this attention module issued may accompany it;
 *         a fabricated, epoch-mismatched or stale lease is never audible.
 *
 *     now — optional deterministic clock (defaults to the system clock).
 *
 *     tracer:
 *       ingest({ event, payload }) → Promise<{ submitted, outcome }>
 *         One normalized §5.3 EventEnvelope plus the payload its payloadRef resolves to, in ingest
 *         order, exactly like the live B flow. `submitted` is true only when that event produced the
 *         turn's completion plan for the voice layer; progress, log lines, user text and agent text
 *         never become one utterance each. `outcome` is the deterministic task status reduced from
 *         tool receipts only — { sessionId, taskId, status: 'passed'|'failed'|'running'|'unknown',
 *         exitCode?, evidenceIds } — and is null until a receipt is known. A nonzero observed exit
 *         code can never be upgraded by later agent text, and a zero exit code can never be
 *         downgraded by it. One completion summary is spoken once, after the turn's last event
 *         (`session_state` payload method 'turn/completed'), never before it.
 *       replay() → Promise<ReadonlyArray<{ planId, segmentId, sessionId, text, evidenceIds }>>
 *         The audible completion outcomes, newest last; each identifies the original session and
 *         the durable evidence it was reduced from. Nothing audible → empty.
 *
 * Deterministic scope: `fixtures/narration/basic/managed-readonly-tests.json` is the normalized
 * journal of a managed read-only Codex app-server session (the pinned `fixtures/harness/codex`
 * shape) that ran the real read-only `fixtures/narration/basic/check-readonly-suite.mjs` as its test
 * command. The oracle executes that command to prove each recorded exit code is a real observed
 * exit code, then drives the narration seam with deterministic attention/voice doubles.
 *
 * Remaining limitation: the journal is a deterministic input, not a live harness process, and
 * microphone, signed helper and TTS voice are out of scope for this tracer. Managed app-server
 * plumbing stays covered by H01's oracle; the shared speech-lease contract is what this oracle pins.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, SpeechLease, SpeechPlan, VoiceOutputEvent } from '../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../fixtures/narration/basic/managed-readonly-tests.json', import.meta.url);
const FIXTURE_SCRIPT = fileURLToPath(new URL('../../../fixtures/narration/basic/check-readonly-suite.mjs', import.meta.url));
/** Deterministic clock after every fixture event, so any lease the tracer requests is still fresh. */
const FIXTURE_NOW = new Date('2026-09-13T09:20:00.000Z');
/** §5.7 Concise budget: 25–50 words per logical update; N01 speaks the concise outcome. */
const CONCISE_MAX_WORDS = 50;
const LOG_PREFIX = 'N01-LOG-';
const PROGRESS_PREFIX = 'N01-PROGRESS';

type NarrationOutcome = Readonly<{
  sessionId: string;
  taskId: string;
  status: 'passed' | 'failed' | 'running' | 'unknown';
  exitCode?: number;
  evidenceIds: ReadonlyArray<string>;
}>;

type NarrationIngestResult = Readonly<{
  submitted: boolean;
  outcome: NarrationOutcome | null;
}>;

type NarrationReplayRecord = Readonly<{
  planId: string;
  segmentId: string;
  sessionId: string;
  text: string;
  evidenceIds: ReadonlyArray<string>;
}>;

type NarrationTracer = Readonly<{
  ingest(input: Readonly<{ event: EventEnvelope; payload: unknown }>): Promise<NarrationIngestResult>;
  replay(): Promise<ReadonlyArray<NarrationReplayRecord>>;
}>;

type NarrationModule = Readonly<{
  createNarrationTracer(options: Readonly<{
    attention: Readonly<{ requestSpeech(eventId: string, expiresAt: string): SpeechLease | null }>;
    voice: Readonly<{
      submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
    }>;
    now?: () => Date;
  }>): NarrationTracer;
}>;

async function loadNarrationModule(): Promise<NarrationModule> {
  const fail = (detail: string): never => assert.fail(
    'N01 required narration behavior is not implemented yet: packages/narration/src/index.ts must '
    + `export createNarrationTracer({ attention, voice, now }) with ingest({ event, payload }) and replay(). ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists the import resolves to
  // nothing, and that is reported below as the missing behavior instead of a resolution crash that
  // hides what the oracle is waiting for.
  const specifier = ['..', 'src', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createNarrationTracer !== 'function') {
    return fail('createNarrationTracer({ attention, voice, now }) is not exported');
  }
  return loaded as unknown as NarrationModule;
}

const narration = await loadNarrationModule();

type FixtureCase = Readonly<{
  id: string;
  exitCode: number;
  sessionId: string;
  taskId: string;
  toolEventId: string;
  claimEventId: string;
  turnEventId: string;
  claimedPassPhrase?: string;
  agentHedgePhrase?: string;
  events: ReadonlyArray<EventEnvelope>;
  payloads: Readonly<Record<string, unknown>>;
}>;

type Fixture = Readonly<{
  contractVersion: number;
  fixtureId: string;
  consent: string;
  cases: ReadonlyArray<FixtureCase>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
assert.equal(fixture.contractVersion, 1, 'the N01 fixture journal must speak contract version 1');
assert.equal(fixture.consent, 'synthetic', 'the N01 fixture journal must be synthetic');

function fixtureCase(id: string): FixtureCase {
  const found = fixture.cases.find((candidate) => candidate.id === id);
  assert.ok(found, `fixture case ${id} is missing`);
  return found;
}

const failingCase = fixtureCase('nonzero-exit');
const cleanCase = fixtureCase('clean-pass');

type AttentionMode = 'grant' | 'muted' | 'expired';

type FakeAttention = Readonly<{
  requests: Array<Readonly<{ eventId: string; expiresAt: string }>>;
  issued: Set<SpeechLease>;
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
}>;

/** The shared attention policy double: it only ever hands out leases it issued itself. */
function fakeAttention(mode: AttentionMode): FakeAttention {
  const requests: Array<Readonly<{ eventId: string; expiresAt: string }>> = [];
  const issued = new Set<SpeechLease>();
  let epoch = 0;
  return {
    requests,
    issued,
    requestSpeech(eventId, expiresAt) {
      requests.push({ eventId, expiresAt });
      if (mode === 'muted') return null;
      epoch += 1;
      const lease: SpeechLease = mode === 'expired'
        ? { eventId, epoch, expiresAt: new Date(FIXTURE_NOW.getTime() - 1_000).toISOString() }
        : { eventId, epoch, expiresAt };
      issued.add(lease);
      return lease;
    },
  };
}

type VoiceSubmission = Readonly<{
  plan: SpeechPlan;
  lease: SpeechLease;
  approved: boolean;
  reason: string | null;
}>;

type AudibleSegment = Readonly<{
  planId: string;
  segmentId: string;
  sessionId: string;
  text: string;
  evidenceIds: ReadonlyArray<string>;
}>;

type FakeVoice = Readonly<{
  submissions: Array<VoiceSubmission>;
  audible: Array<AudibleSegment>;
  violations: Array<string>;
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;

/** The V02 boundary double: unleased, epoch-mismatched and stale plans stay silent. */
function fakeVoice(attention: FakeAttention, now: () => Date): FakeVoice {
  const submissions: Array<VoiceSubmission> = [];
  const audible: Array<AudibleSegment> = [];
  const violations: Array<string> = [];
  return {
    submissions,
    audible,
    violations,
    async submitSpeech(plan, lease) {
      if (!attention.issued.has(lease)) {
        violations.push(`plan ${plan.planId} was submitted with a lease attention never issued`);
        return [];
      }
      const nowMs = now().getTime();
      const reasons: Array<string> = [];
      if (lease.epoch !== plan.epoch) reasons.push('lease epoch does not match the plan epoch');
      if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= nowMs) {
        reasons.push('lease expired');
      }
      if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= nowMs) {
        reasons.push('plan expired');
      }
      const approved = reasons.length === 0;
      submissions.push({ plan, lease, approved, reason: approved ? null : reasons.join('; ') });
      if (!approved) return [];
      const events: Array<VoiceOutputEvent> = [];
      for (const segment of plan.segments) {
        audible.push({
          planId: plan.planId,
          segmentId: segment.id,
          sessionId: plan.sessionId ?? '',
          text: segment.text,
          evidenceIds: segment.evidenceIds,
        });
        events.push({
          planId: plan.planId,
          segmentId: segment.id,
          positionMs: Math.round(segment.maxSeconds * 1_000),
          status: 'completed',
        });
      }
      return events;
    },
  };
}

type ScenarioRun = Readonly<{
  fixtureCase: FixtureCase;
  attention: FakeAttention;
  voice: FakeVoice;
  results: ReadonlyArray<NarrationIngestResult>;
  replay: ReadonlyArray<NarrationReplayRecord>;
  /** Submissions that happened before the turn's last event — one-per-log-line narration shows up here. */
  earlySubmissions: number;
}>;

async function runScenario(fixtureCaseToRun: FixtureCase, mode: AttentionMode): Promise<ScenarioRun> {
  const attention = fakeAttention(mode);
  const now = (): Date => FIXTURE_NOW;
  const voice = fakeVoice(attention, now);
  const tracer = narration.createNarrationTracer({ attention, voice, now });
  const results: Array<NarrationIngestResult> = [];
  let earlySubmissions = 0;
  for (const event of fixtureCaseToRun.events) {
    assert.ok(
      Object.hasOwn(fixtureCaseToRun.payloads, event.payloadRef),
      `fixture payload missing for ${event.payloadRef}`,
    );
    const before = voice.submissions.length;
    results.push(await tracer.ingest({ event, payload: fixtureCaseToRun.payloads[event.payloadRef] }));
    if (event.eventId !== fixtureCaseToRun.turnEventId && voice.submissions.length > before) {
      earlySubmissions += 1;
    }
  }
  const replay = await tracer.replay();
  return { fixtureCase: fixtureCaseToRun, attention, voice, results, replay, earlySubmissions };
}

function spokenPlan(run: ScenarioRun): SpeechPlan {
  const submission = run.voice.submissions[0];
  assert.ok(submission, 'the turn outcome must reach the shared voice layer as one SpeechPlan');
  return submission.plan;
}

function spokenText(run: ScenarioRun): string {
  return run.voice.audible.map((segment) => segment.text).join(' ').trim();
}

function finalOutcome(run: ScenarioRun): NarrationOutcome {
  const outcome = run.results.at(-1)?.outcome ?? null;
  assert.ok(outcome, 'a tool receipt must produce a deterministic narration outcome');
  return outcome;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
}

function runFixtureScript(clean: boolean): Readonly<{ status: number | null; stdout: string }> {
  const args = [FIXTURE_SCRIPT, '--read-only', ...(clean ? ['--clean'] : [])];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, `read-only fixture suite failed to run: ${String(result.error)}`);
  assert.ok(typeof result.status === 'number', 'read-only fixture suite must exit normally');
  return { status: result.status ?? null, stdout: result.stdout };
}

test('N01: the recorded nonzero exit code is a real observed read-only fixture exit code', () => {
  const failing = runFixtureScript(false);
  assert.equal(failing.status, failingCase.exitCode, 'the journal must record the fixture suite real failing exit code');
  assert.match(failing.stdout, /N01-LOG-0022 not ok 22 /, 'the journal log lines must come from the real fixture output');

  const clean = runFixtureScript(true);
  assert.equal(clean.status, cleanCase.exitCode, 'the journal must record the fixture suite real clean exit code');
  assert.doesNotMatch(clean.stdout, /not ok/, 'the clean run must not report a failing check');
});

test('N01: one managed read-only fixture produces one concise spoken outcome, not one per log line', async () => {
  const run = await runScenario(failingCase, 'grant');
  assert.deepEqual(run.voice.violations, [], 'only attention-issued leases may reach the shared voice layer');
  assert.equal(run.earlySubmissions, 0, 'no completion summary may be spoken before the turn ends');
  assert.equal(
    run.voice.submissions.length,
    1,
    `expected exactly one completion SpeechPlan for the whole turn, got ${run.voice.submissions.length}`,
  );
  assert.equal(
    run.results.filter((result) => result.submitted).length,
    1,
    'exactly one ingest call may submit speech',
  );
  const plan = spokenPlan(run);
  assert.equal(plan.priority, 'completion');
  assert.equal(plan.sessionId, failingCase.sessionId, 'the spoken plan must name its session');
  assert.ok(plan.dedupeKey.length > 0, 'a completion plan needs a dedupe key');
  assert.equal(plan.segments.length, 1, 'one completion outcome is one segment');
  const segment = plan.segments[0]!;
  assert.ok(segment.text.trim().length > 0, 'the completion outcome must have spoken text');
  assert.ok(
    wordCount(segment.text) <= CONCISE_MAX_WORDS,
    `the concise outcome must stay within ${CONCISE_MAX_WORDS} words, got: ${segment.text}`,
  );
  assert.ok(!segment.text.includes(LOG_PREFIX), 'stdout log lines must not be recited');
  assert.ok(!segment.text.includes(PROGRESS_PREFIX), 'progress chatter must not be recited');
  assert.ok(segment.maxSeconds > 0, 'a spoken segment needs a positive time budget');
  assert.ok(segment.evidenceIds.includes(failingCase.toolEventId), 'the outcome must cite the observed receipt');
  const eventIds = new Set(failingCase.events.map((event) => event.eventId));
  for (const evidenceId of segment.evidenceIds) {
    assert.ok(eventIds.has(evidenceId), `evidence ${evidenceId} must be a durable event of this session`);
  }
  assert.equal(run.voice.audible.length, 1, 'exactly one completion outcome may become audible');
});

test('N01: agent text claiming success cannot override a nonzero observed exit code', async () => {
  const run = await runScenario(failingCase, 'grant');
  const outcome = finalOutcome(run);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.sessionId, failingCase.sessionId);
  assert.equal(outcome.taskId, failingCase.taskId);
  assert.ok(outcome.evidenceIds.includes(failingCase.toolEventId), 'the failure must cite the observed exit code');
  assert.ok(!outcome.evidenceIds.includes(failingCase.claimEventId), 'agent text is never task evidence');

  const claim = failingCase.claimedPassPhrase;
  assert.ok(claim, 'the failing fixture must carry the agent success claim');
  const text = spokenText(run);
  assert.ok(text.length > 0, 'the failure outcome must be spoken');
  assert.ok(!text.includes(claim), `the spoken outcome must not repeat the agent claim: ${text}`);
  assert.match(text, /fail|exit code 1|exit 1|nonzero/i, `the spoken outcome must convey the observed failure: ${text}`);
});

test('N01: a clean zero exit code is narrated as the observed pass, not the agent hedge', async () => {
  const run = await runScenario(cleanCase, 'grant');
  assert.deepEqual(run.voice.violations, []);
  assert.equal(run.voice.submissions.length, 1, 'a finished clean turn is one spoken outcome');
  const outcome = finalOutcome(run);
  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, cleanCase.sessionId);
  assert.ok(outcome.evidenceIds.includes(cleanCase.toolEventId));

  const hedge = cleanCase.agentHedgePhrase;
  assert.ok(hedge, 'the clean fixture must carry the agent hedge');
  const text = spokenText(run);
  assert.ok(!text.includes(hedge), `the spoken outcome must not repeat the agent hedge: ${text}`);
  assert.match(text, /pass|green|clean|exit code 0|exit 0|no failures/i, `the spoken outcome must convey the observed pass: ${text}`);
});

test('N01: muted or unleased output stays silent', async () => {
  const muted = await runScenario(failingCase, 'muted');
  assert.ok(muted.attention.requests.length > 0, 'narration must ask the shared policy before speaking');
  assert.deepEqual(muted.voice.violations, []);
  assert.equal(muted.voice.submissions.length, 0, 'no lease means nothing may be submitted to the voice layer');
  assert.equal(muted.results.filter((result) => result.submitted).length, 0);
  assert.deepEqual([...muted.replay], [], 'nothing audible means nothing to replay');

  const expired = await runScenario(failingCase, 'expired');
  assert.deepEqual(expired.voice.violations, []);
  assert.equal(expired.voice.audible.length, 0, 'a stale lease must never become audible');
  assert.equal(expired.voice.submissions.filter((submission) => submission.approved).length, 0);
  assert.deepEqual([...expired.replay], [], 'a stale lease leaves nothing to replay');
});

test('N01: replay identifies the original evidence and session', async () => {
  const run = await runScenario(failingCase, 'grant');
  const submission = run.voice.submissions[0];
  assert.ok(submission, 'the audible outcome must have been submitted');
  assert.equal(run.replay.length, 1, 'the audible completion outcome must be replayable');
  const record = run.replay[0]!;
  assert.equal(record.planId, submission.plan.planId);
  assert.equal(record.segmentId, submission.plan.segments[0]!.id);
  assert.equal(record.sessionId, failingCase.sessionId, 'replay must identify the original session');
  assert.equal(record.text, spokenText(run));
  assert.ok(record.evidenceIds.includes(failingCase.toolEventId), 'replay must identify the original evidence');
  const eventIds = new Set(failingCase.events.map((event) => event.eventId));
  for (const evidenceId of record.evidenceIds) {
    assert.ok(eventIds.has(evidenceId), `replay evidence ${evidenceId} must be a durable event of this session`);
  }
});
