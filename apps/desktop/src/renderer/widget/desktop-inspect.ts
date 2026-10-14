/**
 * Widget-side desktop inspect seam (C05 renderer half).
 *
 * The widget's one-click "Inspect window" action resolves an explicit active Work project and
 * issues exactly one same-origin `POST desktop-observe` with that project id. The route returns
 * the bounded, read-only `ForegroundEvidence` the native observer already capped; this module
 * revalidates it field by field (the renderer never trusts a route to keep a shape) and reduces it
 * to a small, human-readable preview of real AX labels and values with preview evidence ids.
 *
 * What this module owns and what it refuses:
 *
 *   - Project scope: the selection persisted in same-origin local UI state wins; otherwise exactly
 *     one active project may be used. Zero or several active projects without a valid selection is
 *     a visible instruction to choose one in Work — never a guessed scope from a window title.
 *   - Honesty: denial, missing-helper, timeout, and malformed answers keep their distinct states.
 *     Nothing upgrades a partial snapshot or invents screen state.
 *   - Locality: the preview lives only in component state. Raw evidence is never persisted, never
 *     spoken (`spoken: false`), and never sent anywhere.
 */
import type {
  ForegroundEvidence as NativeForegroundEvidence,
  ForegroundEvidenceNode,
} from '../../main/desktop-observe.js';

export const DESKTOP_INSPECT_PROJECT_KEY = 'echopilot.desktopObserve.projectId';

/** The exact disclosure the widget must keep visible next to any preview. */
export const DESKTOP_PREVIEW_LABEL = 'local Accessibility preview — no AI answer or screenshot';

/** How many evidence rows one preview renders; the rest stay in the bounded snapshot, unshown. */
export const DESKTOP_PREVIEW_MAX_ROWS = 24;
/** Display-only clip for one label or value; longer strings are visibly clipped. */
export const DESKTOP_PREVIEW_MAX_TEXT = 200;

const MAX_NODES = 256;
const MAX_ROLE_BYTES = 256;
const MAX_NODE_STRING_BYTES = 4_096;
const MAX_WINDOW_TITLE_BYTES = 2_048;
const MAX_APPLICATION_FIELD_BYTES = 1_024;
const MAX_PROJECT_ID_BYTES = 256;
const MAX_DETAIL_CHARS = 160;
const MAX_TRUNCATIONS = 16;
const MAX_SESSIONS = 64;

export const DESKTOP_DENIAL_CODES = [
  'accessibility_denied',
  'excluded_application',
  'no_window',
  'empty_evidence',
] as const;
export type DesktopDenialCode = (typeof DESKTOP_DENIAL_CODES)[number];

export const DESKTOP_FAILURE_REASONS = [
  'helper_missing',
  'timeout',
  'response_too_large',
  'malformed_response',
  'crashed',
  'native_error',
  'invalid_scope',
] as const;
export type DesktopFailureReason = (typeof DESKTOP_FAILURE_REASONS)[number];

export type DesktopErrorReason = DesktopFailureReason | 'work_status_unavailable' | 'transport';

/** One active Work session as this surface needs it; every other field is ignored. */
export type WorkSessionSummary = Readonly<{
  id: string;
  projectId: string;
  label: string;
  active: boolean;
}>;

export type ActiveProjectResolution =
  | Readonly<{ kind: 'resolved'; projectId: string; label: string; source: 'selection' | 'single_active' }>
  | Readonly<{ kind: 'no_active_project' }>
  | Readonly<{ kind: 'choose_project'; activeProjects: number; options: readonly DesktopProjectOption[] }>;

export type DesktopProjectOption = Readonly<{ projectId: string; label: string }>;

/** The renderer's own strict reader of the route's evidence; mirrors the main-process bounds. */
export type DesktopEvidence = NativeForegroundEvidence;

export type DesktopPreviewRow = Readonly<{
  /** A stable id for this preview row: the node's index in the bounded snapshot. */
  evidenceId: string;
  depth: number;
  role: string;
  label: string | null;
  value: string | null;
  /** True when the native snapshot clipped this node, or this preview clipped its text. */
  truncated: boolean;
  redacted: boolean;
}>;

