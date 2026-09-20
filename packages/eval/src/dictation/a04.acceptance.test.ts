/**
 * A04 acceptance oracle — real desktop dictation across apps → safe insertion under failures
 * (IMPLEMENTATION_PLAN.md §7.2 A04; plan §4.4 dictation latency, §5.3/§5.4 capture + insertion;
 * BACKLOG A04).
 *
 * BACKLOG A04 accept:
 *   1. ≥25% technical-term error reduction and ≤1% harmful semantic edits on held-out data;
 *   2. all insertion tests avoid unexpected submission, and clipboard changes by the user are
 *      preserved;
 *   3. capture and insertion timing, missing-context behavior, and undo limitations are documented
 *      with reproducible measurements.
 *
 * Real ASR, the local reasoner, the signed macOS helper and the Accessibility/Screen Recording
 * consent prompts need hardware, so every criterion that is decidable off-device is decided here
 * with deterministic doubles, and the remaining interactive qualification is reported as a
 * limitation rather than claiming a hardware pass:
 *
 *   - criterion 1: the frozen 1,000-case held-out corpus (`fixtures/dictation/check-a04-corpus.mjs`)
 *     is scored through the real A02 corrector and the shared M02 assembler; this oracle recomputes
 *     the term-error and harmful-edit numbers independently from the inserted text (the harness is
 *     never allowed to grade itself);
 *   - criterion 2: the 12-surface signed-app matrix is driven through the real A01 controller with a
 *     raw native double per surface (terminals, browsers, IDEs, secure fields, multiple displays,
 *     IME composition, app switching, revoked permission, denied capture), and the runner's audit is
 *     compared against the double's own call log;
 *   - criterion 3: capture/insertion samples, missing-context behavior and undo limits are read from
 *     the runner's report and from ground truth, with the over-budget surface reported, never hidden.
 *
 * `packages/eval/src/dictation/index.ts` must export (this file pins these names; they are the frozen
 * A04 seam between the held-out scoring harness and the dictation engine):
 *
 *   A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET = 0.25
 *   A04_HARMFUL_SEMANTIC_EDIT_CEILING = 0.01
 *   A04_LATENCY_BUDGETS = { captureBundleMs: 500, insertionWarmP50Ms: 1500, insertionWarmP95Ms: 3000 }
 *     §4.4: capture bundle ≤500 ms p95; end of utterance → corrected insertion ≤1.5 s p50 / 3 s p95.
 *
 *   scoreHeldOutDictation({ corpus, dictate }) → Promise<report>
 *
 *     corpus  the held-out utterances exactly as the system under test may see them:
 *             { cases: [{ caseId, rawTranscript, technicalTerms: [{ spoken, canonical, start, end }],
 *                         glossary, memoryEvidence }] }.
 *             Gold transcripts, trap spans and case kinds are labels; they are never handed over, and
 *             this oracle scores them itself.
 *     dictate async ({ caseId, rawTranscript, glossary, memoryEvidence }) → the text dictation would
 *             insert. The case's own `rawTranscript`, `glossary` and `memoryEvidence` are handed over
 *             unchanged (this oracle asserts that before it lets a case be scored). A rejection is a
 *             fallback: the case is scored on the raw transcript and reported with `fallback: true`,
 *             so a crash can never look like an improvement.
 *
 *     Scored per case: a technical-term slot is an error when its canonical form does not appear in
 *     the text; a harmful semantic edit is any protected-token change, i.e. the real A02
 *     `harmfulProtectedTokenEdits(raw, inserted) > 0`.
 *
 *     report: { caseCount, baselineTechnicalTermErrors, correctedTechnicalTermErrors,
 *               technicalTermErrorReduction, harmfulSemanticEdits, harmfulSemanticEditRate,
 *               withinTechnicalTermTarget, withinHarmfulEditCeiling, withinTargets,
 *               cases: [{ caseId, rawTranscript, insertedText, termErrorsBefore, termErrorsAfter,
 *                         harmfulEdits, fallback }] }
 *       reduction = (baseline − corrected) / baseline, 0 when the baseline is 0; the harmful rate
 *       counts harmful cases over caseCount; withinTechnicalTermTarget = reduction ≥ 0.25;
 *       withinHarmfulEditCeiling = rate ≤ 0.01; withinTargets = both. An empty corpus is a
 *       TypeError: a metric computed on no data is not a pass.
 *
 *   runDictationCompatibilityMatrix({ surfaces, transcript, excludedBundleIds, createBridge,
 *                                     createController, now }) → Promise<report>
 *
 *     surfaces  per signed-app surface: { key, app, bundleId, role, displayId, secure, editable,
 *               imeComposing, accessibilityTrust: 'granted' | 'revoked' | 'prompt', insertMethod:
 *               'accessibility' | 'clipboard' | 'unsupported', switchesAwayAfterCommit,
 *               simulatedLatencyMs, userCopiesDuringPaste }. The declared expectation ('insert',
 *               'preview_only', 'focus_changed') is deliberately NOT an input: the runner derives the
 *               behavior and this oracle compares it against the fixture.
 *     createBridge(surface) → CaptureBridge   the native double for that surface (hardware-free)
 *     createController({ bridge, excludedBundleIds }) → DictationController
 *     now() → ms                              the injected clock every measurement uses
 *
 *     Behavior fixed here:
 *       - one preview per surface, then the committed transcript, then at most one insertion;
 *       - a secure field, an active IME composition and revoked Accessibility trust are preview-only:
 *         no insertText call, no clipboard write, no key synthesis, and the committed draft is
 *         preserved (the words are never lost);
 *       - a surface whose focus moved after the commit reports focus_changed: nothing is written
 *         anywhere and the draft is preserved;
 *       - every insertText request carries submit: false, and the only key that may be synthesized is
 *         the paste chord `command+v` on a clipboard surface — never Return/Enter;
 *       - activateApplication is never called: dictation must not steal focus;
 *       - the clipboard fallback restores the previous contents only when the change count proves the
 *         user has not replaced the clipboard; a user copy made while the paste is in flight wins;
 *       - capture and insertion are timed with the injected clock; the nearest-rank percentile is
 *         sorted[min(n − 1, ceil(q·n) − 1)]; over-budget samples are reported as budget violations,
 *         never hidden or rounded away;
 *       - missing-context behavior, undo limits and their measurements are reported as text plus
 *         measurements;
 *       - digest = 'sha256:' + sha256(JSON.stringify(report without digest)), so two runs over the
 *         same doubles are byte-identical and the measurement is reproducible.
 *
 *     report: { surfaces: [{ surfaceKey, app, behavior, method, insertedText, draftPreserved,
 *                            previewMode, submitFlags, keysSynthesized, activations, undo }],
 *               audit: { surfacesRun, insertedWrites, unexpectedSubmissions, synthesizedKeys,
 *                        activations, clipboardRestored, clipboardUserChangesPreserved,
 *                        clipboardViolations, previewOnlyMismatches, limitations },
 *               timing: { capture: TimingSamples, insertion: TimingSamples },
 *               missingContext: { behavior, measurements },
 *               undo: { limitations, measurements },
 *               digest }
 *       TimingSamples = { metric, budgetMs, sampleCount, p50Ms, p95Ms, maxMs, withinBudget,
 *                         samples: [{ surfaceKey, measuredMs }], budgetViolations }
 *       Capture samples are taken for every surface (the injected-clock span of `beginUtterance`);
 *       insertion samples only for surfaces that wrote text (the injected-clock span of the write:
 *       the Accessibility write, or the clipboard paste and its paste keystroke). `budgetMs` is
 *       captureBundleMs for capture and insertionWarmP95Ms for insertion. `withinBudget` is the
 *       metric's own gate: capture p95 ≤ captureBundleMs, insertion p50 ≤ insertionWarmP50Ms and p95
 *       ≤ insertionWarmP95Ms. Sample-level `budgetViolations` are reported against captureBundleMs /
 *       insertionWarmP95Ms respectively — an over-budget surface is measured and documented, never
 *       hidden.
 *
 *     Ordering and per-entry detail fixed by this oracle:
 *       - `surfaces`, `timing.capture.samples` and `missingContext.measurements` follow the matrix
 *         order they were given in, and `surfaces` covers every surface exactly once;
 *       - `draftPreserved` is true exactly when the draft was not written into the surface
 *         (preview-only or focus changed), so the words are still available to the user;
 *       - `previewMode` is the A01 preview's own mode: only denied capture (and an excluded app or
 *         no focused target) is 'transcript_only'; a secure field still previews a redacted bundle
 *         with no screenshot. `missingContext.measurements` carries the redaction counts of that
 *         preview bundle, or `redactions: null` for a transcript-only preview;
 *       - `submitFlags` are the `submit` values the bridge received, `keysSynthesized` the keys the
 *         runner synthesized on that surface, `activations` the applications it activated (empty);
 *       - `undo` per surface: `first` is the controller's outcome after the matrix ran ('undone'
 *         where text was written, 'nothing_to_undo' otherwise) and `second` is a second undo call on
 *         a surface that wrote text — single-level undo can only report 'nothing_to_undo' there, and
 *         `second` is null where no second call was made. `undo.measurements` mirrors this with one
 *         `action: 'undo'` entry per surface plus one `action: 'undo_again'` entry per write;
 *         `undo.limitations` documents at least three limits (single-level undo, the user typing
 *         after an insertion being discarded by that undo, and the app's own undo stack);
 *       - `audit.limitations` documents at least four failure-mode limits, covering the clipboard
 *         rule and the focus-change refusal among them.
 *
 * Remaining limitation (not automatable here): the digits above come from deterministic doubles and
 * the synthetic held-out corpus, not from a microphone, the local reasoner weights, the signed
 * helper, real TCC consent, a real IME, or a second physical display. Those need manual
 * qualification on a signed build; the runner's report is the structure that qualification fills in.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createContextAssembler, type AssembledContext, type ContextAssembler} from '../../../memory/src/context/index.js';
import {AX_CAPTURE_BUDGET, PASTE_KEYSTROKE, createDictationController, type CaptureBridge, type CaptureOutcome, type CaptureRequest, type CaptureTarget, type DictationController, type InsertOutcome, type InsertRequest, type UndoOutcome} from '../../../capture/src/index.js';
import {createDictationCorrector, harmfulProtectedTokenEdits} from '../../../capture/src/correction/index.js';
import type {GlossaryEntry, ProjectMemoryEvidence} from '../../../capture/src/context/index.js';

const CORPUS_SCRIPT = fileURLToPath(new URL('../../../../fixtures/dictation/check-a04-corpus.mjs', import.meta.url));
/** Frozen with `node fixtures/dictation/check-a04-corpus.mjs --summary`. */
const CORPUS_DIGEST = 'sha256:d397be76b0f47a84c95ba1b2143e92a2bcc94242aaee720f137ae5bab22bef16';
const CORPUS_CASE_COUNT = 1000;
const CORPUS_TRAP_CASE_COUNT = 100;
const CORPUS_CLEAN_CASE_COUNT = 100;
const CORPUS_SURFACE_COUNT = 12;
/** The raw transcripts carry this many term slots the microphone path misheard. */
const CORPUS_BASELINE_TERM_ERRORS = 1167;
/** The one surface where the user replaces the clipboard while the paste is in flight. */
const USER_CLIPBOARD_CHANGE_SURFACE = 'crm-screen-recording-denied';
const CLIPBOARD_BEFORE = 'prior user clipboard (synthetic)';
const CLIPBOARD_USER_COPY = 'user copied something during the paste (synthetic)';
const USER_TYPED_AFTER_INSERT = 'user keeps typing after insertion (synthetic)';
const MATRIX_TRANSCRIPT = 'serialize the Jason response as JSON without retrying';
const MODEL = {modelId: 'qwen2.5-14b-instruct', contextCapacity: 32768} as const;
/** The configured exclusion list from the matrix scope; the vault bundle is one of its entries. */
const EXCLUDED_VAULT_BUNDLE = 'com.elephant.secret-vault';
const EXCLUDED_BUNDLE_IDS: ReadonlyArray<string> = ['com.echopilot.widget', 'com.apple.SecurityAgent', EXCLUDED_VAULT_BUNDLE];
/** The module under test; the specifier is assembled at runtime so a missing file is behavior, not resolution. */
const A04_MODULE = ['.', 'index.js'].join('/');

