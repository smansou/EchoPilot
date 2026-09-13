/**
 * A01 dictation seam: the shapes the rules layer shares with the signed macOS helper.
 *
 * The helper is the only component that touches the Accessibility API, ScreenCaptureKit and the
 * pasteboard. It is a *raw producer*: `captureContext` may hand back secure, excluded, or
 * EchoPilot-widget content, and the controller redacts it before a bundle exists (plan §5.4:
 * "post-capture blur alone is insufficient for an excluded app").
 */
export type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * Identity of the element dictation started in. `elementFingerprint` is the helper's opaque
 * per-element identity, so revalidation is a fingerprint comparison and never a guess about focus.
 */
export type TargetFingerprint = Readonly<{
  bundleId: string;
  pid: number;
  windowId: number;
  elementFingerprint: string;
}>;

export type CaptureTarget = Readonly<{
  fingerprint: TargetFingerprint;
  displayId: number;
  bounds: Bounds;
  pixelScale: number;
  role: string;
  secure: boolean;
  editable: boolean;
}>;

export type CaptureRequest = Readonly<{
  target: CaptureTarget;
  includeScreenshot: boolean;
  axBudget: Readonly<{ maxNodes: number; maxTraversalMs: number }>;
  excludedBundleIds: ReadonlyArray<string>;
}>;

export type CapturedAXNode = Readonly<{
  nodeId: string;
  bundleId: string;
  role: string;
  value: string;
  secure: boolean;
  bounds: Bounds;
}>;

export type CapturedOCRSpan = Readonly<{ text: string; bundleId: string; bounds: Bounds }>;

export type CaptureSnapshot = Readonly<{
  snapshotId: string;
  capturedAtMs: number;
  target: CaptureTarget;
  screenshotRef: string | null;
  selectedText: string | null;
  axNodes: ReadonlyArray<CapturedAXNode>;
  ocrSpans: ReadonlyArray<CapturedOCRSpan>;
  quality: 'full' | 'partial';
  truncated: boolean;
}>;

export type CaptureOutcome =
  | Readonly<{ status: 'captured'; snapshot: CaptureSnapshot }>
  | Readonly<{ status: 'denied'; reason: 'screen_recording_denied' | 'accessibility_denied' }>;

export type InsertRequest = Readonly<{
  transactionId: string;
  targetFingerprint: TargetFingerprint;
  text: string;
  /** Dictation never submits: raw text is inserted and the user keeps the Return key. */
  submit: false;
}>;

export type InsertOutcome =
  | Readonly<{ status: 'inserted'; transactionId: string; method: 'accessibility' }>
  | Readonly<{ status: 'unsupported'; transactionId: string; reason: string }>
  | Readonly<{ status: 'target_mismatch'; transactionId: string; reason: string }>;

export type UndoOutcome = Readonly<{ status: 'undone' | 'nothing_to_undo'; transactionId: string | null }>;

export type CaptureBridge = Readonly<{
  currentTarget(): Promise<CaptureTarget | null>;
  captureContext(request: CaptureRequest): Promise<CaptureOutcome>;
  insertText(request: InsertRequest): Promise<InsertOutcome>;
  undo(request: Readonly<{ transactionId: string }>): Promise<UndoOutcome>;
  clipboard: Readonly<{ changeCount(): number; readText(): string; writeText(text: string): void }>;
  /** Native key synthesis; only the paste fallback may use it, and only with `command+v`. */
  sendKey(key: string): Promise<void>;
  /** Focus-changing API: dictation must never call it, because focus theft would misroute text. */
  activateApplication(bundleId: string): Promise<void>;
}>;

export type AXNode = Readonly<{
  nodeId: string;
  role: string;
  value: string;
  secure: boolean;
  bounds: Bounds;
}>;

export type OCRSpan = Readonly<{ text: string; bundleId: string; bounds: Bounds }>;

export type ContextBundle = Readonly<{
  snapshotId: string;
  capturedAtMs: number;
  target: Readonly<{
    bundleId: string;
    pid: number;
    windowId: number;
    displayId: number;
    elementFingerprint: string;
    bounds: Bounds;
    pixelScale: number;
  }> | null;
  selectedText: string | null;
  screenshotRef: string | null;
  axNodes: ReadonlyArray<AXNode>;
  ocrSpans: ReadonlyArray<OCRSpan>;
  quality: 'full' | 'partial' | 'unavailable';
  truncated: boolean;
  redactions: Readonly<{ secureNodes: number; excludedNodes: number; excludedSpans: number }>;
}>;

export type CaptureMode = 'context' | 'transcript_only';

export type CapturePreview = Readonly<{
  mode: CaptureMode;
  bundle: ContextBundle;
  target: TargetFingerprint | null;
}>;

export type Draft = Readonly<{ text: string; target: TargetFingerprint }>;

export type InsertionResult =
  | Readonly<{
      status: 'inserted';
      method: 'accessibility' | 'clipboard';
      transactionId: string;
      text: string;
    }>
  | Readonly<{ status: 'focus_changed'; draftPreserved: true }>
  | Readonly<{ status: 'nothing_to_insert' }>;

export type UndoResult = Readonly<{ status: 'undone' | 'nothing_to_undo' }>;

export type ControllerPhase = 'idle' | 'captured' | 'drafted' | 'inserted' | 'undone';

export type ControllerStatus = Readonly<{ phase: ControllerPhase; mode: CaptureMode | null }>;

export type DictationController = Readonly<{
  beginUtterance(options?: Readonly<{ screenshot?: boolean }>): Promise<CapturePreview>;
  preview(): CapturePreview | null;
  commitTranscript(text: string): Promise<Draft>;
  draft(): Draft | null;
  insert(): Promise<InsertionResult>;
  retargetToCurrentFocus(): Promise<
    Readonly<{ status: 'retargeted'; target: TargetFingerprint }> | Readonly<{ status: 'no_target' }>
  >;
  undo(): Promise<UndoResult>;
  status(): ControllerStatus;
}>;

export type DictationControllerOptions = Readonly<{
  bridge: CaptureBridge;
  excludedBundleIds: ReadonlyArray<string>;
}>;
