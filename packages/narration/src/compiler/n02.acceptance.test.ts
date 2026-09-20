/**
 * N02 acceptance oracle — messy diff/log stream → typed claims → configured spoken chapters
 * (IMPLEMENTATION_PLAN.md §7.2 N02 and §5.7 narration stages 1–6; BACKLOG N02).
 *
 * The oracle drives the frozen seam with the deterministic, synthetic 200-run corpus that
 * `fixtures/narration/large/check-corpus.mjs` rebuilds from index-derived values only (no network,
 * no clock, no user data). That CLI is executed here and its digest is frozen, so the corpus cannot
 * be reshaped to fit an implementation; the labels (facts, criticality, raw detail, redraw counts,
 * exact-reading requests) live only in the fixture and are never handed to the compiler.
 *
 * Frozen seam (this file pins these names):
 *
 * packages/narration/src/compiler/index.ts
 *   export const NARRATION_VERBOSITIES = ['concise', 'balanced', 'detailed', 'thorough']
 *
 *   export function compileNarration({ run, verbosity, exactReading }) → CompiledNarration
 *     run — one corpus run as { runId, sessionId, taskId, events, payloads }: normalized §5.3
 *       EventEnvelope records plus the payload each `payloadRef` resolves to, in the pinned shapes
 *       documented in `fixtures/narration/large/check-corpus.mjs` (tool_started / tool_completed /
 *       unsupported(log_line) / agent_message / decision / artifact_changed / approval_requested /
 *       permission_changed / session_state). No labels are visible to the compiler.
 *     verbosity — one of NARRATION_VERBOSITIES. §5.7 upper bounds per logical update (chapter):
 *       concise 50, balanced 120, detailed 250, thorough 600 words. Every spoken segment stays
 *       inside 40 seconds at the shared local-voice pacing N01 already assumes (~2.5 words/second),
 *       so a section's declared `maxSeconds` must cover its own text.
 *     exactReading — optional { text }: the explicit "read it exactly" request.
 *     Returns (synchronously or as a Promise):
 *       {
 *         verbosity,
 *         chapters: [{ id, title, evidenceIds,
 *                      segments: [{ id, text, maxSeconds, exact, claimIds, evidenceIds }] }],
 *         claims:   [{ id, kind: 'result'|'decision'|'change'|'problem'|'progress'|'verification',
 *                      text, evidenceIds, supported, agentReported }],
 *         suppressed: { duplicateRedraws, unsupportedClaims, duplicateClaims },
 *       }
 *     Behavior fixed here:
 *       - a claim may set `supported: true` only when its evidence is observed output; anything
 *         derived from `agent_message` prose stays unsupported, so prose that contradicts a nonzero
 *         exit code can never become a verified, spoken fact (§5.7 stage 5);
 *       - every spoken segment cites the typed claims it speaks, and every claim cites durable
 *         events of the same run: no hallucinated evidence;
 *       - rising verbosity covers materially more of the same corpus (concise ≈ observed outcomes,
 *         thorough ≈ near-complete useful meaning without reciting duplicate log lines);
 *       - exact-reading segments preserve the requested text verbatim in bounded chunks, while
 *         ordinary segments never recite raw paths, URLs or code (§5.7 stage 6);
 *       - repeated progress redraws collapse instead of producing one utterance per redraw: groups of
 *         identical progress lines yield at most one spoken update, never one claim per copy;
 *       - an observed nonzero exit stays spoken at balanced/thorough in recognisable words (failure,
 *         error, exit status), never smoothed into a success sentence.
 *
 * packages/narration/src/formatting/index.ts
 *   export function formatForSpeech(text, options?) → string
 *     options.exact === true returns the text verbatim. Otherwise URLs become site labels, paths
 *     become meaningful basenames and code becomes speech, so ordinary formatted text carries none
 *     of the raw separators ('/', '\\', '://', backticks) the user should not have to hear.
 *
 * Remaining limitation: the corpus is a deterministic normalized journal, not a live harness or a
 * live Reasoner, and no microphone, signed helper or TTS voice is exercised. Every acceptance
 * criterion is decided offline from frozen evidence; interactive hardware qualification stays out
 * of scope for this ticket's automated oracle.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '../../../contracts/src/index.js';

const CORPUS_SCRIPT = fileURLToPath(new URL('../../../../fixtures/narration/large/check-corpus.mjs', import.meta.url));
/** Frozen with `node fixtures/narration/large/check-corpus.mjs --summary`. */
const CORPUS_DIGEST = 'sha256:5ede117487a626009a5c09028cb153abc950130dc8830e3b129fad8edabfc5f7';
const RUN_COUNT = 200;
const COMPILER_MODULE = ['.', 'index.js'].join('/');
const FORMATTING_MODULE = ['..', 'formatting', 'index.js'].join('/');

