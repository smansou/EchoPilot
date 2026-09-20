/**
 * A03 acceptance oracle — a user correction updates the glossary, the glossary survives a restart,
 * and the next matching dictation is better for it while unrelated speech is untouched; global
 * scope stays explicit and long dictation stays inside the audio/context budgets
 * (IMPLEMENTATION_PLAN.md §7.2 A03; plan §4.4 dictation windows, §5.4 correction rules, §5.8
 * budgets, judgment A-F6).
 *
 * Real ASR, the local Qwen reasoner, and the signed macOS helper need hardware, model weights, and
 * Screen Recording consent, so this oracle drives the frozen A03 seam with deterministic doubles
 * and enforces every property that is decidable off-device:
 *
 *   - a corrected proper name is learned once per term, survives close/reopen of the durable store,
 *     is exactly the entry shape the A02 request builder turns into `ctx:glossary:<i>` evidence,
 *     corrects the next matching utterance, and leaves an unrelated utterance byte-identical;
 *   - a rejected correction protects the person-name reading it was rejected for, keeps the
 *     technical variant working elsewhere, and never promotes anything to global;
 *   - learning is project-scoped, promotion to global happens only through the explicit promote
 *     call, and another project's identifier stays invisible — for retrieval and for correction —
 *     until an explicit grant;
 *   - the §4.4 ASR limits (≤15 s window, ≤1 s overlap) are enforced, committed windows concatenate
 *     without duplicating their overlap, an over-budget window is reported instead of transcribed,
 *     and a long dictation is corrected as a sequence of bounded chunks whose assembled requests
 *     fit the M02 budget.
 *
 * `packages/capture/src/glossary/index.ts` must export (this file pins these names; they are the
 * frozen A03 seam between the correction UI, the glossary store, and long-utterance correction):
 *
 *   GLOSSARY_SCOPES = ['project', 'global']
 *   MAX_DICTATION_WINDOW_MS = 15000     §4.4: "a maximum 15-second rolling window"
 *   MAX_DICTATION_OVERLAP_MS = 1000     §4.4: "… with 1-second overlap"
 *
 *   createDictationGlossary({ directory }) → Promise<DictationGlossary>
 *     Durable state lives under `directory` and survives close/reopen; every operation below names
 *     its project explicitly, so one store serves the whole app without an ambient project.
 *
 *     learnCorrection({ projectId, raw, corrected }) → Promise<entry view>
 *       Learns the term the corrected span carries: the canonical term is the corrected span, the
 *       spoken variant is the raw span. The entry is project-scoped, `userConfirmed: true`, and its
 *       positive example is `corrected`. A second correction for a term already in the project adds
 *       the variant instead of creating a second entry. Learning never creates a global entry.
 *
 *     rejectCorrection({ projectId, raw, corrected }) → Promise<entry views[]>
 *       The user's reversal of a wrong application of a learned term: the raw span that must stay
 *       untouched (the person's name) and the term the wrong replacement matched are recorded as a
 *       negative example of that entry. A negative example phrase is case-sensitive; a later
 *       occurrence of a variant that overlaps it is not rewritten, while the term's real technical
 *       variant elsewhere still is. No entry's scope changes because of a rejection.
 *
 *     promoteToGlobal(term) → Promise<entry view>
 *       The only path that makes an entry visible to other projects without a grant. Returns the
 *       entry with scope 'global'.
 *
 *     grantProjectAccess({ projectId, term }) → Promise<entry view>
 *       Explicit grant: `projectId` now sees another project's entry, while every other project
 *       still does not. The granted entry keeps scope 'project' — a grant is not a promotion.
 *
 *     glossaryForProject(projectId) → entry views visible to that project
 *       Its own entries, global entries, and entries explicitly granted to it. An entry owned by
 *       another project is invisible without a grant.
 *
 *     entries() → every stored entry, with ownerProjectId, grantedTo and negativeExamples.
 *
 *     correctTranscript(text, { projectId }) → { text, applied }
 *       Applies only the variants of the entries visible to `projectId`, as whole-word sequences (a
 *       variant is never applied inside a longer word), skipping occurrences protected by a
 *       negative example; `applied` names every substitution. Unrelated text comes back unchanged.
 *
 *     close() → Promise<void>
 *
 *   commitDictationWindows({ windows, windowMs, overlapMs }) → { committed, rejected, text }
 *     Deterministic rolling-window commit. `windowMs` must not exceed MAX_DICTATION_WINDOW_MS and
 *     `overlapMs` must not exceed MAX_DICTATION_OVERLAP_MS. A window whose duration exceeds
 *     `windowMs` is rejected with reason 'audio_window_exceeded'; a window overlapping the previous
 *     committed window by more than `overlapMs` is rejected with reason 'audio_overlap_exceeded'.
 *     Rejected windows are reported, never truncated and never committed. `committed[i].overlapMs`
 *     is the measured overlap with the previous committed window, and `text` appends each committed
 *     window after dropping the longest prefix that is already the suffix of the committed text, so
 *     an overlap is never duplicated.
 *
 *   chunkLongDictation({ text, maxChunkTokens, tokenizer }) → { chunks, totalTokens, maxChunkTokens }
 *     Splits committed dictation into ordered correction chunks, each measured with the caller's
 *     exact tokenizer and no larger than `maxChunkTokens` (plan §4.4: longer dictation is a sequence
 *     of bounded windows, not one oversized request). `chunks.map(c => c.text).join(' ')` is the
 *     input text exactly and `totalTokens` is its token count, so nothing is dropped or sent twice.
 */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import type {GlossaryEntry} from '../context/index.js';
