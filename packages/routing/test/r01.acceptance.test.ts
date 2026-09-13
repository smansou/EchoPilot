/**
 * R01 acceptance oracle — spoken follow-up → memory answer / named-agent instruction → delivery
 * receipt (IMPLEMENTATION_PLAN.md §5.6; BACKLOG R01).
 *
 * The oracle drives the frozen seam with deterministic doubles: a synthetic memory store, a
 * recording HarnessAdapter per managed session, and a speak() recorder standing in for the
 * attention-gated VoiceSession. A real managed Codex child cannot be qualified in this automated
 * environment; the adapter/protocol leg is H01's oracle (packages/harness-codex/test), and this
 * file observes the delivered-instruction leg at the same packages/contracts HarnessAdapter seam
 * the real Codex adapter implements.
 *
 * Frozen seam (this file pins these names):
 *
 * packages/routing/src/index.ts
 *   export const AUTO_DISPATCH_MIN_CONFIDENCE = 0.95
 *     Plan §5.6: "Auto-dispatch requires calibrated probability ≥0.95 and the ≥99% precision
 *     evaluation gate."
 *
 *   export function createAddresseeRouter({ sessions }) → AddresseeRouter
 *     sessions — the active managed sessions:
 *       { sessionId, harness: 'codex'|'claude'|'generic', label, projectId?, active }
 *     AddresseeRouter:
 *       setActiveSessions(sessions) — replaces the active session set.
 *       route({ utteranceId, text, asrConfidence?, partial? }) → packages/contracts RouteDecision
 *         { utteranceId, destination, targetSessionId?, confidence, basis, requiresClarification }
 *     Behavior fixed here (plan §5.6 precedence 3/6):
 *       - "Tell Codex"/"Tell Claude" plus a session name that uniquely matches one active session
 *         resolves to that session: destination 'harness', targetSessionId set,
 *         requiresClarification false, basis 'explicit_prefix',
 *         confidence ≥ AUTO_DISPATCH_MIN_CONFIDENCE.
 *       - A harness name matching two active sessions, or any destination that is not unique,
 *         yields requiresClarification true with no targetSessionId and no auto-dispatch.
 *       - Questions with no addressee default to the companion: destination 'companion',
 *         requiresClarification false, no auto-dispatch.
 *       - partial: true utterances never auto-dispatch, even when the transcript looks complete.
 *
 * packages/core/src/dialogue/index.ts
 *   export function createDialogueSession({ router, memory, adapters, speak, scope, now? })
 *     → DialogueSession
 *     router   — AddresseeRouter above
 *     memory   — packages/contracts Memory
 *     adapters — ReadonlyMap<sessionId, HarnessAdapter> for the active sessions
 *     speak    — (plan: SpeechPlan) => Promise<ReadonlyArray<VoiceOutputEvent>>; the only path
 *                that produces audio
 *     scope    — Scope for memory queries and durable records
 *     now      — () => Date, default () => new Date()
 *
 *     DialogueSession:
 *       handleUtterance({ utteranceId, text, asrConfidence?, partial? }) → DialogueTurn
 *         DialogueTurn = {
 *           decision: RouteDecision,
 *           clarification?: string,
 *           dispatch?: { deliveryId, sessionId, instruction },
 *           receipt?: HarnessDeliveryReceipt,
 *         }
 *       outbox() → ReadonlyArray<OutboxRecord>
 *         OutboxRecord = { deliveryId, idempotencyKey, sessionId, state, updatedAt }
 *         states (plan §5.6): 'prepared' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'unknown'
 *
 *     Behavior fixed here:
 *       - A companion question queries memory with the spoken question in the session scope and
 *         speaks the answer as SpeechPlan segment(s) whose evidenceIds are non-empty and drawn
 *         from the evidence memory returned; the answer restates content from the returned
 *         summary (the oracle requires one shared content word). Companion questions stay local:
 *         no adapter send and no outbox record.
 *       - A dispatchable harness instruction persists an outbox record (state 'prepared' with a
 *         stable idempotencyKey) before adapter.send(instruction, deliveryId) is called; the
 *         delivered instruction is the utterance with the addressee prefix removed
 *         ("Tell Codex to add a regression test" → "add a regression test").
 *       - After the adapter returns an observed receipt the outbox record reaches that state
 *         ('acknowledged') and the session speaks an acknowledgment after the send: one short
 *         segment (≤ 240 characters) naming the target session. The acknowledgment reports the
 *         observed receipt only; it never claims execution completed.
 *       - A clarification turn speaks exactly one concise question (≤ 240 characters) naming the
 *         ambiguous destination, calls no adapter, and creates no outbox record.
 *       - partial ASR and ambient acknowledgments ('yes', 'okay', 'go ahead') trigger no adapter
 *         send and no outbox record.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type {
  EventEnvelope,
  HarnessAdapter,
  HarnessCapability,
  HarnessDeliveryReceipt,
  Memory,
  RouteDecision,
  Scope,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../contracts/src/index.js';

const FIXTURE_URL = new URL('../../../fixtures/routing/r01-held-out-utterances.json', import.meta.url);
const ROUTER_MODULE = '../src/index.js';
const DIALOGUE_MODULE = '../../core/src/dialogue/index.js';
/** Plan §5.6 calibrated auto-dispatch probability, asserted equal to the exported constant. */
const AUTO_DISPATCH_CONFIDENCE = 0.95;
/** "Concise clarification" and acknowledgment budget for a single spoken reply. */
const MAX_REPLY_CHARACTERS = 240;

