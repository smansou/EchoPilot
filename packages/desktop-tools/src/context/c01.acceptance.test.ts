/**
 * C01 acceptance oracle — desktop "what is this?" → scoped screen/context → grounded spoken
 * explanation (IMPLEMENTATION_PLAN.md §7.2 C01; §5.4 C flow; §5.3 Memory/Reasoner/Attention/
 * VoiceSession, SpeechPlan/SpeechLease).
 *
 * `packages/desktop-tools/src/context/index.ts` must export (this file freezes these names; they
 * are the frozen C01 seam between the widget conversation and permitted desktop windows):
 *
 *   createDesktopContextService({ bridge, memory, reasoner, attention, voice, now, scope,
 *   excludedBundleIds }) → DesktopContextService
 *
 *     bridge — the C01 native boundary (§5.4 "capture permitted foreground state"):
 *       foregroundApp() → { bundleId, name, windowTitle } | null
 *         The permitted app in front right now. A desktop question is never captured without one.
 *       captureQuestionContext({ app, question }) → CaptureOutcome
 *         Raw AX/OCR producer for exactly one question:
 *           { status: 'captured', snapshot: { snapshotId, capturedAtMs, screenshotRef, quality,
 *             truncated, axNodes: [{ role, value }], ocrSpans: [{ text }] } }
 *           { status: 'unavailable', reason: 'accessibility_denied' | 'screen_recording_denied'
 *             | 'no_window' }
 *         The bridge is a raw producer: it would happily hand back an excluded app's content, so
 *         the service decides before calling it (acceptance: "Excluded apps are not captured").
 *
 *     memory — §5.3 `Memory.query(search, scope, budget) → EvidenceBundle`. The search combines the
 *       user's question with the captured screen text; it must carry the explicit project scope.
 *       The fixture stores a near-duplicate note from another project that a scope-less,
 *       window-title-similarity query does return (the probe in the browser test proves it), and
 *       `scope.projectId` is the only thing that keeps it out of the bounded context.
 *
 *     reasoner — §5.3 `Reasoner.run(task, boundedContext, outputSchema, abortSignal)`. One grounded
 *       inference per desktop question, with the bounded evidence the service assembled
 *       (desk:ax:<i> / desk:ocr:<i> / scoped memory ids). Every evidence id the returned answer
 *       cites that the bounded context does not contain is dropped before the answer is spoken.
 *
 *     attention — §5.3 `Attention.requestSpeech(eventId, expiresAt) → SpeechLease | null`, the only
 *       granter of speech; `null` (muted/silent) means the answer stays visible-only.
 *     voice — the §5.3 `VoiceSession.submitSpeech(plan, lease)` playback seam; one SpeechPlan per
 *       spoken answer, submitted only with the lease attention issued for it.
 *     now — deterministic clock; every timestamp the service writes comes from it.
 *     scope — the explicit project association, e.g.
 *       { profileId: 'profile-c01', projectId: 'atlas', sensitivity: 'normal' }.
 *     excludedBundleIds — apps whose content is never captured, never queried, never reasoned over.
 *
 *     service:
 *       answer({ question, surface: 'widget' }) → Promise<DesktopAnswer>
 *         DesktopAnswer = {
 *           question, surface: 'widget',
 *           text, evidenceIds: string[],
 *           capture: { state: 'captured' | 'limited' | 'excluded', app: string,
 *                      reason?: 'accessibility_denied' | 'screen_recording_denied' | 'no_window'
 *                             | 'empty_context' },
 *           spoken: boolean,
 *         }
 *         `surface` is the widget conversation: the ticket's path answers there, without Mission
 *         Control. `capture` plus `evidenceIds` are the data behind the capture/evidence indicator.
 *
 * Deterministic rules pinned here (BACKLOG.json C01 acceptance criteria):
 *   1. Browser error and IDE control questions answer end to end on the widget surface: one
 *      foreground resolution, exactly one capture per question, one scoped memory query, one
 *      reasoner call whose bounded context carries the captured AX/OCR text and the in-project
 *      memory, and one spoken answer authorized by a live lease of at most 30 s. `text` is the
 *      reasoner's answer; invented evidence ids never survive.
 *   2. An excluded app is refused before the bridge is asked: zero capture calls, zero memory
 *      queries, zero reasoner calls, and no captured content anywhere in the answer.
 *   3. Unrelated project memory never enters the bounded context: a scope-less similarity query
 *      against the fixture store demonstrably returns the other project's note, while every query
 *      the service issues carries the explicit project scope.
 *   4. Missing AX/pixels — capture unavailable, or a snapshot with no non-blank AX value, no OCR
 *      text and no screenshot — yields the fixture's deterministic limited-context sentence for
 *      that reason, names the app, asserts no control state, and is produced without calling the
 *      reasoner or memory. Hallucinated control state can never be spoken.
 *   5. Evidence ids are derived, not invented: axNodes[i].value → 'desk:ax:<i>' and
 *      ocrSpans[i].text → 'desk:ocr:<i>' for each non-blank entry, using the original index;
 *      scoped memory ids pass through unchanged. The screenshot artifact is captured (fixture
 *      `screenshotRef`) but is not an evidence id in this tracer.
 *   6. Muting silences the answer without replacing it or bypassing attention, and the same
 *      question replays to the same answer under the injected clock.
 *
 * Remaining limitation: this oracle pins the TypeScript seam with deterministic doubles. Real AX
 * traversal, ScreenCaptureKit pixels, macOS permission prompts, and the rendered widget
 * capture/evidence indicator need the signed helper and a manual qualification pass; the fixture
 * is fully synthetic (no real screen content, credential, or screenshot).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  Attention,
  BoundedContext,
  EvidenceBundle,
  Memory,
  Reasoner,
  ReasoningTask,
  Scope,
  SpeechLease,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/desktop/questions/c01-questions.json', import.meta.url);
/** Deterministic injected clock: every timestamp the service writes comes from it. */
const NOW = '2026-09-21T10:00:00.000Z';
/** §5.4 deterministic context budget: the bounded context never exceeds this. */
const MAX_CONTEXT_TOKENS = 8_192;
/** §5.3: a lease expires after its decision and at most 30 s later. */
const MAX_LEASE_MS = 30_000;
const WIDGET_SURFACE = 'widget' as const;
const BROWSER_EVIDENCE = ['desk:ax:0', 'desk:ax:1', 'desk:ocr:0', 'mem-atlas-1'];
const IDE_EVIDENCE = ['desk:ax:0', 'desk:ax:1', 'mem-atlas-2'];