const VERBOSITIES = ['concise', 'balanced', 'detailed', 'thorough'] as const;
type Verbosity = (typeof VERBOSITIES)[number];
/** §5.7 verbosity budgets per logical update (chapter), in words. */
const CHAPTER_WORD_CEILING: Readonly<Record<Verbosity, number>> = {
  concise: 50,
  balanced: 120,
  detailed: 250,
  thorough: 600,
};
const MAX_SEGMENT_SECONDS = 40;
const WORDS_PER_SECOND = 2.5;
const REDRAW_MARKER = 'N02-REDRAW';
const CLAIM_KINDS = new Set(['result', 'decision', 'change', 'problem', 'progress', 'verification']);
/** A spoken failure must stay recognisable to a listener, not be smoothed into a success. */
const FAILURE_WORDS = /\b(?:fail(?:ed|ure|s)?|error|problem|unsuccessful|abort(?:ed)?|crash(?:ed)?|non-?zero|exit(?:ed)?(?:\s+(?:code|status))?\s+[1-9]\d*|returned\s+[1-9]\d*|code\s+[1-9]\d*)\b/iu;
/** Ordinary speech never carries a raw absolute (or dot-relative) path token. */
const RAW_PATH_TOKEN = /(?:^|\s)(?:\.{0,2}\/|~\/|\/)[^\s]*/u;
/** Ordinary speech never carries a multi-segment relative path such as `src/compiler/index.ts`. */
const NESTED_PATH_TOKEN = /(?:^|\s)[A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]*\/[^\s]*/u;

type CorpusFact = Readonly<{
  id: string;
  kind: string;
  critical: boolean;
  supported: boolean;
  evidenceEventIds: ReadonlyArray<string>;
}>;

type CorpusLabels = Readonly<{
  facts: ReadonlyArray<CorpusFact>;
  rawDetail: Readonly<{ paths: ReadonlyArray<string>; urls: ReadonlyArray<string>; code: ReadonlyArray<string> }>;
  formattingSamples: ReadonlyArray<string>;
  duplicateRedraws: number;
  exactReading: Readonly<{ text: string }> | null;
  falseSuccessClaim: Readonly<{ eventId: string; phrase: string }> | null;
  finalReceiptEventId: string | null;
  finalExitCode: number | null;
}>;

type CorpusRun = Readonly<{
  runId: string;
  sessionId: string;
  taskId: string;
  archetype: string;
  events: ReadonlyArray<EventEnvelope>;
  payloads: Readonly<Record<string, unknown>>;
  labels: CorpusLabels;
}>;

type CorpusDocument = Readonly<{
  contractVersion: number;
  fixtureId: string;
  consent: string;
  seed: string;
  runCount: number;
  digest: string;
  runs: ReadonlyArray<CorpusRun>;
}>;

type NarrationClaim = Readonly<{
  id: string;
  kind: string;
  text: string;
  evidenceIds: ReadonlyArray<string>;
  supported: boolean;
  agentReported: boolean;
}>;

type NarrationSegment = Readonly<{
  id: string;
  text: string;
  maxSeconds: number;
  exact: boolean;
  claimIds: ReadonlyArray<string>;
  evidenceIds: ReadonlyArray<string>;
}>;

type NarrationChapter = Readonly<{
  id: string;
  title: string;
  segments: ReadonlyArray<NarrationSegment>;
  evidenceIds: ReadonlyArray<string>;
}>;

type CompiledNarration = Readonly<{
  verbosity: string;
  chapters: ReadonlyArray<NarrationChapter>;
  claims: ReadonlyArray<NarrationClaim>;
  suppressed: Readonly<{ duplicateRedraws: number; unsupportedClaims: number; duplicateClaims: number }>;
}>;

type CompileInput = Readonly<{
  run: Readonly<{
    runId: string;
    sessionId: string;
    taskId: string;
    events: ReadonlyArray<EventEnvelope>;
    payloads: Readonly<Record<string, unknown>>;
  }>;
  verbosity: Verbosity;
  exactReading?: Readonly<{ text: string }> | null;
}>;

type CompileNarration = (input: CompileInput) => CompiledNarration | Promise<CompiledNarration>;
type FormatForSpeech = (text: string, options?: Readonly<{ exact?: boolean }>) => string;
type ModuleNamespace = Record<string, unknown>;

/** Loads a yet-to-be-implemented module, turning "module missing" into a named behavior failure. */
async function importModule(specifier: string, missingBehavior: string): Promise<ModuleNamespace> {
  try {
    return (await import(specifier)) as ModuleNamespace;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/u.test(String((error as Error).message))) {
      assert.fail(missingBehavior);
    }
    throw error;
  }
}