type Harness = 'codex' | 'claude' | 'generic';

type RoutingSession = Readonly<{
  sessionId: string;
  harness: Harness;
  label: string;
  projectId?: string;
  active: boolean;
}>;

type RoutingUtterance = Readonly<{
  utteranceId: string;
  text: string;
  asrConfidence?: number;
  partial?: boolean;
}>;

type AddresseeRouter = Readonly<{
  setActiveSessions(sessions: ReadonlyArray<RoutingSession>): void;
  route(utterance: RoutingUtterance): RouteDecision;
}>;

type AddresseeRouterFactory = (options: Readonly<{ sessions: ReadonlyArray<RoutingSession> }>) => AddresseeRouter;

type OutboxState = 'prepared' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'unknown';

type OutboxRecord = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  sessionId: string;
  state: OutboxState;
  updatedAt: string;
}>;

type DialogueTurn = Readonly<{
  decision: RouteDecision;
  clarification?: string;
  dispatch?: Readonly<{ deliveryId: string; sessionId: string; instruction: string }>;
  receipt?: HarnessDeliveryReceipt;
}>;

type DialogueSession = Readonly<{
  handleUtterance(utterance: RoutingUtterance): Promise<DialogueTurn>;
  outbox(): ReadonlyArray<OutboxRecord>;
}>;

type Speak = (plan: SpeechPlan) => Promise<ReadonlyArray<VoiceOutputEvent>>;

type DialogueSessionFactory = (options: Readonly<{
  router: AddresseeRouter;
  memory: Memory;
  adapters: ReadonlyMap<string, HarnessAdapter>;
  speak: Speak;
  scope: Scope;
  now?: () => Date;
}>) => DialogueSession;

type LabelledCase = Readonly<{ key: string; text: string; asrConfidence: number; partial?: boolean }>;
type UnsafeCase = LabelledCase & Readonly<{ reason: 'partial_asr' | 'ambient_acknowledgment' }>;
type DispatchCase = Readonly<{ key: string; text: string; sessionId: string }>;

