/**
 * A01 acceptance oracle — dictate into a focused editor → scoped context preview → literal
 * insertion → undo (IMPLEMENTATION_PLAN.md §7.2 A01; plan §5.3/§5.4, insertion judgment A-F7).
 *
 * Real insertion into VS Code, TextEdit, and a browser field needs the signed helper,
 * Accessibility/Screen Recording consent, and the A04 compatibility matrix. This oracle drives the
 * same frozen seam with a deterministic native double so every property that is decidable
 * off-device is enforced now: one permitted capture per utterance, a redacted bounded bundle,
 * fingerprint revalidation before writing, literal non-submitting insertion, transactional
 * clipboard fallback, draft preservation, and undo.
 *
 * `packages/capture/src/index.ts` must export (this file pins these names; they are the frozen A01
 * seam between the TypeScript dictation controller and the signed native helper):
 *
 *   AX_CAPTURE_BUDGET = { maxNodes: 500, maxTraversalMs: 100 }
 *     Plan §5.4: "Limit initial AX traversal to 500 nodes and 100 ms."
 *
 *   createDictationController({ bridge, excludedBundleIds }) → DictationController
 *
 *     bridge — the native host boundary (plan §5.3 `NativeHost.capture` / `insertText`):
 *       currentTarget() → CaptureTarget | null
 *         The focused surface right now:
 *         { fingerprint: { bundleId, pid, windowId, elementFingerprint }, displayId, bounds,
 *           pixelScale, role, secure, editable }.
 *       captureContext({ target, includeScreenshot, axBudget, excludedBundleIds }) → CaptureOutcome
 *         captured → { status: 'captured', snapshot } where snapshot carries snapshotId,
 *         capturedAtMs, target, screenshotRef, selectedText, axNodes, ocrSpans, quality,
 *         truncated. denied → { status: 'denied', reason }.
 *         The helper is a raw producer: it can hand back secure, excluded, and widget content, so
 *         the controller redacts before anything enters a bundle (plan §5.4: "post-capture blur
 *         alone is insufficient for an excluded app").
 *       insertText({ transactionId, targetFingerprint, text, submit: false })
 *         → { status: 'inserted', transactionId, method: 'accessibility' }
 *         | { status: 'unsupported', transactionId, reason }
 *         | { status: 'target_mismatch', transactionId, reason }
 *         It writes into the currently focused element, so the caller must revalidate the
 *         fingerprint immediately before calling it. It never synthesizes a key, and `submit` is
 *         always false for dictation.
 *       undo({ transactionId }) → { status: 'undone' | 'nothing_to_undo' }
 *         Restores the buffer snapshot taken before that insertion.
 *       clipboard.changeCount() / clipboard.readText() / clipboard.writeText(text)
 *       sendKey(key)                  — native key synthesis; only the paste fallback may use it.
 *       activateApplication(bundleId) — focus-changing API; dictation must never call it.
 *
 *     excludedBundleIds — applications whose content must never enter a bundle.
 *
 *     controller:
 *       beginUtterance({ screenshot? }) → CapturePreview
 *         Captures the original target fingerprint and exactly one context bundle per utterance,
 *         with at most one permitted screenshot (`screenshot` defaults to true and is forced off
 *         for a secure focused field). mode 'context' when the helper captured; 'transcript_only'
 *         when capture was denied. preview() returns the same preview afterwards.
 *         The development preview bundle is { snapshotId, capturedAtMs, target: { bundleId, pid,
 *         windowId, displayId, elementFingerprint, bounds, pixelScale } | null, selectedText,
 *         screenshotRef, axNodes: [{ nodeId, role, value, secure, bounds }], ocrSpans: [{ text,
 *         bundleId, bounds }], quality: 'full' | 'partial' | 'unavailable', truncated, redactions:
 *         { secureNodes, excludedNodes, excludedSpans } }. Excluded bundle IDs, secure nodes, secure
 *         selected text, and OCR spans from excluded applications never enter it; the AX list never
 *         exceeds AX_CAPTURE_BUDGET.maxNodes and set truncated when the helper returned more.
 *       commitTranscript(text) → Draft
 *         Freezes the raw committed ASR text as the draft; nothing is inserted yet.
 *       insert() → { status: 'inserted', method: 'accessibility' | 'clipboard', transactionId,
 *                    text }
 *                | { status: 'focus_changed', draftPreserved: true }
 *                | { status: 'nothing_to_insert' }
 *         AX write first, transactional clipboard paste second. On a fingerprint mismatch it writes
 *         nothing anywhere and preserves the draft; retargetToCurrentFocus() is the explicit
 *         new-target decision that permits a later insert().
 *       retargetToCurrentFocus() → { status: 'retargeted', target } | { status: 'no_target' }
 *       undo() → { status: 'undone' | 'nothing_to_undo' }
 *       draft() → Draft | null      (Draft = { text, target: TargetFingerprint })
 *       status() → { phase: 'idle' | 'captured' | 'drafted' | 'inserted' | 'undone',
 *                    mode: 'context' | 'transcript_only' | null }
 *
 *     Clipboard judgment (§7.2 A01): the previous clipboard is restored only when its change count
 *     proves the user has not replaced it, and the clipboard is never read merely to collect
 *     context.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FIXTURE_URL = new URL('../../../fixtures/capture/a01-app-surfaces.json', import.meta.url);
/** The native double reports one fixed timestamp so bundles stay byte-comparable. */
const CAPTURED_AT_MS = 1_700_000_000_000;
/** Raw committed ASR text: internal newline, no trailing whitespace, nothing to "correct" yet. */
const RAW_COMMITTED_TEXT = 'serialize the Jason response as JSON\n{"id": 7, "note": "keep raw"}';
const PRIOR_CLIPBOARD_TEXT = 'previous user clipboard text (synthetic)';
const INTERFERENCE_CLIPBOARD_TEXT = 'user copied something else mid-paste (synthetic)';