type FixtureAxNode = Readonly<{ role: string; value: string }>;
type FixtureOcrSpan = Readonly<{ text: string }>;
type FixtureCaptureOutcome =
  | Readonly<{
      status: 'captured';
      snapshot: Readonly<{
        snapshotId: string;
        capturedAtMs: number;
        screenshotRef: string | null;
        quality: 'full' | 'partial' | 'unavailable';
        truncated: boolean;
        axNodes: ReadonlyArray<FixtureAxNode>;
        ocrSpans: ReadonlyArray<FixtureOcrSpan>;
      }>;
    }>
  | Readonly<{ status: 'unavailable'; reason: 'accessibility_denied' | 'screen_recording_denied' | 'no_window' }>;
type FixtureMemoryEntry = Readonly<{ id: string; projectId: string; text: string }>;
type FixtureScenario = Readonly<{
  key: string;
  question: string;
  app: Readonly<{ bundleId: string; name: string; windowTitle: string }>;
  captureMustNeverBeRequested?: true;
  leakMarker?: string;
  capture: FixtureCaptureOutcome;
  memory: Readonly<{
    explicitProject: ReadonlyArray<FixtureMemoryEntry>;
    otherProjects: ReadonlyArray<FixtureMemoryEntry>;
  }>;
  reasoner: Readonly<{ answer: string; inventedEvidenceIds: ReadonlyArray<string> }> | null;
}>;
type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string; displayName: string }>;
  excludedBundleIds: ReadonlyArray<string>;
  forbiddenControlStateWords: ReadonlyArray<string>;
  excludedTemplate: string;
  limitedTemplates: Readonly<Record<string, string>>;
  scenarios: ReadonlyArray<FixtureScenario>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

function scenarioByKey(key: string): FixtureScenario {
  const found = fixture.scenarios.find((entry) => entry.key === key);
  assert.ok(found, `fixture ${FIXTURE_URL.pathname} is missing scenario ${key}`);
  return found;
}

function limitedTemplate(reason: string): string {
  const template = fixture.limitedTemplates[reason];
  assert.ok(template, `fixture is missing the ${reason} limited-context template`);
  return template;
}

