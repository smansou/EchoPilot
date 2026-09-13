/**
 * A02 evidence citations — a substitution is backed, or it is offered instead of applied.
 *
 * An `evidence`-basis edit is only valid when an evidence text the model actually received contains
 * the replacement. `AssembledContext` reports the admitted evidence ids and the exact bounded
 * prompt, but not the admitted evidence *texts*, and the shared assembler only ever admits a
 * whitespace prefix of an evidence text (`trimToLimit`). Recovering that prefix from the prompt
 * keeps this check a measurement of the request that was sent: an evidence item the budget dropped
 * or clipped can neither corroborate nor be cited, even though it was offered.
 */

export interface CitationEvidenceItem {
  readonly id: string;
  readonly text: string;
}

/**
 * The prefix of `text` that is present in the assembled prompt, or `null` when none of it is.
 * The assembler admits either the whole text or a whitespace-joined prefix of it, so a binary
 * search over the word prefix is exact.
 */
export function admittedEvidenceText(prompt: string, text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (prompt.includes(text)) return text;
  const parts = text.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  let low = 0;
  let high = parts.length;
  let best = 0;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const candidate = parts.slice(0, middle).join(' ');
    if (prompt.includes(candidate)) {
      best = middle;
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return best === 0 ? null : parts.slice(0, best).join(' ');
}

/**
 * The admitted evidence ids whose text (as the model received it) contains `replacement`,
 * case-insensitively. An empty result means the proposal has no evidence and must be offered as an
 * unresolved span rather than applied. An empty replacement is never corroborated: deleting text
 * cannot be a grounded token substitution.
 */
export function corroboratingEvidenceIds(
  prompt: string,
  admitted: ReadonlyArray<CitationEvidenceItem>,
  replacement: string,
): ReadonlyArray<string> {
  const needle = replacement.toLowerCase();
  if (needle.length === 0) return [];
  const ids: string[] = [];
  for (const item of admitted) {
    const text = admittedEvidenceText(prompt, item.text);
    if (text !== null && text.toLowerCase().includes(needle)) ids.push(item.id);
  }
  return ids;
}
