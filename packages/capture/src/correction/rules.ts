/**
 * A02 correction rules — the deterministic gates every proposed substitution must clear.
 *
 * The model is a proposal source, never an authority. Three independent checks live here:
 *
 *   1. `protectedTokenKind` answers "does this span or its replacement carry a number, negation,
 *      flag, path, or quoted literal?" — the pinned protected classes (judgment A-F5). A candidate
 *      that touches one is blocked as `protected_token` before any basis is considered, whatever
 *      confidence the model reports; confidence is not an authorization signal.
 *   2. `verifyAcousticNormalization` accepts only the three pinned acoustic reasons, and only when
 *      the raw/replacement pair satisfies the pinned equality: `spelled_letters` = letter-only
 *      equality with whitespace disappearing, `capitalization` = lowercase equality, `punctuation`
 *      = alphanumeric-insensitive equality.
 *   3. `harmfulProtectedTokenEdits` is the end-to-end gate. It re-scans the raw and the corrected
 *      text with its own tokenizer and counts how many protected tokens changed, so the reported
 *      `harmfulEditsApplied` is a measurement of the text that would be inserted — never a
 *      constant, and never the engine grading its own homework.
 */

export const CORRECTION_MODES = ['verbatim', 'technical_cleanup', 'rewrite'] as const;
export type CorrectionMode = (typeof CORRECTION_MODES)[number];

export const ACOUSTIC_NORMALIZATION_REASONS = ['spelled_letters', 'capitalization', 'punctuation'] as const;
export type AcousticNormalizationReason = (typeof ACOUSTIC_NORMALIZATION_REASONS)[number];

export const PROTECTED_TOKEN_KINDS = ['number', 'negation', 'flag', 'path', 'quoted_literal'] as const;
export type ProtectedTokenKind = (typeof PROTECTED_TOKEN_KINDS)[number];

export const EDIT_BLOCK_REASONS = ['protected_token', 'missing_evidence', 'invalid_acoustic_reason'] as const;
export type EditBlockReason = (typeof EDIT_BLOCK_REASONS)[number];

export type CorrectionBasis = 'evidence' | 'acoustic_normalization';

export function isCorrectionMode(value: unknown): value is CorrectionMode {
  return typeof value === 'string' && (CORRECTION_MODES as readonly string[]).includes(value);
}

export function isAcousticNormalizationReason(value: unknown): value is AcousticNormalizationReason {
  return typeof value === 'string' && (ACOUSTIC_NORMALIZATION_REASONS as readonly string[]).includes(value);
}

/**
 * Token scans, non-global on purpose: `.test()` on a shared regex must not depend on `lastIndex`.
 * Order matters — it is the pinned order of `PROTECTED_TOKEN_KINDS`.
 */
const NUMBER_HINT = /\d/;
const FLAG_HINT = /(?:^|\s)-{1,2}[A-Za-z][\w-]*/;
const NEGATION_HINT = /\b(?:not|never|no|none|without|except|cannot)\b|n't/i;
const PATH_HINT = /[\w.-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|toml|swift|py|sh|css|html|txt)\b/;
const QUOTED_HINT = /["'`]/;

/** Global variants used for the full-text scan; `.match()` resets `lastIndex`, so sharing is safe. */
const NUMBER_SCAN = /\d+(?:[.,:/-]\d+)*/g;
const FLAG_SCAN = /(?:^|\s)(-{1,2}[A-Za-z][\w-]*)/g;
const NEGATION_SCAN = /\b(?:not|never|no|none|without|except|cannot)\b|n't/gi;
const PATH_SCAN = /[\w.-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|toml|swift|py|sh|css|html|txt)\b/g;
const QUOTED_SCAN = /"[^"]*"|'[^']*'|`[^`]*`/g;

/**
 * The protected class a substitution touches, or `null` when the pair is free to change. Both the
 * raw span and its replacement are inspected, because both directions are harmful: rewriting a
 * number away and introducing a new one are the same edit from the user's point of view.
 */
export function protectedTokenKind(original: string, replacement: string): ProtectedTokenKind | null {
  for (const value of [original, replacement]) {
    if (NUMBER_HINT.test(value)) return 'number';
  }
  for (const value of [original, replacement]) {
    if (NEGATION_HINT.test(value)) return 'negation';
  }
  for (const value of [original, replacement]) {
    if (FLAG_HINT.test(value)) return 'flag';
  }
  for (const value of [original, replacement]) {
    if (PATH_HINT.test(value)) return 'path';
  }
  for (const value of [original, replacement]) {
    if (QUOTED_HINT.test(value)) return 'quoted_literal';
  }
  return null;
}

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function lettersAndDigits(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Deterministic verification of an acoustic normalization: the reason must be true of the pair on
 * its own, with no model testimony involved. An unverifiable claim never becomes an applied edit;
 * it is offered back as an unresolved span (`invalid_acoustic_reason`) instead.
 */
export function verifyAcousticNormalization(
  original: string,
  replacement: string,
  reason: AcousticNormalizationReason,
): boolean {
  if (original === replacement) return false;
  switch (reason) {
    case 'spelled_letters':
      // "U R L" → "URL": the letters survive, the spoken spacing collapses.
      return lettersOnly(original) === lettersOnly(replacement)
        && /\s/.test(original.trim())
        && !/\s/.test(replacement.trim());
    case 'capitalization':
      // "grafana" → "Grafana": only the case changes.
      return original.toLowerCase() === replacement.toLowerCase();
    case 'punctuation':
      // " ," → ",": only punctuation and spacing move.
      return lettersAndDigits(original) === lettersAndDigits(replacement);
  }
}

/**
 * The protected-token inventory of a text, as `kind:token` entries. This is the unit the harmful
 * gate compares; it is deliberately a text-level scan (not a span-level one) so it also notices a
 * protected token that a span boundary would have split.
 */
export function protectedTokenInventory(text: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  for (const match of text.match(NUMBER_SCAN) ?? []) tokens.push(`number:${match}`);
  for (const match of text.match(FLAG_SCAN) ?? []) tokens.push(`flag:${match.trim()}`);
  for (const match of text.match(NEGATION_SCAN) ?? []) tokens.push(`negation:${match.toLowerCase()}`);
  for (const match of text.match(PATH_SCAN) ?? []) tokens.push(`path:${match}`);
  for (const match of text.match(QUOTED_SCAN) ?? []) tokens.push(`quoted:${match}`);
  return tokens;
}

function tally(tokens: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * How many protected tokens the corrected text changed relative to the raw transcript: the
 * symmetric difference of the two inventories. Zero is the only acceptable value for the
 * harmful-edit gate.
 */
export function harmfulProtectedTokenEdits(rawText: string, correctedText: string): number {
  if (rawText === correctedText) return 0;
  const before = tally(protectedTokenInventory(rawText));
  const after = tally(protectedTokenInventory(correctedText));
  let changed = 0;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    changed += Math.abs((before.get(key) ?? 0) - (after.get(key) ?? 0));
  }
  return changed;
}
