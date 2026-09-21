/**
 * A04 dictation seam — "real desktop dictation across apps → safe insertion under failures".
 *
 * Two things are pinned here, because both are decidable off-device with deterministic doubles and
 * both are the numbers BACKLOG A04 asks to be reproducible:
 *
 *   1. `scoreHeldOutDictation({ corpus, dictate })` scores the frozen 1,000-case held-out corpus.
 *      The system under test only ever receives the case fields a live dictation engine would have
 *      (committed transcript, term slots, project glossary, project memory evidence); gold
 *      transcripts, trap spans and case kinds remain labels on the oracle's side. This module
 *      re-scans the inserted text with its own copy of the A02 rule (`harmfulProtectedTokenEdits`)
 *      instead of trusting the engine's self-report, so a harness can never grade itself:
 *
 *        technicalTermErrorReduction = (baseline − corrected) / baseline  (0 when baseline is 0)
 *        harmfulSemanticEditRate     = cases with a protected-token change / caseCount
 *        withinTargets               = reduction ≥ 0.25 and rate ≤ 0.01
 *
 *      A `dictate` rejection is a fallback, never an improvement: the case is scored on the raw
 *      transcript and reported with `fallback: true`. An empty corpus is a TypeError.
 *
 *   2. `runDictationCompatibilityMatrix({ surfaces, transcript, excludedBundleIds, createBridge,
 *      createController, now })` drives the real A01 controller across the signed-app matrix
 *      (terminal, browser, IDE, secure field, second display, IME composition, app switch, revoked
 *      Accessibility trust, denied Screen Recording) through one raw native double per surface.
 *      The declared expectation is deliberately *not* an input — the behavior is derived, and the
 *      runner's audit is built from what the double actually saw, not from what the runner meant:
 *
 *        - secure fields, active IME compositions and revoked Accessibility trust are preview-only:
 *          no Accessibility write, no clipboard write, no key synthesis, draft preserved;
 *        - a focus that moved after the commit writes nothing anywhere (focus_changed);
 *        - every write carries `submit: false`, and the only key ever synthesized is the
 *          `command+v` paste chord — Return/Enter is never sent, and no application is activated;
 *        - the clipboard fallback borrows the pasteboard and restores it only while the change
 *          count proves the user has not replaced it; a copy made during the paste wins and the
 *          restoration stands down;
 *        - capture and insertion latencies are injected-clock spans, aggregated with the seam's
 *          nearest-rank percentile `sorted[min(n − 1, ceil(q·n) − 1)]`; an over-budget sample is
 *          reported as a budget violation, never hidden or rounded away;
 *        - missing-context behavior (denied capture ⇒ transcript-only, still inserted) and the undo
 *          limits (single-level, snapshot restore discards post-insertion typing, the app's own undo
 *          stack is separate) are reported as text plus measurements;
 *        - `digest` covers the whole report without itself, so two runs over the same doubles are
 *          byte-identical and the measurement is reproducible.
 *
 * What is *not* decided here: real microphone ASR, the local reasoner weights, the signed helper,
 * real TCC consent, a real IME and a second physical display. Those need manual qualification on a
 * signed build, and this report is the structure that qualification fills in. The measurements
 * below are deterministic-double measurements and are labelled as such — never as a device pass.
 */
import { createHash } from 'node:crypto';

import {
  AX_CAPTURE_BUDGET,
  PASTE_KEYSTROKE,
  type CaptureBridge,
  type CapturePreview,
  type CaptureRequest,
  type CaptureOutcome,
  type CaptureTarget,
  type DictationController,
  type InsertOutcome,
  type InsertRequest,
  type UndoOutcome,
} from '../../../capture/src/index.js';
import { harmfulProtectedTokenEdits } from '../../../capture/src/correction/index.js';
import type { GlossaryEntry, ProjectMemoryEvidence } from '../../../capture/src/context/index.js';

