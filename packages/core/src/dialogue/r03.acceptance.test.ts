/**
 * R03 acceptance oracle (criterion 3, report half) — "Stop all reports which managed turns
 * acknowledged interruption and which external work may still be running"
 * (IMPLEMENTATION_PLAN.md §5.6 precedence 1; BACKLOG R03).
 *
 * packages/routing/src/state/ decides that "stop all" is the precedence-1 emergency control:
 * destination 'control' with control 'stop_all' (pinned by
 * packages/routing/src/state/r03.acceptance.test.ts). This file pins what the dialogue session
 * must do with that decision, so a bounded dialogue never claims to have stopped work it did not.
 *
 * Seam pinned here — packages/core/src/dialogue/index.ts, createDialogueSession(options):
 *
 *   The options gain two accessors, read when stop all runs (never snapshotted at construction,
 *   because the set of turns in flight changes while the session lives):
 *     managedTurns?: () => ReadonlyArray<{ sessionId: string; turnId: string }>
 *       the managed harness turns currently in flight, e.g. H04 registry records with a recorded
 *       turnId (packages/core/src/session-registry/index.ts recordTurn).
 *     externalWork?: () => ReadonlyArray<{ sessionId: string; detail: string }>
 *       work outside the managed adapters (external processes) that stop all cannot interrupt.
 *
 *   DialogueTurn gains:
 *     stopAll?: {
 *       managed: ReadonlyArray<{
 *         sessionId: string;
 *         turnId: string;
 *         interruption: 'acknowledged' | 'unconfirmed';
 *         reason?: string;   // required non-empty when 'unconfirmed', so the miss explains itself
 *       }>;
 *       external: ReadonlyArray<{
 *         sessionId: string;
 *         detail: string;
 *         mayStillBeRunning: true;
 *       }>;
 *     }
 *
 *   Behavior fixed here, for a turn whose decision is a control 'stop_all' (the shape the routing
 *   state returns for "stop all", "Stop all.", "stop all now", …):
 *     R03-C3a Every managed turn is interrupted exactly once through that session's adapter
 *              (HarnessAdapter.interrupt(turnId)); a rejected interrupt does not abort the sweep
 *              and is reported 'unconfirmed' with a reason. 'acknowledged' is reported only when
 *              that turn's own interrupt resolved, and every declared external work item is
 *              reported with mayStillBeRunning true. Stop all dispatches nothing.
 *     R03-C3b "stop speaking" and "mute" are speech controls: they interrupt no managed turn and
 *              report no interrupted managed turn; "stop all" does (R03: agent-versus-speech stop).
 *     R03-C3c The report covers the turns in flight at the moment stop all runs, not the set seen
 *              when the session was built, and invents neither managed turns nor external work.
 *
 * Deterministic: recording HarnessAdapter doubles and a Memory double; no hardware, no network.
 * Remaining limitation: real audio (the audible half of the plan's "closes audio", TTS playback
 * through VoiceSession) is qualified by V02/V03 and cannot be asserted here; this oracle pins the
 * deterministic report the dialogue session returns, and packages/routing's oracle pins the
 * control decision that triggers it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EventEnvelope,
  HarnessAdapter,
  HarnessCapability,
  Memory,
  RouteDecision,
  Scope,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../../contracts/src/index.js';

const DIALOGUE_MODULE = './index.js';

/** The route "stop all" produces in packages/routing/src/state/ (see that ticket's oracle). */
type ControlKind = 'stop_all' | 'stop_speaking' | 'pause' | 'mute';
type R03ControlDecision = RouteDecision & Readonly<{ control: ControlKind }>;

type Utterance = Readonly<{
  utteranceId: string;
  text: string;
  asrConfidence?: number;
  partial?: boolean;
}>;

type ManagedTurn = Readonly<{ sessionId: string; turnId: string }>;
type ExternalWork = Readonly<{ sessionId: string; detail: string }>;

type StopAllManagedEntry = Readonly<{
  sessionId: string;
  turnId: string;
  interruption: 'acknowledged' | 'unconfirmed';
  reason?: string;
}>;

type StopAllExternalEntry = Readonly<{
  sessionId: string;
  detail: string;
  mayStillBeRunning: true;
}>;

type StopAllReport = Readonly<{
  managed: ReadonlyArray<StopAllManagedEntry>;
  external: ReadonlyArray<StopAllExternalEntry>;
}>;

type DialogueTurn = Readonly<{
  decision: RouteDecision;
  clarification?: string;
  dispatch?: Readonly<{ deliveryId: string; sessionId: string; instruction: string }>;
  /** R03 criterion 3: present on a stop-all control turn. */
  stopAll?: StopAllReport;
}>;