function renderTemplate(template: string, app: string): string {
  return template.replaceAll('{app}', app);
}

type ForegroundApp = Readonly<{ bundleId: string; name: string; windowTitle: string }>;
type CaptureUnavailableReason = 'accessibility_denied' | 'screen_recording_denied' | 'no_window';
type DesktopCaptureReason = CaptureUnavailableReason | 'empty_context';
type CaptureOutcome =
  | Readonly<{
      status: 'captured';
      snapshot: Readonly<{
        snapshotId: string;
        capturedAtMs: number;
        screenshotRef: string | null;
        quality: 'full' | 'partial' | 'unavailable';
        truncated: boolean;
        axNodes: ReadonlyArray<FixtureAxNode>;
        ocrSpans: ReadonlyArray<FixtureOcrSpan>;
      }>;
    }>
  | Readonly<{ status: 'unavailable'; reason: CaptureUnavailableReason }>;
type DesktopCaptureRequest = Readonly<{ app: ForegroundApp; question: string }>;
type DesktopBridge = Readonly<{
  foregroundApp(): Promise<ForegroundApp | null>;
  captureQuestionContext(request: DesktopCaptureRequest): Promise<CaptureOutcome>;
}>;
/** The §5.3 VoiceSession playback seam; only submitSpeech is exercised by this tracer. */
type DesktopVoice = Readonly<{
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;
type DesktopAnswer = Readonly<{
  question: string;
  surface: 'widget';
  text: string;
  evidenceIds: ReadonlyArray<string>;
  capture: Readonly<{ state: 'captured' | 'limited' | 'excluded'; app: string; reason?: DesktopCaptureReason }>;
  spoken: boolean;
}>;
type DesktopContextService = Readonly<{
  answer(input: Readonly<{ question: string; surface: 'widget' }>): Promise<DesktopAnswer>;
}>;
type DesktopContextOptions = Readonly<{
  bridge: DesktopBridge;
  memory: Memory;
  reasoner: Reasoner;
  attention: Attention;
  voice: DesktopVoice;
  now: () => Date;
  scope: Scope;
  excludedBundleIds: ReadonlyArray<string>;
}>;
type DesktopContextModule = Readonly<{
  createDesktopContextService(options: DesktopContextOptions): DesktopContextService;
}>;

const MISSING_BEHAVIOR = 'C01 required desktop context behavior is not implemented yet: '
  + 'packages/desktop-tools/src/context/index.ts must export createDesktopContextService({ bridge, '
  + 'memory, reasoner, attention, voice, now, scope, excludedBundleIds }) returning '
  + 'answer({ question, surface }) → Promise<DesktopAnswer> over the frozen desktop-question seam.';

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): DesktopContextModule {
  return {
    createDesktopContextService(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadDesktopContextModule(): Promise<DesktopContextModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createDesktopContextService !== 'function') {
    return missingModule('createDesktopContextService is not exported');
  }
  return loaded as unknown as DesktopContextModule;
}

const desktopContext = await loadDesktopContextModule();

function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function overlaps(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function memoryEntries(scenario: FixtureScenario): ReadonlyArray<FixtureMemoryEntry> {
  return [...scenario.memory.explicitProject, ...scenario.memory.otherProjects];
}

type MemoryQuery = Readonly<{ search: string; scope: Scope; budget: number }>;
type FakeMemory = Memory & Readonly<{ queries: Array<MemoryQuery> }>;

/** The fixture store matches on token overlap and only the explicit project scope separates the
 * near-duplicate notes, so a scope-less query is exactly the leak the acceptance criterion names. */
function fakeMemory(entries: ReadonlyArray<FixtureMemoryEntry>): FakeMemory {
  const queries: Array<MemoryQuery> = [];
  return {
    queries,
    async ingest(): Promise<never> {
      throw new Error('C01 oracle: memory.ingest is not part of the desktop question path');
    },
    async query(search: string, scope: Scope, budget: number): Promise<EvidenceBundle> {
      queries.push({ search, scope, budget });
      const searchTokens = tokenize(search);
      const matches = entries
        .filter((entry) => (scope.projectId === undefined ? true : entry.projectId === scope.projectId))
        .filter((entry) => overlaps(tokenize(entry.text), searchTokens));
      const selected = matches.slice(0, Math.max(0, budget));
      return {
        evidenceIds: selected.map((entry) => entry.id),
        summary: selected.map((entry) => entry.text).join(' '),
      };
    },
    async consolidate(): Promise<never> {
      throw new Error('C01 oracle: memory.consolidate is not part of the desktop question path');
    },
    async forget(): Promise<never> {
      throw new Error('C01 oracle: memory.forget is not part of the desktop question path');
    },
  };
}

type ReasonerCall = Readonly<{
  task: ReasoningTask;
  context: BoundedContext;
  outputSchema: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}>;
type FakeReasoner = Reasoner & Readonly<{ calls: Array<ReasonerCall> }>;

function fakeReasoner(scenario: FixtureScenario): FakeReasoner {
  const calls: Array<ReasonerCall> = [];
  return {
    calls,
    async run(
      task: ReasoningTask,
      context: BoundedContext,
      outputSchema: Readonly<Record<string, unknown>>,
      abortSignal: AbortSignal,
    ): Promise<unknown> {
      calls.push({ task, context, outputSchema, signal: abortSignal });
      const script = scenario.reasoner;
      if (script === null) throw new Error(`C01 oracle: scenario ${scenario.key} must not reach the reasoner`);
      return { text: script.answer, evidenceIds: [...context.evidenceIds, ...script.inventedEvidenceIds] };
    },
  };
}

type FakeAttention = Attention & Readonly<{
  requests: Array<Readonly<{ eventId: string; expiresAt: string }>>;
  issued: Set<SpeechLease>;
  muted: boolean;
}>;

function fakeAttention(muted: boolean): FakeAttention {
  const requests: Array<Readonly<{ eventId: string; expiresAt: string }>> = [];
  const issued = new Set<SpeechLease>();
  let epoch = 0;
  return {
    requests,
    issued,
    muted,
    requestSpeech(eventId: string, expiresAt: string): SpeechLease | null {
      requests.push({ eventId, expiresAt });
      if (muted) return null;
      epoch += 1;
      const lease: SpeechLease = { eventId, epoch, expiresAt };
      issued.add(lease);
      return lease;
    },
    canSpeak(lease: SpeechLease): boolean {
      return issued.has(lease);
    },
    revokeSpeech(): void {
      issued.clear();
    },
  };
}

type VoiceSubmission = Readonly<{ plan: SpeechPlan; lease: SpeechLease; authorized: boolean }>;
type FakeVoice = DesktopVoice & Readonly<{
  submissions: Array<VoiceSubmission>;
  audible: Array<Readonly<{ text: string; evidenceIds: ReadonlyArray<string> }>>;
}>;

/** The §5.3 boundary double: unleased or muted plans are never audible. */
function fakeVoice(attention: FakeAttention): FakeVoice {
  const submissions: Array<VoiceSubmission> = [];
  const audible: Array<Readonly<{ text: string; evidenceIds: ReadonlyArray<string> }>> = [];
  return {
    submissions,
    audible,
    async submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>> {
      const authorized = attention.canSpeak(lease) && !attention.muted;
      submissions.push({ plan, lease, authorized });
      if (!authorized) return [];
      for (const segment of plan.segments) {
        audible.push({ text: segment.text, evidenceIds: segment.evidenceIds });
      }
      return plan.segments.map((segment) => ({
        planId: plan.planId,
        segmentId: segment.id,
        positionMs: 0,
        status: 'started' as const,
      }));
    },
  };
}

type Harness = Readonly<{
  scenario: FixtureScenario;
  bridge: Readonly<{
    calls: { foreground: number; capture: Array<DesktopCaptureRequest> };
    foregroundApp(): Promise<ForegroundApp | null>;
    captureQuestionContext(request: DesktopCaptureRequest): Promise<CaptureOutcome>;
  }>;
  memory: FakeMemory;
  reasoner: FakeReasoner;
  attention: FakeAttention;
  voice: FakeVoice;
  service: DesktopContextService;
  ask(): Promise<DesktopAnswer>;
}>;

function harness(key: string, options: Readonly<{ muted?: boolean }> = {}): Harness {
  const scenario = scenarioByKey(key);
  const calls = { foreground: 0, capture: [] as Array<DesktopCaptureRequest> };
  const bridge = {
    calls,
    async foregroundApp(): Promise<ForegroundApp | null> {
      calls.foreground += 1;
      return scenario.app;
    },
    async captureQuestionContext(request: DesktopCaptureRequest): Promise<CaptureOutcome> {
      calls.capture.push(request);
      return scenario.capture;
    },
  };
  const memory = fakeMemory(memoryEntries(scenario));
  const reasoner = fakeReasoner(scenario);
  const attention = fakeAttention(options.muted === true);
  const voice = fakeVoice(attention);
  const scope: Scope = {
    profileId: fixture.profileId,
    projectId: fixture.project.projectId,
    sensitivity: 'normal',
  };
  const service = desktopContext.createDesktopContextService({
    bridge,
    memory,
    reasoner,
    attention,
    voice,
    now: () => new Date(NOW),
    scope,
    excludedBundleIds: fixture.excludedBundleIds,
  });
  return {
    scenario,
    bridge,
    memory,
    reasoner,
    attention,
    voice,
    service,
    ask: () => service.answer({ question: scenario.question, surface: WIDGET_SURFACE }),
  };
}

function sorted(ids: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function singleSubmission(run: Harness): VoiceSubmission {
  assert.equal(run.voice.submissions.length, 1, 'a spoken answer is submitted to voice exactly once');
  const submission = run.voice.submissions[0];
  assert.ok(submission, 'the voice submission must exist');
  assert.equal(submission.authorized, true, 'the voice layer only plays a live attention lease');
  return submission;
}

function assertSpokenSeam(run: Harness, answer: DesktopAnswer): void {
  assert.equal(answer.spoken, true, 'the grounded answer is spoken');
  const { plan, lease } = singleSubmission(run);
  assert.equal(run.attention.requests.length, 1, 'the service asks attention exactly once per answer');
  const request = run.attention.requests[0];
  assert.ok(request, 'attention is asked before anything speaks');
  assert.ok(request.eventId.trim().length > 0, 'the speech event has a durable id');
  assert.equal(request.eventId, lease.eventId, 'the lease answers exactly the requested event');
  const nowMs = Date.parse(NOW);
  const expiresMs = Date.parse(request.expiresAt);
  assert.ok(Number.isFinite(expiresMs) && expiresMs > nowMs, 'the requested lease is live');
  assert.ok(expiresMs - nowMs <= MAX_LEASE_MS, 'the lease lasts at most 30 s');
  assert.equal(plan.epoch, lease.epoch, 'the plan runs under the issued lease epoch');
  const planExpiresMs = Date.parse(plan.expiresAt);
  assert.ok(
    Number.isFinite(planExpiresMs) && planExpiresMs > nowMs && planExpiresMs <= expiresMs,
    'the plan expires no later than the lease',
  );
  assert.ok(plan.planId.trim().length > 0, 'the plan has an id');
  assert.ok(plan.segments.length > 0, 'the spoken plan has at least one segment');
  const spokenText = plan.segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(spokenText, answer.text.replace(/\s+/g, ' ').trim(), 'the spoken plan carries exactly the answer text');
  for (const segment of plan.segments) {
    assert.ok(segment.text.trim().length > 0, 'no empty segment is submitted');
    for (const evidenceId of segment.evidenceIds) {
      assert.ok(answer.evidenceIds.includes(evidenceId), `segment cites ${evidenceId}, absent from the answer evidence`);
    }
  }
}

function assertNoControlStateWords(answer: DesktopAnswer): void {
  for (const word of fixture.forbiddenControlStateWords) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, 'i').test(answer.text),
      `a limited-context answer never asserts control state ("${word}")`,
    );
  }
}

