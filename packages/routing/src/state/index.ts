/**
 * R03 routing state (IMPLEMENTATION_PLAN.md §5.6 precedence 1–6) — conversational ambiguity,
 * session switches, and permissions → correct bounded dialogue.
 *
 * The frozen addressee router (packages/routing/src/index.ts) already classifies single
 * utterances: partial ASR, ambient acknowledgments, explicit prefixes, ambiguity, and quoted
 * misreads. This module holds the *conversation* around that classifier:
 *
 *   1. global emergency controls ("stop all", "stop speaking", "pause", "mute") work in every
 *      mode and are never dispatched;
 *   2. dictation mode keeps text literal until DICTATION_END_PHRASE, with a literal escape
 *      phrase that lets control words be dictated instead of executed;
 *   3. explicit prefixes keep their frozen meaning;
 *   4. a pending companion question binds the next answer to its request id for
 *      PENDING_ANSWER_EXPIRY_MS, and a stale binding can never reach the session it named;
 *   5. Agent Direct routes ordinary instructions to the displayed session, ends on an explicit
 *      exit, a project change, or AGENT_DIRECT_INACTIVITY_MS of inactivity, and reports every
 *      entry/exit as a visible label plus an audible cue;
 *   6. everything else stays with the frozen classifier, including one-question clarification.
 *
 * Quoted content is never an instruction: when the utterance's first instruction-shaped span
 * sits inside quotation marks, nothing is dispatched — even when the quoted words look like an
 * explicit prefix — while a genuine instruction that merely mentions a quoted phrase still
 * dispatches.
 */
import {
  AUTO_DISPATCH_MIN_CONFIDENCE,
  createAddresseeRouter,
  type ManagedSession,
  type RoutingDecision,
  type RoutingUtterance,
} from '../index.js';
import { localIntent, parseCommand, parseExplicitPrefix } from '../grammar.js';
import { resolveDestination, type DestinationResolution } from '../sessions.js';
import { normalize, stripWakeWord } from '../text.js';

/** Plan §5.6 rule 4: a pending companion question binds the next answer for 30 seconds. */
export const PENDING_ANSWER_EXPIRY_MS = 30_000;
/** Plan §5.6 rule 5: Agent Direct lasts until switched, a project change, or five minutes idle. */
export const AGENT_DIRECT_INACTIVITY_MS = 300_000;
/** Plan §5.6 rule 2 / A-F1: dictation stays literal until this phrase. */
export const DICTATION_END_PHRASE = 'finish dictation';
/** Plan §5.6 rule 2: this phrase is consumed and the words after it are dictated, not executed. */
export const DICTATION_ESCAPE_PHRASE = 'literal';

export type ModeKind = 'companion' | 'agent_direct' | 'dictation';
export type ControlKind = 'stop_all' | 'stop_speaking' | 'pause' | 'mute';

export type RoutingMode = Readonly<{ kind: ModeKind; sessionId?: string; since: string }>;

export type ModeChange = Readonly<{ from: ModeKind; to: ModeKind; cue: string; visible: string }>;

export type PendingQuestion = Readonly<{
  requestId: string;
  question: string;
  candidates: ReadonlyArray<string>;
  expiresAt: string;
}>;

/** The frozen contract fields plus the R03 conversation extensions. */
export type R03RoutingDecision = RoutingDecision &
  Readonly<{
    mode?: RoutingMode;
    modeChange?: ModeChange;
    pending?: Readonly<{ requestId: string; expiresAt: string }>;
    answer?: Readonly<{ requestId: string }>;
    expiredPending?: ReadonlyArray<string>;
    dictation?: Readonly<{ literal: string }>;
    control?: ControlKind;
    /** The turn quoted an instruction-shaped span; nothing was dispatched. */
    quotedContent?: true;
  }>;

export type RoutingState = Readonly<{
  setActiveSessions(sessions: ReadonlyArray<ManagedSession>): void;
  setProject(projectId: string): void;
  mode(): RoutingMode;
  pending(): ReadonlyArray<PendingQuestion>;
  route(utterance: RoutingUtterance): R03RoutingDecision;
}>;

export type RoutingStateOptions = Readonly<{
  sessions: ReadonlyArray<ManagedSession>;
  now?: () => Date;
}>;

const CONTROL_PATTERNS: ReadonlyArray<readonly [ControlKind, RegExp]> = [
  ['stop_all', /^stop\s+all\b/i],
  ['stop_speaking', /^stop\s+speaking\b/i],
  ['pause', /^pause\b/i],
  ['mute', /^mute\b/i],
];