/** ≥25% fewer technical-term errors on held-out data (BACKLOG A04 accept 1). */
export const A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET = 0.25;
/** ≤1% harmful semantic edits on held-out data (BACKLOG A04 accept 1). */
export const A04_HARMFUL_SEMANTIC_EDIT_CEILING = 0.01;
/**
 * Plan §4.4: a capture bundle ≤500 ms p95, and end of utterance → corrected insertion ≤1.5 s p50 /
 * 3 s p95 for warm local dictation.
 */
export const A04_LATENCY_BUDGETS: Readonly<{
  captureBundleMs: number;
  insertionWarmP50Ms: number;
  insertionWarmP95Ms: number;
}> = Object.freeze({
  captureBundleMs: 500,
  insertionWarmP50Ms: 1500,
  insertionWarmP95Ms: 3000,
});

/* ------------------------------------------------------------------ held-out scoring ---- */

export interface A04TechnicalTerm {
  readonly spoken: string;
  readonly canonical: string;
  readonly start: number;
  readonly end: number;
}

/** A held-out utterance as the engine may see it: labels stay on the scorer's side of the seam. */
export interface A04HeldOutCase {
  readonly caseId: string;
  readonly rawTranscript: string;
  readonly technicalTerms: ReadonlyArray<A04TechnicalTerm>;
  readonly glossary: ReadonlyArray<GlossaryEntry>;
  readonly memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
}

export interface A04DictationRequest {
  readonly caseId: string;
  readonly rawTranscript: string;
  readonly glossary: ReadonlyArray<GlossaryEntry>;
  readonly memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
}

export interface A04HeldOutCaseReport {
  readonly caseId: string;
  readonly rawTranscript: string;
  readonly insertedText: string;
  readonly termErrorsBefore: number;
  readonly termErrorsAfter: number;
  readonly harmfulEdits: number;
  readonly fallback: boolean;
}

export interface A04HeldOutReport {
  readonly caseCount: number;
  readonly baselineTechnicalTermErrors: number;
  readonly correctedTechnicalTermErrors: number;
  readonly technicalTermErrorReduction: number;
  readonly harmfulSemanticEdits: number;
  readonly harmfulSemanticEditRate: number;
  readonly withinTechnicalTermTarget: boolean;
  readonly withinHarmfulEditCeiling: boolean;
  readonly withinTargets: boolean;
  readonly cases: ReadonlyArray<A04HeldOutCaseReport>;
}

export interface A04ScoreHeldOutInput {
  readonly corpus: Readonly<{ cases: ReadonlyArray<A04HeldOutCase> }>;
  readonly dictate: (request: A04DictationRequest) => Promise<string>;
}

