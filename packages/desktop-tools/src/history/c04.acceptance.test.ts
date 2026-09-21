/**
 * C04 acceptance oracle — a day of scoped desktop activity → compact project context → useful
 * later recall (IMPLEMENTATION_PLAN.md §7.2 C04; BACKLOG C04 acceptance criteria).
 *
 * `packages/desktop-tools/src/history/index.ts` must export (this file freezes these names):
 *
 *   createDesktopHistoryService({ scope, now, config, capture, memory, reasoner })
 *     → DesktopHistoryService
 *
 *     scope — the explicit project mapping, e.g.
 *       { profileId: 'profile-c04', projectId: 'atlas', sensitivity: 'normal' }.
 *       Every memory ingest batch and every memory query carries it; without the project id the
 *       fixture's other-project note would be retrieved (the probe below proves it).
 *
 *     now — deterministic clock; every timestamp the service writes comes from it.
 *
 *     config — { policy, workSessions, excludedBundleIds }:
 *       policy — the capture budget { minIntervalMs, maxCapturesPerHour, maxEnergyMsPerDay,
 *         captureCostMs } (packages/capture/src/sampling/, same shape as the sampler oracle).
 *       workSessions — [{ beginsAt, endsAt }]: the explicit work sessions. History is off by
 *         default outside them.
 *       excludedBundleIds — apps whose content is never captured, summarized, or ingested.
 *
 *     capture — the raw desktop boundary (a §5.4-style producer that would happily hand back an
 *       excluded app's window):
 *         captureWindow({ observation }) → Promise<WindowCapture>
 *           WindowCapture = { snapshotId, capturedAt, frameRef, axText, frameText }
 *           `axText` is the window's text right now; `frameRef` identifies the raw screen frame and
 *           `frameText` contains the frame-only bytes. The raw frame is retained only when a
 *           session explicitly opts in — by default the service may read it transiently and must
 *           persist neither the reference nor the bytes.
 *
 *     memory — §5.3 `Memory` (ingest/query/consolidate/forget).
 *
 *     reasoner — §5.3 `Reasoner`: the only model boundary.
 *       Exactly one summarize call per admitted capture: the bounded context carries the capture
 *       as the evidence id `desk:capture:<snapshotId>`, and the returned `{ text }` is the semantic
 *       history record. Later recall makes exactly one more call whose task instruction carries the
 *       later question; its answer is the model text with invented evidence ids dropped.
 *       No model call happens for an unchanged tick.
 *
 *     service:
 *       observe(observation) → Promise<HistoryObservation>
 *         One desktop observation. The identity signature is
 *         `app.bundleId | documentRef | focusedControl | windowTitle | contentRevision`; the
 *         first signature is a change, a different signature is a change, a repeated signature is
 *         'unchanged'. Decision order: an excluded app is 'excluded'; a tick outside every work
 *         session is 'outside_work_session'; a revoked or private session is 'stopped'/'private';
 *         otherwise the sampling policy decides 'changed', 'unchanged', or 'throttled'.
 *         A 'changed' tick captures the window, makes one summarize model call, and appends one
 *         pending semantic record. HistoryObservation = { captured, reason, budget?, recordId? }.
 *       flush() → Promise<{ ingested: number }>
 *         Ingests the pending semantic records into memory as one batch of EventEnvelopes scoped to
 *         `scope`, each carrying its capsule as `payloadRef`; the records stay exportable.
 *       recall({ question }) → Promise<{ text, evidenceIds }>
 *         Later recall: exactly one scoped `memory.query` and one reasoner call; evidence ids the
 *         answer cites that the retrieved bundle does not contain are dropped.
 *       revoke({ reason }) → Promise<{ stopped: true, purged: number }>
 *         Revocation: capture stops permanently and the pending unsaved records (with their frame
 *         refs) are purged.
 *       enterPrivateMode() → Promise<{ purged: number }>, exitPrivateMode() → Promise<void>
 *         The same stop-and-purge for the duration; capture resumes on exit.
 *       exportRecords() → Promise<{ records, frameRefs }>
 *         What a future export would ship: the retained semantic records with their capsule refs,
 *         and the raw frame refs if any were retained. A purged record is gone from here and never
 *         reaches memory afterwards.
 *
 * Deterministic rules pinned here (BACKLOG C04 acceptance criteria):
 *   1. A day-long replay supports later questions about selected work without retaining raw screen
 *      frames by default: every admitted change becomes one semantic record with a source capsule,
 *      ingested under the explicit project scope; the later fixture questions are answered from
 *      the retrieved records, invented evidence ids never survive, and no frame reference, frame
 *      text, or excluded app content appears in memory or in the export.
 *   2. No-change desktop periods produce no repeated model calls, and capture respects the
 *      frequency/energy budgets: the declared idle read yields no captures and no model calls
 *      after the change that started it, exactly one summarize call happens per admitted change,
 *      and min interval, rolling hour cap, and rolling day energy budget hold all day.
 *   3. Revocation and private mode stop capture and purge pending unsaved snapshots before a
 *      future export: the flushed control proves the same ticks do ingest when capture is not
 *      revoked, while the revoked/private service drops them from memory and from the export.
 *
 * Scope note: the fixture is fully synthetic (no real screen content, window, app, or credential)
 * and this oracle drives the frozen service seam only. Real ScreenCaptureKit/AX capture, TCC
 * permission prompts, and OS-level energy metering need the signed helper and a manual
 * qualification pass; they are not claimed here.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  BoundedContext,
  DurableCursor,
  EvidenceBundle,
  EventEnvelope,
  Memory,
  Reasoner,
  ReasoningTask,
  Scope,
} from '../../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/desktop/history/c04-day-replay.json', import.meta.url);
const ROLLING_HOUR_MS = 3_600_000;

type SamplingPolicy = Readonly<{
  minIntervalMs: number;
  maxCapturesPerHour: number;
  maxEnergyMsPerDay: number;
  captureCostMs: number;
}>;
type FixturePhase = Readonly<{
  key: string;
  label: string;
  app: string;
  excluded?: true;
  beginsAt: string;
  endsAt: string;
  stepMs: number;
  changeEveryTicks: number;
  documentRef: string;
  focusedControl: string;
  windowTitle: string;
  summaries: ReadonlyArray<string>;
}>;
type FixtureQuestion = Readonly<{
  key: string;
  question: string;
  answer: string;
  inventedEvidenceIds: ReadonlyArray<string>;
}>;
type FixtureMemoryEntry = Readonly<{ id: string; projectId: string; text: string }>;
type Fixture = Readonly<{
  profileId: string;
  project: Readonly<{ projectId: string; displayName: string }>;
  excludedBundleIds: ReadonlyArray<string>;
  rawCanary: string;
  snapshotIdPrefix: string;
  frameRefTemplate: string;
  samplingPolicy: SamplingPolicy;
  workSession: Readonly<{ label: string; beginsAt: string; endsAt: string }>;
  checkpoints: ReadonlyArray<string>;
  apps: Readonly<Record<string, Readonly<{ bundleId: string; name: string }>>>;
  phases: ReadonlyArray<FixturePhase>;
  questions: ReadonlyArray<FixtureQuestion>;
  preloadedMemory: ReadonlyArray<FixtureMemoryEntry>;
}>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
const FRAME_REF_PREFIX = fixture.frameRefTemplate.split('{snapshotId}')[0] ?? fixture.frameRefTemplate;
const SCOPE: Scope = {
  profileId: fixture.profileId,
  projectId: fixture.project.projectId,
  sensitivity: 'normal',
};

type DesktopObservation = Readonly<{
  app: Readonly<{ bundleId: string; name: string }>;
  windowTitle: string;
  documentRef: string;
  focusedControl: string;
  contentRevision: string;
}>;
type Tick = Readonly<{ phase: FixturePhase; at: number; observation: DesktopObservation; summary: string }>;
type WindowCapture = Readonly<{
  snapshotId: string;
  capturedAt: string;
  frameRef: string;
  axText: ReadonlyArray<string>;
  frameText: ReadonlyArray<string>;
}>;
type HistoryObservation = Readonly<{
  captured: boolean;
  reason: 'changed' | 'unchanged' | 'throttled' | 'excluded' | 'outside_work_session' | 'stopped' | 'private';
  budget?: 'frequency' | 'energy';
  recordId?: string;
}>;
type RetainedRecord = Readonly<{ recordId: string; text: string; capsuleRef: string; capturedAt: string }>;
type ExportBundle = Readonly<{ records: ReadonlyArray<RetainedRecord>; frameRefs: ReadonlyArray<string> }>;
type Recall = Readonly<{ text: string; evidenceIds: ReadonlyArray<string> }>;
type DesktopHistoryService = Readonly<{
  observe(observation: DesktopObservation): Promise<HistoryObservation>;
  flush(): Promise<Readonly<{ ingested: number }>>;
  recall(request: Readonly<{ question: string }>): Promise<Recall>;
  revoke(request: Readonly<{ reason: string }>): Promise<Readonly<{ stopped: boolean; purged: number }>>;
  enterPrivateMode(): Promise<Readonly<{ purged: number }>>;
  exitPrivateMode(): Promise<void>;
  exportRecords(): Promise<ExportBundle>;
}>;
type DesktopHistoryOptions = Readonly<{
  scope: Scope;
  now: () => Date;
  config: Readonly<{
    policy: SamplingPolicy;
    workSessions: ReadonlyArray<Readonly<{ beginsAt: string; endsAt: string }>>;
    excludedBundleIds: ReadonlyArray<string>;
  }>;
  capture: Readonly<{ captureWindow(request: Readonly<{ observation: DesktopObservation }>): Promise<WindowCapture> }>;
  memory: Memory;
  reasoner: Reasoner;
}>;
type DesktopHistoryModule = Readonly<{
  createDesktopHistoryService(options: DesktopHistoryOptions): DesktopHistoryService;
}>;

const MISSING_BEHAVIOR = 'C04 required desktop history behavior is not implemented yet: '
  + 'packages/desktop-tools/src/history/index.ts must export createDesktopHistoryService({ scope, '
  + 'now, config, capture, memory, reasoner }) returning observe({ observation }) → '
  + 'Promise<HistoryObservation>, flush(), recall({ question }), revoke({ reason }), '
  + 'enterPrivateMode(), exitPrivateMode() and exportRecords() over the frozen history seam.';

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): DesktopHistoryModule {
  return {
    createDesktopHistoryService(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadDesktopHistoryModule(): Promise<DesktopHistoryModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createDesktopHistoryService !== 'function') {
    return missingModule('createDesktopHistoryService is not exported');
  }
  return loaded as unknown as DesktopHistoryModule;
}

const desktopHistory = await loadDesktopHistoryModule();

function appFor(key: string): Readonly<{ bundleId: string; name: string }> {
  const app = fixture.apps[key];
  assert.ok(app, `fixture is missing apps.${key}`);
  return app;
}

function ticksFor(phase: FixturePhase): ReadonlyArray<Tick> {
  const ticks: Array<Tick> = [];
  const begin = Date.parse(phase.beginsAt);
  const end = Date.parse(phase.endsAt);
  let index = 0;
  for (let at = begin; at < end; at += phase.stepMs, index += 1) {
    const revision = Math.floor(index / phase.changeEveryTicks);
    const summary = phase.summaries[revision % phase.summaries.length];
    assert.ok(summary, `fixture phase ${phase.key} has no summary for revision ${revision}`);
    ticks.push({
      phase,
      at,
      observation: {
        app: appFor(phase.app),
        windowTitle: phase.windowTitle,
        documentRef: phase.documentRef,
        focusedControl: phase.focusedControl,
        contentRevision: `${phase.key}:${revision}`,
      },
      summary,
    });
  }
  return ticks;
}

const ALL_TICKS: ReadonlyArray<Tick> = fixture.phases.flatMap(ticksFor);
for (let index = 1; index < ALL_TICKS.length; index += 1) {
  const previous = ALL_TICKS[index - 1];
  const current = ALL_TICKS[index];
  assert.ok(previous && current && current.at > previous.at, 'the fixture timeline is strictly increasing');
}

function ticksIn(phaseKey: string, fromMs = -Infinity, toMs = Infinity): ReadonlyArray<Tick> {
  return ALL_TICKS.filter((tick) => tick.phase.key === phaseKey && tick.at >= fromMs && tick.at <= toMs);
}

/** The fixture's changeEveryTicks grouped without any budget: what an unthrottled day would capture. */
function naiveChangeGroups(): number {
  const sessionEnd = Date.parse(fixture.workSession.endsAt);
  return fixture.phases
    .filter((phase) => phase.excluded !== true && Date.parse(phase.beginsAt) < sessionEnd)
    .reduce((total, phase) => total + Math.ceil(ticksFor(phase).length / phase.changeEveryTicks), 0);
}

