/**
 * A03 correction pass — the deterministic half of "user corrects a term → better later dictation".
 *
 * The glossary store owns what was learned; this module owns how a learned entry is applied, and it
 * is deterministic on purpose: the same committed transcript and the same visible entries always
 * produce the same text and the same substitution list, so a correction the user did not make can
 * never be attributed to learning.
 *
 * Three rules are enforced here:
 *
 *   1. A correction is only ever a *variant* of a visible term replaced by that term. A variant is
 *      matched as a whole-word sequence (case-insensitively, so "jason" matches how the user
 *      spoke it), and never inside a longer word — "echoes pilot" is not "echo pilot".
 *   2. A negative example is a case-sensitive span the user explicitly refused. An occurrence whose
 *      text overlaps it is left exactly as it was said, which is how "tell Jason the deploy is
 *      blocked" survives while the technical "serialize the jason response" still corrects. The
 *      protection is applied across every visible entry's examples, because the user's instruction
 *      was about that span, not about the entry that happened to match it.
 *   3. Learning names a span, never a whole utterance: the learned variant is the spoken span and
 *      the term is what the user corrected it to, both delimited on word boundaries so the entry
 *      can be applied again elsewhere without dragging the rest of the sentence into the store.
 */
import type { CorrectionApplication, DictationGlossaryEntry } from './model.js';

/** One whitespace-delimited word of a transcript, with its offsets in the original text. */
export interface WordSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function wordSpans(text: string): readonly WordSpan[] {
  const spans: WordSpan[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const index = match.index ?? 0;
    spans.push({ text: match[0], start: index, end: index + match[0].length });
  }
  return spans;
}

/** The spoken span and the term the user corrected it to. */
export interface CorrectionSpans {
  readonly variant: string;
  readonly term: string;
}

/**
 * The differing span between what was said and what the user corrected it to, delimited on word
 * boundaries. A word-level diff is what keeps "tell Jason …" → "tell JSON …" naming the person's
 * name ("Jason") instead of a character-level fragment that would then protect the wrong text.
 */
export function correctionSpans(raw: string, corrected: string): CorrectionSpans {
  const rawWords = wordSpans(raw);
  const correctedWords = wordSpans(corrected);
  let prefix = 0;
  while (
    prefix < rawWords.length
    && prefix < correctedWords.length
    && rawWords[prefix]?.text === correctedWords[prefix]?.text
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < rawWords.length - prefix
    && suffix < correctedWords.length - prefix
    && rawWords[rawWords.length - 1 - suffix]?.text === correctedWords[correctedWords.length - 1 - suffix]?.text
  ) {
    suffix += 1;
  }
  const rawMiddle = rawWords.slice(prefix, rawWords.length - suffix);
  const correctedMiddle = correctedWords.slice(prefix, correctedWords.length - suffix);
  const variant = rawMiddle.length > 0 ? raw.slice(first(rawMiddle).start, last(rawMiddle).end) : '';
  const term = correctedMiddle.length > 0
    ? corrected.slice(first(correctedMiddle).start, last(correctedMiddle).end)
    : '';
  return { variant, term };
}

function first<T>(values: readonly T[]): T {
  return values[0] as T;
}

function last<T>(values: readonly T[]): T {
  return values[values.length - 1] as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A variant as a whole-word sequence. Whitespace inside a variant is flexible (`\s+`), because ASR
 * spacing is not stable, but the match is bounded by non-word characters on both sides so a variant
 * is never applied inside a longer word.
 */
function variantPattern(variant: string): RegExp {
  const body = variant.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
}

export interface VariantMatch {
  readonly start: number;
  readonly end: number;
  /** The text as the user said it (its own casing), which is what a rejection protects. */
  readonly matched: string;
  readonly variant: string;
  readonly entry: DictationGlossaryEntry;
}

/**
 * Every visible variant occurrence in the transcript, longest first at the same start, with
 * overlapping candidates dropped so one stretch of speech is rewritten at most once.
 */
export function findVariantMatches(
  text: string,
  entries: readonly DictationGlossaryEntry[],
): readonly VariantMatch[] {
  const candidates: VariantMatch[] = [];
  for (const entry of entries) {
    for (const variant of entry.variants) {
      const needle = variant.trim();
      if (needle.length === 0) continue;
      for (const match of text.matchAll(variantPattern(needle))) {
        const index = match.index ?? 0;
        candidates.push({
          start: index,
          end: index + match[0].length,
          matched: match[0],
          variant: needle,
          entry,
        });
      }
    }
  }
  candidates.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const accepted: VariantMatch[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    accepted.push(candidate);
    cursor = candidate.end;
  }
  return accepted;
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Case-sensitive occurrences of every negative example of every visible entry. `indexOf` is the
 * point: the comparison must not fold case, or "Jason" would protect the technical "jason" too.
 */
export function protectedRanges(
  text: string,
  entries: readonly DictationGlossaryEntry[],
): readonly TextRange[] {
  const ranges: TextRange[] = [];
  for (const entry of entries) {
    for (const phrase of entry.negativeExamples) {
      if (typeof phrase !== 'string' || phrase.length === 0) continue;
      let from = 0;
      for (;;) {
        const index = text.indexOf(phrase, from);
        if (index < 0) break;
        ranges.push({ start: index, end: index + phrase.length });
        from = index + 1;
      }
    }
  }
  return ranges;
}

function overlaps(range: TextRange, match: TextRange): boolean {
  return range.start < match.end && match.start < range.end;
}

/**
 * Applies the visible glossary to one committed transcript: every unprotected variant occurrence is
 * replaced by its term, and every substitution is named. Text the glossary does not own — including
 * speech the user explicitly rejected — comes back byte-identical.
 */
export function applyGlossaryCorrections(
  text: string,
  entries: readonly DictationGlossaryEntry[],
): CorrectionApplication {
  const protections = protectedRanges(text, entries);
  const matches = findVariantMatches(text, entries)
    .filter((match) => !protections.some((range) => overlaps(range, match)));

  let corrected = '';
  let cursor = 0;
  for (const match of matches) {
    corrected += text.slice(cursor, match.start) + match.entry.term;
    cursor = match.end;
  }
  corrected += text.slice(cursor);

  return {
    text: corrected,
    applied: matches.map((match) => ({
      term: match.entry.term,
      variant: match.variant,
      scope: match.entry.scope,
    })),
  };
}