test('C01: a browser error asked from the widget is answered from scoped screen and project memory', async () => {
  const run = harness('browser-error');
  const answer = await run.ask();

  assert.equal(answer.surface, WIDGET_SURFACE, 'answered in the widget conversation, never requiring Mission Control');
  assert.equal(answer.question, run.scenario.question);
  assert.equal(answer.capture.state, 'captured');
  assert.equal(answer.capture.app, 'Google Chrome');
  assert.equal(run.bridge.calls.foreground, 1, 'one foreground resolution per question');
  assert.equal(run.bridge.calls.capture.length, 1, 'exactly one capture per question');
  const captureRequest = run.bridge.calls.capture[0];
  assert.ok(captureRequest, 'the capture request must exist');
  assert.equal(captureRequest.question, run.scenario.question);
  assert.deepEqual(captureRequest.app, run.scenario.app, 'the captured app is the resolved foreground app');

  // Scoped memory: every issued query carries the explicit project, and the other project's
  // near-duplicate note is reachable only without it.
  assert.equal(run.memory.queries.length, 1, 'one retrieval per desktop question');
  const query = run.memory.queries[0];
  assert.ok(query, 'the memory query must exist');
  assert.equal(query.scope.projectId, fixture.project.projectId, 'memory is retrieved in the explicit project scope');
  assert.ok(query.budget > 0, 'retrieval carries a positive budget');
  assert.ok(
    !run.memory.queries.some((call) => call.scope.projectId === undefined),
    'the service itself never queries memory without the project scope',
  );
  const probe = await run.memory.query(
    `${run.scenario.app.windowTitle} ${run.scenario.question}`,
    { profileId: fixture.profileId, sensitivity: 'normal' },
    10,
  );
  assert.ok(
    probe.evidenceIds.includes('mem-helios-1'),
    'the trap is observable: a scope-less window-title similarity query would return the other project',
  );

  // Grounded inference: the bounded context holds the captured AX/OCR text and the in-project note.
  assert.equal(run.reasoner.calls.length, 1, 'exactly one grounded inference per question');
  const call = run.reasoner.calls[0];
  assert.ok(call, 'the reasoner call must exist');
  assert.ok(call.task.instruction.includes(run.scenario.question), 'the reasoner is asked the user\'s question');
  assert.ok(call.signal instanceof AbortSignal, 'the reasoner call is cancellable');
  assert.ok(
    call.context.maxTokens > 0 && call.context.maxTokens <= MAX_CONTEXT_TOKENS,
    'the §5.4 bounded context stays within the deterministic budget',
  );
  assert.deepEqual(
    sorted(call.context.evidenceIds),
    sorted(BROWSER_EVIDENCE),
    'the bounded context carries the captured AX/OCR evidence and the in-project memory',
  );
  assert.ok(!call.context.evidenceIds.includes('mem-helios-1'), 'the unrelated project never enters the context');

  const script = run.scenario.reasoner;
  assert.ok(script, 'the fixture scripts a reasoner answer');
  assert.equal(answer.text, script.answer, 'the spoken explanation is the grounded answer');
  assert.deepEqual(sorted(answer.evidenceIds), sorted(call.context.evidenceIds), 'invented ids are dropped');
  assert.ok(!JSON.stringify(answer).includes('mem-helios-1'), 'the dropped id appears nowhere in the answer');
  assert.ok(!answer.text.includes('Helios'), 'the unrelated project is never named');
  assertSpokenSeam(run, answer);
});