import {deriveDictationEvidence} from '../context/index.js';
import {
  CONTEXT_CEILING_TOKENS,
  DEFAULT_OUTPUT_RESERVATION_TOKENS,
  boundedBudget,
  createContextAssembler,
} from '../../../memory/src/context/index.js';

const FIXTURE_URL = new URL('../../../../fixtures/dictation/a03-glossary-long-dictation.json', import.meta.url);

type Scope = 'project' | 'global';
type LongWindow = Readonly<{startMs: number; endMs: number; text: string}>;

/** The stored entry view: the A02 glossary entry plus the ownership and negative-example fields. */
type EntryView = GlossaryEntry & Readonly<{
  ownerProjectId: string | null;
  grantedTo: readonly string[];
  negativeExamples: readonly string[];
}>;

type CorrectionOutcome = Readonly<{
  text: string;
  applied: readonly Readonly<{term: string; variant: string; scope: Scope}>[];
}>;

type CommitResult = Readonly<{
  committed: readonly Readonly<{index: number; startMs: number; endMs: number; text: string; overlapMs: number}>[];
  rejected: readonly Readonly<{index: number; startMs: number; endMs: number; reason: string}>[];
  text: string;
}>;

type ChunkPlan = Readonly<{
  chunks: readonly Readonly<{index: number; text: string; tokenCount: number}>[];
  totalTokens: number;
  maxChunkTokens: number;
}>;

type DictationGlossary = {
  learnCorrection(input: Readonly<{projectId: string; raw: string; corrected: string}>): Promise<EntryView>;
  rejectCorrection(input: Readonly<{projectId: string; raw: string; corrected: string}>): Promise<readonly EntryView[]>;
  promoteToGlobal(term: string): Promise<EntryView>;
  grantProjectAccess(input: Readonly<{projectId: string; term: string}>): Promise<EntryView>;
  glossaryForProject(projectId: string): readonly EntryView[] | Promise<readonly EntryView[]>;
  entries(): readonly EntryView[] | Promise<readonly EntryView[]>;
  correctTranscript(text: string, options: Readonly<{projectId: string}>): CorrectionOutcome | Promise<CorrectionOutcome>;
  close(): Promise<void>;
};

type GlossaryModule = Readonly<{
  GLOSSARY_SCOPES: readonly string[];
  MAX_DICTATION_WINDOW_MS: number;
  MAX_DICTATION_OVERLAP_MS: number;
  createDictationGlossary(options: Readonly<{directory: string}>): Promise<DictationGlossary>;
  commitDictationWindows(input: Readonly<{
    windows: readonly LongWindow[];
    windowMs: number;
    overlapMs: number;
  }>): CommitResult;
  chunkLongDictation(input: Readonly<{
    text: string;
    maxChunkTokens: number;
    tokenizer: Readonly<{count(text: string): number}>;
  }>): ChunkPlan;
}>;