type DialogueSession = Readonly<{
  handleUtterance(utterance: Utterance): Promise<DialogueTurn>;
  outbox(): ReadonlyArray<unknown>;
}>;

type DialogueRouterStub = Readonly<{ route(utterance: Utterance): RouteDecision }>;

type Speak = (plan: SpeechPlan) => Promise<ReadonlyArray<VoiceOutputEvent>>;

type DialogueSessionOptions = Readonly<{
  router: DialogueRouterStub;
  memory: Memory;
  adapters: ReadonlyMap<string, HarnessAdapter>;
  speak: Speak;
  scope: Scope;
  now?: () => Date;
  /** R03: the managed turns in flight when stop all runs. */
  managedTurns?: () => ReadonlyArray<ManagedTurn>;
  /** R03: work outside the managed adapters that stop all cannot interrupt. */
  externalWork?: () => ReadonlyArray<ExternalWork>;
}>;

type DialogueSessionFactory = (options: DialogueSessionOptions) => DialogueSession;

const STOP_ALL_SEAM =
  'packages/core/src/dialogue/index.ts must make a control stop_all turn call '
  + 'HarnessAdapter.interrupt(turnId) for every managed turn from managedTurns() and return '
  + 'turn.stopAll = { managed: [{ sessionId, turnId, interruption: "acknowledged" | "unconfirmed", '
  + 'reason? }], external: [{ sessionId, detail, mayStillBeRunning: true }] }';

/** Loads the dialogue seam; a missing module or export is reported as missing R03 behavior. */
async function dialogueFactory(): Promise<DialogueSessionFactory> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(DIALOGUE_MODULE)) as unknown as Record<string, unknown>;
  } catch (error) {
    assert.fail(`R03 required stop-all reporting is not implemented yet: ${STOP_ALL_SEAM}. Importing ${DIALOGUE_MODULE} failed: ${(error as Error).message}`);
  }
  const factory = loaded.createDialogueSession;
  if (typeof factory !== 'function') {
    assert.fail(`R03 required stop-all reporting is not implemented yet: ${STOP_ALL_SEAM}. createDialogueSession is not exported`);
  }
  return factory as DialogueSessionFactory;
}

/** Turns "the report is missing" into a named red failure instead of a TypeError. */
function requireStopAllReport(turn: DialogueTurn, where: string): StopAllReport {
  const report = turn.stopAll;
  if (report === undefined) {
    assert.fail(`R03 required stop-all reporting is not implemented yet: ${STOP_ALL_SEAM}. Missing on ${where}`);
  }
  return report;
}

type AdapterDouble = Readonly<{
  adapter: HarnessAdapter;
  interruptedTurnIds: string[];
  sentInstructions: string[];
}>;

/** Recording HarnessAdapter double: interrupt() either resolves or rejects, per behavior. */
function createAdapter(behavior: 'acknowledge' | 'reject'): AdapterDouble {
  const interruptedTurnIds: string[] = [];
  const sentInstructions: string[] = [];
  const adapter: HarnessAdapter = {
    capabilities: async (): Promise<ReadonlySet<HarnessCapability>> =>
      new Set<HarnessCapability>(['observe', 'send', 'interrupt']),
    start: async (): Promise<void> => undefined,
    observe: (): AsyncIterable<EventEnvelope> => (async function* empty(): AsyncGenerator<EventEnvelope> {})(),
    send: async (instruction: string, deliveryId: string) => {
      sentInstructions.push(instruction);
      return { deliveryId, status: 'acknowledged' as const };
    },
    interrupt: async (turnId: string): Promise<void> => {
      interruptedTurnIds.push(turnId);
      if (behavior === 'reject') throw new Error(`turn ${turnId} is not responding`);
    },
    respondApproval: async (): Promise<void> => undefined,
    resume: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  };
  return { adapter, interruptedTurnIds, sentInstructions };
}

function createMemoryDouble(): Readonly<{ memory: Memory; queries: string[] }> {
  const queries: string[] = [];
  return {
    queries,
    memory: {
      ingest: async () => ({ value: 'r03-cursor' }),
      query: async (query: string) => {
        queries.push(query);
        return { evidenceIds: [], summary: '' };
      },
      consolidate: async () => ({ checkpoint: 'r03-checkpoint' }),
      forget: async () => ({ deleted: 0 }),
    },
  };
}

const SCOPE: Scope = { profileId: 'r03-oracle', projectId: 'atlas', sensitivity: 'normal' };

