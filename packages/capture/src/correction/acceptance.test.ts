/**
 * A02 acceptance oracle — speech + screenshot + project memory → evidence-backed correction →
 * insertion (IMPLEMENTATION_PLAN.md §7.2 A02; plan §5.4 correction rules, §4.4 dictation latency,
 * judgments A-F3…A-F6).
 *
 * Real ASR, the local Qwen reasoner, and the signed macOS helper need hardware, model weights, and
 * Screen Recording consent, so this oracle drives the frozen A02 seam with deterministic doubles
 * and enforces every property that is decidable off-device:
 *
 *   - paired fixtures prove that screenshot context and the prior project glossary each improve the
 *     committed text, and that Jason-as-a-person stays unchanged in both cases;
 *   - every applied substitution carries a validated evidence citation or a verifiable acoustic
 *     normalization reason;
 *   - protected tokens (numbers, negation, flags, paths, quoted literals) are never silently
 *     rewritten, whatever confidence the model reports;
 *   - the warm correction latency and harmful-edit gates are measured and reported;
 *   - an invalid, inconsistent, or crashing model response falls back to the raw committed text;
 *   - the corrected text is what the A01 controller inserts, literally and without submission.
 *
 * `packages/capture/src/correction/index.ts` must export (this file pins these names; they are the
 * frozen A02 seam between dictation context assembly and the shared Reasoner/context contracts):
 *
 *   CORRECTION_MODES = ['verbatim', 'technical_cleanup', 'rewrite']
 *   ACOUSTIC_NORMALIZATION_REASONS = ['spelled_letters', 'capitalization', 'punctuation']
 *   PROTECTED_TOKEN_KINDS = ['number', 'negation', 'flag', 'path', 'quoted_literal']
 *   EDIT_BLOCK_REASONS = ['protected_token', 'missing_evidence', 'invalid_acoustic_reason']
 *   WARM_CORRECTION_BUDGET_MS = 3000
 *     §4.4: end of utterance → corrected insertion ≤1.5 s p50 / 3 s p95 for ≤15-second utterances,
 *     warm local model.
 *   CORRECTION_OUTPUT_SCHEMA
 *     The JSON Schema handed to `Reasoner.run`; an object requiring `text` and `edits`.
 *
 *   createDictationCorrector({ reasoner, assembler, model, now }) → DictationCorrector
 *
 *     reasoner — the F01/M02 Reasoner contract
 *       run({ taskId, instruction }, assembledContext, outputSchema, abortSignal) → unknown
 *       Called exactly once per non-verbatim correction, with the bounded context the injected
 *       assembler produced (B = min(8192, floor(0.25·capacity))).
 *     assembler — the M02 `ContextAssembler` (packages/memory/src/context). Images are charged with
 *       its `imageTokens`, so an admitted screenshot is real multimodal input, not a filename.
 *     model — { modelId, contextCapacity } for the assembler budget.
 *     now — injected monotonic clock (ms); the warm correction gate is measured with it.
 *
 *     correct(request) → Promise<CorrectionResult>
 *       request: { rawTranscript, mode, bundle, screenshot, glossary, memoryEvidence }
 *         bundle         — the A01 ContextBundle (redacted preview) for this utterance
 *         screenshot     — { ref, width, height } when the utterance had a permitted capture
 *         glossary       — prior project glossary entries, in retrieval order
 *         memoryEvidence — M02 evidence items ({ id, text }) already scoped to the project
 *
 *       Evidence ids are deterministic and derived only from the request, in this order:
 *       `ctx:selected-text`, `ctx:ax:<i>` (non-empty AX node values), `ctx:ocr:<i>`,
 *       `ctx:glossary:<i>`, then the memory evidence ids unchanged. A screenshot travels as an
 *       image whose id is `screenshot.ref`.
 *
 *       The model response must be `{ text, edits: [{ start, end, original, replacement, basis,
 *       acousticReason, confidence }] }` and is valid only when `text` is exactly the raw
 *       transcript with every declared edit applied and every span matches the raw text. An
 *       invalid, inconsistent, or failed response falls back to the raw transcript, with no edits.
 *
 *       Each candidate edit is validated in this order:
 *         1. protected token (number, negation, flag, path, quoted literal) → blocked
 *            'protected_token'; the model's confidence is never an authorization signal;
 *         2. basis 'evidence' → at least one admitted evidence text must contain the replacement
 *            (case-insensitive); otherwise blocked 'missing_evidence'. The applied edit cites the
 *            corroborating evidence ids;
 *         3. basis 'acoustic_normalization' → the reason must be one of
 *            ACOUSTIC_NORMALIZATION_REASONS and the raw/replacement pair must verify
 *            deterministically: spelled_letters = letter-only equality, capitalization =
 *            lowercase equality, punctuation = alphanumeric-insensitive equality; otherwise
 *            blocked 'invalid_acoustic_reason'.
 *       Blocked candidates are preserved as unresolvedSpans
 *       { start, end, raw, alternative, reason } so the alternative is offered, never applied.
 *
 *       result: { rawText, text, mode, edits[], unresolvedSpans[], evidenceIds[], coverage,
 *                 fallback: 'none' | 'invalid_model_response' | 'reasoner_error',
 *                 gates: { warmLatencyMs, warmBudgetMs, withinWarmBudget, harmfulEditsApplied } }
 *       Verbatim returns the raw transcript without calling the reasoner and without admitting
 *       evidence (`evidenceIds: []`, no image, latency 0); it never assembles a correction request.
 *       `edits` are the applied substitutions in raw-text order with span, replacement,
 *       evidenceIds/acousticReason, and the model's recorded confidence; `evidenceIds` are the ids
 *       the bounded request actually admitted; `history()` returns one entry per correction so raw
 *       and corrected text stay separately inspectable. An over-budget correction is still returned
 *       with `withinWarmBudget: false`; the gate is a measurement, not a silent discard.
 *
 * The corrected text is what dictation inserts; the A01 controller still owns literal insertion.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {createDictationController} from '../index.js';
import {
  createContextAssembler,
  type AssembledContext,
  type ContextAssembler,
} from '../../../memory/src/context/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/dictation/a02-correction-pairs.json', import.meta.url);
const CAPTURED_AT_MS = 1_700_000_000_000;

type CorrectionMode = 'verbatim' | 'technical_cleanup' | 'rewrite';
type AcousticNormalizationReason = 'spelled_letters' | 'capitalization' | 'punctuation';
type ProtectedTokenKind = 'number' | 'negation' | 'flag' | 'path' | 'quoted_literal';
type EditBlockReason = 'protected_token' | 'missing_evidence' | 'invalid_acoustic_reason';
type CorrectionBasis = 'evidence' | 'acoustic_normalization';
type CorrectionFallback = 'none' | 'invalid_model_response' | 'reasoner_error';

type Bounds = Readonly<{x: number; y: number; width: number; height: number}>;

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
  axBudget: Readonly<{maxNodes: number; maxTraversalMs: number}>;
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

type CapturedOCRSpan = Readonly<{text: string; bundleId: string; bounds: Bounds}>;

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
  | Readonly<{status: 'captured'; snapshot: CaptureSnapshot}>
  | Readonly<{status: 'denied'; reason: 'screen_recording_denied' | 'accessibility_denied'}>;

type InsertRequest = Readonly<{
  transactionId: string;
  targetFingerprint: TargetFingerprint;
  text: string;
  submit: false;
}>;

type InsertOutcome =
  | Readonly<{status: 'inserted'; transactionId: string; method: 'accessibility'}>
  | Readonly<{status: 'unsupported'; transactionId: string; reason: string}>
  | Readonly<{status: 'target_mismatch'; transactionId: string; reason: string}>;

type CaptureBridge = Readonly<{
  currentTarget(): Promise<CaptureTarget | null>;
  captureContext(request: CaptureRequest): Promise<CaptureOutcome>;
  insertText(request: InsertRequest): Promise<InsertOutcome>;
  undo(request: Readonly<{transactionId: string}>): Promise<Readonly<{status: 'undone' | 'nothing_to_undo'; transactionId: string | null}>>;
  clipboard: Readonly<{changeCount(): number; readText(): string; writeText(text: string): void}>;
  sendKey(key: string): Promise<void>;
  activateApplication(bundleId: string): Promise<void>;
}>;

type AXNode = Readonly<{nodeId: string; role: string; value: string; secure: boolean; bounds: Bounds}>;
type OCRSpan = Readonly<{text: string; bundleId: string; bounds: Bounds}>;

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
  redactions: Readonly<{secureNodes: number; excludedNodes: number; excludedSpans: number}>;
}>;

type GlossaryEntry = Readonly<{
  term: string;
  variants: ReadonlyArray<string>;
  scope: 'project' | 'global';
  userConfirmed: boolean;
  positiveExamples: ReadonlyArray<string>;
}>;

type MemoryEvidenceItem = Readonly<{id: string; text: string}>;
type ScreenshotInput = Readonly<{ref: string; width: number; height: number}>;

type ReasoningTask = Readonly<{taskId: string; instruction: string}>;

type ReasonerContract = Readonly<{
  run(
    task: ReasoningTask,
    boundedContext: AssembledContext,
    outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown>;
}>;

type CorrectionRequest = Readonly<{
  rawTranscript: string;
  mode: CorrectionMode;
  bundle: ContextBundle;
  screenshot: ScreenshotInput | null;
  glossary: ReadonlyArray<GlossaryEntry>;
  memoryEvidence: ReadonlyArray<MemoryEvidenceItem>;
}>;

type CorrectionEdit = Readonly<{
  start: number;
  end: number;
  original: string;
  replacement: string;
  basis: CorrectionBasis;
  evidenceIds: ReadonlyArray<string>;
  acousticReason: AcousticNormalizationReason | null;
  confidence: number;
}>;

type UnresolvedSpan = Readonly<{
  start: number;
  end: number;
  raw: string;
  alternative: string;
  reason: EditBlockReason;
}>;

type CorrectionGates = Readonly<{
  warmLatencyMs: number;
  warmBudgetMs: number;
  withinWarmBudget: boolean;
  harmfulEditsApplied: number;
}>;

type CorrectionResult = Readonly<{
  rawText: string;
  text: string;
  mode: CorrectionMode;
  edits: ReadonlyArray<CorrectionEdit>;
  unresolvedSpans: ReadonlyArray<UnresolvedSpan>;
  evidenceIds: ReadonlyArray<string>;
  coverage: 'complete' | 'partial';
  fallback: CorrectionFallback;
  gates: CorrectionGates;
}>;

type CorrectionHistoryEntry = Readonly<{
  rawText: string;
  text: string;
  mode: CorrectionMode;
  fallback: CorrectionFallback;
}>;

type DictationCorrector = Readonly<{
  correct(request: CorrectionRequest): Promise<CorrectionResult>;
  history(): ReadonlyArray<CorrectionHistoryEntry>;
}>;

type CorrectionModule = Readonly<{
  CORRECTION_MODES: ReadonlyArray<CorrectionMode>;
  ACOUSTIC_NORMALIZATION_REASONS: ReadonlyArray<AcousticNormalizationReason>;
  PROTECTED_TOKEN_KINDS: ReadonlyArray<ProtectedTokenKind>;
  EDIT_BLOCK_REASONS: ReadonlyArray<EditBlockReason>;
  WARM_CORRECTION_BUDGET_MS: number;
  CORRECTION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>>;
  createDictationCorrector(options: Readonly<{
    reasoner: ReasonerContract;
    assembler: ContextAssembler;
    model: Readonly<{modelId: string; contextCapacity: number}>;
    now?: () => number;
  }>): DictationCorrector;
}>;

async function loadCorrectionModule(): Promise<CorrectionModule> {
  const fail = (detail: string): never => assert.fail(
    'A02 required correction behavior is not implemented yet: packages/capture/src/correction/index.ts '
    + 'must export CORRECTION_MODES, ACOUSTIC_NORMALIZATION_REASONS, PROTECTED_TOKEN_KINDS, '
    + 'EDIT_BLOCK_REASONS, WARM_CORRECTION_BUDGET_MS, CORRECTION_OUTPUT_SCHEMA, and '
    + `createDictationCorrector({ reasoner, assembler, model, now }). ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists the import resolves to
  // nothing, and that is reported below as missing behavior instead of a node/TS resolution
  // failure that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createDictationCorrector !== 'function') {
    return fail('createDictationCorrector is not exported as a function');
  }
  const modes = loaded.CORRECTION_MODES;
  if (!Array.isArray(modes) || modes.join(',') !== 'verbatim,technical_cleanup,rewrite') {
    return fail('CORRECTION_MODES must be [verbatim, technical_cleanup, rewrite]');
  }
  const acousticReasons = loaded.ACOUSTIC_NORMALIZATION_REASONS;
  if (!Array.isArray(acousticReasons)
    || acousticReasons.join(',') !== 'spelled_letters,capitalization,punctuation') {
    return fail('ACOUSTIC_NORMALIZATION_REASONS must be [spelled_letters, capitalization, punctuation]');
  }
  const protectedKinds = loaded.PROTECTED_TOKEN_KINDS;
  if (!Array.isArray(protectedKinds)
    || protectedKinds.join(',') !== 'number,negation,flag,path,quoted_literal') {
    return fail('PROTECTED_TOKEN_KINDS must be [number, negation, flag, path, quoted_literal]');
  }
  const blockReasons = loaded.EDIT_BLOCK_REASONS;
  if (!Array.isArray(blockReasons)
    || blockReasons.join(',') !== 'protected_token,missing_evidence,invalid_acoustic_reason') {
    return fail('EDIT_BLOCK_REASONS must be [protected_token, missing_evidence, invalid_acoustic_reason]');
  }
  if (loaded.WARM_CORRECTION_BUDGET_MS !== 3000) {
    return fail('WARM_CORRECTION_BUDGET_MS must be 3000 (plan §4.4 dictation p95, warm local model)');
  }
  const schema = loaded.CORRECTION_OUTPUT_SCHEMA;
  if (typeof schema !== 'object' || schema === null) {
    return fail('CORRECTION_OUTPUT_SCHEMA is not exported');
  }
  const required = (schema as Record<string, unknown>).required;
  if ((schema as Record<string, unknown>).type !== 'object'
    || !Array.isArray(required)
    || !required.includes('text')
    || !required.includes('edits')) {
    return fail('CORRECTION_OUTPUT_SCHEMA must be an object schema requiring text and edits');
  }
  return loaded as unknown as CorrectionModule;
}

type FixtureSurface = Readonly<{
  bundleId: string;
  pid: number;
  windowId: number;
  displayId: number;
  elementFingerprint: string;
  role: string;
  bounds: Bounds;
  pixelScale: number;
}>;

type FixtureModelEdit = Readonly<{
  from: string;
  to: string;
  basis: CorrectionBasis;
  acousticReason: string | null;
  confidence: number;
  requiresPromptText: ReadonlyArray<string>;
}>;

type FixtureUnresolved = Readonly<{raw: string; alternative: string; reason: EditBlockReason}>;

type FixtureCase = Readonly<{
  key: string;
  pair: string | null;
  variant: string | null;
  evidenceSource: string;
  mode: CorrectionMode;
  rawTranscript: string;
  screenshot: ScreenshotInput | null;
  selectedText: string | null;
  axValues: ReadonlyArray<string>;
  ocrTexts: ReadonlyArray<string>;
  glossaryTerms: ReadonlyArray<string>;
  memoryEvidence: ReadonlyArray<MemoryEvidenceItem>;
  modelLatencyMs: number;
  modelEdits: ReadonlyArray<FixtureModelEdit>;
  expect: Readonly<{
    text: string;
    applied: number;
    blocked: number;
    fallback: CorrectionFallback;
    evidenceIds: ReadonlyArray<string>;
    images: number;
    reasonerCalls: number;
    appliedBasis: CorrectionBasis | null;
    appliedAcousticReason: AcousticNormalizationReason | null;
    unresolved: ReadonlyArray<FixtureUnresolved>;
  }>;
}>;

type Fixture = Readonly<{
  schemaVersion: number;
  ticket: string;
  projectId: string;
  model: Readonly<{modelId: string; contextCapacity: number}>;
  defaultModelLatencyMs: number;
  excludedBundleIds: ReadonlyArray<string>;
  surface: FixtureSurface;
  glossary: Readonly<Record<string, GlossaryEntry>>;
  cases: ReadonlyArray<FixtureCase>;
}>;

async function loadFixture(): Promise<Fixture> {
  const parsed = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
  assert.equal(parsed.schemaVersion, 1, 'fixture schema version');
  assert.equal(parsed.ticket, 'A02', 'fixture ticket');
  assert.ok(parsed.cases.length >= 12, 'fixture must declare every A02 correction case');
  return parsed;
}

const correction = await loadCorrectionModule();
const fixture = await loadFixture();

function mustCase(key: string): FixtureCase {
  const entry = fixture.cases.find((candidate) => candidate.key === key);
  assert.ok(entry, `fixture must declare case ${key}`);
  return entry;
}

function firstCall(reasoner: ScriptedReasoner): ReasonerCall {
  const call = reasoner.calls[0];
  assert.ok(call, 'the correction must call the reasoner exactly once');
  return call;
}

type ReasonerCall = Readonly<{
  task: ReasoningTask;
  assembled: AssembledContext;
  outputSchema: Readonly<Record<string, unknown>>;
  aborted: boolean;
}>;

class FakeClock {
  private value = 1_000;

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

/**
 * Deterministic stand-in for the local reasoner. It is deliberately evidence-driven: a rule only
 * fires when every `requiresPromptText` fragment was actually assembled into the prompt, so a
 * corrector that drops the screenshot or the glossary evidence gets no correction, exactly like a
 * grounded model reading the same bounded request.
 */
