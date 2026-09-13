/**
 * Focused unit checks for the A01 controller branches the frozen oracle does not drive: the
 * no-target utterance, the misuse guard on committing without a target, the defensive redaction of
 * a screenshot/selection the helper should not have produced, non-editable focus, and starting a
 * second utterance while a draft is still pending.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AX_CAPTURE_BUDGET,
  assembleContextBundle,
  createBundlePolicy,
  createDictationController,
} from '../src/index.js';
import type {
  CaptureBridge,
  CaptureOutcome,
  CaptureRequest,
  CaptureSnapshot,
  CaptureTarget,
  InsertOutcome,
  InsertRequest,
  UndoOutcome,
} from '../src/index.js';

const RAW_TEXT = 'ship the tracer bullet\nsecond line';
const VAULT_BUNDLE_ID = 'com.1password.1password';
const WIDGET_BUNDLE_ID = 'com.echopilot.widget';
const VAULT_SELECTION = 'synthetic-vault-master-password';
const VAULT_NODE_TEXT = 'synthetic-vault-note';
const VAULT_SCREENSHOT = 'artifact://unit/vault-window@2x.png';

const BOUNDS = { x: 0, y: 0, width: 10, height: 10 } as const;

/** A raw snapshot for `state`: the helper hands back everything, policy decides what survives. */
function snapshotFor(state: CaptureTarget, overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return {
    snapshotId: 'unit-snapshot',
    capturedAtMs: 1_700_000_000_000,
    target: state,
    screenshotRef: null,
    selectedText: null,
    axNodes: [],
    ocrSpans: [],
    quality: 'full',
    truncated: false,
    ...overrides,
  };
}

function nodeFor(bundleId: string, value: string, overrides: Partial<CaptureSnapshot['axNodes'][number]> = {}) {
  return {
    nodeId: `ax-${bundleId}`,
    bundleId,
    role: 'AXStaticText',
    value,
    secure: false,
    bounds: BOUNDS,
    ...overrides,
  };
}

function target(overrides: Partial<CaptureTarget> = {}): CaptureTarget {
  return {
    fingerprint: {
      bundleId: 'com.apple.TextEdit',
      pid: 4202,
      windowId: 77,
      elementFingerprint: 'textedit:4202:77:0',
    },
    displayId: 1,
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    pixelScale: 2,
    role: 'AXTextArea',
    secure: false,
    editable: true,
    ...overrides,
  };
}

class TestBridge implements CaptureBridge {
  focused: CaptureTarget | null = target();
  captureOutcome: CaptureOutcome = {
    status: 'captured',
    snapshot: {
      snapshotId: 'unit-snapshot',
      capturedAtMs: 1_700_000_000_000,
      target: target(),
      screenshotRef: null,
      selectedText: null,
      axNodes: [],
      ocrSpans: [],
      quality: 'full',
      truncated: false,
    },
  };
  insertOutcome: 'inserted' | 'unsupported' | 'target_mismatch' = 'inserted';
  clipboardText = 'previous clipboard';
  clipboardChangeCount = 1;
  readonly captureRequests: Array<CaptureRequest> = [];
  readonly insertRequests: Array<InsertRequest> = [];
  readonly undoRequests: Array<string> = [];
  readonly keyEvents: Array<string> = [];
  readonly activations: Array<string> = [];
  clipboardReads = 0;

  readonly clipboard = {
    changeCount: (): number => this.clipboardChangeCount,
    readText: (): string => {
      this.clipboardReads += 1;
      return this.clipboardText;
    },
    writeText: (text: string): void => {
      this.clipboardText = text;
      this.clipboardChangeCount += 1;
    },
  };

  async currentTarget(): Promise<CaptureTarget | null> {
    return this.focused;
  }

  async captureContext(request: CaptureRequest): Promise<CaptureOutcome> {
    this.captureRequests.push(request);
    return this.captureOutcome;
  }

  async insertText(request: InsertRequest): Promise<InsertOutcome> {
    this.insertRequests.push(request);
    if (this.insertOutcome === 'inserted') {
      return { status: 'inserted', transactionId: request.transactionId, method: 'accessibility' };
    }
    if (this.insertOutcome === 'target_mismatch') {
      return { status: 'target_mismatch', transactionId: request.transactionId, reason: 'moved' };
    }
    return { status: 'unsupported', transactionId: request.transactionId, reason: 'ax_insert_unsupported' };
  }