const DICTATION_ENTRY =
  /^(?:(?:start|begin|enter|enable|activate|turn\s+on|switch\s+to|go\s+to|use)\s+)?(?:dictation|dictating)(?:\s+mode)?$/;
const AGENT_DIRECT_EXIT =
  /^(?:stop|end|exit|leave|turn\s+off|switch\s+off|disable)\s+(?:the\s+)?(?:agent|assistant)\s*direct(?:\s+mode)?$/;
const AGENT_DIRECT_ENTRY_PREFIX =
  /^(?:switch\s+to|start|enter|enable|activate|turn\s+on|go\s+to|go|use|open)?$/;
/** A question stays with the companion even while Agent Direct is active. */
const QUERY_START =
  /^(?:what|which|when|where|who|whom|whose|why|how|remind|tell\s+me|is|are|was|were|has|have|had|did|does)\b/;

/** "codex-parser" → "Codex Parser", so the cue names the session the way the user knows it. */
function humanizeSessionId(sessionId: string): string {
  const words = sessionId.split(/[^a-zA-Z0-9]+/).filter((word) => word.length > 0);
  if (words.length === 0) return sessionId;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function conjunctionList(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

/** One short question that names the destinations the user must choose between. */
function questionText(candidates: ReadonlyArray<string>): string {
  const names = [...new Set(candidates)].map(humanizeSessionId);
  if (names.length === 0) return 'Which session did you mean?';
  return `Which session did you mean: ${conjunctionList(names)}?`;
}

function cueFor(from: ModeKind, to: RoutingMode): string {
  if (to.kind === 'agent_direct') {
    const bound = to.sessionId === undefined ? '' : ` for ${humanizeSessionId(to.sessionId)}`;
    return `Agent Direct is on${bound}. Everything you say goes to that session until you stop it.`;
  }
  if (to.kind === 'dictation') {
    return `Dictation mode is on. Everything you say is typed literally until you say "${DICTATION_END_PHRASE}".`;
  }
  return from === 'dictation'
    ? 'Dictation mode is off. Back to companion mode.'
    : 'Agent Direct is off. Back to companion mode.';
}

function visibleFor(mode: RoutingMode): string {
  if (mode.kind === 'agent_direct') {
    return mode.sessionId === undefined ? 'Agent Direct' : `Agent Direct: ${humanizeSessionId(mode.sessionId)}`;
  }
  if (mode.kind === 'dictation') return 'Dictation';
  return 'Companion';
}

function confidenceOf(utterance: RoutingUtterance): number | undefined {
  const value = utterance.asrConfidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the words would parse as a command or an explicit route prefix on their own. */
function looksInstructionShaped(text: string): boolean {
  if (parseExplicitPrefix(text) !== null) return true;
  return parseCommand(text) !== null;
}

type QuoteRegion = Readonly<{ start: number; end: number }>;

/** Paired double-quote spans (plain and typographic). */
function quoteRegions(text: string): QuoteRegion[] {
  const regions: QuoteRegion[] = [];
  for (const [open, close] of [['"', '"'], ['\u201c', '\u201d']] as ReadonlyArray<readonly [string, string]>) {
    let cursor = 0;
    for (;;) {
      const start = text.indexOf(open, cursor);
      if (start < 0) break;
      const closeAt = text.indexOf(close, start + open.length);
      if (closeAt < 0) break;
      regions.push({ start, end: closeAt + close.length - 1 });
      cursor = closeAt + close.length;
    }
  }
  return regions.sort((left, right) => left.start - right.start);
}

/** Index of the first instruction-shaped span, or -1 when the utterance is not one. */
function firstInstructionShapedIndex(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const previous = index === 0 ? '' : (text[index - 1] ?? '');
    if (index > 0 && /[a-zA-Z0-9]/.test(previous)) continue;
    if (looksInstructionShaped(text.slice(index))) return index;
  }
  return -1;
}

/**
 * True when the first instruction-shaped span is quoted content: the adversarial frames wrap a
 * command in quotation marks and then talk *about* it. A genuine instruction that merely
 * mentions a quoted phrase keeps its first span outside the quotes, so it still dispatches.
 */
function firstInstructionIsQuoted(text: string): boolean {
  const regions = quoteRegions(text);
  if (regions.length === 0) return false;
  const index = firstInstructionShapedIndex(text);
  if (index < 0) return false;
  return regions.some((region) => index >= region.start && index <= region.end);
}

/** Everything outside quotation marks — the words that may actually address a session. */
function unquotedText(text: string): string {
  return text
    .replace(/"[^"]*"/g, ' ')
    .replace(/\u201c[^\u201d]*\u201d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function controlKindOf(text: string): ControlKind | null {
  const trimmed = stripWakeWord(text).trim();
  for (const [kind, pattern] of CONTROL_PATTERNS) {
    if (pattern.test(trimmed)) return kind;
  }
  return null;
}

/** "agent direct" (optionally with a leading verb and a named session) enters Agent Direct. */
function agentDirectEntry(
  text: string,
  sessions: ReadonlyArray<ManagedSession>,
): DestinationResolution | null {
  const normalized = normalize(stripWakeWord(text));
  const phrase = 'agent direct';
  const index = normalized.indexOf(phrase);
  if (index < 0) return null;
  if (!AGENT_DIRECT_ENTRY_PREFIX.test(normalized.slice(0, index).trim())) return null;
  const remainder = normalized
    .slice(index + phrase.length)
    .replace(/^[\s:,-]+/, '')
    .replace(/\bmode\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return resolveDestination(sessions, remainder);
}

export function createRoutingState(options: RoutingStateOptions): RoutingState {
  const clock = options.now ?? ((): Date => new Date());
  const router = createAddresseeRouter({ sessions: options.sessions });
  let sessions: ReadonlyArray<ManagedSession> = [...options.sessions];
  let currentMode: RoutingMode = { kind: 'companion', since: clock().toISOString() };
  let lastActivityMs = clock().getTime();
  let project: string | undefined;
  let pendingModeChange: ModeChange | null = null;
  let pendingQuestions: PendingQuestion[] = [];
  let requestSequence = 0;

  function activeSessions(): ReadonlyArray<ManagedSession> {
    return sessions.filter((session) => session.active);
  }

  function activeSessionIds(): string[] {
    return activeSessions().map((session) => session.sessionId);
  }

  function companionMode(): RoutingMode {
    return { kind: 'companion', since: clock().toISOString() };
  }

  /** Every mode change is recorded so the next turn can speak and show it. */
  function enterMode(next: RoutingMode): void {
    if (next.kind === currentMode.kind && next.sessionId === currentMode.sessionId) return;
    const previous = currentMode;
    currentMode = next;
    // Inactivity is measured from the last route() call while the mode is displayed; the entry
    // itself counts as activity for the session it binds.
    if (next.kind === 'agent_direct') lastActivityMs = clock().getTime();
    pendingModeChange = {
      from: previous.kind,
      to: next.kind,
      cue: cueFor(previous.kind, next),
      visible: visibleFor(next),
    };
  }

  function refreshAgentDirectStaleness(): void {
    if (currentMode.kind !== 'agent_direct') return;
    if (clock().getTime() - lastActivityMs <= AGENT_DIRECT_INACTIVITY_MS) return;
    enterMode(companionMode());
  }

  /** Drops bindings whose 30-second window has passed before this utterance is routed. */
  function dropExpiredPending(): string[] {
    if (pendingQuestions.length === 0) return [];
    const nowMs = clock().getTime();
    const expired = pendingQuestions
      .filter((entry) => Date.parse(entry.expiresAt) <= nowMs)
      .map((entry) => entry.requestId);
    if (expired.length === 0) return [];
    pendingQuestions = pendingQuestions.filter((entry) => Date.parse(entry.expiresAt) > nowMs);
    return expired;
  }

  function askQuestion(decision: RoutingDecision): R03RoutingDecision {
    if (decision.requiresClarification !== true) return decision;
    const candidates =
      decision.candidates !== undefined && decision.candidates.length > 0
        ? [...decision.candidates]
        : activeSessionIds();
    requestSequence += 1;
    const requestId = `pending-${requestSequence}`;
    const expiresAt = new Date(clock().getTime() + PENDING_ANSWER_EXPIRY_MS).toISOString();
    const question: PendingQuestion = { requestId, question: questionText(candidates), candidates, expiresAt };
    pendingQuestions.push(question);
    return { ...decision, pending: { requestId, expiresAt } };
  }

  function classificationOf(utterance: RoutingUtterance, text: string): R03RoutingDecision {
    return askQuestion(router.route({ ...utterance, text }));
  }

  function modeDispatch(utteranceId: string, sessionId: string, asr: number | undefined): R03RoutingDecision {
    const confidence = Math.min(0.98, asr ?? 0.98);
    if (confidence < AUTO_DISPATCH_MIN_CONFIDENCE) {
      return askQuestion({
        utteranceId,
        destination: 'harness',
        targetSessionId: sessionId,
        confidence: AUTO_DISPATCH_MIN_CONFIDENCE - 0.01,
        basis: 'clarified',
        requiresClarification: true,
        candidates: [sessionId],
      });
    }
    return {
      utteranceId,
      destination: 'harness',
      targetSessionId: sessionId,
      confidence,
      basis: 'active_mode',
      requiresClarification: false,
    };
  }

  /**
   * A question ("Echo, what is the deploy status?"), a desktop intent, or quoted content stays
   * with the companion even while Agent Direct is displayed.
   */
  function staysLocal(text: string): boolean {
    const withoutWake = stripWakeWord(text).trim();
    if (withoutWake.length === 0) return true;
    if (/\?\s*$/.test(text)) return true;
    if (localIntent(withoutWake) !== null) return true;
    return QUERY_START.test(normalize(withoutWake));
  }

  function dictationTurn(utteranceId: string, text: string): R03RoutingDecision {
    const escape = new RegExp(`^${escapeRegExp(DICTATION_ESCAPE_PHRASE)}[\\s,:;-]*`, 'i').exec(text.trim());
    if (escape !== null) {
      // The escape phrase is consumed and the words after it are dictated, so control words can
      // be spoken without being executed.
      const literal = text.trim().slice(escape[0].length).trim();
      return {
        utteranceId,
        destination: 'dictation',
        confidence: 0.99,
        basis: 'active_mode',
        requiresClarification: false,
        dictation: { literal },
      };
    }
    if (normalize(stripWakeWord(text)) === normalize(DICTATION_END_PHRASE)) {
      enterMode(companionMode());
      return {
        utteranceId,
        destination: 'control',
        confidence: 0.99,
        basis: 'explicit_prefix',
        requiresClarification: false,
      };
    }
    return {
      utteranceId,
      destination: 'dictation',
      confidence: 0.99,
      basis: 'active_mode',
      requiresClarification: false,
      dictation: { literal: text },
    };
  }

  function answerTo(text: string, asr: number | undefined): Readonly<{ requestId: string; sessionId: string }> | null {
    const head = pendingQuestions[0];
    if (head === undefined) return null;
    if (looksInstructionShaped(text) || localIntent(text) !== null) return null;
    const candidates = activeSessions().filter((session) => head.candidates.includes(session.sessionId));
    const resolution = resolveDestination(candidates, stripWakeWord(text));
    if (resolution.kind !== 'resolved') return null;
    const confidence = Math.min(0.99, asr ?? 0.99);
    if (confidence < AUTO_DISPATCH_MIN_CONFIDENCE) return null;
    return { requestId: head.requestId, sessionId: resolution.session.sessionId };
  }

  function route(utterance: RoutingUtterance): R03RoutingDecision {
    const utteranceId = utterance.utteranceId;
    const text = typeof utterance.text === 'string' ? utterance.text : '';
    const asr = confidenceOf(utterance);
    const expiredPending = dropExpiredPending();
    refreshAgentDirectStaleness();

    const finish = (decision: R03RoutingDecision): R03RoutingDecision => {
      const change = pendingModeChange;
      pendingModeChange = null;
      return {
        ...decision,
        mode: { ...currentMode },
        ...(change === null ? {} : { modeChange: change }),
        ...(expiredPending.length === 0 ? {} : { expiredPending: [...expiredPending] }),
      };
    };

    // Partial transcripts and empty utterances never act: the router holds them, so they cannot
    // enter a mode, answer a pending question, or reach a session.
    if (utterance.partial === true || normalize(text).length === 0) {
      return finish(classificationOf(utterance, text));
    }

    // Precedence 1 — the global emergency controls work in every mode and are never dispatched.
    const control = controlKindOf(text);
    if (control !== null) {
      return finish({
        utteranceId,
        destination: 'control',
        confidence: 0.99,
        basis: 'explicit_prefix',
        requiresClarification: false,
        control,
      });
    }

    // Precedence 2 — dictation keeps everything literal until the end phrase.
    if (currentMode.kind === 'dictation') return finish(dictationTurn(utteranceId, text));

    // Mode changes are local control turns: they carry the visible label and the audible cue.
    const entry = agentDirectEntry(text, activeSessions());
    if (entry !== null) {
      if (entry.kind === 'resolved') {
        enterMode({ kind: 'agent_direct', sessionId: entry.session.sessionId, since: clock().toISOString() });
        return finish(modeTurn(utteranceId));
      }
      if (entry.kind === 'ambiguous') {
        return finish(askQuestion(clarificationOf(utteranceId, entry.candidates.map((session) => session.sessionId))));
      }
      if (activeSessions().length === 1) {
        enterMode({ kind: 'agent_direct', sessionId: activeSessions()[0]!.sessionId, since: clock().toISOString() });
        return finish(modeTurn(utteranceId));
      }
      return finish(askQuestion(clarificationOf(utteranceId, activeSessionIds())));
    }

    if (DICTATION_ENTRY.test(normalize(stripWakeWord(text)))) {
      enterMode({ kind: 'dictation', since: clock().toISOString() });
      return finish(modeTurn(utteranceId));
    }

    if (AGENT_DIRECT_EXIT.test(normalize(stripWakeWord(text)))) {
      if (currentMode.kind === 'agent_direct') enterMode(companionMode());
      return finish(modeTurn(utteranceId));
    }

    // Precedence 3 — explicit prefixes keep their frozen meaning.
    const explicit = parseExplicitPrefix(text);
    if (explicit !== null) {
      if (explicit.destination === 'harness') {
        return finish(classificationOf(utterance, explicit.rest));
      }
      return finish({
        utteranceId,
        destination: explicit.destination,
        confidence: 0.98,
        basis: 'explicit_prefix',
        requiresClarification: false,
      });
    }

    // Precedence 4 — the pending question binds the next answer to its request id; a stale
    // binding was already dropped, so a stale answer can never reach the session it named.
    const answer = answerTo(text, asr);
    if (answer !== null) {
      pendingQuestions = pendingQuestions.slice(1);
      return finish({
        utteranceId,
        destination: 'harness',
        targetSessionId: answer.sessionId,
        confidence: Math.min(0.99, asr ?? 0.99),
        basis: 'clarified',
        requiresClarification: false,
        answer: { requestId: answer.requestId },
      });
    }

    // Quoted content is never an instruction, in any mode.
    if (firstInstructionIsQuoted(text)) {
      return finish({
        utteranceId,
        destination: 'companion',
        confidence: 0.9,
        basis: 'classified',
        requiresClarification: false,
        quotedContent: true,
      });
    }

    // Precedence 5 — Agent Direct routes ordinary instructions to the displayed session.
    if (currentMode.kind === 'agent_direct' && currentMode.sessionId !== undefined) {
      lastActivityMs = clock().getTime();
      const classified = classificationOf(utterance, text);
      if (classified.destination === 'companion' && classified.hold === undefined && classified.requiresClarification !== true) {
        if (staysLocal(text)) return finish(classified);
        return finish(modeDispatch(utteranceId, currentMode.sessionId, asr));
      }
      return finish(classified);
    }

    // Precedence 6 — classification and one-question clarification. Quoted spans are removed
    // first so a quote at the start of the utterance cannot be read as a command.
    return finish(classificationOf(utterance, unquotedText(text)));
  }

  function modeTurn(utteranceId: string): R03RoutingDecision {
    return {
      utteranceId,
      destination: 'control',
      confidence: 0.99,
      basis: 'explicit_prefix',
      requiresClarification: false,
    };
  }

  function clarificationOf(
    utteranceId: string,
    candidates: ReadonlyArray<string>,
  ): RoutingDecision {
    return {
      utteranceId,
      destination: 'harness',
      confidence: AUTO_DISPATCH_MIN_CONFIDENCE - 0.01,
      basis: 'clarified',
      requiresClarification: true,
      candidates: [...candidates],
    };
  }

  function endAgentDirectIfUnavailable(): void {
    if (currentMode.kind !== 'agent_direct') return;
    const bound = currentMode.sessionId;
    if (bound !== undefined && activeSessionIds().includes(bound)) return;
    enterMode(companionMode());
  }

  return {
    setActiveSessions(next: ReadonlyArray<ManagedSession>): void {
      sessions = [...next];
      router.setActiveSessions(sessions);
      endAgentDirectIfUnavailable();
    },
    setProject(projectId: string): void {
      // Plan §5.6 rule 5: a project change ends Agent Direct mode.
      project = projectId;
      if (currentMode.kind === 'agent_direct') enterMode(companionMode());
    },
    mode(): RoutingMode {
      refreshAgentDirectStaleness();
      return { ...currentMode };
    },
    pending(): ReadonlyArray<PendingQuestion> {
      return pendingQuestions.map((entry) => ({ ...entry, candidates: [...entry.candidates] }));
    },
    route,
  };
}
