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

/** A role that is itself secure (for example `AXSecureTextField`) can never carry a value out. */
function isSecureRole(role: string): boolean {
  return role.toLowerCase().includes('secure');
}

function normalize(bundleId: string): string {
  return bundleId.trim().toLowerCase();
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

  const permittedNodes: Array<AXNode> = [];
  for (const node of snapshot.axNodes) {
    if (policy.isExcluded(node.bundleId)) {
      excludedNodes += 1;
      continue;
    }
    if (node.secure || isSecureRole(node.role)) {
      secureNodes += 1;
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

  const ocrSpans: Array<OCRSpan> = [];
  for (const span of snapshot.ocrSpans) {
    if (policy.isExcluded(span.bundleId)) {
      excludedSpans += 1;
      continue;
    }
    ocrSpans.push({ text: span.text, bundleId: span.bundleId, bounds: span.bounds });
  }

  const secureFocus = snapshot.target.secure;
  return {
    snapshotId: snapshot.snapshotId,
    capturedAtMs: snapshot.capturedAtMs,
    target: mapTarget(snapshot.target),
    selectedText: secureFocus ? null : snapshot.selectedText,
    screenshotRef: secureFocus ? null : snapshot.screenshotRef,
    axNodes: permittedNodes.slice(0, budget.maxNodes),
    ocrSpans,
    quality: snapshot.quality,
    // `truncated` reports the traversal, not the post-redaction list: 620 raw nodes are 620 raw
    // nodes even after policy removes three of them.
    truncated: snapshot.truncated || snapshot.axNodes.length > budget.maxNodes,
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
