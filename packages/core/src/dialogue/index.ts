/**
 * Dialogue session (IMPLEMENTATION_PLAN.md §5.6) — the companion's spoken turn loop.
 *
 * Frozen seam:
 *   createDialogueSession({ router, memory, adapters, speak, scope, now })
 *
 * One utterance produces at most one spoken reply:
 *   - a companion question is answered from memory, and the spoken answer cites the evidence the
 *     memory store returned (no evidence, no claim);
 *   - a named-agent instruction is persisted in the outbox before it is handed to that session's
 *     adapter, and the spoken acknowledgment is produced only after the adapter observed the
 *     delivery — an "acknowledged" handoff never claims the work finished;
 *   - an ambiguous destination asks one short question, dispatches nothing, and persists nothing;
 *   - partial ASR and ambient acknowledgments hold silently (the router marks them) and reach no
 *     adapter.
 */
import type {
  EvidenceBundle,
  HarnessAdapter,
  HarnessDeliveryReceipt,
  Memory,
  RouteDecision,
  Scope,
  SpeechPlan,
  VoiceOutputEvent,
} from '@echopilot/contracts';

/** Companion answers are grounded in a bounded slice of memory; the companion never invents them. */
export const ANSWER_EVIDENCE_BUDGET = 12;
/** Spoken replies stay inside one short utterance (clarifications and acknowledgments). */
export const MAX_REPLY_CHARACTERS = 240;
const SPEECH_WINDOW_MS = 30_000;
const CHARACTERS_PER_SECOND = 15;

export type OutboxState = 'prepared' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'unknown';

export type OutboxRecord = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  sessionId: string;
  state: OutboxState;
  updatedAt: string;
}>;

export type DialogueUtterance = Readonly<{
  utteranceId: string;
  text: string;
  asrConfidence?: number;
  partial?: boolean;
}>;

/**
 * The router seam this session depends on. It is the shape exported by
 * packages/routing's createAddresseeRouter(); `hold` and `candidates` are the routing package's
 * documented decision extensions and are read defensively here.
 */
export interface DialogueRouter {
  route(utterance: DialogueUtterance): RouteDecision;
}

export type DialogueTurn = Readonly<{
  decision: RouteDecision;
  clarification?: string;
  dispatch?: Readonly<{ deliveryId: string; sessionId: string; instruction: string }>;
  receipt?: HarnessDeliveryReceipt;
}>;

export interface DialogueSession {
  handleUtterance(utterance: DialogueUtterance): Promise<DialogueTurn>;
  outbox(): ReadonlyArray<OutboxRecord>;
}

export type DialogueSpeak = (plan: SpeechPlan) => Promise<ReadonlyArray<VoiceOutputEvent>>;

export type DialogueSessionOptions = Readonly<{
  router: DialogueRouter;
  memory: Memory;
  adapters: ReadonlyMap<string, HarnessAdapter>;
  speak: DialogueSpeak;
  scope: Scope;
  now?: () => Date;
}>;

type MutableOutboxRecord = {
  deliveryId: string;
  idempotencyKey: string;
  sessionId: string;
  state: OutboxState;
  updatedAt: string;
};

type RoutingAnnotation = Readonly<{ hold?: string; candidates?: ReadonlyArray<string> }>;

/** Reads the routing package's decision extensions without depending on their package. */
function routingAnnotation(decision: RouteDecision): RoutingAnnotation {
  const extended = decision as RouteDecision & { readonly hold?: unknown; readonly candidates?: unknown };
  const hold = typeof extended.hold === 'string' && extended.hold.length > 0 ? extended.hold : undefined;
  const candidates = Array.isArray(extended.candidates)
    ? extended.candidates.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : undefined;
  return {
    ...(hold === undefined ? {} : { hold }),
    ...(candidates === undefined ? {} : { candidates }),
  };
}

/** "codex-parser" → "Codex Parser", so the spoken reply names the session the user knows. */
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

