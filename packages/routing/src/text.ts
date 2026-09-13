/**
 * Deterministic text utilities for the addressee router.
 *
 * Routing never calls a language model: the same utterance must always produce the same
 * decision, and partially decoded speech must be rejected before it can act. Normalizing case,
 * punctuation, and hyphens up front is what makes "Codex: parser", "codex-parser", and
 * "codex parser" one destination.
 */

/** Lower-cases the text and collapses every non-alphanumeric run into single spaces. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Normalized whitespace-separated tokens; empty when the text has no alphanumeric content. */
export function tokens(text: string): string[] {
  const normalized = normalize(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

const WAKE_WORD = /^(?:(?:hey|hi|ok|okay)\s+)?echo\b[\s,:-]*/i;

/** Drops a leading wake word ("Echo, …") so the grammar sees the user's actual intent. */
export function stripWakeWord(text: string): string {
  return text.trim().replace(WAKE_WORD, '').trim();
}
