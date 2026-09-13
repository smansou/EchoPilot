/**
 * N01 spoken formatting: factual templates plus the deterministic line between what a terminal
 * prints and what a person hears.
 *
 * The plan's narration scope calls out URL/path/code spoken formatting. N01 keeps that rule small
 * and testable: a literal that will be read back verbatim is rendered as words (`/` is "slash",
 * `.` is "dot", camelCase splits), so a later exact-TTS path can speak identifiers without the
 * engine guessing at punctuation. The completion summary itself is a template over observed counts
 * and the observed exit code — it never recites a command's log lines.
 */

import type { CheckCounts } from './outcome.js';

/** §5.7 concise budget: 25–50 words per logical update; the N01 completion outcome sits under it. */
export const CONCISE_MAX_WORDS = 50;

/** Rough local-voice pacing used to give one segment a positive time budget. */
const WORDS_PER_SECOND = 2.5;

const SCRIPT_EXTENSIONS = ['.mjs', '.cjs', '.jsx', '.tsx', '.mts', '.cts', '.js', '.ts', '.py', '.sh'];
/** Interpreter/shell words that describe how a command ran, not what ran. */
const SHELL_WORDS = new Set(['node', 'npx', 'pnpm', 'npm', 'yarn', 'bun', 'deno', 'python', 'python3', 'bash', 'sh', 'zsh', 'env', 'sudo', 'time']);
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

const PUNCTUATION_WORDS: Readonly<Record<string, string>> = {
  '/': 'slash',
  '\\': 'slash',
  '.': 'dot',
  ',': 'comma',
  ';': 'semicolon',
  '-': 'dash',
  '_': 'underscore',
  ':': 'colon',
  '@': 'at',
  '#': 'hash',
  '?': 'question mark',
  '!': 'bang',
  '=': 'equals',
  '&': 'ampersand',
  '|': 'pipe',
  '+': 'plus',
  '*': 'star',
  '%': 'percent',
  '$': 'dollar',
  '^': 'caret',
  '~': 'tilde',
  '`': 'backtick',
  '(': 'open paren',
  ')': 'close paren',
  '[': 'open bracket',
  ']': 'close bracket',
  '{': 'open brace',
  '}': 'close brace',
  '<': 'less than',
  '>': 'greater than',
};

export function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
}

/** Keeps an utterance inside the concise budget even when a command or path is unusually long. */
export function truncateToWords(text: string, limit: number = CONCISE_MAX_WORDS): string {
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  if (words.length <= limit) return words.join(' ');
  return `${words.slice(0, limit).join(' ')}…`;
}

/** One segment's positive time budget, derived from its own spoken text. */
export function estimateSeconds(text: string): number {
  return Math.min(60, Math.max(1, Math.ceil(wordCount(text) / WORDS_PER_SECOND)));
}

function splitCamel(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');
}

/**
 * Renders a literal (path, URL or code token) the way concise narration says it: identifiers and
 * punctuation become words instead of characters the voice engine would have to guess at.
 */
export function spokenLiteral(value: string): string {
  const pieces: string[] = [];
  for (const token of splitCamel(value.trim()).split(/([A-Za-z0-9]+)/u)) {
    if (token.length === 0) continue;
    if (/^[A-Za-z0-9]+$/u.test(token)) {
      pieces.push(token);
      continue;
    }
    for (const character of token) {
      const spoken = /^\s$/u.test(character) ? null : PUNCTUATION_WORDS[character] ?? character;
      if (spoken !== null && spoken.length > 0) pieces.push(spoken);
    }
  }
  return pieces.join(' ');
}

/**
 * The artifact a managed command ran: the first token that names a script, otherwise the first
 * token that is not the interpreter itself. Returns null when the command says nothing usable.
 */
export function spokenArtifactName(command: string | null): string | null {
  if (command === null) return null;
  const tokens = command
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0 && !token.startsWith('-'));
  const script = tokens.find((token) => SCRIPT_EXTENSIONS.some((extension) => token.toLowerCase().endsWith(extension)));
  const chosen = script ?? tokens.find((token) => !SHELL_WORDS.has(token.toLowerCase()));
  if (chosen === undefined) return null;
  const base = chosen.split(/[\\/]/u).pop() ?? chosen;
  const withoutExtension = SCRIPT_EXTENSIONS
    .reduce((name, extension) => (name.toLowerCase().endsWith(extension) ? name.slice(0, -extension.length) : name), base);
  if (withoutExtension.length === 0 || !ARTIFACT_NAME.test(withoutExtension)) return null;
  return withoutExtension;
}

export type CompletionSpeechInput = Readonly<{
  status: 'passed' | 'failed';
  exitCode: number;
  counts: CheckCounts | null;
  artifact: string | null;
}>;

/**
 * The counts a completion sentence may recite: only totals that agree with the observed exit code.
 * A summary that contradicts the receipt is dropped instead of being spoken, so the one utterance
 * stays factual (`(failed > 0)` must equal `(exitCode !== 0)`).
 */
function countsAgreeingWithExit(counts: CheckCounts | null, exitCode: number): CheckCounts | null {
  if (counts === null) return null;
  if ((counts.failed > 0) !== (exitCode !== 0)) return null;
  return counts;
}

/**
 * The one completion sentence for a finished turn. It leads with the observed result (a blocking
 * failure is announced as the turn's outcome, not as a second utterance) and cites no agent text.
 */
export function completionSpokenText(input: CompletionSpeechInput): string {
  const subject = input.artifact ?? 'The managed test';
  const counts = countsAgreeingWithExit(input.counts, input.exitCode);
  if (input.status === 'failed') {
    const text = counts === null
      ? `${subject} failed: exit code ${input.exitCode}.`
      : `${subject} failed: ${counts.failed} of ${counts.total} checks failed, exit code ${input.exitCode}.`;
    return truncateToWords(text);
  }
  const text = counts === null
    ? `${subject} passed: exit code ${input.exitCode}.`
    : `${subject} passed: ${counts.passed} of ${counts.total} checks passed, exit code ${input.exitCode}.`;
  return truncateToWords(text);
}

/** The single blocking announcement for a recorded evidence gap: incomplete is spoken as incomplete. */
export function gapSpokenText(): string {
  return 'Evidence gap recorded: part of this session was never observed, so nothing can be confirmed.';
}