type RoutingFixture = Readonly<{
  sessions: ReadonlyArray<RoutingSession>;
  dispatch: Readonly<{
    templates: ReadonlyArray<string>;
    names: ReadonlyArray<Readonly<{ text: string; sessionId: string }>>;
    tasks: ReadonlyArray<string>;
    expectedCount: number;
  }>;
  clarification: Readonly<{ expectedCount: number; cases: ReadonlyArray<LabelledCase> }>;
  companion: Readonly<{ expectedCount: number; cases: ReadonlyArray<LabelledCase> }>;
  unsafe: Readonly<{ expectedCount: number; cases: ReadonlyArray<UnsafeCase> }>;
  dialogueScenario: Readonly<{
    scope: Scope;
    sessions: ReadonlyArray<RoutingSession>;
    memorySummary: string;
    memoryEvidence: ReadonlyArray<EventEnvelope>;
    question: Readonly<{ utteranceId: string; text: string; asrConfidence: number }>;
    instruction: Readonly<{
      utteranceId: string;
      text: string;
      asrConfidence: number;
      expectedTargetSessionId: string;
      expectedInstruction: string;
    }>;
  }>;
}>;

type ModuleNamespace = Record<string, unknown>;

/** Loads a yet-to-be-implemented module, turning "module missing" into a named behavior failure. */
async function importModule(specifier: string, missingBehavior: string): Promise<ModuleNamespace> {
  try {
    return (await import(specifier)) as ModuleNamespace;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(missingBehavior);
    }
    throw error;
  }
}

async function routingModule(): Promise<ModuleNamespace> {
  const loaded = await importModule(
    ROUTER_MODULE,
    'Missing required behavior: packages/routing/src/index.ts must export createAddresseeRouter() so '
    + 'a spoken addressee resolves to the companion, a named managed session, dictation, desktop, or '
    + 'a clarification before anything dispatches (plan §5.6).',
  );
  assert.equal(typeof loaded.createAddresseeRouter, 'function', 'packages/routing must export createAddresseeRouter()');
  return loaded;
}

async function routerFactory(): Promise<AddresseeRouterFactory> {
  return (await routingModule()).createAddresseeRouter as AddresseeRouterFactory;
}

async function autoDispatchConfidence(): Promise<number> {
  const loaded = await routingModule();
  assert.equal(
    loaded.AUTO_DISPATCH_MIN_CONFIDENCE,
    AUTO_DISPATCH_CONFIDENCE,
    'packages/routing must export AUTO_DISPATCH_MIN_CONFIDENCE = 0.95 (plan §5.6)',
  );
  return AUTO_DISPATCH_CONFIDENCE;
}

async function dialogueFactory(): Promise<DialogueSessionFactory> {
  const loaded = await importModule(
    DIALOGUE_MODULE,
    'Missing required behavior: packages/core/src/dialogue/index.ts must export createDialogueSession() '
    + 'so a companion question is answered from memory and a named-agent instruction is persisted and '
    + 'delivered with an observed acknowledgment (plan §5.6).',
  );
  assert.equal(typeof loaded.createDialogueSession, 'function', 'packages/core/src/dialogue must export createDialogueSession()');
  return loaded.createDialogueSession as DialogueSessionFactory;
}

async function loadFixture(): Promise<RoutingFixture> {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as RoutingFixture;
}

type LogEntry = Readonly<{ kind: 'send' | 'speak'; detail: string }>;
type SendRecord = Readonly<{
  sessionId: string;
  instruction: string;
  deliveryId: string;
  outboxAtSend: ReadonlyArray<OutboxRecord>;
}>;

function utteranceFrom(testCase: LabelledCase, utteranceId: string): RoutingUtterance {
  return {
    utteranceId,
    text: testCase.text,
    asrConfidence: testCase.asrConfidence,
    ...(testCase.partial === undefined ? {} : { partial: testCase.partial }),
  };
}

