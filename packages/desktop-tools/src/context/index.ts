/**
 * C01 — desktop "what is this?" → scoped screen/context → grounded spoken explanation
 * (IMPLEMENTATION_PLAN.md §7.2 C01, §5.4 "capture permitted foreground state", §5.3
 * Memory/Reasoner/Attention/VoiceSession + SpeechPlan/SpeechLease).
 *
 * `createDesktopContextService(...)` is the seam between the widget conversation and the permitted
 * desktop windows. It answers a question on the `widget` surface, without Mission Control, and the
 * behavior it guarantees is:
 *
 * - the permitted foreground app is resolved exactly once per question; a desktop question is never
 *   captured without one;
 * - an excluded bundle id is refused locally, before the bridge is asked for its content — the raw
 *   bridge would happily hand back an excluded app's window;
 * - the capture reaches memory only under the explicit project scope (`scope.projectId` is required
 *   at construction, so a scope-less window-title-similarity query can never be issued) and the
 *   bounded context carries the derived screen evidence ids (`desk:ax:<i>` / `desk:ocr:<i>`, using
 *   the original node index and skipping blank entries) plus the in-project memory ids;
 * - the model answer is accepted only against the evidence the bounded context actually contains:
 *   every id the model invents is dropped before the answer is returned or spoken, and an answer
 *   that is not shaped like the grounded contract is never spoken — the user gets the deterministic
 *   ungrounded sentence instead;
 * - missing Accessibility/Screen Recording access, a missing window, and a snapshot with no
 *   non-blank AX value, no OCR text and no screenshot each produce that reason's deterministic
 *   limited-context sentence without calling memory or the reasoner, so no control state can be
 *   invented about a screen that was not read;
 * - speech happens only through a lease Attention issues (a muted answer stays visible-only, with
 *   the same text and evidence), and every timestamp the service writes comes from the injected
 *   clock.
 *
 * The deterministic sentences below are the same strings the C01 fixture corpus
 * (`fixtures/desktop/questions/c01-questions.json`) pins; `{app}` is replaced with the resolved
 * application name. They never assert control state.
 */