function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function overlapScore(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let score = 0;
  for (const token of left) if (right.has(token)) score += 1;
  return score;
}

type ReplayClock = Readonly<{ now: () => Date; set: (at: number) => void }>;

function replayClock(at: number): ReplayClock {
  let current = at;
  return {
    now: () => new Date(current),
    set: (value: number) => {
      current = value;
    },
  };
}

type CaptureCall = Readonly<{ observation: DesktopObservation; snapshotId: string; frameRef: string }>;
type FakeCapture = Readonly<{
  calls: Array<CaptureCall>;
  captures: ReadonlyMap<string, WindowCapture>;
  captureWindow(request: Readonly<{ observation: DesktopObservation }>): Promise<WindowCapture>;
}>;

/** The raw producer: it can hand back any window, including excluded apps and frame-only bytes. */
function fakeCapture(ticks: ReadonlyArray<Tick>, clock: ReplayClock): FakeCapture {
  const summaryByRevision = new Map(ticks.map((tick) => [tick.observation.contentRevision, tick.summary]));
  const calls: Array<CaptureCall> = [];
  const captures = new Map<string, WindowCapture>();
  return {
    calls,
    captures,
    async captureWindow({ observation }) {
      const summary = summaryByRevision.get(observation.contentRevision);
      assert.ok(summary, `the capture probe has no window text for revision ${observation.contentRevision}`);
      const snapshotId = `${fixture.snapshotIdPrefix}${calls.length + 1}`;
      const frameRef = fixture.frameRefTemplate.replaceAll('{snapshotId}', snapshotId);
      const capture: WindowCapture = {
        snapshotId,
        capturedAt: clock.now().toISOString(),
        frameRef,
        axText: [summary],
        frameText: [`${fixture.rawCanary} ${snapshotId}`],
      };
      calls.push({ observation, snapshotId, frameRef });
      captures.set(snapshotId, capture);
      return capture;
    },
  };
}

