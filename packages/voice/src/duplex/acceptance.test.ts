/**
 * V03 acceptance oracle — narration + overlapping user speech → backchannel or interruption →
 * correct continuation.
 *
 * The Section 4.4 interruption row is a reference-machine measurement: it needs the signed app,
 * Apple voice processing (one AEC) and a real microphone/speaker route. The deterministic
 * acceptance path therefore drives the same duplex decision boundary with local fakes plus the
 * frozen held-out subset in `fixtures/duplex/v03-held-out-exchanges.json`: a manual monotonic
 * clock, a fake playback port that records what the device was told to do, and a fake managed
 * agent port that records interruption delivery. The latencies below are the modeled pipeline
 * latencies the controller owns (acoustic onset → duck, stop detection → silence, ordinary
 * barge-in → silence); acoustic and device latency stay subject to hardware qualification and are
 * reported as a limitation instead of being claimed from the model.
 *
 * `packages/voice/src/duplex/index.ts` must export:
 *
 *   createDuplexController({ clock, output, agent }) → DuplexController
 *
 *     clock — monotonic milliseconds: `now(): number`. The native pipeline stamps VAD, ASR,
 *       playback and device-switch events with one monotonic clock, and the Section 5.5 duck and
 *       350 ms budgets are measured against it. The controller must use this clock (never
 *       `Date.now()`), so the budgets are testable and a device switch invalidates one calibration.
 *
 *     output — the audible narration boundary (native playback graph / V02 playback session):
 *       speaking() → boolean — a plan is audibly playing
 *       cursorMs() → number  — monotonic ms position of the last audible frame
 *       duck(levelDb)        — attenuate by `levelDb` without moving the cursor (Section 5.5.1:
 *                              the acceptance call is -18 dB)
 *       restore(fadeMs)      — fade back to full volume over `fadeMs` (Section 5.5.4: 40 ms)
 *       pause()              — silence now, keep the cursor and the generation epoch so the turn
 *                              can continue from the next complete relevant segment
 *       stop()               — silence now and cancel the generation epoch; late frames from the
 *                              cancelled epoch must never become audible (Section 5.5.2)
 *
 *     agent — the managed-harness control port (the Section 5.3 adapter boundary):
 *       interrupt({ turnId, reason }) → Promise<'acknowledged' | 'unknown'>
 *         One routed agent-control request. The resolved value is the observed receipt, never an
 *         assumption that delivery happened.
 *
 *     controller:
 *       noteSpeechOnset({ utteranceId, route, atMs }) — non-echo speech onset while narration is
 *         speaking: duck within 100 ms of `atMs` and preserve the playback cursor (Section 5.5.1).
 *       submitUserSpeech(evidence) → DuplexDecision — committed, classified overlapping speech:
 *         evidence = { utteranceId, route, durationMs, transcript, asrConfidence,
 *           prosody: { energyDb, voicedRatio, pitchSpanSemitones },
 *           confirmationPending, newRequestFollows }
 *         decision = { utteranceId, outcome: 'backchannel' | 'interruption' | 'explicit_stop' |
 *           'uncertain', decidedAtMs, committed, output, resumeCursorMs }
 *         A backchannel restores output with a 40 ms fade from the preserved cursor and is never
 *         committed as a request. Interruption and uncertainty pause/flush and commit the utterance
 *         for routing (no new request may follow a backchannel, and a confirmation answer is not a
 *         backchannel). An explicit stop flushes and cancels the generation epoch.
 *       stopSpeaking() → Promise<void> — the explicit local stop control (hotkey / local spotter):
 *         silence within 200 ms and cancel the epoch without touching managed agent work.
 *       submitAgentControl({ requestId, turnId, reason }) → Promise<AgentControlReceipt> — one
 *         separately routed agent-control request from the addressee router (Section 5.6). A
 *         redelivered requestId is delivered at most once; the receipt reports only what the
 *         adapter observed.
 *       status() → { output: 'idle' | 'speaking' | 'ducked' | 'paused' | 'stopped', cursorMs }
 *
 * Acceptance mapping:
 *   - Section 4.4 over the 200-exchange speaker/headphone subset: acoustic onset → duck ≤100 ms,
 *     explicit stop → silence ≤200 ms, ordinary barge-in → silence ≤350 ms. Every exchange is
 *     asserted against its deadline (a deterministic stand-in strictly stronger than the p95 gate
 *     because the modeled pipeline carries no jitter) and the p95 is reported.
 *   - ≥95% backchannel precision on the held-out exchanges, with a recall floor so "never
 *     backchannel" cannot game precision, and uncertain speech that pauses output (at least 80%
 *     must reach the distinct 'uncertain' paused state; every uncertain exchange must silence).
 *   - "stop speaking" cancels narration only: the managed turn keeps running, and the harness sees
 *     an interrupt only through a separate routed agent-control request, at most once per requestId.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/** Section 4.4: acoustic onset → initial duck ≤100 ms p95. */