async function loadGlossaryModule(): Promise<GlossaryModule> {
  const fail = (detail: string): never => assert.fail(
    'A03 required glossary behavior is not implemented yet: packages/capture/src/glossary/index.ts '
    + 'must export GLOSSARY_SCOPES, MAX_DICTATION_WINDOW_MS, MAX_DICTATION_OVERLAP_MS, '
    + 'createDictationGlossary({ directory }), commitDictationWindows({ windows, windowMs, overlapMs }) '
    + `and chunkLongDictation({ text, maxChunkTokens, tokenizer }). ${detail}`,
  );
  // The specifier is assembled at runtime: until the implementation exists the import resolves to
  // nothing, and that is reported below as missing behavior instead of a node/TS resolution failure
  // that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as unknown as Record<string, unknown>;
  } catch (error) {
    return fail(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createDictationGlossary !== 'function') {
    return fail('createDictationGlossary is not exported as a function');
  }
  if (typeof loaded.commitDictationWindows !== 'function') {
    return fail('commitDictationWindows is not exported as a function');
  }
  if (typeof loaded.chunkLongDictation !== 'function') {
    return fail('chunkLongDictation is not exported as a function');
  }
  const scopes = loaded.GLOSSARY_SCOPES;
  if (!Array.isArray(scopes) || scopes.join(',') !== 'project,global') {
    return fail('GLOSSARY_SCOPES must be [project, global]');
  }
  if (loaded.MAX_DICTATION_WINDOW_MS !== 15000) {
    return fail('MAX_DICTATION_WINDOW_MS must be 15000 (plan §4.4: maximum 15-second ASR window)');
  }
  if (loaded.MAX_DICTATION_OVERLAP_MS !== 1000) {
    return fail('MAX_DICTATION_OVERLAP_MS must be 1000 (plan §4.4: 1-second overlap)');
  }
  return loaded as unknown as GlossaryModule;
}

type Fixture = Readonly<{
  schemaVersion: number;
  ticket: string;
  projects: Readonly<{atlas: string; beacon: string; cairn: string}>;
  model: Readonly<{modelId: string; contextCapacity: number}>;
  echoPilot: Readonly<{
    projectId: string;
    term: string;
    variants: readonly string[];
    learnedFrom: string;
    confirmedExample: string;
    secondVariant: string;
    secondLearnedFrom: string;
    secondExample: string;
    matchingUtterance: string;
    matchingCorrected: string;
    unrelatedUtterance: string;
  }>;
  sqlite: Readonly<{
    projectId: string;
    term: string;
    variants: readonly string[];
    learnedFrom: string;
    confirmedExample: string;
    matchingUtterance: string;
    matchingCorrected: string;
  }>;
  jsonPerson: Readonly<{
    projectId: string;
    term: string;
    variants: readonly string[];
    confirmedExample: string;
    allowedUtterance: string;
    allowedCorrected: string;
    rejectedUtterance: string;
    rejectedBadCorrection: string;
    rejectedFollowUp: string;
  }>;
  beaconTerm: Readonly<{
    projectId: string;
    term: string;
    variants: readonly string[];
    learnedFrom: string;
    confirmedExample: string;
  }>;
  longDictation: Readonly<{
    projectId: string;
    windowMs: number;
    overlapMs: number;
    maxChunkTokens: number;
    overBudgetWindow: LongWindow;
    overlapPhrases: readonly string[];
    windows: readonly LongWindow[];
    glossaryVariant: string;
    glossaryTerm: string;
    expectedText: string;
    expectedCorrectedText: string;
  }>;
}>;

async function loadFixture(): Promise<Fixture> {
  const parsed = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;
  assert.equal(parsed.schemaVersion, 1, 'fixture schema version');
  assert.equal(parsed.ticket, 'A03', 'fixture ticket');
  assert.ok(parsed.longDictation.windows.length >= 6, 'fixture must declare the overlapping ASR windows');
  assert.ok(parsed.longDictation.overlapPhrases.length >= 5, 'fixture must declare the shared overlap phrases');
  return parsed;
}