type ReasonerCall = Readonly<{
  task: ReasoningTask;
  context: BoundedContext;
  outputSchema: Readonly<Record<string, unknown>>;
  at: number;
}>;
type FakeReasoner = Reasoner & Readonly<{ calls: Array<ReasonerCall> }>;

/** The model boundary: it resolves the evidence ids it is given, and scripts the fixture answers. */
function fakeReasoner(capture: FakeCapture, clock: ReplayClock): FakeReasoner {
  const calls: Array<ReasonerCall> = [];
  return {
    calls,
    async run(task, context, outputSchema): Promise<unknown> {
      calls.push({ task, context, outputSchema, at: clock.now().getTime() });
      const captureId = context.evidenceIds.find((id) => id.startsWith('desk:capture:'));
      if (captureId !== undefined) {
        const snapshotId = captureId.slice('desk:capture:'.length);
        const captured = capture.captures.get(snapshotId);
        assert.ok(captured, `the summarize call cites an unknown capture ${snapshotId}`);
        const text = captured.axText[0];
        assert.ok(text, `capture ${snapshotId} has no window text`);
        return { text };
      }
      const question = fixture.questions.find((entry) => task.instruction.includes(entry.question));
      assert.ok(question, `the recall call does not carry a fixture question: ${task.instruction}`);
      return { text: question.answer, evidenceIds: [...context.evidenceIds, ...question.inventedEvidenceIds] };
    },
  };
}