function createMemoryDouble(
  evidenceIds: ReadonlyArray<string>,
  summary: string,
): Readonly<{ memory: Memory; queries: Array<Readonly<{ query: string; scope: Scope; budget: number }>> }> {
  const queries: Array<Readonly<{ query: string; scope: Scope; budget: number }>> = [];
  const memory: Memory = {
    async ingest(): Promise<Readonly<{ value: string }>> {
      return { value: 'r01-synthetic-cursor' };
    },
    async query(query: string, scope: Scope, budget: number) {
      queries.push({ query, scope, budget });
      return { evidenceIds: [...evidenceIds], summary };
    },
    async consolidate(cursor) {
      return { checkpoint: cursor.value };
    },
    async forget() {
      return { deleted: 0 };
    },
  };
  return { memory, queries };
}

function createSpeakRecorder(log: LogEntry[]): Readonly<{ speak: Speak; plans: SpeechPlan[] }> {
  const plans: SpeechPlan[] = [];
  const speak: Speak = async (plan) => {
    plans.push(plan);
    log.push({ kind: 'speak', detail: plan.segments.map((segment) => segment.text).join(' ') });
    return plan.segments.map((segment) => ({
      planId: plan.planId,
      segmentId: segment.id,
      positionMs: 0,
      status: 'completed' as const,
    }));
  };
  return { speak, plans };
}

function createAdapterDouble(options: Readonly<{
  sessionId: string;
  status: HarnessDeliveryReceipt['status'];
  log: LogEntry[];
  outboxAtSend: () => ReadonlyArray<OutboxRecord>;
}>): Readonly<{ adapter: HarnessAdapter; sends: SendRecord[] }> {
  const sends: SendRecord[] = [];
  const capabilities: ReadonlySet<HarnessCapability> = new Set<HarnessCapability>(
    options.status === 'acknowledged' ? ['observe', 'send'] : ['observe'],
  );
  const adapter: HarnessAdapter = {
    async capabilities(): Promise<ReadonlySet<HarnessCapability>> {
      return capabilities;
    },
    async start(): Promise<void> {},
    async *observe(): AsyncIterable<EventEnvelope> {},
    async send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
      sends.push({ sessionId: options.sessionId, instruction, deliveryId, outboxAtSend: options.outboxAtSend() });
      options.log.push({ kind: 'send', detail: `${options.sessionId} ${deliveryId} ${instruction}` });
      return { deliveryId, status: options.status };
    },
    async interrupt(): Promise<void> {},
    async respondApproval(): Promise<void> {},
    async resume(): Promise<void> {},
    async close(): Promise<void> {},
  };
  return { adapter, sends };
}

function isAutoDispatch(decision: RouteDecision): boolean {
  return decision.destination === 'harness'
    && !decision.requiresClarification
    && typeof decision.targetSessionId === 'string'
    && decision.targetSessionId.length > 0;
}

function describeDecision(decision: RouteDecision): string {
  return JSON.stringify(decision);
}

function planText(plan: SpeechPlan): string {
  return plan.segments.map((segment) => segment.text).join(' ').trim();
}

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

function expandDispatchCases(fixture: RoutingFixture): DispatchCase[] {
  const cases: DispatchCase[] = [];
  for (const template of fixture.dispatch.templates) {
    for (const name of fixture.dispatch.names) {
      for (const task of fixture.dispatch.tasks) {
        const text = template.replace('{name}', name.text).replace('{task}', task);
        cases.push({ key: `${name.sessionId}:${text}`, text, sessionId: name.sessionId });
      }
    }
  }
  return cases;
}

test('R01 seam: the addressee router and dialogue session export the frozen contract', async () => {
  assert.equal(typeof await routerFactory(), 'function');
  assert.equal(typeof await dialogueFactory(), 'function');
  assert.equal(await autoDispatchConfidence(), AUTO_DISPATCH_CONFIDENCE);
});

