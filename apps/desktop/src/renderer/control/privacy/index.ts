/**
 * Renderer-side privacy control (ticket path: private session / forget / export → the storage and
 * retrieval surfaces reflect the choice).
 *
 * The renderer owns three user choices and the words it is allowed to show for them; it never owns
 * the machinery. `forget`, `exportProfile` and `importProfile` are injected, so this module cannot
 * reach a store, a directory or a key by itself, and its invariants stay checkable in a unit test:
 *
 *   - **A private session is visible while it runs.** The indicator is a first-class field, not a
 *     caption: the UI has no state to render that hides an active private session. It turns on only
 *     after the host's registry accepted the session, so a control that cannot reach the registry
 *     reports the failure instead of claiming privacy the storage boundary would not honor.
 *   - **A forget needs an explicit confirmation.** `requestForget` only stages the selection (with
 *     a human label); `confirmForget` refuses unless a stage exists and no request is in flight, so
 *     an agent-originated selection can never delete anything by itself.
 *   - **The passphrase is spent, never stored.** A submitted passphrase is dropped from state as
 *     soon as the operation settles — success or failure — and only the outcome is kept.
 *   - **Failure never claims success.** A failed export/import records the reason and leaves the
 *     previous outcome untouched; a failed import explicitly reports that the destination was not
 *     modified, which is what the storage layer guarantees.
 *
 * `PrivacyOperations` is the seam the desktop host binds to the profile's real service:
 * `profile-host.ts` builds it from the M01 store's own `privacy` handle (the same one its `ingest`
 * enforces) and the passphrase-sealed export/restore pair from `@echopilot/security`, and `host.ts`
 * is how a window resolves the binding its host installed. Nothing below is a double.
 */

export type PrivacyForgetSelection = Readonly<{
  /** Raw lineage ids the user selected, as the memory views expose them. */
  eventIds?: readonly string[];
  /** Whole-source choices; an empty `sourceEventIds` means "every record of this source". */
  sources?: readonly Readonly<{ sourceId: string; sourceEventIds: readonly string[] }>[];
}>;

/** One buffered private-session entry, as the storage-side registry hands it back once. */
export type PrivacySessionEntry = Readonly<{
  sequence: number;
  kind: string;
  text: string;
  at: string;
}>;

export type PrivacyOperations = Readonly<{
  /**
   * False when the desktop host has not bound a profile: every operation then fails with the
   * host's reason instead of pretending a choice was stored. A bound host omits it (or passes
   * `true`).
   */
  readonly bound?: boolean;
  forget(request: PrivacyForgetSelection): Promise<Readonly<{ deleted: number; condensed: number }>>;
  exportProfile(request: Readonly<{ passphrase: string }>): Promise<Readonly<{ files: readonly string[]; destination?: string }>>;
  importProfile(request: Readonly<{ archive: string; passphrase: string }>): Promise<Readonly<{ files: readonly string[] }>>;
  /**
   * Opens the profile's private-session registry — the entry the storage boundary consults before
   * every write — so a capture under `sessionId` is buffered in memory instead of persisted.
   */
  beginPrivateSession?(request: Readonly<{ sessionId: string }>): Promise<void> | void;
  /** Ends it, hands the buffered transcript back once, and drops it. */
  endPrivateSession?(request: Readonly<{ sessionId: string }>): Promise<readonly PrivacySessionEntry[]> | readonly PrivacySessionEntry[];
}>;

export type PrivacyStage =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'running' }>
  | Readonly<{ kind: 'succeeded'; detail: string }>
  | Readonly<{ kind: 'failed'; reason: string }>;

export type PrivacyControlState = Readonly<{
  /** The private indicator: true exactly while a private session is open in the host registry. */
  private: boolean;
  /** The session id the storage boundary must keep out of durable memory while it runs. */
  privateSessionId: string | null;
  privateLabel: string;
  /** The transcript an ended session handed back once; empty until a session ends. */
  privateTranscript: readonly PrivacySessionEntry[];
  /** Why the last private-session transition failed; null when nothing failed. */
  privateError: string | null;
  /** A staged forget: the selection is shown back to the user before anything is deleted. */
  pendingForget: Readonly<{ selection: PrivacyForgetSelection; label: string }> | null;
  forget: PrivacyStage;
  export: PrivacyStage;
  import: PrivacyStage;
  /** False when the host has not bound a profile; the UI must not offer what cannot be stored. */
  bound: boolean;
}>;

export interface PrivacyControl {
  state(): PrivacyControlState;
  /** Opens a private session in the host registry; the indicator follows that registry, not the click. */
  beginPrivateSession(): Promise<PrivacyControlState>;
  /** Ends it and keeps the transcript the host handed back once. */
  endPrivateSession(): Promise<PrivacyControlState>;
  /** Stages a forget selection. Nothing is deleted until `confirmForget` runs. */
  requestForget(selection: PrivacyForgetSelection, label: string): PrivacyControlState;
  cancelForget(): PrivacyControlState;
  /** Runs the staged forget through the injected operation; without a stage it refuses. */
  confirmForget(): Promise<PrivacyControlState>;
  exportProfile(request: Readonly<{ passphrase: string }>): Promise<PrivacyControlState>;
  importProfile(request: Readonly<{ archive: string; passphrase: string }>): Promise<PrivacyControlState>;
}