  async undo(request: Readonly<{ transactionId: string }>): Promise<UndoOutcome> {
    this.undoRequests.push(request.transactionId);
    return { status: 'undone', transactionId: request.transactionId };
  }

  async sendKey(key: string): Promise<void> {
    this.keyEvents.push(key);
  }

  async activateApplication(bundleId: string): Promise<void> {
    this.activations.push(bundleId);
  }
}

function controllerFor(bridge: TestBridge) {
  return createDictationController({ bridge, excludedBundleIds: ['com.1password.1password'] });
}

test('insert() without a committed transcript is a no-op', async () => {
  const bridge = new TestBridge();
  const controller = controllerFor(bridge);

  assert.deepEqual(await controller.insert(), { status: 'nothing_to_insert' });
  assert.deepEqual(await controller.undo(), { status: 'nothing_to_undo' });
  assert.equal(controller.draft(), null);
  assert.deepEqual(controller.status(), { phase: 'idle', mode: null });
  assert.equal(bridge.insertRequests.length, 0);
  assert.equal(bridge.clipboardReads, 0);
  assert.deepEqual(bridge.keyEvents, []);
  assert.deepEqual(bridge.activations, []);
});

test('an utterance with no focused target is transcript-only and cannot be committed blindly', async () => {
  const bridge = new TestBridge();
  bridge.focused = null;
  const controller = controllerFor(bridge);

  const preview = await controller.beginUtterance();
  assert.equal(preview.mode, 'transcript_only');
  assert.equal(preview.target, null);
  assert.equal(preview.bundle.quality, 'unavailable');
  assert.equal(preview.bundle.target, null);
  assert.deepEqual(preview.bundle.axNodes, []);
  assert.deepEqual(preview.bundle.redactions, { secureNodes: 0, excludedNodes: 0, excludedSpans: 0 });
  assert.equal(bridge.captureRequests.length, 0, 'no snapshot is attempted without a target');
  assert.deepEqual(controller.status(), { phase: 'captured', mode: 'transcript_only' });

  await assert.rejects(() => controller.commitTranscript(RAW_TEXT), /target fingerprint/);
  assert.deepEqual(await controller.retargetToCurrentFocus(), { status: 'no_target' });

  // Once the user focuses a field, the explicit retarget is what lets a new utterance insert.
  bridge.focused = target();
  const next = await controller.beginUtterance({ screenshot: false });
  assert.equal(next.mode, 'context');
  assert.equal(bridge.captureRequests.length, 1);
  assert.equal(bridge.captureRequests[0]?.includeScreenshot, false);
  assert.deepEqual(bridge.captureRequests[0]?.axBudget, AX_CAPTURE_BUDGET);
  await controller.commitTranscript(RAW_TEXT);
  assert.equal((await controller.insert()).status, 'inserted');
  assert.deepEqual(bridge.insertRequests[0]?.submit, false);
});

test('a secure focused field keeps its screenshot and selection out of the bundle defensively', async () => {
  const secure = target({ secure: true, role: 'AXSecureTextField' });
  const bridge = new TestBridge();
  bridge.focused = secure;
  // A helper that ignored the policy and handed back the raw secure artifacts anyway.
  bridge.captureOutcome = {
    status: 'captured',
    snapshot: {
      snapshotId: 'unit-secure',
      capturedAtMs: 1_700_000_000_001,
      target: secure,
      screenshotRef: 'artifact://unit/secure-window@2x.png',
      selectedText: 'synthetic-secure-unit-value',
      axNodes: [
        {
          nodeId: 'ax-permitted',
          bundleId: 'com.apple.TextEdit',
          role: 'AXStaticText',
          value: 'permitted',
          secure: false,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
        },
        {
          nodeId: 'ax-secure',
          bundleId: 'com.apple.TextEdit',
          role: 'AXSecureTextField',
          value: 'synthetic-secure-unit-value',
          secure: true,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
        },
      ],
      ocrSpans: [],
      quality: 'full',
      truncated: false,
    },
  };
  const controller = controllerFor(bridge);

  const preview = await controller.beginUtterance({ screenshot: true });
  assert.equal(bridge.captureRequests[0]?.includeScreenshot, false);
  assert.equal(preview.bundle.screenshotRef, null);
  assert.equal(preview.bundle.selectedText, null);
  assert.deepEqual(preview.bundle.redactions, { secureNodes: 1, excludedNodes: 0, excludedSpans: 0 });
  assert.ok(!JSON.stringify(preview.bundle).includes('synthetic-secure-unit-value'));
  assert.deepEqual(preview.bundle.axNodes.map((node) => node.nodeId), ['ax-permitted']);
});