type A04TechnicalTerm = Readonly<{spoken: string; canonical: string; start: number; end: number}>;
type A04Trap = Readonly<{kind: string; original: string; replacement: string; start: number; end: number}>;

type CorpusCase = Readonly<{
  caseId: string;
  app: string;
  kind: 'technical_error' | 'clean' | 'protected_trap';
  rawTranscript: string;
  goldTranscript: string;
  technicalTerms: ReadonlyArray<A04TechnicalTerm>;
  protectedTokens: ReadonlyArray<string>;
  glossary: ReadonlyArray<GlossaryEntry>;
  memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
  trap: A04Trap | null;
}>;

type CorpusSurface = Readonly<{
  key: string;
  app: string;
  bundleId: string;
  role: string;
  displayId: number;
  secure: boolean;
  editable: boolean;
  imeComposing: boolean;
  accessibilityTrust: 'granted' | 'revoked' | 'prompt';
  screenRecording: 'granted' | 'denied';
  insertMethod: 'accessibility' | 'clipboard' | 'unsupported';
  expect: 'insert' | 'preview_only' | 'focus_changed';
  switchesAwayAfterCommit: boolean;
  userEditsAfterInsert: boolean;
  simulatedLatencyMs: Readonly<{capture: number; insert: number; keyStroke: number}>;
  userCopiesDuringPaste: boolean;
  note: string;
}>;

type CorpusDocument = Readonly<{
  contractVersion: number;
  fixtureId: string;
  seed: string;
  consent: string;
  caseCount: number;
  cases: ReadonlyArray<CorpusCase>;
  surfaces: ReadonlyArray<CorpusSurface>;
  digest: string;
  stats: Readonly<Record<string, number>>;
}>;

/** The system-under-test view of a held-out case: no gold transcript, no trap, no kind label. */
type HeldOutCaseInput = Readonly<{
  caseId: string;
  rawTranscript: string;
  technicalTerms: ReadonlyArray<A04TechnicalTerm>;
  glossary: ReadonlyArray<GlossaryEntry>;
  memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
}>;

type HeldOutCaseReport = Readonly<{
  caseId: string;
  rawTranscript: string;
  insertedText: string;
  termErrorsBefore: number;
  termErrorsAfter: number;
  harmfulEdits: number;
  fallback: boolean;
}>;

type HeldOutReport = Readonly<{
  caseCount: number;
  baselineTechnicalTermErrors: number;
  correctedTechnicalTermErrors: number;
  technicalTermErrorReduction: number;
  harmfulSemanticEdits: number;
  harmfulSemanticEditRate: number;
  withinTechnicalTermTarget: boolean;
  withinHarmfulEditCeiling: boolean;
  withinTargets: boolean;
  cases: ReadonlyArray<HeldOutCaseReport>;
}>;

/** A surface profile: the native facts, without the expectation the runner must derive. */
type SurfaceProfile = Readonly<{
  key: string;
  app: string;
  bundleId: string;
  role: string;
  displayId: number;
  secure: boolean;
  editable: boolean;
  imeComposing: boolean;
  accessibilityTrust: 'granted' | 'revoked' | 'prompt';
  insertMethod: 'accessibility' | 'clipboard' | 'unsupported';
  switchesAwayAfterCommit: boolean;
  simulatedLatencyMs: Readonly<{capture: number; insert: number; keyStroke: number}>;
  userCopiesDuringPaste: boolean;
}>;

type TimingSample = Readonly<{surfaceKey: string; measuredMs: number}>;
type BudgetViolation = Readonly<{surfaceKey: string; metric: string; measuredMs: number; budgetMs: number}>;
type TimingSamples = Readonly<{
  metric: string;
  budgetMs: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  withinBudget: boolean;
  samples: ReadonlyArray<TimingSample>;
  budgetViolations: ReadonlyArray<BudgetViolation>;
}>;

type SurfaceReport = Readonly<{
  surfaceKey: string;
  app: string;
  behavior: 'insert' | 'preview_only' | 'focus_changed';
  method: 'accessibility' | 'clipboard' | null;
  insertedText: string | null;
  draftPreserved: boolean;
  previewMode: 'context' | 'transcript_only';
  submitFlags: ReadonlyArray<boolean>;
  keysSynthesized: ReadonlyArray<string>;
  activations: ReadonlyArray<string>;
  undo: Readonly<{first: string; second: string | null}>;
}>;

