/**
 * Deterministic question → record matching for the records layer (M04).
 *
 * An answer may only report records that the request actually references: a decision's question, a
 * fact's subject, or a task's id. Overlap is measured on content tokens with the closed-class words
 * every question carries dropped, and a single shared token only counts when it is distinctive (long
 * enough, or the whole key) — otherwise "Where does Atlas durable memory live?" would also pull in
 * the "Atlas widget polling" decision just because both mention Atlas, and a fresh question would
 * match every record that happens to share the word "should".
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'into',
  'about', 'over', 'under', 'this', 'that', 'these', 'those', 'it', 'its', 'there', 'here',
  'what', 'whats', 'which', 'where', 'when', 'who', 'whom', 'whose', 'why', 'how',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
  'should', 'would', 'could', 'can', 'will', 'shall', 'may', 'might', 'must',
  'use', 'used', 'uses', 'using', 'have', 'has', 'had',
]);

/** Lowercased alphanumeric content tokens; closed-class and one/two letter tokens are dropped. */
export function contentTokens(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export function normalizeKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when the asked question references the record key (its question or subject). Two shared
 * content tokens are a reference; one shared token counts when it is at least six characters or is
 * the record's entire key.
 */
export function bearsOnQuestion(question: string, keys: readonly (string | undefined)[]): boolean {
  const asked = new Set(contentTokens(question));
  if (asked.size === 0) return false;
  for (const key of keys) {
    if (key === undefined || key.length === 0) continue;
    const keyTokens = [...new Set(contentTokens(key))];
    if (keyTokens.length === 0) continue;
    const shared = keyTokens.filter((token) => asked.has(token));
    if (shared.length >= 2) return true;
    if (shared.length === 1) {
      const only = shared[0];
      if (only !== undefined && (only.length >= 6 || keyTokens.length === 1)) return true;
    }
  }
  return false;
}