const glossary = await loadGlossaryModule();
const fixture = await loadFixture();

const WORD_TOKENIZER = {
  count: (text: string): number => (text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length),
};
const IMAGE_TOKENS = (descriptor: Readonly<{width: number; height: number}>): number =>
  Math.ceil((descriptor.width * descriptor.height) / 750);

function first<T>(values: readonly T[], what: string): T {
  const value = values[0];
  assert.ok(value !== undefined, `${what} must not be empty`);
  return value;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function mustEntry(entries: readonly EntryView[], term: string): EntryView {
  const entry = entries.find((candidate) => candidate.term.toLowerCase() === term.toLowerCase());
  assert.ok(entry, `the glossary must contain ${term}`);
  return entry;
}

/** One durable store per test, always cleaned up; `directory` is handed back for the restart test. */
async function withStore<T>(run: (store: DictationGlossary, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-a03-'));
  try {
    const store = await glossary.createDictationGlossary({directory});
    return await run(store, directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function learnProjectGlossary(store: DictationGlossary, projectId: string): Promise<void> {
  await store.learnCorrection({projectId, raw: fixture.echoPilot.learnedFrom, corrected: fixture.echoPilot.confirmedExample});
  await store.learnCorrection({
    projectId,
    raw: fixture.echoPilot.secondLearnedFrom,
    corrected: fixture.echoPilot.secondExample,
  });
  await store.learnCorrection({projectId, raw: fixture.sqlite.learnedFrom, corrected: fixture.sqlite.confirmedExample});
  await store.learnCorrection({
    projectId,
    raw: fixture.jsonPerson.allowedUtterance,
    corrected: fixture.jsonPerson.allowedCorrected,
  });
}

test('A03-C1 a corrected proper name persists across restart and improves the next matching utterance', async () => {
  await withStore(async (store, directory) => {
    const projectId = fixture.echoPilot.projectId;
    const learned = await store.learnCorrection({
      projectId,
      raw: fixture.echoPilot.learnedFrom,
      corrected: fixture.echoPilot.confirmedExample,
    });
    assert.equal(learned.term, fixture.echoPilot.term, 'the corrected span is the learned term');
    assert.deepEqual([...learned.variants], [...fixture.echoPilot.variants], 'the raw span is the learned spoken variant');
    assert.equal(learned.scope, 'project', 'a corrected term is learned project-scoped by default');
    assert.equal(learned.userConfirmed, true, 'a user correction confirms the term');
    assert.deepEqual([...learned.positiveExamples], [fixture.echoPilot.confirmedExample], 'the corrected utterance is the positive example');
    assert.equal(learned.ownerProjectId, projectId, 'the entry belongs to the project it was learned in');

    const merged = await store.learnCorrection({
      projectId,
      raw: fixture.echoPilot.secondLearnedFrom,
      corrected: fixture.echoPilot.secondExample,
    });
    assert.deepEqual(
      [...merged.variants],
      [...fixture.echoPilot.variants, fixture.echoPilot.secondVariant],
      'a second correction for the same term adds a variant instead of a second entry',
    );
    assert.equal((await store.entries()).length, 1, 'one entry per term');

    await learnProjectGlossary(store, projectId);
    assert.equal((await store.entries()).length, 3, 'EchoPilot, SQLite and JSON are three terms');

    const matching = await store.correctTranscript(fixture.echoPilot.matchingUtterance, {projectId});
    assert.equal(matching.text, fixture.echoPilot.matchingCorrected, 'the next matching utterance is corrected');
    const applied = first(matching.applied, 'the matching utterance must record its substitution');
    assert.equal(applied.term, fixture.echoPilot.term);
    assert.equal(applied.variant, first(fixture.echoPilot.variants, 'fixture variants'));
    assert.equal(applied.scope, 'project');

    const unrelated = await store.correctTranscript(fixture.echoPilot.unrelatedUtterance, {projectId});
    assert.equal(unrelated.text, fixture.echoPilot.unrelatedUtterance, 'an unrelated use is never rewritten');
    assert.deepEqual([...unrelated.applied], [], 'an unrelated use records no substitution');

    const sqlite = await store.correctTranscript(fixture.sqlite.matchingUtterance, {projectId});
    assert.equal(sqlite.text, fixture.sqlite.matchingCorrected, 'every confirmed term corrects its own matching utterance');

    const allowed = await store.correctTranscript(fixture.jsonPerson.allowedUtterance, {projectId});
    assert.equal(allowed.text, fixture.jsonPerson.allowedCorrected, 'the technical use of the learned variant is corrected');

    const affected = await store.rejectCorrection({
      projectId,
      raw: fixture.jsonPerson.rejectedUtterance,
      corrected: fixture.jsonPerson.rejectedBadCorrection,
    });
    assert.ok(
      affected.some((entry) => entry.term.toLowerCase() === fixture.jsonPerson.term.toLowerCase()),
      'a reversal records the negative example on the term the wrong correction produced',
    );
    assert.ok(
      mustEntry(await store.entries(), fixture.jsonPerson.term).negativeExamples.length >= 1,
      'the rejected reading is stored as a negative example',
    );
    assert.ok(
      (await store.entries()).every((entry) => entry.scope === 'project'),
      'a rejected correction never promotes a global preference',
    );

    const rejected = await store.correctTranscript(fixture.jsonPerson.rejectedUtterance, {projectId});
    assert.equal(rejected.text, fixture.jsonPerson.rejectedUtterance, 'the rejected reading stays exactly as the user said it');
    assert.deepEqual([...rejected.applied], [], 'the rejected reading records no substitution');
    const followUp = await store.correctTranscript(fixture.jsonPerson.rejectedFollowUp, {projectId});
    assert.equal(followUp.text, fixture.jsonPerson.rejectedFollowUp, 'a later repetition of the rejected reading is protected too');
    const stillAllowed = await store.correctTranscript(fixture.jsonPerson.allowedUtterance, {projectId});
    assert.equal(stillAllowed.text, fixture.jsonPerson.allowedCorrected, 'the technical use still corrects after the reversal');

    await store.close();

    // Restart: the same directory reopens with the same learned behavior.
    const reopened = await glossary.createDictationGlossary({directory});
    try {
      const entries = await reopened.entries();
      assert.equal(entries.length, 3, 'the durable store keeps every learned term across a restart');
      mustEntry(entries, fixture.echoPilot.term);
      assert.ok(
        mustEntry(entries, fixture.jsonPerson.term).negativeExamples.length >= 1,
        'the negative example survives the restart',
      );
      const afterRestart = await reopened.correctTranscript(fixture.echoPilot.matchingUtterance, {projectId});
      assert.equal(afterRestart.text, fixture.echoPilot.matchingCorrected, 'the matching utterance is corrected after a restart');
      const unrelatedAfterRestart = await reopened.correctTranscript(fixture.echoPilot.unrelatedUtterance, {projectId});
      assert.equal(unrelatedAfterRestart.text, fixture.echoPilot.unrelatedUtterance, 'unrelated speech is still untouched after a restart');
      const rejectedAfterRestart = await reopened.correctTranscript(fixture.jsonPerson.rejectedFollowUp, {projectId});
      assert.equal(rejectedAfterRestart.text, fixture.jsonPerson.rejectedFollowUp, 'the reversal survives the restart');

      // The learned entry is what the A02 dictation request turns into glossary evidence.
      const evidence = deriveDictationEvidence({
        bundle: null,
        glossary: await reopened.glossaryForProject(projectId),
        memoryEvidence: null,
      });
      assert.ok(
        evidence.every((item, index) => item.id === `ctx:glossary:${index}`),
        'project glossary evidence ids stay in the A02 retrieval order',
      );
      const echoPilotEvidence = evidence.filter(
        (item) => item.text.includes(fixture.echoPilot.term) && item.text.includes(first(fixture.echoPilot.variants, 'fixture variants')),
      );
      assert.equal(echoPilotEvidence.length, 1, 'the learned term and its variant reach the correction request as evidence');
    } finally {
      await reopened.close();
    }
  });
});

test('A03-C2 global promotion is explicit and a project-only identifier crosses projects only by grant', async () => {
  await withStore(async (store) => {
    const {atlas, beacon, cairn} = fixture.projects;
    await store.learnCorrection({
      projectId: atlas,
      raw: fixture.echoPilot.learnedFrom,
      corrected: fixture.echoPilot.confirmedExample,
    });
    await store.learnCorrection({
      projectId: beacon,
      raw: fixture.beaconTerm.learnedFrom,
      corrected: fixture.beaconTerm.confirmedExample,
    });

    assert.deepEqual(
      (await store.glossaryForProject(beacon)).map((entry) => entry.term),
      [fixture.beaconTerm.term],
      'another project never receives a project-only identifier',
    );
    assert.ok(
      !(await store.glossaryForProject(atlas)).some((entry) => entry.term === fixture.beaconTerm.term),
      'the beacon identifier stays out of atlas without a grant',
    );
    assert.ok(
      !(await store.glossaryForProject(cairn)).some((entry) => entry.term === fixture.echoPilot.term),
      'an atlas identifier stays out of cairn without a grant',
    );
    const crossProject = await store.correctTranscript(fixture.echoPilot.matchingUtterance, {projectId: beacon});
    assert.equal(crossProject.text, fixture.echoPilot.matchingUtterance, 'another project cannot correct with a foreign identifier');
    assert.deepEqual([...crossProject.applied], [], 'another project applies no foreign substitution');

    const promoted = await store.promoteToGlobal(fixture.echoPilot.term);
    assert.equal(promoted.scope, 'global', 'explicit promotion changes the entry scope');
    assert.ok(
      (await store.glossaryForProject(beacon)).some((entry) => entry.term === fixture.echoPilot.term),
      'a global term is visible to every project',
    );
    const globalCorrected = await store.correctTranscript(fixture.echoPilot.matchingUtterance, {projectId: beacon});
    assert.equal(globalCorrected.text, fixture.echoPilot.matchingCorrected, 'a global term corrects in another project');

    const granted = await store.grantProjectAccess({projectId: atlas, term: fixture.beaconTerm.term});
    assert.equal(granted.scope, 'project', 'a grant is not a promotion: the entry stays project-scoped');
    assert.ok(granted.grantedTo.includes(atlas), 'the grant is recorded on the entry the user shared');
    assert.ok(
      (await store.glossaryForProject(atlas)).some((entry) => entry.term === fixture.beaconTerm.term),
      'the granted project now retrieves the identifier',
    );
    assert.ok(
      !(await store.glossaryForProject(cairn)).some((entry) => entry.term === fixture.beaconTerm.term),
      'the grant does not leak to a third project',
    );
    const grantedCorrected = await store.correctTranscript(fixture.beaconTerm.learnedFrom, {projectId: atlas});
    assert.equal(grantedCorrected.text, fixture.beaconTerm.confirmedExample, 'the granted project can correct with the shared identifier');
    const ungrantedCorrected = await store.correctTranscript(fixture.beaconTerm.learnedFrom, {projectId: cairn});
    assert.equal(ungrantedCorrected.text, fixture.beaconTerm.learnedFrom, 'an ungranted project cannot');
  });
});

test('A03-C3 long dictation stays inside the audio/context budgets and never duplicates an overlap', async () => {
  const long = fixture.longDictation;
  assert.equal(glossary.MAX_DICTATION_WINDOW_MS, 15000, 'plan §4.4: maximum 15-second rolling window');
  assert.equal(glossary.MAX_DICTATION_OVERLAP_MS, 1000, 'plan §4.4: 1-second overlap');

  const commit = glossary.commitDictationWindows({
    windows: long.windows,
    windowMs: long.windowMs,
    overlapMs: long.overlapMs,
  });
  assert.deepEqual([...commit.rejected], [], 'every fixture window is inside the audio budget');
  assert.equal(commit.committed.length, long.windows.length, 'every window is committed exactly once');
  assert.equal(commit.text, long.expectedText, 'committed windows concatenate without duplicating their overlap');
  for (const window of commit.committed) {
    assert.ok(window.endMs - window.startMs <= glossary.MAX_DICTATION_WINDOW_MS, 'no committed window exceeds the 15-second audio budget');
    assert.ok(window.overlapMs <= glossary.MAX_DICTATION_OVERLAP_MS, 'no committed window exceeds the 1-second overlap budget');
  }
  for (const phrase of long.overlapPhrases) {
    assert.equal(countOccurrences(commit.text, phrase), 1, `the committed text carries "${phrase}" exactly once`);
  }

  const lastWindow = first([...long.windows].reverse(), 'fixture windows');
  const duplicate = {...lastWindow};
  const bounded = glossary.commitDictationWindows({
    windows: [...long.windows, duplicate, long.overBudgetWindow],
    windowMs: long.windowMs,
    overlapMs: long.overlapMs,
  });
  assert.equal(bounded.text, long.expectedText, 'a rejected window never changes the committed text');
  assert.equal(bounded.committed.length, long.windows.length, 'a rejected window is not committed twice');
  assert.deepEqual(
    bounded.rejected.map((entry) => [entry.startMs, entry.endMs, entry.reason]),
    [
      [duplicate.startMs, duplicate.endMs, 'audio_overlap_exceeded'],
      [long.overBudgetWindow.startMs, long.overBudgetWindow.endMs, 'audio_window_exceeded'],
    ],
    'an out-of-budget window is reported with its reason instead of being transcribed',
  );
  assert.ok(!bounded.text.includes(long.overBudgetWindow.text), 'over-budget audio is never silently committed');

  const model = fixture.model;
  const budget = boundedBudget(model);
  assert.equal(budget.ceiling, CONTEXT_CEILING_TOKENS, 'the dictation ceiling is the shared 8192-token context ceiling');
  assert.equal(budget.outputReservation, DEFAULT_OUTPUT_RESERVATION_TOKENS, 'the output reservation is the shared 2048-token reservation');
  const assembler = createContextAssembler({tokenizer: WORD_TOKENIZER, imageTokens: IMAGE_TOKENS});

  await withStore(async (store) => {
    await store.learnCorrection({
      projectId: long.projectId,
      raw: fixture.echoPilot.learnedFrom,
      corrected: fixture.echoPilot.confirmedExample,
    });
    const corrected = await store.correctTranscript(commit.text, {projectId: long.projectId});
    assert.equal(corrected.text, long.expectedCorrectedText, 'the glossary corrects the long dictation too');
    assert.equal(countOccurrences(corrected.text, long.glossaryTerm), 1, 'the corrected long dictation carries the term once');

    const plan = glossary.chunkLongDictation({
      text: corrected.text,
      maxChunkTokens: long.maxChunkTokens,
      tokenizer: assembler.tokenizer,
    });
    assert.ok(plan.chunks.length >= 3, 'a long dictation is corrected as a sequence of bounded chunks, not one request');
    assert.equal(plan.totalTokens, assembler.tokenizer.count(corrected.text), 'chunking measures the whole committed text');
    assert.equal(plan.chunks.map((chunk) => chunk.text).join(' '), corrected.text, 'chunks cover the committed text exactly, in order');
    const evidence = deriveDictationEvidence({
      bundle: null,
      glossary: await store.glossaryForProject(long.projectId),
      memoryEvidence: null,
    });
    for (const chunk of plan.chunks) {
      assert.ok(chunk.tokenCount <= long.maxChunkTokens, 'no correction chunk exceeds the configured chunk budget');
      assert.equal(chunk.tokenCount, assembler.tokenizer.count(chunk.text), 'the chunk reports the exact tokenizer count');
      const assembled = await assembler.assemble({
        model,
        instruction: 'Correct one bounded dictation chunk.',
        request: chunk.text,
        evidence,
      });
      assert.ok(assembled.totalTokens <= assembled.maxTokens, 'every chunk request stays inside the model ceiling');
      assert.ok(assembled.inputTokens <= budget.input, 'every chunk request stays inside the B input budget');
      assert.equal(assembled.coverage, 'complete', 'a bounded chunk request drops no committed text or glossary evidence');
    }
  });
});