type MatrixReport = Readonly<{
  surfaces: ReadonlyArray<SurfaceReport>;
  audit: Readonly<{
    surfacesRun: number;
    insertedWrites: number;
    unexpectedSubmissions: number;
    synthesizedKeys: ReadonlyArray<Readonly<{surfaceKey: string; key: string}>>;
    activations: ReadonlyArray<Readonly<{surfaceKey: string; bundleId: string}>>;
    clipboardRestored: ReadonlyArray<string>;
    clipboardUserChangesPreserved: ReadonlyArray<string>;
    clipboardViolations: ReadonlyArray<Readonly<{surfaceKey: string; detail: string}>>;
    previewOnlyMismatches: ReadonlyArray<string>;
    limitations: ReadonlyArray<string>;
  }>;
  timing: Readonly<{capture: TimingSamples; insertion: TimingSamples}>;
  missingContext: Readonly<{
    behavior: string;
    measurements: ReadonlyArray<
      Readonly<{
        surfaceKey: string;
        previewMode: string;
        inserted: boolean;
        redactions: Readonly<{secureNodes: number; excludedNodes: number; excludedSpans: number}> | null;
      }>
    >;
  }>;
  undo: Readonly<{
    limitations: ReadonlyArray<string>;
    measurements: ReadonlyArray<Readonly<{surfaceKey: string; action: string; status: string}>>;
  }>;
  digest: string;
}>;

type A04Module = Readonly<{
  A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET: number;
  A04_HARMFUL_SEMANTIC_EDIT_CEILING: number;
  A04_LATENCY_BUDGETS: Readonly<{captureBundleMs: number; insertionWarmP50Ms: number; insertionWarmP95Ms: number}>;
  scoreHeldOutDictation(input: Readonly<{
    corpus: Readonly<{cases: ReadonlyArray<HeldOutCaseInput>}>;
    dictate: (request: Readonly<{
      caseId: string;
      rawTranscript: string;
      glossary: ReadonlyArray<GlossaryEntry>;
      memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
    }>) => Promise<string>;
  }>): Promise<HeldOutReport>;
  runDictationCompatibilityMatrix(input: Readonly<{
    surfaces: ReadonlyArray<SurfaceProfile>;
    transcript: string;
    excludedBundleIds: ReadonlyArray<string>;
    createBridge: (surface: SurfaceProfile) => CaptureBridge;
    createController: (input: Readonly<{
      bridge: CaptureBridge;
      excludedBundleIds: ReadonlyArray<string>;
    }>) => DictationController;
    now: () => number;
  }>): Promise<MatrixReport>;
}>;

/**
 * Loads the yet-to-be-implemented A04 module, turning "module missing" into a named behavior
 * failure instead of a resolution error that hides what the oracle is waiting for.
 */
async function loadA04Module(): Promise<A04Module> {
  const fail = (detail: string): never => assert.fail(
    'A04 required dictation behavior is not implemented yet: packages/eval/src/dictation/index.ts must '
    + 'export A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET, A04_HARMFUL_SEMANTIC_EDIT_CEILING, '
    + 'A04_LATENCY_BUDGETS, scoreHeldOutDictation({ corpus, dictate }), and '
    + `runDictationCompatibilityMatrix({ surfaces, transcript, excludedBundleIds, createBridge, createController, now }). ${detail}`,
  );
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(A04_MODULE)) as unknown as Record<string, unknown>;
  } catch (error) {
    const code = (error as {code?: string}).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/u.test(String((error as Error).message))) {
      return fail('the module does not exist yet');
    }
    return fail(`importing it failed: ${(error as Error).message}`);
  }
  if (typeof loaded.scoreHeldOutDictation !== 'function') {
    return fail('scoreHeldOutDictation is not exported as a function');
  }
  if (typeof loaded.runDictationCompatibilityMatrix !== 'function') {
    return fail('runDictationCompatibilityMatrix is not exported as a function');
  }
  if (loaded.A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET !== 0.25) {
    return fail('A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET must be 0.25 (≥25% fewer technical-term errors)');
  }
  if (loaded.A04_HARMFUL_SEMANTIC_EDIT_CEILING !== 0.01) {
    return fail('A04_HARMFUL_SEMANTIC_EDIT_CEILING must be 0.01 (≤1% harmful semantic edits)');
  }
  const budgets = loaded.A04_LATENCY_BUDGETS as
    | Partial<Readonly<{captureBundleMs: unknown; insertionWarmP50Ms: unknown; insertionWarmP95Ms: unknown}>>
    | null
    | undefined;
  const expectedBudgets = {captureBundleMs: 500, insertionWarmP50Ms: 1500, insertionWarmP95Ms: 3000};
  if (typeof budgets !== 'object' || budgets === null
    || budgets.captureBundleMs !== expectedBudgets.captureBundleMs
    || budgets.insertionWarmP50Ms !== expectedBudgets.insertionWarmP50Ms
    || budgets.insertionWarmP95Ms !== expectedBudgets.insertionWarmP95Ms) {
    return fail('A04_LATENCY_BUDGETS must be { captureBundleMs: 500, insertionWarmP50Ms: 1500, insertionWarmP95Ms: 3000 }');
  }
  return loaded as unknown as A04Module;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Recomputes the fixture digest exactly like `check-a04-corpus.mjs` does (stats/digest stripped). */
function corpusDigest(document: CorpusDocument): string {
  const base = {
    contractVersion: document.contractVersion,
    fixtureId: document.fixtureId,
    seed: document.seed,
    caseCount: document.caseCount,
    surfaces: document.surfaces,
    cases: document.cases,
  };
  return `sha256:${sha256(JSON.stringify(base))}`;
}

