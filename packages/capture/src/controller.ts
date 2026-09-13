/**
 * A01 dictation controller: dictate into the focused editor → scoped context preview → literal
 * insertion → undo.
 *
 * The rules are deliberately boring and deterministic:
 *
 * - exactly one capture per utterance, with at most one permitted screenshot;
 * - bundle redaction happens in this process, never in the helper alone;
 * - a transcript is committed as a draft and only written after the original fingerprint is
 *   revalidated against the currently focused element;
 * - insertion is literal and never submits: no Return/Enter, no app activation, no clipboard read
 *   on the Accessibility path;
 * - the clipboard paste is the transactional fallback, and undo reuses the insertion transaction.
 */
import { AX_CAPTURE_BUDGET } from './budget.js';
import { pasteWithClipboardTransaction } from './clipboard.js';
import {
  assembleContextBundle,
  createBundlePolicy,
  isSecureRole,
  sameFingerprint,
  transcriptOnlyBundle,
} from './redaction.js';
import type {
  CaptureBridge,
  CaptureMode,
  CapturePreview,
  CaptureTarget,
  ControllerPhase,
  ControllerStatus,
  DictationController,
  DictationControllerOptions,
  Draft,
  InsertionResult,
  TargetFingerprint,
  UndoResult,
} from './types.js';

export function createDictationController(options: DictationControllerOptions): DictationController {
  const { bridge } = options;
  const policy = createBundlePolicy(options.excludedBundleIds);

  let phase: ControllerPhase = 'idle';
  let mode: CaptureMode | null = null;
  let preview: CapturePreview | null = null;
  let draft: Draft | null = null;
  let lastTransactionId: string | null = null;
  let utteranceCount = 0;
  let transactionCount = 0;

  const nextTransactionId = (): string => {
    transactionCount += 1;
    return `a01-dictation-${utteranceCount}-${transactionCount}`;
  };

  /** Focus moved away (or the element stopped being editable): write nothing, keep the draft. */
  const targetStillFocused = async (fingerprint: TargetFingerprint): Promise<boolean> => {
    const current: CaptureTarget | null = await bridge.currentTarget();
    if (!current || !current.editable) return false;
    return sameFingerprint(current.fingerprint, fingerprint);
  };

  async function beginUtterance(input?: Readonly<{ screenshot?: boolean }>): Promise<CapturePreview> {
    utteranceCount += 1;
    const target = await bridge.currentTarget();
    const wantScreenshot = input?.screenshot ?? true;
    // A field the controller itself saw as secure never gets a screenshot, flag or role that says
    // otherwise: `AXSecureTextField` is secure even when the helper reports `secure: false`.
    const targetIsSecure = target !== null && (target.secure || isSecureRole(target.role));

    if (!target) {
      // Nothing focused to capture or to revalidate against: transcript-only, with no bundle.
      mode = 'transcript_only';
      preview = { mode, bundle: transcriptOnlyBundle(utteranceCount, Date.now()), target: null };
    } else if (policy.isExcluded(target.fingerprint.bundleId)) {
      // An excluded application (including the always-excluded EchoPilot widget) is never
      // captured: no screenshot, no AX traversal, no selection, no OCR. Dictation still lands
      // there — transcript-only — and the fingerprint stays for the pre-write revalidation.
      mode = 'transcript_only';
      preview = { mode, bundle: transcriptOnlyBundle(utteranceCount, Date.now()), target: target.fingerprint };
    } else {
      const outcome = await bridge.captureContext({
        target,
        // A secure field is never screenshotted, whatever the caller asked for.
        includeScreenshot: wantScreenshot && !targetIsSecure,
        axBudget: AX_CAPTURE_BUDGET,
        excludedBundleIds: policy.excludedBundleIds,
      });
      if (outcome.status === 'captured') {
        mode = 'context';
        // The helper is a raw producer and its snapshot may disagree with the element this
        // controller focused. Secureness is the union of both views, so a helper claiming
        // `secure: false` cannot walk the focused field's selection or OCR into the bundle.
        const snapshot = targetIsSecure && !outcome.snapshot.target.secure
          ? { ...outcome.snapshot, target: { ...outcome.snapshot.target, secure: true } }
          : outcome.snapshot;
        preview = {
          mode,
          bundle: assembleContextBundle(snapshot, policy, AX_CAPTURE_BUDGET),
          target: outcome.snapshot.target.fingerprint,
        };
      } else {
        // Denied capture still dictates: the transcript must reach the editor either way.
        mode = 'transcript_only';
        preview = { mode, bundle: transcriptOnlyBundle(utteranceCount, Date.now()), target: target.fingerprint };
      }
    }

    draft = null;
    lastTransactionId = null;
    phase = 'captured';
    return preview;
  }

  async function commitTranscript(text: string): Promise<Draft> {
    const target = preview?.target ?? null;
    if (!target) {
      throw new Error(
        'commitTranscript requires a target fingerprint: call beginUtterance() while a field is focused',
      );
    }
    // Freeze the raw committed ASR text. No trimming, no punctuation "fixups", no insertion yet.
    draft = { text, target };
    phase = 'drafted';
    return draft;
  }

  function completeInsertion(text: string, method: 'accessibility' | 'clipboard', transactionId: string): InsertionResult {
    draft = null;
    lastTransactionId = transactionId;
    phase = 'inserted';
    return { status: 'inserted', method, transactionId, text };
  }

  async function insert(): Promise<InsertionResult> {
    const committed = draft;
    if (!committed) return { status: 'nothing_to_insert' };

    // Revalidate immediately before writing: the helper writes into whatever is focused now.
    if (!(await targetStillFocused(committed.target))) {
      return { status: 'focus_changed', draftPreserved: true };
    }

    const transactionId = nextTransactionId();
    const outcome = await bridge.insertText({
      transactionId,
      targetFingerprint: committed.target,
      text: committed.text,
      submit: false,
    });

    if (outcome.status === 'inserted') {
      return completeInsertion(committed.text, outcome.method, transactionId);
    }
    if (outcome.status === 'target_mismatch') {
      // The helper saw a different element than the caller did: nothing was written.
      return { status: 'focus_changed', draftPreserved: true };
    }

    // Accessibility insertion is unsupported here, so borrow the clipboard transactionally into
    // the element the fingerprint still points at.
    if (!(await targetStillFocused(committed.target))) {
      return { status: 'focus_changed', draftPreserved: true };
    }
    await pasteWithClipboardTransaction(bridge, committed.text);
    return completeInsertion(committed.text, 'clipboard', transactionId);
  }

  async function retargetToCurrentFocus(): Promise<
    Readonly<{ status: 'retargeted'; target: TargetFingerprint }> | Readonly<{ status: 'no_target' }>
  > {
    if (!draft) return { status: 'no_target' };
    const current = await bridge.currentTarget();
    if (!current) return { status: 'no_target' };
    // The explicit new-target decision: the text is preserved, only the destination changes.
    draft = { text: draft.text, target: current.fingerprint };
    return { status: 'retargeted', target: current.fingerprint };
  }

  async function undo(): Promise<UndoResult> {
    const transactionId = lastTransactionId;
    if (!transactionId) return { status: 'nothing_to_undo' };
    lastTransactionId = null;
    const outcome = await bridge.undo({ transactionId });
    phase = 'undone';
    return { status: outcome.status === 'undone' ? 'undone' : 'nothing_to_undo' };
  }

  const status = (): ControllerStatus => ({ phase, mode });

  return {
    beginUtterance,
    preview: () => preview,
    commitTranscript,
    draft: () => draft,
    insert,
    retargetToCurrentFocus,
    undo,
    status,
  };
}
