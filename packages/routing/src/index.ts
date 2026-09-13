/**
 * Addressee routing (IMPLEMENTATION_PLAN.md §5.6) — the deterministic front door for every
 * utterance. Speech is classified before anything dispatches, so partial transcripts, ambient
 * acknowledgments, and ambiguous destinations can never reach a managed agent session.
 *
 * Frozen seam:
 *   AUTO_DISPATCH_MIN_CONFIDENCE = 0.95  calibrated auto-dispatch floor (plan §5.7)
 *   createAddresseeRouter({ sessions })  → AddresseeRouter
 *
 * Extensions carried on the returned decision (the contract fields keep their exact meaning):
 *   hold        the utterance is not actionable for this turn (partial ASR, ambient
 *               acknowledgment) and the dialogue session must stay silent
 *   candidates  the sessions a clarification is about, so the companion can name them
 */
// Type-only import of the frozen contract: the router stays free of a runtime dependency on the
// contracts package, and the seam type is erased when the module is loaded.
import type { RouteDecision } from '../../contracts/src/index.js';

import { parseCommand, parseExplicitPrefix, localIntent, type ParsedCommand } from './grammar.js';
import { isAmbientAcknowledgment } from './holds.js';
import { resolveDestination, type AddresseeHarness, type ManagedSession } from './sessions.js';
import { normalize, stripWakeWord } from './text.js';

export type { AddresseeHarness, ManagedSession } from './sessions.js';

/** Plan §5.6/§5.7: auto-dispatch needs a calibrated probability of at least 0.95. */
export const AUTO_DISPATCH_MIN_CONFIDENCE = 0.95;

export type RoutingUtterance = Readonly<{
  utteranceId: string;
  text: string;
  asrConfidence?: number;
  partial?: boolean;
}>;

export type RoutingHoldReason = 'partial_asr' | 'ambient_acknowledgment' | 'empty_utterance';

export type RoutingDecision = RouteDecision &
  Readonly<{
    hold?: RoutingHoldReason;
    candidates?: ReadonlyArray<string>;
  }>;

export type AddresseeRouter = Readonly<{
  /** Replaces the active managed-session set. */
  setActiveSessions(sessions: ReadonlyArray<ManagedSession>): void;
  route(utterance: RoutingUtterance): RoutingDecision;
}>;

export type AddresseeRouterOptions = Readonly<{ sessions: ReadonlyArray<ManagedSession> }>;