async function compilerFactory(): Promise<CompileNarration> {
  const loaded = await importModule(
    COMPILER_MODULE,
    'N02 required narration behavior is not implemented yet: packages/narration/src/compiler/index.ts '
    + 'must export compileNarration({ run, verbosity, exactReading }) so a messy diff/log stream is '
    + 'reduced to typed claims and spoken chapters at all four §5.7 verbosity budgets (plan §7.2 N02).',
  );
  assert.equal(
    typeof loaded.compileNarration,
    'function',
    'packages/narration/src/compiler must export compileNarration({ run, verbosity, exactReading })',
  );
  assert.ok(
    Array.isArray(loaded.NARRATION_VERBOSITIES),
    'packages/narration/src/compiler must export NARRATION_VERBOSITIES (concise, balanced, detailed, thorough)',
  );
  assert.deepEqual(
    [...(loaded.NARRATION_VERBOSITIES as ReadonlyArray<string>)],
    [...VERBOSITIES],
    'NARRATION_VERBOSITIES must list the four §5.7 budgets in rising order',
  );
  return loaded.compileNarration as CompileNarration;
}

async function formattingFunction(): Promise<FormatForSpeech> {
  const loaded = await importModule(
    FORMATTING_MODULE,
    'N02 required narration behavior is not implemented yet: packages/narration/src/formatting/index.ts '
    + 'must export formatForSpeech(text, options) so ordinary speech omits raw paths/URLs/code while an '
    + 'explicit exact reading preserves the requested text (§5.7 stage 6).',
  );
  assert.equal(
    typeof loaded.formatForSpeech,
    'function',
    'packages/narration/src/formatting must export formatForSpeech(text, options)',
  );
  return loaded.formatForSpeech as FormatForSpeech;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      ordered[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return ordered;
  }
  return value;
}

/** Recomputes the fixture digest exactly like `check-corpus.mjs` does (digest/stats stripped). */
function corpusDigest(document: CorpusDocument): string {
  const base = {
    contractVersion: document.contractVersion,
    fixtureId: document.fixtureId,
    consent: document.consent,
    seed: document.seed,
    runCount: document.runCount,
    runs: document.runs,
  };
  return `sha256:${sha256(JSON.stringify(canonicalize(base)))}`;
}

function loadCorpus(): CorpusDocument {
  const result = spawnSync(process.execPath, [CORPUS_SCRIPT, '--json'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `the N02 corpus fixture must self-validate:\n${result.stderr ?? ''}`);
  const document = JSON.parse(result.stdout) as CorpusDocument;
  assert.equal(document.runCount, RUN_COUNT, 'the N02 corpus must stay a 200-run corpus');
  assert.equal(document.runs.length, RUN_COUNT, 'the N02 corpus must materialize 200 runs');
  assert.equal(document.consent, 'synthetic', 'the N02 corpus must stay synthetic');
  assert.equal(corpusDigest(document), CORPUS_DIGEST, 'the frozen N02 corpus fixture changed');
  assert.equal(document.digest, CORPUS_DIGEST, 'the fixture must report its own frozen digest');
  return document;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0).length;
}

function compilerInput(run: CorpusRun): CompileInput['run'] {
  return { runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, events: run.events, payloads: run.payloads };
}

function eventIds(run: CorpusRun): ReadonlySet<string> {
  return new Set(run.events.map((event) => event.eventId));
}

/** Observed output (anything the tool boundary recorded) — agent prose is never evidence. */
function observedEventIds(run: CorpusRun): ReadonlySet<string> {
  return new Set(run.events.filter((event) => event.kind !== 'agent_message').map((event) => event.eventId));
}

function receiptEventIds(run: CorpusRun): ReadonlySet<string> {
  return new Set(run.events.filter((event) => event.kind === 'tool_completed').map((event) => event.eventId));
}

function failingReceiptEventIds(run: CorpusRun): ReadonlySet<string> {
  const failing = new Set<string>();
  for (const event of run.events) {
    if (event.kind !== 'tool_completed') continue;
    const payload = run.payloads[event.payloadRef] as { exitCode?: unknown } | undefined;
    if (typeof payload?.exitCode === 'number' && payload.exitCode !== 0) failing.add(event.eventId);
  }
  return failing;
}

function rawTokens(run: CorpusRun): ReadonlyArray<string> {
  const { paths, urls, code } = run.labels.rawDetail;
  return [...paths, ...urls, ...code];
}

const corpus = loadCorpus();
const corpusRunIds = new Set(corpus.runs.map((run) => run.runId));
assert.equal(corpusRunIds.size, RUN_COUNT, 'the N02 corpus must not repeat run ids');

type CompiledCorpus = ReadonlyMap<string, ReadonlyMap<Verbosity, CompiledNarration>>;

