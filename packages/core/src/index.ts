import { parseFixtureEvent, parseState, type FixtureEvent, type State } from '@echopilot/contracts';

export const BOOTSTRAP_EVENT: Readonly<FixtureEvent> = Object.freeze({
  id: 'bootstrap-event-001',
  sessionId: 'synthetic-session-001',
  text: 'EchoPilot is ready. This is a synthetic session event; no agent or microphone is connected.',
  createdAt: '2026-09-09T00:00:00.000Z',
});

export type SpeechLease = Readonly<{ eventId: string; epoch: number }>;

export interface Coordinator {
  getState(): State;
  ingest(event: FixtureEvent): State;
  setMuted(muted: boolean): State;
  /** Re-selects the current event; audio adapters must separately obtain a lease. */
  replay(): State;
  requestSpeech(eventId: string): SpeechLease | null;
  canSpeak(lease: SpeechLease): boolean;
  interrupt(): void;
}

/** All speech adapters must check canSpeak before each output chunk. */
export function createCoordinator(initialState: State = { muted: false, event: null }): Coordinator {
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
    requestSpeech(eventId) {
      if (state.muted || state.event?.id !== eventId) return null;
      invalidate();
      activeLease = Object.freeze({ eventId, epoch });
      return activeLease;
    },
    canSpeak(lease) {
      return activeLease !== null && lease === activeLease && !state.muted
        && lease.epoch === epoch && state.event?.id === lease.eventId;
    },
    interrupt: invalidate,
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