const DUCK_DEADLINE_MS = 100;
/** Section 5.5 step 1: duck by 18 dB and keep the playback cursor. */
const DUCK_LEVEL_DB = -18;
/** Section 5.5 step 4: restore a backchannel with a 40 ms fade. */
const RESTORE_FADE_MS = 40;
/** Section 4.4: explicit stop → silence ≤200 ms p95. */
const EXPLICIT_STOP_DEADLINE_MS = 200;
/** Section 4.4: ordinary barge-in → silence ≤350 ms p95. */
const BARGE_IN_DEADLINE_MS = 350;
/** Section 4.5 release gate: ≥95% precision for recognizing backchannels. */
const BACKCHANNEL_PRECISION_TARGET = 0.95;
/** Anti-degenerate floor: precision is meaningless if backchannels are never recognized. */
const BACKCHANNEL_RECALL_FLOOR = 0.75;
/** Uncertain speech must pause output; this floor keeps a distinct uncertain state alive. */
const UNCERTAIN_STATE_FLOOR = 0.8;
/** p95-style allowance for uncertain evidence reaching the paused state. */
const UNCERTAIN_PAUSE_FLOOR = 0.96;
/** p95-style allowance for the exact-phrase explicit stop spotter. */
const EXPLICIT_STOP_RECOGNITION_FLOOR = 0.96;
const CORPUS_SIZE = 200;
const NARRATION_CURSOR_MS = 2_400;
const FIXTURE_URL = new URL('../../../../fixtures/duplex/v03-held-out-exchanges.json', import.meta.url);

type DuplexRoute = 'speaker' | 'headphones';
type BargeInOutcome = 'backchannel' | 'interruption' | 'explicit_stop' | 'uncertain';
type DuplexOutputState = 'idle' | 'speaking' | 'ducked' | 'paused' | 'stopped';

type UserSpeechEvidence = Readonly<{
  utteranceId: string;
  route: DuplexRoute;
  durationMs: number;
  transcript: string;
  asrConfidence: number;
  prosody: Readonly<{ energyDb: number; voicedRatio: number; pitchSpanSemitones: number }>;
  confirmationPending: boolean;
  newRequestFollows: boolean;
}>;

type DuplexDecision = Readonly<{
  utteranceId: string;
  outcome: BargeInOutcome;
  decidedAtMs: number;
  committed: boolean;
  output: DuplexOutputState;
  resumeCursorMs: number | null;
}>;

type AgentControlRequest = Readonly<{ requestId: string; turnId: string; reason: string }>;
type AgentControlReceipt = Readonly<{ requestId: string; turnId: string; status: 'acknowledged' | 'unknown' }>;

type DuplexOutputPort = Readonly<{
  speaking(): boolean;
  cursorMs(): number;
  duck(levelDb: number): void;
  restore(fadeMs: number): void;
  pause(): void;
  stop(): void;
}>;

type DuplexAgentPort = Readonly<{
  interrupt(request: Readonly<{ turnId: string; reason: string }>): Promise<'acknowledged' | 'unknown'>;
}>;

type DuplexController = Readonly<{
  noteSpeechOnset(onset: Readonly<{ utteranceId: string; route: DuplexRoute; atMs: number }>): void;
  submitUserSpeech(evidence: UserSpeechEvidence): Promise<DuplexDecision>;
  stopSpeaking(): Promise<void>;
  submitAgentControl(request: AgentControlRequest): Promise<AgentControlReceipt>;
  status(): Readonly<{ output: DuplexOutputState; cursorMs: number }>;
}>;

type DuplexControllerOptions = Readonly<{
  clock: Readonly<{ now(): number }>;
  output: DuplexOutputPort;
  agent: DuplexAgentPort;
}>;

type DuplexModule = Readonly<{
  createDuplexController(options: DuplexControllerOptions): DuplexController;
}>;