export type DesktopEvidencePreview = Readonly<{
  application: Readonly<{ name: string; bundleId: string; pid: number; identityTruncated: boolean }>;
  window: Readonly<{ title: string; role: string; titleTruncated: boolean }>;
  rows: readonly DesktopPreviewRow[];
  omittedRows: number;
  quality: 'full' | 'partial';
  truncated: boolean;
  truncations: readonly string[];
  visitedNodes: number;
  emittedNodes: number;
  label: string;
  spoken: false;
}>;

export type DesktopInspectState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'preview';
      projectId: string;
      projectLabel: string;
      observedAtMs: number;
      preview: DesktopEvidencePreview;
    }>
  | Readonly<{
      kind: 'limited';
      projectId: string;
      projectLabel: string;
      code: DesktopDenialCode;
      detail: string | null;
    }>
  | Readonly<{ kind: 'blocked'; activeProjects: number; options: readonly DesktopProjectOption[] }>
  | Readonly<{ kind: 'error'; reason: DesktopErrorReason; message: string; projectLabel: string | null }>;

export type DesktopScopeState =
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'ready'; projectId: string; label: string; source: 'selection' | 'single_active' }>
  | Readonly<{ kind: 'blocked'; activeProjects: number; options: readonly DesktopProjectOption[] }>
  | Readonly<{ kind: 'unavailable' }>;

export type DesktopInspectTransport = Readonly<{
  loadWorkSessions(): Promise<readonly WorkSessionSummary[]>;
  /** Resolves with the parsed response body; rejects only when the route itself did not answer. */
  postObserve(projectId: string): Promise<unknown>;
}>;

export type DesktopInspectClient = Readonly<{
  /** Loads Work sessions and resolves them against the remembered selection, without observing. */
  loadScope(): Promise<DesktopScopeState>;
  /** One observation per call; returns null while an observation is already in flight. */
  inspect(): Promise<DesktopInspectState | null>;
}>;

/** Honest, bounded copy for each denial the native observer can report. */
export const DESKTOP_DENIAL_COPY: Readonly<Record<DesktopDenialCode, string>> = {
  accessibility_denied:
    'macOS Accessibility access is not granted to EchoPilot, so the focused window could not be read. Grant it in System Settings → Privacy & Security → Accessibility.',
  excluded_application:
    'The frontmost application is excluded from observation, so nothing was read.',
  no_window:
    'No focused window was available to read. Bring the window you want to inspect to the front, then inspect again.',
  empty_evidence:
    'The focused window held no readable Accessibility labels or values. This is a limited result, not an invented one.',
};

/** Honest copy for each failure the host can report; none of these carries evidence. */
export const DESKTOP_FAILURE_COPY: Readonly<Record<DesktopErrorReason, string>> = {
  helper_missing:
    'The desktop observation helper is missing from this build. Run pnpm dev to build and sign dist/native/echopilot-desktop, then try again.',
  timeout: 'The observation timed out before the helper answered. Nothing was read.',
  response_too_large: 'The helper returned more data than the host accepts, so nothing is shown.',
  malformed_response: 'The helper returned a response the widget could not trust, so nothing is shown.',
  crashed: 'The observation helper exited before answering. Nothing was read.',
  native_error: 'The observation failed inside the helper. Nothing is shown.',
  invalid_scope: 'The project scope was rejected, so no observation ran.',
  work_status_unavailable:
    'Work session status is unavailable, so no active project can be confirmed and nothing was observed.',
  transport: 'The desktop observation route did not answer, so nothing was read.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Non-empty after trimming, at most 256 UTF-8 bytes — the same identity rule the host enforces. */
export function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || utf8Bytes(trimmed) > MAX_PROJECT_ID_BYTES) return null;
  return trimmed;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || utf8Bytes(value) > maxBytes) return null;
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, maxBytes: number): string | null | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return null;
  const value = boundedString(raw, maxBytes);
  return value === null ? undefined : value;
}