const IDLE: PrivacyStage = { kind: 'idle' };
/** What the indicator says while a private session is open: the user must be told, not just shown a dot. */
export const PRIVATE_SESSION_LABEL = 'Private session — this conversation is not being saved.';
export const NOT_PRIVATE_LABEL = 'Recall is on.';

/** Session ids only need to be unique inside this profile; the id itself is never record content. */
function newPrivateSessionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `private-session-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createPrivacyControl(operations: PrivacyOperations): PrivacyControl {
  if (operations === null || typeof operations !== 'object' || typeof operations.forget !== 'function') {
    throw new TypeError('createPrivacyControl requires { forget, exportProfile, importProfile }');
  }
  let state: PrivacyControlState = {
    private: false,
    privateSessionId: null,
    privateLabel: NOT_PRIVATE_LABEL,
    privateTranscript: [],
    privateError: null,
    pendingForget: null,
    forget: IDLE,
    export: IDLE,
    import: IDLE,
    bound: operations.bound !== false,
  };
  const update = (patch: Partial<PrivacyControlState>): PrivacyControlState => {
    state = { ...state, ...patch };
    return state;
  };
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  return {
    state: () => state,
    beginPrivateSession: async () => {
      if (state.private) return state;
      const sessionId = newPrivateSessionId();
      // The indicator follows the registry: if the host cannot open the session, the capture
      // boundary does not know about it and the UI must not claim the conversation is private.
      if (typeof operations.beginPrivateSession !== 'function') {
        return update({ privateError: 'This host has no private-session registry to open a session on.' });
      }
      try {
        await operations.beginPrivateSession({ sessionId });
      } catch (error) {
        return update({ privateError: reasonOf(error) });
      }
      return update({
        private: true,
        privateSessionId: sessionId,
        privateLabel: PRIVATE_SESSION_LABEL,
        privateError: null,
        privateTranscript: [],
      });
    },
    endPrivateSession: async () => {
      const sessionId = state.privateSessionId;
      if (!state.private || sessionId === null) {
        return update({ private: false, privateLabel: NOT_PRIVATE_LABEL, privateSessionId: null });
      }
      let transcript: readonly PrivacySessionEntry[] = [];
      let privateError: string | null = null;
      if (typeof operations.endPrivateSession === 'function') {
        try {
          transcript = await operations.endPrivateSession({ sessionId });
        } catch (error) {
          privateError = reasonOf(error);
        }
      }
      // The session is over either way: an ended id must never keep claiming the private label.
      return update({
        private: false,
        privateSessionId: null,
        privateLabel: NOT_PRIVATE_LABEL,
        privateTranscript: transcript,
        privateError,
      });
    },
    requestForget: (selection, label) => {
      const text = typeof label === 'string' && label.trim().length > 0
        ? label.trim()
        : 'Selected memory';
      return update({ pendingForget: { selection, label: text }, forget: IDLE });
    },
    cancelForget: () => update({ pendingForget: null, forget: IDLE }),
    confirmForget: async () => {
      const staged = state.pendingForget;
      if (staged === null) return update({ forget: { kind: 'failed', reason: 'No forget has been confirmed by the user.' } });
      if (state.forget.kind === 'running') return state;
      update({ forget: { kind: 'running' } });
      try {
        const receipt = await operations.forget(staged.selection);
        return update({
          pendingForget: null,
          forget: { kind: 'succeeded', detail: `Forgot ${staged.label}: ${receipt.deleted} stored rows removed, ${receipt.condensed} derived entries updated.` },
        });
      } catch (error) {
        return update({ pendingForget: null, forget: { kind: 'failed', reason: reasonOf(error) } });
      }
    },
    exportProfile: async ({ passphrase }) => {
      update({ export: { kind: 'running' } });
      try {
        const receipt = await operations.exportProfile({ passphrase });
        return update({ export: { kind: 'succeeded', detail: receipt.destination
          ? `Sealed ${receipt.files.length} files in ${receipt.destination}.`
          : `Sealed ${receipt.files.length} files.` } });
      } catch (error) {
        // The passphrase is already out of scope here; only the reason is kept.
        return update({ export: { kind: 'failed', reason: reasonOf(error) } });
      }
    },
    importProfile: async ({ archive, passphrase }) => {
      update({ import: { kind: 'running' } });
      try {
        const receipt = await operations.importProfile({ archive, passphrase });
        return update({ import: { kind: 'succeeded', detail: `Restored ${receipt.files.length} files.` } });
      } catch (error) {
        return update({
          import: {
            kind: 'failed',
            reason: `${reasonOf(error)} The destination was not modified.`,
          },
        });
      }
    },
  };
}