test('C01: an IDE control question is answered from the AX control labels and project memory', async () => {
  const run = harness('ide-control');
  const answer = await run.ask();

  assert.equal(answer.surface, WIDGET_SURFACE);
  assert.equal(answer.capture.state, 'captured');
  assert.equal(answer.capture.app, 'Visual Studio Code');
  assert.equal(run.bridge.calls.capture.length, 1, 'exactly one capture per question');
  assert.ok(run.memory.queries.every((call) => call.scope.projectId === fixture.project.projectId));

  assert.equal(run.reasoner.calls.length, 1);
  const call = run.reasoner.calls[0];
  assert.ok(call, 'the reasoner call must exist');
  assert.deepEqual(
    sorted(call.context.evidenceIds),
    sorted(IDE_EVIDENCE),
    'the bounded context carries both AX control labels and the in-project memory',
  );
  const script = run.scenario.reasoner;
  assert.ok(script, 'the fixture scripts a reasoner answer');
  assert.equal(answer.text, script.answer);
  assert.match(answer.text, /Run Without Debugging/, 'the IDE control is explained by its AX label');
  assert.deepEqual(sorted(answer.evidenceIds), sorted(IDE_EVIDENCE));
  assertSpokenSeam(run, answer);
});

test('C01: an excluded app is refused before the bridge is asked for its content', async () => {
  const run = harness('excluded-app');
  const answer = await run.ask();

  assert.equal(run.scenario.captureMustNeverBeRequested, true, 'the fixture declares the exclusion trap');
  assert.equal(run.bridge.calls.foreground, 1, 'the foreground app is still resolved so it can be named');
  assert.equal(run.bridge.calls.capture.length, 0, 'an excluded app is never captured');
  assert.equal(run.memory.queries.length, 0, 'an excluded app is never queried against memory');
  assert.equal(run.reasoner.calls.length, 0, 'an excluded app is never reasoned over');

  assert.equal(answer.capture.state, 'excluded');
  assert.equal(answer.capture.app, run.scenario.app.name);
  assert.equal(answer.text, renderTemplate(fixture.excludedTemplate, run.scenario.app.name));
  assert.deepEqual([...answer.evidenceIds], [], 'an excluded app contributes no evidence');
  const leakMarker = run.scenario.leakMarker;
  assert.ok(leakMarker, 'the fixture scripts the would-be leak');
  assert.ok(!JSON.stringify(answer).includes(leakMarker), 'no captured content from the excluded app appears anywhere');
  assertSpokenSeam(run, answer);
});