test('R01 AC1: grounded spoken answer, then "Tell Codex to add a regression test" yields an observed delivery acknowledgment', async () => {
  const fixture = await loadFixture();
  const scenario = fixture.dialogueScenario;
  const createRouter = await routerFactory();
  const createDialogue = await dialogueFactory();
  const router = createRouter({ sessions: scenario.sessions });
  const memoryIds = scenario.memoryEvidence.map((event) => event.eventId);
  const { memory, queries } = createMemoryDouble(memoryIds, scenario.memorySummary);
  const log: LogEntry[] = [];
  const { speak, plans } = createSpeakRecorder(log);
  const doubles: Array<Readonly<{ adapter: HarnessAdapter; sends: SendRecord[] }>> = [];
  const adapters = new Map<string, HarnessAdapter>();
  let dialogue: DialogueSession | undefined;
  for (const session of scenario.sessions) {
    const double = createAdapterDouble({
      sessionId: session.sessionId,
      status: 'acknowledged',
      log,
      outboxAtSend: () => dialogue?.outbox() ?? [],
    });
    doubles.push(double);
    adapters.set(session.sessionId, double.adapter);
  }
  dialogue = createDialogue({
    router,
    memory,
    adapters,
    speak,
    scope: scenario.scope,
    now: () => new Date('2026-09-13T09:20:00.000Z'),
  });
  const session = dialogue;
  const codex = doubles[0];
  const claude = doubles[1];
  assert.ok(codex && claude);
  const totalSends = (): number => doubles.reduce((total, double) => total + double.sends.length, 0);

  // Turn 1 — "what happened?" must be answered from memory, aloud, and stay local.
  const answer = await session.handleUtterance({
    utteranceId: scenario.question.utteranceId,
    text: scenario.question.text,
    asrConfidence: scenario.question.asrConfidence,
  });
  assert.equal(answer.decision.destination, 'companion', 'a companion question must stay local');
  assert.equal(answer.decision.requiresClarification, false);
  assert.equal(totalSends(), 0, 'a companion question must not reach any agent session');
  assert.equal(session.outbox().length, 0, 'a companion question must not create an outbox record');
  assert.equal(queries.length, 1, 'the companion answer must query memory exactly once');
  const query = queries[0];
  assert.ok(query, 'memory query was captured');
  assert.match(query.query.toLowerCase(), /happened/, 'memory must be queried with the spoken question');
  assert.ok(Number.isInteger(query.budget) && query.budget > 0, 'the memory query needs a positive evidence budget');
  assert.equal(plans.length, 1, 'the grounded answer must be spoken');
  const answerPlan = plans[0];
  assert.ok(answerPlan, 'a SpeechPlan was submitted for the companion answer');
  assert.ok(
    answerPlan.segments.length > 0 && answerPlan.segments.every((segment) => segment.text.trim().length > 0),
    'the grounded answer must contain spoken text',
  );
  const cited = answerPlan.segments.flatMap((segment) => [...segment.evidenceIds]);
  assert.ok(cited.length > 0, 'the spoken answer must cite memory evidence ids');
  for (const evidenceId of cited) {
    assert.ok(
      memoryIds.includes(evidenceId),
      `the spoken answer cites ${evidenceId}, which memory did not return`,
    );
  }
  const answerWords = contentWords(planText(answerPlan));
  const sharedWords = [...contentWords(scenario.memorySummary)].filter((word) => answerWords.has(word));
  assert.ok(
    sharedWords.length > 0,
    `the spoken answer must restate grounded content from the returned summary: "${planText(answerPlan)}"`,
  );

  // Turn 2 — "Tell Codex ..." must persist the delivery, deliver the instruction, and acknowledge.
  const instruction = await session.handleUtterance({
    utteranceId: scenario.instruction.utteranceId,
    text: scenario.instruction.text,
    asrConfidence: scenario.instruction.asrConfidence,
  });
  assert.equal(instruction.decision.destination, 'harness');
  assert.equal(instruction.decision.targetSessionId, scenario.instruction.expectedTargetSessionId);
  assert.equal(instruction.decision.requiresClarification, false);
  assert.equal(codex.sends.length, 1, 'exactly one instruction reaches the named Codex session');
  assert.equal(claude.sends.length, 0, 'the unnamed Claude session must not receive the instruction');
  const send = codex.sends[0];
  assert.ok(send, 'the adapter recorded the send');
  assert.equal(
    send.instruction,
    scenario.instruction.expectedInstruction,
    'the addressee prefix must be stripped from the delivered instruction',
  );
  assert.ok(instruction.dispatch, 'the turn reports the dispatch it performed');
  assert.equal(instruction.dispatch.deliveryId, send.deliveryId);
  assert.equal(instruction.dispatch.sessionId, scenario.instruction.expectedTargetSessionId);
  assert.equal(instruction.dispatch.instruction, send.instruction);
  assert.ok(instruction.receipt, 'the turn reports the observed delivery receipt');
  assert.equal(instruction.receipt.deliveryId, send.deliveryId);
  assert.equal(instruction.receipt.status, 'acknowledged');
  assert.ok(
    send.outboxAtSend.some((record) => record.deliveryId === send.deliveryId && record.state === 'prepared'),
    'the outbox record must be persisted before adapter.send is called',
  );
  const record = session.outbox().find((entry) => entry.deliveryId === send.deliveryId);
  assert.ok(record, 'the delivery must be persisted in the outbox');
  assert.equal(record.state, 'acknowledged');
  assert.equal(record.sessionId, scenario.instruction.expectedTargetSessionId);
  assert.ok(record.idempotencyKey.length > 0, 'a stable idempotency key is required');

  assert.equal(plans.length, 2, 'the observed delivery must be acknowledged aloud');
  const acknowledgment = plans[1];
  assert.ok(acknowledgment, 'an acknowledgment SpeechPlan was submitted');
  const sendIndex = log.findIndex((entry) => entry.kind === 'send');
  const acknowledgmentIndex = log.length - 1 - [...log].reverse().findIndex((entry) => entry.kind === 'speak');
  assert.ok(sendIndex >= 0, 'the adapter send was logged');
  assert.ok(
    acknowledgmentIndex > sendIndex,
    'the acknowledgment must be spoken only after the adapter observed the delivery',
  );
  const acknowledgmentText = planText(acknowledgment);
  assert.ok(
    acknowledgmentText.length > 0 && acknowledgmentText.length <= MAX_REPLY_CHARACTERS,
    `the acknowledgment must stay short: "${acknowledgmentText}"`,
  );
  assert.match(acknowledgmentText.toLowerCase(), /codex/, 'the acknowledgment must name the target session');
  assert.doesNotMatch(
    acknowledgmentText.toLowerCase(),
    /\b(completed|finished|succeeded|passed)\b/,
    'an acknowledged handoff must not claim the work already completed',
  );
});

