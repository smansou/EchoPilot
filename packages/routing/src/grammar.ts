/**
 * Command grammar for Spoken follow-up (plan §5.6).
 *
 * Only an explicit second-person command ("tell/ask/message <addressee> to <task>") can reach a
 * managed session; everything else stays with the companion. Parsing separates the addressee
 * from the task before any name matching happens, so a task clause that mentions another session
 * ("tell Codex to rerun the failing parser test") can never be mistaken for the destination.
 */
import { normalize } from './text.js';

export type CommandVerb = 'tell' | 'ask' | 'message' | 'notify' | 'ping' | 'brief' | 'send';
export type LocalIntent = 'dictation' | 'desktop' | 'control';
export type ExplicitDestination = 'companion' | 'harness' | 'dictation' | 'desktop' | 'control';

export type ParsedCommand =
  | Readonly<{ kind: 'instruction'; verb: CommandVerb; destination: string; task: string }>
  /** "tell Codex parser" / "tell Codex parser to" — nothing was said to do. */
  | Readonly<{ kind: 'incomplete'; verb: CommandVerb; destination: string }>
  /** "send that to Codex" — the payload is a referent the router cannot resolve. */
  | Readonly<{ kind: 'dangling_referent'; verb: CommandVerb; destination: string }>;

export type ExplicitPrefix = Readonly<{ destination: ExplicitDestination; rest: string }>;

const PREFIX_DESTINATIONS: Readonly<Record<string, ExplicitDestination>> = {
  dictate: 'dictation',
  companion: 'companion',
  harness: 'harness',
  desktop: 'desktop',
  control: 'control',
};

const SESSION_VERBS: ReadonlyArray<CommandVerb> = ['tell', 'ask', 'message', 'notify', 'ping', 'brief'];
const POLITE_PREFIX =
  String.raw`(?:(?:could|can|would)\s+you\s+(?:please\s+)?|i\s+(?:need|want|would\s+like)\s+you\s+to\s+|please\s+)?`;
const VERB_GROUP = `(${SESSION_VERBS.join('|')})`;

const INSTRUCTION = new RegExp(`^${POLITE_PREFIX}${VERB_GROUP}\\s+(.+?)\\s+to\\s+(.+)$`);
const COMMAND_START = new RegExp(`^${POLITE_PREFIX}${VERB_GROUP}\\b`);
const SEND_REFERENT =
  /^send\s+(?:that|this|it|those|these|the\s+(?:last|above|previous|following)(?:\s+\w+)?)\s+(?:to|over\s+to)\s+(.+)$/;
const EXPLICIT_PREFIX = /^(dictate|companion|harness|desktop|control)\s*:\s*([\s\S]*)$/;

const DICTATION = /^(?:dictate|type|insert|write)\b/;
const DESKTOP = /^(?:open|launch|focus|switch|click|scroll|maximize|maximise|minimize|minimise|close|move)\b/;
const CONTROL = /^(?:stop|pause|cancel|mute|unmute|quiet|silence|never\s?mind|that\s?is\s?all|nothing\s?else)\b/;

const LEADING_DISCOURSE: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'right', 'well', 'so', 'um', 'uh', 'hmm', 'hey',
  'and', 'but', 'then', 'now', 'listen',
]);

/** Drops leading filler ("yes, tell Codex …") without ever consuming the whole utterance. */
export function stripLeadingDiscourse(normalized: string): string {
  const words = normalized.split(' ').filter((word) => word.length > 0);
  let index = 0;
  while (index < words.length - 1 && LEADING_DISCOURSE.has(words[index] ?? '')) index += 1;
  return words.slice(index).join(' ');
}

/**
 * Recognizes the frozen cross-subsystem prefixes ("harness:", "dictate:", "companion:",
 * "desktop:", "control:"). These run on the raw text because normalization removes the colon.
 */
export function parseExplicitPrefix(rawText: string): ExplicitPrefix | null {
  const match = EXPLICIT_PREFIX.exec(rawText.trim().toLowerCase());
  if (match === null) return null;
  const destination = PREFIX_DESTINATIONS[match[1] ?? ''];
  if (destination === undefined) return null;
  return {
    destination,
    rest: (match[2] ?? '').trim(),
  };
}

/** Parses a command addressed to a session; returns null when the utterance is not one. */
export function parseCommand(rawText: string): ParsedCommand | null {
  const normalized = stripLeadingDiscourse(normalize(rawText));
  const referent = SEND_REFERENT.exec(normalized);
  if (referent !== null) {
    return { kind: 'dangling_referent', verb: 'send', destination: (referent[1] ?? '').trim() };
  }
  const instruction = INSTRUCTION.exec(normalized);
  if (instruction !== null) {
    const verb = instruction[1] as CommandVerb;
    const destination = (instruction[2] ?? '').trim();
    const task = (instruction[3] ?? '').trim();
    return { kind: 'instruction', verb, destination, task };
  }
  const start = COMMAND_START.exec(normalized);
  if (start !== null) {
    const rest = normalized.slice(start[0].length).replace(/\s+to$/, '').trim();
    return { kind: 'incomplete', verb: start[1] as CommandVerb, destination: rest };
  }
  return null;
}

/** Classifies utterances that never name a session: local dictation, desktop, or control. */
export function localIntent(rawText: string): LocalIntent | null {
  const normalized = stripLeadingDiscourse(normalize(rawText));
  if (DICTATION.test(normalized)) return 'dictation';
  if (CONTROL.test(normalized)) return 'control';
  if (DESKTOP.test(normalized)) return 'desktop';
  return null;
}