test('C01: missing Accessibility yields the limited-context sentence, not invented control state', async () => {
  const run = harness('missing-accessibility');
  const answer = await run.ask();

  assert.equal(run.bridge.calls.capture.length, 1, 'the capture is attempted because the app is not excluded');
  assert.equal(run.reasoner.calls.length, 0, 'no inference runs without screen evidence');
  assert.equal(run.memory.queries.length, 0, 'no retrieval runs without screen evidence');

  assert.equal(answer.capture.state, 'limited');
  assert.equal(answer.capture.reason, 'accessibility_denied');
  assert.equal(
    answer.text,
    renderTemplate(limitedTemplate('accessibility_denied'), run.scenario.app.name),
    'the deterministic limited-context sentence names the app and the missing access',
  );
  assertNoControlStateWords(answer);
  const hallucination = run.scenario.reasoner;
  assert.ok(hallucination, 'the fixture scripts the hallucinated answer');
  assert.ok(!answer.text.includes(hallucination.answer), 'the hallucinated control state never reaches the user');
  assert.deepEqual([...answer.evidenceIds], [], 'a limited answer cites no evidence');
  assertSpokenSeam(run, answer);
});

test('C01: a blank snapshot (no AX text, no OCR, no pixels) yields the empty-context sentence', async () => {
  const run = harness('empty-context');
  const answer = await run.ask();

  assert.equal(run.scenario.capture.status, 'captured', 'the fixture hands back a captured-but-blank snapshot');
  assert.equal(run.bridge.calls.capture.length, 1);
  assert.equal(run.reasoner.calls.length, 0, 'blank AX/OCR is still missing context: no inference');
  assert.equal(run.memory.queries.length, 0);

  assert.equal(answer.capture.state, 'limited');
  assert.equal(answer.capture.reason, 'empty_context');
  assert.equal(answer.text, renderTemplate(limitedTemplate('empty_context'), run.scenario.app.name));
  assertNoControlStateWords(answer);
  const hallucination = run.scenario.reasoner;
  assert.ok(hallucination, 'the fixture scripts the hallucinated answer');
  assert.ok(!answer.text.includes(hallucination.answer), 'invented page state never reaches the user');
  assert.deepEqual([...answer.evidenceIds], [], 'a blank snapshot cites no evidence');
  assertSpokenSeam(run, answer);
});

test('C01: muting silences the answer without replacing it or bypassing attention', async () => {
  const audible = harness('browser-error');
  const muted = harness('browser-error', { muted: true });
  const [spokenAnswer, mutedAnswer] = await Promise.all([audible.ask(), muted.ask()]);

  assert.equal(spokenAnswer.spoken, true);
  assert.equal(mutedAnswer.spoken, false, 'a muted answer is visible-only');
  assert.equal(muted.voice.submissions.length, 0, 'no plan is submitted without a lease');
  assert.equal(muted.attention.requests.length, 1, 'the service asks attention; it never decides to speak on its own');
  assert.equal(muted.bridge.calls.capture.length, 1, 'muting never changes how context is assembled');
  assert.equal(mutedAnswer.text, spokenAnswer.text, 'muting never replaces the answer text');
  assert.deepEqual(sorted(mutedAnswer.evidenceIds), sorted(spokenAnswer.evidenceIds));
});

test('C01: the same desktop question replays to the same answer under the injected clock', async () => {
  const first = await harness('browser-error').ask();
  const second = await harness('browser-error').ask();
  assert.deepEqual(second, first);
});
