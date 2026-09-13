/**
 * N01 — agent test result → durable event → concise spoken outcome → replay.
 *
 * One managed turn produces exactly one utterance. Progress messages, stdout log lines, user text
 * and agent text are context: they move the reducer's ledger, never a speaker. When the turn's last
 * event (`session_state` / `turn/completed`) arrives, the tracer reduces the turn from tool receipts
 * only, asks the shared attention policy for a speech lease, and submits one §5.3 `SpeechPlan`
 * through the V02 `submitSpeech` seam. No lease means silence: nothing is submitted and nothing is
 * replayable. A lease that is fabricated, stale or epoch-mismatched is rejected by the voice layer,
 * and the tracer only records what that layer reported as audible.
 *
 * Fidelity rules worth stating because the tests pin them:
 *
 * - the plan's epoch and expiry are copied from the lease attention issued — the tracer can never
 *   mint authority of its own;
 * - a failing receipt is announced as the turn's single completion outcome (blocking fact first,
 *   one segment, priority `completion`). Splitting the failure into a second blocking utterance is
 *   N03's queue arbitration, not this tracer's license to speak twice;
 * - `gap` events are the blocking-event announcement N01 owns: one bounded sentence per recorded
 *   gap, and the gap id is cited as evidence rather than being smoothed over;
 * - heard receipts are persisted through the M01 memory API when one is supplied. Persisting is
 *   best-effort: a memory failure never makes narration lie or crash, and `replay()` stays the
 *   authoritative list of what this process made audible.
 */
import { createHash } from 'node:crypto';
import type {
  DurableCursor,
  EventEnvelope,
  SpeechLease,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../contracts/src/index.js';
import {
  TURN_COMPLETED_METHOD,
  isObservedToolReceipt,
  readSessionState,
  readToolCompletion,
  readToolStart,
  type ToolCompletion,
} from './extract.js';
import { countChecks, reduceTurn, type NarrationOutcome, type TaskReceipt } from './outcome.js';
import {
  completionSpokenText,
  estimateSeconds,
  gapSpokenText,
  spokenArtifactName,
} from './format.js';

export type NarrationIngestInput = Readonly<{ event: EventEnvelope; payload: unknown }>;

export type NarrationIngestResult = Readonly<{
  /** True only when this ingest call produced audio the voice layer reported as heard. */
  submitted: boolean;
  /** The turn's reduced outcome, or null while no tool receipt is known. */
  outcome: NarrationOutcome | null;
}>;

export type NarrationReplayRecord = Readonly<{
  planId: string;
  segmentId: string;
  sessionId: string;
  text: string;
  evidenceIds: ReadonlyArray<string>;
}>;

/** The §5.7 speech-lease granter. Only it can authorize proactive speech. */
export type NarrationAttention = Readonly<{
  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null;
}>;

/** The V02 playback seam: the only path from a plan to audio. */
export type NarrationVoice = Readonly<{
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;

/** The slice of the M01 memory API N01 writes heard receipts through. */
export type NarrationHeardSink = Readonly<{
  ingest(batch: ReadonlyArray<EventEnvelope>): Promise<DurableCursor>;
}>;

export type NarrationTracerOptions = Readonly<{
  attention: NarrationAttention;
  voice: NarrationVoice;
  /** Deterministic clock; defaults to the system clock. */
  now?: () => Date;
  memory?: NarrationHeardSink;
}>;

export type NarrationTracer = Readonly<{
  ingest(input: NarrationIngestInput): Promise<NarrationIngestResult>;
  /** The audible outcomes, newest last. Nothing audible → empty. */
  replay(): Promise<ReadonlyArray<NarrationReplayRecord>>;
}>;

/** Matches the coordinator's default lease window (§5.7); the voice layer still re-checks it. */
const LEASE_TTL_MS = 30_000;
/** Bounded retention so a long-lived session cannot grow without limit. */
const MAX_REPLAY_RECORDS = 200;
const MAX_TRACKED_KEYS = 128;

type PendingStart = Readonly<{ taskId: string | null; eventId: string }>;

type SessionState = {
  sessionId: string;
  turnId: string | null;
  receipts: TaskReceipt[];
  pendingStarts: PendingStart[];
  extraEvidenceIds: string[];
  /** Turns whose one completion summary was already attempted (speaking it or staying silent). */
  plannedTurns: Set<string>;
  announcedGaps: Set<string>;
  lastOutcome: NarrationOutcome | null;
};

type SpeakRequest = Readonly<{
  session: SessionState;
  event: EventEnvelope;
  priority: SpeechPlan['priority'];
  planId: string;
  segmentId: string;
  text: string;
  evidenceIds: ReadonlyArray<string>;
  dedupeKey: string;
}>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Keeps an insertion-ordered tracking set bounded by dropping its oldest keys. */
function trimSet(keys: Set<string>, limit: number): void {
  while (keys.size > limit) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) return;
    keys.delete(oldest);
  }
}