function flag(record: Record<string, unknown>, key: string): boolean | null {
  return typeof record[key] === 'boolean' ? record[key] as boolean : null;
}

function count(record: Record<string, unknown>, key: string, min = 0): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null;
}

/** A denial or failure detail is category evidence, not content: control characters removed, bounded. */
export function sanitizeDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_DETAIL_CHARS) : null;
}

/** Strict reader for the Work session rows: unknown fields are dropped, malformed rows rejected. */
export function parseWorkSessions(value: unknown): readonly WorkSessionSummary[] {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) {
    throw new TypeError('Invalid work session response');
  }
  // Production now reports the main host's explicit folder association independently of any CLI.
  // Its exact selection overrides local stale preferences and prevents guessed multi-session scope.
  if ('selectedProject' in value) {
    if (value.selectedProject === null) return [];
    const selected = value.selectedProject;
    if (!isRecord(selected)) throw new TypeError('Invalid selected project association');
    const projectId = normalizeProjectId(selected.projectId); const label = boundedString(selected.label, 512);
    if (!projectId || label === null) throw new TypeError('Invalid selected project association');
    return [{ id: `associated:${projectId}`, projectId, label, active: true }];
  }
  return value.sessions.map((row) => {
    if (!isRecord(row)) throw new TypeError('Invalid work session row');
    const id = boundedString(row.id, 256);
    const projectId = normalizeProjectId(row.projectId);
    const label = boundedString(row.label, 512);
    if (id === null || id.trim().length === 0 || projectId === null || label === null
      || typeof row.active !== 'boolean') {
      throw new TypeError('Invalid work session row');
    }
    return { id, projectId, label, active: row.active };
  });
}

/** Prefers the remembered selection; otherwise only an unambiguous single active project is used. */
export function resolveActiveProject(
  sessions: readonly WorkSessionSummary[],
  rememberedProjectId: string | null,
): ActiveProjectResolution {
  const activeByProject = new Map<string, WorkSessionSummary>();
  for (const session of sessions) {
    if (session.active && !activeByProject.has(session.projectId)) activeByProject.set(session.projectId, session);
  }
  if (rememberedProjectId !== null) {
    const selected = activeByProject.get(rememberedProjectId);
    if (selected) {
      return { kind: 'resolved', projectId: selected.projectId, label: selected.label, source: 'selection' };
    }
  }
  const only = [...activeByProject.values()];
  if (only.length === 1) {
    const single = only[0] as WorkSessionSummary;
    return { kind: 'resolved', projectId: single.projectId, label: single.label, source: 'single_active' };
  }
  if (only.length === 0) return { kind: 'no_active_project' };
  return {
    kind: 'choose_project',
    activeProjects: only.length,
    options: only.map((session) => ({ projectId: session.projectId, label: session.label })),
  };
}

/** Strict reader for `POST desktop-observe`: evidence, a denial, a named failure, or malformed. */
export type DesktopObservePayload =
  | Readonly<{ kind: 'evidence'; evidence: DesktopEvidence }>
  | Readonly<{ kind: 'denied'; code: DesktopDenialCode; detail: string | null }>
  | Readonly<{ kind: 'failure'; reason: DesktopFailureReason }>
  | Readonly<{ kind: 'malformed' }>;

export function parseDesktopObservePayload(value: unknown, expectedProjectId: string): DesktopObservePayload {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return { kind: 'malformed' };
  if (value.ok === true) {
    const evidence = parseEvidence(value.evidence, expectedProjectId);
    return evidence === null ? { kind: 'malformed' } : { kind: 'evidence', evidence };
  }
  if (typeof value.reason !== 'string') return { kind: 'malformed' };
  if ((DESKTOP_DENIAL_CODES as readonly string[]).includes(value.reason)) {
    return { kind: 'denied', code: value.reason as DesktopDenialCode, detail: sanitizeDetail(value.detail) };
  }
  if ((DESKTOP_FAILURE_REASONS as readonly string[]).includes(value.reason)) {
    return { kind: 'failure', reason: value.reason as DesktopFailureReason };
  }
  return { kind: 'malformed' };
}

