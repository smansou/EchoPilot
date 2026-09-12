/**
 * M02 acceptance test — live event batch → local extraction → bounded context → grounded answer
 * (IMPLEMENTATION_PLAN.md §5.8 memory schema/consolidation/bounded context; ticket M02 in §6).
 *
 * No implementation exists yet in packages/memory/src/context/, packages/memory/src/consolidation/,
 * or native/macos/Sources/Reasoner/, so this red baseline reports the missing behavior as explicit
 * named assertions instead of failing as a bare module-resolution crash, exactly like the
 * M01/Q01/S01 red baselines.
 *
 * Frozen contract
 * ---------------
 * packages/memory/src/context/index.ts
 *   CONTEXT_CEILING_TOKENS = 8192
 *   boundedBudget({ modelId, contextCapacity }) → { modelId, capacity, ceiling, outputReservation, input }
 *     ceiling = min(CONTEXT_CEILING_TOKENS, floor(0.25 * contextCapacity)); a model without a
 *     declared, positive, finite capacity is rejected. On the normal 32K-or-larger route
 *     outputReservation = 2,048 and input = 6,144; smaller capacities scale both down.
 *   createContextAssembler({ tokenizer, imageTokens }) → { assemble(request) → AssembledContext }
 *     The one owner of shared context budgeting: every other feature consumes this API instead of
 *     inventing its own compaction loop. `assemble` counts each admitted part with the supplied
 *     exact tokenizer, charges tool schemas plus their call wrapper, charges images with the
 *     processor's own `imageTokens` calculation (never zero), reserves the output allowance, and
 *     returns:
 *       { modelId, maxTokens, outputReservation, inputTokens, totalTokens,
 *         accounting: { system, request, cards, dialogue, evidence, images, tools, reserve, output },
 *         evidenceIds, prompt, coverage: 'complete' | 'partial' }
 *     totalTokens === inputTokens + accounting.output === the sum of all accounting sections and is
 *     always ≤ maxTokens ≤ B. Text sections count their content with the exact tokenizer; wrappers,
 *     separators, and formatting overhead belong to `reserve`. request inputs: { model, instruction,
 *     request?, card?, dialogue?, evidence?, images?, tools?, compactDialogue? }. Dialogue that does
 *     not fit is only admitted through `compactDialogue`; a hook that throws (deliberately failed
 *     compaction) drops the unadmitted dialogue, keeps the deterministic card, still returns
 *     totalTokens ≤ maxTokens and sets coverage 'partial'.
 *
 * packages/memory/src/consolidation/index.ts
 *   createMemoryConsolidator({ projectId, directory, store, reasoner, assembler, model })
 *     → Promise<MemoryConsolidator>
 *     store     — the M01 MemoryStore; its read API is the raw log and its ids are source event ids.
 *     directory — durable root shared with the store: extracted facts/decisions, segment/session/
 *                 project cards, coverage, and the consolidation watermark live here and survive a
 *                 restart.
 *     reasoner  — the F01 Reasoner contract. Live extraction requests carry an outputSchema whose
 *                 title is 'memory.extraction'; grounded-answer requests carry 'memory.answer'. The
 *                 second argument is the context module's AssembledContext, so every request carries
 *                 its measured accounting and can be checked against B.
 *   MemoryConsolidator:
 *     consolidate() → { checkpoint, coverage }
 *         Runs the pending segment jobs for events after the durable watermark. A second call with
 *         no new events is a no-op: same checkpoint, no model call, no duplicate records.
 *     facts() → [{ id, subject, predicate, object, status, sourceEventIds }]
 *     decisions() → [{ id, question, choice, status, sourceEventIds }]
 *     card('segment' | 'session' | 'project') → string | undefined (bounded by 500 / 800 / 1200
 *         tokens per §5.8)
 *     coverage() → { semantic: 'complete' | 'partial', failedJobs }
 *     answer({ question }) → { text, supported, evidenceIds, coverage, maxTokens, usedTokens }
 *         Builds a bounded EvidenceBundle from consolidated state and asks the Reasoner for a dated
 *         project answer. The answer is grounded: every reported evidence id was presented in the
 *         bounded context. Model output that is unparseable, empty, or cites evidence that was not
 *         presented is never returned as the answer; the deterministic factual template built from
 *         stored cards/decisions replaces it.
 *     close()
 *   Failure behavior: invalid JSON gets its one repair attempt; after that, or after a model crash,
 *   the deterministic factual template is used, coverage becomes 'partial', and repeated calls over
 *   unchanged state return identical results that survive a restart.
 *
 * The bundled Qwen3.5-4B worker in native/macos/Sources/Reasoner/ is exercised through this same
 * frozen Reasoner seam by a scripted stand-in: proving the bounded-context and grounding behavior
 * this ticket owns needs no model weights, download, or paid call.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMemoryStore, type MemoryStore, type NormalizedBatch } from '../store/index.js';
import type { NormalizedEvent } from '../reducers/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/memory/live/atlas-session.json', import.meta.url);
/** Synthetic key material; this fixture is the only thing the store ever sees. */
const STORE_KEY = '5f0e1d2c3b4a59687f6e5d4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908';
/** The normal 32K-or-larger route from §5.8: B = min(8192, floor(0.25 * 32768)) = 8192. */
const MODEL = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 } as const;
/** An answer may inspect a bounded evidence set; the 300-turn raw log must stay out of it. */
const ANSWER_READ_BOUND = 32;
const FABRICATED_EVIDENCE_ID = 'evt-atlas-fabricated-999';