type MemoryQuery = Readonly<{ search: string; scope: Scope; budget: number }>;
type FakeMemory = Memory & Readonly<{
  queries: Array<MemoryQuery>;
  batches: Array<ReadonlyArray<EventEnvelope>>;
  envelopes: Array<EventEnvelope>;
  capsuleTexts: Map<string, string>;
}>;

/** Token-overlap store: only the explicit project scope keeps the other-project note out. */
function fakeMemory(preloaded: ReadonlyArray<FixtureMemoryEntry>): FakeMemory {
  const queries: Array<MemoryQuery> = [];
  const batches: Array<ReadonlyArray<EventEnvelope>> = [];
  const envelopes: Array<EventEnvelope> = [];
  const capsuleTexts = new Map<string, string>();
  return {
    queries,
    batches,
    envelopes,
    capsuleTexts,
    async ingest(batch): Promise<DurableCursor> {
      batches.push(batch);
      for (const envelope of batch) envelopes.push(envelope);
      return { value: String(envelopes.length) };
    },
    async query(search, scope, budget): Promise<EvidenceBundle> {
      queries.push({ search, scope, budget });
      const searchTokens = tokenize(search);
      const entries: Array<FixtureMemoryEntry> = [
        ...preloaded.map((entry) => ({ id: entry.id, projectId: entry.projectId, text: entry.text })),
        ...envelopes.map((envelope) => {
          const text = capsuleTexts.get(envelope.payloadRef);
          assert.ok(text, `memory holds envelope ${envelope.payloadRef} without a capsule text`);
          return { id: envelope.payloadRef, projectId: envelope.scope.projectId ?? '', text };
        }),
      ];
      const matches = entries
        .filter((entry) => scope.projectId === undefined || entry.projectId === scope.projectId)
        .map((entry) => ({ entry, score: overlapScore(tokenize(entry.text), searchTokens) }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || (left.entry.id < right.entry.id ? -1 : 1))
        .slice(0, Math.max(0, budget))
        .map((candidate) => candidate.entry);
      return {
        evidenceIds: matches.map((entry) => entry.id),
        summary: matches.map((entry) => entry.text).join(' '),
      };
    },
    async consolidate(): Promise<never> {
      throw new Error('C04 oracle: memory.consolidate is not part of the desktop history path');
    },
    async forget(): Promise<never> {
      throw new Error('C04 oracle: memory.forget is not part of the desktop history path');
    },
  };
}

type ObservedTick = Readonly<{ tick: Tick; outcome: HistoryObservation }>;
type Harness = Readonly<{
  clock: ReplayClock;
  capture: FakeCapture;
  memory: FakeMemory;
  reasoner: FakeReasoner;
  service: DesktopHistoryService;
  observed: Array<ObservedTick>;
  observe(tick: Tick): Promise<HistoryObservation>;
  flush(): Promise<Readonly<{ ingested: number }>>;
  replay(timeline: ReadonlyArray<Tick>): Promise<void>;
}>;

async function createHarness(): Promise<Harness> {
  const clock = replayClock(Date.parse(fixture.workSession.beginsAt));
  const capture = fakeCapture(ALL_TICKS, clock);
  const memory = fakeMemory(fixture.preloadedMemory);
  const reasoner = fakeReasoner(capture, clock);
  const service = desktopHistory.createDesktopHistoryService({
    scope: SCOPE,
    now: clock.now,
    config: {
      policy: fixture.samplingPolicy,
      workSessions: [{ beginsAt: fixture.workSession.beginsAt, endsAt: fixture.workSession.endsAt }],
      excludedBundleIds: fixture.excludedBundleIds,
    },
    capture,
    memory,
    reasoner,
  });
  const observed: Array<ObservedTick> = [];
  const observe = async (tick: Tick): Promise<HistoryObservation> => {
    clock.set(tick.at);
    const outcome = await service.observe(tick.observation);
    observed.push({ tick, outcome });
    return outcome;
  };
  const flush = async (): Promise<Readonly<{ ingested: number }>> => {
    const receipt = await service.flush();
    const bundle = await service.exportRecords();
    for (const record of bundle.records) memory.capsuleTexts.set(record.capsuleRef, record.text);
    return receipt;
  };
  const replay = async (timeline: ReadonlyArray<Tick>): Promise<void> => {
    const pending = fixture.checkpoints.map((value) => Date.parse(value));
    for (const tick of timeline) {
      while (pending.length > 0 && (pending[0] ?? Infinity) <= tick.at) {
        pending.shift();
        await flush();
      }
      await observe(tick);
    }
    while (pending.length > 0) {
      pending.shift();
      await flush();
    }
    await flush();
  };
  return { clock, capture, memory, reasoner, service, observed, observe, flush, replay };
}

function captures(run: Harness): ReadonlyArray<ObservedTick> {
  return run.observed.filter(({ outcome }) => outcome.captured);
}

function outcomesIn(run: Harness, phaseKey: string): ReadonlyArray<HistoryObservation> {
  return run.observed.filter(({ tick }) => tick.phase.key === phaseKey).map(({ outcome }) => outcome);
}

/** The change signature the sampler decides on: the same identity the service forwards. */
function signatureOf(observation: DesktopObservation): string {
  return [
    observation.app.bundleId,
    observation.documentRef,
    observation.focusedControl,
    observation.windowTitle,
    observation.contentRevision,
  ].join('|');
}

function captureCallsIn(run: Harness, phaseKey: string): ReadonlyArray<CaptureCall> {
  const signatures = new Set(ticksIn(phaseKey).map((tick) => signatureOf(tick.observation)));
  return run.capture.calls.filter((call) => signatures.has(signatureOf(call.observation)));
}

test('C04: a day-long replay records scoped work and answers later questions without raw frames', async () => {
  const run = await createHarness();
  await run.replay(ALL_TICKS);

  // Capture is scoped: an excluded app and after-hours activity never reach the raw boundary.
  const vault = outcomesIn(run, 'vault-lunch');
  assert.equal(vault.length, 40, 'the fixture declares 40 excluded observations');
  assert.ok(vault.every((outcome) => outcome.reason === 'excluded'), 'an excluded app is refused before capture');
  assert.equal(captureCallsIn(run, 'vault-lunch').length, 0, 'an excluded app is never captured');
  const evening = outcomesIn(run, 'editor-evening-session');
  assert.equal(evening.length, 60, 'the fixture declares 60 after-hours observations');
  assert.ok(evening.every((outcome) => outcome.reason === 'outside_work_session'), 'history is off outside an explicit work session');
  assert.equal(captureCallsIn(run, 'editor-evening-session').length, 0, 'after-hours activity is never captured');

  // Every admitted change became one semantic record with its own capsule, ingested under the scope.
  const admitted = captures(run);
  assert.ok(admitted.length >= 10, 'the day records the work that changed');
  const bundle = await run.service.exportRecords();
  assert.equal(bundle.records.length, admitted.length, 'one semantic record per admitted change');
  assert.deepEqual([...bundle.frameRefs], [], 'raw screen frames are not retained by default');
  assert.equal(run.reasoner.calls.length, admitted.length, 'exactly one summarize model call per admitted change');
  assert.equal(run.memory.envelopes.length, admitted.length, 'every record was ingested once');
  const capsules = new Set(bundle.records.map((record) => record.capsuleRef));
  assert.equal(capsules.size, bundle.records.length, 'each record has its own source capsule');
  assert.ok(run.memory.envelopes.every((envelope) => envelope.scope.projectId === fixture.project.projectId));
  assert.ok(run.memory.envelopes.every((envelope) => capsules.has(envelope.payloadRef)), 'ingest references the record capsules');
  const summaryLines = new Set(ALL_TICKS.map((tick) => tick.summary));
  assert.ok(bundle.records.every((record) => summaryLines.has(record.text)), 'records carry the semantic sentence, not raw frame bytes');
  const persisted = JSON.stringify({ bundle, envelopes: run.memory.envelopes, batches: run.memory.batches });
  assert.ok(!persisted.includes(fixture.rawCanary), 'no raw frame content is persisted');
  assert.ok(!persisted.includes(FRAME_REF_PREFIX), 'no raw frame reference is persisted');
  for (const phase of fixture.phases.filter((entry) => entry.excluded === true)) {
    for (const summary of phase.summaries) {
      assert.ok(!persisted.includes(summary), `content of the excluded ${phase.key} phase never reaches storage`);
    }
  }

  // The probe: without the explicit project scope the fixture's other-project note would be retrieved.
  const question = fixture.questions[0];
  assert.ok(question, 'the fixture declares the first later question');
  const otherProjectIds = fixture.preloadedMemory
    .filter((entry) => entry.projectId !== fixture.project.projectId)
    .map((entry) => entry.id);
  assert.ok(otherProjectIds.length > 0, 'the fixture declares the other-project note');
  const unscoped = await run.memory.query(question.question, { profileId: fixture.profileId, sensitivity: 'normal' }, 32);
  assert.ok(
    otherProjectIds.some((id) => unscoped.evidenceIds.includes(id)),
    'the probe: an unscoped query demonstrably returns the other project note',
  );

  // Later recall: scoped retrieval plus one model call, with invented evidence ids dropped.
  const queryCount = run.memory.queries.length;
  const envelopeCount = run.memory.envelopes.length;
  const captureCallCount = run.capture.calls.length;
  const recalls: Array<Readonly<{ question: FixtureQuestion; recall: Recall }>> = [];
  for (const entry of fixture.questions) {
    recalls.push({ question: entry, recall: await run.service.recall({ question: entry.question }) });
  }
  const recallCalls = run.reasoner.calls.slice(admitted.length);
  assert.equal(recallCalls.length, fixture.questions.length, 'exactly one model call per later question');
  for (const [index, { question: asked, recall }] of recalls.entries()) {
    assert.equal(recall.text, asked.answer, 'the later question is answered from the recorded project history');
    assert.ok(recall.evidenceIds.length > 0, 'the answer is grounded in retrieved records');
    assert.ok(recall.evidenceIds.every((id) => capsules.has(id)), 'every citation is an ingested record capsule');
    assert.ok(asked.inventedEvidenceIds.every((id) => !recall.evidenceIds.includes(id)), 'invented evidence ids never survive');
    const cited = recall.evidenceIds.map((id) => bundle.records.find((record) => record.capsuleRef === id)?.text ?? '');
    assert.ok(
      cited.some((text) => overlapScore(tokenize(text), tokenize(asked.question)) > 0),
      'the cited records match the later question',
    );
    const call = recallCalls[index];
    assert.ok(call, `the model call for ${asked.key} is recorded`);
    assert.deepEqual(
      [...recall.evidenceIds].sort(),
      [...call.context.evidenceIds].sort(),
      'the answer cites exactly the bounded context it was given',
    );
  }
  const queries = run.memory.queries.slice(queryCount);
  assert.equal(queries.length, fixture.questions.length, 'one retrieval per later question');
  assert.ok(queries.every((entry) => entry.scope.projectId === fixture.project.projectId), 'retrieval is scoped to the project');
  assert.ok(queries.every((entry) => entry.scope.profileId === fixture.profileId));
  assert.ok(queries.every((entry) => entry.budget >= 1), 'retrieval is bounded, not unbounded');
  assert.equal(run.capture.calls.length, captureCallCount, 'recall never captures the screen');
  assert.equal(run.memory.envelopes.length, envelopeCount, 'recall never ingests new records');
});

test('C04: no-change periods produce no captures or model calls, and capture respects the budgets', async () => {
  const run = await createHarness();
  await run.replay(ALL_TICKS);
  const policy = fixture.samplingPolicy;
  const admitted = captures(run);
  const captureTimes = admitted.map(({ tick }) => tick.at);

  // The declared long read (browser-midday-read) changes once and then holds still for two hours.
  const idleStart = Date.parse('2026-09-15T10:02:00.000Z');
  const idleEnd = Date.parse('2026-09-15T12:00:00.000Z');
  assert.equal(captureTimes.filter((at) => at > idleStart && at < idleEnd).length, 0, 'a no-change period captures nothing');
  assert.equal(
    run.reasoner.calls.filter((call) => call.at > idleStart && call.at < idleEnd).length,
    0,
    'a no-change period makes no model call at all',
  );
  const unchanged = run.observed.filter(({ outcome }) => outcome.reason === 'unchanged');
  assert.ok(unchanged.length >= 100, 'the no-change ticks are observed and decided, never silently skipped');
  assert.equal(run.observed.length, ALL_TICKS.length, 'the whole day was replayed');

  // One summarize call per admitted change, never one per tick.
  assert.equal(run.reasoner.calls.length, captureTimes.length, 'exactly one summarize model call per admitted change');
  assert.ok(
    run.reasoner.calls.every((call) => call.context.evidenceIds.some((id) => id.startsWith('desk:capture:'))),
    'no model call happens without a captured change',
  );

  // Frequency and energy budgets hold across the whole day.
  assert.ok(admitted.length >= 10, 'the day still records the work that changed');
  assert.ok(
    admitted.length * policy.captureCostMs <= policy.maxEnergyMsPerDay,
    'the rolling day energy budget holds',
  );
  for (let index = 1; index < captureTimes.length; index += 1) {
    const previous = captureTimes[index - 1] ?? 0;
    const current = captureTimes[index] ?? 0;
    assert.ok(current - previous >= policy.minIntervalMs, 'no two captures break the minimum interval');
  }
  for (const at of captureTimes) {
    const inHour = captureTimes.filter((candidate) => candidate > at - ROLLING_HOUR_MS && candidate <= at).length;
    assert.ok(inHour <= policy.maxCapturesPerHour, 'no rolling hour exceeds the capture cap');
  }
  const naive = naiveChangeGroups();
  assert.ok(naive >= 100, 'the fixture declares a busy day without budgets');
  assert.ok(admitted.length < naive, `the budgets reduced ${naive} unthrottled changes to ${admitted.length} captures`);
  assert.ok(run.observed.filter(({ outcome }) => outcome.reason === 'throttled').length > 0, 'the budgets were actually binding');
  assert.ok(captureTimes.some((at) => at >= Date.parse('2026-09-15T12:00:00.000Z')), 'capture continues after the idle period');
});

test('C04: revocation stops capture and purges pending unsaved snapshots before a future export', async () => {
  const morning = ticksIn('terminal-morning-suite', -Infinity, Date.parse('2026-09-15T08:02:00.000Z'));
  assert.ok(morning.length >= 3, 'the fixture declares the morning observations');

  const run = await createHarness();
  for (const tick of morning) await run.observe(tick);
  const pending = captures(run);
  assert.ok(pending.length >= 2, 'the morning produced unsaved records');
  const purgeIds = pending.map(({ outcome }) => outcome.recordId);
  assert.ok(purgeIds.every((id) => typeof id === 'string' && id.length > 0), 'every captured change reports its record id');
  const before = await run.service.exportRecords();
  assert.equal(before.records.length, pending.length, 'the unsaved records are retained before the checkpoint');
  assert.equal(run.memory.envelopes.length, 0, 'nothing was ingested before the checkpoint');

  // Control: the same ticks ingest normally when capture is not revoked.
  const control = await createHarness();
  for (const tick of morning) await control.observe(tick);
  assert.equal((await control.service.flush()).ingested, pending.length, 'the same ticks ingest without revocation');
  assert.equal(control.memory.envelopes.length, pending.length);

  const receipt = await run.service.revoke({ reason: 'permission_revoked' });
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.purged, pending.length, 'every pending unsaved snapshot is purged');
  assert.equal((await run.flush()).ingested, 0, 'a purged snapshot is never ingested later');
  assert.equal(run.memory.envelopes.length, 0, 'no purged content reaches memory');

  // Capture is stopped: further desktop activity never touches the raw boundary or the model.
  const captureCalls = run.capture.calls.length;
  const reasonerCalls = run.reasoner.calls.length;
  for (const tick of ticksIn('editor-morning-plan')) {
    const outcome = await run.observe(tick);
    assert.equal(outcome.captured, false);
    assert.equal(outcome.reason, 'stopped', 'a revoked session never captures again');
  }
  assert.equal(run.capture.calls.length, captureCalls, 'revoked capture is never asked again');
  assert.equal(run.reasoner.calls.length, reasonerCalls, 'a revoked history makes no model calls');

  // The future export ships none of the purged snapshots and no raw frames.
  const after = await run.service.exportRecords();
  assert.equal(after.records.length, 0, 'purged snapshots are gone from a future export');
  assert.deepEqual([...after.frameRefs], [], 'revocation retains no raw frames either');
  const shipped = JSON.stringify(after);
  assert.ok(!shipped.includes(fixture.rawCanary));
  assert.ok(purgeIds.every((id) => typeof id === 'string' && !shipped.includes(id)), 'a purged record id is never exportable');
  assert.equal((await run.service.exportRecords()).records.length, 0, 'the export stays empty on a later read');
});