function parseEvidence(value: unknown, expectedProjectId: string): DesktopEvidence | null {
  if (!isRecord(value) || value.kind !== 'desktop_observe') return null;
  if (typeof value.observedAtMs !== 'number' || !Number.isFinite(value.observedAtMs) || value.observedAtMs < 0) return null;
  if (value.projectId !== expectedProjectId) return null;

  const application = value.application;
  if (!isRecord(application)) return null;
  const pid = count(application, 'pid');
  const bundleId = boundedString(application.bundleId, MAX_APPLICATION_FIELD_BYTES);
  const name = boundedString(application.name, MAX_APPLICATION_FIELD_BYTES);
  const bundleIdTruncated = flag(application, 'bundleIdTruncated');
  const nameTruncated = flag(application, 'nameTruncated');
  if (pid === null || pid > 2_147_483_647 || bundleId === null || name === null
    || bundleIdTruncated === null || nameTruncated === null) return null;

  const window = value.window;
  if (!isRecord(window)) return null;
  const windowRole = boundedString(window.role, MAX_ROLE_BYTES);
  const windowTitle = boundedString(window.title, MAX_WINDOW_TITLE_BYTES);
  const windowRoleTruncated = flag(window, 'roleTruncated');
  const windowTitleTruncated = flag(window, 'titleTruncated');
  if (windowRole === null || windowTitle === null || windowRoleTruncated === null || windowTitleTruncated === null) return null;

  if (!Array.isArray(value.nodes) || value.nodes.length > MAX_NODES) return null;
  const nodes: ForegroundEvidenceNode[] = [];
  for (const rawNode of value.nodes) {
    if (!isRecord(rawNode)) return null;
    const depth = count(rawNode, 'depth');
    const role = boundedString(rawNode.role, MAX_ROLE_BYTES);
    const subrole = optionalString(rawNode, 'subrole', MAX_ROLE_BYTES);
    const label = optionalString(rawNode, 'label', MAX_NODE_STRING_BYTES);
    const nodeValue = optionalString(rawNode, 'value', MAX_NODE_STRING_BYTES);
    const labelTruncated = flag(rawNode, 'labelTruncated');
    const valueTruncated = flag(rawNode, 'valueTruncated');
    const redacted = flag(rawNode, 'redacted');
    const roleTruncated = flag(rawNode, 'roleTruncated');
    const subroleTruncated = flag(rawNode, 'subroleTruncated');
    if (depth === null || depth > 64 || role === null || subrole === undefined || label === undefined
      || nodeValue === undefined || labelTruncated === null || valueTruncated === null || redacted === null
      || roleTruncated === null || subroleTruncated === null) return null;
    nodes.push({
      depth, role, subrole, label, value: nodeValue,
      labelTruncated, valueTruncated, redacted, roleTruncated, subroleTruncated,
    });
  }

  if (value.quality !== 'full' && value.quality !== 'partial') return null;
  const truncated = flag(value, 'truncated');
  if (truncated === null) return null;
  if (!Array.isArray(value.truncations) || value.truncations.length > MAX_TRUNCATIONS) return null;
  const truncations: string[] = [];
  for (const entry of value.truncations) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 32) return null;
    truncations.push(entry);
  }

  const stats = value.stats;
  if (!isRecord(stats)) return null;
  const visitedNodes = count(stats, 'visitedNodes');
  const emittedNodes = count(stats, 'emittedNodes');
  const maxDepthReached = count(stats, 'maxDepthReached');
  const estimatedBytes = count(stats, 'estimatedBytes');
  if (visitedNodes === null || emittedNodes === null || maxDepthReached === null || estimatedBytes === null) return null;
  if (emittedNodes !== nodes.length || visitedNodes < emittedNodes) return null;

  return {
    kind: 'desktop_observe',
    observedAtMs: value.observedAtMs,
    projectId: expectedProjectId,
    application: { pid, bundleId, name, bundleIdTruncated, nameTruncated },
    window: { role: windowRole, roleTruncated: windowRoleTruncated, title: windowTitle, titleTruncated: windowTitleTruncated },
    nodes,
    quality: value.quality,
    truncated,
    truncations,
    stats: { visitedNodes, emittedNodes, maxDepthReached, estimatedBytes },
  };
}

