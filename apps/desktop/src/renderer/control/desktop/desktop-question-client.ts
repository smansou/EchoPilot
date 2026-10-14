/**
 * Mission Control → Desktop grounded-question client (renderer half, C05).
 *
 * The widget's non-focusable surface only observes; the question flow lives in the focusable
 * Mission Control window. This module owns the bounded transport and the controller that:
 *
 *   - resolves the active Work project with the same rules as the widget (persisted selection
 *     first, then exactly one active project) and asks the read-only `desktop-answer-context`
 *     route for the newest live snapshot pointer — opening or refreshing the page never captures;
 *   - previews a question (one POST, still no egress) and keeps the exact returned prompt,
 *     provider, model, source age, partial flags, and expiry for explicit review;
 *   - confirms only the stored confirmation id once, with a client single-flight so a duplicate
 *     click cannot issue a second confirm, and never re-sends changed question text: editing the
 *     question (or a context/snapshot change) invalidates the preview and best-effort cancels it;
 *   - surfaces route refusals with concrete copy and always requires a fresh preview after a
 *     one-shot confirmation is consumed by success or failure.
 *
 * Nothing here persists raw evidence or prompt text (no localStorage, no broadcast), nothing is
 * spoken, and no method other than an explicit user `confirm` can reach the provider.
 */
import {
  readRememberedProject,
  parseWorkSessions,
  resolveActiveProject,
  type DesktopProjectOption,
  type WorkSessionSummary,
} from '../../widget/desktop-inspect';

/** Must match `DESKTOP_ANSWER_MAX_QUESTION_CHARS` in the main-process seam. */
export const DESKTOP_QUESTION_MAX_CHARS = 1_000;
const MAX_ID_CHARS = 128;
const MAX_PROJECT_ID_CHARS = 256;
const MAX_MODEL_CHARS = 128;
const MAX_PROMPT_CHARS = 12_000;
const MAX_ROWS = 24;
const MAX_ROW_CHARS = 200;
const MAX_ANSWER_CHARS = 100_000;
const MAX_TRUNCATIONS = 16;
const MAX_RELATED_CHARS = 512;

/** Mirrors the main-process error codes; an unknown code is treated as malformed. */
export const DESKTOP_QUESTION_ERROR_CODES = [
  'invalid_request',
  'not_confirmed',
  'invalid_question',
  'snapshot_unknown',
  'snapshot_expired',
  'snapshot_foreign',
  'confirmation_unknown',
  'confirmation_expired',
  'confirmation_foreign',
  'evidence_empty',
  'project_inactive',
  'model_changed',
  'busy',
  'provider_unavailable',
  'kernel_denied',
  'provider_failed',
] as const;
export type DesktopQuestionErrorCode = (typeof DESKTOP_QUESTION_ERROR_CODES)[number];

/** Route refusals keep their distinct code; transport and parse failures stay separate. */
export type DesktopQuestionFailureCode = DesktopQuestionErrorCode | 'transport' | 'malformed';

export type DesktopQuestionSnapshotPointer = Readonly<{
  snapshotId: string;
  observedAtMs: number;
  expiresAtMs: number;
}>;

export type DesktopQuestionSourceRow = Readonly<{
  number: number;
  evidenceId: string;
  role: string;
  label: string | null;
  value: string | null;
  truncated: boolean;
}>;

export type DesktopQuestionSource = Readonly<{
  rows: readonly DesktopQuestionSourceRow[];
  omittedRows: number;
  application: Readonly<{ name: string; bundleId: string; pid: number; identityTruncated: boolean }>;
  window: Readonly<{ role: string; title: string; titleTruncated: boolean }>;
  quality: 'full' | 'partial';
  truncated: boolean;
  truncations: readonly string[];
  observedAtMs: number;
}>;