test('focus on a non-editable element preserves the draft instead of writing into it', async () => {
  const bridge = new TestBridge();
  const controller = controllerFor(bridge);

  await controller.beginUtterance();
  const committed = await controller.commitTranscript(RAW_TEXT);
  bridge.focused = target({ editable: false, role: 'AXGroup' });

  const result = await controller.insert();
  assert.deepEqual(result, { status: 'focus_changed', draftPreserved: true });
  assert.equal(bridge.insertRequests.length, 0, 'a non-editable focus is never written into');
  assert.deepEqual(controller.draft(), committed);
  assert.deepEqual(controller.status(), { phase: 'drafted', mode: 'context' });
});

test('a target_mismatch from the helper preserves the draft and writes nowhere', async () => {
  const bridge = new TestBridge();
  bridge.insertOutcome = 'target_mismatch';
  const controller = controllerFor(bridge);

  await controller.beginUtterance();
  await controller.commitTranscript(RAW_TEXT);

  assert.deepEqual(await controller.insert(), { status: 'focus_changed', draftPreserved: true });
  assert.equal(controller.draft()?.text, RAW_TEXT);
  assert.equal(bridge.clipboardReads, 0, 'a mismatch must not fall through to the clipboard');
  assert.deepEqual(bridge.keyEvents, []);
});

test('beginning a new utterance drops the previous draft and captures exactly once more', async () => {
  const bridge = new TestBridge();
  const controller = controllerFor(bridge);

  await controller.beginUtterance();
  await controller.commitTranscript(RAW_TEXT);
  assert.ok(controller.draft());

  await controller.beginUtterance({ screenshot: false });
  assert.equal(controller.draft(), null, 'a fresh utterance never carries the old transcript');
  assert.equal(bridge.captureRequests.length, 2);
  assert.deepEqual(await controller.insert(), { status: 'nothing_to_insert' });
  assert.equal(bridge.insertRequests.length, 0);
});

test('an excluded focused application is never captured, and its content never reaches a bundle', async () => {
  const vault = target({
    fingerprint: {
      bundleId: VAULT_BUNDLE_ID,
      pid: 9001,
      windowId: 12,
      elementFingerprint: 'vault:9001:12:0',
    },
    role: 'AXTextField',
  });
  const bridge = new TestBridge();
  bridge.focused = vault;
  // A raw helper that ignored the exclusion list and would hand the vault window back anyway.
  bridge.captureOutcome = {
    status: 'captured',
    snapshot: snapshotFor(vault, {
      screenshotRef: VAULT_SCREENSHOT,
      selectedText: VAULT_SELECTION,
      axNodes: [
        nodeFor(VAULT_BUNDLE_ID, VAULT_NODE_TEXT),
        nodeFor(WIDGET_BUNDLE_ID, 'synthetic-widget-draft'),
      ],
      ocrSpans: [{ text: VAULT_SELECTION, bundleId: VAULT_BUNDLE_ID, bounds: BOUNDS }],
    }),
  };
  const controller = controllerFor(bridge);

  const preview = await controller.beginUtterance({ screenshot: true });
  assert.equal(preview.mode, 'transcript_only');
  assert.equal(bridge.captureRequests.length, 0, 'an excluded application is never captured at all');

  const serialized = JSON.stringify(preview.bundle);
  assert.ok(!serialized.includes(VAULT_BUNDLE_ID), 'the excluded bundle id reached the bundle');
  assert.ok(!serialized.includes(VAULT_SELECTION), 'excluded selected text reached the bundle');
  assert.ok(!serialized.includes(VAULT_NODE_TEXT), 'excluded AX text reached the bundle');
  assert.ok(!serialized.includes(VAULT_SCREENSHOT), 'a screenshot of an excluded window reached the bundle');
  assert.equal(preview.bundle.target, null);
  assert.equal(preview.bundle.selectedText, null);
  assert.equal(preview.bundle.screenshotRef, null);
  assert.deepEqual(preview.bundle.axNodes, []);
  assert.deepEqual(preview.bundle.ocrSpans, []);
  assert.equal(preview.bundle.quality, 'unavailable');
  assert.deepEqual(preview.target, vault.fingerprint, 'the destination fingerprint stays for revalidation');

  // Dictation still lands in the excluded application: only its context is off limits.
  await controller.commitTranscript(RAW_TEXT);
  assert.equal((await controller.insert()).status, 'inserted');
  assert.deepEqual(bridge.insertRequests[0]?.targetFingerprint, vault.fingerprint);
  assert.equal(bridge.insertRequests[0]?.submit, false);
});