function clip(text: string, max: number): Readonly<{ text: string; clipped: boolean }> {
  return text.length <= max ? { text, clipped: false } : { text: `${text.slice(0, max - 1)}…`, clipped: true };
}

/** Reduces validated evidence to the bounded, human-readable preview the widget paints. */
export function buildDesktopEvidencePreview(evidence: DesktopEvidence): DesktopEvidencePreview {
  const rows: DesktopPreviewRow[] = [];
  let omittedRows = 0;
  evidence.nodes.forEach((node, index) => {
    if (rows.length >= DESKTOP_PREVIEW_MAX_ROWS) {
      omittedRows += 1;
      return;
    }
    const role = clip(node.role, DESKTOP_PREVIEW_MAX_TEXT);
    const label = node.label === null ? null : clip(node.label, DESKTOP_PREVIEW_MAX_TEXT);
    const value = node.value === null ? null : clip(node.value, DESKTOP_PREVIEW_MAX_TEXT);
    rows.push({
      evidenceId: `desk:ax:${index}`,
      depth: node.depth,
      role: role.text,
      label: label?.text ?? null,
      value: value?.text ?? null,
      truncated: node.labelTruncated || node.valueTruncated || node.roleTruncated || node.subroleTruncated
        || role.clipped || (label?.clipped ?? false) || (value?.clipped ?? false),
      redacted: node.redacted,
    });
  });
  return {
    application: {
      name: evidence.application.name,
      bundleId: evidence.application.bundleId,
      pid: evidence.application.pid,
      identityTruncated: evidence.application.nameTruncated || evidence.application.bundleIdTruncated,
    },
    window: {
      title: evidence.window.title,
      role: evidence.window.role,
      titleTruncated: evidence.window.titleTruncated,
    },
    rows,
    omittedRows,
    quality: evidence.quality,
    truncated: evidence.truncated,
    truncations: [...evidence.truncations],
    visitedNodes: evidence.stats.visitedNodes,
    emittedNodes: evidence.stats.emittedNodes,
    label: DESKTOP_PREVIEW_LABEL,
    spoken: false,
  };
}

export type StorageLike = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The only thing this surface persists: the project id the user chose in Mission Control Work.
 * Raw evidence, previews, and identities are never written to local UI state.
 */
export function readRememberedProject(storage: StorageLike | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    return normalizeProjectId(storage.getItem(DESKTOP_INSPECT_PROJECT_KEY));
  } catch {
    return null;
  }
}

/** Returns false when the value is not a valid project id or storage refused the write. */
export function rememberProject(projectId: string, storage: StorageLike | null = defaultStorage()): boolean {
  const normalized = normalizeProjectId(projectId);
  if (normalized === null) return false;
  if (!storage) return false;
  try {
    storage.setItem(DESKTOP_INSPECT_PROJECT_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function forgetRememberedProject(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(DESKTOP_INSPECT_PROJECT_KEY);
  } catch {
    // A refused storage clear never blocks the inspect flow.
  }
}

function baseHref(): string {
  try {
    return typeof location === 'undefined' ? 'echo://app/index.html' : location.href;
  } catch {
    return 'echo://app/index.html';
  }
}

function routeFetch(): typeof fetch {
  const implementation = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof implementation !== 'function') throw new Error('Same-origin fetch is unavailable in this renderer.');
  return implementation;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error('The route did not answer with JSON.');
  }
}

