/**
 * Renderer-side privacy control (ticket path: private session / forget / export → the storage and
 * retrieval surfaces reflect the choice).
 *
 * The renderer owns three user choices and the words it is allowed to show for them; it never owns
 * the machinery. `forget`, `exportProfile` and `importProfile` are injected, so this module cannot
 * reach a store, a directory or a key by itself, and its invariants stay checkable in a unit test:
 *
 *   - **A private session is visible while it runs.** The indicator is a first-class field, not a
 *     caption: the UI has no state to render that hides an active private session.
 *   - **A forget needs an explicit confirmation.** `requestForget` only stages the selection (with
 *     a human label); `confirmForget` refuses unless a stage exists and no request is in flight, so
 *     an agent-originated selection can never delete anything by itself.
 *   - **The passphrase is spent, never stored.** A submitted passphrase is dropped from state as
 *     soon as the operation settles — success or failure — and only the outcome is kept.
 *   - **Failure never claims success.** A failed export/import records the reason and leaves the
 *     previous outcome untouched; a failed import explicitly reports that the destination was not
 *     modified, which is what the storage layer guarantees.
 */

export type PrivacyForgetSelection = Readonly<{
  /** Raw lineage ids the user selected, as the memory views expose them. */
  eventIds?: readonly string[];
  /** Whole-source choices; an empty `sourceEventIds` means "every record of this source". */
  sources?: readonly Readonly<{ sourceId: string; sourceEventIds: readonly string[] }>[];
}>;

export type PrivacyOperations = Readonly<{
  forget(request: PrivacyForgetSelection): Promise<Readonly<{ deleted: number; condensed: number }>>;
  exportProfile(request: Readonly<{ passphrase: string }>): Promise<Readonly<{ files: readonly string[] }>>;
  importProfile(request: Readonly<{ archive: string; passphrase: string }>): Promise<Readonly<{ files: readonly string[] }>>;
}>;

export type PrivacyStage =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'running' }>
  | Readonly<{ kind: 'succeeded'; detail: string }>
  | Readonly<{ kind: 'failed'; reason: string }>;

export type PrivacyControlState = Readonly<{
  /** The private indicator: true exactly while a private session is open. */
  private: boolean;
  privateLabel: string;
  /** A staged forget: the selection is shown back to the user before anything is deleted. */
  pendingForget: Readonly<{ selection: PrivacyForgetSelection; label: string }> | null;
  forget: PrivacyStage;
  export: PrivacyStage;
  import: PrivacyStage;
}>;

export interface PrivacyControl {
  state(): PrivacyControlState;
  beginPrivateSession(): PrivacyControlState;
  endPrivateSession(): PrivacyControlState;
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

export function createPrivacyControl(operations: PrivacyOperations): PrivacyControl {
  if (operations === null || typeof operations !== 'object' || typeof operations.forget !== 'function') {
    throw new TypeError('createPrivacyControl requires { forget, exportProfile, importProfile }');
  }
  let state: PrivacyControlState = {
    private: false,
    privateLabel: NOT_PRIVATE_LABEL,
    pendingForget: null,
    forget: IDLE,
    export: IDLE,
    import: IDLE,
  };
  const update = (patch: Partial<PrivacyControlState>): PrivacyControlState => {
    state = { ...state, ...patch };
    return state;
  };
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  return {
    state: () => state,
    beginPrivateSession: () => update({ private: true, privateLabel: PRIVATE_SESSION_LABEL }),
    endPrivateSession: () => update({ private: false, privateLabel: NOT_PRIVATE_LABEL }),
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
        return update({ export: { kind: 'succeeded', detail: `Sealed ${receipt.files.length} files.` } });
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