type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>;

type TargetFingerprint = Readonly<{
  bundleId: string;
  pid: number;
  windowId: number;
  elementFingerprint: string;
}>;

type CaptureTarget = Readonly<{
  fingerprint: TargetFingerprint;
  displayId: number;
  bounds: Bounds;
  pixelScale: number;
  role: string;
  secure: boolean;
  editable: boolean;
}>;

type CaptureRequest = Readonly<{
  target: CaptureTarget;
  includeScreenshot: boolean;
  axBudget: Readonly<{ maxNodes: number; maxTraversalMs: number }>;
  excludedBundleIds: ReadonlyArray<string>;
}>;

type CapturedAXNode = Readonly<{
  nodeId: string;
  bundleId: string;
  role: string;
  value: string;
  secure: boolean;
  bounds: Bounds;
}>;

type CapturedOCRSpan = Readonly<{ text: string; bundleId: string; bounds: Bounds }>;

type CaptureSnapshot = Readonly<{
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

type CaptureOutcome =
  | Readonly<{ status: 'captured'; snapshot: CaptureSnapshot }>
  | Readonly<{ status: 'denied'; reason: 'screen_recording_denied' | 'accessibility_denied' }>;

type InsertRequest = Readonly<{
  transactionId: string;
  targetFingerprint: TargetFingerprint;
  text: string;
  submit: false;
}>;

type InsertOutcome =
  | Readonly<{ status: 'inserted'; transactionId: string; method: 'accessibility' }>
  | Readonly<{ status: 'unsupported'; transactionId: string; reason: string }>
  | Readonly<{ status: 'target_mismatch'; transactionId: string; reason: string }>;

type UndoOutcome = Readonly<{ status: 'undone' | 'nothing_to_undo'; transactionId: string | null }>;

type CaptureBridge = Readonly<{
  currentTarget(): Promise<CaptureTarget | null>;
  captureContext(request: CaptureRequest): Promise<CaptureOutcome>;
  insertText(request: InsertRequest): Promise<InsertOutcome>;
  undo(request: Readonly<{ transactionId: string }>): Promise<UndoOutcome>;
  clipboard: Readonly<{ changeCount(): number; readText(): string; writeText(text: string): void }>;
  sendKey(key: string): Promise<void>;
  activateApplication(bundleId: string): Promise<void>;
}>;

type AXNode = Readonly<{
  nodeId: string;
  role: string;
  value: string;
  secure: boolean;
  bounds: Bounds;
}>;

type OCRSpan = Readonly<{ text: string; bundleId: string; bounds: Bounds }>;

type ContextBundle = Readonly<{
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

type CapturePreview = Readonly<{
  mode: 'context' | 'transcript_only';
  bundle: ContextBundle;
  target: TargetFingerprint | null;
}>;

type Draft = Readonly<{ text: string; target: TargetFingerprint }>;

type InsertionResult =
  | Readonly<{
      status: 'inserted';
      method: 'accessibility' | 'clipboard';
      transactionId: string;
      text: string;
    }>
  | Readonly<{ status: 'focus_changed'; draftPreserved: true }>
  | Readonly<{ status: 'nothing_to_insert' }>;

type UndoResult = Readonly<{ status: 'undone' | 'nothing_to_undo' }>;

type ControllerStatus = Readonly<{
  phase: 'idle' | 'captured' | 'drafted' | 'inserted' | 'undone';
  mode: 'context' | 'transcript_only' | null;
}>;

type DictationController = Readonly<{
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

type CaptureModule = Readonly<{
  AX_CAPTURE_BUDGET: Readonly<{ maxNodes: number; maxTraversalMs: number }>;
  createDictationController(options: Readonly<{
    bridge: CaptureBridge;
    excludedBundleIds: ReadonlyArray<string>;
  }>): DictationController;
}>;

async function loadCaptureModule(): Promise<CaptureModule> {
  const fail = (detail: string): never => assert.fail(
    'A01 required dictation behavior is not implemented yet: packages/capture/src/index.ts must '
    + `export AX_CAPTURE_BUDGET and createDictationController({ bridge, excludedBundleIds }). ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists the import resolves to
  // nothing, and that is reported below as the missing behavior instead of a node/TS resolution
  // failure that hides what the oracle is waiting for.
  const specifier = ['..', 'src', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createDictationController !== 'function') {
    return fail('createDictationController({ bridge, excludedBundleIds }) is not exported');
  }
  const budget = loaded.AX_CAPTURE_BUDGET as Record<string, unknown> | undefined;
  if (typeof budget !== 'object' || budget === null) return fail('AX_CAPTURE_BUDGET is not exported');
  if (budget.maxNodes !== 500 || budget.maxTraversalMs !== 100) {
    return fail('AX_CAPTURE_BUDGET must be { maxNodes: 500, maxTraversalMs: 100 }');
  }
  return loaded as unknown as CaptureModule;
}

const capture = await loadCaptureModule();

type SurfaceFixture = Readonly<{
  key: string;
  bundleId: string;
  pid: number;
  windowId: number;
  displayId: number;
  role: string;
  insertMethod: 'accessibility' | 'clipboard';
  secure: boolean;
  bounds: Bounds;
  pixelScale: number;
  initialText: string;
}>;

type CaptureFixture = Readonly<{
  schemaVersion: number;
  excludedBundleIds: ReadonlyArray<string>;
  secretMarkers: Readonly<{
    secureFieldValue: string;
    excludedVaultText: string;
    widgetDraftText: string;
  }>;
  permittedSelectedText: string;
  permittedOcrText: string;
  permittedAxNodeCount: number;
  screenshotArtifactRef: string;
  surfaces: ReadonlyArray<SurfaceFixture>;
}>;

async function loadFixture(): Promise<CaptureFixture> {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as CaptureFixture;
  assert.equal(fixture.schemaVersion, 1, 'fixture schema version');
  assert.ok(fixture.surfaces.length >= 4, 'fixture must declare every A01 surface');
  return fixture;
}

const fixture = await loadFixture();

function surfaceFixture(key: string): SurfaceFixture {
  const spec = fixture.surfaces.find((candidate) => candidate.key === key);
  assert.ok(spec, `fixture must declare surface ${key}`);
  return spec;
}

type InsertionRecord = {
  readonly transactionId: string;
  readonly text: string;
  readonly bufferBefore: string;
  undone: boolean;
};

type SurfaceState = {
  readonly spec: SurfaceFixture;
  buffer: string;
  readonly insertions: Array<InsertionRecord>;
};

type CallLogEntry = Readonly<{ op: string; detail: string }>;

/**
 * Deterministic stand-in for the signed helper. It is deliberately raw: `captureContext` returns
 * secure, excluded, and widget content so bundle redaction cannot be delegated to the helper, and
 * `insertText` writes into whatever is focused right now, so a caller that skips fingerprint
 * revalidation visibly writes into the wrong target.
 */
class FakeDesktop {
  readonly fixture: CaptureFixture;
  readonly calls: Array<CallLogEntry> = [];
  readonly keyEvents: Array<string> = [];
  readonly activations: Array<string> = [];
  readonly captureRequests: Array<CaptureRequest> = [];
  clipboardReads = 0;
  clipboardWrites = 0;
  userClipboardWrites = 0;
  captureMode: 'full' | 'denied' = 'full';
  /** When set, the user replaces the clipboard after our paste but before restoration. */
  pasteInterference: string | null = null;
  private readonly surfaces = new Map<string, SurfaceState>();
  private focusedKey: string;
  private clipboardText = '';
  private clipboardChangeCount = 1;
  private lastUnsupported: Readonly<{ transactionId: string; surfaceKey: string }> | null = null;

  readonly clipboard = {
    changeCount: (): number => this.clipboardChangeCount,
    readText: (): string => {
      this.clipboardReads += 1;
      return this.clipboardText;
    },
    writeText: (text: string): void => {
      this.clipboardText = text;
      this.clipboardChangeCount += 1;
      this.clipboardWrites += 1;
    },
  };

  constructor(captureFixture: CaptureFixture, initialFocus = 'vscode') {
    this.fixture = captureFixture;
    for (const spec of captureFixture.surfaces) {
      this.surfaces.set(spec.key, { spec, buffer: spec.initialText, insertions: [] });
    }
    surfaceFixture(initialFocus);
    this.focusedKey = initialFocus;
  }

  surface(key: string): SurfaceState {
    const state = this.surfaces.get(key);
    assert.ok(state, `unknown surface ${key}`);
    return state;
  }

  /** The user's own focus action; dictation must not perform one of these itself. */
  focus(key: string): void {
    this.surface(key);
    this.focusedKey = key;
    this.calls.push({ op: 'focus', detail: key });
  }

  fingerprint(key: string): TargetFingerprint {
    return this.targetFor(this.surface(key)).fingerprint;
  }

  setUserClipboard(text: string): void {
    this.clipboardText = text;
    this.clipboardChangeCount += 1;
    this.userClipboardWrites += 1;
  }

  currentClipboardText(): string {
    return this.clipboardText;
  }

  currentClipboardChangeCount(): number {
    return this.clipboardChangeCount;
  }

  async currentTarget(): Promise<CaptureTarget | null> {
    return this.targetFor(this.surface(this.focusedKey));
  }

  async captureContext(request: CaptureRequest): Promise<CaptureOutcome> {
    this.captureRequests.push(request);
    this.calls.push({ op: 'captureContext', detail: request.target.fingerprint.bundleId });
    if (this.captureMode === 'denied') {
      return { status: 'denied', reason: 'screen_recording_denied' };
    }
    const focused = this.surface(this.focusedKey);
    const nodeBounds: Bounds = { x: 0, y: 0, width: 320, height: 18 };
    const axNodes: Array<CapturedAXNode> = [];
    for (let index = 0; index < this.fixture.permittedAxNodeCount; index += 1) {
      axNodes.push({
        nodeId: `ax-${index}`,
        bundleId: focused.spec.bundleId,
        role: 'AXStaticText',
        value: `permitted-node-${index}`,
        secure: false,
        bounds: { ...nodeBounds, y: index % 100 },
      });
    }
    // Raw producer data that policy must remove before a bundle exists.
    axNodes.push({
      nodeId: 'ax-secure-field',
      bundleId: focused.spec.bundleId,
      role: 'AXSecureTextField',
      value: this.fixture.secretMarkers.secureFieldValue,
      secure: true,
      bounds: nodeBounds,
    });
    axNodes.push({
      nodeId: 'ax-excluded-vault',
      bundleId: this.excludedBundleId(0),
      role: 'AXStaticText',
      value: this.fixture.secretMarkers.excludedVaultText,
      secure: false,
      bounds: nodeBounds,
    });
    axNodes.push({
      nodeId: 'ax-widget',
      bundleId: this.excludedBundleId(1),
      role: 'AXStaticText',
      value: this.fixture.secretMarkers.widgetDraftText,
      secure: false,
      bounds: nodeBounds,
    });
    const ocrSpans: Array<CapturedOCRSpan> = [
      { text: this.fixture.permittedOcrText, bundleId: focused.spec.bundleId, bounds: nodeBounds },
      {
        text: this.fixture.secretMarkers.excludedVaultText,
        bundleId: this.excludedBundleId(0),
        bounds: nodeBounds,
      },
    ];
    return {
      status: 'captured',
      snapshot: {
        snapshotId: 'snapshot-a01-1',
        capturedAtMs: CAPTURED_AT_MS,
        target: this.targetFor(focused),
        screenshotRef: request.includeScreenshot ? this.fixture.screenshotArtifactRef : null,
        selectedText: focused.spec.secure
          ? this.fixture.secretMarkers.secureFieldValue
          : this.fixture.permittedSelectedText,
        axNodes,
        ocrSpans,
        quality: 'full',
        truncated: axNodes.length > request.axBudget.maxNodes,
      },
    };
  }

  async insertText(request: InsertRequest): Promise<InsertOutcome> {
    this.calls.push({ op: 'insertText', detail: `${request.targetFingerprint.bundleId}:${request.submit}` });
    const focused = this.surface(this.focusedKey);
    if (focused.spec.insertMethod !== 'accessibility') {
      this.lastUnsupported = { transactionId: request.transactionId, surfaceKey: focused.spec.key };
      return { status: 'unsupported', transactionId: request.transactionId, reason: 'ax_insert_unsupported' };
    }
    const current = this.fingerprint(focused.spec.key);
    if (!sameFingerprint(current, request.targetFingerprint)) {
      this.calls.push({ op: 'target_mismatch', detail: request.transactionId });
      return { status: 'target_mismatch', transactionId: request.transactionId, reason: 'focused element changed' };
    }
    this.applyInsertion(focused, request.transactionId, request.text);
    return { status: 'inserted', transactionId: request.transactionId, method: 'accessibility' };
  }

  async undo(request: Readonly<{ transactionId: string }>): Promise<UndoOutcome> {
    this.calls.push({ op: 'undo', detail: request.transactionId });
    for (const state of this.surfaces.values()) {
      const record = state.insertions.find(
        (candidate) => !candidate.undone && candidate.transactionId === request.transactionId,
      );
      if (record) {
        state.buffer = record.bufferBefore;
        record.undone = true;
        return { status: 'undone', transactionId: request.transactionId };
      }
    }
    return { status: 'nothing_to_undo', transactionId: null };
  }

  async sendKey(key: string): Promise<void> {
    this.keyEvents.push(key);
    if (key !== 'command+v') return;
    const focused = this.surface(this.focusedKey);
    const transactionId = this.lastUnsupported?.transactionId ?? `paste-${this.keyEvents.length}`;
    this.applyInsertion(focused, transactionId, this.clipboardText);
    if (this.pasteInterference !== null) this.setUserClipboard(this.pasteInterference);
  }

  async activateApplication(bundleId: string): Promise<void> {
    this.activations.push(bundleId);
  }

  private applyInsertion(state: SurfaceState, transactionId: string, text: string): void {
    const bufferBefore = state.buffer;
    state.insertions.push({ transactionId, text, bufferBefore, undone: false });
    state.buffer = bufferBefore + text;
  }

  private excludedBundleId(index: number): string {
    const value = this.fixture.excludedBundleIds[index];
    assert.ok(value, `fixture excludedBundleIds[${index}] is required`);
    return value;
  }

  private targetFor(state: SurfaceState): CaptureTarget {
    const spec = state.spec;
    return {
      fingerprint: {
        bundleId: spec.bundleId,
        pid: spec.pid,
        windowId: spec.windowId,
        elementFingerprint: `${spec.key}:${spec.pid}:${spec.windowId}:0`,
      },
      displayId: spec.displayId,
      bounds: spec.bounds,
      pixelScale: spec.pixelScale,
      role: spec.role,
      secure: spec.secure,
      editable: true,
    };
  }
}

function sameFingerprint(left: TargetFingerprint, right: TargetFingerprint): boolean {
  return left.bundleId === right.bundleId
    && left.pid === right.pid
    && left.windowId === right.windowId
    && left.elementFingerprint === right.elementFingerprint;
}

function createController(desktop: FakeDesktop): DictationController {
  return capture.createDictationController({
    bridge: desktop,
    excludedBundleIds: fixture.excludedBundleIds,
  });
}

function assertNoSubmissionOrFocusTheft(desktop: FakeDesktop): void {
  const submissionKeys = desktop.keyEvents.filter((key) => /enter|return|\r|\n/i.test(key));
  assert.deepEqual(submissionKeys, [], 'insertion must never synthesize a submission keystroke');
  assert.deepEqual(desktop.activations, [], 'insertion must never activate or refocus an application');
}

test('A01 captures one permitted screenshot and a bounded AX subtree for the original target', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('vscode');
  const controller = createController(desktop);

  const preview = await controller.beginUtterance({ screenshot: true });
  const spec = surfaceFixture('vscode');

  assert.equal(preview.mode, 'context');
  assert.deepEqual(controller.preview(), preview, 'preview() exposes the development preview bundle');
  assert.equal(controller.status().phase, 'captured');
  assert.equal(controller.status().mode, 'context');

  const bundle = preview.bundle;
  assert.ok(bundle.target, 'bundle must carry the original target');
  if (bundle.target) {
    assert.equal(bundle.target.bundleId, spec.bundleId);
    assert.equal(bundle.target.pid, spec.pid);
    assert.equal(bundle.target.windowId, spec.windowId);
    assert.equal(bundle.target.displayId, spec.displayId);
    assert.equal(bundle.target.elementFingerprint, desktop.fingerprint('vscode').elementFingerprint);
    assert.deepEqual(bundle.target.bounds, spec.bounds);
    assert.equal(bundle.target.pixelScale, spec.pixelScale);
  }
  assert.equal(preview.target?.bundleId, spec.bundleId);
  assert.equal(bundle.snapshotId, 'snapshot-a01-1');
  assert.equal(bundle.capturedAtMs, CAPTURED_AT_MS);
  assert.equal(bundle.screenshotRef, fixture.screenshotArtifactRef, 'exactly one permitted screenshot');
  assert.equal(bundle.selectedText, fixture.permittedSelectedText);
  assert.ok(bundle.axNodes.length > 0, 'permitted AX nodes reach the bundle');
  assert.ok(
    bundle.axNodes.length <= capture.AX_CAPTURE_BUDGET.maxNodes,
    `AX subtree must stay within ${capture.AX_CAPTURE_BUDGET.maxNodes} nodes`,
  );
  assert.equal(bundle.truncated, true, 'a 620-node traversal must be reported as truncated');
  assert.ok(bundle.ocrSpans.some((span) => span.text === fixture.permittedOcrText), 'OCR spans reach the bundle');
  assert.equal(bundle.quality, 'full');

  assert.equal(desktop.captureRequests.length, 1, 'one utterance performs one capture');
  const request = desktop.captureRequests[0];
  assert.ok(request, 'capture request was recorded');
  if (request) {
    assert.equal(request.includeScreenshot, true);
    assert.deepEqual(request.axBudget, capture.AX_CAPTURE_BUDGET);
    assert.deepEqual(request.excludedBundleIds, fixture.excludedBundleIds);
    assert.deepEqual(request.target.fingerprint, desktop.fingerprint('vscode'));
  }
});

test('A01 inserts raw committed text literally into VS Code, TextEdit, and a browser field', async () => {
  const surfaces: ReadonlyArray<Readonly<{ key: string; method: 'accessibility' | 'clipboard' }>> = [
    { key: 'vscode', method: 'accessibility' },
    { key: 'textedit', method: 'accessibility' },
    { key: 'browser-field', method: 'clipboard' },
  ];

  for (const expectation of surfaces) {
    const desktop = new FakeDesktop(fixture);
    desktop.focus(expectation.key);
    const controller = createController(desktop);

    const preview = await controller.beginUtterance({ screenshot: true });
    assert.equal(preview.mode, 'context', `${expectation.key} captures context`);
    const draft = await controller.commitTranscript(RAW_COMMITTED_TEXT);
    assert.equal(draft.text, RAW_COMMITTED_TEXT);
    const surface = desktop.surface(expectation.key);
    assert.equal(surface.buffer, surface.spec.initialText, 'commit must not write into the editor');

    const result = await controller.insert();
    if (result.status !== 'inserted') {
      assert.fail(`insertion into ${expectation.key} failed: ${JSON.stringify(result)}`);
    }
    assert.equal(result.method, expectation.method);
    assert.equal(result.text, RAW_COMMITTED_TEXT);
    assert.equal(
      surface.buffer,
      surface.spec.initialText + RAW_COMMITTED_TEXT,
      `${expectation.key} receives the raw text exactly once, literally`,
    );
    assert.equal(surface.insertions.length, 1);
    assert.equal(desktop.captureRequests.length, 1, 'no re-capture during insertion');
    assert.equal(desktop.clipboardReads, expectation.method === 'clipboard' ? 1 : 0);
    assert.deepEqual(desktop.keyEvents, expectation.method === 'clipboard' ? ['command+v'] : []);
    assertNoSubmissionOrFocusTheft(desktop);
    assert.equal(controller.draft(), null);
    assert.equal(controller.status().phase, 'inserted');
  }
});

test('A01 preserves the draft instead of writing into a new target after a focus change', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('vscode');
  const controller = createController(desktop);

  await controller.beginUtterance({ screenshot: true });
  await controller.commitTranscript(RAW_COMMITTED_TEXT);

  const vscode = desktop.surface('vscode');
  const textedit = desktop.surface('textedit');
  desktop.focus('textedit');

  const result = await controller.insert();
  assert.equal(result.status, 'focus_changed');
  if (result.status === 'focus_changed') {
    assert.equal(result.draftPreserved, true);
  }
  assert.equal(vscode.buffer, vscode.spec.initialText, 'the stale target stays untouched');
  assert.equal(textedit.buffer, textedit.spec.initialText, 'the new target must not receive the draft');
  assert.equal(textedit.insertions.length, 0);
  assert.equal(
    desktop.calls.filter((call) => call.op === 'insertText').length,
    0,
    'no insertion is attempted against a stale fingerprint',
  );
  assert.deepEqual(controller.draft(), { text: RAW_COMMITTED_TEXT, target: desktop.fingerprint('vscode') });
  assert.equal(controller.status().phase, 'drafted');

  const retarget = await controller.retargetToCurrentFocus();
  assert.equal(retarget.status, 'retargeted');
  if (retarget.status === 'retargeted') {
    assert.deepEqual(retarget.target, desktop.fingerprint('textedit'));
  }
  const inserted = await controller.insert();
  assert.equal(inserted.status, 'inserted');
  assert.equal(textedit.buffer, textedit.spec.initialText + RAW_COMMITTED_TEXT);
  assert.equal(controller.draft(), null);
});

test('A01 keeps excluded and secure fields out of the context bundle', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('vscode');
  const controller = createController(desktop);

  const preview = await controller.beginUtterance({ screenshot: true });
  const serialized = JSON.stringify(preview.bundle);
  const markers = fixture.secretMarkers;

  assert.ok(!serialized.includes(markers.secureFieldValue), 'a secure field value reached the bundle');
  assert.ok(!serialized.includes(markers.excludedVaultText), 'excluded application text reached the bundle');
  assert.ok(!serialized.includes(markers.widgetDraftText), 'the widget itself reached the bundle');
  for (const bundleId of fixture.excludedBundleIds) {
    assert.ok(!serialized.includes(bundleId), `excluded bundle ${bundleId} reached the bundle`);
  }
  assert.equal(preview.bundle.redactions.secureNodes, 1);
  assert.ok(preview.bundle.redactions.excludedNodes >= 2, 'vault and widget nodes must be removed');
  assert.ok(preview.bundle.redactions.excludedSpans >= 1, 'excluded OCR spans must be removed');
  assert.ok(
    preview.bundle.axNodes.every((node) => !node.secure && node.role !== 'AXSecureTextField'),
    'no secure AX node may survive into the bundle',
  );
  assert.ok(
    preview.bundle.ocrSpans.every((span) => !fixture.excludedBundleIds.includes(span.bundleId)),
    'no OCR span from an excluded application may survive into the bundle',
  );
  assert.ok(JSON.stringify(preview.bundle).length > 0);
  const request = desktop.captureRequests[0];
  assert.ok(request, 'capture request was recorded');
  if (request) assert.deepEqual(request.excludedBundleIds, fixture.excludedBundleIds);
});

test('A01 never screenshots or quotes a secure focused field', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('secure-field');
  const controller = createController(desktop);

  const preview = await controller.beginUtterance();
  assert.equal(preview.mode, 'context');
  assert.equal(preview.bundle.screenshotRef, null, 'a secure field must not be screenshotted');
  assert.equal(preview.bundle.selectedText, null, 'a secure field must not contribute selected text');
  assert.ok(
    preview.bundle.axNodes.every((node) => !node.secure && node.role !== 'AXSecureTextField'),
    'a secure field must not contribute AX nodes',
  );
  assert.ok(!JSON.stringify(preview.bundle).includes(fixture.secretMarkers.secureFieldValue));
  const request = desktop.captureRequests[0];
  assert.ok(request, 'capture request was recorded');
  if (request) assert.equal(request.includeScreenshot, false);
});

test('A01 falls back to transcript-only mode on denied capture and still inserts safely', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('textedit');
  desktop.captureMode = 'denied';
  const controller = createController(desktop);

  const preview = await controller.beginUtterance({ screenshot: true });
  assert.equal(preview.mode, 'transcript_only');
  assert.equal(preview.bundle.screenshotRef, null);
  assert.equal(preview.bundle.selectedText, null);
  assert.deepEqual(preview.bundle.axNodes, []);
  assert.deepEqual(preview.bundle.ocrSpans, []);
  assert.equal(preview.bundle.quality, 'unavailable');
  assert.deepEqual(preview.bundle.redactions, { secureNodes: 0, excludedNodes: 0, excludedSpans: 0 });
  assert.equal(preview.target?.bundleId, 'com.apple.TextEdit', 'the fingerprint stays for safe revalidation');
  assert.equal(desktop.captureRequests.length, 1);

  await controller.commitTranscript(RAW_COMMITTED_TEXT);
  const result = await controller.insert();
  if (result.status !== 'inserted') {
    assert.fail(`transcript-only insertion failed: ${JSON.stringify(result)}`);
  }
  const surface = desktop.surface('textedit');
  assert.equal(surface.buffer, surface.spec.initialText + RAW_COMMITTED_TEXT);
  assert.deepEqual(desktop.keyEvents, []);
  assert.equal(desktop.clipboardReads, 0);
  assertNoSubmissionOrFocusTheft(desktop);
});

test('A01 restores the clipboard only when its change count proves no user change', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('browser-field');
  desktop.setUserClipboard(PRIOR_CLIPBOARD_TEXT);
  const controller = createController(desktop);

  const readsBefore = desktop.clipboardReads;
  const writesBefore = desktop.clipboardWrites;
  const changeCountBefore = desktop.currentClipboardChangeCount();

  await controller.beginUtterance({ screenshot: true });
  await controller.commitTranscript(RAW_COMMITTED_TEXT);
  const result = await controller.insert();
  if (result.status !== 'inserted') {
    assert.fail(`clipboard insertion failed: ${JSON.stringify(result)}`);
  }
  assert.equal(result.method, 'clipboard');
  assert.equal(desktop.surface('browser-field').buffer, RAW_COMMITTED_TEXT);
  assert.equal(desktop.clipboardReads, readsBefore + 1, 'the fallback reads the clipboard once');
  assert.equal(desktop.clipboardWrites, writesBefore + 2, 'one transactional write plus one restore');
  assert.equal(desktop.currentClipboardText(), PRIOR_CLIPBOARD_TEXT, 'the previous clipboard is restored');
  assert.equal(desktop.currentClipboardChangeCount(), changeCountBefore + 2);
  assert.deepEqual(desktop.keyEvents, ['command+v']);
  assertNoSubmissionOrFocusTheft(desktop);

  const interfered = new FakeDesktop(fixture);
  interfered.focus('browser-field');
  interfered.setUserClipboard(PRIOR_CLIPBOARD_TEXT);
  interfered.pasteInterference = INTERFERENCE_CLIPBOARD_TEXT;
  const interferedController = createController(interfered);
  const interferedWrites = interfered.clipboardWrites;

  await interferedController.beginUtterance({ screenshot: true });
  await interferedController.commitTranscript(RAW_COMMITTED_TEXT);
  const interferedResult = await interferedController.insert();
  if (interferedResult.status !== 'inserted') {
    assert.fail(`clipboard insertion failed: ${JSON.stringify(interferedResult)}`);
  }
  assert.equal(interfered.surface('browser-field').buffer, RAW_COMMITTED_TEXT);
  assert.equal(interfered.clipboardWrites, interferedWrites + 1, 'no restore overwrites the user change');
  assert.equal(
    interfered.currentClipboardText(),
    INTERFERENCE_CLIPBOARD_TEXT,
    'a user clipboard change survives the transaction',
  );
  assertNoSubmissionOrFocusTheft(interfered);
});

test('A01 undo restores the pre-insertion buffer and refuses a second undo', async () => {
  const desktop = new FakeDesktop(fixture);
  desktop.focus('vscode');
  const controller = createController(desktop);

  assert.equal((await controller.undo()).status, 'nothing_to_undo');
  await controller.beginUtterance({ screenshot: true });
  await controller.commitTranscript(RAW_COMMITTED_TEXT);
  const inserted = await controller.insert();
  assert.equal(inserted.status, 'inserted');

  const surface = desktop.surface('vscode');
  assert.equal(surface.buffer, surface.spec.initialText + RAW_COMMITTED_TEXT);

  const undone = await controller.undo();
  assert.equal(undone.status, 'undone');
  assert.equal(surface.buffer, surface.spec.initialText, 'undo must restore the pre-insertion buffer');
  assert.equal((await controller.undo()).status, 'nothing_to_undo');
  assert.equal(controller.status().phase, 'undone');
});
