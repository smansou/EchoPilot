/**
 * N02 spoken formatting — §5.7 stage 6: the deterministic line between what the terminal prints and
 * what a person hears.
 *
 * Ordinary mode is the default and is lossy in exactly one direction: URLs become their site label,
 * file paths become their basenames and inline code becomes spoken words, so a listener never hears
 * a raw separator (`/`, `\`, `://`) or a backtick. Exact mode is the explicit "read it exactly"
 * request and returns the text untouched — the user's request outranks the ordinary rule, and the
 * caller keeps an exact reading bounded by splitting it into segments.
 *
 * The passes run from the most specific shape to the least: a backtick span is code whatever it
 * holds, a URL keeps only its host, a path keeps only its basename (with a trailing source location
 * read as words), a call-like span is code even without backticks, and whatever punctuation survives
 * is spoken by the N01 literal renderer so identifiers are never spelled out letter by letter.
 */
import { spokenLiteral } from '../format.js';

export type SpeechFormatOptions = Readonly<{ exact?: boolean }>;

/** `scheme://host/...` — the site label is the host alone. */
const URL_TOKEN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/gu;
/** A backtick span is code whatever it holds, so it is rendered before the path and URL passes. */
const BACKTICK_SPAN = /`([^`]*)`/gu;
/** Absolute, dot-relative and nested relative path tokens. */
const PATH_TOKEN = /(?:~\/|\/|\.\.?\/)(?:[A-Za-z0-9_.@+%-]+\/?)+|(?:[A-Za-z0-9_.@+%-]+\/)+[A-Za-z0-9_.@+%-]*/gu;
/** `name(...)` and `ns.name({ ... })` are code calls even without backticks around them. */
const CALL_SPAN = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\([^()]*(?:\([^()]*\)[^()]*)*\)/gu;
/** `(41,7)` right after a path is a source location, not code. */
const SOURCE_LOCATION = /\((\d+),(\d+)\)/gu;
/** What is left of a code token once paths, URLs, calls and backtick spans are gone. */
const CODE_PUNCTUATION = /[{}[\]<>=`]/u;
/** Last resort: no ordinary utterance may carry a raw separator or a backtick. */
const SEPARATORS = /[/\\`]/gu;
const WHITESPACE = /\s+/gu;

/** The site label of one URL token: the host with its dots spoken. */
function speakUrl(match: string): string {
  const host = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@\s]+@)?([^/?#:\s]+)/u.exec(match)?.[1];
  if (host === undefined || host.length === 0) return spokenLiteral(match);
  return spokenLiteral(host);
}

/** The meaningful basename of one path token: `/a/b/parse-2.ts` is heard as "parse dash 2 dot ts". */
function speakPath(match: string): string {
  const segments = match.split('/').filter((segment) => segment.length > 0);
  const base = segments.at(-1);
  if (base === undefined || base.length === 0) return spokenLiteral(match);
  return spokenLiteral(base);
}

/** Ordinary spoken rendering of one stream line, path, URL or code fragment. */
function speakOrdinary(text: string): string {
  let output = text;
  output = output.replace(BACKTICK_SPAN, (_match, inner: string) => spokenLiteral(inner));
  output = output.replace(URL_TOKEN, (match) => speakUrl(match));
  output = output.replace(PATH_TOKEN, (match) => speakPath(match));
  output = output.replace(CALL_SPAN, (match) => spokenLiteral(match));
  output = output.replace(SOURCE_LOCATION, (_match, line: string, column: string) => `line ${line} column ${column}`);
  output = output.replace(/\S+/gu, (token) => (CODE_PUNCTUATION.test(token) ? spokenLiteral(token) : token));
  output = output.replace(SEPARATORS, ' ');
  return output.replace(WHITESPACE, ' ').trim();
}

/**
 * `formatForSpeech(text, { exact: true })` is `text` verbatim; every other call — `formatForSpeech
 * (text)` and `formatForSpeech(text, { exact: false })` alike — is ordinary speakable text.
 */
export function formatForSpeech(text: string, options: SpeechFormatOptions = {}): string {
  if (options.exact === true) return text;
  return speakOrdinary(text);
}