/** One concise question that names the destinations the user must choose between. */
function clarificationText(candidates: ReadonlyArray<string>): string {
  const names = [...new Set(candidates)].map(humanizeSessionId);
  if (names.length === 0) return 'I could not tell which session you meant. Which session should receive that?';
  const spoken = conjunctionList(names);
  const question = names.length === 1
    ? `I may have misheard which session. Did you mean ${spoken}?`
    : `Which session did you mean: ${spoken}?`;
  return question.length <= MAX_REPLY_CHARACTERS ? question : 'Which session did you mean?';
}

/** A memory answer restates the returned summary and cites the evidence it was drawn from. */
function groundedAnswer(bundle: EvidenceBundle): string {
  const summary = bundle.summary.trim();
  if (summary.length > 0) return summary;
  if (bundle.evidenceIds.length > 0) {
    return 'I found related events in memory, but there is no summary to read back yet.';
  }
  return 'I do not have grounded evidence for that yet.';
}

const WAKE_WORD = /^(?:(?:hey|hi|ok|okay)\s+)?echo\b[\s,:-]*/i;
const EXPLICIT_PREFIX = /^(?:dictate|companion|harness|desktop|control)\s*:\s*/i;
const COMMAND_PREFIX =
  /^(?:(?:could|can|would)\s+you\s+(?:please\s+)?|i\s+(?:need|want|would\s+like)\s+you\s+to\s+|please\s+)?(?:tell|ask|message|notify|ping|brief)\s+[\s\S]{1,120}?\s+to\s+/i;
const SEND_PREFIX = /^(?:please\s+)?send\s+(?:that|this|it|those|these)[\s\S]{0,60}?\s+to\s+/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the addressee from a spoken instruction: "Tell Codex to add a regression test" is
 * delivered to codex-parser as "add a regression test". Only the leading addressee is removed, so
 * a task that itself contains "to" is delivered whole. When the utterance declares its route with
 * a prefix ("harness: Codex parser add a regression test") the target session's own name is
 * removed instead.
 */
export function stripAddressee(text: string, targetSessionId: string): string {
  const original = text.trim();
  const remainder = original.replace(WAKE_WORD, '');
  const withoutExplicitPrefix = remainder.replace(EXPLICIT_PREFIX, '');
  const hadExplicitPrefix = withoutExplicitPrefix !== remainder;
  const body = withoutExplicitPrefix.trim();

  const withoutCommand = body.replace(COMMAND_PREFIX, '');
  if (withoutCommand !== body) return withoutCommand.trim();
  const withoutSend = body.replace(SEND_PREFIX, '');
  if (withoutSend !== body) return withoutSend.trim();

  if (hadExplicitPrefix) {
    const sessionWords = targetSessionId
      .split(/[^a-zA-Z0-9]+/)
      .filter((word) => word.length > 0)
      .map(escapeRegExp)
      .join('\\s+');
    if (sessionWords.length > 0) {
      const withoutSession = body.replace(new RegExp(`^${sessionWords}\\s+`, 'i'), '');
      if (withoutSession !== body) return withoutSession.trim();
    }
  }

  return (hadExplicitPrefix ? body : original).trim();
}