import type {
  Attention,
  BoundedContext,
  Memory,
  Reasoner,
  Scope,
  SpeechLease,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../../contracts/src/index.js';

export type DesktopSurface = 'widget';

/** The permitted foreground app the bridge resolves for one desktop question. */
export type ForegroundApp = Readonly<{ bundleId: string; name: string; windowTitle: string }>;

export type AxNode = Readonly<{ role: string; value: string }>;
export type OcrSpan = Readonly<{ text: string }>;

/** One raw AX/OCR snapshot for exactly one question; `screenshotRef` is captured, not an evidence id. */
export type DesktopSnapshot = Readonly<{
  snapshotId: string;
  capturedAtMs: number;
  screenshotRef: string | null;
  quality: 'full' | 'partial' | 'unavailable';
  truncated: boolean;
  axNodes: ReadonlyArray<AxNode>;
  ocrSpans: ReadonlyArray<OcrSpan>;
}>;

export type DesktopCaptureUnavailableReason = 'accessibility_denied' | 'screen_recording_denied' | 'no_window';
export type DesktopCaptureReason = DesktopCaptureUnavailableReason | 'empty_context';

export type DesktopCaptureOutcome =
  | Readonly<{ status: 'captured'; snapshot: DesktopSnapshot }>
  | Readonly<{ status: 'unavailable'; reason: DesktopCaptureUnavailableReason }>;

export type DesktopCaptureRequest = Readonly<{ app: ForegroundApp; question: string }>;

/**
 * The C01 native boundary. `captureQuestionContext` is a raw producer: it does not enforce
 * exclusions, so the service decides before calling it.
 */
export type DesktopBridge = Readonly<{
  foregroundApp(): Promise<ForegroundApp | null>;
  captureQuestionContext(request: DesktopCaptureRequest): Promise<DesktopCaptureOutcome>;
}>;

/** The §5.3 VoiceSession playback seam; only submitSpeech is exercised by this tracer. */
export type DesktopVoice = Readonly<{
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;

export type DesktopCaptureState = 'captured' | 'limited' | 'excluded';

export type DesktopCaptureSummary = Readonly<{
  state: DesktopCaptureState;
  app: string;
  reason?: DesktopCaptureReason;
}>;

/** `capture` plus `evidenceIds` are the data behind the widget capture/evidence indicator. */
export type DesktopAnswer = Readonly<{
  question: string;
  surface: DesktopSurface;
  text: string;
  evidenceIds: ReadonlyArray<string>;
  capture: DesktopCaptureSummary;
  spoken: boolean;
}>;

export type DesktopContextService = Readonly<{
  answer(input: Readonly<{ question: string; surface: DesktopSurface }>): Promise<DesktopAnswer>;
}>;

export type DesktopContextOptions = Readonly<{
  bridge: DesktopBridge;
  memory: Memory;
  reasoner: Reasoner;
  attention: Attention;
  voice: DesktopVoice;
  now: () => Date;
  /** The explicit project association; memory is never queried without `projectId`. */
  scope: Scope;
  excludedBundleIds: ReadonlyArray<string>;
}>;

/** §5.4 deterministic context budget: the bounded context never exceeds this. */
export const MAX_CONTEXT_TOKENS = 8_192;
/** At most this many in-project memory items enter the bounded context. */
export const MEMORY_EVIDENCE_BUDGET = 8;
/** §5.3: a lease expires after its decision and at most 30 s later. */
export const MAX_SPEECH_LEASE_MS = 30_000;

export const EXCLUDED_APP_TEMPLATE = "{app} is excluded from capture, so I can't look at it. "
  + 'Remove it from the excluded apps list if you want me to read it.';

export const LIMITED_CONTEXT_TEMPLATES: Readonly<Record<DesktopCaptureReason, string>> = {
  accessibility_denied: "I couldn't read {app} because Accessibility access is missing. "
    + "Grant Accessibility to EchoPilot and ask again; I won't guess about what's on screen.",
  screen_recording_denied: "I couldn't see {app} because Screen Recording access is missing. "
    + "Grant Screen Recording to EchoPilot and ask again; I won't guess about what's on screen.",
  no_window: "I couldn't find a window for {app} to look at. "
    + "Bring it forward and ask again; I won't guess about what's on screen.",
  empty_context: "I couldn't read anything on {app}: no Accessibility text and no screenshot are available. "
    + 'Bring the content into view or grant access and ask again; '
    + "I won't guess about what's on screen.",
};

/** A model answer that is not the grounded shape is never repeated; the user gets this instead. */
export const UNGROUNDED_ANSWER_TEMPLATE = "I couldn't turn what was on {app} into a grounded answer, "
  + "so I won't repeat it. Ask again once the window is readable.";

const UNKNOWN_APP_NAME = 'the foreground app';
const ANSWER_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'evidenceIds'],
  properties: {
    text: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' } },
  },
};

type DesktopAnswerDraft = Readonly<{
  text: string;
  evidenceIds: ReadonlyArray<string>;
  capture: DesktopCaptureSummary;
}>;

export function renderTemplate(template: string, app: string): string {
  return template.split('{app}').join(app);
}

/** Stable, dependency-free id material so a replay of the same question is byte-identical. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** axNodes[i].value → 'desk:ax:<i>' and ocrSpans[i].text → 'desk:ocr:<i>', skipping blank entries. */
export function screenEvidence(snapshot: DesktopSnapshot): Readonly<{ evidenceIds: ReadonlyArray<string>; text: string }> {
  const evidenceIds: Array<string> = [];
  const parts: Array<string> = [];
  snapshot.axNodes.forEach((node, index) => {
    if (node.value.trim().length === 0) return;
    evidenceIds.push(`desk:ax:${index}`);
    parts.push(node.value);
  });
  snapshot.ocrSpans.forEach((span, index) => {
    if (span.text.trim().length === 0) return;
    evidenceIds.push(`desk:ocr:${index}`);
    parts.push(span.text);
  });
  return { evidenceIds, text: parts.join('\n') };
}