type LiveFixture = {
  contractVersion: number;
  fixtureId: string;
  profileId: string;
  projectId: string;
  worktreeId: string;
  sessionId: string;
  question: { text: string; expectedEvidenceEventId: string; expectedAnswerCanary: string };
  padding: {
    turns: number;
    canary: string;
    startedAt: string;
    eventIdPrefix: string;
    payloadRefPrefix: string;
    sourceSequenceBase: number;
    sentence: string;
  };
  events: NormalizedEvent[];
  payloads: Record<string, unknown>;
};

type Budget = {
  modelId: string;
  capacity: number;
  ceiling: number;
  outputReservation: number;
  input: number;
};

type AssembledContext = {
  modelId: string;
  maxTokens: number;
  outputReservation: number;
  inputTokens: number;
  totalTokens: number;
  accounting: Readonly<Record<string, number>>;
  evidenceIds: readonly string[];
  prompt: string;
  coverage: 'complete' | 'partial';
};

type DialogueItem = { id: string; text: string };
type AssembleRequest = {
  model: { modelId: string; contextCapacity: number };
  instruction: string;
  request?: string;
  card?: string;
  dialogue?: readonly DialogueItem[];
  evidence?: readonly { id: string; text: string }[];
  images?: readonly { id: string; width: number; height: number }[];
  tools?: readonly { name: string; schema: unknown }[];
  compactDialogue?: (dialogue: readonly DialogueItem[]) => Promise<readonly DialogueItem[]>;
};

type ContextModule = {
  CONTEXT_CEILING_TOKENS: number;
  boundedBudget(model: { modelId: string; contextCapacity: number }): Budget;
  createContextAssembler(options: {
    tokenizer: { count(text: string): number };
    imageTokens(descriptor: { id: string; width: number; height: number }): number;
  }): { assemble(request: AssembleRequest): Promise<AssembledContext> };
};

type Coverage = { semantic: 'complete' | 'partial'; failedJobs: readonly string[] };
type FactRecord = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  status: string;
  sourceEventIds: readonly string[];
};
type DecisionRecord = {
  id: string;
  question: string;
  choice: string;
  status: string;
  sourceEventIds: readonly string[];
};
type GroundedAnswer = {
  text: string;
  supported: boolean;
  evidenceIds: readonly string[];
  coverage: Coverage;
  maxTokens: number;
  usedTokens: number;
};
type MemoryConsolidator = {
  consolidate(): Promise<{ checkpoint: string; coverage: Coverage }>;
  facts(): Promise<readonly FactRecord[]>;
  decisions(): Promise<readonly DecisionRecord[]>;
  card(level: 'segment' | 'session' | 'project'): Promise<string | undefined>;
  coverage(): Promise<Coverage>;
  answer(request: { question: string }): Promise<GroundedAnswer>;
  close(): Promise<void>;
};
type ConsolidationModule = {
  createMemoryConsolidator(options: {
    projectId: string;
    directory: string;
    store: MemoryStore;
    reasoner: ReasonerLike;
    assembler: { assemble(request: AssembleRequest): Promise<AssembledContext> };
    model: { modelId: string; contextCapacity: number };
  }): Promise<MemoryConsolidator>;
};

type ReasoningTask = Readonly<{ taskId: string; instruction: string }>;
type ReasonerLike = {
  run(
    task: ReasoningTask,
    boundedContext: unknown,
    outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown>;
};

type RecordedCall = {
  taskId: string;
  schemaTitle: unknown;
  prompt: string | undefined;
  maxTokens: number | undefined;
  outputReservation: number | undefined;
  inputTokens: number | undefined;
  totalTokens: number | undefined;
  evidenceIds: readonly string[] | undefined;
  accounting: Readonly<Record<string, number>> | undefined;
};

type FakeReasoner = ReasonerLike & { calls: RecordedCall[]; faults: string[] };
type FakeMode = 'ok' | 'invalid-json' | 'crash' | 'fabricated-citation';

const tokenizer = {
  count(text: string): number {
    return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
  },
};

/** The processor's own image-token calculation; M02 must charge it, never zero. */
function imageTokens(image: { width: number; height: number }): number {
  return Math.ceil(image.width / 28) * Math.ceil(image.height / 28);
}

/** Loads a module that does not exist yet without turning the red baseline into a crash. */
async function loadModule(specifier: string, requirement: string): Promise<Record<string, unknown>> {
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(message)) {
      assert.fail(`Missing required behavior: ${requirement}`);
    }
    throw error;
  }
  if (typeof loaded !== 'object' || loaded === null) {
    assert.fail(`Missing required behavior: ${requirement}`);
  }
  return loaded as Record<string, unknown>;
}