class ScriptedReasoner implements ReasonerContract {
  readonly calls: Array<ReasonerCall> = [];
  private readonly entry: FixtureCase;
  private readonly clock: FakeClock;
  private readonly latencyMs: number;

  constructor(entry: FixtureCase, clock: FakeClock, latencyMs: number) {
    this.entry = entry;
    this.clock = clock;
    this.latencyMs = latencyMs;
  }

  async run(
    task: ReasoningTask,
    assembled: AssembledContext,
    outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({task, assembled, outputSchema, aborted: abortSignal.aborted});
    assert.ok(task.taskId.length > 0, 'the reasoner task must carry a task id');
    assert.ok(task.instruction.length > 0, 'the reasoner task must carry the mode instruction');
    assert.ok(
      assembled.totalTokens <= assembled.maxTokens,
      'the correction request must stay inside the bounded context',
    );
    this.clock.advance(this.latencyMs);

    const proposals: Array<Readonly<{
      start: number;
      end: number;
      original: string;
      replacement: string;
      basis: CorrectionBasis;
      acousticReason: string | null;
      confidence: number;
    }>> = [];
    for (const rule of this.entry.modelEdits) {
      if (!this.entry.rawTranscript.includes(rule.from)) continue;
      const evidenceReady = rule.requiresPromptText.every((fragment) => assembled.prompt.includes(fragment));
      if (!evidenceReady) continue;
      const start = this.entry.rawTranscript.indexOf(rule.from);
      proposals.push({
        start,
        end: start + rule.from.length,
        original: rule.from,
        replacement: rule.to,
        basis: rule.basis,
        acousticReason: rule.acousticReason,
        confidence: rule.confidence,
      });
    }
    return {
      text: applyEdits(this.entry.rawTranscript, proposals),
      edits: proposals,
    };
  }
}

