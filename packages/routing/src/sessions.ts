/**
 * Addressee resolution for the addressee router (plan §5.6).
 *
 * A destination is resolved only by matching the spoken addressee phrase against the session's
 * own names: its label ("Codex: parser"), its id ("codex-parser"), or its harness when exactly
 * one active session of that harness exists. Anything less specific — "the session", "the other
 * Codex", a bare harness with two matching sessions — is reported as ambiguous so the companion
 * can ask, and nothing dispatches.
 */
import { normalize, tokens } from './text.js';

export type AddresseeHarness = 'codex' | 'claude' | 'generic';

export type ManagedSession = Readonly<{
  sessionId: string;
  harness: AddresseeHarness;
  label: string;
  projectId?: string;
  active: boolean;
}>;

export type DestinationResolution =
  | Readonly<{ kind: 'resolved'; session: ManagedSession; confidence: number }>
  | Readonly<{ kind: 'ambiguous'; candidates: ReadonlyArray<ManagedSession> }>
  | Readonly<{ kind: 'unmatched' }>;

/** Spoken filler that carries no destination information. */
const LEADING_FILLER: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'both', 'other', 'another', 'that', 'this', 'those', 'these', 'my', 'our',
]);
const TRAILING_FILLER: ReadonlySet<string> = new Set([
  'session', 'sessions', 'agent', 'agents', 'one', 'ones', 'there', 'please',
]);

/** Harness names the user may say instead of the session's own label. */
const HARNESS_ALIASES: Readonly<Record<AddresseeHarness, ReadonlyArray<string>>> = {
  codex: ['codex', 'openai'],
  claude: ['claude', 'anthropic'],
  generic: ['generic', 'agent', 'assistant', 'harness'],
};

type SessionProfile = Readonly<{
  session: ManagedSession;
  labelText: string;
  idText: string;
  labelTokens: ReadonlyArray<string>;
  qualifierText: string;
}>;

function profileOf(session: ManagedSession): SessionProfile {
  const labelTokens = tokens(session.label);
  const harnessTokens = tokens(session.harness);
  const qualifier = labelTokens.filter((token) => !harnessTokens.includes(token));
  return {
    session,
    labelText: normalize(session.label),
    idText: normalize(session.sessionId),
    labelTokens,
    qualifierText: qualifier.join(' '),
  };
}

/**
 * Reduces a spoken addressee phrase to its significant words: "the Codex parser session" and
 * "Codex: parser" both become "codex parser".
 */
export function canonicalAddresseeTokens(phrase: string): string[] {
  const words = tokens(phrase);
  let start = 0;
  let end = words.length;
  while (start < end && LEADING_FILLER.has(words[start] ?? '')) start += 1;
  while (end > start && TRAILING_FILLER.has(words[end - 1] ?? '')) end -= 1;
  return words.slice(start, end);
}

export function resolveDestination(
  sessions: ReadonlyArray<ManagedSession>,
  phrase: string,
): DestinationResolution {
  const phraseTokens = canonicalAddresseeTokens(phrase);
  const phraseText = phraseTokens.join(' ');
  if (phraseText.length === 0) return { kind: 'unmatched' };
  const profiles = sessions.filter((session) => session.active).map(profileOf);

  const exact = profiles.filter((entry) => phraseText === entry.labelText || phraseText === entry.idText);
  if (exact.length === 1) return { kind: 'resolved', session: exact[0]!.session, confidence: 0.99 };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.map((entry) => entry.session) };

  // "Codex parser and Codex tests" names more than one session; a single superset match still
  // resolves ("the Codex parser session, please").
  const contained = profiles.filter(
    (entry) => entry.labelTokens.length > 0 && entry.labelTokens.every((token) => phraseTokens.includes(token)),
  );
  if (contained.length === 1) return { kind: 'resolved', session: contained[0]!.session, confidence: 0.97 };
  if (contained.length > 1) return { kind: 'ambiguous', candidates: contained.map((entry) => entry.session) };

  const qualifier = profiles.filter(
    (entry) => entry.qualifierText.length > 0 && phraseText === entry.qualifierText,
  );
  if (qualifier.length === 1) return { kind: 'resolved', session: qualifier[0]!.session, confidence: 0.96 };
  if (qualifier.length > 1) return { kind: 'ambiguous', candidates: qualifier.map((entry) => entry.session) };

  const harness = profiles.filter((entry) =>
    HARNESS_ALIASES[entry.session.harness].includes(phraseText),
  );
  if (harness.length === 1) return { kind: 'resolved', session: harness[0]!.session, confidence: 0.97 };
  if (harness.length > 1) return { kind: 'ambiguous', candidates: harness.map((entry) => entry.session) };

  return { kind: 'unmatched' };
}