/**
 * Builds a dialogue session whose router returns the routing state's control decision for the
 * utterance (the way "stop all", "stop speaking", and "mute" arrive from packages/routing).
 */
function createHarness(options: Readonly<{
  createDialogueSession: DialogueSessionFactory;
  control: ControlKind;
  adapters: ReadonlyMap<string, HarnessAdapter>;
  managedTurns?: () => ReadonlyArray<ManagedTurn>;
  externalWork?: () => ReadonlyArray<ExternalWork>;
}>): Readonly<{ session: DialogueSession; memory: ReturnType<typeof createMemoryDouble>; plans: SpeechPlan[] }> {
  const memory = createMemoryDouble();
  const plans: SpeechPlan[] = [];
  const router: DialogueRouterStub = {
    route: (utterance: Utterance): R03ControlDecision => ({
      utteranceId: utterance.utteranceId,
      destination: 'control',
      confidence: 0.99,
      basis: 'explicit_prefix',
      requiresClarification: false,
      control: options.control,
    }),
  };
  const session = options.createDialogueSession({
    router,
    memory: memory.memory,
    adapters: options.adapters,
    speak: async (plan: SpeechPlan): Promise<ReadonlyArray<VoiceOutputEvent>> => {
      plans.push(plan);
      return [];
    },
    scope: SCOPE,
    now: (): Date => new Date('2026-09-21T03:00:00.000Z'),
    ...(options.managedTurns === undefined ? {} : { managedTurns: options.managedTurns }),
    ...(options.externalWork === undefined ? {} : { externalWork: options.externalWork }),
  });
  return { session, memory, plans };
}

test('R03-C3a stop all interrupts every managed turn and reports acknowledged vs unconfirmed honestly', async () => {
  const createDialogueSession = await dialogueFactory();
  const runner = createAdapter('reject');
  const parser = createAdapter('acknowledge');
  const adapters = new Map<string, HarnessAdapter>([
    ['codex-runner', runner.adapter],
    ['codex-parser', parser.adapter],
  ]);
  const managedTurns: ReadonlyArray<ManagedTurn> = [
    { sessionId: 'codex-runner', turnId: 'turn-runner-3' },
    { sessionId: 'codex-parser', turnId: 'turn-parser-7' },
  ];
  const externalWork: ReadonlyArray<ExternalWork> = [
    { sessionId: 'desktop-export', detail: 'an export started before stop all' },
  ];
  const harness = createHarness({
    createDialogueSession,
    control: 'stop_all',
    adapters,
    managedTurns: () => managedTurns,
    externalWork: () => externalWork,
  });

  const turn = await harness.session.handleUtterance({ utteranceId: 'r03-c3a', text: 'stop all', asrConfidence: 0.98 });
  assert.equal(turn.decision.destination, 'control', 'stop all stays a local control turn');
  const report = requireStopAllReport(turn, 'the "stop all" turn');

  assert.deepEqual(runner.interruptedTurnIds, ['turn-runner-3'], 'the rejecting turn is interrupted exactly once');
  assert.deepEqual(
    parser.interruptedTurnIds,
    ['turn-parser-7'],
    'an interrupt that rejects must not abort the sweep over the remaining managed turns',
  );
  assert.deepEqual(
    report.managed.map((entry) => `${entry.sessionId}:${entry.turnId}:${entry.interruption}`).sort(),
    ['codex-parser:turn-parser-7:acknowledged', 'codex-runner:turn-runner-3:unconfirmed'],
    'every managed turn is reported once with the outcome its own interrupt produced',
  );
  const unconfirmed = report.managed.find((entry) => entry.sessionId === 'codex-runner');
  assert.equal(unconfirmed?.interruption, 'unconfirmed', 'a rejected interrupt is never reported as acknowledged');
  assert.ok(
    (unconfirmed?.reason ?? '').trim().length > 0,
    'an unacknowledged interruption carries a non-empty reason instead of silently dropping the turn',
  );

  assert.deepEqual(
    report.external.map((entry) => `${entry.sessionId}:${entry.detail}`),
    ['desktop-export:an export started before stop all'],
    'external work is reported with its identity and detail',
  );
  for (const entry of report.external) {
    assert.equal(entry.mayStillBeRunning, true, 'external work is reported as possibly still running, never as stopped');
  }
  assert.deepEqual(harness.memory.queries, [], 'stop all asks no memory question');
  assert.equal(harness.session.outbox().length, 0, 'stop all persists no delivery');
  assert.deepEqual(parser.sentInstructions, [], 'stop all sends no instruction');
  assert.deepEqual(runner.sentInstructions, [], 'stop all sends no instruction to the unresponsive session either');
});