async function compileCorpus(compile: CompileNarration): Promise<CompiledCorpus> {
  const compiled = new Map<string, Map<Verbosity, CompiledNarration>>();
  for (const run of corpus.runs) {
    const perVerbosity = new Map<Verbosity, CompiledNarration>();
    for (const verbosity of VERBOSITIES) {
      perVerbosity.set(verbosity, await compile({ run: compilerInput(run), verbosity, exactReading: null }));
    }
    compiled.set(run.runId, perVerbosity);
  }
  return compiled;
}

/** One shared 200-run × 4-verbosity compilation for the whole file (deterministic, keeps the oracle fast). */
let sharedCompilations: Promise<CompiledCorpus> | undefined;
async function corpusCompilations(): Promise<CompiledCorpus> {
  sharedCompilations ??= compilerFactory().then((compile) => compileCorpus(compile));
  return sharedCompilations;
}

function compiledFor(compiled: CompiledCorpus, run: CorpusRun, verbosity: Verbosity): CompiledNarration {
  const perVerbosity = compiled.get(run.runId);
  assert.ok(perVerbosity !== undefined, `${run.runId} must be compiled`);
  const result = perVerbosity.get(verbosity);
  assert.ok(result !== undefined, `${run.runId}@${verbosity} must be compiled`);
  return result;
}

/** Structural + grounding checks for one compilation. Throws with the run/verbosity in the message. */
function checkCompilation(run: CorpusRun, compiled: CompiledNarration, verbosity: Verbosity): void {
  const where = `${run.runId}@${verbosity}`;
  assert.equal(compiled.verbosity, verbosity, `${where}: the result must echo its verbosity`);
  assert.ok(Array.isArray(compiled.chapters) && compiled.chapters.length > 0, `${where}: at least one chapter is required`);
  assert.ok(typeof compiled.suppressed === 'object' && compiled.suppressed !== null, `${where}: suppressed counters are required`);
  for (const field of ['duplicateRedraws', 'unsupportedClaims', 'duplicateClaims'] as const) {
    const value = compiled.suppressed[field];
    assert.ok(
      typeof value === 'number' && Number.isFinite(value) && value >= 0,
      `${where}: suppressed.${field} must be a non-negative number`,
    );
  }

  const claimIds = new Set<string>();
  const knownEvents = eventIds(run);
  const observed = observedEventIds(run);
  for (const claim of compiled.claims) {
    assert.ok(!claimIds.has(claim.id), `${where}: claim ${claim.id} is duplicated`);
    claimIds.add(claim.id);
    assert.ok(CLAIM_KINDS.has(claim.kind), `${where}: claim ${claim.id} has unknown kind ${claim.kind}`);
    assert.ok(claim.text.trim().length > 0, `${where}: claim ${claim.id} must have text`);
    assert.ok(claim.evidenceIds.length > 0, `${where}: claim ${claim.id} must cite durable evidence`);
    for (const id of claim.evidenceIds) {
      assert.ok(knownEvents.has(id), `${where}: claim ${claim.id} cites unknown event ${id}`);
    }
    const grounded = claim.evidenceIds.some((id) => observed.has(id));
    if (claim.supported) {
      assert.ok(grounded, `${where}: claim ${claim.id} is marked supported without observed evidence`);
    }
    if (claim.evidenceIds.every((id) => !observed.has(id))) {
      assert.equal(
        claim.supported,
        false,
        `${where}: agent prose (${claim.evidenceIds.join(', ')}) can never become a verified claim`,
      );
      assert.equal(claim.agentReported, true, `${where}: an unsupported claim must stay marked as agent-reported`);
    }
  }

  const seenSegmentIds = new Set<string>();
  for (const chapter of compiled.chapters) {
    assert.ok(chapter.id.length > 0, `${where}: chapters need ids`);
    assert.ok(chapter.title.trim().length > 0, `${where}: chapter ${chapter.id} needs a title`);
    assert.ok(chapter.segments.length > 0, `${where}: chapter ${chapter.id} needs segments`);
    let chapterWords = 0;
    for (const segment of chapter.segments) {
      assert.ok(!seenSegmentIds.has(segment.id), `${where}: segment ${segment.id} is duplicated`);
      seenSegmentIds.add(segment.id);
      assert.ok(segment.text.trim().length > 0, `${where}: segment ${segment.id} must have text`);
      assert.equal(segment.exact, false, `${where}: ordinary compilation must not mark segments exact`);
      assert.ok(
        typeof segment.maxSeconds === 'number' && segment.maxSeconds > 0 && segment.maxSeconds <= MAX_SEGMENT_SECONDS,
        `${where}: segment ${segment.id} must declare a bounded time budget (0, ${MAX_SEGMENT_SECONDS}]`,
      );
      const words = wordCount(segment.text);
      chapterWords += words;
      assert.ok(
        words <= Math.ceil(segment.maxSeconds * WORDS_PER_SECOND),
        `${where}: segment ${segment.id} speaks ${words} words but only budgets ${segment.maxSeconds}s`,
      );
      assert.ok(segment.evidenceIds.length > 0, `${where}: segment ${segment.id} must cite evidence`);
      for (const id of segment.evidenceIds) {
        assert.ok(knownEvents.has(id), `${where}: segment ${segment.id} cites unknown event ${id}`);
      }
      assert.ok(segment.claimIds.length > 0, `${where}: segment ${segment.id} must cite the claims it speaks`);
      for (const id of segment.claimIds) {
        assert.ok(claimIds.has(id), `${where}: segment ${segment.id} cites unknown claim ${id}`);
      }
    }
    assert.ok(
      chapterWords <= CHAPTER_WORD_CEILING[verbosity],
      `${where}: chapter ${chapter.id} speaks ${chapterWords} words, over the ${verbosity} budget of ${CHAPTER_WORD_CEILING[verbosity]}`,
    );
  }
}