/** Stand-in that returns an arbitrary (possibly invalid) payload or crashes. */
class RawReasoner implements ReasonerContract {
  readonly calls: Array<number> = [];
  private readonly produce: () => unknown;

  constructor(produce: () => unknown) {
    this.produce = produce;
  }

  async run(
    task: ReasoningTask,
    assembled: AssembledContext,
    outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    void task;
    void outputSchema;
    void abortSignal;
    this.calls.push(assembled.totalTokens);
    return this.produce();
  }
}

function applyEdits(
  raw: string,
  edits: ReadonlyArray<Readonly<{start: number; end: number; replacement: string}>>,
): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  let text = '';
  let cursor = 0;
  for (const edit of ordered) {
    assert.ok(
      edit.start >= cursor && edit.end <= raw.length && edit.start <= edit.end,
      'edits must be ordered, non-overlapping spans inside the raw transcript',
    );
    text += raw.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return text + raw.slice(cursor);
}

function glossaryFor(entry: FixtureCase): ReadonlyArray<GlossaryEntry> {
  return entry.glossaryTerms.map((key) => {
    const item = fixture.glossary[key];
    assert.ok(item, `fixture glossary must declare ${key}`);
    return item;
  });
}

function bundleFor(entry: FixtureCase): ContextBundle {
  const surface = fixture.surface;
  return {
    snapshotId: `a02-snapshot-${entry.key}`,
    capturedAtMs: CAPTURED_AT_MS,
    target: {
      bundleId: surface.bundleId,
      pid: surface.pid,
      windowId: surface.windowId,
      displayId: surface.displayId,
      elementFingerprint: surface.elementFingerprint,
      bounds: surface.bounds,
      pixelScale: surface.pixelScale,
    },
    selectedText: entry.selectedText,
    screenshotRef: entry.screenshot === null ? null : entry.screenshot.ref,
    axNodes: entry.axValues
      .filter((value) => value.trim().length > 0)
      .map((value, index) => ({
        nodeId: `ax-${index}`,
        role: 'AXStaticText',
        value,
        secure: false,
        bounds: surface.bounds,
      })),
    ocrSpans: entry.ocrTexts
      .filter((text) => text.trim().length > 0)
      .map((text) => ({text, bundleId: surface.bundleId, bounds: surface.bounds})),
    quality: 'full',
    truncated: false,
    redactions: {secureNodes: 0, excludedNodes: 0, excludedSpans: 0},
  };
}