test('R03-C3b stop speaking and mute never interrupt managed harness turns while stop all does', async () => {
  const createDialogueSession = await dialogueFactory();
  const parser = createAdapter('acknowledge');
  const adapters = new Map<string, HarnessAdapter>([['codex-parser', parser.adapter]]);
  const managedTurns: ReadonlyArray<ManagedTurn> = [{ sessionId: 'codex-parser', turnId: 'turn-parser-7' }];

  for (const [control, text] of [['stop_speaking', 'stop speaking'], ['mute', 'mute']] as const) {
    const harness = createHarness({
      createDialogueSession,
      control,
      adapters,
      managedTurns: () => managedTurns,
    });
    const turn = await harness.session.handleUtterance({ utteranceId: `r03-c3b-${control}`, text, asrConfidence: 0.98 });
    assert.equal(turn.decision.destination, 'control', `"${text}" stays a local control turn`);
    assert.deepEqual(parser.interruptedTurnIds, [], `"${text}" must not interrupt managed agent work`);
    assert.equal(
      turn.stopAll?.managed.length ?? 0,
      0,
      `"${text}" is a speech control and reports no interrupted managed turn`,
    );
    assert.equal(harness.session.outbox().length, 0, `"${text}" persists no delivery`);
  }

  const stop = createHarness({
    createDialogueSession,
    control: 'stop_all',
    adapters,
    managedTurns: () => managedTurns,
  });
  const stopTurn = await stop.session.handleUtterance({ utteranceId: 'r03-c3b-stop-all', text: 'stop all', asrConfidence: 0.98 });
  requireStopAllReport(stopTurn, 'the "stop all" turn after the speech controls');
  assert.deepEqual(parser.interruptedTurnIds, ['turn-parser-7'], 'stop all does interrupt the managed turn');
});

test('R03-C3c stop all reports the turns in flight when it runs and invents no external work', async () => {
  const createDialogueSession = await dialogueFactory();
  const parser = createAdapter('acknowledge');
  const runner = createAdapter('acknowledge');
  const adapters = new Map<string, HarnessAdapter>([
    ['codex-parser', parser.adapter],
    ['codex-runner', runner.adapter],
  ]);
  let managedTurns: ReadonlyArray<ManagedTurn> = [{ sessionId: 'codex-parser', turnId: 'turn-stale' }];
  let externalWork: ReadonlyArray<ExternalWork> = [];
  const harness = createHarness({
    createDialogueSession,
    control: 'stop_all',
    adapters,
    managedTurns: () => managedTurns,
    externalWork: () => externalWork,
  });

  managedTurns = [{ sessionId: 'codex-runner', turnId: 'turn-live' }];
  const first = await harness.session.handleUtterance({ utteranceId: 'r03-c3c-1', text: 'stop all', asrConfidence: 0.98 });
  const report = requireStopAllReport(first, 'the first "stop all" turn');
  assert.deepEqual(parser.interruptedTurnIds, [], 'a turn replaced before stop all runs is not interrupted');
  assert.deepEqual(runner.interruptedTurnIds, ['turn-live'], 'the turn in flight when stop all runs is interrupted');
  assert.deepEqual(
    report.managed.map((entry) => `${entry.sessionId}:${entry.turnId}:${entry.interruption}`),
    ['codex-runner:turn-live:acknowledged'],
    'the report covers the managed turns in flight at stop-all time',
  );
  assert.deepEqual(report.external, [], 'stop all invents no external work when none is declared');

  managedTurns = [];
  externalWork = [{ sessionId: 'external-build', detail: 'a CI build started outside the managed sessions' }];
  const second = await harness.session.handleUtterance({ utteranceId: 'r03-c3c-2', text: 'stop all', asrConfidence: 0.98 });
  const secondReport = requireStopAllReport(second, 'the second "stop all" turn');
  assert.deepEqual(
    secondReport.managed.map((entry) => `${entry.sessionId}:${entry.turnId}:${entry.interruption}`),
    [],
    'no managed turn in flight means nothing is reported as interrupted',
  );
  assert.deepEqual(runner.interruptedTurnIds, ['turn-live'], 'stop all never re-interrupts a turn that is no longer in flight');
  assert.deepEqual(
    secondReport.external.map((entry) => `${entry.sessionId}:${entry.detail}`),
    ['external-build:a CI build started outside the managed sessions'],
    'work that stop all cannot reach is still reported',
  );
  assert.equal(secondReport.external[0]?.mayStillBeRunning, true, 'external work stays flagged as possibly running');
});