async function loadContextModule(): Promise<ContextModule> {
  const loaded = await loadModule(
    '../context/index.js',
    'packages/memory/src/context/index.ts must export CONTEXT_CEILING_TOKENS, '
    + 'boundedBudget({ modelId, contextCapacity }), and createContextAssembler({ tokenizer, imageTokens }) '
    + 'as the one owner of shared context budgeting.',
  );
  assert.equal(loaded.CONTEXT_CEILING_TOKENS, 8192, 'the shared context ceiling must be 8,192 tokens');
  assert.equal(typeof loaded.boundedBudget, 'function', 'packages/memory/src/context must export boundedBudget(...)');
  assert.equal(typeof loaded.createContextAssembler, 'function', 'packages/memory/src/context must export createContextAssembler(...)');
  return loaded as unknown as ContextModule;
}

async function loadConsolidationModule(): Promise<ConsolidationModule> {
  const loaded = await loadModule(
    './index.js',
    'packages/memory/src/consolidation/index.ts must export '
    + 'createMemoryConsolidator({ projectId, directory, store, reasoner, assembler, model }) with consolidate(), '
    + 'facts(), decisions(), card(), coverage(), answer(), and close().',
  );
  assert.equal(
    typeof loaded.createMemoryConsolidator,
    'function',
    'packages/memory/src/consolidation must export createMemoryConsolidator(...)',
  );
  return loaded as unknown as ConsolidationModule;
}

async function loadFixture(): Promise<LiveFixture> {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as LiveFixture;
  assert.equal(fixture.contractVersion, 1, 'the live fixture uses the v1 normalized-event contract');
  assert.equal(fixture.events.length, 12, 'the live fixture keeps its twelve meaningful multi-turn events');
  assert.ok(fixture.padding.turns >= 200, 'the padding must be large enough that the full raw log cannot fit one request');
  assert.ok(
    fixture.question.expectedAnswerCanary.length > 0 && fixture.padding.canary !== fixture.question.expectedAnswerCanary,
    'the decision canary and the raw-log canary must be distinct',
  );
  return fixture;
}

/** Deterministic padding turns: a big raw log whose canary must never reach a bounded request. */
function paddingBatch(fixture: LiveFixture): { events: NormalizedEvent[]; payloads: Record<string, unknown> } {
  const events: NormalizedEvent[] = [];
  const payloads: Record<string, unknown> = {};
  const startedAt = Date.parse(fixture.padding.startedAt);
  assert.ok(Number.isFinite(startedAt), 'the fixture padding start time must be valid');
  for (let index = 0; index < fixture.padding.turns; index += 1) {
    const sequence = fixture.padding.sourceSequenceBase + index;
    const label = String(index).padStart(4, '0');
    const payloadRef = `${fixture.padding.payloadRefPrefix}-${label}`;
    const blocks = Array.from(
      { length: 14 },
      (_, block) => `${fixture.padding.sentence} Block ${block + 1} of padding turn ${index + 1} carries no decision value.`,
    );
    // The canary leads the payload so it also lands in the capsule summary: a request that stuffs
    // raw-log capsules into the answer prompt is caught even though summaries are truncated.
    payloads[payloadRef] = { text: `Canary ${fixture.padding.canary}. ${blocks.join(' ')}` };
    events.push({
      schemaVersion: 1,
      eventId: `${fixture.padding.eventIdPrefix}-${label}`,
      sourceId: 'source-atlas-live',
      sourceEventId: `atlas-pad-${sequence}`,
      sourceSequence: sequence,
      ingestSequence: sequence,
      occurredAt: new Date(startedAt + index * 60_000).toISOString(),
      observedAt: new Date(startedAt + index * 60_000 + 250).toISOString(),
      scope: {
        profileId: fixture.profileId,
        projectId: fixture.projectId,
        worktreeId: fixture.worktreeId,
        sessionId: fixture.sessionId,
        sensitivity: 'normal',
      },
      kind: index % 2 === 0 ? 'user_utterance' : 'agent_message',
      payloadRef,
      contentHash: `sha256:atlas-pad-${sequence}`,
      trust: index % 2 === 0 ? 'user_explicit' : 'agent_reported',
    });
  }
  return { events, payloads };
}

function fixtureBatch(fixture: LiveFixture): NormalizedBatch {
  const padding = paddingBatch(fixture);
  return {
    events: [...fixture.events, ...padding.events],
    payloads: { ...fixture.payloads, ...padding.payloads },
  };
}

