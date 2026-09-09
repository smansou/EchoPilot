import {
  parseEventEnvelope,
  parseFixtureEvent,
  parseState,
  type ActionReceipt,
  type ActionRequest,
  type Attention,
  type BoundedContext,
  type ContextSnapshot,
  type DurableCursor,
  type EvidenceBundle,
  type EventEnvelope,
  type FixtureEvent,
  type HarnessAdapter,
  type HarnessCapability,
  type HarnessDeliveryReceipt,
  type InsertReceipt,
  type Memory,
  type NativeHost,
  type Reasoner,
  type ReasoningTask,
  type Scope,
  type SpeechLease,
  type SpeechPlan,
  type State,
  type VoiceOutputEvent,
  type VoiceSession,
} from '@echopilot/contracts';

export const BOOTSTRAP_EVENT: Readonly<FixtureEvent> = Object.freeze({
  id: 'bootstrap-event-001',
  sessionId: 'synthetic-session-001',
  text: 'EchoPilot is ready. This is a synthetic session event; no agent or microphone is connected.',
  createdAt: '2026-09-09T00:00:00.000Z',
});

export interface Coordinator {
  getState(): State;
  ingest(event: FixtureEvent): State;
  setMuted(muted: boolean): State;
  /** Re-selects the current event; audio adapters must separately obtain a lease. */
  replay(): State;
  requestSpeech(eventId: string, expiresAt?: string): SpeechLease | null;
  canSpeak(lease: SpeechLease): boolean;
  interrupt(): void;
  revokeSpeech(reason: string): void;
}

/** All speech adapters must check canSpeak before each output chunk. */
export function createCoordinator(initialState: State = { muted: false, event: null }, now = () => new Date()): Coordinator {
  let state = parseState(initialState);
  let epoch = 0;
  let activeLease: SpeechLease | null = null;
  const snapshot = (): State => parseState(state);
  const invalidate = (): void => { epoch += 1; activeLease = null; };

  return {
    getState: snapshot,
    ingest(event) {
      const parsed = parseFixtureEvent(event);
      invalidate();
      state = { ...state, event: parsed };
      return snapshot();
    },
    setMuted(muted) {
      if (typeof muted !== 'boolean') throw new TypeError('Invalid muted flag');
      if (muted !== state.muted) invalidate();
      state = { ...state, muted };
      return snapshot();
    },
    replay() {
      invalidate();
      return snapshot();
    },
    requestSpeech(eventId, expiresAt = new Date(now().getTime() + 30_000).toISOString()) {
      if (state.muted || state.event?.id !== eventId) return null;
      const expiry = new Date(expiresAt);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now().getTime()) return null;
      invalidate();
      activeLease = Object.freeze({ eventId, epoch, expiresAt });
      return activeLease;
    },
    canSpeak(lease) {
      return activeLease !== null && lease === activeLease && !state.muted
        && lease.epoch === epoch && state.event?.id === lease.eventId
        && new Date(lease.expiresAt).getTime() > now().getTime();
    },
    interrupt: invalidate,
    revokeSpeech: (_reason) => invalidate(),
  };
}

/** F01's deterministic fake implementations; they never touch protected inputs or the OS. */
export function createFakeNativeHost(): NativeHost {
  const audio = async (): Promise<void> => undefined;
  return {
    async capture({ scope }): Promise<ContextSnapshot> {
      return Object.freeze({ snapshotId: 'synthetic-snapshot-001', scope, capturedAt: BOOTSTRAP_EVENT.createdAt, source: 'synthetic' });
    },
    async *observeForeground(): AsyncIterable<EventEnvelope> { /* deliberately empty in the synthetic bootstrap */ },
    async insertText(transaction): Promise<InsertReceipt> {
      return Object.freeze({ transactionId: transaction.transactionId, inserted: false });
    },
    audio: Object.freeze({ start: audio, stop: audio, duck: audio, flush: audio }),
    gaze: Object.freeze({ start: audio, stop: audio }),
    async execute(_capability: string, action: ActionRequest): Promise<ActionReceipt> {
      return Object.freeze({ actionId: action.actionId, status: 'unsupported' });
    },
  };
}