/** A02-shaped slot count: a term is an error while its canonical form is absent from the text. */
function countTermErrors(text: string, technicalTerms: ReadonlyArray<A04TechnicalTerm>): number {
  let errors = 0;
  for (const term of technicalTerms) {
    if (typeof term?.canonical !== 'string' || term.canonical.length === 0) {
      throw new TypeError('scoreHeldOutDictation requires every term slot to carry a canonical form');
    }
    if (!text.includes(term.canonical)) errors += 1;
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scores the held-out dictation corpus: baseline vs corrected technical-term errors, and the
 * protected-token semantic damage the inserted text carries. Independent of the engine's own
 * reporting, and safe against a harness that throws: a rejection never buys a better number.
 */
export async function scoreHeldOutDictation(input: A04ScoreHeldOutInput): Promise<A04HeldOutReport> {
  if (!isRecord(input)) throw new TypeError('scoreHeldOutDictation requires { corpus, dictate }');
  const corpus = (input as { corpus?: unknown }).corpus;
  const cases = isRecord(corpus) ? (corpus as { cases?: unknown }).cases : undefined;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new TypeError('scoreHeldOutDictation requires a non-empty held-out corpus: a metric over no data is not a pass');
  }
  const dictate = (input as { dictate?: unknown }).dictate;
  if (typeof dictate !== 'function') {
    throw new TypeError('scoreHeldOutDictation requires dictate({ caseId, rawTranscript, glossary, memoryEvidence })');
  }
  const run = dictate as A04ScoreHeldOutInput['dictate'];

  const reports: Array<A04HeldOutCaseReport> = [];
  let baselineTechnicalTermErrors = 0;
  let correctedTechnicalTermErrors = 0;
  let harmfulCases = 0;

  for (const candidate of cases as ReadonlyArray<A04HeldOutCase>) {
    if (!isRecord(candidate)) throw new TypeError('scoreHeldOutDictation requires case objects');
    const caseId = candidate.caseId;
    const rawTranscript = candidate.rawTranscript;
    if (typeof caseId !== 'string' || caseId.length === 0) {
      throw new TypeError('scoreHeldOutDictation requires every case to carry a caseId');
    }
    if (typeof rawTranscript !== 'string') {
      throw new TypeError(`scoreHeldOutDictation requires the committed transcript for ${caseId}`);
    }
    const technicalTerms = Array.isArray(candidate.technicalTerms) ? candidate.technicalTerms : [];
    const glossary = Array.isArray(candidate.glossary) ? candidate.glossary : [];
    const memoryEvidence = Array.isArray(candidate.memoryEvidence) ? candidate.memoryEvidence : [];

    // Only the fields a live engine sees cross the seam; gold text, trap spans and kind labels stay
    // on this side. A rejection is a fallback on the raw transcript, never a silent improvement.
    let insertedText = rawTranscript;
    let fallback = false;
    try {
      const dictated = await run({ caseId, rawTranscript, glossary, memoryEvidence });
      if (typeof dictated === 'string') insertedText = dictated;
      else fallback = true;
    } catch {
      fallback = true;
    }

    const termErrorsBefore = countTermErrors(rawTranscript, technicalTerms);
    const termErrorsAfter = countTermErrors(insertedText, technicalTerms);
    const harmfulEdits = harmfulProtectedTokenEdits(rawTranscript, insertedText);

    baselineTechnicalTermErrors += termErrorsBefore;
    correctedTechnicalTermErrors += termErrorsAfter;
    if (harmfulEdits > 0) harmfulCases += 1;
    reports.push({
      caseId,
      rawTranscript,
      insertedText,
      termErrorsBefore,
      termErrorsAfter,
      harmfulEdits,
      fallback,
    });
  }

  const caseCount = reports.length;
  const technicalTermErrorReduction = baselineTechnicalTermErrors > 0
    ? (baselineTechnicalTermErrors - correctedTechnicalTermErrors) / baselineTechnicalTermErrors
    : 0;
  const harmfulSemanticEditRate = harmfulCases / caseCount;
  const withinTechnicalTermTarget = technicalTermErrorReduction >= A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET;
  const withinHarmfulEditCeiling = harmfulSemanticEditRate <= A04_HARMFUL_SEMANTIC_EDIT_CEILING;

  return {
    caseCount,
    baselineTechnicalTermErrors,
    correctedTechnicalTermErrors,
    technicalTermErrorReduction,
    harmfulSemanticEdits: harmfulCases,
    harmfulSemanticEditRate,
    withinTechnicalTermTarget,
    withinHarmfulEditCeiling,
    withinTargets: withinTechnicalTermTarget && withinHarmfulEditCeiling,
    cases: reports,
  };
}

/* -------------------------------------------------- signed-app insertion matrix ---- */

export interface A04SurfaceProfile {
  readonly key: string;
  readonly app: string;
  readonly bundleId: string;
  readonly role: string;
  readonly displayId: number;
  readonly secure: boolean;
  readonly editable: boolean;
  readonly imeComposing: boolean;
  readonly accessibilityTrust: 'granted' | 'revoked' | 'prompt';
  readonly insertMethod: 'accessibility' | 'clipboard' | 'unsupported';
  readonly switchesAwayAfterCommit: boolean;
  readonly simulatedLatencyMs: Readonly<{ capture: number; insert: number; keyStroke: number }>;
  readonly userCopiesDuringPaste: boolean;
}

export interface A04TimingSample {
  readonly surfaceKey: string;
  readonly measuredMs: number;
}

export interface A04BudgetViolation {
  readonly surfaceKey: string;
  readonly metric: string;
  readonly measuredMs: number;
  readonly budgetMs: number;
}

export interface A04TimingSamples {
  readonly metric: string;
  readonly budgetMs: number;
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly withinBudget: boolean;
  readonly samples: ReadonlyArray<A04TimingSample>;
  readonly budgetViolations: ReadonlyArray<A04BudgetViolation>;
}

export type A04SurfaceBehavior = 'insert' | 'preview_only' | 'focus_changed';

export interface A04SurfaceReport {
  readonly surfaceKey: string;
  readonly app: string;
  readonly behavior: A04SurfaceBehavior;
  readonly method: 'accessibility' | 'clipboard' | null;
  readonly insertedText: string | null;
  readonly draftPreserved: boolean;
  readonly previewMode: 'context' | 'transcript_only';
  readonly submitFlags: ReadonlyArray<boolean>;
  readonly keysSynthesized: ReadonlyArray<string>;
  readonly activations: ReadonlyArray<string>;
  readonly undo: Readonly<{ first: string; second: string | null }>;
}

export interface A04MissingContextMeasurement {
  readonly surfaceKey: string;
  readonly previewMode: string;
  readonly inserted: boolean;
  readonly redactions: Readonly<{ secureNodes: number; excludedNodes: number; excludedSpans: number }> | null;
}

export interface A04MatrixReport {
  readonly surfaces: ReadonlyArray<A04SurfaceReport>;
  readonly audit: Readonly<{
    surfacesRun: number;
    insertedWrites: number;
    unexpectedSubmissions: number;
    synthesizedKeys: ReadonlyArray<Readonly<{ surfaceKey: string; key: string }>>;
    activations: ReadonlyArray<Readonly<{ surfaceKey: string; bundleId: string }>>;
    clipboardRestored: ReadonlyArray<string>;
    clipboardUserChangesPreserved: ReadonlyArray<string>;
    clipboardViolations: ReadonlyArray<Readonly<{ surfaceKey: string; detail: string }>>;
    previewOnlyMismatches: ReadonlyArray<string>;
    limitations: ReadonlyArray<string>;
  }>;
  readonly timing: Readonly<{ capture: A04TimingSamples; insertion: A04TimingSamples }>;
  readonly missingContext: Readonly<{
    behavior: string;
    measurements: ReadonlyArray<A04MissingContextMeasurement>;
  }>;
  readonly undo: Readonly<{
    limitations: ReadonlyArray<string>;
    measurements: ReadonlyArray<Readonly<{ surfaceKey: string; action: string; status: string }>>;
  }>;
  readonly digest: string;
}

export interface A04MatrixInput {
  readonly surfaces: ReadonlyArray<A04SurfaceProfile>;
  readonly transcript: string;
  readonly excludedBundleIds: ReadonlyArray<string>;
  readonly createBridge: (surface: A04SurfaceProfile) => CaptureBridge;
  readonly createController: (input: Readonly<{
    bridge: CaptureBridge;
    excludedBundleIds: ReadonlyArray<string>;
  }>) => DictationController;
  readonly now: () => number;
}

/**
 * What the runner observed through the wrapped bridge for one surface. The runner never infers a
 * write from its own intent: these are the calls the double actually received.
 */
type BridgeObservation = {
  inserts: Array<{ text: string; submit: boolean }>;
  keys: Array<string>;
  activations: Array<string>;
  clipboardWrites: Array<string>;
  /** Change-count movement while the paste keystroke was in flight: the user wrote the pasteboard. */
  changeCountDeltaDuringPasteKey: number;
  /** The pasteboard text immediately after the paste keystroke returned. */
  textAfterPasteKey: string | null;
};

/**
 * Wraps the native double so every call the rules layer makes is observed: writes, keys, focus
 * activations, clipboard reads/writes and the change count around the paste keystroke. The bridge's
 * behavior is untouched — the wrapper only records.
 */
function instrumentBridge(raw: CaptureBridge): Readonly<{ bridge: CaptureBridge; observation: BridgeObservation }> {
  const observation: BridgeObservation = {
    inserts: [],
    keys: [],
    activations: [],
    clipboardWrites: [],
    changeCountDeltaDuringPasteKey: 0,
    textAfterPasteKey: null,
  };
  const bridge: CaptureBridge = {
    currentTarget: (): Promise<CaptureTarget | null> => raw.currentTarget(),
    captureContext: (request: CaptureRequest): Promise<CaptureOutcome> => raw.captureContext(request),
    insertText: async (request: InsertRequest): Promise<InsertOutcome> => {
      const submitted = (request as { submit?: unknown }).submit;
      observation.inserts.push({ text: request.text, submit: submitted !== false });
      return raw.insertText(request);
    },
    undo: (request: Readonly<{ transactionId: string }>): Promise<UndoOutcome> => raw.undo(request),
    clipboard: {
      changeCount: (): number => raw.clipboard.changeCount(),
      readText: (): string => raw.clipboard.readText(),
      writeText: (text: string): void => {
        observation.clipboardWrites.push(text);
        raw.clipboard.writeText(text);
      },
    },
    sendKey: async (key: string): Promise<void> => {
      observation.keys.push(key);
      const before = raw.clipboard.changeCount();
      await raw.sendKey(key);
      // The user can replace the clipboard while the paste keystroke is in flight, which is what
      // the transactional fallback must notice; the change count is the only signal it has.
      observation.changeCountDeltaDuringPasteKey += raw.clipboard.changeCount() - before;
      observation.textAfterPasteKey = raw.clipboard.readText();
    },
    activateApplication: async (bundleId: string): Promise<void> => {
      observation.activations.push(bundleId);
      await raw.activateApplication(bundleId);
    },
  };
  return { bridge, observation };
}

/** Nearest-rank percentile, exactly as the frozen seam defines it: sorted[min(n − 1, ceil(q·n) − 1)]. */
function percentile(values: ReadonlyArray<number>, q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

function timingReport(
  metric: string,
  budgetMs: number,
  samples: ReadonlyArray<A04TimingSample>,
  withinBudget: boolean,
  violationBudgetMs: number,
): A04TimingSamples {
  const values = samples.map((sample) => sample.measuredMs);
  return {
    metric,
    budgetMs,
    sampleCount: samples.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length === 0 ? 0 : Math.max(...values),
    withinBudget,
    samples: [...samples],
    budgetViolations: samples
      .filter((sample) => sample.measuredMs > violationBudgetMs)
      .map((sample) => ({
        surfaceKey: sample.surfaceKey,
        metric,
        measuredMs: sample.measuredMs,
        budgetMs: violationBudgetMs,
      })),
  };
}

/** The documented failure modes of the insertion path, measured by the matrix above. */
const MATRIX_LIMITATIONS: ReadonlyArray<string> = Object.freeze([
  'Clipboard rule: the pasteboard is borrowed and restored only while the change count proves the user did not replace it, so dictation must never overwrite a copy the user made while the paste was in flight.',
  'Focus-change refusal: the captured element fingerprint is revalidated before every write; when focus moved, nothing is written anywhere, no clipboard is touched and the draft is preserved for the user.',
  'Accessibility capabilities are not guaranteed: the helper can report the Accessibility write unsupported, and the only fallback is the transactional paste of the command+v chord — Return/Enter is never synthesized, so a submitted line is impossible.',
  'Missing context is not a write failure: a denied Screen Recording capture previews transcript-only with no screenshot, and the committed transcript is still inserted, so dictation works with no context at all.',
  'Secure fields and active IME compositions are preview-only: the words are never lost, but no write, no clipboard and no key may reach the surface until the field is safe and the composition ends.',
  'These measurements come from deterministic native doubles, not from a signed helper: TCC consent prompts, real IME state and real AX timing need the hardware qualification on a signed build.',
].map((line) => line.trim()));

/** The documented undo limits, measured by the matrix above. */
const UNDO_LIMITATIONS: ReadonlyArray<string> = Object.freeze([
  'Undo is single-level: the insertion transaction is spent by the first undo, and a second undo on the same surface reports nothing_to_undo.',
  'Undo restores the pre-insertion snapshot, so anything the user typed after the insertion is discarded together with the dictated text.',
  'Undo covers only the insertion transaction; the application keeps its own undo stack, and an app-level undo after ours is a separate history entry, not a redo of the insertion.',
  'A preview-only or focus-changed surface has nothing to undo, so undo reports nothing_to_undo there: no user text was ever replaced.',
].map((line) => line.trim()));

const MISSING_CONTEXT_BEHAVIOR = [
  'Missing context never blocks dictation: when Screen Recording consent is denied, the focused app is excluded, or no target is focused, the preview is transcript-only (no screenshot, no bundle, no redactions) and the committed transcript is still inserted into the revalidated target.',
  'Every other surface previews a context bundle whose secure AX nodes, excluded-bundle nodes and excluded OCR spans were removed before the bundle existed; the redaction counts per surface are reported below.',
  'A secure focused field contributes no screenshot, selection, AX value or OCR span even when the helper returns them, and an over-budget capture bundle is reported as a budget violation instead of being hidden.',
].join(' ');

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/**
 * Drives one preview/commit/insert/undo cycle per surface through the real A01 controller and
 * reports what the native doubles actually observed. The behavior is derived, never assumed: the
 * profile's own limits (secure field, active IME composition, revoked Accessibility trust) refuse
 * the write before it is attempted, and the controller's revalidation decides the app-switch case.
 */
export async function runDictationCompatibilityMatrix(input: A04MatrixInput): Promise<A04MatrixReport> {
  if (!isRecord(input)) throw new TypeError('runDictationCompatibilityMatrix requires a matrix input');
  const surfaces = (input as { surfaces?: unknown }).surfaces;
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    throw new TypeError('runDictationCompatibilityMatrix requires at least one signed-app surface');
  }
  const { transcript, excludedBundleIds, createBridge, createController, now } = input;
  if (typeof transcript !== 'string' || transcript.length === 0) {
    throw new TypeError('runDictationCompatibilityMatrix requires the committed transcript');
  }
  if (typeof createBridge !== 'function' || typeof createController !== 'function' || typeof now !== 'function') {
    throw new TypeError('runDictationCompatibilityMatrix requires createBridge, createController and the injected now()');
  }

  const surfaceReports: Array<A04SurfaceReport> = [];
  const captureSamples: Array<A04TimingSample> = [];
  const insertionSamples: Array<A04TimingSample> = [];
  const missingContextMeasurements: Array<A04MissingContextMeasurement> = [];
  const undoMeasurements: Array<{ surfaceKey: string; action: string; status: string }> = [];
  const clipboardRestored: Array<string> = [];
  const clipboardUserChangesPreserved: Array<string> = [];
  const clipboardViolations: Array<{ surfaceKey: string; detail: string }> = [];
  const previewOnlyMismatches: Array<string> = [];
  const synthesizedKeys: Array<{ surfaceKey: string; key: string }> = [];
  const activations: Array<{ surfaceKey: string; bundleId: string }> = [];
  let unexpectedSubmissions = 0;
  let insertedWrites = 0;

  for (const surface of surfaces as ReadonlyArray<A04SurfaceProfile>) {
    if (!isRecord(surface) || typeof surface.key !== 'string' || typeof surface.app !== 'string') {
      throw new TypeError('runDictationCompatibilityMatrix requires surfaces with a key and an app name');
    }
    const rawBridge = createBridge(surface);
    const { bridge, observation } = instrumentBridge(rawBridge);
    const controller = createController({ bridge, excludedBundleIds });
    const previousClipboardText = rawBridge.clipboard.readText();

    // Capture: the helper may still refuse (Screen Recording denied); the measured span is the
    // injected-clock cost of `beginUtterance` either way, and the preview reports its own mode.
    const captureStartedAt = now();
    const preview: CapturePreview = await controller.beginUtterance();
    const captureMs = Math.max(0, now() - captureStartedAt);

    await controller.commitTranscript(transcript);

    // The surface's own limits refuse the write before the attempt: a secure field, an active IME
    // composition and revoked Accessibility trust keep the words in the preview, never in the
    // field. Everything else is decided by the controller's fingerprint revalidation.
    const previewOnly = surface.secure
      || surface.imeComposing
      || surface.accessibilityTrust !== 'granted'
      || !surface.editable;

    let behavior: A04SurfaceBehavior = 'preview_only';
    let method: 'accessibility' | 'clipboard' | null = null;
    let insertedText: string | null = null;
    let insertionMs: number | null = null;
    if (!previewOnly) {
      const writeStartedAt = now();
      const result = await controller.insert();
      if (result.status === 'inserted') {
        behavior = 'insert';
        method = result.method;
        insertedText = result.text;
        insertionMs = Math.max(0, now() - writeStartedAt);
        insertedWrites += 1;
      } else if (result.status === 'focus_changed') {
        behavior = 'focus_changed';
      }
    }

    // Undo is called once per surface so `nothing_to_undo` is an observation; a surface that wrote
    // text gets the second call too, because undo is single-level and the report must say so.
    const undoFirst = (await controller.undo()).status;
    let undoSecond: string | null = null;
    if (behavior === 'insert') undoSecond = (await controller.undo()).status;

    captureSamples.push({ surfaceKey: surface.key, measuredMs: captureMs });
    if (insertionMs !== null) insertionSamples.push({ surfaceKey: surface.key, measuredMs: insertionMs });
    undoMeasurements.push({ surfaceKey: surface.key, action: 'undo', status: undoFirst });
    if (undoSecond !== null) {
      undoMeasurements.push({ surfaceKey: surface.key, action: 'undo_again', status: undoSecond });
    }
    missingContextMeasurements.push({
      surfaceKey: surface.key,
      previewMode: preview.mode,
      inserted: behavior === 'insert',
      redactions: preview.mode === 'transcript_only'
        ? null
        : {
          secureNodes: preview.bundle.redactions.secureNodes,
          excludedNodes: preview.bundle.redactions.excludedNodes,
          excludedSpans: preview.bundle.redactions.excludedSpans,
        },
    });
    for (const key of observation.keys) synthesizedKeys.push({ surfaceKey: surface.key, key });
    for (const bundleId of observation.activations) activations.push({ surfaceKey: surface.key, bundleId });
    for (const request of observation.inserts) {
      if (request.submit) unexpectedSubmissions += 1;
    }
    if (behavior !== 'insert' && (
      observation.inserts.length > 0 || observation.keys.length > 0 || observation.clipboardWrites.length > 0
    )) {
      // A surface that was not allowed to write (or whose focus moved) received a write anyway.
      previewOnlyMismatches.push(surface.key);
    }
    for (const key of observation.keys) {
      if (key !== PASTE_KEYSTROKE) {
        clipboardViolations.push({
          surfaceKey: surface.key,
          detail: `key synthesis outside the clipboard fallback: ${JSON.stringify(key)}`,
        });
      }
    }

    // What the double's pasteboard did, from the calls it received: the transcript is borrowed,
    // the previous contents are restored only when nobody replaced the clipboard in the meantime,
    // and a user copy made during the paste is what must survive.
    const clipboardAfterInsert = rawBridge.clipboard.readText();
    if (method === 'clipboard') {
      if (observation.clipboardWrites.length === 0) {
        clipboardViolations.push({
          surfaceKey: surface.key,
          detail: 'the clipboard fallback reported an insertion without writing the transcript to the pasteboard',
        });
      }
      const restored = observation.clipboardWrites.length >= 2
        && observation.clipboardWrites[1] === previousClipboardText
        && clipboardAfterInsert === previousClipboardText;
      if (observation.changeCountDeltaDuringPasteKey > 0) {
        if (restored) {
          clipboardViolations.push({
            surfaceKey: surface.key,
            detail: 'the previous clipboard contents were restored over the copy the user made during the paste',
          });
        } else if (clipboardAfterInsert !== observation.textAfterPasteKey) {
          clipboardViolations.push({
            surfaceKey: surface.key,
            detail: "the clipboard no longer holds the copy the user made during the paste",
          });
        } else {
          clipboardUserChangesPreserved.push(surface.key);
        }
      } else if (restored) {
        clipboardRestored.push(surface.key);
      } else {
        clipboardViolations.push({
          surfaceKey: surface.key,
          detail: 'the previous clipboard contents were not restored after the paste',
        });
      }
    } else if (observation.clipboardWrites.length > 0) {
      clipboardViolations.push({
        surfaceKey: surface.key,
        detail: 'the clipboard was written on a surface that never pastes',
      });
    }

    surfaceReports.push({
      surfaceKey: surface.key,
      app: surface.app,
      behavior,
      method,
      insertedText,
      draftPreserved: behavior !== 'insert',
      previewMode: preview.mode,
      submitFlags: observation.inserts.map((request) => request.submit),
      keysSynthesized: [...observation.keys],
      activations: [...observation.activations],
      undo: { first: undoFirst, second: undoSecond },
    });
  }

  const captureValues = captureSamples.map((sample) => sample.measuredMs);
  const captureP95 = percentile(captureValues, 0.95);
  const insertionValues = insertionSamples.map((sample) => sample.measuredMs);
  const insertionP50 = percentile(insertionValues, 0.5);
  const insertionP95 = percentile(insertionValues, 0.95);

  const report = {
    surfaces: surfaceReports,
    audit: {
      surfacesRun: surfaces.length,
      insertedWrites,
      unexpectedSubmissions,
      synthesizedKeys,
      activations,
      clipboardRestored,
      clipboardUserChangesPreserved,
      clipboardViolations,
      previewOnlyMismatches,
      limitations: [...MATRIX_LIMITATIONS],
    },
    timing: {
      capture: timingReport(
        'capture',
        A04_LATENCY_BUDGETS.captureBundleMs,
        captureSamples,
        captureP95 <= A04_LATENCY_BUDGETS.captureBundleMs,
        A04_LATENCY_BUDGETS.captureBundleMs,
      ),
      insertion: timingReport(
        'insertion',
        A04_LATENCY_BUDGETS.insertionWarmP95Ms,
        insertionSamples,
        insertionP50 <= A04_LATENCY_BUDGETS.insertionWarmP50Ms
          && insertionP95 <= A04_LATENCY_BUDGETS.insertionWarmP95Ms,
        A04_LATENCY_BUDGETS.insertionWarmP95Ms,
      ),
    },
    missingContext: {
      behavior: MISSING_CONTEXT_BEHAVIOR,
      measurements: missingContextMeasurements,
    },
    undo: {
      limitations: [...UNDO_LIMITATIONS],
      measurements: undoMeasurements,
    },
  };

  // The digest covers the whole report without itself: two runs over the same doubles are
  // byte-identical, so a measurement can be re-derived instead of trusted.
  return { ...report, digest: sha256Json(report) };
}

/** The capture budget every matrix surface is measured against, re-exported for the report reader. */
export const A04_AX_CAPTURE_BUDGET = AX_CAPTURE_BUDGET;