/** Counts what the consolidator actually pulls out of the raw log. */
function timelineSpy(inner: MemoryStore): { store: MemoryStore; stats: { calls: number; items: number } } {
  const stats = { calls: 0, items: 0 };
  const store: MemoryStore = {
    ingest: (batch, options) => inner.ingest(batch, options),
    durableCursor: () => inner.durableCursor(),
    close: () => inner.close(),
    timeline: async (query) => {
      const items = await inner.timeline(query);
      stats.calls += 1;
      stats.items += items.length;
      return items;
    },
  };
  return { store, stats };
}

function numberRecord(value: unknown): Readonly<Record<string, number>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number') return undefined;
    record[key] = entry;
  }
  return record;
}

/**
 * Scripted stand-in for the bundled Reasoner. It only emits the Atlas decision when the request it
 * was handed actually carried the decision event and its text, so a passing answer proves the
 * grounded evidence reached the model; every call is recorded for budget assertions afterwards.
 */
function createFakeReasoner(mode: FakeMode, fixture: LiveFixture): FakeReasoner {
  const calls: RecordedCall[] = [];
  const faults: string[] = [];
  const decision = {
    eventId: fixture.question.expectedEvidenceEventId,
    canary: fixture.question.expectedAnswerCanary,
    question: 'Where does Atlas keep durable project memory?',
    choice: `One encrypted database per project, with the profile registry stored separately. Canary ${fixture.question.expectedAnswerCanary} marks this decision.`,
    fact: `per-project encrypted database (${fixture.question.expectedAnswerCanary})`,
  };
  return {
    calls,
    faults,
    async run(task, boundedContext, outputSchema): Promise<unknown> {
      const context = typeof boundedContext === 'object' && boundedContext !== null
        ? boundedContext as Record<string, unknown>
        : {};
      const call: RecordedCall = {
        taskId: task.taskId,
        schemaTitle: (outputSchema as { title?: unknown }).title,
        prompt: typeof context.prompt === 'string' ? context.prompt : undefined,
        maxTokens: typeof context.maxTokens === 'number' ? context.maxTokens : undefined,
        outputReservation: typeof context.outputReservation === 'number' ? context.outputReservation : undefined,
        inputTokens: typeof context.inputTokens === 'number' ? context.inputTokens : undefined,
        totalTokens: typeof context.totalTokens === 'number' ? context.totalTokens : undefined,
        evidenceIds: Array.isArray(context.evidenceIds)
          ? context.evidenceIds.filter((id): id is string => typeof id === 'string')
          : undefined,
        accounting: numberRecord(context.accounting),
      };
      calls.push(call);
      if (mode === 'crash') throw new Error('simulated model crash');
      if (mode === 'invalid-json') return '{"decisions": [ this is not valid JSON';
      const grounded = (call.evidenceIds ?? []).includes(decision.eventId)
        && (call.prompt ?? '').includes(decision.canary);
      if (call.schemaTitle === 'memory.extraction') {
        return grounded
          ? {
              decisions: [{ question: decision.question, choice: decision.choice, sourceEventIds: [decision.eventId] }],
              facts: [{ subject: 'atlas', predicate: 'memory.backend', object: decision.fact, sourceEventIds: [decision.eventId] }],
              summary: `Segment carrying the Atlas storage decision ${decision.canary}.`,
            }
          : { decisions: [], facts: [], summary: 'Segment with no decision to extract.' };
      }
      if (call.schemaTitle === 'memory.answer') {
        if (mode === 'fabricated-citation') {
          return { text: 'Fabricated answer.', evidenceIds: [FABRICATED_EVIDENCE_ID] };
        }
        return grounded
          ? { text: `On 2026-09-08 Atlas decided: ${decision.canary}.`, evidenceIds: [decision.eventId] }
          : { text: 'No supporting evidence was available.', evidenceIds: [] };
      }
      faults.push(`unexpected outputSchema title: ${JSON.stringify(call.schemaTitle)}`);
      return { decisions: [], facts: [], summary: '' };
    },
  };
}

/** Asserts one Reasoner request obeyed the shared bounded-context invariant from §5.8. */
function assertBoundedCall(call: RecordedCall, budget: Budget, label: string): void {
  assert.equal(typeof call.maxTokens, 'number', `${label}: the bounded context must carry maxTokens (the ceiling B)`);
  assert.ok(
    call.maxTokens! > 0 && call.maxTokens! <= budget.ceiling,
    `${label}: maxTokens ${String(call.maxTokens)} must be inside B = ${budget.ceiling}`,
  );
  assert.equal(typeof call.totalTokens, 'number', `${label}: the bounded context must carry totalTokens`);
  assert.ok(
    call.totalTokens! <= call.maxTokens!,
    `${label}: totalTokens ${call.totalTokens} must not exceed B = ${call.maxTokens}`,
  );
  assert.equal(typeof call.inputTokens, 'number', `${label}: the bounded context must carry inputTokens`);
  assert.equal(typeof call.outputReservation, 'number', `${label}: the bounded context must reserve the output allowance`);
  assert.ok(call.outputReservation! > 0, `${label}: the output allowance must be reserved, never zero`);
  assert.equal(
    call.totalTokens,
    call.inputTokens! + call.outputReservation!,
    `${label}: totalTokens must equal the counted input plus the output reservation`,
  );
  assert.ok(
    call.inputTokens! <= budget.input,
    `${label}: input ${call.inputTokens} must stay within the input cap ${budget.input}`,
  );
  assert.ok(
    typeof call.prompt === 'string' && call.prompt.length > 0,
    `${label}: the bounded context must carry the exact prompt handed to the Reasoner`,
  );
  assert.ok(call.accounting !== undefined, `${label}: the bounded context must carry the context module's accounting`);
  for (const section of ['system', 'request', 'cards', 'dialogue', 'evidence', 'images', 'tools', 'reserve', 'output']) {
    assert.equal(typeof call.accounting![section], 'number', `${label}: accounting.${section} must be counted`);
  }
  const sum = Object.values(call.accounting!).reduce((total, tokens) => total + tokens, 0);
  assert.equal(sum, call.totalTokens, `${label}: totalTokens must equal the sum of the accounting sections`);
}