function spokenClaims(run: CorpusRun, compiled: CompiledNarration): ReadonlyArray<NarrationClaim> {
  const byId = new Map(compiled.claims.map((claim) => [claim.id, claim]));
  const spoken = new Map<string, NarrationClaim>();
  for (const chapter of compiled.chapters) {
    for (const segment of chapter.segments) {
      for (const id of segment.claimIds) {
        const claim = byId.get(id);
        assert.ok(claim !== undefined, `${run.runId}: segment ${segment.id} cites unknown claim ${id}`);
        spoken.set(id, claim);
      }
    }
  }
  return [...spoken.values()];
}

function isGrounded(run: CorpusRun, claim: NarrationClaim): boolean {
  const known = eventIds(run);
  const observed = observedEventIds(run);
  return claim.evidenceIds.length > 0
    && claim.evidenceIds.every((id) => known.has(id))
    && claim.evidenceIds.some((id) => observed.has(id));
}

function coveredFacts(run: CorpusRun, compiled: CompiledNarration): ReadonlySet<string> {
  const covered = new Set<string>();
  const spoken = spokenClaims(run, compiled);
  for (const claim of spoken) {
    if (!claim.supported || !isGrounded(run, claim)) continue;
    for (const fact of run.labels.facts) {
      if (!fact.supported) continue;
      if (fact.evidenceEventIds.some((id) => claim.evidenceIds.includes(id))) covered.add(fact.id);
    }
  }
  return covered;
}

function allSegmentTexts(compiled: CompiledNarration): ReadonlyArray<string> {
  return compiled.chapters.flatMap((chapter) => chapter.segments.map((segment) => segment.text));
}

/** Groups of events whose payload repeats the same progress line (the redraw storm the compiler must collapse). */
function repeatedLineGroups(run: CorpusRun): ReadonlyArray<ReadonlySet<string>> {
  const byLine = new Map<string, Array<string>>();
  for (const event of run.events) {
    if (event.kind === 'agent_message') continue;
    const payload = run.payloads[event.payloadRef] as { line?: unknown } | undefined;
    if (typeof payload?.line !== 'string' || payload.line.length === 0) continue;
    const list = byLine.get(payload.line) ?? [];
    list.push(event.eventId);
    byLine.set(payload.line, list);
  }
  return [...byLine.values()].filter((ids) => ids.length > 1).map((ids) => new Set(ids));
}

function totalWords(compiled: CompiledNarration): number {
  return allSegmentTexts(compiled).reduce((sum, text) => sum + wordCount(text), 0);
}

test('N02: the frozen corpus is a deterministic 200-run stream with labels the compiler cannot see', () => {
  assert.equal(corpus.contractVersion, 1, 'the corpus speaks contract version 1');
  assert.equal(corpus.fixtureId, 'narration-large-messy-200');
  const facts = corpus.runs.flatMap((run) => run.labels.facts);
  const critical = facts.filter((fact) => fact.critical);
  assert.ok(facts.length >= 800, `the corpus must label a large fact set, got ${facts.length}`);
  assert.ok(critical.length >= 200, `the corpus must label critical facts, got ${critical.length}`);
  assert.ok(
    corpus.runs.filter((run) => run.labels.falseSuccessClaim !== null).length >= 30,
    'the corpus must contain prose that contradicts an observed exit code',
  );
  assert.ok(
    corpus.runs.filter((run) => run.labels.exactReading !== null).length >= 10,
    'the corpus must contain explicit exact-reading requests',
  );
  assert.ok(
    corpus.runs.filter((run) => run.labels.duplicateRedraws > 0).length >= 10,
    'the corpus must contain repeated progress redraws',
  );
  for (const run of corpus.runs) {
    assert.ok(run.labels.finalReceiptEventId !== null, `${run.runId} must observe a final receipt`);
    assert.ok(receiptEventIds(run).size > 0, `${run.runId} must carry a tool receipt`);
    assert.ok(rawTokens(run).length > 0, `${run.runId} must carry raw path/URL/code detail`);
    assert.ok(run.labels.formattingSamples.length > 0, `${run.runId} must carry a raw formatting sample`);
  }
});