export function createDialogueSession(options: DialogueSessionOptions): DialogueSession {
  const clock = options.now ?? ((): Date => new Date());
  const outbox: MutableOutboxRecord[] = [];
  let sequence = 0;

  function timestamp(): string {
    return clock().toISOString();
  }

  async function speak(
    utteranceId: string,
    text: string,
    kind: 'answer' | 'clarification' | 'acknowledgment',
    evidenceIds: ReadonlyArray<string>,
    dedupeSuffix: string,
  ): Promise<void> {
    sequence += 1;
    const planId = `speech-${sequence}`;
    const plan: SpeechPlan = {
      planId,
      ...(options.scope.sessionId === undefined ? {} : { sessionId: options.scope.sessionId }),
      epoch: sequence,
      priority: kind === 'acknowledgment' ? 'completion' : 'blocking',
      expiresAt: new Date(clock().getTime() + SPEECH_WINDOW_MS).toISOString(),
      dedupeKey: `${utteranceId}:${kind}:${dedupeSuffix}`,
      segments: [
        {
          id: `${planId}-segment-1`,
          text,
          evidenceIds: [...evidenceIds],
          exact: false,
          maxSeconds: Math.max(1, Math.ceil(text.length / CHARACTERS_PER_SECOND)),
        },
      ],
      resume: 'discard',
    };
    await options.speak(plan);
  }

  async function dispatch(
    utterance: DialogueUtterance,
    decision: RouteDecision,
    sessionId: string,
  ): Promise<DialogueTurn> {
    const display = humanizeSessionId(sessionId);
    const adapter = options.adapters.get(sessionId);
    if (adapter === undefined) {
      const notice = `No managed session is connected for ${display}.`;
      await speak(utterance.utteranceId, notice, 'acknowledgment', [], 'no-session');
      return { decision };
    }

    const instruction = stripAddressee(utterance.text, sessionId) || utterance.text.trim();
    const idempotencyKey = `${options.scope.profileId}:${utterance.utteranceId}:${sessionId}`;
    const existing = outbox.find((record) => record.idempotencyKey === idempotencyKey);

    // A replay of an observed delivery is not delivered twice; the user still hears that the
    // instruction already landed.
    if (existing !== undefined && existing.state === 'acknowledged') {
      const receipt: HarnessDeliveryReceipt = { deliveryId: existing.deliveryId, status: 'acknowledged' };
      await speak(
        utterance.utteranceId,
        `${display} already acknowledged the instruction.`,
        'acknowledgment',
        [],
        existing.deliveryId,
      );
      return {
        decision,
        dispatch: { deliveryId: existing.deliveryId, sessionId, instruction },
        receipt,
      };
    }

    sequence += 1;
    const deliveryId = existing?.deliveryId ?? `delivery-${sequence}`;
    const record: MutableOutboxRecord = {
      deliveryId,
      idempotencyKey,
      sessionId,
      state: 'prepared',
      updatedAt: timestamp(),
    };
    if (existing === undefined) outbox.push(record);
    else Object.assign(existing, record);

    const receipt = await adapter.send(instruction, deliveryId);
    record.state = receipt.status === 'acknowledged' ? 'acknowledged' : 'failed';
    record.updatedAt = timestamp();

    const acknowledgment = receipt.status === 'acknowledged'
      ? `${display} acknowledged the instruction.`
      : `I could not deliver that to ${display}.`;
    await speak(utterance.utteranceId, acknowledgment, 'acknowledgment', [], deliveryId);

    return { decision, dispatch: { deliveryId, sessionId, instruction }, receipt };
  }

  async function handleUtterance(utterance: DialogueUtterance): Promise<DialogueTurn> {
    const decision = options.router.route(utterance);
    const annotation = routingAnnotation(decision);

    // Partial ASR, ambient acknowledgments, and other non-actionable turns are held silently.
    if (annotation.hold !== undefined) return { decision };

    if (decision.requiresClarification) {
      const text = clarificationText(annotation.candidates ?? [...options.adapters.keys()]);
      await speak(utterance.utteranceId, text, 'clarification', [], 'clarify');
      return { decision, clarification: text };
    }

    if (decision.destination === 'companion') {
      const bundle = await options.memory.query(utterance.text, options.scope, ANSWER_EVIDENCE_BUDGET);
      await speak(utterance.utteranceId, groundedAnswer(bundle), 'answer', bundle.evidenceIds, 'answer');
      return { decision };
    }

    if (decision.destination === 'harness' && decision.targetSessionId !== undefined) {
      return dispatch(utterance, decision, decision.targetSessionId);
    }

    // Dictation, desktop, and control destinations are executed by their own subsystems.
    return { decision };
  }

  return {
    handleUtterance,
    outbox(): ReadonlyArray<OutboxRecord> {
      return outbox.map((record) => ({ ...record }));
    },
  };
}
