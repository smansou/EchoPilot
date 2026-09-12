/**
 * M02 context-module invariants that the frozen acceptance oracle does not reach.
 *
 * The frozen oracle measures with a whitespace counter, where the module's nominal 64-token
 * formatting allowance always happens to be enough. These checks drive the same assembler with a
 * character counter whose header/separator cost is larger than that allowance, so they only pass
 * when `accounting.reserve` is the exact measurement of the prompt that is actually sent and the
 * admitted image descriptors really travel with the context they were charged for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_CEILING_TOKENS,
  FORMAT_RESERVE_TOKENS,
  boundedBudget,
  createContextAssembler,
  type AssembledContext,
  type ContextAccounting,
} from './index.js';

/** One token per character: every header, separator and newline is charged. */
const charTokenizer = { count: (text: string): number => text.length };

function imageTokens(image: { width: number; height: number }): number {
  return Math.ceil(image.width / 28) * Math.ceil(image.height / 28);
}

const assembler = createContextAssembler({
  tokenizer: charTokenizer,
  imageTokens: (image) => imageTokens({ width: image.width, height: image.height }),
});

function accountingSum(accounting: ContextAccounting): number {
  return Object.values(accounting).reduce((total, tokens) => total + tokens, 0);
}

function assertInvariant(context: AssembledContext, ceiling: number): void {
  assert.ok(context.totalTokens <= context.maxTokens, 'totalTokens must stay inside B');
  assert.ok(context.maxTokens <= ceiling, 'maxTokens must never exceed B');
  assert.equal(context.totalTokens, context.inputTokens + context.outputReservation);
  assert.equal(accountingSum(context.accounting), context.totalTokens);
  assert.equal(
    tokenizerCount(context.prompt) <= context.inputTokens,
    true,
    'the exact prompt must fit the accounted input, headers and separators included',
  );
}

function tokenizerCount(text: string): number {
  return charTokenizer.count(text);
}

test('a formatting overhead larger than the nominal allowance is measured exactly and never breaks B', async () => {
  const model = { modelId: 'qwen3.5-4b-q4', contextCapacity: 1000 };
  const budget = boundedBudget(model);
  // Evidence long enough to consume the admission allowance, and all six sections present, so the
  // header/separator cost exceeds the module's nominal formatting allowance.
  const context = await assembler.assemble({
    model,
    instruction: '12345678901234567890',
    request: '0123456789',
    card: 'card-text',
    evidence: [{ id: 'evt-long', text: 'e'.repeat(200) }],
    images: [{ id: 'shot-small', width: 28, height: 28 }],
    tools: [{ name: 'q', schema: { a: 1 } }],
  });

  assert.equal(context.maxTokens, budget.ceiling);
  assert.equal(context.outputReservation, budget.outputReservation);
  assert.ok(
    context.accounting.reserve > FORMAT_RESERVE_TOKENS,
    `the measured reserve ${context.accounting.reserve} must exceed the nominal allowance when the ` +
    `prompt's headers cost that much`,
  );
  assert.equal(context.coverage, 'partial', 'parts dropped to keep the exact measurement inside B are disclosed');
  assert.equal(
    context.accounting.images,
    context.images.reduce((total, image) => total + image.tokens, 0),
    'the charged image tokens must equal the transmitted descriptors’ charge',
  );
  assertInvariant(context, CONTEXT_CEILING_TOKENS);
});

test('admitted images travel with the context they were charged for', async () => {
  const model = { modelId: 'qwen3.5-4b-q4', contextCapacity: 32768 };
  const context = await assembler.assemble({
    model,
    instruction: 'Answer the dated project question.',
    request: 'Where does Atlas keep durable project memory?',
    card: 'Project card: Atlas keeps one encrypted database per project.',
    evidence: [{ id: 'evt-1', text: 'Atlas decision recorded 2026-09-08.' }],
    images: [{ id: 'artifact-atlas-screen', width: 896, height: 896 }],
    tools: [{ name: 'memory_query', schema: { type: 'object', properties: { text: { type: 'string' } } } }],
  });

  assert.equal(context.coverage, 'complete');
  assert.equal(context.accounting.images, imageTokens({ width: 896, height: 896 }));
  assert.deepEqual(context.images, [
    { id: 'artifact-atlas-screen', width: 896, height: 896, tokens: imageTokens({ width: 896, height: 896 }) },
  ]);
  assert.ok(context.prompt.includes('artifact-atlas-screen'), 'the prompt documents the image it transmits');
  const schemaText = JSON.stringify({ type: 'object', properties: { text: { type: 'string' } } });
  assert.ok(
    context.accounting.tools > charTokenizer.count(schemaText),
    'the tool charge covers the exact wrapper text the prompt sends, not just the schema',
  );
  assert.ok(context.prompt.includes(schemaText), 'the charged wrapper is the wrapper that was sent');
  assertInvariant(context, CONTEXT_CEILING_TOKENS);
});

test('a deliberately failed compaction still leaves an exactly measured prompt', async () => {
  const model = { modelId: 'qwen3.5-4b-q4', contextCapacity: 20000 };
  const budget = boundedBudget(model);
  const dialogue = Array.from({ length: 40 }, (_, index) => ({
    id: `dialogue-${String(index).padStart(3, '0')}`,
    text: `dialogue-marker-${String(index).padStart(3, '0')} ${'recent committed dialogue token '.repeat(12)}`.trim(),
  }));
  const context = await assembler.assemble({
    model,
    instruction: 'Extract structured memory.',
    request: 'Extract the segment.',
    card: 'Deterministic card: the decision canary.',
    dialogue,
    evidence: [{ id: 'evt-1', text: 'evidence text' }],
    tools: [{ name: 'memory_query', schema: { type: 'object' } }],
    compactDialogue: async () => {
      throw new Error('deliberately failed compaction');
    },
  });

  assert.equal(context.coverage, 'partial');
  assert.ok(context.prompt.includes('Deterministic card: the decision canary.'));
  assert.equal(context.prompt.includes('dialogue-marker-000'), false);
  assert.equal(context.accounting.dialogue, 0);
  assertInvariant(context, budget.ceiling);
});