test('N02: every verbosity compiles the 200-run corpus into bounded, evidence-backed spoken chapters', async () => {
  const compiled = await corpusCompilations();
  for (const run of corpus.runs) {
    for (const verbosity of VERBOSITIES) {
      checkCompilation(run, compiledFor(compiled, run, verbosity), verbosity);
    }
  }

  // Every run's observed outcome is spoken at every budget: narration may compress detail, never
  // the observed result itself. Failures stay visible at the default levels.
  for (const run of corpus.runs) {
    const receipts = receiptEventIds(run);
    const failing = failingReceiptEventIds(run);
    for (const verbosity of VERBOSITIES) {
      const spoken = spokenClaims(run, compiledFor(compiled, run, verbosity));
      const citesReceipt = spoken.some((claim) => claim.supported && claim.agentReported === false
        && claim.evidenceIds.some((id) => receipts.has(id)));
      assert.ok(citesReceipt, `${run.runId}@${verbosity}: the observed outcome must be spoken and supported`);
      if (failing.size > 0 && (verbosity === 'balanced' || verbosity === 'thorough')) {
        const failureClaims = spoken.filter((claim) => claim.supported && claim.agentReported === false
          && claim.evidenceIds.some((id) => failing.has(id)));
        assert.ok(failureClaims.length > 0, `${run.runId}@${verbosity}: an observed failure must be spoken, not smoothed over`);
        assert.ok(
          failureClaims.some((claim) => FAILURE_WORDS.test(claim.text)),
          `${run.runId}@${verbosity}: the spoken failure must stay recognisable as a failure, got "${failureClaims[0]?.text ?? ''}"`,
        );
      }
    }
  }
});

test('N02: Concise through Thorough produce materially different, supported coverage of the same corpus', async () => {
  const compiled = await corpusCompilations();

  const coverage = new Map<Verbosity, number>();
  const volume = new Map<Verbosity, number>();
  for (const verbosity of VERBOSITIES) {
    let supportedFacts = 0;
    let covered = 0;
    let words = 0;
    for (const run of corpus.runs) {
      const result = compiledFor(compiled, run, verbosity);
      const facts = run.labels.facts.filter((fact) => fact.supported);
      supportedFacts += facts.length;
      const coveredIds = coveredFacts(run, result);
      covered += facts.filter((fact) => coveredIds.has(fact.id)).length;
      words += totalWords(result);
    }
    coverage.set(verbosity, covered / supportedFacts);
    volume.set(verbosity, words);
  }

  const concise = coverage.get('concise')!;
  const balanced = coverage.get('balanced')!;
  const detailed = coverage.get('detailed')!;
  const thorough = coverage.get('thorough')!;

  assert.ok(concise >= 0.1, `concise coverage must still be a real digest, got ${concise.toFixed(3)}`);
  assert.ok(balanced > concise + 0.05, `balanced must add coverage over concise (${concise.toFixed(3)} → ${balanced.toFixed(3)})`);
  assert.ok(detailed > balanced + 0.05, `detailed must add coverage over balanced (${balanced.toFixed(3)} → ${detailed.toFixed(3)})`);
  assert.ok(thorough > detailed + 0.05, `thorough must add coverage over detailed (${detailed.toFixed(3)} → ${thorough.toFixed(3)})`);
  assert.ok(thorough - concise >= 0.25, `thorough must be materially richer than concise (${concise.toFixed(3)} → ${thorough.toFixed(3)})`);

  const conciseWords = volume.get('concise')!;
  const balancedWords = volume.get('balanced')!;
  const detailedWords = volume.get('detailed')!;
  const thoroughWords = volume.get('thorough')!;
  assert.ok(balancedWords > conciseWords, `balanced must speak more than concise (${conciseWords} → ${balancedWords})`);
  assert.ok(detailedWords > balancedWords, `detailed must speak more than balanced (${balancedWords} → ${detailedWords})`);
  assert.ok(thoroughWords > detailedWords, `thorough must speak more than detailed (${detailedWords} → ${thoroughWords})`);
  assert.ok(thoroughWords >= conciseWords * 1.5, `thorough must be materially longer than concise (${conciseWords} → ${thoroughWords})`);
});