/** The same-origin transport the widget uses; tests drive it with a fake fetch. */
export function createDesktopInspectTransport(
  fetchImpl: typeof fetch = routeFetch(),
  href: string = baseHref(),
): DesktopInspectTransport {
  return {
    async loadWorkSessions(): Promise<readonly WorkSessionSummary[]> {
      const response = await fetchImpl(new URL('work-status', href), { cache: 'no-store' });
      return parseWorkSessions(await readJson(response));
    },
    async postObserve(projectId: string): Promise<unknown> {
      const response = await fetchImpl(new URL('desktop-observe', href), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      return readJson(response);
    },
  };
}

export type DesktopInspectClientOptions = Readonly<{
  transport?: DesktopInspectTransport;
  /** Reads the persisted Work selection; defaults to the same-origin local UI state. */
  selectedProjectId?: () => string | null;
}>;

/**
 * The widget's inspect client. `inspect` is single-flight: re-entry while one observation is
 * running returns null and issues no request, so one click can never fan out into several.
 */
export function createDesktopInspectClient(options: DesktopInspectClientOptions = {}): DesktopInspectClient {
  const transport = options.transport ?? createDesktopInspectTransport();
  const selected = options.selectedProjectId ?? (() => readRememberedProject());
  let inFlight: Promise<DesktopInspectState> | null = null;

  async function loadScope(): Promise<DesktopScopeState> {
    try {
      const resolved = resolveActiveProject(await transport.loadWorkSessions(), selected());
      if (resolved.kind === 'resolved') {
        return { kind: 'ready', projectId: resolved.projectId, label: resolved.label, source: resolved.source };
      }
      if (resolved.kind === 'no_active_project') return { kind: 'blocked', activeProjects: 0, options: [] };
      return { kind: 'blocked', activeProjects: resolved.activeProjects, options: resolved.options };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function inspect(): Promise<DesktopInspectState | null> {
    if (inFlight) return null;
    const run = runDesktopInspect({ transport, selectedProjectId: selected() });
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
    }
  }

  return { loadScope, inspect };
}

/**
 * One inspect flow: resolve the explicit active project, then issue exactly one observation.
 * A blocked resolution performs no observation at all, so an ambiguous or empty scope can never
 * turn into a capture of whatever window happens to be frontmost.
 */
export async function runDesktopInspect(input: Readonly<{
  transport: DesktopInspectTransport;
  selectedProjectId: string | null;
}>): Promise<DesktopInspectState> {
  let sessions: readonly WorkSessionSummary[];
  try {
    sessions = await input.transport.loadWorkSessions();
  } catch {
    return {
      kind: 'error',
      reason: 'work_status_unavailable',
      message: DESKTOP_FAILURE_COPY.work_status_unavailable,
      projectLabel: null,
    };
  }

  const resolved = resolveActiveProject(sessions, input.selectedProjectId);
  if (resolved.kind === 'no_active_project') return { kind: 'blocked', activeProjects: 0, options: [] };
  if (resolved.kind === 'choose_project') {
    return { kind: 'blocked', activeProjects: resolved.activeProjects, options: resolved.options };
  }

  let payload: unknown;
  try {
    payload = await input.transport.postObserve(resolved.projectId);
  } catch {
    return { kind: 'error', reason: 'transport', message: DESKTOP_FAILURE_COPY.transport, projectLabel: resolved.label };
  }

  const parsed = parseDesktopObservePayload(payload, resolved.projectId);
  if (parsed.kind === 'evidence') {
    return {
      kind: 'preview',
      projectId: resolved.projectId,
      projectLabel: resolved.label,
      observedAtMs: parsed.evidence.observedAtMs,
      preview: buildDesktopEvidencePreview(parsed.evidence),
    };
  }
  if (parsed.kind === 'denied') {
    return {
      kind: 'limited',
      projectId: resolved.projectId,
      projectLabel: resolved.label,
      code: parsed.code,
      detail: parsed.detail,
    };
  }
  return {
    kind: 'error',
    reason: parsed.kind === 'failure' ? parsed.reason : 'malformed_response',
    message: DESKTOP_FAILURE_COPY[parsed.kind === 'failure' ? parsed.reason : 'malformed_response'],
    projectLabel: resolved.label,
  };
}
