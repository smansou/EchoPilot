/**
 * `@echopilot/capture` — the A01 dictation seam.
 *
 * The signed macOS helper owns the Accessibility/ScreenCaptureKit/pasteboard calls
 * (`native/macos/Sources/Accessibility`, `native/macos/Sources/Capture`); this package owns the
 * safety rules that are decidable off-device: the bounded capture request, bundle redaction,
 * fingerprint revalidation before writing, literal non-submitting insertion, the transactional
 * clipboard fallback, and undo.
 */
export { AX_CAPTURE_BUDGET } from './budget.js';
export { createDictationController } from './controller.js';
export {
  WIDGET_BUNDLE_IDS,
  assembleContextBundle,
  createBundlePolicy,
  sameFingerprint,
  transcriptOnlyBundle,
} from './redaction.js';
export { PASTE_KEYSTROKE, pasteWithClipboardTransaction } from './clipboard.js';
export type { BundlePolicy } from './redaction.js';
export type { ClipboardTransaction } from './clipboard.js';
export type {
  AXNode,
  Bounds,
  CaptureBridge,
  CaptureMode,
  CaptureOutcome,
  CapturePreview,
  CaptureRequest,
  CaptureSnapshot,
  CaptureTarget,
  CapturedAXNode,
  CapturedOCRSpan,
  ContextBundle,
  ControllerPhase,
  ControllerStatus,
  DictationController,
  DictationControllerOptions,
  Draft,
  InsertOutcome,
  InsertRequest,
  InsertionResult,
  OCRSpan,
  TargetFingerprint,
  UndoOutcome,
  UndoResult,
} from './types.js';
