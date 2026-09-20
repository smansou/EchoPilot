/**
 * Renderer-side view of the shared attention policy (R02: events from any pillar → one policy →
 * speech / suppression / resumption receipt).
 *
 * The renderer is a consumer only. It never grants speech and never re-derives an outcome: every
 * row it paints is an `AttentionDecision` the policy actually produced, carried over verbatim so
 * the attention/settings surface answers "why did that update speak, stay silent or wait?" with
 * the policy's own `explanation` and the `setting` that governed it.
 *
 * Three invariants matter for the UI:
 *
 *   - The lease stays behind the seam. A receipt's `lease` is stripped on the way in, so no renderer
 *     state can replay speech authority; only the playback half checks `canSpeak` with it.
 *   - Silence controls render from the policy's resolved settings, never inferred from the stream.
 *     Mute and explicit output silence stay visible while the queue drains, and the receipt that
 *     explains a suppression stays in the append-only trail after the switch is flipped back.
 *   - The trail is bounded and newest-first, and a later receipt for one candidate supersedes the
 *     earlier row: `currentReceipt` is what the UI shows, while `resumptionReceipt` pairs a
 *     deferral with the spoken receipt that resumed it.
 */
import type {
  AttentionDecision,
  AttentionPolicy,
  AttentionSettingKey,
  AttentionSettings,
  PendingCandidate,
  SpeechCandidate,
} from '../../../../../../packages/attention/src/index.js';
import type {
  AttentionEventClass,
  AttentionOutcome,
  AttentionReason,
} from '../../../../../../packages/attention/src/index.js';

/** How many receipts the surface keeps for the settings/log pane. */
export const ATTENTION_RECEIPT_LIMIT = 50;

/** One policy receipt as the UI renders it; deliberately carries no speech authority. */
export type AttentionReceiptView = Readonly<{
  candidateId: string;
  eventId: string;
  sourceId: string;
  eventClass: AttentionEventClass;
  outcome: AttentionOutcome;
  reason: AttentionReason;
  explanation: string;
  setting: AttentionSettingKey | null;
  decidedAt: string;
}>;

export type AttentionView = Readonly<{
  settings: AttentionSettings;
  /** Newest first, bounded by the surface's receipt limit. */
  receipts: ReadonlyArray<AttentionReceiptView>;
  pending: ReadonlyArray<PendingCandidate>;
}>;

export type AttentionSurfaceOptions = Readonly<{ receiptLimit?: number }>;

export type AttentionSurface = Readonly<{
  /** Snapshot for rendering: settings, recent receipts, and what is still waiting. */
  view(): AttentionView;
  /** One pillar candidate in; the receipts it produced out. Listeners see the new view first. */
  submit(candidate: SpeechCandidate): ReadonlyArray<AttentionReceiptView>;
  /** Re-evaluate deferrals (the quiet/safe gap elapsed). Returns whatever finally spoke. */
  tick(): ReadonlyArray<AttentionReceiptView>;
  /** Settings changes (mute, silence, preset, overrides) flow through the policy and re-render. */
  updateSettings(patch: Partial<AttentionSettings>): AttentionView;
  /** Notified with every newly produced receipt, in policy order. Returns an unsubscribe. */
  subscribe(listener: (receipt: AttentionReceiptView, view: AttentionView) => void): () => void;
}>;

function toReceiptView({ lease: _lease, ...receipt }: AttentionDecision): AttentionReceiptView {
  return receipt;
}

/** The newest receipt for one candidate — the row the UI shows as its current state. */
export function currentReceipt(
  view: AttentionView,
  candidateId: string,
): AttentionReceiptView | null {
  return view.receipts.find((receipt) => receipt.candidateId === candidateId) ?? null;
}

/**
 * The pair that explains a resumption: the deferral and the later receipt that resolved it. `null`
 * while the update is still waiting, and for updates that spoke without ever being deferred.
 */
export function resumptionReceipt(
  view: AttentionView,
  candidateId: string,
): Readonly<{ deferred: AttentionReceiptView; resolved: AttentionReceiptView }> | null {
  const rows = view.receipts.filter((receipt) => receipt.candidateId === candidateId);
  const resolved = rows.find((receipt) => receipt.outcome !== 'deferred') ?? null;
  const deferred = rows.find((receipt) => receipt.outcome === 'deferred') ?? null;
  if (resolved === null || deferred === null) return null;
  return { deferred, resolved };
}

/** The one line the settings surface shows for a row: the policy's explanation and its governor. */
export function explainReceipt(receipt: AttentionReceiptView): string {
  return receipt.setting === null
    ? receipt.explanation
    : `${receipt.explanation} (governed by setting: ${receipt.setting})`;
}

export function createAttentionSurface(
  policy: AttentionPolicy,
  options: AttentionSurfaceOptions = {},
): AttentionSurface {
  const receiptLimit = Math.max(1, options.receiptLimit ?? ATTENTION_RECEIPT_LIMIT);
  const listeners = new Set<(receipt: AttentionReceiptView, view: AttentionView) => void>();

  const surface = {
    view(): AttentionView {
      const trail = policy.decisions();
      return {
        settings: policy.settings(),
        receipts: trail.slice(-receiptLimit).reverse().map(toReceiptView),
        pending: policy.pending(),
      };
    },

    emit(decisions: ReadonlyArray<AttentionDecision>): ReadonlyArray<AttentionReceiptView> {
      const receipts = decisions.map(toReceiptView);
      if (receipts.length > 0) {
        const view = surface.view();
        for (const receipt of receipts) {
          for (const listener of [...listeners]) listener(receipt, view);
        }
      }
      return receipts;
    },

    submit(candidate: SpeechCandidate): ReadonlyArray<AttentionReceiptView> {
      return surface.emit(policy.submit(candidate));
    },

    tick(): ReadonlyArray<AttentionReceiptView> {
      return surface.emit(policy.tick());
    },

    updateSettings(patch: Partial<AttentionSettings>): AttentionView {
      policy.updateSettings(patch);
      return surface.view();
    },

    subscribe(listener: (receipt: AttentionReceiptView, view: AttentionView) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies AttentionSurface & { emit(decisions: ReadonlyArray<AttentionDecision>): ReadonlyArray<AttentionReceiptView> };

  return surface;
}
