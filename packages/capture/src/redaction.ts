/**
 * Bundle assembly and redaction for the A01 development preview.
 *
 * Everything here runs *after* the helper returns and *before* a bundle exists, because the helper
 * is a raw producer: it hands back secure fields, excluded applications and EchoPilot's own widget
 * content, and policy is what removes them (plan §5.4).
 */
import type {
  AXNode,
  CaptureSnapshot,
  CaptureTarget,
  CapturedAXNode,
  ContextBundle,
  OCRSpan,
} from './types.js';

/**
 * EchoPilot's own surfaces never enter a context bundle, configured list or not: dictating into
 * the widget must not capture the widget's own draft text back into the bundle.
 */
export const WIDGET_BUNDLE_IDS: ReadonlyArray<string> = ['com.echopilot.widget'];

export type BundlePolicy = Readonly<{
  /** Deduplicated exclusion list, in first-seen order; this is what the helper is asked for. */
  excludedBundleIds: ReadonlyArray<string>;
  isExcluded(bundleId: string): boolean;
}>;

/**
 * A role that is itself secure (for example `AXSecureTextField`) can never carry a value out.
 * The controller also uses this on the *focused* element, so a raw helper cannot unlock a secure
 * field by reporting `secure: false`.
 */
export function isSecureRole(role: string): boolean {
  return role.toLowerCase().includes('secure');
}

function normalize(bundleId: string): string {
  return bundleId.trim().toLowerCase();
}

/**
 * Lowercase and keep letters/digits only: OCR and AX text rarely agree on case, spacing or
 * punctuation for the same value (`synthetic-secure-unit-value` vs `Synthetic Secure Unit Value`).
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Secure values a raw helper may hand back twice: once as an AX node and once (unflagged) as OCR
 * text. OCR spans carry no secure bit of their own, so the values are collected here and matched
 * against every span.
 */
function redactedSecureTexts(nodes: ReadonlyArray<CapturedAXNode>): ReadonlyArray<string> {
  const values = new Set<string>();
  for (const node of nodes) {
    if (!node.secure && !isSecureRole(node.role)) continue;
    const value = normalizeText(node.value);
    if (!value) continue;
    values.add(value);
  }
  return [...values];
}

/** Shortest secure value worth matching as a substring: shorter ones would redact unrelated text. */
const MIN_ECHO_LENGTH = 4;

function echoesSecureText(text: string, secureTexts: ReadonlyArray<string>): boolean {
  if (secureTexts.length === 0) return false;
  const candidate = normalizeText(text);
  if (!candidate) return false;
  return secureTexts.some((secure) => candidate === secure
    || (secure.length >= MIN_ECHO_LENGTH && candidate.includes(secure)));
}

/**
 * Combines the configured exclusions with the always-excluded widget surfaces, keeping the first
 * occurrence of each bundle id so the request the helper receives is exactly the enforced policy.
 */
export function createBundlePolicy(configuredBundleIds: ReadonlyArray<string>): BundlePolicy {
  const excludedBundleIds: Array<string> = [];
  const keys = new Set<string>();
  for (const candidate of [...configuredBundleIds, ...WIDGET_BUNDLE_IDS]) {
    const key = normalize(candidate);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    excludedBundleIds.push(candidate);
  }
  return { excludedBundleIds, isExcluded: (bundleId: string) => keys.has(normalize(bundleId)) };
}

function mapTarget(target: CaptureTarget): ContextBundle['target'] {
  return {
    bundleId: target.fingerprint.bundleId,
    pid: target.fingerprint.pid,
    windowId: target.fingerprint.windowId,
    displayId: target.displayId,
    elementFingerprint: target.fingerprint.elementFingerprint,
    bounds: target.bounds,
    pixelScale: target.pixelScale,
  };
}

/**
 * Turns a raw snapshot into the preview bundle: permitted AX nodes only, bounded to the capture
 * budget, with counts recording what policy removed.
 *
 * A secure focused field never contributes a screenshot or quoted text, even when the helper
 * ignored `includeScreenshot: false` and returned one.
 */