let duplexModulePromise: Promise<DuplexModule> | undefined;

function loadDuplexModule(): Promise<DuplexModule> {
  duplexModulePromise ??= (async () => {
    const fail = (detail: string): never => assert.fail(
      'V03 required duplex behavior is not implemented yet: packages/voice/src/duplex/index.ts must '
      + 'export createDuplexController({ clock, output, agent }). '
      + detail,
    );
    let loaded: Record<string, unknown>;
    try {
      // The specifier is not a literal so a missing implementation is reported by this oracle as a
      // missing-behavior failure instead of a TypeScript resolution error.
      const specifier = './index.js';
      loaded = (await import(specifier)) as unknown as Record<string, unknown>;
    } catch (error) {
      return fail(
        'packages/voice/src/duplex/index.ts does not exist yet (it is imported here as the '
        + `TypeScript ESM specifier "./index.js"): ${(error as Error).message}`,
      );
    }
    if (typeof loaded.createDuplexController !== 'function') {
      return fail('createDuplexController(...) is not exported');
    }
    return loaded as unknown as DuplexModule;
  })();
  return duplexModulePromise;
}

type FixtureTemplate = Readonly<{
  transcript: string;
  durationMs: number;
  asrConfidence: number;
  confirmationPending?: boolean;
  newRequestFollows?: boolean;
}>;

type FixtureClass = Readonly<{
  label: BargeInOutcome;
  count: number;
  evidenceDelayMs: number;
  templates: ReadonlyArray<FixtureTemplate>;
}>;

type DuplexFixture = Readonly<{
  id: string;
  version: number;
  consent: string;
  totalExchanges: number;
  routes: ReadonlyArray<DuplexRoute>;
  pattern: ReadonlyArray<BargeInOutcome>;
  onset: Readonly<{ baseMs: number; stepMs: number; cycle: number }>;
  prosody: Readonly<{
    energyDb: readonly [number, number];
    voicedRatio: readonly [number, number];
    pitchSpanSemitones: readonly [number, number];
  }>;
  classes: ReadonlyArray<FixtureClass>;
}>;

type Exchange = Readonly<{
  id: string;
  route: DuplexRoute;
  /** Ground truth from the fixture classes; never passed to the controller. */
  label: BargeInOutcome;
  onsetMs: number;
  /** Delay from acoustic onset to the classification evidence (or the stop-spotter event). */
  evidenceDelayMs: number;
  evidence: UserSpeechEvidence;
}>;

type OutputEvent = Readonly<{
  kind: 'duck' | 'restore' | 'pause' | 'stop';
  atMs: number;
  /** Level in dB for `duck`, fade in ms for `restore`, 0 otherwise. */
  value: number;
}>;

type FakeOutput = DuplexOutputPort & Readonly<{
  events: OutputEvent[];
  state(): DuplexOutputState;
  epoch(): number;
  /** Test-harness side: a new narration plan becomes audible at `cursorMs`. */
  startNarration(cursorMs: number): void;
}>;

type FakeAgent = Readonly<{
  port: DuplexAgentPort;
  interrupts: Array<Readonly<{ turnId: string; reason: string }>>;
  turn: { turnId: string; state: 'running' | 'interrupted' };
}>;