function contextAssembler(context: ContextModule): { assemble(request: AssembleRequest): Promise<AssembledContext> } {
  return context.createContextAssembler({ tokenizer, imageTokens: (image) => imageTokens(image) });
}

test('bounded context budgeting obeys B=min(8192, floor(0.25*C)) and survives deliberately failed compaction', async () => {
  const context = await loadContextModule();
  const fixture = await loadFixture();
  const budget = context.boundedBudget(MODEL);
  assert.equal(budget.ceiling, 8192, 'B = min(8192, floor(0.25 * 32768)) = 8192');
  assert.equal(budget.outputReservation, 2048, 'the normal 32K route reserves 2,048 tokens for output');
  assert.equal(budget.input, 6144, 'the normal 32K route caps input at 6,144 tokens');
  assert.equal(budget.input + budget.outputReservation, budget.ceiling, 'input plus output reservation must be exactly B');

  const smaller = context.boundedBudget({ modelId: 'qwen3.5-4b-q4', contextCapacity: 20000 });
  assert.equal(smaller.ceiling, 5000, 'B = min(8192, floor(0.25 * 20000)) = 5000');
  assert.equal(smaller.input + smaller.outputReservation, smaller.ceiling);
  assert.ok(
    smaller.outputReservation > 0 && smaller.outputReservation <= 2048,
    'smaller-context adapters scale the output allowance down instead of overflowing',
  );
  const larger = context.boundedBudget({ modelId: 'qwen3.5-4b-q4', contextCapacity: 200000 });
  assert.equal(larger.ceiling, 8192, 'a larger capacity never raises the ceiling above 8,192 tokens');
  for (const capacity of [0, -1, Number.NaN]) {
    assert.throws(
      () => context.boundedBudget({ modelId: 'undeclared-capacity', contextCapacity: capacity }),
      (error: unknown) => error instanceof Error,
      `a model declaring capacity ${capacity} has no verified capacity and must be rejected`,
    );
  }
  assert.throws(
    () => context.boundedBudget({ modelId: 'missing-capacity' } as { modelId: string; contextCapacity: number }),
    (error: unknown) => error instanceof Error,
    'a model without a declared capacity must be rejected',
  );

  const assembler = contextAssembler(context);
  const instruction = 'System policy and tool schemas for one Atlas memory request.';
  const request = 'What did we decide on 2026-09-08 about the Atlas memory backend?';
  const card = 'Project card: Atlas keeps one encrypted database per project.';
  const toolSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const dialogue: DialogueItem[] = Array.from({ length: 60 }, (_, index) => ({
    id: `dialogue-${String(index).padStart(3, '0')}`,
    text: `dialogue-marker-${String(index).padStart(3, '0')} ${'recent committed dialogue token '.repeat(20)}`.trim(),
  }));
  const model = { modelId: MODEL.modelId, contextCapacity: 20000 };

  const failed = await assembler.assemble({
    model,
    instruction,
    request,
    card,
    dialogue,
    evidence: [{
      id: fixture.question.expectedEvidenceEventId,
      text: `Where does Atlas keep durable project memory? ${fixture.question.expectedAnswerCanary}.`,
    }],
    images: [{ id: 'artifact-atlas-screen', width: 896, height: 896 }],
    tools: [{ name: 'memory_query', schema: toolSchema }],
    compactDialogue: async () => {
      throw new Error('deliberately failed compaction');
    },
  });

  assert.equal(failed.maxTokens, smaller.ceiling, 'the assembled context must carry the ceiling it enforced');
  assert.ok(failed.totalTokens <= failed.maxTokens, 'a failed compaction must not push the request past B');
  assert.equal(
    failed.totalTokens,
    failed.inputTokens + failed.outputReservation,
    'totalTokens must count the output reservation, not just the input',
  );
  for (const section of ['system', 'request', 'cards', 'dialogue', 'evidence', 'images', 'tools', 'reserve', 'output']) {
    assert.equal(typeof failed.accounting[section], 'number', `accounting.${section} must be counted`);
  }
  const accountingSum = Object.values(failed.accounting).reduce((total, tokens) => total + tokens, 0);
  assert.equal(accountingSum, failed.totalTokens, 'totalTokens must equal the sum of the accounting sections');
  assert.equal(failed.accounting.request, tokenizer.count(request), 'the request section must use exact tokenizer accounting');
  assert.equal(
    failed.accounting.images,
    imageTokens({ width: 896, height: 896 }),
    'image tokens must use the processor calculation instead of an estimate',
  );
  assert.ok(failed.accounting.images > 0, 'a screenshot must never be claimed to cost zero tokens');
  assert.ok(
    (failed.accounting.tools ?? -1) > tokenizer.count(JSON.stringify(toolSchema)),
    'tool schemas must be charged with their call wrapper, not only the raw schema text',
  );
  assert.equal(failed.coverage, 'partial', 'a deliberately failed compaction must mark the context partial');
  assert.ok(
    failed.prompt.includes(card),
    'the deterministic card must replace the dialogue a failed compaction could not keep',
  );
  assert.equal(
    failed.prompt.includes('dialogue-marker-000'),
    false,
    'failed compaction must not fall back to stuffing the whole dialogue into the prompt',
  );
  assert.ok(tokenizer.count(failed.prompt) <= failed.inputTokens, 'the prompt must fit the accounted input tokens');

  const compacted = await assembler.assemble({
    model: { modelId: MODEL.modelId, contextCapacity: 20000 },
    instruction,
    request,
    card,
    dialogue,
    evidence: [{ id: fixture.question.expectedEvidenceEventId, text: `${fixture.question.expectedAnswerCanary}.` }],
    images: [{ id: 'artifact-atlas-screen', width: 896, height: 896 }],
    tools: [{ name: 'memory_query', schema: toolSchema }],
    compactDialogue: async () => [{ id: 'dialogue-summary', text: 'Compacted dialogue summary: the Atlas session so far.' }],
  });
  assert.equal(compacted.coverage, 'complete', 'successful compaction keeps the context complete');
  assert.ok(compacted.prompt.includes('Compacted dialogue summary'), 'the compacted dialogue must reach the prompt');
  assert.ok(compacted.totalTokens <= compacted.maxTokens, 'the compacted request must stay inside B');
  assert.equal(compacted.prompt.includes('dialogue-marker-000'), false, 'old dialogue must be compacted, not re-stuffed');
});

