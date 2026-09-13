/**
 * Utterances that must never trigger an action (plan §5.6 / §5.7): short acknowledgments that
 * repeat ambient speech ("yes", "okay", "go ahead"), and partial ASR handled by the router.
 *
 * A pending confirmation may bind an acknowledgment to a queued action, but that binding belongs
 * to the pending-decision layer. The router therefore reports a hold instead of guessing a
 * destination, which keeps ambient audio from dispatching work to a managed session.
 */
import { tokens } from './text.js';

const AMBIENT_ACKNOWLEDGMENTS: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'sure', 'ok', 'okay', 'k', 'mm hm', 'mmhmm', 'mhm',
  'uh huh', 'uhhuh', 'right', 'correct', 'exactly', 'affirmative', 'got it', 'agreed',
  'of course', 'go ahead', 'do it', 'do that', 'please do', 'sounds good', 'no thanks',
  'thanks', 'thank you', 'no', 'nope', 'not now',
]);

const TRAILING_POLITENESS: ReadonlySet<string> = new Set(['please', 'then', 'thanks']);

function trimPoliteness(words: ReadonlyArray<string>): string[] {
  const trimmed = [...words];
  while (trimmed.length > 0 && TRAILING_POLITENESS.has(trimmed[trimmed.length - 1] ?? '')) trimmed.pop();
  const last = trimmed[trimmed.length - 1];
  if (last === 'you' && trimmed[trimmed.length - 2] === 'thank') trimmed.splice(-2);
  return trimmed;
}

/**
 * True when the utterance is only an acknowledgment: four words or fewer that all belong to the
 * acknowledgment vocabulary. Longer sentences stay routable so "yes, tell Codex …" still works.
 */
export function isAmbientAcknowledgment(text: string): boolean {
  const words = trimPoliteness(tokens(text));
  if (words.length === 0 || words.length > 4) return false;
  return AMBIENT_ACKNOWLEDGMENTS.has(words.join(' '));
}
