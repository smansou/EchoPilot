/**
 * A02 model-response validation — the shape a correction response must have before any of it is
 * believed.
 *
 * A local model can return anything: prose, a truncated JSON object, spans counted in the wrong
 * unit, or a corrected text that does not match its own edit list. The rule here is that a response
 * is *consistent* or it is discarded: `text` must be exactly the raw transcript with every declared
 * span applied, every span must be an ordered, non-overlapping range of the raw transcript whose
 * `original` matches the raw slice, and every declared field must have the declared type. Anything
 * short of that is not partially trusted — the caller falls back to the raw transcript, because a
 * correction that cannot be verified is worse than no correction.
 */

import type { CorrectionBasis } from './rules.js';

export interface ModelCorrectionEdit {
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly basis: CorrectionBasis;
  readonly acousticReason: string | null;
  readonly confidence: number;
}

export interface ParsedCorrectionResponse {
  readonly text: string;
  readonly edits: ReadonlyArray<ModelCorrectionEdit>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Composes ordered, non-overlapping spans over `raw`. Spans are relative to the raw transcript, so
 * this is the one place that turns a proposal list into the text a user would receive. It throws on
 * an unvalidated span rather than silently repairing one; callers validate first.
 */
export function applyEditSpans(
  raw: string,
  spans: ReadonlyArray<Readonly<{ start: number; end: number; replacement: string }>>,
): string {
  let text = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor || span.end < span.start || span.end > raw.length) {
      throw new RangeError('applyEditSpans requires ordered, in-range spans of the raw transcript');
    }
    text += raw.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return text + raw.slice(cursor);
}

function readEdit(candidate: unknown, raw: string, cursor: number): ModelCorrectionEdit | null {
  if (!isRecord(candidate)) return null;
  const { start, end, original, replacement, basis, confidence } = candidate;
  const acousticReason = candidate.acousticReason ?? null;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) return null;
  if (typeof end !== 'number' || !Number.isInteger(end) || end < start || end > raw.length) return null;
  if (typeof original !== 'string' || typeof replacement !== 'string') return null;
  if (basis !== 'evidence' && basis !== 'acoustic_normalization') return null;
  if (acousticReason !== null && typeof acousticReason !== 'string') return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  // Ordered and non-overlapping: `cursor` is the end of the previous accepted span.
  if (start < cursor) return null;
  // The declared original must be the raw text at the declared span, character for character.
  if (raw.slice(start, end) !== original) return null;
  return { start, end, original, replacement, basis, acousticReason, confidence };
}

/**
 * Parses a model response into validated proposals, or `null` when the response is not trustworthy
 * as a whole. `null` is deliberately blunt: a response whose text disagrees with its own edits
 * cannot be salvaged edit-by-edit without inventing a corrected text the model never proposed.
 */
export function parseCorrectionResponse(raw: string, value: unknown): ParsedCorrectionResponse | null {
  if (!isRecord(value)) return null;
  const { text, edits: declared } = value;
  if (typeof text !== 'string' || !Array.isArray(declared)) return null;

  const edits: ModelCorrectionEdit[] = [];
  let cursor = 0;
  for (const candidate of declared) {
    const edit = readEdit(candidate, raw, cursor);
    if (edit === null) return null;
    edits.push(edit);
    cursor = edit.end;
  }
  if (applyEditSpans(raw, edits) !== text) return null;
  return { text, edits };
}