/** Clamps a caller-supplied ASR confidence; a missing confidence is "unknown", not "certain". */
function asrConfidenceOf(utterance: RoutingUtterance): number | undefined {
  const value = utterance.asrConfidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

function sessionIdsOf(sessions: ReadonlyArray<ManagedSession>): string[] {
  return sessions.map((session) => session.sessionId);
}

export function createAddresseeRouter(options: AddresseeRouterOptions): AddresseeRouter {
  let sessions: ReadonlyArray<ManagedSession> = [...options.sessions];

  function activeSessions(): ReadonlyArray<ManagedSession> {
    return sessions.filter((session) => session.active);
  }

  function clarification(
    utteranceId: string,
    candidates: ReadonlyArray<string>,
    confidence: number,
  ): RoutingDecision {
    const bounded = Math.min(confidence, AUTO_DISPATCH_MIN_CONFIDENCE - 0.01);
    return {
      utteranceId,
      destination: 'harness',
      confidence: bounded,
      basis: 'clarified',
      requiresClarification: true,
      candidates,
    };
  }

  function hold(utteranceId: string, reason: RoutingHoldReason, confidence: number): RoutingDecision {
    return {
      utteranceId,
      destination: 'companion',
      confidence: Math.min(confidence, AUTO_DISPATCH_MIN_CONFIDENCE - 0.01),
      basis: 'classified',
      requiresClarification: false,
      hold: reason,
    };
  }

  function routeCommand(
    utteranceId: string,
    command: ParsedCommand,
    asr: number | undefined,
  ): RoutingDecision {
    const resolution = resolveDestination(activeSessions(), command.destination);
    if (resolution.kind === 'resolved') {
      const confidence = Math.min(resolution.confidence, asr ?? resolution.confidence);
      if (command.kind === 'instruction' && confidence >= AUTO_DISPATCH_MIN_CONFIDENCE) {
        return {
          utteranceId,
          destination: 'harness',
          targetSessionId: resolution.session.sessionId,
          confidence,
          basis: 'explicit_prefix',
          requiresClarification: false,
        };
      }
      // The session is clear but the transcript is not trustworthy (or the task is missing):
      // confirm instead of dispatching on a guess.
      return clarification(utteranceId, [resolution.session.sessionId], confidence);
    }
    if (resolution.kind === 'ambiguous') {
      return clarification(utteranceId, sessionIdsOf(resolution.candidates), 0.5);
    }
    return clarification(utteranceId, sessionIdsOf(activeSessions()), 0.4);
  }

  /**
   * "harness: …" declares the bucket in the utterance itself. The remainder must name the session
   * (either as a command, or as an addressee phrase followed by the task); anything less specific
   * asks instead of guessing.
   */
  function routeHarnessPrefix(utteranceId: string, rest: string, asr: number | undefined): RoutingDecision {
    const command = parseCommand(rest);
    if (command !== null) return routeCommand(utteranceId, command, asr);
    const words = rest.split(/\s+/).filter((word) => word.length > 0);
    for (let length = Math.min(words.length - 1, 6); length >= 1; length -= 1) {
      const resolution = resolveDestination(activeSessions(), words.slice(0, length).join(' '));
      if (resolution.kind === 'ambiguous') {
        return clarification(utteranceId, sessionIdsOf(resolution.candidates), 0.5);
      }
      if (resolution.kind === 'resolved') {
        const instruction = words.slice(length).join(' ');
        const confidence = Math.min(resolution.confidence, asr ?? resolution.confidence);
        if (instruction.length > 0 && confidence >= AUTO_DISPATCH_MIN_CONFIDENCE) {
          return {
            utteranceId,
            destination: 'harness',
            targetSessionId: resolution.session.sessionId,
            confidence,
            basis: 'explicit_prefix',
            requiresClarification: false,
          };
        }
        return clarification(utteranceId, [resolution.session.sessionId], confidence);
      }
    }
    return clarification(utteranceId, sessionIdsOf(activeSessions()), 0.4);
  }

  function decide(
    utteranceId: string,
    text: string,
    asr: number | undefined,
    command: ParsedCommand | null,
  ): RoutingDecision {
    if (command !== null) return routeCommand(utteranceId, command, asr);
    const intent = localIntent(text);
    if (intent !== null) {
      return {
        utteranceId,
        destination: intent,
        confidence: Math.min(0.97, asr ?? 0.97),
        basis: 'classified',
        requiresClarification: false,
      };
    }
    return {
      utteranceId,
      destination: 'companion',
      confidence: Math.min(0.98, asr ?? 0.98),
      basis: 'classified',
      requiresClarification: false,
    };
  }

  return {
    setActiveSessions(next: ReadonlyArray<ManagedSession>): void {
      sessions = [...next];
    },
    route(utterance: RoutingUtterance): RoutingDecision {
      const utteranceId = utterance.utteranceId;
      const raw = typeof utterance.text === 'string' ? utterance.text : '';
      const text = stripWakeWord(raw);
      const asr = asrConfidenceOf(utterance);

      if (utterance.partial === true) return hold(utteranceId, 'partial_asr', asr ?? 0);
      if (normalize(text).length === 0) return hold(utteranceId, 'empty_utterance', asr ?? 0);
      if (isAmbientAcknowledgment(text)) return hold(utteranceId, 'ambient_acknowledgment', asr ?? 0);

      const explicit = parseExplicitPrefix(text);
      if (explicit !== null) {
        if (explicit.destination === 'harness') return routeHarnessPrefix(utteranceId, explicit.rest, asr);
        return {
          utteranceId,
          destination: explicit.destination,
          confidence: Math.min(0.97, asr ?? 0.97),
          basis: 'explicit_prefix',
          requiresClarification: false,
        };
      }

      return decide(utteranceId, text, asr, parseCommand(text));
    },
  };
}