test('the always-excluded widget is never captured even when the configured list is empty', async () => {
  const widget = target({
    fingerprint: { bundleId: WIDGET_BUNDLE_ID, pid: 9002, windowId: 13, elementFingerprint: 'widget:9002:13:0' },
  });
  const bridge = new TestBridge();
  bridge.focused = widget;
  const controller = createDictationController({ bridge, excludedBundleIds: [] });

  const preview = await controller.beginUtterance({ screenshot: true });
  assert.equal(preview.mode, 'transcript_only');
  assert.equal(bridge.captureRequests.length, 0);
  assert.ok(!JSON.stringify(preview.bundle).includes(WIDGET_BUNDLE_ID));
  assert.deepEqual(preview.target, widget.fingerprint);
});

test('assembleContextBundle drops target, selection, screenshot, nodes and spans for an excluded focus', () => {
  const vault = target({
    fingerprint: { bundleId: VAULT_BUNDLE_ID, pid: 9001, windowId: 12, elementFingerprint: 'vault:9001:12:0' },
  });
  const bundle = assembleContextBundle(
    snapshotFor(vault, {
      screenshotRef: VAULT_SCREENSHOT,
      selectedText: VAULT_SELECTION,
      axNodes: [nodeFor(VAULT_BUNDLE_ID, VAULT_NODE_TEXT), nodeFor(WIDGET_BUNDLE_ID, 'synthetic-widget-draft')],
      ocrSpans: [{ text: VAULT_SELECTION, bundleId: VAULT_BUNDLE_ID, bounds: BOUNDS }],
    }),
    createBundlePolicy([VAULT_BUNDLE_ID]),
    AX_CAPTURE_BUDGET,
  );

  assert.equal(bundle.target, null);
  assert.equal(bundle.selectedText, null);
  assert.equal(bundle.screenshotRef, null);
  assert.deepEqual(bundle.axNodes, []);
  assert.deepEqual(bundle.ocrSpans, []);
  assert.equal(bundle.quality, 'unavailable');
  assert.equal(bundle.truncated, false);
  assert.ok(!JSON.stringify(bundle).includes(VAULT_BUNDLE_ID));
  assert.ok(!JSON.stringify(bundle).includes(VAULT_SELECTION));
});

test('OCR spans that only exist to restate a secure field never reach the bundle', async () => {
  const secure = target({ secure: true, role: 'AXSecureTextField' });
  const secureFocus = new TestBridge();
  secureFocus.focused = secure;
  // A raw helper answering a secure-field capture with the field's value as OCR text.
  secureFocus.captureOutcome = {
    status: 'captured',
    snapshot: snapshotFor(secure, {
      axNodes: [
        nodeFor('com.apple.Safari', 'synthetic-secure-unit-value', { role: 'AXSecureTextField', secure: true }),
      ],
      ocrSpans: [{ text: 'synthetic-secure-unit-value', bundleId: 'com.apple.Safari', bounds: BOUNDS }],
    }),
  };
  const securePreview = await controllerFor(secureFocus).beginUtterance({ screenshot: true });
  assert.deepEqual(securePreview.bundle.ocrSpans, [], 'a secure focus contributes no OCR spans');
  assert.equal(securePreview.bundle.redactions.excludedSpans, 1);
  assert.ok(!JSON.stringify(securePreview.bundle).includes('synthetic-secure-unit-value'));

  // Focused field is not itself secure, but the raw helper echoes a secure node's value as OCR.
  const mixed = new TestBridge();
  mixed.captureOutcome = {
    status: 'captured',
    snapshot: snapshotFor(target(), {
      axNodes: [
        nodeFor('com.apple.TextEdit', 'permitted value'),
        nodeFor('com.apple.TextEdit', 'synthetic-secure-unit-value', { role: 'AXSecureTextField', secure: true }),
      ],
      ocrSpans: [
        { text: 'permitted OCR line', bundleId: 'com.apple.TextEdit', bounds: BOUNDS },
        { text: 'synthetic-secure-unit-value', bundleId: 'com.apple.TextEdit', bounds: BOUNDS },
      ],
    }),
  };
  const mixedPreview = await controllerFor(mixed).beginUtterance({ screenshot: true });
  assert.deepEqual(mixedPreview.bundle.ocrSpans.map((span) => span.text), ['permitted OCR line']);
  assert.equal(mixedPreview.bundle.redactions.excludedSpans, 1);
  assert.ok(!JSON.stringify(mixedPreview.bundle).includes('synthetic-secure-unit-value'));
});