test('R01 AC2: ambiguous destinations clarify concisely and dispatch nothing', async () => {
  const fixture = await loadFixture();
  const createRouter = await routerFactory();
  const createDialogue = await dialogueFactory();
  const router = createRouter({ sessions: fixture.sessions });
  const { memory } = createMemoryDouble([], 'No grounded evidence for this synthetic turn.');
  const log: LogEntry[] = [];
  const { speak, plans } = createSpeakRecorder(log);
  const doubles: Array<Readonly<{ adapter: HarnessAdapter; sends: SendRecord[] }>> = [];
  const adapters = new Map<string, HarnessAdapter>();
  let dialogue: DialogueSession | undefined;
  for (const session of fixture.sessions) {
    const double = createAdapterDouble({
      sessionId: session.sessionId,
      status: 'acknowledged',
      log,
      outboxAtSend: () => dialogue?.outbox() ?? [],
    });
    doubles.push(double);
    adapters.set(session.sessionId, double.adapter);
  }
  dialogue = createDialogue({
    router,
    memory,
    adapters,
    speak,
    scope: fixture.dialogueScenario.scope,
    now: () => new Date('2026-09-13T09:25:00.000Z'),
  });
  const session = dialogue;
  const totalSends = (): number => doubles.reduce((total, double) => total + double.sends.length, 0);
  const samples = ['two-codex-no-name', 'two-claude-no-name', 'no-session-named']
    .map((key) => fixture.clarification.cases.find((candidate) => candidate.key === key));
  assert.ok(samples.every((sample) => sample !== undefined), 'ambiguity samples exist in the fixture');

  for (const [index, sample] of samples.entries()) {
    assert.ok(sample, 'ambiguity sample');
    const before = plans.length;
    const turn = await session.handleUtterance(utteranceFrom(sample, `r01-clarify-${index}`));
    assert.equal(turn.decision.requiresClarification, true, `ambiguous destination must clarify: "${sample.text}"`);
    assert.equal(
      turn.decision.targetSessionId,
      undefined,
      `clarification must not select a session: "${sample.text}"`,
    );
    assert.equal(totalSends(), 0, `clarification must not dispatch: "${sample.text}"`);
    assert.equal(session.outbox().length, 0, `clarification must not persist an outbox record: "${sample.text}"`);
    assert.equal(plans.length, before + 1, `clarification must be spoken: "${sample.text}"`);
    const plan = plans[plans.length - 1];
    assert.ok(plan, 'clarification SpeechPlan');
    assert.equal(plan.segments.length, 1, `clarification must be one concise question: "${sample.text}"`);
    const text = planText(plan);
    assert.ok(
      text.length > 0 && text.length <= MAX_REPLY_CHARACTERS,
      `clarification must stay concise: "${text}"`,
    );
    assert.match(
      text.toLowerCase(),
      /codex|parser|tests|claude|session/,
      `clarification must name the ambiguous destination: "${text}"`,
    );
    assert.ok(
      typeof turn.clarification === 'string'
      && turn.clarification.trim().length > 0
      && turn.clarification.length <= MAX_REPLY_CHARACTERS,
      `the turn must report the concise clarification: "${String(turn.clarification)}"`,
    );
  }
});