function requestFor(entry: FixtureCase, bundle: ContextBundle): CorrectionRequest {
  return {
    rawTranscript: entry.rawTranscript,
    mode: entry.mode,
    bundle,
    screenshot: entry.screenshot,
    glossary: glossaryFor(entry),
    memoryEvidence: entry.memoryEvidence,
  };
}

function expectedEvidenceIds(entry: FixtureCase): ReadonlyArray<string> {
  const ids: string[] = [];
  if (entry.selectedText !== null && entry.selectedText.trim().length > 0) ids.push('ctx:selected-text');
  entry.axValues.forEach((value, index) => {
    if (value.trim().length > 0) ids.push(`ctx:ax:${index}`);
  });
  entry.ocrTexts.forEach((text, index) => {
    if (text.trim().length > 0) ids.push(`ctx:ocr:${index}`);
  });
  entry.glossaryTerms.forEach((_key, index) => ids.push(`ctx:glossary:${index}`));
  entry.memoryEvidence.forEach((item) => ids.push(item.id));
  return ids;
}

function makeCorrector(reasoner: ReasonerContract, clock: FakeClock): DictationCorrector {
  return correction.createDictationCorrector({
    reasoner,
    assembler: makeAssembler(),
    model: fixture.model,
    now: () => clock.now(),
  });
}

type RunOutcome = Readonly<{
  entry: FixtureCase;
  result: CorrectionResult;
  reasoner: ScriptedReasoner;
  corrector: DictationCorrector;
  clock: FakeClock;
}>;

async function runCase(entry: FixtureCase, latencyMs?: number): Promise<RunOutcome> {
  const clock = new FakeClock();
  const reasoner = new ScriptedReasoner(entry, clock, latencyMs ?? entry.modelLatencyMs);
  const corrector = makeCorrector(reasoner, clock);
  const result = await corrector.correct(requestFor(entry, bundleFor(entry)));
  return {entry, result, reasoner, corrector, clock};
}

const outcomes = new Map<string, Promise<RunOutcome>>();