export function createFakeMemory(): Memory {
  const events = new Map<string, EventEnvelope>();
  let cursor = 0;
  return {
    async ingest(batch) {
      for (const event of batch) events.set(parseEventEnvelope(event).eventId, parseEventEnvelope(event));
      cursor += batch.length;
      return Object.freeze({ value: `synthetic:${cursor}` }) as DurableCursor;
    },
    async query(_query: string, scope: Scope, budget: number): Promise<EvidenceBundle> {
      if (!Number.isSafeInteger(budget) || budget < 0) throw new TypeError('Invalid query budget');
      const evidenceIds = [...events.values()].filter((event) => event.scope.profileId === scope.profileId).slice(0, budget).map((event) => event.eventId);
      return Object.freeze({ evidenceIds, summary: evidenceIds.length === 0 ? 'No synthetic evidence.' : 'Synthetic evidence only.' });
    },
    async consolidate(cursorValue) { return Object.freeze({ checkpoint: cursorValue.value }); },
    async forget({ scope }) {
      let deleted = 0;
      for (const [id, event] of events) if (event.scope.profileId === scope.profileId) { events.delete(id); deleted += 1; }
      return Object.freeze({ deleted });
    },
  };
}

export function createFakeHarnessAdapter(events: readonly EventEnvelope[] = []): HarnessAdapter {
  let started = false;
  return {
    async capabilities(): Promise<ReadonlySet<HarnessCapability>> { return new Set(['observe', 'send', 'interrupt', 'approval', 'resume']); },
    async start(): Promise<void> { started = true; },
    async *observe(): AsyncIterable<EventEnvelope> { for (const event of events) yield parseEventEnvelope(event); },
    async send(_instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
      return Object.freeze({ deliveryId, status: started ? 'acknowledged' : 'unsupported' });
    },
    async interrupt(_turnId: string): Promise<void> {},
    async respondApproval(_requestId: string, _decision: 'approve' | 'deny'): Promise<void> {},
    async resume(_sessionId: string): Promise<void> {},
    async close(): Promise<void> { started = false; },
  };
}

/** The fake voice can emit only after the coordinator/Attention validates the supplied lease. */
export function createFakeVoiceSession(attention: Attention): VoiceSession {
  let muted = false;
  let closed = false;
  const emitted: VoiceOutputEvent[] = [];
  return {
    async start(): Promise<void> { closed = false; },
    async pushInput(): Promise<void> { if (closed) throw new Error('Voice session is closed'); },
    async submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>> {
      if (closed || muted || !attention.canSpeak(lease)) throw new Error('Speech lease is not valid');
      const output = plan.segments.map((segment) => Object.freeze({ planId: plan.planId, segmentId: segment.id, positionMs: 0, status: 'completed' as const }));
      emitted.push(...output);
      return output;
    },
    async interrupt(_reason: string): Promise<void> { attention.revokeSpeech('voice-interrupt'); },
    async mute(): Promise<void> { muted = true; attention.revokeSpeech('voice-mute'); },
    async replay(segmentId: string): Promise<void> { if (!emitted.some((event) => event.segmentId === segmentId)) throw new Error('Unknown synthetic segment'); },
    async close(): Promise<void> { closed = true; attention.revokeSpeech('voice-closed'); },
  };
}

export function createFakeReasoner(): Reasoner {
  return {
    async run(task: ReasoningTask, context: BoundedContext, _outputSchema: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
      if (signal.aborted) throw signal.reason ?? new Error('Reasoning aborted');
      return Object.freeze({ taskId: task.taskId, status: 'synthetic', evidenceIds: [...context.evidenceIds] });
    },
  };
}

export const MAX_JOURNAL_BYTES = 1_048_576;
export const MAX_JOURNAL_EVENTS = 100;

/** Synthetic data only until encrypted persistence is implemented. */
export function parseJournal(text: string): FixtureEvent[] {
  if (new TextEncoder().encode(text).byteLength > MAX_JOURNAL_BYTES) {
    throw new RangeError('Fixture journal exceeds byte limit');
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length > MAX_JOURNAL_EVENTS) throw new RangeError('Fixture journal exceeds event limit');
  const ids = new Set<string>();
  return lines.map((line) => {
    const event = parseFixtureEvent(JSON.parse(line));
    if (ids.has(event.id)) throw new TypeError('Duplicate fixture event ID');
    ids.add(event.id);
    return event;
  });
}

export function serializeJournal(events: readonly FixtureEvent[]): string {
  const text = events.map((event) => JSON.stringify(parseFixtureEvent(event))).join('\n')
    + (events.length > 0 ? '\n' : '');
  parseJournal(text);
  return text;
}