test('N02: critical-event recall ≥95% and supported factual claims ≥98%', async () => {
  const compiled = await corpusCompilations();

  let criticalFacts = 0;
  let criticalCovered = 0;
  for (const run of corpus.runs) {
    const covered = coveredFacts(run, compiledFor(compiled, run, 'thorough'));
    for (const fact of run.labels.facts) {
      if (!fact.supported || !fact.critical) continue;
      criticalFacts += 1;
      if (covered.has(fact.id)) criticalCovered += 1;
    }
  }
  const recall = criticalCovered / criticalFacts;
  assert.ok(
    recall >= 0.95,
    `critical-event recall at thorough must be ≥95%, got ${(recall * 100).toFixed(1)}% (${criticalCovered}/${criticalFacts})`,
  );

  let factualSpoken = 0;
  let supportedSpoken = 0;
  for (const run of corpus.runs) {
    for (const verbosity of VERBOSITIES) {
      for (const claim of spokenClaims(run, compiledFor(compiled, run, verbosity))) {
        if (claim.agentReported) continue;
        factualSpoken += 1;
        if (claim.supported && isGrounded(run, claim)) supportedSpoken += 1;
      }
    }
  }
  assert.ok(factualSpoken >= 300, `the corpus must produce a meaningful claim set, got ${factualSpoken} spoken claims`);
  const support = supportedSpoken / factualSpoken;
  assert.ok(
    support >= 0.98,
    `supported factual claims must be ≥98%, got ${(support * 100).toFixed(1)}% (${supportedSpoken}/${factualSpoken})`,
  );
});

test('N02: repeated progress redraws do not create speech storms', async () => {
  const compiled = await corpusCompilations();
  const redrawRuns = corpus.runs.filter((run) => run.labels.duplicateRedraws > 0);
  assert.ok(redrawRuns.length >= 10, 'the corpus must contain redraw-heavy runs');

  let corpusRedrawSegments = 0;
  for (const run of redrawRuns) {
    for (const verbosity of VERBOSITIES) {
      const result = compiledFor(compiled, run, verbosity);
      const texts = allSegmentTexts(result);
      const redrawSegments = texts.filter((text) => text.includes(REDRAW_MARKER)).length;
      corpusRedrawSegments += redrawSegments;
      assert.ok(
        redrawSegments <= 1,
        `${run.runId}@${verbosity}: ${redrawSegments} segments speak the redraw marker, expected at most one digest`,
      );
      assert.ok(
        result.chapters.length <= 6,
        `${run.runId}@${verbosity}: chapters must track logical updates, not raw redraws (${result.chapters.length})`,
      );
      assert.ok(
        result.suppressed.duplicateRedraws >= run.labels.duplicateRedraws,
        `${run.runId}@${verbosity}: suppressed.duplicateRedraws must report the collapsed redraws`,
      );
      const markerHits = texts.join(' ').split(REDRAW_MARKER).length - 1;
      assert.ok(markerHits <= 1, `${run.runId}@${verbosity}: the redraw marker may be voiced at most once`);
      for (const group of repeatedLineGroups(run)) {
        const citing = spokenClaims(run, result)
          .filter((claim) => claim.evidenceIds.some((id) => group.has(id)))
          .length;
        assert.ok(
          citing <= 2,
          `${run.runId}@${verbosity}: ${group.size} identical progress lines must collapse into one update, but ${citing} spoken claims cite them`,
        );
      }
    }
  }
  for (const run of redrawRuns) {
    assert.ok(
      repeatedLineGroups(run).length > 0,
      `${run.runId}: a labelled redraw run must contain repeated identical progress lines`,
    );
  }
  assert.ok(
    corpusRedrawSegments <= redrawRuns.length,
    `redraws must not multiply speech: ${corpusRedrawSegments} redraw segments for ${redrawRuns.length} runs`,
  );
});