test('a secure role stays secure when the raw helper reports secure: false for the focused target', async () => {
  const lying = target({ secure: false, role: 'AXSecureTextField' });
  const bridge = new TestBridge();
  bridge.focused = lying;
  // The helper contradicts the focused element: it says "not secure" but hands back the value.
  const raw: CaptureSnapshot = snapshotFor(lying, {
    screenshotRef: 'artifact://unit/secure-window@2x.png',
    selectedText: 'synthetic-secure-unit-value',
    axNodes: [
      nodeFor('com.apple.Safari', 'permitted sibling', { role: 'AXStaticText' }),
      nodeFor('com.apple.Safari', 'synthetic-secure-unit-value', { role: 'AXSecureTextField', secure: true }),
    ],
    ocrSpans: [
      { text: 'permitted sibling', bundleId: 'com.apple.Safari', bounds: BOUNDS },
      { text: 'synthetic-secure-unit-value', bundleId: 'com.apple.Safari', bounds: BOUNDS },
    ],
  });
  bridge.captureOutcome = { status: 'captured', snapshot: raw };

  const preview = await controllerFor(bridge).beginUtterance({ screenshot: true });
  assert.equal(bridge.captureRequests[0]?.includeScreenshot, false, 'a secure role is never screenshotted');
  assert.equal(preview.bundle.screenshotRef, null);
  assert.equal(preview.bundle.selectedText, null);
  // A secure focus taints the whole OCR pass: spans cannot be attributed back to their field.
  assert.deepEqual(preview.bundle.ocrSpans, []);
  assert.deepEqual(preview.bundle.axNodes.map((node) => node.nodeId), ['ax-com.apple.Safari']);
  assert.ok(!JSON.stringify(preview.bundle).includes('synthetic-secure-unit-value'));

  // The redaction layer holds the same line even when it is called with the raw snapshot directly.
  const bundle = assembleContextBundle(raw, createBundlePolicy([]), AX_CAPTURE_BUDGET);
  assert.equal(bundle.selectedText, null);
  assert.equal(bundle.screenshotRef, null);
  assert.deepEqual(bundle.ocrSpans, []);
});

test('OCR echo matching ignores case and spacing, and leaves short unrelated spans alone', async () => {
  const echoed: CaptureSnapshot = snapshotFor(target(), {
    axNodes: [
      nodeFor('com.apple.TextEdit', 'Synthetic-Secure-Unit-Value', {
        role: 'AXSecureTextField',
        secure: true,
      }),
    ],
    ocrSpans: [
      { text: 'synthetic secure unit value', bundleId: 'com.apple.TextEdit', bounds: BOUNDS },
      { text: 'SYNTHETIC-SECURE-UNIT-VALUE', bundleId: 'com.apple.TextEdit', bounds: BOUNDS },
      { text: 'permitted OCR line', bundleId: 'com.apple.TextEdit', bounds: BOUNDS },
    ],
  });

  // The raw producer path: the helper reflects a secure node's value back as OCR text.
  const bridge = new TestBridge();
  bridge.captureOutcome = { status: 'captured', snapshot: echoed };
  const preview = await controllerFor(bridge).beginUtterance({ screenshot: false });
  assert.equal(preview.mode, 'context');
  assert.deepEqual(preview.bundle.ocrSpans.map((span) => span.text), ['permitted OCR line']);
  assert.ok(!JSON.stringify(preview.bundle).includes('synthetic secure unit value'));

  const bundle = assembleContextBundle(echoed, createBundlePolicy([]), AX_CAPTURE_BUDGET);
  assert.deepEqual(bundle.ocrSpans.map((span) => span.text), ['permitted OCR line']);
  assert.equal(bundle.redactions.excludedSpans, 2);
  assert.equal(bundle.redactions.secureNodes, 1);
});