export type DesktopQuestionPreview = Readonly<{
  confirmationId: string;
  /** Scope the confirmation is bound to; the client only ever confirms with this pair. */
  projectId: string;
  snapshotId: string;
  question: string;
  /** The exact bounded prompt the confirmation would send; nothing else is ever sent. */
  prompt: string;
  evidence: DesktopQuestionSource;
  providerId: 'openai';
  model: string;
  expiresAtMs: number;
}>;

export type DesktopQuestionAnswer = Readonly<{
  answer: string;
  answerKind: 'model_generated';
  citationsVerified: false;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: null;
  snapshotId: string;
  evidence: DesktopQuestionSource;
}>;

export type DesktopQuestionContextState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; projectId: string; projectLabel: string; snapshot: DesktopQuestionSnapshotPointer | null }>
  | Readonly<{ kind: 'blocked'; activeProjects: number; options: readonly DesktopProjectOption[] }>
  | Readonly<{ kind: 'unavailable'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

export type DesktopQuestionPhase = 'idle' | 'previewing' | 'confirming' | 'answered';

export type DesktopQuestionState = Readonly<{
  context: DesktopQuestionContextState;
  question: string;
  phase: DesktopQuestionPhase;
  preview: DesktopQuestionPreview | null;
  answer: DesktopQuestionAnswer | null;
  error: Readonly<{ code: DesktopQuestionFailureCode; message: string; requiresNewPreview: boolean }> | null;
}>;

export type DesktopQuestionTransport = Readonly<{
  loadWorkSessions(): Promise<readonly WorkSessionSummary[]>;
  loadContext(projectId: string): Promise<unknown>;
  postPreview(input: Readonly<{ projectId: string; snapshotId: string; question: string }>): Promise<unknown>;
  postConfirm(input: Readonly<{ projectId: string; confirmationId: string; confirmed: true }>): Promise<unknown>;
  postCancel(input: Readonly<{ projectId: string; confirmationId: string }>): Promise<unknown>;
}>;

export type DesktopQuestionClient = Readonly<{
  getSnapshot(): DesktopQuestionState;
  subscribe(listener: () => void): () => void;
  /** Resolves the active Work project and reads the latest live snapshot pointer; never captures. */
  loadContext(): Promise<void>;
  setQuestion(question: string): void;
  preview(): Promise<void>;
  confirm(): Promise<void>;
  cancelPreview(): Promise<void>;
  /** Stops state updates and best-effort withdraws an unconsumed preview. */
  dispose(): void;
}>;

/** A bounded route refusal, distinct from a transport or parse failure. */
export class DesktopQuestionRouteError extends Error {
  readonly code: DesktopQuestionFailureCode;
  readonly status: number;
  constructor(message: string, code: DesktopQuestionFailureCode, status: number) {
    super(message);
    this.name = 'DesktopQuestionRouteError';
    this.code = code;
    this.status = status;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) fail(`${where} is invalid`);
  return value;
}

function optionalBoundedString(value: unknown, maxChars: number, where: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maxChars) fail(`${where} is invalid`);
  return value;
}