export function createNarrationTracer(options: NarrationTracerOptions): NarrationTracer {
  const { attention, voice, memory } = options;
  const clock = options.now ?? ((): Date => new Date());
  const sessions = new Map<string, SessionState>();
  const replayRecords: NarrationReplayRecord[] = [];
  let receiptSequence = 0;

  const sessionFor = (event: EventEnvelope): SessionState => {
    const sessionId = event.scope.sessionId ?? `source:${event.sourceId}`;
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionState = {
      sessionId,
      turnId: null,
      receipts: [],
      pendingStarts: [],
      extraEvidenceIds: [],
      plannedTurns: new Set<string>(),
      announcedGaps: new Set<string>(),
      lastOutcome: null,
    };
    sessions.set(sessionId, created);
    return created;
  };

  /** A turn is the unit of reduction: a new turn id starts with an empty receipt ledger. */
  const beginTurn = (session: SessionState, event: EventEnvelope): void => {
    const turnId = event.turnId ?? null;
    if (turnId === null || turnId === session.turnId) return;
    session.turnId = turnId;
    session.receipts = [];
    session.pendingStarts = [];
    session.extraEvidenceIds = [];
    session.lastOutcome = null;
  };

  const refreshOutcome = (session: SessionState): void => {
    session.lastOutcome = reduceTurn({
      sessionId: session.sessionId,
      receipts: session.receipts,
      extraEvidenceIds: session.extraEvidenceIds,
    });
  };

  const takePendingStart = (session: SessionState, completion: ToolCompletion): string | null => {
    if (session.pendingStarts.length === 0) return null;
    const matched = completion.taskId === null
      ? -1
      : session.pendingStarts.findIndex((start) => start.taskId === completion.taskId);
    const index = matched >= 0 ? matched : session.pendingStarts.length - 1;
    const [start] = session.pendingStarts.splice(index, 1);
    return start?.eventId ?? null;
  };

  const completionKey = (session: SessionState): string => `${session.sessionId}::${session.turnId ?? 'no-turn'}`;

  const rememberReplay = (record: NarrationReplayRecord): void => {
    replayRecords.push(record);
    if (replayRecords.length > MAX_REPLAY_RECORDS) {
      replayRecords.splice(0, replayRecords.length - MAX_REPLAY_RECORDS);
    }
  };

  /**
   * Writes the heard outcome to memory as a durable delivery receipt: hashed spoken text, the
   * session scope and the evidence ids the outcome was reduced from.
   */
  const persistHeardReceipts = async (
    session: SessionState,
    source: EventEnvelope,
    plan: SpeechPlan,
    heard: SpeechPlan['segments'],
  ): Promise<void> => {
    if (memory === undefined || heard.length === 0) return;
    const observedAt = clock().toISOString();
    const sessionId = source.scope.sessionId ?? session.sessionId;
    const batch: EventEnvelope[] = heard.map((segment) => {
      receiptSequence += 1;
      return {
        schemaVersion: 1,
        eventId: `heard-${receiptSequence}-${sha256(`${plan.planId}\u0000${segment.id}`).slice(0, 16)}`,
        sourceId: 'narration',
        sourceEventId: `heard#${plan.planId}#${segment.id}`,
        sourceSequence: receiptSequence,
        ingestSequence: receiptSequence,
        occurredAt: observedAt,
        observedAt,
        scope: {
          profileId: source.scope.profileId,
          sensitivity: source.scope.sensitivity,
          sessionId,
          ...(source.scope.projectId === undefined ? {} : { projectId: source.scope.projectId }),
          ...(source.scope.worktreeId === undefined ? {} : { worktreeId: source.scope.worktreeId }),
        },
        ...(source.turnId === undefined ? {} : { turnId: source.turnId }),
        kind: 'delivery_receipt',
        payloadRef: `narration://heard/${plan.planId}/${segment.id}`,
        contentHash: `sha256:${sha256(`${segment.id}\u0000${segment.text}`)}`,
        trust: 'tool_observed',
      };
    });
    try {
      await memory.ingest(batch);
    } catch {
      // Best effort: a memory outage must not turn narration into a failure or a fabrication.
    }
  };

  /** Segments the voice layer actually reported as heard; generated-but-unheard audio does not count. */
  const audibleSegments = (
    plan: SpeechPlan,
    output: ReadonlyArray<VoiceOutputEvent>,
  ): SpeechPlan['segments'] => {
    const heard = new Set(
      output
        .filter((event) => event.status === 'started' || event.status === 'completed')
        .map((event) => event.segmentId),
    );
    return plan.segments.filter((segment) => heard.has(segment.id));
  };

  /** Ask the shared policy, then submit exactly one plan. No lease → silent, nothing submitted. */
  const speak = async (request: SpeakRequest): Promise<boolean> => {
    const expiresAt = new Date(clock().getTime() + LEASE_TTL_MS).toISOString();
    const lease = attention.requestSpeech(request.event.eventId, expiresAt);
    if (lease === null) return false;
    const plan: SpeechPlan = {
      planId: request.planId,
      sessionId: request.session.sessionId,
      epoch: lease.epoch,
      priority: request.priority,
      expiresAt: lease.expiresAt,
      dedupeKey: request.dedupeKey,
      segments: [{
        id: request.segmentId,
        text: request.text,
        evidenceIds: [...request.evidenceIds],
        exact: false,
        maxSeconds: estimateSeconds(request.text),
      }],
      resume: 'offer',
    };
    const output = await voice.submitSpeech(plan, lease);
    const audible = audibleSegments(plan, output);
    if (audible.length === 0) return false;
    for (const segment of audible) {
      rememberReplay({
        planId: plan.planId,
        segmentId: segment.id,
        sessionId: request.session.sessionId,
        text: segment.text,
        evidenceIds: [...segment.evidenceIds],
      });
    }
    await persistHeardReceipts(request.session, request.event, plan, audible);
    return true;
  };

  /** The receipt that decided the outcome: the newest failing one, else the newest one. */
  const decisiveReceipt = (session: SessionState): TaskReceipt | null => {
    const failing = session.receipts.filter((receipt) => receipt.exitCode !== 0);
    return failing[failing.length - 1] ?? session.receipts[session.receipts.length - 1] ?? null;
  };

  const speakCompletion = async (session: SessionState, event: EventEnvelope, outcome: NarrationOutcome): Promise<boolean> => {
    const receipt = decisiveReceipt(session);
    const exitCode = outcome.exitCode ?? receipt?.exitCode ?? 0;
    const text = completionSpokenText({
      status: outcome.status === 'passed' ? 'passed' : 'failed',
      exitCode,
      counts: receipt?.counts ?? null,
      artifact: spokenArtifactName(receipt?.command ?? null),
    });
    const planId = `narration-completion:${session.sessionId}:${session.turnId ?? 'turn'}`;
    return await speak({
      session,
      event,
      priority: 'completion',
      planId,
      segmentId: `${planId}:segment:1`,
      text,
      evidenceIds: [...outcome.evidenceIds, event.eventId],
      dedupeKey: `narration:completion:${outcome.status}:${completionKey(session)}:${outcome.evidenceIds.join(',')}`,
    });
  };

  const finishTurn = async (session: SessionState, event: EventEnvelope): Promise<boolean> => {
    const key = completionKey(session);
    if (session.plannedTurns.has(key)) return false;
    session.plannedTurns.add(key);
    trimSet(session.plannedTurns, MAX_TRACKED_KEYS);
    const outcome = session.lastOutcome;
    if (outcome === null || (outcome.status !== 'passed' && outcome.status !== 'failed')) return false;
    return await speakCompletion(session, event, outcome);
  };

  /** One bounded blocking announcement per recorded evidence gap; repeats are deduplicated. */
  const announceGap = async (session: SessionState, event: EventEnvelope): Promise<boolean> => {
    if (session.announcedGaps.has(event.eventId)) return false;
    session.announcedGaps.add(event.eventId);
    trimSet(session.announcedGaps, MAX_TRACKED_KEYS);
    const planId = `narration-gap:${session.sessionId}:${event.eventId}`;
    return await speak({
      session,
      event,
      priority: 'blocking',
      planId,
      segmentId: `${planId}:segment:1`,
      text: gapSpokenText(),
      evidenceIds: [event.eventId],
      dedupeKey: `narration:gap:${event.eventId}`,
    });
  };

  const ingest = async (input: NarrationIngestInput): Promise<NarrationIngestResult> => {
    const { event, payload } = input;
    const session = sessionFor(event);
    beginTurn(session, event);
    switch (event.kind) {
      case 'tool_started': {
        const start = readToolStart(payload);
        if (start !== null) session.pendingStarts.push({ taskId: start.taskId, eventId: event.eventId });
        return { submitted: false, outcome: session.lastOutcome };
      }
      case 'tool_completed': {
        if (isObservedToolReceipt(event)) {
          const completion = readToolCompletion(payload);
          if (completion !== null && completion.exitCode !== null) {
            session.receipts.push({
              eventId: event.eventId,
              startEventId: takePendingStart(session, completion),
              taskId: completion.taskId,
              command: completion.command,
              exitCode: completion.exitCode,
              observedAt: event.observedAt,
              counts: countChecks(completion.output),
            });
            refreshOutcome(session);
          }
        }
        // Agent text (or any non-observed envelope) never becomes a receipt.
        return { submitted: false, outcome: session.lastOutcome };
      }
      case 'gap': {
        session.extraEvidenceIds.push(event.eventId);
        refreshOutcome(session);
        const submitted = await announceGap(session, event);
        return { submitted, outcome: session.lastOutcome };
      }
      case 'session_state': {
        const state = readSessionState(payload);
        if (state?.method !== TURN_COMPLETED_METHOD) return { submitted: false, outcome: session.lastOutcome };
        const submitted = await finishTurn(session, event);
        return { submitted, outcome: session.lastOutcome };
      }
      default:
        // User text, agent text, log lines, captures and delivery receipts: context, never a voice.
        return { submitted: false, outcome: session.lastOutcome };
    }
  };

  return {
    ingest,
    replay: async (): Promise<ReadonlyArray<NarrationReplayRecord>> => replayRecords.map((record) => ({
      ...record,
      evidenceIds: [...record.evidenceIds],
    })),
  };
}