export function assembleContextBundle(
  snapshot: CaptureSnapshot,
  policy: BundlePolicy,
  budget: Readonly<{ maxNodes: number; maxTraversalMs: number }>,
): ContextBundle {
  let secureNodes = 0;
  let excludedNodes = 0;
  let excludedSpans = 0;

  // A secure focus is the union of what the controller asked about and what the helper claims: a
  // raw helper that forgets `secure` (or fakes it) must not unlock the screenshot, the selection
  // or the OCR of a field the controller saw as secure.
  const secureFocus = snapshot.target.secure || isSecureRole(snapshot.target.role);
  // An excluded focused application is context we must not have at all. Even if a raw helper
  // returns a snapshot for that window anyway, nothing of it belongs in a bundle: not the target
  // metadata, not the selection, not the screenshot, not the AX subtree, not the OCR text
  // (plan §5.4: "post-capture blur alone is insufficient for an excluded app").
  const excludedFocus = policy.isExcluded(snapshot.target.fingerprint.bundleId);

  const permittedNodes: Array<AXNode> = [];
  for (const node of snapshot.axNodes) {
    const nodeIsSecure = node.secure || isSecureRole(node.role);
    if (excludedFocus || policy.isExcluded(node.bundleId) || nodeIsSecure) {
      if (nodeIsSecure) secureNodes += 1;
      else excludedNodes += 1;
      continue;
    }
    permittedNodes.push({
      nodeId: node.nodeId,
      role: node.role,
      value: node.value,
      secure: false,
      bounds: node.bounds,
    });
  }

  const secureTexts = redactedSecureTexts(snapshot.axNodes);
  const ocrSpans: Array<OCRSpan> = [];
  for (const span of snapshot.ocrSpans) {
    // OCR has no secure flag, so a secure focused field taints every span from that capture, and a
    // span that repeats a value redaction already removed is removed with it.
    if (excludedFocus || secureFocus || policy.isExcluded(span.bundleId) || echoesSecureText(span.text, secureTexts)) {
      excludedSpans += 1;
      continue;
    }
    ocrSpans.push({ text: span.text, bundleId: span.bundleId, bounds: span.bounds });
  }

  return {
    snapshotId: snapshot.snapshotId,
    capturedAtMs: snapshot.capturedAtMs,
    target: excludedFocus ? null : mapTarget(snapshot.target),
    selectedText: secureFocus || excludedFocus ? null : snapshot.selectedText,
    screenshotRef: secureFocus || excludedFocus ? null : snapshot.screenshotRef,
    axNodes: permittedNodes.slice(0, budget.maxNodes),
    ocrSpans,
    quality: excludedFocus ? 'unavailable' : snapshot.quality,
    // `truncated` reports the traversal, not the post-redaction list: 620 raw nodes are 620 raw
    // nodes even after policy removes three of them.
    truncated: excludedFocus ? false : snapshot.truncated || snapshot.axNodes.length > budget.maxNodes,
    redactions: { secureNodes, excludedNodes, excludedSpans },
  };
}

/**
 * Transcript-only mode: capture was denied (or there is no focused target at all), so the bundle
 * carries no context. The committed transcript still reaches the target, and the fingerprint the
 * preview keeps is what `insert()` revalidates before writing.
 */
export function transcriptOnlyBundle(utterance: number, capturedAtMs: number): ContextBundle {
  return {
    snapshotId: `transcript-only-${utterance}`,
    capturedAtMs,
    target: null,
    selectedText: null,
    screenshotRef: null,
    axNodes: [],
    ocrSpans: [],
    quality: 'unavailable',
    truncated: false,
    redactions: { secureNodes: 0, excludedNodes: 0, excludedSpans: 0 },
  };
}

export function sameFingerprint(left: CaptureTarget['fingerprint'], right: CaptureTarget['fingerprint']): boolean {
  return left.bundleId === right.bundleId
    && left.pid === right.pid
    && left.windowId === right.windowId
    && left.elementFingerprint === right.elementFingerprint;
}