function loadCorpus(): CorpusDocument {
  const result = spawnSync(process.execPath, [CORPUS_SCRIPT, '--json'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `the A04 held-out corpus fixture must self-validate:\n${result.stderr ?? ''}`);
  const document = JSON.parse(result.stdout) as CorpusDocument;
  assert.equal(document.consent, 'synthetic', 'the A04 corpus must stay synthetic');
  assert.equal(document.caseCount, CORPUS_CASE_COUNT, 'the A04 corpus must stay a 1,000-case held-out corpus');
  assert.equal(document.cases.length, CORPUS_CASE_COUNT, 'the A04 corpus must materialize 1,000 cases');
  assert.equal(document.surfaces.length, CORPUS_SURFACE_COUNT, 'the A04 matrix must keep its 12 signed-app surfaces');
  assert.equal(corpusDigest(document), CORPUS_DIGEST, 'the frozen A04 corpus fixture changed');
  assert.equal(document.digest, CORPUS_DIGEST, 'the fixture must report its own frozen digest');
  return document;
}

const corpus = loadCorpus();
const casesById = new Map(corpus.cases.map((entry) => [entry.caseId, entry]));
const goldByCaseId = new Map(corpus.cases.map((entry) => [entry.caseId, entry.goldTranscript]));
const surfacesByKey = new Map(corpus.surfaces.map((entry) => [entry.key, entry]));

function mustCase(caseId: string): CorpusCase {
  const entry = casesById.get(caseId);
  assert.ok(entry, `corpus must declare case ${caseId}`);
  return entry;
}

function mustSurface(key: string): CorpusSurface {
  const entry = surfacesByKey.get(key);
  assert.ok(entry, `corpus matrix must declare surface ${key}`);
  return entry;
}

/** The held-out case as the system under test may see it: labels stay on this side of the seam. */
function heldOutCaseInput(entry: CorpusCase): HeldOutCaseInput {
  return {
    caseId: entry.caseId,
    rawTranscript: entry.rawTranscript,
    technicalTerms: entry.technicalTerms,
    glossary: entry.glossary,
    memoryEvidence: entry.memoryEvidence,
  };
}

function surfaceProfile(surface: CorpusSurface): SurfaceProfile {
  return {
    key: surface.key,
    app: surface.app,
    bundleId: surface.bundleId,
    role: surface.role,
    displayId: surface.displayId,
    secure: surface.secure,
    editable: surface.editable,
    imeComposing: surface.imeComposing,
    accessibilityTrust: surface.accessibilityTrust,
    insertMethod: surface.insertMethod,
    switchesAwayAfterCommit: surface.switchesAwayAfterCommit,
    simulatedLatencyMs: surface.simulatedLatencyMs,
    userCopiesDuringPaste: surface.userCopiesDuringPaste,
  };
}

/** A02-shaped slot count: a term is an error while its canonical form is absent from the text. */
function termErrors(text: string, technicalTerms: ReadonlyArray<A04TechnicalTerm>): number {
  return technicalTerms.filter((term) => !text.includes(term.canonical)).length;
}

const SECURE_FIELD_VALUE = 'matrix-secret-field-value (synthetic)';
const EXCLUDED_VAULT_TEXT = 'excluded vault content (synthetic)';
const INITIAL_BUFFER = 'user draft: ';
const CAPTURE_LATENCY_PROBE = 'matrix-ax-value';

/** Injected monotonic clock: every measurement in the report is a reading of this object. */
class FakeClock {
  private value = 1_000_000;

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

const WORD_TOKENIZER = {
  count: (text: string): number => (text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length),
};

const IMAGE_TOKENS = (descriptor: Readonly<{width: number; height: number}>): number =>
  Math.ceil((descriptor.width * descriptor.height) / 750);

function makeAssembler(): ContextAssembler {
  return createContextAssembler({tokenizer: WORD_TOKENIZER, imageTokens: IMAGE_TOKENS});
}

type ReasoningTask = Readonly<{taskId: string; instruction: string}>;

type ReasonerCall = Readonly<{
  taskId: string;
  instruction: string;
  prompt: string;
  evidenceIds: ReadonlyArray<string>;
  aborted: boolean;
}>;

type ProposedEdit = Readonly<{
  start: number;
  end: number;
  original: string;
  replacement: string;
  basis: 'evidence' | 'acoustic_normalization';
  acousticReason: null;
  confidence: number;
}>;

function applySpans(raw: string, spans: ReadonlyArray<ProposedEdit>): string {
  let text = '';
  let cursor = 0;
  for (const span of spans) {
    assert.ok(span.start >= cursor, 'scripted spans must be ordered and non-overlapping');
    text += raw.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return text + raw.slice(cursor);
}

/**
 * Deterministic stand-in for the local reasoner: it is deliberately grounded, so it proposes a
 * technical-term substitution only when the canonical form was actually admitted into the bounded
 * prompt the corrector assembled. A corrector that drops the glossary evidence therefore gets no
 * correction, exactly like a real grounded model reading the same request. The held-out trap is
 * proposed unconditionally: it is the harmful proposal the protected-token rule must block.
 */
class ScriptedGroundingReasoner {
  readonly calls: Array<ReasonerCall> = [];
  private readonly entry: CorpusCase;

  constructor(entry: CorpusCase) {
    this.entry = entry;
  }

  async run(
    task: ReasoningTask,
    assembled: AssembledContext,
    _outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({
      taskId: task.taskId,
      instruction: task.instruction,
      prompt: assembled.prompt,
      evidenceIds: assembled.evidenceIds,
      aborted: abortSignal.aborted,
    });
    const prompt = assembled.prompt.toLowerCase();
    const raw = this.entry.rawTranscript;
    const edits: Array<ProposedEdit> = [];
    for (const term of this.entry.technicalTerms) {
      if (term.spoken === term.canonical) continue;
      if (raw.slice(term.start, term.end) !== term.spoken) continue;
      if (!prompt.includes(term.canonical.toLowerCase())) continue;
      edits.push({
        start: term.start,
        end: term.end,
        original: term.spoken,
        replacement: term.canonical,
        basis: 'evidence',
        acousticReason: null,
        confidence: 0.9,
      });
    }
    const trap = this.entry.trap;
    if (trap !== null) {
      edits.push({
        start: trap.start,
        end: trap.end,
        original: trap.original,
        replacement: trap.replacement,
        basis: 'evidence',
        acousticReason: null,
        confidence: 0.99,
      });
    }
    edits.sort((left, right) => left.start - right.start);
    return {text: applySpans(raw, edits), edits};
  }
}

type CaseDiagnostics = Readonly<{
  caseId: string;
  reasonerCalls: number;
  appliedEdits: number;
  blockedProtected: number;
  unresolvedReasons: ReadonlyArray<string>;
  fallback: string;
  text: string;
}>;

/**
 * The system under test for criterion 1: the real A02 corrector over the real M02 assembler, driven
 * by the grounded scripted reasoner, fed exactly the fields the harness hands over. The oracle keeps
 * its own diagnostics so the report's numbers can be cross-checked instead of trusted.
 */
function createDictationAdapter(): Readonly<{
  dictate: (request: Readonly<{
    caseId: string;
    rawTranscript: string;
    glossary: ReadonlyArray<GlossaryEntry>;
    memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
  }>) => Promise<string>;
  diagnostics: Array<CaseDiagnostics>;
}> {
  const diagnostics: Array<CaseDiagnostics> = [];
  const clock = new FakeClock();
  const dictate = async (request: Readonly<{
    caseId: string;
    rawTranscript: string;
    glossary: ReadonlyArray<GlossaryEntry>;
    memoryEvidence: ReadonlyArray<ProjectMemoryEvidence>;
  }>): Promise<string> => {
    const entry = mustCase(request.caseId);
    assert.equal(request.rawTranscript, entry.rawTranscript, `${entry.caseId}: the harness must hand over the committed transcript unchanged`);
    assert.deepEqual(request.glossary, entry.glossary, `${entry.caseId}: the harness must hand over the project glossary unchanged`);
    assert.deepEqual(request.memoryEvidence, entry.memoryEvidence, `${entry.caseId}: the harness must hand over the memory evidence unchanged`);
    const reasoner = new ScriptedGroundingReasoner(entry);
    const corrector = createDictationCorrector({
      reasoner,
      assembler: makeAssembler(),
      model: MODEL,
      now: () => clock.now(),
    });
    const result = await corrector.correct({
      rawTranscript: request.rawTranscript,
      mode: 'technical_cleanup',
      bundle: null,
      screenshot: null,
      glossary: request.glossary,
      memoryEvidence: request.memoryEvidence,
    });
    diagnostics.push({
      caseId: entry.caseId,
      reasonerCalls: reasoner.calls.length,
      appliedEdits: result.edits.length,
      blockedProtected: result.unresolvedSpans.filter((span) => span.reason === 'protected_token').length,
      unresolvedReasons: result.unresolvedSpans.map((span) => span.reason),
      fallback: result.fallback,
      text: result.text,
    });
    return result.text;
  };
  return {dictate, diagnostics};
}

type DesktopInsertion = {transactionId: string; bufferBefore: string; undone: boolean};

type UndoObservation = Readonly<{
  transactionId: string;
  status: 'undone' | 'nothing_to_undo';
  bufferBefore: string;
  bufferAfter: string;
  userTextDiscarded: boolean;
}>;

/** Compares the four identity fields of a fingerprint; the helper is opaque to this process. */
function sameFingerprint(
  left: Readonly<{bundleId: string; pid: number; windowId: number; elementFingerprint: string}>,
  right: Readonly<{bundleId: string; pid: number; windowId: number; elementFingerprint: string}>,
): boolean {
  return left.bundleId === right.bundleId
    && left.pid === right.pid
    && left.windowId === right.windowId
    && left.elementFingerprint === right.elementFingerprint;
}

/**
 * Deterministic stand-in for the signed helper on one surface. It is deliberately raw (it hands
 * back secure and excluded content that policy must remove) and hostile in the ways the matrix
 * models: an Accessibility write can be unsupported, the user can switch applications between the
 * commit and the insert, the user can copy something while the paste is in flight, and the user can
 * keep typing after an insertion. Every call it receives is logged, so the runner's audit is
 * compared against ground truth rather than against itself.
 */
class FakeSurfaceDesktop implements CaptureBridge {
  readonly spec: CorpusSurface;
  readonly clock: FakeClock;
  readonly captureRequests: Array<CaptureRequest> = [];
  readonly insertRequests: Array<Readonly<{text: string; submit: boolean; transactionId: string}>> = [];
  readonly targetMismatches: Array<string> = [];
  readonly keyEvents: Array<string> = [];
  readonly activations: Array<string> = [];
  readonly undoLog: Array<UndoObservation> = [];
  readonly clipboardWritesLog: Array<string> = [];
  clipboardReads = 0;
  userClipboardWrites = 0;

  readonly clipboard = {
    changeCount: (): number => this.clipboardChangeCount,
    readText: (): string => {
      this.clipboardReads += 1;
      return this.clipboardText;
    },
    writeText: (text: string): void => {
      this.clipboardText = text;
      this.clipboardChangeCount += 1;
      this.clipboardWritesLog.push(text);
    },
  };

  private readonly insertions: Array<DesktopInsertion> = [];
  private buffer = INITIAL_BUFFER;
  private bufferAfterWrite = INITIAL_BUFFER;
  private clipboardText = CLIPBOARD_BEFORE;
  private clipboardChangeCount = 1;
  private focused: 'origin' | 'elsewhere' = 'origin';
  private pendingTransactionId: string | null = null;

  constructor(spec: CorpusSurface, clock: FakeClock) {
    this.spec = spec;
    this.clock = clock;
  }

  bufferText(): string {
    return this.buffer;
  }

  /** The buffer exactly as the last write left it, before any undo restored the snapshot. */
  bufferAfterLastWrite(): string {
    return this.bufferAfterWrite;
  }

  clipboardTextValue(): string {
    return this.clipboardText;
  }

  async currentTarget(): Promise<CaptureTarget | null> {
    return this.targetFor(this.focused);
  }

  async captureContext(request: CaptureRequest): Promise<CaptureOutcome> {
    this.captureRequests.push(request);
    if (this.spec.screenRecording === 'denied') {
      this.clock.advance(this.spec.simulatedLatencyMs.capture);
      return {status: 'denied', reason: 'screen_recording_denied'};
    }
    const bounds = {x: 0, y: 0, width: 320, height: 18};
    const captureLatencyNode: Readonly<{
      nodeId: string;
      bundleId: string;
      role: string;
      value: string;
      secure: boolean;
      bounds: Readonly<{x: number; y: number; width: number; height: number}>;
    }> = {
      nodeId: 'ax-capture-latency',
      bundleId: this.spec.bundleId,
      role: 'AXStaticText',
      value: CAPTURE_LATENCY_PROBE,
      secure: false,
      bounds,
    };
    const snapshot: CaptureOutcome = {
      status: 'captured',
      snapshot: {
        snapshotId: `matrix-${this.spec.key}`,
        capturedAtMs: this.clock.now(),
        target: this.targetFor('origin'),
        screenshotRef: request.includeScreenshot ? `screenshot://${this.spec.key}` : null,
        selectedText: null,
        axNodes: [
          captureLatencyNode,
          {nodeId: 'ax-secure', bundleId: this.spec.bundleId, role: 'AXSecureTextField', value: SECURE_FIELD_VALUE, secure: true, bounds},
          {nodeId: 'ax-excluded', bundleId: EXCLUDED_VAULT_BUNDLE, role: 'AXStaticText', value: EXCLUDED_VAULT_TEXT, secure: false, bounds},
        ],
        ocrSpans: [
          {text: `${CAPTURE_LATENCY_PROBE}-ocr`, bundleId: this.spec.bundleId, bounds},
          {text: EXCLUDED_VAULT_TEXT, bundleId: EXCLUDED_VAULT_BUNDLE, bounds},
        ],
        quality: 'full',
        truncated: false,
      },
    };
    this.clock.advance(this.spec.simulatedLatencyMs.capture);
    // The user switches away after the utterance is committed: the captured fingerprint is now
    // stale, so a correct implementation must refuse to write into the newly focused element.
    if (this.spec.switchesAwayAfterCommit) this.focused = 'elsewhere';
    return snapshot;
  }

  async insertText(request: InsertRequest): Promise<InsertOutcome> {
    const submitted = (request as {submit?: unknown}).submit;
    this.insertRequests.push({
      text: request.text,
      submit: submitted !== false,
      transactionId: request.transactionId,
    });
    if (this.spec.insertMethod !== 'accessibility') {
      this.pendingTransactionId = request.transactionId;
      return {status: 'unsupported', transactionId: request.transactionId, reason: 'ax_insert_unsupported'};
    }
    const current = this.targetFor(this.focused);
    if (!sameFingerprint(current.fingerprint, request.targetFingerprint)) {
      this.targetMismatches.push(request.transactionId);
      return {status: 'target_mismatch', transactionId: request.transactionId, reason: 'focused element changed'};
    }
    this.clock.advance(this.spec.simulatedLatencyMs.insert);
    this.applyInsertion(request.transactionId, request.text);
    return {status: 'inserted', transactionId: request.transactionId, method: 'accessibility'};
  }

  async undo(request: Readonly<{transactionId: string}>): Promise<UndoOutcome> {
    const record = this.insertions.find(
      (candidate) => !candidate.undone && candidate.transactionId === request.transactionId,
    );
    if (!record) {
      this.undoLog.push({
        transactionId: request.transactionId,
        status: 'nothing_to_undo',
        bufferBefore: this.buffer,
        bufferAfter: this.buffer,
        userTextDiscarded: false,
      });
      return {status: 'nothing_to_undo', transactionId: null};
    }
    const bufferBefore = this.buffer;
    record.undone = true;
    this.buffer = record.bufferBefore;
    const bufferAfter = this.buffer;
    this.undoLog.push({
      transactionId: request.transactionId,
      status: 'undone',
      bufferBefore,
      bufferAfter,
      userTextDiscarded: bufferBefore.includes(USER_TYPED_AFTER_INSERT)
        && !bufferAfter.includes(USER_TYPED_AFTER_INSERT),
    });
    return {status: 'undone', transactionId: request.transactionId};
  }

  async sendKey(key: string): Promise<void> {
    this.keyEvents.push(key);
    if (key !== 'command+v') return;
    const transactionId = this.pendingTransactionId ?? `paste-${this.keyEvents.length}`;
    this.clock.advance(this.spec.simulatedLatencyMs.insert + this.spec.simulatedLatencyMs.keyStroke);
    this.applyInsertion(transactionId, this.clipboardText);
    // The user replaces the clipboard while the paste is in flight: the restoration must stand down.
    if (this.spec.userCopiesDuringPaste) this.setUserClipboard(CLIPBOARD_USER_COPY);
  }

  async activateApplication(bundleId: string): Promise<void> {
    this.activations.push(bundleId);
  }

  private setUserClipboard(text: string): void {
    this.clipboardText = text;
    this.clipboardChangeCount += 1;
    this.userClipboardWrites += 1;
  }

  private applyInsertion(transactionId: string, text: string): void {
    this.insertions.push({transactionId, bufferBefore: this.buffer, undone: false});
    this.buffer = `${this.buffer}${text}`;
    // The user keeps typing after the insertion; undo restores the pre-insertion snapshot, so that
    // typing is what a later undo silently discards.
    if (this.spec.userEditsAfterInsert) this.buffer = `${this.buffer}${USER_TYPED_AFTER_INSERT}`;
    this.bufferAfterWrite = this.buffer;
  }

  private targetFor(state: 'origin' | 'elsewhere'): CaptureTarget {
    if (state === 'elsewhere') {
      return {
        fingerprint: {
          bundleId: 'com.apple.Finder',
          pid: 9009,
          windowId: 77,
          elementFingerprint: 'finder-sidebar-element',
        },
        displayId: 1,
        bounds: {x: 0, y: 0, width: 800, height: 600},
        pixelScale: 2,
        role: 'AXList',
        secure: false,
        editable: false,
      };
    }
    return {
      fingerprint: {
        bundleId: this.spec.bundleId,
        pid: 7001,
        windowId: 21,
        elementFingerprint: `${this.spec.key}-element`,
      },
      displayId: this.spec.displayId,
      bounds: {x: 10, y: 20, width: 640, height: 220},
      pixelScale: 2,
      role: this.spec.role,
      secure: this.spec.secure,
      editable: this.spec.editable,
    };
  }
}

type MatrixRun = Readonly<{
  report: MatrixReport;
  doubles: ReadonlyMap<string, FakeSurfaceDesktop>;
  clock: FakeClock;
}>;

async function runMatrix(a04: A04Module): Promise<MatrixRun> {
  const clock = new FakeClock();
  const doubles = new Map<string, FakeSurfaceDesktop>();
  const report = await a04.runDictationCompatibilityMatrix({
    surfaces: corpus.surfaces.map(surfaceProfile),
    transcript: MATRIX_TRANSCRIPT,
    excludedBundleIds: EXCLUDED_BUNDLE_IDS,
    createBridge: (surface) => {
      assert.ok(!doubles.has(surface.key), `the runner must create exactly one bridge for surface ${surface.key}`);
      const desktop = new FakeSurfaceDesktop(mustSurface(surface.key), clock);
      doubles.set(surface.key, desktop);
      return desktop;
    },
    createController: ({bridge, excludedBundleIds}) => createDictationController({bridge, excludedBundleIds}),
    now: () => clock.now(),
  });
  return {report, doubles, clock};
}

function surfaceReport(report: MatrixReport, key: string): SurfaceReport {
  const entry = report.surfaces.find((candidate) => candidate.surfaceKey === key);
  assert.ok(entry, `the matrix report must cover surface ${key}`);
  return entry;
}

function timingFor(samples: TimingSamples, key: string): TimingSample {
  const entry = samples.samples.find((candidate) => candidate.surfaceKey === key);
  assert.ok(entry, `the ${samples.metric} samples must cover surface ${key}`);
  return entry;
}

/** Nearest-rank percentile, exactly as the frozen seam defines it: sorted[min(n − 1, ceil(q·n) − 1)]. */
function percentile(values: ReadonlyArray<number>, q: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? Number.NaN;
}

/** The injected-clock cost of one write: the Accessibility write, or the clipboard paste and its key. */
function expectedInsertLatency(spec: CorpusSurface): number {
  return spec.insertMethod === 'clipboard'
    ? spec.simulatedLatencyMs.insert + spec.simulatedLatencyMs.keyStroke
    : spec.simulatedLatencyMs.insert;
}

test('A04 criterion 1 — ≥25% fewer technical-term errors and ≤1% harmful semantic edits on the held-out corpus', async () => {
  const a04 = await loadA04Module();
  const harness = createDictationAdapter();
  const report = await a04.scoreHeldOutDictation({
    corpus: {cases: corpus.cases.map(heldOutCaseInput)},
    dictate: harness.dictate,
  });

  assert.equal(report.caseCount, CORPUS_CASE_COUNT, 'every held-out case must be scored');
  assert.equal(report.cases.length, CORPUS_CASE_COUNT);
  assert.deepEqual(
    report.cases.map((entry) => entry.caseId),
    corpus.cases.map((entry) => entry.caseId),
    'the report must keep the held-out corpus order',
  );
  assert.equal(harness.diagnostics.length, CORPUS_CASE_COUNT, 'the harness must dictate every held-out case exactly once');
  assert.ok(
    harness.diagnostics.every((entry) => entry.fallback === 'none'),
    'the corrector must not fall back to the raw transcript on any held-out case',
  );
  const diagnostics = new Map(harness.diagnostics.map((entry) => [entry.caseId, entry]));

  let baselineErrors = 0;
  let correctedErrors = 0;
  let harmfulCases = 0;
  const offGold: Array<string> = [];
  for (const scored of report.cases) {
    const fixture = mustCase(scored.caseId);
    assert.equal(scored.rawTranscript, fixture.rawTranscript, `${scored.caseId}: the report must score the committed transcript it was handed`);
    const before = termErrors(scored.rawTranscript, fixture.technicalTerms);
    const after = termErrors(scored.insertedText, fixture.technicalTerms);
    const harmful = harmfulProtectedTokenEdits(scored.rawTranscript, scored.insertedText);
    assert.equal(scored.termErrorsBefore, before, `${scored.caseId}: term errors before must be recomputable from the raw transcript`);
    assert.equal(scored.termErrorsAfter, after, `${scored.caseId}: term errors after must be recomputable from the inserted text`);
    assert.equal(scored.harmfulEdits, harmful, `${scored.caseId}: harmful edits must be the real A02 re-scan of raw vs inserted`);
    assert.equal(scored.fallback, false, `${scored.caseId}: the harness never rejected, so no case may be scored as a fallback`);
    baselineErrors += before;
    correctedErrors += after;
    if (harmful > 0) harmfulCases += 1;
    if (fixture.kind === 'clean') {
      assert.equal(scored.insertedText, fixture.rawTranscript, `${scored.caseId}: already-correct text must be inserted untouched`);
    } else if (scored.insertedText !== fixture.goldTranscript) {
      offGold.push(scored.caseId);
    }
  }
  assert.equal(
    offGold.length,
    0,
    `${offGold.length} of ${CORPUS_CASE_COUNT} held-out cases did not reach the gold transcript (first: ${offGold.slice(0, 5).join(', ')})`,
  );

  assert.equal(baselineErrors, CORPUS_BASELINE_TERM_ERRORS, 'the held-out baseline must stay the frozen raw-transcript error count');
  assert.equal(report.baselineTechnicalTermErrors, baselineErrors);
  assert.equal(report.correctedTechnicalTermErrors, correctedErrors);
  assert.equal(correctedErrors, 0, `dictation must correct the misheard held-out terms, not just 75% of them (${correctedErrors} left)`);
  const reduction = baselineErrors > 0 ? (baselineErrors - correctedErrors) / baselineErrors : 0;
  assert.ok(
    Math.abs(report.technicalTermErrorReduction - reduction) < 1e-12,
    `the reported reduction ${report.technicalTermErrorReduction} must be (baseline − corrected)/baseline = ${reduction}`,
  );
  assert.equal(report.harmfulSemanticEdits, harmfulCases);
  assert.ok(
    Math.abs(report.harmfulSemanticEditRate - harmfulCases / CORPUS_CASE_COUNT) < 1e-12,
    `the harmful rate ${report.harmfulSemanticEditRate} must be harmful cases over ${CORPUS_CASE_COUNT}`,
  );
  assert.equal(report.withinTechnicalTermTarget, true);
  assert.equal(report.withinHarmfulEditCeiling, true);
  assert.equal(report.withinTargets, true, 'the held-out corpus must clear both A04 targets');
  assert.ok(
    reduction >= a04.A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET,
    `reduction ${reduction} must clear the ${a04.A04_TECHNICAL_TERM_ERROR_REDUCTION_TARGET} technical-term target`,
  );
  assert.ok(
    report.harmfulSemanticEditRate <= a04.A04_HARMFUL_SEMANTIC_EDIT_CEILING,
    `harmful rate ${report.harmfulSemanticEditRate} must stay under the ${a04.A04_HARMFUL_SEMANTIC_EDIT_CEILING} ceiling`,
  );

  const cleanCases = corpus.cases.filter((entry) => entry.kind === 'clean');
  assert.equal(cleanCases.length, CORPUS_CLEAN_CASE_COUNT, 'the corpus must keep its clean cases');
  for (const fixture of cleanCases) {
    const diagnostic = diagnostics.get(fixture.caseId);
    assert.ok(diagnostic, `${fixture.caseId}: the harness must have dictated this case`);
    assert.equal(diagnostic.appliedEdits, 0, `${fixture.caseId}: already-correct text must not be edited at all`);
  }

  const traps = corpus.cases.filter((entry) => entry.kind === 'protected_trap');
  assert.equal(traps.length, CORPUS_TRAP_CASE_COUNT, 'the corpus must keep its protected-token traps');
  const scoredById = new Map(report.cases.map((entry) => [entry.caseId, entry]));
  for (const fixture of traps) {
    const trap = fixture.trap;
    assert.ok(trap, `${fixture.caseId}: a trap case must carry the harmful proposal it models`);
    const diagnostic = diagnostics.get(fixture.caseId);
    assert.ok(diagnostic, `${fixture.caseId}: the harness must have dictated this case`);
    assert.ok(
      diagnostic.blockedProtected >= 1,
      `${fixture.caseId}: the ${trap.kind} proposal ${JSON.stringify(trap.original)} → ${JSON.stringify(trap.replacement)} must be blocked as a protected token`,
    );
    assert.ok(
      diagnostic.unresolvedReasons.includes('protected_token'),
      `${fixture.caseId}: the block must surface as unresolvedSpans[].reason = 'protected_token'`,
    );
    const scored = scoredById.get(fixture.caseId);
    assert.ok(scored, `${fixture.caseId}: the report must score this trap case`);
    assert.ok(
      scored.insertedText.includes(trap.original),
      `${fixture.caseId}: the protected literal ${JSON.stringify(trap.original)} must survive insertion verbatim`,
    );
  }
});

test('A04 criterion 2 — insertion never submits and never steals focus, and a user clipboard change survives', async () => {
  const a04 = await loadA04Module();
  const {report, doubles} = await runMatrix(a04);

  assert.equal(report.surfaces.length, CORPUS_SURFACE_COUNT, 'every matrix surface must be reported');
  assert.deepEqual(
    report.surfaces.map((entry) => entry.surfaceKey),
    corpus.surfaces.map((entry) => entry.key),
    'the matrix must report every surface exactly once, in matrix order',
  );

  const clipboardRestored: Array<string> = [];
  const clipboardPreserved: Array<string> = [];
  for (const spec of corpus.surfaces) {
    const desktop = doubles.get(spec.key);
    assert.ok(desktop, `the runner must create the ${spec.key} bridge`);
    const entry = surfaceReport(report, spec.key);
    const inserts = spec.expect === 'insert';

    assert.equal(entry.app, spec.app);
    assert.equal(entry.behavior, spec.expect, `${spec.key}: the behavior must be derived, not assumed`);
    assert.equal(
      entry.method,
      inserts ? (spec.insertMethod === 'accessibility' ? 'accessibility' : 'clipboard') : null,
      `${spec.key}: the insertion method must match the surface capability`,
    );
    assert.equal(entry.insertedText, inserts ? MATRIX_TRANSCRIPT : null, `${spec.key}: only an inserting surface may hold the committed transcript`);
    assert.equal(entry.draftPreserved, !inserts, `${spec.key}: the draft survives exactly when it was not written`);
    assert.equal(
      entry.previewMode,
      spec.screenRecording === 'denied' ? 'transcript_only' : 'context',
      `${spec.key}: only a denied capture previews transcript-only`,
    );
    assert.deepEqual(entry.activations, [], `${spec.key}: dictation must not activate another application`);
    assert.ok(desktop.activations.length === 0, `${spec.key}: activateApplication was called on the native bridge`);

    // Ground truth from the raw double: one bounded capture, and a write only where a write may land.
    assert.equal(desktop.captureRequests.length, 1, `${spec.key}: exactly one capture per utterance`);
    const captureRequest = desktop.captureRequests[0];
    assert.ok(captureRequest, `${spec.key}: the capture request must be recorded`);
    assert.deepEqual(captureRequest.axBudget, AX_CAPTURE_BUDGET, `${spec.key}: the helper must receive the bounded traversal budget`);
    assert.equal(captureRequest.includeScreenshot, !spec.secure, `${spec.key}: a secure field is never screenshotted`);
    assert.ok(
      captureRequest.excludedBundleIds.includes(EXCLUDED_VAULT_BUNDLE),
      `${spec.key}: the runner's excluded bundles must reach the helper request`,
    );
    assert.ok(captureRequest.excludedBundleIds.includes('com.echopilot.widget'), `${spec.key}: EchoPilot's own widget is always excluded`);

    assert.equal(desktop.insertRequests.length, inserts ? 1 : 0, `${spec.key}: nothing may be written on a surface that did not insert`);
    for (const insertRequest of desktop.insertRequests) {
      assert.equal(insertRequest.submit, false, `${spec.key}: insertion is literal — submit must be false`);
      assert.equal(insertRequest.text, MATRIX_TRANSCRIPT);
    }
    assert.deepEqual(entry.submitFlags, desktop.insertRequests.map((insertRequest) => insertRequest.submit));
    assert.ok(entry.submitFlags.every((flag) => flag === false), `${spec.key}: no write may carry submit: true`);

    const expectedKeys = inserts && spec.insertMethod === 'clipboard' ? [PASTE_KEYSTROKE] : [];
    assert.deepEqual(entry.keysSynthesized, expectedKeys, `${spec.key}: the only key dictation may synthesize is the paste chord`);
    assert.deepEqual(desktop.keyEvents, expectedKeys, `${spec.key}: the bridge saw a key the runner must not have sent`);
    assert.ok(desktop.keyEvents.every((key) => key === PASTE_KEYSTROKE), `${spec.key}: Return/Enter may never be synthesized`);
    assert.ok(!desktop.bufferText().includes('\n'), `${spec.key}: the buffer must not gain a newline`);

    const expectedBuffer = inserts
      ? `${INITIAL_BUFFER}${MATRIX_TRANSCRIPT}${spec.userEditsAfterInsert ? USER_TYPED_AFTER_INSERT : ''}`
      : INITIAL_BUFFER;
    assert.equal(
      desktop.bufferAfterLastWrite(),
      expectedBuffer,
      `${spec.key}: the focused element must hold exactly the inserted text, and nothing else`,
    );
    assert.equal(
      desktop.bufferText(),
      INITIAL_BUFFER,
      `${spec.key}: the undo the report claims must put the pre-insertion snapshot back`,
    );

    if (inserts && spec.insertMethod === 'clipboard') {
      if (spec.userCopiesDuringPaste) {
        assert.equal(
          desktop.clipboardTextValue(),
          CLIPBOARD_USER_COPY,
          `${spec.key}: the user's copy must win over the restoration`,
        );
        assert.deepEqual(
          desktop.clipboardWritesLog,
          [MATRIX_TRANSCRIPT],
          `${spec.key}: the restoration must stand down once the user replaced the clipboard`,
        );
        clipboardPreserved.push(spec.key);
      } else {
        assert.equal(desktop.clipboardTextValue(), CLIPBOARD_BEFORE, `${spec.key}: the previous clipboard contents must come back`);
        assert.deepEqual(
          desktop.clipboardWritesLog,
          [MATRIX_TRANSCRIPT, CLIPBOARD_BEFORE],
          `${spec.key}: borrow the clipboard, paste, restore`,
        );
        clipboardRestored.push(spec.key);
      }
    } else {
      assert.deepEqual(desktop.clipboardWritesLog, [], `${spec.key}: the clipboard is untouched on a surface that never pastes`);
      assert.equal(desktop.clipboardTextValue(), CLIPBOARD_BEFORE);
    }
  }

  const insertKeys = corpus.surfaces.filter((spec) => spec.expect === 'insert').map((spec) => spec.key);
  const clipboardKeys = corpus.surfaces
    .filter((spec) => spec.expect === 'insert' && spec.insertMethod === 'clipboard')
    .map((spec) => spec.key);
  assert.deepEqual([...clipboardRestored].sort(), clipboardKeys.filter((key) => key !== USER_CLIPBOARD_CHANGE_SURFACE).sort());
  assert.deepEqual(clipboardPreserved, [USER_CLIPBOARD_CHANGE_SURFACE]);

  assert.equal(report.audit.surfacesRun, CORPUS_SURFACE_COUNT);
  assert.equal(report.audit.insertedWrites, insertKeys.length, 'the audit must count the writes that actually landed');
  assert.equal(report.audit.unexpectedSubmissions, 0, 'a submitted insertion is the failure this criterion exists for');
  assert.deepEqual(
    report.audit.synthesizedKeys.map((entry) => entry.surfaceKey).sort(),
    [...clipboardKeys].sort(),
    'key synthesis must be limited to the clipboard fallback surfaces',
  );
  assert.ok(report.audit.synthesizedKeys.every((entry) => entry.key === PASTE_KEYSTROKE));
  assert.deepEqual(report.audit.activations, [], 'dictation must not steal focus from the user');
  assert.deepEqual(report.audit.clipboardRestored.slice().sort(), [...clipboardRestored].sort());
  assert.deepEqual(report.audit.clipboardUserChangesPreserved, [USER_CLIPBOARD_CHANGE_SURFACE]);
  assert.deepEqual(report.audit.clipboardViolations, [], 'no clipboard rule may be violated');
  assert.deepEqual(report.audit.previewOnlyMismatches, [], 'a preview-only surface was written to');
  assert.ok(report.audit.limitations.length >= 4, 'the matrix must document its failure-mode limits');
  assert.ok(
    report.audit.limitations.every((line) => line.trim().length > 0),
    'a limitation must be a statement, not an empty placeholder',
  );
  const auditLimits = report.audit.limitations.join(' ').toLowerCase();
  assert.ok(
    auditLimits.includes('clipboard') && auditLimits.includes('focus'),
    'the documented limits must cover the clipboard rule and the focus-change refusal',
  );
});

test('A04 criterion 3 — capture/insertion timing, missing-context behavior and undo limits are reproducible measurements', async () => {
  const a04 = await loadA04Module();
  const budgets = a04.A04_LATENCY_BUDGETS;
  const {report, doubles} = await runMatrix(a04);

  const capture = report.timing.capture;
  assert.equal(capture.budgetMs, budgets.captureBundleMs, 'the capture gate is the plan §4.4 bundle budget');
  assert.equal(capture.sampleCount, CORPUS_SURFACE_COUNT, 'capture is measured on every surface, preview-only ones included');
  assert.deepEqual(capture.samples.map((entry) => entry.surfaceKey), corpus.surfaces.map((entry) => entry.key));
  for (const spec of corpus.surfaces) {
    assert.equal(
      timingFor(capture, spec.key).measuredMs,
      spec.simulatedLatencyMs.capture,
      `${spec.key}: the capture sample must be the injected-clock span of beginUtterance, not a wall-clock guess`,
    );
  }
  const captureValues = capture.samples.map((entry) => entry.measuredMs);
  assert.equal(capture.maxMs, Math.max(...captureValues));
  assert.equal(capture.p50Ms, percentile(captureValues, 0.5));
  assert.equal(capture.p95Ms, percentile(captureValues, 0.95));
  assert.equal(capture.withinBudget, capture.p95Ms <= capture.budgetMs, 'the capture gate is its own p95');
  assert.equal(capture.withinBudget, false, 'the 640 ms large-scrollback capture must not be reported as within budget');
  assert.deepEqual(
    capture.budgetViolations.map((violation) => ({
      surfaceKey: violation.surfaceKey,
      measuredMs: violation.measuredMs,
      budgetMs: violation.budgetMs,
    })),
    [{surfaceKey: 'terminal-large-scrollback', measuredMs: 640, budgetMs: budgets.captureBundleMs}],
    'the over-budget capture must be documented as a violation, never hidden',
  );
  assert.ok(capture.budgetViolations.every((violation) => violation.metric === capture.metric));

  const insertion = report.timing.insertion;
  const insertingSpecs = corpus.surfaces.filter((spec) => spec.expect === 'insert');
  assert.equal(insertion.budgetMs, budgets.insertionWarmP95Ms, 'the insertion sample gate is the §4.4 warm p95 budget');
  assert.equal(insertion.sampleCount, insertingSpecs.length, 'insertion is measured exactly on the surfaces that wrote text');
  assert.deepEqual(insertion.samples.map((entry) => entry.surfaceKey).sort(), insertingSpecs.map((spec) => spec.key).sort());
  for (const spec of insertingSpecs) {
    assert.equal(
      timingFor(insertion, spec.key).measuredMs,
      expectedInsertLatency(spec),
      `${spec.key}: the insertion sample must be the injected-clock span of the write itself`,
    );
  }
  const insertionValues = insertion.samples.map((entry) => entry.measuredMs);
  assert.equal(insertion.maxMs, Math.max(...insertionValues));
  assert.equal(insertion.p50Ms, percentile(insertionValues, 0.5));
  assert.equal(insertion.p95Ms, percentile(insertionValues, 0.95));
  assert.ok(insertion.p50Ms <= budgets.insertionWarmP50Ms, `insertion p50 ${insertion.p50Ms} must stay under ${budgets.insertionWarmP50Ms}`);
  assert.ok(insertion.p95Ms <= budgets.insertionWarmP95Ms, `insertion p95 ${insertion.p95Ms} must stay under ${budgets.insertionWarmP95Ms}`);
  assert.equal(insertion.withinBudget, true);
  assert.deepEqual(insertion.budgetViolations, [], 'no insertion may exceed the warm budget in this matrix');

  assert.ok(report.missingContext.behavior.trim().length > 20, 'missing-context behavior must be documented in words');
  assert.equal(report.missingContext.measurements.length, CORPUS_SURFACE_COUNT);
  assert.deepEqual(
    report.missingContext.measurements.map((entry) => entry.surfaceKey),
    corpus.surfaces.map((entry) => entry.key),
    'the missing-context measurements must cover every surface in matrix order',
  );
  for (const spec of corpus.surfaces) {
    const measurement = report.missingContext.measurements.find((entry) => entry.surfaceKey === spec.key);
    assert.ok(measurement, `the missing-context measurements must cover ${spec.key}`);
    const transcriptOnly = spec.screenRecording === 'denied';
    assert.equal(measurement.previewMode, transcriptOnly ? 'transcript_only' : 'context');
    assert.equal(measurement.inserted, spec.expect === 'insert', `${spec.key}: denied capture must not stop the insertion`);
    if (transcriptOnly) {
      assert.equal(measurement.redactions, null, `${spec.key}: a transcript-only preview has no redaction counts`);
      assert.ok(report.missingContext.behavior.toLowerCase().includes('transcript'), 'the behavior note must name transcript-only mode');
    } else {
      assert.ok(measurement.redactions, `${spec.key}: a context preview must report what redaction removed`);
      assert.ok(measurement.redactions.secureNodes >= 1, `${spec.key}: the secure AX node must be redacted out of the bundle`);
      assert.ok(measurement.redactions.excludedNodes >= 1, `${spec.key}: the excluded-bundle AX node must be redacted out of the bundle`);
      assert.ok(measurement.redactions.excludedSpans >= 1, `${spec.key}: the excluded OCR span must be redacted out of the bundle`);
    }
  }

  const userEditSurface = mustSurface('editor-user-edit-after-insert');
  const userEditDesktop = doubles.get(userEditSurface.key);
  assert.ok(userEditDesktop, 'the user-typing surface needs its bridge');
  for (const spec of corpus.surfaces.filter((entry) => entry.expect === 'insert')) {
    const desktop = doubles.get(spec.key);
    assert.ok(desktop, `the ${spec.key} bridge must exist`);
    assert.equal(
      desktop.undoLog.filter((entry) => entry.status === 'undone').length,
      1,
      `${spec.key}: exactly one undo must reach the bridge, so 'undone' is an observation and not a claim`,
    );
  }
  const undoRecord = userEditDesktop.undoLog.find((entry) => entry.status === 'undone');
  assert.ok(undoRecord, 'the runner must undo the insertion it made on the user-typing surface');
  assert.equal(
    undoRecord.userTextDiscarded,
    true,
    'undo restores the pre-insertion snapshot, so the typing that followed the insertion is discarded',
  );
  const undoMeasurements = report.undo.measurements.filter((entry) => entry.action === 'undo');
  assert.equal(undoMeasurements.length, CORPUS_SURFACE_COUNT, 'every surface must report its undo outcome');
  for (const spec of corpus.surfaces) {
    const measurement = undoMeasurements.find((entry) => entry.surfaceKey === spec.key);
    assert.ok(measurement, `the undo measurements must cover ${spec.key}`);
    assert.equal(measurement.status, spec.expect === 'insert' ? 'undone' : 'nothing_to_undo');
    assert.equal(surfaceReport(report, spec.key).undo.first, measurement.status);
  }
  const undoAgain = report.undo.measurements.filter((entry) => entry.action === 'undo_again');
  assert.equal(undoAgain.length, insertingSpecs.length, 'each write must be un-undoable a second time');
  assert.ok(undoAgain.every((entry) => entry.status === 'nothing_to_undo'), 'undo is single-level, and the report must say so');
  assert.ok(report.undo.limitations.length >= 3, 'undo limits must be documented');
  assert.ok(report.undo.limitations.every((line) => line.trim().length > 0));
  const undoLimits = report.undo.limitations.join(' ').toLowerCase();
  assert.ok(undoLimits.includes('undo'), 'the undo limits must be about undo');
  assert.ok(/typ|snapshot|discard/.test(undoLimits), 'the discarded user typing must be documented');
  assert.ok(/single|second|once|again|last/.test(undoLimits), 'single-level undo must be documented');
  for (const spec of corpus.surfaces) {
    const entry = surfaceReport(report, spec.key);
    assert.equal(entry.undo.first, spec.expect === 'insert' ? 'undone' : 'nothing_to_undo');
    assert.equal(entry.undo.second, spec.expect === 'insert' ? 'nothing_to_undo' : null);
  }

  const {digest, ...rest} = report;
  assert.equal(digest, `sha256:${sha256(JSON.stringify(rest))}`, 'the digest must cover the whole report without itself');
  const second = await runMatrix(a04);
  const {digest: secondDigest, ...secondRest} = second.report;
  assert.equal(secondDigest, digest, 'two runs over the same deterministic doubles must digest identically');
  assert.equal(JSON.stringify(secondRest), JSON.stringify(rest), 'the measurements must be reproducible, not merely re-digested');
});