test('N02: exact reading preserves requested text in bounded segments while ordinary speech omits raw detail', async () => {
  const compile = await compilerFactory();
  const formatForSpeech = await formattingFunction();
  const compiled = await corpusCompilations();

  for (const run of corpus.runs) {
    for (const verbosity of VERBOSITIES) {
      const ordinary = allSegmentTexts(compiledFor(compiled, run, verbosity)).join(' ');
      for (const token of rawTokens(run)) {
        assert.ok(
          !ordinary.includes(token),
          `${run.runId}@${verbosity}: ordinary narration must not recite raw detail ${token}`,
        );
      }
      assert.ok(!ordinary.includes('://'), `${run.runId}@${verbosity}: ordinary narration must not read a URL scheme`);
      assert.ok(!ordinary.includes('`'), `${run.runId}@${verbosity}: ordinary narration must not read code fences`);
      assert.ok(!RAW_PATH_TOKEN.test(ordinary), `${run.runId}@${verbosity}: ordinary narration must not read raw paths`);
      assert.ok(!NESTED_PATH_TOKEN.test(ordinary), `${run.runId}@${verbosity}: ordinary narration must not read nested paths`);
    }
  }

  const exactRuns = corpus.runs.filter((run) => run.labels.exactReading !== null);
  assert.ok(exactRuns.length >= 10, 'the corpus must carry explicit exact-reading requests');
  for (const run of exactRuns) {
    const request = run.labels.exactReading!.text;
    const expected = request.replace(/\s+/gu, ' ').trim();
    const result = await compile({ run: compilerInput(run), verbosity: 'balanced', exactReading: { text: request } });
    checkExactCompilation(run, result, expected);
    const exactSegments = result.chapters.flatMap((chapter) => chapter.segments).filter((segment) => segment.exact);
    const joined = exactSegments.map((segment) => segment.text.trim()).join(' ');
    assert.equal(joined, expected, `${run.runId}: exact reading must preserve the requested text verbatim`);
    assert.ok(
      exactSegments.length >= 3,
      `${run.runId}: a 200+ word exact request must be chunked into bounded segments, got ${exactSegments.length}`,
    );
    for (const token of rawTokens(run)) {
      assert.ok(joined.includes(token), `${run.runId}: exact reading must preserve raw detail ${token}`);
    }
    const ordinary = result.chapters.flatMap((chapter) => chapter.segments)
      .filter((segment) => !segment.exact)
      .map((segment) => segment.text)
      .join(' ');
    for (const token of rawTokens(run)) {
      assert.ok(!ordinary.includes(token), `${run.runId}: non-exact segments must not recite raw detail ${token}`);
    }
  }

  for (const run of corpus.runs) {
    for (const sample of run.labels.formattingSamples) {
      assert.equal(formatForSpeech(sample, { exact: true }), sample, `${run.runId}: exact formatting must be verbatim`);
      const ordinary = formatForSpeech(sample);
      assert.ok(ordinary.trim().length > 0, `${run.runId}: ordinary formatting must produce speakable text`);
      assert.equal(formatForSpeech(sample, { exact: false }), ordinary, `${run.runId}: ordinary mode must be the default`);
      for (const token of rawTokens(run)) {
        if (!sample.includes(token)) continue;
        assert.ok(!ordinary.includes(token), `${run.runId}: ordinary formatting must omit raw detail ${token}`);
      }
      assert.ok(!ordinary.includes('/'), `${run.runId}: ordinary formatting must not read raw path separators`);
      assert.ok(!ordinary.includes('\\'), `${run.runId}: ordinary formatting must not read raw path separators`);
      assert.ok(!ordinary.includes('://'), `${run.runId}: ordinary formatting must not read a URL scheme`);
      assert.ok(!ordinary.includes('`'), `${run.runId}: ordinary formatting must not read code fences`);
    }
  }
});

/** Exact-reading compilations must still be bounded, cited, and keep non-exact text ordinary. */
function checkExactCompilation(run: CorpusRun, compiled: CompiledNarration, _expected: string): void {
  const where = `${run.runId}@exact`;
  const knownEvents = eventIds(run);
  const claims = new Map(compiled.claims.map((claim) => [claim.id, claim]));
  let exactSegments = 0;
  for (const chapter of compiled.chapters) {
    for (const segment of chapter.segments) {
      assert.ok(segment.text.trim().length > 0, `${where}: segment ${segment.id} must have text`);
      assert.ok(
        typeof segment.maxSeconds === 'number' && segment.maxSeconds > 0 && segment.maxSeconds <= MAX_SEGMENT_SECONDS,
        `${where}: segment ${segment.id} must declare a bounded time budget (0, ${MAX_SEGMENT_SECONDS}]`,
      );
      const words = wordCount(segment.text);
      assert.ok(
        words <= Math.ceil(segment.maxSeconds * WORDS_PER_SECOND),
        `${where}: segment ${segment.id} speaks ${words} words but only budgets ${segment.maxSeconds}s`,
      );
      assert.ok(segment.evidenceIds.length > 0, `${where}: segment ${segment.id} must cite evidence`);
      for (const id of segment.evidenceIds) {
        assert.ok(knownEvents.has(id), `${where}: segment ${segment.id} cites unknown event ${id}`);
      }
      for (const id of segment.claimIds) {
        assert.ok(claims.has(id), `${where}: segment ${segment.id} cites unknown claim ${id}`);
      }
      if (segment.exact) {
        exactSegments += 1;
      } else {
        assert.ok(
          segment.text.trim().length > 0,
          `${where}: ordinary segments must survive alongside an exact reading`,
        );
      }
    }
  }
  assert.ok(exactSegments > 0, `${where}: the requested exact reading must be spoken`);
}