function estimateMaxTokens(charCount: number): number {
  const estimated = Math.ceil(Math.max(0, charCount) / 4) + 256;
  return Math.min(MAX_CONTEXT_TOKENS, Math.max(1, estimated));
}

function speechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0).length;
  return Math.max(1, Math.min(30, Math.ceil(words / 2.5)));
}

/** The grounded-answer contract, validated: `text` from the model, `evidenceIds` filtered to the context. */
function parseGroundedAnswer(
  output: unknown,
  contextEvidenceIds: ReadonlyArray<string>,
): Readonly<{ text: string; evidenceIds: ReadonlyArray<string> }> | null {
  if (typeof output !== 'object' || output === null) return null;
  const record = output as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (!Array.isArray(record.evidenceIds)) return null;
  const known = new Set(contextEvidenceIds);
  const evidenceIds: Array<string> = [];
  for (const entry of record.evidenceIds) {
    if (typeof entry !== 'string' || !known.has(entry) || evidenceIds.includes(entry)) continue;
    evidenceIds.push(entry);
  }
  return { text, evidenceIds };
}

export function createDesktopContextService(options: DesktopContextOptions): DesktopContextService {
  const { bridge, memory, reasoner, attention, voice, now, scope, excludedBundleIds } = options;
  const projectId = scope.projectId;
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new TypeError(
      'C01: createDesktopContextService requires an explicit project scope (scope.projectId); '
      + 'a desktop question is never answered from a scope-less, window-title-similarity memory query.',
    );
  }
  const excluded = new Set(
    excludedBundleIds.map((bundleId) => bundleId.trim().toLowerCase()).filter((bundleId) => bundleId.length > 0),
  );
  let speechSequence = 0;

  function speechEventId(surface: DesktopSurface, app: ForegroundApp | null, question: string): string {
    const material = `${surface}\u0000${app === null ? 'none' : app.bundleId}\u0000${question}`;
    return `desk-${surface}-question-${stableHash(material)}`;
  }

  async function speak(text: string, evidenceIds: ReadonlyArray<string>, eventId: string): Promise<boolean> {
    const expiresAt = new Date(now().getTime() + MAX_SPEECH_LEASE_MS).toISOString();
    const lease = attention.requestSpeech(eventId, expiresAt);
    if (lease === null) return false; // muted/silent: the answer stays visible-only, unchanged.
    speechSequence += 1;
    const planId = `desktop-context:${eventId}:${speechSequence}`;
    const plan: SpeechPlan = {
      planId,
      epoch: lease.epoch,
      priority: 'completion',
      expiresAt: lease.expiresAt,
      dedupeKey: `desktop-context:${eventId}`,
      segments: [
        {
          id: `${planId}:segment-1`,
          text,
          evidenceIds: [...evidenceIds],
          exact: false,
          maxSeconds: speechSeconds(text),
        },
      ],
      resume: 'discard',
    };
    try {
      await voice.submitSpeech(plan, lease);
      return true;
    } catch {
      // The answer is still shown; a playback failure is never reported as speech that happened.
      return false;
    }
  }

  async function finish(
    draft: DesktopAnswerDraft,
    eventId: string,
    question: string,
    surface: DesktopSurface,
  ): Promise<DesktopAnswer> {
    const spoken = await speak(draft.text, draft.evidenceIds, eventId);
    return {
      question,
      surface,
      text: draft.text,
      evidenceIds: draft.evidenceIds,
      capture: draft.capture,
      spoken,
    };
  }

  async function answer(input: Readonly<{ question: string; surface: DesktopSurface }>): Promise<DesktopAnswer> {
    const question = input.question;
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new TypeError('C01: the desktop question must be a non-empty string');
    }
    const surface = input.surface;

    const app = await bridge.foregroundApp();
    if (app === null) {
      return finish(
        {
          text: renderTemplate(LIMITED_CONTEXT_TEMPLATES.no_window, UNKNOWN_APP_NAME),
          evidenceIds: [],
          capture: { state: 'limited', app: UNKNOWN_APP_NAME, reason: 'no_window' },
        },
        speechEventId(surface, null, question),
        question,
        surface,
      );
    }
    const appName = app.name.trim().length > 0 ? app.name : app.bundleId;

    // Refuse before the bridge is asked: an excluded app is never captured, queried, or reasoned over.
    if (excluded.has(app.bundleId.trim().toLowerCase())) {
      return finish(
        {
          text: renderTemplate(EXCLUDED_APP_TEMPLATE, appName),
          evidenceIds: [],
          capture: { state: 'excluded', app: appName },
        },
        speechEventId(surface, app, question),
        question,
        surface,
      );
    }

    const outcome = await bridge.captureQuestionContext({ app, question });
    if (outcome.status === 'unavailable') {
      return finish(
        {
          text: renderTemplate(LIMITED_CONTEXT_TEMPLATES[outcome.reason], appName),
          evidenceIds: [],
          capture: { state: 'limited', app: appName, reason: outcome.reason },
        },
        speechEventId(surface, app, question),
        question,
        surface,
      );
    }

    const snapshot = outcome.snapshot;
    const screen = screenEvidence(snapshot);
    const hasPixels = typeof snapshot.screenshotRef === 'string' && snapshot.screenshotRef.trim().length > 0;
    if (screen.evidenceIds.length === 0 && !hasPixels) {
      // No AX text, no OCR, no screenshot: missing context, so no inference and no invented state.
      return finish(
        {
          text: renderTemplate(LIMITED_CONTEXT_TEMPLATES.empty_context, appName),
          evidenceIds: [],
          capture: { state: 'limited', app: appName, reason: 'empty_context' },
        },
        speechEventId(surface, app, question),
        question,
        surface,
      );
    }

    // Scope first: the explicit project association is the only thing that keeps the near-duplicate
    // note from another project out of the bounded context; window-title similarity is not a scope.
    const search = `${question}\n${screen.text}`.trim();
    const evidence = await memory.query(search, scope, MEMORY_EVIDENCE_BUDGET);
    const contextEvidenceIds = [...screen.evidenceIds, ...evidence.evidenceIds];
    const boundedContext: BoundedContext = {
      evidenceIds: contextEvidenceIds,
      maxTokens: estimateMaxTokens(screen.text.length + evidence.summary.length),
    };
    const output = await reasoner.run(
      {
        taskId: `desk-task-${stableHash(`${surface}\u0000${app.bundleId}\u0000${question}`)}`,
        instruction: `Answer the user's desktop question from the captured screen evidence and the `
          + `in-project memory only; cite only the provided evidence ids. Question: ${question}`,
      },
      boundedContext,
      ANSWER_SCHEMA,
      new AbortController().signal,
    );
    const grounded = parseGroundedAnswer(output, contextEvidenceIds);
    if (grounded === null) {
      return finish(
        {
          text: renderTemplate(UNGROUNDED_ANSWER_TEMPLATE, appName),
          evidenceIds: [],
          capture: { state: 'limited', app: appName },
        },
        speechEventId(surface, app, question),
        question,
        surface,
      );
    }
    return finish(
      { text: grounded.text, evidenceIds: grounded.evidenceIds, capture: { state: 'captured', app: appName } },
      speechEventId(surface, app, question),
      question,
      surface,
    );
  }

  return { answer };
}