test('R01 AC3: held-out corpus keeps auto-dispatch precision at or above 99%', async (t) => {
  const fixture = await loadFixture();
  const threshold = await autoDispatchConfidence();
  const createRouter = await routerFactory();
  const router = createRouter({ sessions: fixture.sessions });
  const dispatchCases = expandDispatchCases(fixture);
  assert.equal(
    dispatchCases.length,
    fixture.dispatch.expectedCount,
    'dispatch corpus expansion drifted from the fixture count',
  );
  assert.equal(fixture.clarification.cases.length, fixture.clarification.expectedCount);
  assert.equal(fixture.companion.cases.length, fixture.companion.expectedCount);
  assert.equal(fixture.unsafe.cases.length, fixture.unsafe.expectedCount);

  const failures: string[] = [];
  let dispatches = 0;
  let correct = 0;

  for (const testCase of dispatchCases) {
    const decision = router.route({
      utteranceId: `route:${testCase.key}`,
      text: testCase.text,
      asrConfidence: 0.97,
    });
    if (!isAutoDispatch(decision)) {
      failures.push(`explicit addressee did not auto-dispatch: "${testCase.text}" → ${describeDecision(decision)}`);
      continue;
    }
    dispatches += 1;
    if (decision.targetSessionId === testCase.sessionId) correct += 1;
    else failures.push(`dispatched to ${String(decision.targetSessionId)} instead of ${testCase.sessionId}: "${testCase.text}"`);
    if (decision.confidence < threshold) {
      failures.push(`auto-dispatch below the calibrated threshold (${decision.confidence} < ${threshold}): "${testCase.text}"`);
    }
    if (decision.basis !== 'explicit_prefix') {
      failures.push(`explicit addressee must resolve as 'explicit_prefix', got '${String(decision.basis)}': "${testCase.text}"`);
    }
  }

  for (const testCase of fixture.clarification.cases) {
    const decision = router.route(utteranceFrom(testCase, `clarify:${testCase.key}`));
    if (isAutoDispatch(decision) || decision.requiresClarification !== true) {
      failures.push(`ambiguous destination must clarify without dispatch: "${testCase.text}" → ${describeDecision(decision)}`);
    }
    if (decision.targetSessionId !== undefined) {
      failures.push(`ambiguous destination must not select a session: "${testCase.text}" → ${String(decision.targetSessionId)}`);
    }
  }

  for (const testCase of fixture.companion.cases) {
    const decision = router.route(utteranceFrom(testCase, `companion:${testCase.key}`));
    if (decision.destination !== 'companion' || isAutoDispatch(decision)) {
      failures.push(`companion-default question must stay local: "${testCase.text}" → ${describeDecision(decision)}`);
    }
    if (decision.requiresClarification) {
      failures.push(`companion-default question must not ask for a destination: "${testCase.text}"`);
    }
  }

  for (const testCase of fixture.unsafe.cases) {
    const decision = router.route(utteranceFrom(testCase, `unsafe:${testCase.key}`));
    if (isAutoDispatch(decision)) {
      failures.push(`unsafe ${testCase.reason} utterance auto-dispatched: "${testCase.text}" → ${describeDecision(decision)}`);
    }
  }

  assert.equal(failures.length, 0, `held-out routing failures:\n${failures.slice(0, 10).join('\n')}`);
  assert.equal(dispatches, fixture.dispatch.expectedCount, 'every explicit addressee case must auto-dispatch');
  const precision = dispatches === 0 ? 0 : correct / dispatches;
  const corpusSize = dispatchCases.length + fixture.clarification.cases.length
    + fixture.companion.cases.length + fixture.unsafe.cases.length;
  t.diagnostic(
    `held-out auto-dispatch precision ${correct}/${dispatches} = ${precision.toFixed(3)} `
    + `across ${corpusSize} synthetic utterances`,
  );
  assert.ok(precision >= 0.99, `auto-dispatch precision ${precision} must stay at or above 0.99`);
});