function finiteTime(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${where} is invalid`);
  return value;
}

function boundedCount(value: unknown, where: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) fail(`${where} is invalid`);
  return value;
}

function booleanFlag(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(`${where} is invalid`);
  return value;
}

/** Strict reader for `GET desktop-answer-context`: a live pointer or an honest null. */
export function parseDesktopAnswerContext(value: unknown, expectedProjectId: string): DesktopQuestionSnapshotPointer | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'snapshot')) fail('desktop-answer-context: snapshot is missing');
  if (value.snapshot === null) return null;
  const snapshot = value.snapshot;
  if (!isRecord(snapshot)) fail('desktop-answer-context: snapshot is invalid');
  const snapshotId = boundedString(snapshot.snapshotId, MAX_ID_CHARS, 'desktop-answer-context: snapshotId');
  const observedAtMs = finiteTime(snapshot.observedAtMs, 'desktop-answer-context: observedAtMs');
  const expiresAtMs = finiteTime(snapshot.expiresAtMs, 'desktop-answer-context: expiresAtMs');
  if (expiresAtMs < observedAtMs) fail('desktop-answer-context: expiresAtMs precedes observedAtMs');
  if (expectedProjectId.length === 0) fail('desktop-answer-context: projectId is missing');
  return Object.freeze({ snapshotId, observedAtMs, expiresAtMs });
}

/** Strict reader for the preview route; every bounded field is revalidated in the renderer. */
export function parseDesktopQuestionPreview(value: unknown, expectedProjectId: string): DesktopQuestionPreview {
  if (!isRecord(value)) fail('desktop-answer-preview: response is not an object');
  const confirmationId = boundedString(value.confirmationId, MAX_ID_CHARS, 'desktop-answer-preview: confirmationId');
  const snapshotId = boundedString(value.snapshotId, MAX_ID_CHARS, 'desktop-answer-preview: snapshotId');
  const question = boundedString(value.question, DESKTOP_QUESTION_MAX_CHARS, 'desktop-answer-preview: question');
  const prompt = boundedString(value.prompt, MAX_PROMPT_CHARS, 'desktop-answer-preview: prompt');
  const expiresAtMs = finiteTime(value.expiresAtMs, 'desktop-answer-preview: expiresAtMs');
  const destination = value.destination;
  if (!isRecord(destination) || destination.providerId !== 'openai') {
    fail('desktop-answer-preview: destination is invalid');
  }
  const model = boundedString(destination.model, MAX_MODEL_CHARS, 'desktop-answer-preview: destination.model');
  const evidence = parseDesktopQuestionSource(value.evidence, 'desktop-answer-preview: evidence');
  return Object.freeze({
    confirmationId,
    projectId: expectedProjectId,
    snapshotId,
    question,
    prompt,
    evidence,
    providerId: 'openai' as const,
    model,
    expiresAtMs,
  });
}

function parseDesktopQuestionSource(value: unknown, where: string): DesktopQuestionSource {
  if (!isRecord(value)) fail(`${where} is invalid`);
  const application = value.application;
  if (!isRecord(application)) fail(`${where}.application is invalid`);
  const name = boundedString(application.name, MAX_RELATED_CHARS, `${where}.application.name`);
  const bundleId = boundedString(application.bundleId, MAX_RELATED_CHARS, `${where}.application.bundleId`);
  const pid = boundedCount(application.pid, `${where}.application.pid`);
  const identityTruncated = booleanFlag(application.identityTruncated, `${where}.application.identityTruncated`);
  const window = value.window;
  if (!isRecord(window)) fail(`${where}.window is invalid`);
  const role = boundedString(window.role, MAX_RELATED_CHARS, `${where}.window.role`);
  const rawTitle = window.title;
  if (typeof rawTitle !== 'string' || rawTitle.length > MAX_RELATED_CHARS) fail(`${where}.window.title is invalid`);
  const title = rawTitle;
  const titleTruncated = booleanFlag(window.titleTruncated, `${where}.window.titleTruncated`);
  if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS) fail(`${where}.rows is invalid`);
  const rows: DesktopQuestionSourceRow[] = value.rows.map((raw, index) => {
    if (!isRecord(raw)) fail(`${where}.rows[${index}] is invalid`);
    return Object.freeze({
      number: boundedCount(raw.number, `${where}.rows[${index}].number`),
      evidenceId: boundedString(raw.evidenceId, MAX_ID_CHARS, `${where}.rows[${index}].evidenceId`),
      role: boundedString(raw.role, MAX_ROW_CHARS, `${where}.rows[${index}].role`),
      label: optionalBoundedString(raw.label, MAX_ROW_CHARS, `${where}.rows[${index}].label`),
      value: optionalBoundedString(raw.value, MAX_ROW_CHARS, `${where}.rows[${index}].value`),
      truncated: booleanFlag(raw.truncated, `${where}.rows[${index}].truncated`),
    });
  });
  const omittedRows = boundedCount(value.omittedRows, `${where}.omittedRows`);
  if (value.quality !== 'full' && value.quality !== 'partial') fail(`${where}.quality is invalid`);
  const truncated = booleanFlag(value.truncated, `${where}.truncated`);
  if (!Array.isArray(value.truncations) || value.truncations.length > MAX_TRUNCATIONS) fail(`${where}.truncations is invalid`);
  const truncations = value.truncations.map((entry, index) =>
    boundedString(entry, 32, `${where}.truncations[${index}]`));
  const observedAtMs = finiteTime(value.observedAtMs, `${where}.observedAtMs`);
  return Object.freeze({
    rows: Object.freeze(rows),
    omittedRows,
    application: Object.freeze({ name, bundleId, pid, identityTruncated }),
    window: Object.freeze({ role, title, titleTruncated }),
    quality: value.quality,
    truncated,
    truncations: Object.freeze(truncations),
    observedAtMs,
  });
}

/** Strict reader for the confirm route; unknown usage stays null instead of becoming zero. */
export function parseDesktopQuestionAnswer(value: unknown, expectedSnapshotId: string): DesktopQuestionAnswer {
  if (!isRecord(value)) fail('desktop-answer-confirm: response is not an object');
  const answer = boundedString(value.answer, MAX_ANSWER_CHARS, 'desktop-answer-confirm: answer');
  if (value.answerKind !== 'model_generated') fail('desktop-answer-confirm: answerKind is invalid');
  if (value.citationsVerified !== false) fail('desktop-answer-confirm: citationsVerified must stay false');
  const model = boundedString(value.model, MAX_MODEL_CHARS, 'desktop-answer-confirm: model');
  const tokens = (raw: unknown, where: string): number | null =>
    raw === null ? null : boundedCount(raw, where);
  const inputTokens = tokens(value.inputTokens, 'desktop-answer-confirm: inputTokens');
  const outputTokens = tokens(value.outputTokens, 'desktop-answer-confirm: outputTokens');
  if (value.estimatedUsd !== null) fail('desktop-answer-confirm: estimatedUsd must stay null');
  const snapshotId = boundedString(value.snapshotId, MAX_ID_CHARS, 'desktop-answer-confirm: snapshotId');
  if (snapshotId !== expectedSnapshotId) fail('desktop-answer-confirm: snapshotId does not match the preview');
  const evidence = parseDesktopQuestionSource(value.evidence, 'desktop-answer-confirm: evidence');
  return Object.freeze({
    answer,
    answerKind: 'model_generated' as const,
    citationsVerified: false as const,
    model,
    inputTokens,
    outputTokens,
    estimatedUsd: null,
    snapshotId,
    evidence,
  });
}

/** Consumer-facing copy for every refusal; the route's own message is the fallback. */
export function desktopQuestionFailureMessage(code: DesktopQuestionFailureCode, routeMessage: string): string {
  switch (code) {
    case 'invalid_request':
    case 'invalid_question':
      return `That question cannot be previewed: ${routeMessage}`;
    case 'not_confirmed':
      return 'Nothing is sent without an explicit confirmation of the preview.';
    case 'snapshot_unknown':
      return 'That local snapshot is no longer in memory. Inspect the window again from the widget, then refresh this context.';
    case 'snapshot_expired':
      return 'That local snapshot expired. Inspect the window again from the widget, then refresh this context.';
    case 'snapshot_foreign':
      return 'That local snapshot belongs to a different project, so it was not used.';
    case 'confirmation_unknown':
    case 'confirmation_expired':
    case 'confirmation_foreign':
      return 'This preview can no longer be sent. Review a fresh preview before sending anything.';
    case 'evidence_empty':
      return 'The snapshot held no usable Accessibility text, so there is nothing to ask about. Inspect the window again.';
    case 'project_inactive':
      return 'That project no longer has an active Work session, so nothing was sent. Reconnect it in Work.';
    case 'model_changed':
      return 'The text model changed after this preview, so nothing was sent. Review a fresh preview.';
    case 'busy':
      return 'Another desktop answer is already running. Wait for it to finish, then review a fresh preview.';
    case 'provider_unavailable':
      return 'No OpenAI API key is available. Store one under Providers, then review a fresh preview.';
    case 'kernel_denied':
      return `The one-time permission grant was refused, so nothing was sent. ${routeMessage}`;
    case 'provider_failed':
      return 'The request failed before an answer was accepted, so nothing is shown. Review a fresh preview to retry.';
    case 'transport':
      return 'The app route did not answer. Nothing was sent. Try again.';
    case 'malformed':
      return `The app returned a response this page could not trust, so nothing is shown. ${routeMessage}`;
  }
}

function isErrorCode(value: unknown): value is DesktopQuestionErrorCode {
  return typeof value === 'string' && (DESKTOP_QUESTION_ERROR_CODES as readonly string[]).includes(value);
}

function routeFetch(): typeof fetch {
  const implementation = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof implementation !== 'function') throw new Error('Same-origin fetch is unavailable in this renderer.');
  return implementation;
}

function baseHref(): string {
  try {
    return typeof location === 'undefined' ? 'echo://app/index.html' : location.href;
  } catch {
    return 'echo://app/index.html';
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new DesktopQuestionRouteError('The route did not answer with JSON.', 'transport', response.status);
  }
}

/** The same-origin transport; tests drive it with a fake fetch and a fake URL. */
export function createDesktopQuestionTransport(
  fetchImpl: typeof fetch = routeFetch(),
  href: string = baseHref(),
): DesktopQuestionTransport {
  async function request(name: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(new URL(name, href), init);
    const payload = await readJson(response);
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {};
      const message = typeof record.error === 'string' && record.error.length > 0
        ? record.error
        : `${name} failed (${response.status})`;
      throw new DesktopQuestionRouteError(message, isErrorCode(record.code) ? record.code : 'transport', response.status);
    }
    return payload;
  }
  return {
    async loadWorkSessions(): Promise<readonly WorkSessionSummary[]> {
      const payload = await request('work-status', { cache: 'no-store' });
      if (isRecord(payload) && 'selectedProject' in payload) return parseWorkSessions(payload);
      if (!isRecord(payload) || !Array.isArray(payload.sessions)) fail('work-status: sessions is invalid');
      return payload.sessions.map((row, index) => {
        if (!isRecord(row)
          || typeof row.id !== 'string' || row.id.length === 0
          || typeof row.projectId !== 'string' || row.projectId.trim().length === 0
          || typeof row.label !== 'string'
          || typeof row.active !== 'boolean') {
          fail(`work-status: sessions[${index}] is invalid`);
        }
        return { id: row.id, projectId: row.projectId, label: row.label, active: row.active };
      });
    },
    loadContext(projectId: string): Promise<unknown> {
      return request(`desktop-answer-context?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    },
    postPreview(input): Promise<unknown> {
      return request('desktop-answer-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
    },
    postConfirm(input): Promise<unknown> {
      return request('desktop-answer-confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
    },
    postCancel(input): Promise<unknown> {
      return request('desktop-answer-cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
    },
  };
}

export type DesktopQuestionClientOptions = Readonly<{
  transport?: DesktopQuestionTransport;
  /** Reads the persisted Work selection; defaults to the same-origin local UI state. */
  selectedProjectId?: () => string | null;
  now?(): number;
}>;

function emptyState(): DesktopQuestionState {
  return Object.freeze({
    context: Object.freeze({ kind: 'loading' as const }),
    question: '',
    phase: 'idle' as const,
    preview: null,
    answer: null,
    error: null,
  });
}

/**
 * The controller Mission Control's Desktop page renders. Every async completion is guarded so an
 * unmounted page or a superseded project never receives a stale state update, and the only path
 * that can reach the provider is an explicit `confirm` of a stored preview.
 */
export function createDesktopQuestionClient(options: DesktopQuestionClientOptions = {}): DesktopQuestionClient {
  const transport = options.transport ?? createDesktopQuestionTransport();
  const selected = options.selectedProjectId ?? (() => readRememberedProject());
  let state = emptyState();
  const listeners = new Set<() => void>();
  let disposed = false;
  let loadToken = 0;
  let previewInFlight: Promise<void> | null = null;
  let confirmInFlight: Promise<void> | null = null;

  function update(partial: Partial<DesktopQuestionState>): void {
    state = Object.freeze({ ...state, ...partial });
    for (const listener of [...listeners]) listener();
  }

  function withdrawPreview(preview: DesktopQuestionPreview): void {
    void transport.postCancel({ projectId: preview.projectId, confirmationId: preview.confirmationId }).catch(() => {
      // Best effort: a refused cancel never blocks the page, and the preview is already gone here.
    });
  }

  function invalidatePreview(): void {
    if (state.preview === null) return;
    const preview = state.preview;
    update({ preview: null, phase: 'idle' });
    if (!disposed) withdrawPreview(preview);
  }

  async function loadContext(): Promise<void> {
    if (disposed) return;
    const token = ++loadToken;
    update({ context: { kind: 'loading' }, error: null });
    let sessions: readonly WorkSessionSummary[];
    try {
      sessions = await transport.loadWorkSessions();
    } catch {
      if (!disposed && token === loadToken) {
        update({ context: { kind: 'unavailable', message: 'Work session status is unavailable, so no active project can be confirmed and nothing was observed.' } });
      }
      return;
    }
    const resolved = resolveActiveProject(sessions, selected());
    if (!disposed && token === loadToken) {
      if (resolved.kind === 'no_active_project') {
        invalidatePreview();
        update({ context: { kind: 'blocked', activeProjects: 0, options: [] } });
        return;
      }
      if (resolved.kind === 'choose_project') {
        invalidatePreview();
        update({ context: { kind: 'blocked', activeProjects: resolved.activeProjects, options: resolved.options } });
        return;
      }
    }
    if (resolved.kind !== 'resolved') return;
    let payload: unknown;
    try {
      payload = await transport.loadContext(resolved.projectId);
    } catch (failure) {
      if (!disposed && token === loadToken) {
        const message = failure instanceof DesktopQuestionRouteError ? failure.message : 'The desktop context route did not answer.';
        update({ context: { kind: 'unavailable', message } });
      }
      return;
    }
    if (disposed || token !== loadToken) return;
    let snapshot: DesktopQuestionSnapshotPointer | null;
    try {
      snapshot = parseDesktopAnswerContext(payload, resolved.projectId);
    } catch (failure) {
      update({ context: { kind: 'error', message: failure instanceof Error ? failure.message : 'The desktop context response was malformed.' } });
      return;
    }
    const previous = state.context;
    const projectChanged = previous.kind === 'ready' && previous.projectId !== resolved.projectId;
    if (state.preview !== null
      && (state.preview.projectId !== resolved.projectId || state.preview.snapshotId !== (snapshot?.snapshotId ?? null))) {
      invalidatePreview();
    }
    update({
      context: { kind: 'ready', projectId: resolved.projectId, projectLabel: resolved.label, snapshot },
      ...(projectChanged ? { answer: null, error: null } : {}),
    });
  }

  function setQuestion(question: string): void {
    if (disposed || question === state.question) return;
    if (state.phase === 'confirming') return;
    update({ question, error: null });
    if (state.preview !== null && state.preview.question !== question.trim()) invalidatePreview();
  }

  async function preview(): Promise<void> {
    if (disposed || previewInFlight !== null || state.phase === 'confirming') return;
    const context = state.context;
    if (context.kind !== 'ready' || context.snapshot === null) return;
    const question = state.question.trim();
    if (question.length === 0 || question.length > DESKTOP_QUESTION_MAX_CHARS) return;
    const run = (async () => {
      invalidatePreview();
      update({ phase: 'previewing', error: null, answer: null });
      let payload: unknown;
      try {
        payload = await transport.postPreview({
          projectId: context.projectId,
          snapshotId: context.snapshot!.snapshotId,
          question,
        });
      } catch (failure) {
        if (disposed) return;
        const code = failure instanceof DesktopQuestionRouteError ? failure.code : 'transport';
        const message = desktopQuestionFailureMessage(code, failure instanceof Error ? failure.message : '');
        const snapshotGone = code === 'snapshot_unknown' || code === 'snapshot_expired';
        update({
          phase: 'idle',
          error: { code, message, requiresNewPreview: false },
          ...(snapshotGone && state.context.kind === 'ready' ? { context: { ...state.context, snapshot: null } } : {}),
        });
        return;
      }
      if (disposed) return;
      try {
        const parsed = parseDesktopQuestionPreview(payload, context.projectId);
        update({ phase: 'idle', preview: parsed });
      } catch (failure) {
        update({
          phase: 'idle',
          error: {
            code: 'malformed',
            message: desktopQuestionFailureMessage('malformed', failure instanceof Error ? failure.message : ''),
            requiresNewPreview: false,
          },
        });
      }
    })();
    previewInFlight = run;
    try {
      await run;
    } finally {
      previewInFlight = null;
    }
  }

  async function confirm(): Promise<void> {
    if (disposed || state.phase === 'confirming') return;
    // Client single-flight: a duplicate click while one confirm is running resolves with the same
    // promise and never issues a second POST, so a one-shot confirmation cannot be double-spent.
    if (confirmInFlight !== null) return confirmInFlight;
    const preview = state.preview;
    if (preview === null || state.phase !== 'idle') return;
    const run = (async () => {
      update({ phase: 'confirming', error: null });
      let payload: unknown;
      try {
        payload = await transport.postConfirm({
          projectId: preview.projectId,
          confirmationId: preview.confirmationId,
          confirmed: true,
        });
      } catch (failure) {
        if (disposed) return;
        const code = failure instanceof DesktopQuestionRouteError ? failure.code : 'transport';
        update({
          phase: 'idle',
          preview: null,
          error: {
            code,
            message: desktopQuestionFailureMessage(code, failure instanceof Error ? failure.message : ''),
            requiresNewPreview: true,
          },
        });
        return;
      }
      if (disposed) return;
      try {
        const answer = parseDesktopQuestionAnswer(payload, preview.snapshotId);
        update({ phase: 'answered', preview: null, answer, error: null });
      } catch (failure) {
        update({
          phase: 'idle',
          preview: null,
          error: {
            code: 'malformed',
            message: desktopQuestionFailureMessage('malformed', failure instanceof Error ? failure.message : ''),
            requiresNewPreview: true,
          },
        });
      }
    })();
    confirmInFlight = run;
    try {
      await run;
    } finally {
      confirmInFlight = null;
    }
  }

  async function cancelPreview(): Promise<void> {
    const preview = state.preview;
    if (preview === null) return;
    update({ preview: null, phase: 'idle' });
    try {
      await transport.postCancel({ projectId: preview.projectId, confirmationId: preview.confirmationId });
    } catch {
      // Best effort: the pending confirmation expires on its own and was never sent.
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const pending = state.preview;
    if (pending !== null) {
      const preview = pending;
      state = Object.freeze({ ...state, preview: null, phase: 'idle' as const });
      void transport.postCancel({ projectId: preview.projectId, confirmationId: preview.confirmationId }).catch(() => {});
    }
    listeners.clear();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    loadContext,
    setQuestion,
    preview,
    confirm,
    cancelPreview,
    dispose,
  };
}

/** Human-readable age of a snapshot; the page never claims freshness it cannot compute. */
export function desktopQuestionSourceAge(observedAtMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.round((nowMs - observedAtMs) / 1_000));
  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds} seconds ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** Human-readable reminder of the main-memory expiry. */
export function desktopQuestionExpiry(expiresAtMs: number, nowMs: number): string {
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) return 'expired';
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1 ? 'expires within a minute' : `expires in about ${minutes} minutes`;
}