function outcomeFor(entry: FixtureCase): Promise<RunOutcome> {
  const cached = outcomes.get(entry.key);
  if (cached !== undefined) return cached;
  const pending = runCase(entry);
  outcomes.set(entry.key, pending);
  return pending;
}

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function lettersAndDigits(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The oracle's own deterministic reading of the acoustic rules the engine must enforce. */
function verifyAcoustic(
  original: string,
  replacement: string,
  reason: AcousticNormalizationReason,
): boolean {
  if (original === replacement) return false;
  switch (reason) {
    case 'spelled_letters':
      return lettersOnly(original) === lettersOnly(replacement)
        && /\s/.test(original.trim())
        && !/\s/.test(replacement.trim());
    case 'capitalization':
      return original.toLowerCase() === replacement.toLowerCase();
    case 'punctuation':
      return lettersAndDigits(original) === lettersAndDigits(replacement);
  }
}

/**
 * Independent reading of the tokens a correction may not silently change (A-F5, ticket judgment).
 * It is intentionally a second implementation: the engine reporting `harmfulEditsApplied: 0` is not
 * accepted as proof that nothing harmful reached the inserted text.
 */
function protectedTokens(text: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  for (const match of text.match(/\d+(?:[.,:/-]\d+)*/g) ?? []) tokens.push(`number:${match}`);
  for (const match of text.match(/(?:^|\s)(-{1,2}[A-Za-z][\w-]*)/g) ?? []) tokens.push(`flag:${match.trim()}`);
  for (const match of text.match(/\b(?:not|never|no|none|without|except|cannot)\b|n't/gi) ?? []) {
    tokens.push(`negation:${match.toLowerCase()}`);
  }
  for (const match of text.match(/[\w.-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|toml|swift|py|sh|css|html|txt)\b/g) ?? []) {
    tokens.push(`path:${match}`);
  }
  for (const match of text.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? []) tokens.push(`quoted:${match}`);
  return tokens;
}

function evidenceTextFor(entry: FixtureCase, id: string): string | null {
  if (id === 'ctx:selected-text') return entry.selectedText;
  const ax = /^ctx:ax:(\d+)$/.exec(id);
  if (ax !== null) return entry.axValues[Number(ax[1])] ?? null;
  const ocr = /^ctx:ocr:(\d+)$/.exec(id);
  if (ocr !== null) return entry.ocrTexts[Number(ocr[1])] ?? null;
  const memory = entry.memoryEvidence.find((item) => item.id === id);
  if (memory !== undefined) return memory.text;
  return null;
}

function corroborates(entry: FixtureCase, id: string, replacement: string): boolean {
  const glossary = /^ctx:glossary:(\d+)$/.exec(id);
  if (glossary !== null) {
    const term = glossaryFor(entry)[Number(glossary[1])]?.term;
    return term !== undefined && term.toLowerCase() === replacement.toLowerCase();
  }
  const text = evidenceTextFor(entry, id);
  return text !== null && text.toLowerCase().includes(replacement.toLowerCase());
}

async function assertExpectation(outcome: RunOutcome): Promise<void> {
  const {entry, result, reasoner} = outcome;
  const expected = entry.expect;

  assert.equal(result.rawText, entry.rawTranscript, `${entry.key}: the raw transcript is preserved`);
  assert.equal(result.mode, entry.mode, `${entry.key}: the requested mode is reported`);
  assert.equal(result.text, expected.text, `${entry.key}: corrected text`);
  assert.equal(result.fallback, expected.fallback, `${entry.key}: fallback`);
  assert.equal(result.edits.length, expected.applied, `${entry.key}: applied edits`);
  assert.equal(result.unresolvedSpans.length, expected.blocked, `${entry.key}: blocked edits`);
  assert.deepEqual([...result.evidenceIds], [...expected.evidenceIds], `${entry.key}: admitted evidence ids`);
  if (expected.reasonerCalls > 0) {
    assert.deepEqual(
      [...expectedEvidenceIds(entry)],
      [...expected.evidenceIds],
      `${entry.key}: fixture evidence ids must follow the pinned derivation`,
    );
  }
  assert.equal(result.coverage, 'complete', `${entry.key}: coverage`);
  assert.equal(result.gates.harmfulEditsApplied, 0, `${entry.key}: harmful-edit gate`);
  assert.equal(result.gates.warmBudgetMs, correction.WARM_CORRECTION_BUDGET_MS, `${entry.key}: warm budget`);
  assert.equal(
    result.gates.withinWarmBudget,
    result.gates.warmLatencyMs <= correction.WARM_CORRECTION_BUDGET_MS,
    `${entry.key}: the warm gate must be a real comparison`,
  );
  assert.equal(reasoner.calls.length, expected.reasonerCalls, `${entry.key}: reasoner calls`);
  if (expected.reasonerCalls > 0) {
    assert.equal(result.gates.warmLatencyMs, entry.modelLatencyMs, `${entry.key}: warm latency is measured`);
    const call = firstCall(reasoner);
    assert.equal(call.aborted, false, `${entry.key}: the reasoner is called with a live signal`);
    assert.equal(call.assembled.images.length, expected.images, `${entry.key}: admitted images`);
    assert.deepEqual(
      call.outputSchema,
      correction.CORRECTION_OUTPUT_SCHEMA,
      `${entry.key}: the correction output schema is handed to the reasoner`,
    );
    assert.deepEqual(
      [...call.assembled.evidenceIds],
      [...expected.evidenceIds],
      `${entry.key}: the bounded request carries the admitted evidence ids`,
    );
    for (const id of expected.evidenceIds) {
      const text = evidenceTextFor(entry, id);
      if (text !== null) {
        assert.ok(
          call.assembled.prompt.includes(text),
          `${entry.key}: evidence ${id} must reach the prompt`,
        );
      }
    }
    for (const glossaryEntry of glossaryFor(entry)) {
      assert.ok(
        call.assembled.prompt.includes(glossaryEntry.term),
        `${entry.key}: glossary term ${glossaryEntry.term} must reach the prompt`,
      );
      for (const variant of glossaryEntry.variants) {
        assert.ok(
          call.assembled.prompt.includes(variant),
          `${entry.key}: glossary variant ${variant} must reach the prompt`,
        );
      }
    }
  }
  for (const span of expected.unresolved) {
    const match = result.unresolvedSpans.find(
      (candidate) => candidate.raw === span.raw
        && candidate.alternative === span.alternative
        && candidate.reason === span.reason,
    );
    assert.ok(match, `${entry.key}: unresolved span ${span.raw} → ${span.alternative} (${span.reason})`);
  }
  if (expected.appliedBasis !== null) {
    assert.equal(result.edits[0]?.basis, expected.appliedBasis, `${entry.key}: applied basis`);
  }
  if (expected.appliedAcousticReason !== null) {
    assert.equal(
      result.edits[0]?.acousticReason,
      expected.appliedAcousticReason,
      `${entry.key}: applied acoustic reason`,
    );
  }
}

test('fixture pairs cover screenshot and glossary evidence with a strictly improving variant', () => {
  const pairs = new Map<string, Array<FixtureCase>>();
  for (const entry of fixture.cases) {
    if (entry.pair === null) continue;
    const bucket = pairs.get(entry.pair) ?? [];
    bucket.push(entry);
    pairs.set(entry.pair, bucket);
  }
  assert.deepEqual([...pairs.keys()].sort(), ['json-response', 'sqlite-migration']);
  const sources = new Set<string>();
  for (const [pairId, variants] of pairs) {
    assert.equal(variants.length, 2, `${pairId}: a pair must have exactly two variants`);
    const withEvidence = variants.find((candidate) => candidate.variant?.startsWith('with') === true);
    const withoutEvidence = variants.find((candidate) => candidate.variant?.startsWith('without') === true);
    assert.ok(withEvidence, `${pairId}: a with-evidence variant`);
    assert.ok(withoutEvidence, `${pairId}: a without-evidence variant`);
    assert.equal(withEvidence.evidenceSource, withoutEvidence.evidenceSource, `${pairId}: one evidence source`);
    assert.notEqual(withEvidence.rawTranscript, undefined);
    assert.equal(withEvidence.rawTranscript, withoutEvidence.rawTranscript, `${pairId}: same raw transcript`);
    assert.notEqual(withEvidence.expect.text, withEvidence.rawTranscript, `${pairId}: the with variant improves`);
    assert.equal(withoutEvidence.expect.text, withoutEvidence.rawTranscript, `${pairId}: the without variant stays raw`);
    assert.notEqual(withEvidence.expect.text, withoutEvidence.expect.text, `${pairId}: the pair must differ`);
    sources.add(withEvidence.evidenceSource);
  }
  assert.deepEqual([...sources].sort(), ['glossary', 'screenshot']);
});

test('paired screenshot fixture: permitted image + OCR evidence correct Jason → JSON; without it the raw text survives', async () => {
  const withEntry = mustCase('json-response-with-screenshot');
  const withoutEntry = mustCase('json-response-without-screenshot');
  const withOutcome = await outcomeFor(withEntry);
  const withoutOutcome = await outcomeFor(withoutEntry);
  await assertExpectation(withOutcome);
  await assertExpectation(withoutOutcome);

  assert.equal(withOutcome.result.text, 'serialize the JSON response');
  assert.equal(withoutOutcome.result.text, withEntry.rawTranscript);
  assert.equal(withOutcome.result.edits[0]?.original, 'Jason');
  assert.equal(withOutcome.result.edits[0]?.replacement, 'JSON');
  assert.deepEqual([...(withOutcome.result.edits[0]?.evidenceIds ?? [])], ['ctx:ocr:0']);

  const withCall = firstCall(withOutcome.reasoner);
  assert.equal(withCall.assembled.images.length, 1, 'the screenshot must be admitted as an image');
  assert.ok(withCall.assembled.accounting.images > 0, 'the admitted image must carry measured image tokens');
  assert.ok(withCall.assembled.prompt.includes('JSON.parse(payload)'), 'OCR evidence must reach the prompt');
  assert.equal(withCall.assembled.accounting.images, IMAGE_TOKENS(withEntry.screenshot ?? {width: 0, height: 0}));

  const withoutCall = firstCall(withoutOutcome.reasoner);
  assert.equal(withoutCall.assembled.images.length, 0, 'no screenshot, no admitted image');
  assert.equal(
    withoutCall.assembled.prompt.includes('JSON.parse(payload)'),
    false,
    'without the screenshot the token evidence is absent',
  );
});

test('paired glossary fixture: the prior project glossary corrects sequel lite → SQLite; without it the raw text survives', async () => {
  const withEntry = mustCase('sqlite-migration-with-glossary');
  const withoutEntry = mustCase('sqlite-migration-without-glossary');
  const withOutcome = await outcomeFor(withEntry);
  const withoutOutcome = await outcomeFor(withoutEntry);
  await assertExpectation(withOutcome);
  await assertExpectation(withoutOutcome);

  assert.equal(withOutcome.result.text, 'deploy the SQLite migration');
  assert.equal(withoutOutcome.result.text, withEntry.rawTranscript);
  assert.deepEqual([...(withOutcome.result.edits[0]?.evidenceIds ?? [])], ['ctx:glossary:0']);

  const withCall = firstCall(withOutcome.reasoner);
  assert.ok(withCall.assembled.prompt.includes('SQLite'), 'the glossary term must reach the prompt');
  assert.ok(withCall.assembled.prompt.includes('sequel lite'), 'the glossary variant must reach the prompt');
  const withoutCall = firstCall(withoutOutcome.reasoner);
  assert.equal(
    withoutCall.assembled.prompt.includes('SQLite'),
    false,
    'without the glossary nothing in the prompt may leak the term',
  );
});

test('project memory evidence is admitted, cited, and bounded through the shared assembler', async () => {
  const entry = mustCase('memory-evidence');
  const outcome = await outcomeFor(entry);
  await assertExpectation(outcome);
  assert.equal(outcome.result.text, 'resume the Atlas rollout');
  assert.deepEqual([...(outcome.result.edits[0]?.evidenceIds ?? [])], ['mem:decision:17']);
  const call = firstCall(outcome.reasoner);
  assert.ok(call.assembled.prompt.includes('Atlas rollout'), 'the project memory text must reach the prompt');
  assert.ok(call.assembled.totalTokens <= call.assembled.maxTokens, 'the request stays inside the bounded budget');
});

test('Jason as a person stays unchanged: hallucinated Jason → JSON is blocked and offered, never applied', async () => {
  for (const key of ['jason-person-in-screenshot', 'jason-person-in-glossary']) {
    const entry = mustCase(key);
    const outcome = await outcomeFor(entry);
    await assertExpectation(outcome);
    assert.equal(outcome.result.text, entry.rawTranscript, `${key}: the person's name is untouched`);
    assert.ok(outcome.result.text.includes('Jason'), `${key}: Jason survives`);
    assert.equal(outcome.result.edits.length, 0, `${key}: nothing is substituted`);
    assert.equal(outcome.result.unresolvedSpans[0]?.reason, 'missing_evidence', `${key}: blocked reason`);
    assert.equal(outcome.result.unresolvedSpans[0]?.alternative, 'JSON', `${key}: the alternative is offered`);
    assert.equal(outcome.result.gates.harmfulEditsApplied, 0, `${key}: no harmful edit`);
  }
});

test('every applied substitution carries validated evidence or a verifiable acoustic reason', async () => {
  for (const entry of fixture.cases) {
    const {result} = await outcomeFor(entry);
    assert.equal(
      applyEdits(result.rawText, result.edits),
      result.text,
      `${entry.key}: the reported text is the raw transcript with exactly the applied edits`,
    );
    for (const edit of result.edits) {
      assert.ok(edit.start >= 0 && edit.end <= result.rawText.length, `${entry.key}: edit span in range`);
      assert.equal(result.rawText.slice(edit.start, edit.end), edit.original, `${entry.key}: span matches`);
      assert.notEqual(edit.original, edit.replacement, `${entry.key}: an applied edit changes text`);
      assert.ok(Number.isFinite(edit.confidence), `${entry.key}: confidence is recorded as a number`);
      assert.ok(edit.confidence >= 0 && edit.confidence <= 1, `${entry.key}: confidence is calibrated 0..1`);
      if (edit.basis === 'evidence') {
        assert.equal(edit.acousticReason, null, `${entry.key}: evidence edits carry no acoustic reason`);
        assert.ok(edit.evidenceIds.length > 0, `${entry.key}: evidence edits cite at least one id`);
        for (const id of edit.evidenceIds) {
          assert.ok(result.evidenceIds.includes(id), `${entry.key}: cited evidence ${id} was admitted`);
        }
        assert.ok(
          edit.evidenceIds.some((id) => corroborates(entry, id, edit.replacement)),
          `${entry.key}: ${edit.original} → ${edit.replacement} must be corroborated by admitted evidence`,
        );
      } else {
        assert.deepEqual([...edit.evidenceIds], [], `${entry.key}: acoustic edits cite no evidence`);
        assert.ok(edit.acousticReason !== null, `${entry.key}: acoustic edits declare a reason`);
        assert.ok(
          edit.acousticReason !== null
            && correction.ACOUSTIC_NORMALIZATION_REASONS.includes(edit.acousticReason),
          `${entry.key}: the acoustic reason is one of the pinned reasons`,
        );
        assert.ok(
          edit.acousticReason !== null && verifyAcoustic(edit.original, edit.replacement, edit.acousticReason),
          `${entry.key}: ${edit.original} → ${edit.replacement} must verify acoustically`,
        );
      }
    }
  }
});

test('protected tokens are never silently rewritten, even at model confidence 1.0', async () => {
  const entry = mustCase('protected-tokens');
  const outcome = await outcomeFor(entry);
  await assertExpectation(outcome);
  assert.ok(entry.modelEdits.every((rule) => rule.confidence === 1), 'every proposal claims full confidence');
  assert.equal(outcome.result.text, entry.rawTranscript);
  assert.equal(outcome.result.edits.length, 0);
  assert.equal(outcome.result.unresolvedSpans.length, 5);
  assert.ok(
    outcome.result.unresolvedSpans.every((span) => span.reason === 'protected_token'),
    'every protected-token proposal is blocked as protected_token',
  );
  for (const kind of ['number', 'negation', 'flag', 'path', 'quoted_literal']) {
    assert.ok(
      correction.PROTECTED_TOKEN_KINDS.includes(kind as ProtectedTokenKind),
      `PROTECTED_TOKEN_KINDS must include ${kind}`,
    );
  }
  assert.equal(outcome.result.gates.harmfulEditsApplied, 0);
});

test('acoustic normalization accepts only verifiable reasons and rejects unverifiable claims', async () => {
  const spelled = await outcomeFor(mustCase('acoustic-spelled-letters'));
  const capitalization = await outcomeFor(mustCase('acoustic-capitalization'));
  const punctuation = await outcomeFor(mustCase('acoustic-punctuation'));
  for (const outcome of [spelled, capitalization, punctuation]) {
    await assertExpectation(outcome);
    assert.equal(outcome.result.edits.length, 1, `${outcome.entry.key}: one normalization applied`);
    assert.equal(outcome.result.unresolvedSpans.length, 0);
    assert.deepEqual([...(outcome.result.edits[0]?.evidenceIds ?? [])], []);
    assert.equal(outcome.result.edits[0]?.basis, 'acoustic_normalization');
  }
  assert.equal(spelled.result.edits[0]?.acousticReason, 'spelled_letters');
  assert.equal(capitalization.result.edits[0]?.acousticReason, 'capitalization');
  assert.equal(punctuation.result.edits[0]?.acousticReason, 'punctuation');

  const unverified = await outcomeFor(mustCase('acoustic-claim-without-verification'));
  await assertExpectation(unverified);
  assert.equal(unverified.result.text, unverified.entry.rawTranscript);
  assert.equal(unverified.result.edits.length, 0);
  assert.equal(unverified.result.unresolvedSpans[0]?.reason, 'invalid_acoustic_reason');
});

test('verbatim never calls the model; rewrite is labeled and still validated', async () => {
  const verbatim = await outcomeFor(mustCase('verbatim-mode'));
  await assertExpectation(verbatim);
  assert.equal(verbatim.reasoner.calls.length, 0, 'verbatim makes no model call');
  assert.equal(verbatim.result.text, verbatim.entry.rawTranscript);
  assert.equal(verbatim.result.edits.length, 0);
  assert.deepEqual([...verbatim.result.evidenceIds], []);
  assert.equal(verbatim.result.mode, 'verbatim');

  const rewrite = await outcomeFor(mustCase('rewrite-mode'));
  await assertExpectation(rewrite);
  assert.equal(rewrite.result.mode, 'rewrite');
  assert.equal(rewrite.reasoner.calls.length, 1);
  assert.equal(rewrite.result.edits.length, 1);

  const cleanup =
    (await outcomeFor(mustCase('json-response-with-screenshot'))).reasoner.calls[0]?.task.instruction;
  const rewriteInstruction = firstCall(rewrite.reasoner).task.instruction;
  assert.ok(cleanup !== undefined && cleanup.length > 0);
  assert.notEqual(cleanup, rewriteInstruction, 'the model must be told which correction level is active');
});

test('warm latency gate is measured with the injected clock against the 3 s budget', async () => {
  const entry = mustCase('json-response-with-screenshot');
  const fast = await outcomeFor(entry);
  assert.equal(fast.result.gates.warmLatencyMs, entry.modelLatencyMs);
  assert.equal(fast.result.gates.warmBudgetMs, 3000);
  assert.equal(fast.result.gates.withinWarmBudget, true);

  const slow = await runCase(entry, 4_200);
  assert.equal(slow.result.gates.warmLatencyMs, 4_200, 'the slow measurement is reported as measured');
  assert.equal(slow.result.gates.warmBudgetMs, correction.WARM_CORRECTION_BUDGET_MS);
  assert.equal(slow.result.gates.withinWarmBudget, false, 'a 4.2 s warm correction misses the p95 gate');
  assert.equal(slow.result.text, entry.expect.text, 'the gate is a measurement, the correction is still returned');
});

test('invalid, inconsistent, or crashing model responses fall back to the raw transcript', async () => {
  const entry = mustCase('json-response-with-screenshot');
  const invalidPayloads: ReadonlyArray<{name: string; payload: unknown}> = [
    {name: 'not an object', payload: 'not-an-object'},
    {name: 'missing corrected text', payload: {edits: []}},
    {
      name: 'span outside the transcript',
      payload: {
        text: 'serialize the JSON response',
        edits: [{
          start: 12,
          end: 500,
          original: 'Jason',
          replacement: 'JSON',
          basis: 'evidence',
          acousticReason: null,
          confidence: 0.9,
        }],
      },
    },
    {name: 'corrected text inconsistent with its edits', payload: {text: 'serialize the JSON response', edits: []}},
  ];
  for (const invalid of invalidPayloads) {
    const clock = new FakeClock();
    const reasoner = new RawReasoner(() => invalid.payload);
    const corrector = makeCorrector(reasoner, clock);
    const result = await corrector.correct(requestFor(entry, bundleFor(entry)));
    assert.equal(result.text, entry.rawTranscript, `${invalid.name}: raw text fallback`);
    assert.equal(result.rawText, entry.rawTranscript, `${invalid.name}: raw text preserved`);
    assert.equal(result.edits.length, 0, `${invalid.name}: no edit survives an invalid response`);
    assert.equal(result.unresolvedSpans.length, 0, `${invalid.name}: nothing is offered from an invalid response`);
    assert.equal(result.fallback, 'invalid_model_response', `${invalid.name}: fallback reason`);
    assert.equal(result.gates.harmfulEditsApplied, 0, `${invalid.name}: gate stays measured`);
  }

  const clock = new FakeClock();
  const crashing = new RawReasoner(() => {
    throw new Error('synthetic reasoner crash');
  });
  const corrector = makeCorrector(crashing, clock);
  const result = await corrector.correct(requestFor(entry, bundleFor(entry)));
  assert.equal(result.text, entry.rawTranscript, 'a crashing reasoner falls back to raw text');
  assert.equal(result.edits.length, 0);
  assert.equal(result.fallback, 'reasoner_error');
});

test('harmful-edit gate: no protected token changes across any fixture case', async () => {
  let reviewed = 0;
  for (const entry of fixture.cases) {
    const {result} = await outcomeFor(entry);
    assert.deepEqual(
      [...protectedTokens(result.text)],
      [...protectedTokens(result.rawText)],
      `${entry.key}: numbers, negation, flags, paths, and quoted literals must survive unchanged`,
    );
    assert.equal(result.gates.harmfulEditsApplied, 0, `${entry.key}: the reported gate must be zero`);
    reviewed += 1;
  }
  assert.ok(reviewed >= 12, 'every fixture case participates in the harmful-edit gate');
});

test('transparent history keeps raw and corrected text separately per correction', async () => {
  const first = mustCase('json-response-with-screenshot');
  const second = mustCase('verbatim-mode');
  const clock = new FakeClock();
  const reasoner = new ScriptedReasoner(first, clock, first.modelLatencyMs);
  const corrector = makeCorrector(reasoner, clock);
  await corrector.correct(requestFor(first, bundleFor(first)));
  await corrector.correct(requestFor(second, bundleFor(second)));
  const history = corrector.history();
  assert.equal(history.length, 2, 'one history entry per correction');
  assert.equal(history[0]?.rawText, first.rawTranscript);
  assert.equal(history[0]?.text, 'serialize the JSON response');
  assert.notEqual(history[0]?.text, history[0]?.rawText, 'raw and corrected text stay separately inspectable');
  assert.equal(history[1]?.rawText, second.rawTranscript);
  assert.equal(history[1]?.text, second.rawTranscript);
  assert.equal(history[1]?.mode, 'verbatim');
});

/** Minimal deterministic stand-in for the signed helper at the A01 seam. */
class FakeCaptureBridge {
  buffer = '';
  submits = 0;
  activations = 0;
  readonly keys: Array<string> = [];
  readonly clipboard = {
    changeCount: (): number => 7,
    readText: (): string => '',
    writeText: (): void => undefined,
  };
  private readonly entry: FixtureCase;

  constructor(entry: FixtureCase) {
    this.entry = entry;
  }

  async currentTarget(): Promise<CaptureTarget> {
    return this.target();
  }

  async captureContext(request: CaptureRequest): Promise<CaptureOutcome> {
    return {
      status: 'captured',
      snapshot: {
        snapshotId: `a02-e2e-${this.entry.key}`,
        capturedAtMs: CAPTURED_AT_MS,
        target: this.target(),
        screenshotRef: request.includeScreenshot
          ? (this.entry.screenshot === null ? null : this.entry.screenshot.ref)
          : null,
        selectedText: this.entry.selectedText,
        axNodes: this.entry.axValues.map((value, index) => ({
          nodeId: `ax-${index}`,
          bundleId: fixture.surface.bundleId,
          role: 'AXStaticText',
          value,
          secure: false,
          bounds: fixture.surface.bounds,
        })),
        ocrSpans: this.entry.ocrTexts.map((text) => ({
          text,
          bundleId: fixture.surface.bundleId,
          bounds: fixture.surface.bounds,
        })),
        quality: 'full',
        truncated: false,
      },
    };
  }

  async insertText(request: InsertRequest): Promise<InsertOutcome> {
    assert.equal(request.submit, false, 'dictation never submits');
    this.buffer += request.text;
    return {status: 'inserted', transactionId: request.transactionId, method: 'accessibility'};
  }

  async undo(request: Readonly<{transactionId: string}>): Promise<Readonly<{
    status: 'undone' | 'nothing_to_undo';
    transactionId: string | null;
  }>> {
    this.buffer = '';
    return {status: 'undone', transactionId: request.transactionId};
  }

  async sendKey(key: string): Promise<void> {
    this.keys.push(key);
    this.submits += 1;
  }

  async activateApplication(_bundleId: string): Promise<void> {
    this.activations += 1;
  }

  private target(): CaptureTarget {
    const surface = fixture.surface;
    return {
      fingerprint: {
        bundleId: surface.bundleId,
        pid: surface.pid,
        windowId: surface.windowId,
        elementFingerprint: surface.elementFingerprint,
      },
      displayId: surface.displayId,
      bounds: surface.bounds,
      pixelScale: surface.pixelScale,
      role: surface.role,
      secure: false,
      editable: true,
    };
  }
}

test('corrected text inserts literally into the A01 target, with no submission and a working undo', async () => {
  const entry = mustCase('json-response-with-screenshot');
  const screenshot = entry.screenshot;
  assert.ok(screenshot, 'the end-to-end case must have a permitted screenshot');
  const bridge = new FakeCaptureBridge(entry);
  const controller = createDictationController({
    bridge: bridge as unknown as CaptureBridge,
    excludedBundleIds: fixture.excludedBundleIds,
  });

  const preview = await controller.beginUtterance({screenshot: true});
  assert.equal(preview.mode, 'context');
  assert.equal(preview.bundle.screenshotRef, screenshot.ref);
  assert.equal(preview.bundle.ocrSpans[0]?.text, entry.ocrTexts[0]);

  const clock = new FakeClock();
  const reasoner = new ScriptedReasoner(entry, clock, entry.modelLatencyMs);
  const corrector = makeCorrector(reasoner, clock);
  const result = await corrector.correct({
    rawTranscript: entry.rawTranscript,
    mode: entry.mode,
    bundle: preview.bundle,
    screenshot,
    glossary: glossaryFor(entry),
    memoryEvidence: entry.memoryEvidence,
  });
  assert.equal(result.text, entry.expect.text);
  assert.equal(result.rawText, entry.rawTranscript);
  assert.equal(result.gates.withinWarmBudget, true);

  await controller.commitTranscript(result.text);
  const insertion = await controller.insert();
  assert.equal(insertion.status, 'inserted');
  assert.equal(bridge.buffer, 'serialize the JSON response');
  assert.equal(bridge.submits, 0, 'no submission key was ever synthesized');
  assert.equal(bridge.keys.length, 0, 'no key synthesis on the accessibility path');
  assert.equal(bridge.activations, 0, 'dictation must not change focus');

  const undo = await controller.undo();
  assert.equal(undo.status, 'undone');
  assert.equal(bridge.buffer, '');
});
