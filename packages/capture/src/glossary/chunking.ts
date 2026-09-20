/**
 * A03 bounded correction chunks — a long dictation is corrected as a sequence of windows, never as
 * one oversized request (plan §4.4: "longer dictation is a sequence of bounded windows").
 *
 * Chunks are measured with the caller's own tokenizer — the same counter the M02 assembler budgets
 * with — so "inside the budget" is a measurement, not an estimate. The plan is a partition of the
 * committed text: `chunks.map(chunk => chunk.text).join(' ')` is the input text, in order, with no
 * word dropped and no word sent twice, and `totalTokens` is the token count of the whole text.
 *
 * A single word that alone exceeds the budget still gets its own chunk instead of being dropped:
 * the correction path can report an oversized word, but it must never lose the user's words.
 */
import type { DictationChunk, DictationChunkPlan } from './model.js';
import { wordSpans } from './correction.js';

export interface ChunkLongDictationInput {
  readonly text: string;
  readonly maxChunkTokens: number;
  readonly tokenizer: Readonly<{ count(text: string): number }>;
}

export function chunkLongDictation(input: ChunkLongDictationInput): DictationChunkPlan {
  const candidate = input as Partial<ChunkLongDictationInput> | null | undefined;
  if (typeof candidate?.text !== 'string') {
    throw new TypeError('chunkLongDictation requires { text, maxChunkTokens, tokenizer }');
  }
  const maxChunkTokens = candidate.maxChunkTokens;
  if (typeof maxChunkTokens !== 'number' || !Number.isInteger(maxChunkTokens) || maxChunkTokens < 1) {
    throw new RangeError('chunkLongDictation requires a positive integer maxChunkTokens');
  }
  const tokenizer = candidate.tokenizer;
  if (typeof tokenizer?.count !== 'function') {
    throw new TypeError('chunkLongDictation requires the caller\'s exact tokenizer');
  }

  const text = candidate.text;
  const count = (value: string): number => tokenizer.count(value);
  const totalTokens = count(text);
  const spans = wordSpans(text);
  if (spans.length === 0) {
    // No words to split: the text travels as the single (possibly empty) request it already is.
    return {
      chunks: text.length > 0 ? [{ index: 0, text, tokenCount: totalTokens }] : [],
      totalTokens,
      maxChunkTokens,
    };
  }

  const chunks: DictationChunk[] = [];
  let chunkStart = -1;
  let chunkEnd = -1;
  const flush = (): void => {
    if (chunkStart < 0) return;
    const chunkText = text.slice(chunkStart, chunkEnd);
    chunks.push({ index: chunks.length, text: chunkText, tokenCount: count(chunkText) });
    chunkStart = -1;
    chunkEnd = -1;
  };
  for (const span of spans) {
    if (chunkStart >= 0 && count(text.slice(chunkStart, span.end)) > maxChunkTokens) flush();
    if (chunkStart < 0) chunkStart = span.start;
    chunkEnd = span.end;
  }
  flush();

  return { chunks, totalTokens, maxChunkTokens };
}