test('a multi-turn live batch answers a dated project question after restart without the full raw log', async () => {
  const context = await loadContextModule();
  const consolidation = await loadConsolidationModule();
  const fixture = await loadFixture();
  const batch = fixtureBatch(fixture);
  const totalEvents = fixture.events.length + fixture.padding.turns;
  const budget = context.boundedBudget(MODEL);
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m02-live-'));
  try {
    const store = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
    const spy = timelineSpy(store);
    await spy.store.ingest(batch);
    const reasoner = createFakeReasoner('ok', fixture);
    const consolidator = await consolidation.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store: spy.store,
      reasoner,
      assembler: contextAssembler(context),
      model: MODEL,
    });

    const consolidated = await consolidator.consolidate();
    assert.equal(consolidated.coverage.semantic, 'complete', 'a healthy model must consolidate the live batch completely');
    assert.ok(spy.stats.items >= totalEvents, `consolidation must read the freshly ingested raw events (read ${spy.stats.items})`);
    assert.ok(
      reasoner.calls.some((call) => call.schemaTitle === 'memory.extraction'),
      'live segment extraction must run through the Reasoner contract',
    );
    assert.equal(reasoner.faults.length, 0, `the extraction requests violated the contract: ${reasoner.faults.join('; ')}`);
    for (const call of reasoner.calls) assertBoundedCall(call, budget, `extraction ${call.taskId}`);

    const decision = (await consolidator.decisions()).find(
      (entry) => entry.sourceEventIds.includes(fixture.question.expectedEvidenceEventId),
    );
    assert.ok(decision, 'the extracted decision must keep the source event that produced it');
    assert.equal(decision.status, 'active', 'a user decision is active, not superseded');
    assert.ok(decision.choice.includes(fixture.question.expectedAnswerCanary), 'the decision text must be preserved');
    const fact = (await consolidator.facts()).find(
      (entry) => entry.sourceEventIds.includes(fixture.question.expectedEvidenceEventId),
    );
    assert.ok(fact, 'the extracted fact must keep the source event that produced it');
    assert.equal(fact.subject, 'atlas', 'the structured fact must keep the extracted subject');

    const projectCard = await consolidator.card('project');
    assert.ok(projectCard, 'the project card must be readable after consolidation');
    assert.ok(projectCard.includes(fixture.question.expectedAnswerCanary), 'the project card must carry the decision');
    assert.ok(tokenizer.count(projectCard) <= 1200, 'a project card must stay within 1,200 tokens');
    const sessionCard = await consolidator.card('session');
    assert.ok(sessionCard, 'the session card must be readable after consolidation');
    assert.ok(tokenizer.count(sessionCard) <= 800, 'a session card must stay within 800 tokens');

    await consolidator.close();
    await spy.store.close();

    const restartedStore = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
    const restartSpy = timelineSpy(restartedStore);
    const restartedReasoner = createFakeReasoner('ok', fixture);
    const restarted = await consolidation.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store: restartSpy.store,
      reasoner: restartedReasoner,
      assembler: contextAssembler(context),
      model: MODEL,
    });
    assert.equal(restartedReasoner.calls.length, 0, 'opening a consolidated project must load persisted state, not call the model');
    assert.equal(await restarted.card('project'), projectCard, 'the project card must survive a restart unchanged');

    restartSpy.stats.items = 0;
    const answer = await restarted.answer({ question: fixture.question.text });
    assert.ok(
      restartSpy.stats.items <= ANSWER_READ_BOUND,
      `the answer must inspect at most ${ANSWER_READ_BOUND} bounded evidence items, not the ${totalEvents}-event raw log `
      + `(read ${restartSpy.stats.items})`,
    );
    assert.equal(answer.supported, true, 'the dated question must return a supported answer after a restart');
    assert.ok(
      answer.evidenceIds.includes(fixture.question.expectedEvidenceEventId),
      'the supported answer must cite the decision it was derived from',
    );
    assert.ok(
      answer.text.includes(fixture.question.expectedAnswerCanary),
      'the answer must be grounded in the consolidated decision text',
    );
    assert.ok(answer.usedTokens <= answer.maxTokens, 'the answer request must obey its own bounded ceiling');
    assert.ok(answer.maxTokens <= budget.ceiling, 'the answer ceiling must never exceed B');
    assert.equal(answer.coverage.semantic, 'complete', 'a supported answer over complete coverage says so');

    const answerCalls = restartedReasoner.calls.filter((call) => call.schemaTitle === 'memory.answer');
    assert.ok(answerCalls.length >= 1, 'the grounded answer must run through the Reasoner contract');
    for (const call of restartedReasoner.calls) {
      assertBoundedCall(call, budget, `answer ${call.taskId}`);
      assert.equal(
        (call.prompt ?? '').includes(fixture.padding.canary),
        false,
        'the answer request must not carry the raw log it never reread',
      );
    }
    assert.equal(restartedReasoner.faults.length, 0, `the answer requests violated the contract: ${restartedReasoner.faults.join('; ')}`);
    await restarted.close();
    await restartSpy.store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed JSON and model crashes keep deterministic state and mark semantic coverage partial', async () => {
  const context = await loadContextModule();
  const consolidation = await loadConsolidationModule();
  const fixture = await loadFixture();
  const batch: NormalizedBatch = { events: fixture.events, payloads: fixture.payloads };
  for (const mode of ['invalid-json', 'crash'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `echopilot-m02-${mode}-`));
    try {
      const store = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
      await store.ingest(batch);
      const reasoner = createFakeReasoner(mode, fixture);
      const consolidator = await consolidation.createMemoryConsolidator({
        projectId: fixture.projectId,
        directory,
        store,
        reasoner,
        assembler: contextAssembler(context),
        model: MODEL,
      });

      const result = await consolidator.consolidate();
      assert.equal(result.coverage.semantic, 'partial', `${mode}: a failed extraction must mark semantic coverage partial`);
      assert.ok(result.coverage.failedJobs.length > 0, `${mode}: the failed extraction job must be reported`);
      assert.ok(reasoner.calls.length >= 1, `${mode}: the extraction attempt must go through the Reasoner contract`);
      assert.equal((await consolidator.coverage()).semantic, 'partial', `${mode}: coverage must stay partial until repaired`);

      const projectCard = await consolidator.card('project');
      assert.ok(projectCard, `${mode}: the deterministic factual card must exist without the model`);
      assert.ok(
        projectCard.includes(fixture.question.expectedAnswerCanary),
        `${mode}: the deterministic card must keep the stored decision`,
      );
      assert.ok(tokenizer.count(projectCard) <= 1200, `${mode}: the deterministic card stays bounded`);

      const first = await consolidator.answer({ question: fixture.question.text });
      assert.ok(
        first.text.includes(fixture.question.expectedAnswerCanary),
        `${mode}: a model outage must still produce a deterministic, evidence-backed answer`,
      );
      assert.ok(
        first.evidenceIds.includes(fixture.question.expectedEvidenceEventId),
        `${mode}: the fallback answer must cite the stored decision`,
      );
      assert.equal(first.coverage.semantic, 'partial', `${mode}: the fallback answer must disclose partial coverage`);
      assert.ok(first.usedTokens <= first.maxTokens, `${mode}: the fallback answer must stay inside B`);

      const second = await consolidator.answer({ question: fixture.question.text });
      assert.equal(second.text, first.text, `${mode}: repeated answers over unchanged state must be identical`);
      assert.deepEqual([...second.evidenceIds], [...first.evidenceIds], `${mode}: repeated evidence citations must be identical`);
      assert.equal(second.supported, first.supported, `${mode}: repeated support decisions must be identical`);

      await consolidator.close();
      await store.close();

      const restartedStore = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
      const restarted = await consolidation.createMemoryConsolidator({
        projectId: fixture.projectId,
        directory,
        store: restartedStore,
        reasoner: createFakeReasoner(mode, fixture),
        assembler: contextAssembler(context),
        model: MODEL,
      });
      assert.equal((await restarted.coverage()).semantic, 'partial', `${mode}: partial coverage must survive a restart`);
      const afterRestart = await restarted.answer({ question: fixture.question.text });
      assert.equal(afterRestart.text, first.text, `${mode}: the deterministic answer must survive a restart unchanged`);
      assert.deepEqual([...afterRestart.evidenceIds], [...first.evidenceIds], `${mode}: restart must not change the citations`);
      await restarted.close();
      await restartedStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('duplicate consolidation jobs neither re-run the model nor duplicate records', async () => {
  const context = await loadContextModule();
  const consolidation = await loadConsolidationModule();
  const fixture = await loadFixture();
  const batch: NormalizedBatch = { events: fixture.events, payloads: fixture.payloads };
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m02-duplicates-'));
  try {
    const store = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
    await store.ingest(batch);
    const reasoner = createFakeReasoner('ok', fixture);
    const consolidator = await consolidation.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store,
      reasoner,
      assembler: contextAssembler(context),
      model: MODEL,
    });

    const first = await consolidator.consolidate();
    assert.equal(first.coverage.semantic, 'complete');
    assert.ok(reasoner.calls.length > 0, 'the first consolidation must run extraction jobs');
    const decisionsAfterFirst = await consolidator.decisions();
    const factsAfterFirst = await consolidator.facts();
    const cardAfterFirst = await consolidator.card('project');
    assert.ok(decisionsAfterFirst.length > 0 && factsAfterFirst.length > 0, 'the first consolidation must extract records');

    const callsAfterFirst = reasoner.calls.length;
    const second = await consolidator.consolidate();
    assert.equal(second.checkpoint, first.checkpoint, 'a job with no new events must not advance the checkpoint');
    assert.equal(reasoner.calls.length, callsAfterFirst, 'duplicate jobs must not call the model again');
    assert.deepEqual(await consolidator.decisions(), decisionsAfterFirst, 'duplicate jobs must not duplicate decisions');
    assert.deepEqual(await consolidator.facts(), factsAfterFirst, 'duplicate jobs must not duplicate facts');
    assert.equal(await consolidator.card('project'), cardAfterFirst, 'duplicate jobs must not rewrite the card');
    assert.equal(second.coverage.semantic, 'complete', 'duplicate jobs leave coverage complete');

    await consolidator.close();
    await store.close();

    const restartedStore = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
    const restartedReasoner = createFakeReasoner('ok', fixture);
    const restarted = await consolidation.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store: restartedStore,
      reasoner: restartedReasoner,
      assembler: contextAssembler(context),
      model: MODEL,
    });
    const afterRestart = await restarted.consolidate();
    assert.equal(afterRestart.checkpoint, first.checkpoint, 'the consolidation watermark must survive a restart');
    assert.equal(restartedReasoner.calls.length, 0, 'a restart with no new events must not re-run the model');
    assert.deepEqual(await restarted.decisions(), decisionsAfterFirst, 'restart must not duplicate decisions');
    await restarted.close();
    await restartedStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an answer whose citations were never presented is replaced by the grounded fallback', async () => {
  const context = await loadContextModule();
  const consolidation = await loadConsolidationModule();
  const fixture = await loadFixture();
  const batch: NormalizedBatch = { events: fixture.events, payloads: fixture.payloads };
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-m02-grounding-'));
  try {
    const store = await createMemoryStore({ directory, key: STORE_KEY, profileId: fixture.profileId });
    await store.ingest(batch);
    const consolidator = await consolidation.createMemoryConsolidator({
      projectId: fixture.projectId,
      directory,
      store,
      reasoner: createFakeReasoner('fabricated-citation', fixture),
      assembler: contextAssembler(context),
      model: MODEL,
    });
    await consolidator.consolidate();

    const answer = await consolidator.answer({ question: fixture.question.text });
    assert.equal(
      answer.evidenceIds.includes(FABRICATED_EVIDENCE_ID),
      false,
      'an evidence id the model was never shown must never be reported as support',
    );
    assert.notEqual(answer.text, 'Fabricated answer.', 'unverified model text must not be returned as the grounded answer');
    assert.ok(
      answer.evidenceIds.includes(fixture.question.expectedEvidenceEventId),
      'the grounded fallback must cite the stored decision instead of the fabricated citation',
    );
    await consolidator.close();
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