async function settle(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

function createManualClock(startMs = 0): Readonly<{
  clock: Readonly<{ now(): number }>;
  now(): number;
  advanceTo(ms: number): number;
}> {
  let now = startMs;
  return {
    clock: { now: () => now },
    now: () => now,
    advanceTo: (ms: number) => {
      assert.ok(ms >= now, `the monotonic clock must not rewind (${ms} < ${now})`);
      now = ms;
      return now;
    },
  };
}

function createFakeOutput(clock: Readonly<{ now(): number }>): FakeOutput {
  const events: OutputEvent[] = [];
  let state: DuplexOutputState = 'idle';
  let cursor = 0;
  let epoch = 0;
  const record = (kind: OutputEvent['kind'], value: number): void => {
    events.push({ kind, atMs: clock.now(), value });
  };
  return {
    speaking: () => state === 'speaking' || state === 'ducked',
    cursorMs: () => cursor,
    duck: (levelDb) => { record('duck', levelDb); state = 'ducked'; },
    restore: (fadeMs) => { record('restore', fadeMs); state = 'speaking'; },
    pause: () => { record('pause', 0); state = 'paused'; },
    stop: () => { record('stop', 0); state = 'stopped'; epoch += 1; },
    events,
    state: () => state,
    epoch: () => epoch,
    startNarration: (cursorMs) => { cursor = cursorMs; epoch += 1; state = 'speaking'; },
  };
}

function createFakeAgent(turnId = 'turn-42'): FakeAgent {
  const interrupts: Array<Readonly<{ turnId: string; reason: string }>> = [];
  const turn = { turnId, state: 'running' as 'running' | 'interrupted' };
  const port: DuplexAgentPort = {
    interrupt: async (request) => {
      interrupts.push({ turnId: request.turnId, reason: request.reason });
      if (request.turnId === turn.turnId) turn.state = 'interrupted';
      return 'acknowledged';
    },
  };
  return { port, interrupts, turn };
}

function sampleRange(index: number, [min, max]: readonly [number, number]): number {
  const steps = 15;
  const ratio = ((index * 7) % (steps + 1)) / steps;
  return Math.round((min + ratio * (max - min)) * 10) / 10;
}

function expandExchanges(fixture: DuplexFixture): ReadonlyArray<Exchange> {
  const classes = new Map(fixture.classes.map((entry) => [entry.label, entry]));
  const remaining = new Map(fixture.classes.map((entry) => [entry.label, entry.count]));
  const used = new Map<BargeInOutcome, number>();
  const exchanges: Exchange[] = [];
  let passes = 0;
  while (exchanges.length < fixture.totalExchanges) {
    const beforePass = exchanges.length;
    for (const label of fixture.pattern) {
      if (exchanges.length >= fixture.totalExchanges) break;
      const quota = remaining.get(label) ?? 0;
      const classSpec = classes.get(label);
      if (quota <= 0 || classSpec === undefined) continue;
      const route = fixture.routes[exchanges.length % fixture.routes.length];
      const templateIndex = used.get(label) ?? 0;
      const template = classSpec.templates[templateIndex % classSpec.templates.length];
      assert.ok(route !== undefined, 'the fixture must declare at least one route');
      assert.ok(template !== undefined, `the fixture "${label}" class must declare templates`);
      const index = exchanges.length;
      const id = `dx-${String(index + 1).padStart(3, '0')}`;
      exchanges.push({
        id,
        route,
        label,
        onsetMs: fixture.onset.baseMs + (index % fixture.onset.cycle) * fixture.onset.stepMs,
        evidenceDelayMs: classSpec.evidenceDelayMs,
        evidence: Object.freeze({
          utteranceId: id,
          route,
          durationMs: template.durationMs,
          transcript: template.transcript,
          asrConfidence: template.asrConfidence,
          prosody: Object.freeze({
            energyDb: sampleRange(index, fixture.prosody.energyDb),
            voicedRatio: sampleRange(index + 3, fixture.prosody.voicedRatio),
            pitchSpanSemitones: sampleRange(index + 5, fixture.prosody.pitchSpanSemitones),
          }),
          confirmationPending: template.confirmationPending ?? false,
          newRequestFollows: template.newRequestFollows ?? false,
        }),
      });
      used.set(label, templateIndex + 1);
      remaining.set(label, quota - 1);
    }
    assert.ok(exchanges.length > beforePass, 'the fixture pattern cannot satisfy the declared counts');
    passes += 1;
    assert.ok(passes <= fixture.totalExchanges, 'the fixture must fill exactly totalExchanges');
  }
  return exchanges;
}

async function loadCorpus(): Promise<ReadonlyArray<Exchange>> {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as DuplexFixture;
  assert.equal(fixture.id, 'v03-held-out-exchanges', 'the frozen corpus has a stable identity');
  assert.equal(fixture.version, 1);
  assert.equal(fixture.consent, 'synthetic', 'the corpus stores no user audio');
  const declared = fixture.classes.reduce((total, entry) => total + entry.count, 0);
  assert.equal(declared, fixture.totalExchanges, 'class counts must fill the declared corpus size');
  const exchanges = expandExchanges(fixture);
  assert.equal(exchanges.length, CORPUS_SIZE, 'the held-out subset is 200 exchanges');
  const counts = { backchannel: 0, explicit_stop: 0, interruption: 0, uncertain: 0 };
  for (const exchange of exchanges) counts[exchange.label] += 1;
  assert.deepEqual(
    counts,
    { backchannel: 100, explicit_stop: 25, interruption: 50, uncertain: 25 },
    'the held-out subset keeps a representative mix of overlapping speech',
  );
  assert.equal(
    exchanges.filter((exchange) => exchange.route === 'speaker').length,
    CORPUS_SIZE / 2,
    'the subset covers the speaker and headphone routes of the reference machine',
  );
  return exchanges;
}

type ExchangeRun = Readonly<{
  exchange: Exchange;
  decision: DuplexDecision;
  outputState: DuplexOutputState;
  cursorMs: number;
  epoch: number;
  events: ReadonlyArray<OutputEvent>;
}>;

async function runExchange(duplexModule: DuplexModule, exchange: Exchange): Promise<ExchangeRun> {
  assert.deepEqual(
    Object.keys(exchange.evidence).sort(),
    [
      'asrConfidence',
      'confirmationPending',
      'durationMs',
      'newRequestFollows',
      'prosody',
      'route',
      'transcript',
      'utteranceId',
    ],
    `${exchange.id}: the controller only ever sees evidence, never the held-out label`,
  );
  const timeline = createManualClock();
  const output = createFakeOutput(timeline.clock);
  const agent = createFakeAgent();
  const duplex = duplexModule.createDuplexController({
    clock: timeline.clock,
    output,
    agent: agent.port,
  });

  output.startNarration(NARRATION_CURSOR_MS);
  timeline.advanceTo(exchange.onsetMs);
  duplex.noteSpeechOnset({
    utteranceId: exchange.evidence.utteranceId,
    route: exchange.route,
    atMs: timeline.now(),
  });
  await settle();

  const ducks = output.events.filter((event) => event.kind === 'duck');
  assert.equal(ducks.length, 1, `${exchange.id}: a non-echo onset must duck output exactly once`);
  const duck = ducks[0];
  assert.ok(duck, `${exchange.id}: the onset duck must be recorded`);
  assert.equal(duck.value, DUCK_LEVEL_DB, `${exchange.id}: Section 5.5.1 ducks by ${DUCK_LEVEL_DB} dB`);
  assert.ok(
    duck.atMs - exchange.onsetMs <= DUCK_DEADLINE_MS,
    `${exchange.id}: onset → duck must stay within ${DUCK_DEADLINE_MS} ms (took ${duck.atMs - exchange.onsetMs} ms)`,
  );
  assert.equal(output.cursorMs(), NARRATION_CURSOR_MS, `${exchange.id}: ducking preserves the playback cursor`);

  timeline.advanceTo(exchange.onsetMs + exchange.evidenceDelayMs);
  const decision = await duplex.submitUserSpeech(exchange.evidence);
  await settle();

  assert.equal(
    decision.utteranceId,
    exchange.evidence.utteranceId,
    `${exchange.id}: the decision answers the utterance it was given`,
  );
  assert.equal(
    decision.output,
    output.state(),
    `${exchange.id}: decision.output must match what the device was actually told to do`,
  );
  assert.equal(
    decision.decidedAtMs,
    timeline.now(),
    `${exchange.id}: the decision is stamped with the injected monotonic clock`,
  );

  return {
    exchange,
    decision,
    outputState: output.state(),
    cursorMs: output.cursorMs(),
    epoch: output.epoch(),
    events: output.events.slice(),
  };
}

let corpusPromise: Promise<ReadonlyArray<ExchangeRun>> | undefined;

function runCorpus(): Promise<ReadonlyArray<ExchangeRun>> {
  corpusPromise ??= (async () => {
    const duplexModule = await loadDuplexModule();
    const exchanges = await loadCorpus();
    const runs: ExchangeRun[] = [];
    for (const exchange of exchanges) runs.push(await runExchange(duplexModule, exchange));
    return runs;
  })();
  return corpusPromise;
}

function p95(samples: ReadonlyArray<number>): number {
  assert.ok(samples.length > 0, 'p95 needs at least one sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.ceil(0.95 * sorted.length) - 1];
  assert.ok(value !== undefined, 'the nearest-rank p95 sample must exist');
  return value;
}

test('explicit stop and ordinary interruption meet the Section 4.4 targets over the 200-exchange subset', { timeout: 120_000 }, async () => {
  const runs = await runCorpus();
  assert.equal(runs.length, CORPUS_SIZE);

  // Acoustic onset → initial duck, every exchange of the speaker/headphone subset.
  const duckLatencies = runs.map((run) => {
    const duck = run.events.find((event) => event.kind === 'duck');
    assert.ok(duck, `${run.exchange.id}: onset must duck output`);
    return duck.atMs - run.exchange.onsetMs;
  });
  assert.ok(
    Math.max(...duckLatencies) <= DUCK_DEADLINE_MS,
    `onset → duck must meet ${DUCK_DEADLINE_MS} ms for every exchange (worst ${Math.max(...duckLatencies)} ms)`,
  );
  assert.ok(p95(duckLatencies) <= DUCK_DEADLINE_MS, `onset → duck p95 is ${p95(duckLatencies)} ms`);

  // Explicit stop: the spotter event starts the 200 ms silence budget.
  const stops = runs.filter((run) => run.exchange.label === 'explicit_stop');
  assert.equal(stops.length, 25);
  const recognizedStops = stops.filter((run) => run.decision.outcome === 'explicit_stop');
  const stopLatencies: number[] = [];
  for (const run of recognizedStops) {
    const stop = run.events.find((event) => event.kind === 'stop');
    assert.ok(stop, `${run.exchange.id}: an explicit stop flushes the queue, it is not only a duck`);
    stopLatencies.push(stop.atMs - (run.exchange.onsetMs + run.exchange.evidenceDelayMs));
    assert.equal(run.outputState, 'stopped', `${run.exchange.id}: an explicit stop leaves output silent`);
    assert.equal(run.epoch, 2, `${run.exchange.id}: an explicit stop cancels the generation epoch`);
    assert.equal(run.decision.committed, true, `${run.exchange.id}: the stop utterance is still committed for routing`);
  }
  assert.ok(
    recognizedStops.length >= Math.ceil(EXPLICIT_STOP_RECOGNITION_FLOOR * stops.length),
    `explicit stop phrases must be recognized: ${recognizedStops.length}/${stops.length}`,
  );
  assert.ok(
    Math.max(...stopLatencies) <= EXPLICIT_STOP_DEADLINE_MS,
    `explicit stop → silence must meet ${EXPLICIT_STOP_DEADLINE_MS} ms (worst ${Math.max(...stopLatencies)} ms)`,
  );
  assert.ok(
    p95(stopLatencies) <= EXPLICIT_STOP_DEADLINE_MS,
    `explicit stop → silence p95 is ${p95(stopLatencies)} ms`,
  );
  for (const run of stops) {
    const silence = run.events.find((event) => event.kind === 'stop' || event.kind === 'pause');
    assert.ok(silence, `${run.exchange.id}: explicit stop speech must silence narration`);
    assert.ok(
      silence.atMs - run.exchange.onsetMs <= BARGE_IN_DEADLINE_MS,
      `${run.exchange.id}: even an unrecognized stop phrase must silence within ${BARGE_IN_DEADLINE_MS} ms of onset`,
    );
  }

  // Ordinary barge-in: classification to silence inside the 350 ms budget.
  const interruptions = runs.filter((run) => run.exchange.label === 'interruption');
  assert.equal(interruptions.length, 50);
  let silencedInterruptions = 0;
  for (const run of interruptions) {
    const silence = run.events.find((event) => event.kind === 'pause' || event.kind === 'stop');
    if (silence !== undefined && silence.atMs - run.exchange.onsetMs <= BARGE_IN_DEADLINE_MS) {
      silencedInterruptions += 1;
    }
  }
  assert.ok(
    silencedInterruptions >= Math.floor(BACKCHANNEL_PRECISION_TARGET * interruptions.length),
    `ordinary barge-in must reach silence within ${BARGE_IN_DEADLINE_MS} ms for at least 95% of interruptions `
      + `(got ${silencedInterruptions}/${interruptions.length})`,
  );

  // Uncertain speech pauses output inside the same barge-in budget.
  const uncertain = runs.filter((run) => run.exchange.label === 'uncertain');
  assert.equal(uncertain.length, 25);
  const pausedUncertain = uncertain.filter((run) => {
    const pause = run.events.find((event) => event.kind === 'pause');
    return pause !== undefined && pause.atMs - run.exchange.onsetMs <= BARGE_IN_DEADLINE_MS;
  });
  assert.ok(
    pausedUncertain.length >= Math.ceil(UNCERTAIN_PAUSE_FLOOR * uncertain.length),
    `uncertain speech must pause output within ${BARGE_IN_DEADLINE_MS} ms of onset `
      + `(got ${pausedUncertain.length}/${uncertain.length})`,
  );
});

test('backchannel precision stays ≥95% on the held-out exchanges and uncertain speech pauses output', { timeout: 120_000 }, async () => {
  const runs = await runCorpus();
  const predictedBackchannels = runs.filter((run) => run.decision.outcome === 'backchannel');
  const trueBackchannels = runs.filter((run) => run.exchange.label === 'backchannel');
  const truePositives = predictedBackchannels.filter((run) => run.exchange.label === 'backchannel').length;
  const falsePositives = predictedBackchannels.length - truePositives;
  const falseNegatives = trueBackchannels.length - truePositives;

  assert.ok(
    predictedBackchannels.length > 0,
    'backchannels must be recognized at all: the held-out precision denominator is empty',
  );
  const precision = truePositives / predictedBackchannels.length;
  const recall = truePositives / trueBackchannels.length;
  assert.ok(
    precision >= BACKCHANNEL_PRECISION_TARGET,
    `backchannel precision must be ≥${BACKCHANNEL_PRECISION_TARGET}: got ${(precision * 100).toFixed(1)}% `
      + `(${truePositives} true, ${falsePositives} false of ${predictedBackchannels.length} predicted)`,
  );
  assert.ok(
    recall >= BACKCHANNEL_RECALL_FLOOR,
    `backchannel recall floor ${BACKCHANNEL_RECALL_FLOOR}: got ${(recall * 100).toFixed(1)}% (${falseNegatives} missed)`,
  );

  // A recognized backchannel restores the preserved cursor with a 40 ms fade and routes nothing.
  for (const run of predictedBackchannels) {
    const restore = run.events.find((event) => event.kind === 'restore');
    assert.ok(restore, `${run.exchange.id}: a backchannel restores output instead of flushing it`);
    assert.equal(restore.value, RESTORE_FADE_MS, `${run.exchange.id}: Section 5.5.4 restores over ${RESTORE_FADE_MS} ms`);
    assert.ok(
      restore.atMs - run.exchange.onsetMs <= BARGE_IN_DEADLINE_MS,
      `${run.exchange.id}: the backchannel decision must land inside the 350 ms budget`,
    );
    assert.equal(run.outputState, 'speaking', `${run.exchange.id}: narration continues after a backchannel`);
    assert.equal(run.cursorMs, NARRATION_CURSOR_MS, `${run.exchange.id}: a backchannel keeps the resumption cursor`);
    assert.equal(run.epoch, 1, `${run.exchange.id}: a backchannel must not cancel the generation epoch`);
    assert.equal(run.decision.resumeCursorMs, NARRATION_CURSOR_MS, `${run.exchange.id}: continuation resumes at the preserved cursor`);
    assert.equal(run.decision.committed, false, `${run.exchange.id}: a backchannel is never committed as a request`);
  }

  // Uncertain evidence must pause output on every exchange, in the distinct uncertain state.
  const uncertain = runs.filter((run) => run.exchange.label === 'uncertain');
  assert.equal(uncertain.length, 25);
  let pausedAsUncertain = 0;
  for (const run of uncertain) {
    assert.notEqual(
      run.decision.outcome,
      'backchannel',
      `${run.exchange.id}: uncertain speech must pause output, not be treated as a backchannel`,
    );
    assert.equal(run.decision.committed, true, `${run.exchange.id}: uncertain speech is committed for routing`);
    const pause = run.events.find((event) => event.kind === 'pause');
    assert.ok(pause, `${run.exchange.id}: uncertain speech pauses output`);
    assert.equal(run.outputState, 'paused', `${run.exchange.id}: uncertain output stays paused, not idle`);
    assert.equal(run.epoch, 1, `${run.exchange.id}: pausing keeps the generation epoch for the later continuation`);
    if (run.decision.outcome === 'uncertain') pausedAsUncertain += 1;
  }
  assert.ok(
    pausedAsUncertain >= Math.ceil(UNCERTAIN_STATE_FLOOR * uncertain.length),
    `uncertain speech must reach the distinct paused state: ${pausedAsUncertain}/${uncertain.length}`,
  );
});

test('"stop speaking" leaves managed execution running and only a routed agent-control request interrupts it', { timeout: 20_000 }, async () => {
  const duplexModule = await loadDuplexModule();
  const timeline = createManualClock();
  const output = createFakeOutput(timeline.clock);
  const agent = createFakeAgent('turn-42');
  const duplex = duplexModule.createDuplexController({ clock: timeline.clock, output, agent: agent.port });

  // The spoken stop control silences narration and cancels its generation epoch.
  output.startNarration(NARRATION_CURSOR_MS);
  timeline.advanceTo(1_000);
  duplex.noteSpeechOnset({ utteranceId: 'u-stop', route: 'speaker', atMs: timeline.now() });
  await settle();
  assert.ok(output.events.some((event) => event.kind === 'duck'), 'overlapping speech ducks narration first');
  assert.equal(output.cursorMs(), NARRATION_CURSOR_MS, 'ducking preserves the playback cursor');

  timeline.advanceTo(1_120);
  const stopDecision = await duplex.submitUserSpeech({
    utteranceId: 'u-stop',
    route: 'speaker',
    durationMs: 900,
    transcript: 'stop speaking',
    asrConfidence: 0.97,
    prosody: { energyDb: -33.4, voicedRatio: 0.51, pitchSpanSemitones: 2.6 },
    confirmationPending: false,
    newRequestFollows: false,
  });
  await settle();
  assert.equal(stopDecision.outcome, 'explicit_stop', '"stop speaking" is an explicit stop');
  assert.equal(stopDecision.committed, true, 'the stop utterance is accounted for by routing');
  const stopEvent = output.events.find((event) => event.kind === 'stop');
  assert.ok(stopEvent, 'an explicit stop flushes output');
  assert.ok(
    stopEvent.atMs - 1_120 <= EXPLICIT_STOP_DEADLINE_MS,
    `explicit stop → silence must stay within ${EXPLICIT_STOP_DEADLINE_MS} ms`,
  );
  assert.equal(output.epoch(), 2, 'the explicit stop cancels the generation epoch');
  assert.equal(output.state(), 'stopped');
  assert.equal(duplex.status().output, 'stopped');

  // Managed execution continues: stopping the narration is not stopping the turn.
  assert.equal(agent.interrupts.length, 0, '"stop speaking" must not interrupt managed execution');
  assert.deepEqual(agent.turn, { turnId: 'turn-42', state: 'running' });

  // A later narration plays while the same managed turn keeps running.
  output.startNarration(NARRATION_CURSOR_MS + 5_800);
  timeline.advanceTo(3_000);
  duplex.noteSpeechOnset({ utteranceId: 'u-question', route: 'headphones', atMs: timeline.now() });
  await settle();
  timeline.advanceTo(3_300);
  const question = await duplex.submitUserSpeech({
    utteranceId: 'u-question',
    route: 'headphones',
    durationMs: 2_100,
    transcript: 'wait, what changed in the parser',
    asrConfidence: 0.92,
    prosody: { energyDb: -30.6, voicedRatio: 0.62, pitchSpanSemitones: 3.8 },
    confirmationPending: false,
    newRequestFollows: true,
  });
  await settle();
  assert.equal(question.outcome, 'interruption');
  assert.equal(question.committed, true, 'the interruption is committed for addressee routing');
  assert.equal(output.state(), 'paused');
  assert.equal(agent.interrupts.length, 0, 'speech that routes to the companion must not interrupt managed work');
  assert.deepEqual(agent.turn, { turnId: 'turn-42', state: 'running' });

  // Only the separate routed agent-control request reaches the harness, and only once.
  const receipt = await duplex.submitAgentControl({
    requestId: 'ctl-1',
    turnId: 'turn-42',
    reason: 'user_requested_interrupt',
  });
  assert.deepEqual(
    agent.interrupts,
    [{ turnId: 'turn-42', reason: 'user_requested_interrupt' }],
    'the routed request is delivered to the active managed turn',
  );
  assert.deepEqual(receipt, { requestId: 'ctl-1', turnId: 'turn-42', status: 'acknowledged' });
  assert.deepEqual(agent.turn, { turnId: 'turn-42', state: 'interrupted' });

  const redelivered = await duplex.submitAgentControl({
    requestId: 'ctl-1',
    turnId: 'turn-42',
    reason: 'user_requested_interrupt',
  });
  assert.equal(agent.interrupts.length, 1, 'a redelivered routed request must not interrupt twice');
  assert.deepEqual(redelivered, receipt, 'a redelivery resolves the same observed receipt');
});
