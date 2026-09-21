/**
 * S03 private-session seam — the storage side of "private session".
 *
 * A private session is a choice about *storage*, so it is enforced where storage happens instead of
 * where the UI happens to be: the profile's deletion handle owns this registry, and the guarded
 * `MemoryStore.ingest` diverts every event whose scope names an open session into it. Nothing in
 * this module holds a path, a database handle or a writer callback, so there is no code path from a
 * private entry to durable storage — the buffer is plain memory and it is dropped on `end()`.
 *
 * Three rules keep the choice honest:
 *
 *  - **Open means private.** `isPrivate(sessionId)` is true exactly while the session is open, and
 *    the storage boundary asks before every write, so a capture cannot be persisted "by accident".
 *  - **Ended means gone.** `end()` returns the transcript once and empties the buffer. A late batch
 *    that still carries the ended session id is dropped rather than stored, because the user's
 *    choice was to keep that session out of durable memory *and* an ended session is no longer the
 *    thing that was displayed.
 *  - **Nothing travels.** The transcript is text for display; the raw payload is never handed to a
 *    store, and a private session writes no sidecar, no ledger and no tombstone.
 */
/** The kinds a private buffer distinguishes: user speech, an observation, or any other event. */
export type PrivateSessionEntryKind = 'utterance' | 'observation' | 'event';

export type PrivateSessionEntry = Readonly<{
  sessionId: string;
  /** Display order within the session, starting at 1. */
  sequence: number;
  kind: PrivateSessionEntryKind;
  /** Text the UI may show while the session runs (and once, when it ends). */
  text: string;
  at: string;
}>;

export interface MemoryPrivateSession {
  readonly sessionId: string;
  /** True while the session accepts entries; false once it ended. */
  active(): boolean;
  record(entry: Readonly<{ kind?: PrivateSessionEntryKind; text: string }>): PrivateSessionEntry;
  transcript(): readonly PrivateSessionEntry[];
  /** Ends the session, hands the transcript back once and drops the buffer. */
  end(): readonly PrivateSessionEntry[];
}

export interface MemoryPrivateSessions {
  /** Session ids whose choice is currently in force, sorted. */
  openSessions(): readonly string[];
  /** Opens (or returns) the in-memory session for one id. */
  begin(request: Readonly<{ sessionId: string; profileId?: string; now?: () => Date }>): MemoryPrivateSession;
  /** The open session for an id, if any; an ended session is not returned. */
  get(sessionId: string): MemoryPrivateSession | undefined;
  /** True exactly while this session id must not reach durable storage. */
  isPrivate(sessionId: string | undefined): boolean;
  /**
   * True for every id this registry opened privately in this process, open or ended. The storage
   * boundary uses it (instead of `isPrivate`) so a capture that arrives after `end()` is dropped
   * without being buffered: the transcript was already handed back once, and a stale batch must
   * never turn a private session into durable memory.
   */
  wasPrivate(sessionId: string | undefined): boolean;
  /**
   * The storage-boundary hook: buffers one event captured while its session was open and returns
   * the buffered entry, or `undefined` when the session is not open (the entry is then dropped and
   * never reaches a store).
   */
  capture(request: Readonly<{ sessionId: string | undefined; kind?: string; text: string; at?: Date }>): PrivateSessionEntry | undefined;
  /** Drops every buffered session without returning anything. */
  close(): void;
}

type Session = {
  sessionId: string;
  entries: PrivateSessionEntry[];
  open: boolean;
  now: () => Date;
};

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function kindOf(value: unknown): PrivateSessionEntryKind {
  return value === 'observation' || value === 'utterance' ? value : 'event';
}

class InMemoryPrivateSessions implements MemoryPrivateSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
  }

  openSessions(): readonly string[] {
    return [...this.sessions.values()].filter((session) => session.open).map((session) => session.sessionId).sort();
  }

  begin(request: Readonly<{ sessionId: string; now?: () => Date }>): MemoryPrivateSession {
    const sessionId = asText(request?.sessionId);
    if (sessionId === undefined) throw new TypeError('private session requires a sessionId');
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined && existing.open) return this.handle(existing);
    const session: Session = { sessionId, entries: [], open: true, now: request?.now ?? this.now };
    this.sessions.set(sessionId, session);
    return this.handle(session);
  }

  get(sessionId: string): MemoryPrivateSession | undefined {
    const id = asText(sessionId);
    if (id === undefined) return undefined;
    const session = this.sessions.get(id);
    return session !== undefined && session.open ? this.handle(session) : undefined;
  }

  isPrivate(sessionId: string | undefined): boolean {
    const id = asText(sessionId);
    if (id === undefined) return false;
    const session = this.sessions.get(id);
    return session !== undefined && session.open;
  }

  wasPrivate(sessionId: string | undefined): boolean {
    const id = asText(sessionId);
    return id !== undefined && this.sessions.has(id);
  }

  capture(request: Readonly<{ sessionId: string | undefined; kind?: string; text: string; at?: Date }>): PrivateSessionEntry | undefined {
    const session = this.get(asText(request?.sessionId) ?? '');
    if (session === undefined) return undefined;
    const text = typeof request?.text === 'string' ? request.text : '';
    const recorded = session.record({ kind: kindOf(request?.kind), text });
    return recorded;
  }

  close(): void {
    for (const session of this.sessions.values()) session.entries.length = 0;
    this.sessions.clear();
  }

  private handle(session: Session): MemoryPrivateSession {
    const record = (entry: Readonly<{ kind?: PrivateSessionEntryKind; text: string }>): PrivateSessionEntry => {
      if (!session.open) throw new Error(`private session ${session.sessionId} has already ended`);
      const text = typeof entry?.text === 'string' ? entry.text : '';
      const recorded: PrivateSessionEntry = {
        sessionId: session.sessionId,
        sequence: session.entries.length + 1,
        kind: kindOf(entry?.kind),
        text,
        at: session.now().toISOString(),
      };
      session.entries.push(recorded);
      return recorded;
    };
    return {
      sessionId: session.sessionId,
      active: (): boolean => session.open,
      record,
      transcript: (): readonly PrivateSessionEntry[] => session.entries.map((entry) => ({ ...entry })),
      end: (): readonly PrivateSessionEntry[] => {
        // The session stops being private-and-open here: a later capture with the same id must be
        // dropped rather than buffered, so the choice cannot be re-opened by a stale batch.
        session.open = false;
        const ended = session.entries.map((entry) => ({ ...entry }));
        session.entries.length = 0;
        return ended;
      },
    };
  }
}

export function createMemoryPrivateSessions(options: Readonly<{ now?: () => Date }> = {}): MemoryPrivateSessions {
  return new InMemoryPrivateSessions(options.now ?? ((): Date => new Date()));
}