test('R01 AC3: partial ASR and ambient acknowledgments trigger no dispatch and no outbox record', async () => {
  const fixture = await loadFixture();
  const createRouter = await routerFactory();
  const createDialogue = await dialogueFactory();
  const router = createRouter({ sessions: fixture.sessions });
  const scenario = fixture.dialogueScenario;
  const { memory } = createMemoryDouble(
    scenario.memoryEvidence.map((event) => event.eventId),
    scenario.memorySummary,
  );
  const log: LogEntry[] = [];
  const { speak } = createSpeakRecorder(log);
  const doubles: Array<Readonly<{ adapter: HarnessAdapter; sends: SendRecord[] }>> = [];
  const adapters = new Map<string, HarnessAdapter>();
  let dialogue: DialogueSession | undefined;
  for (const session of fixture.sessions) {
    const double = createAdapterDouble({
      sessionId: session.sessionId,
      status: 'acknowledged',
      log,
      outboxAtSend: () => dialogue?.outbox() ?? [],
    });
    doubles.push(double);
    adapters.set(session.sessionId, double.adapter);
  }
  dialogue = createDialogue({
    router,
    memory,
    adapters,
    speak,
    scope: scenario.scope,
    now: () => new Date('2026-09-13T09:30:00.000Z'),
  });
  const session = dialogue;
  const totalSends = (): number => doubles.reduce((total, double) => total + double.sends.length, 0);

  for (const [index, testCase] of fixture.unsafe.cases.entries()) {
    const turn = await session.handleUtterance(utteranceFrom(testCase, `r01-unsafe-${index}`));
    assert.equal(
      isAutoDispatch(turn.decision),
      false,
      `unsafe ${testCase.reason} utterance must not auto-dispatch: "${testCase.text}"`,
    );
    assert.equal(
      totalSends(),
      0,
      `unsafe ${testCase.reason} utterance must not reach any adapter: "${testCase.text}"`,
    );
    assert.equal(
      session.outbox().length,
      0,
      `unsafe ${testCase.reason} utterance must not persist an outbox record: "${testCase.text}"`,
    );
  }
});