test('C04: private mode stops capture, purges pending snapshots, and capture resumes on exit', async () => {
  const run = await createHarness();
  const beforePrivate = ticksIn('terminal-morning-suite', -Infinity, Date.parse('2026-09-15T08:02:00.000Z'));
  for (const tick of beforePrivate) await run.observe(tick);
  const pending = captures(run);
  assert.ok(pending.length >= 2, 'work before the private session left unsaved records');

  const entered = await run.service.enterPrivateMode();
  assert.equal(entered.purged, pending.length, 'private mode purges the pending unsaved snapshots');
  assert.equal((await run.service.exportRecords()).records.length, 0, 'nothing retained survives private mode');

  const captureCalls = run.capture.calls.length;
  const reasonerCalls = run.reasoner.calls.length;
  const privateWindow = ALL_TICKS.filter(
    (tick) => tick.at > Date.parse('2026-09-15T08:02:00.000Z') && tick.at < Date.parse('2026-09-15T08:10:00.000Z'),
  );
  assert.ok(privateWindow.length > 0, 'the fixture declares activity inside the private session');
  for (const tick of privateWindow) {
    const outcome = await run.observe(tick);
    assert.equal(outcome.captured, false);
    assert.equal(outcome.reason, 'private', 'private mode never captures');
  }
  assert.equal(run.capture.calls.length, captureCalls, 'private mode never touches the raw boundary');
  assert.equal(run.reasoner.calls.length, reasonerCalls, 'private mode never reaches the model');
  assert.equal((await run.flush()).ingested, 0, 'a private session ingests nothing');
  assert.equal(run.memory.envelopes.length, 0, 'nothing captured around private mode reaches memory');

  await run.service.exitPrivateMode();
  const resume = ticksIn('editor-morning-plan')[0];
  assert.ok(resume, 'the fixture declares the first post-private change');
  const resumed = await run.observe(resume);
  assert.equal(resumed.captured, true, 'capture resumes when the private session ends');
  assert.equal((await run.flush()).ingested, 1, 'the resumed record ingests normally');
  assert.equal(run.memory.envelopes.length, 1);
});
