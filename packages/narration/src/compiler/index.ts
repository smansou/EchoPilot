/**
 * N02 seam — messy diff/log stream → typed claims → configured spoken chapters (plan §7.2 N02,
 * §5.7 stages 1–6).
 *
 * `compileNarration({ run, verbosity, exactReading })` reduces *one* normalized run to the spoken
 * digest a listener can follow at the requested §5.7 budget:
 *
 * - stage 4/5 (`claims.ts`) turns observed envelopes and log lines into typed claims, every one
 *   citing the durable events it came from, and keeps agent prose in an explicitly unsupported
 *   bucket no spoken segment may cite;
 * - stage 6 (`formatting/index.ts`) renders every spoken sentence, so ordinary narration never
 *   recites a raw path, URL or code token;
 * - this module is stages 1–3: it selects the claims a verbosity budget reaches, groups them into
 *   the logical chapters (outcome → problems → progress → decisions → changes → details) and bounds
 *   every segment so a spoken update stays inside 40 seconds and the chapter stays inside its
 *   `concise 50 / balanced 120 / detailed 250 / thorough 600` word ceiling.
 *
 * The selection is defined as verbosity *tiers*, not as a prefix of one list: concise speaks the
 * observed outcomes, balanced adds the problems/retries a listener must not miss, detailed adds the
 * decisions and changes, and thorough adds the remaining observed detail (progress, verification,
 * raw-stream details). Each tier is a strict superset of the one below it while every tier keeps a
 * bounded chapter/segment budget, which is what makes the four budgets materially different but
 * equally supported.
 *
 * An explicit exact-reading request (§5.7 stage 6 escape hatch) is reproduced verbatim in bounded
 * chunks that cite the observed events whose stream lines the request is made of; the ordinary
 * chapters are still spoken alongside it, and no non-exact segment ever recites the raw text.
 * The request itself stays an unsupported, agent-reported claim: it is something the user asked to
 * hear, never something the run proved.
 */
import type { EventEnvelope } from '../../../contracts/src/index.js';
import { wordCount } from '../format.js';
import { formatForSpeech } from '../formatting/index.js';
import { deriveClaims } from './claims.js';
import type { DerivedClaim, DerivedStream, NarrationChapterId, NarrationRun } from './claims.js';

/** The four §5.7 budgets in rising order; frozen by the N02 acceptance oracle. */
export const NARRATION_VERBOSITIES = ['concise', 'balanced', 'detailed', 'thorough'] as const;
export type NarrationVerbosity = (typeof NARRATION_VERBOSITIES)[number];

/** §5.7 upper bounds per logical update (chapter), in words. */
const CHAPTER_WORD_CEILING: Readonly<Record<NarrationVerbosity, number>> = {
  concise: 50,
  balanced: 120,
  detailed: 250,
  thorough: 600,
};
const MAX_CHAPTERS = 6;
const MAX_SEGMENT_SECONDS = 40;
/** The shared local-voice pacing N01 already assumes. */
const WORDS_PER_SECOND = 2.5;
/** One utterance may not exceed the 40 second segment budget. */
const MAX_SEGMENT_WORDS = Math.floor(MAX_SEGMENT_SECONDS * WORDS_PER_SECOND);
/** Short claims share a segment; a segment never grows past this many claims or words. */
const SEGMENT_MAX_CLAIMS = 3;
const SEGMENT_TARGET_WORDS = 60;
/** A bounded exact-reading chunk: 44 words is well inside the 40 second budget. */
const EXACT_CHUNK_WORDS = 44;

/** The claims a verbosity tier reaches: 1 outcomes, 2 outcomes+problems, 3 +decisions/changes, 4 all. */
const VERBOSITY_TIER: Readonly<Record<NarrationVerbosity, number>> = {
  concise: 1,
  balanced: 2,
  detailed: 3,
  thorough: 4,
};

/** Chapter order and the claims each chapter speaks; a chapter exists only when it has claims. */
const CHAPTER_PLAN: ReadonlyArray<Readonly<{
  id: NarrationChapterId;
  title: string;
  speaks: (claim: DerivedClaim) => boolean;
}>> = [
  { id: 'outcome', title: 'Outcome', speaks: (claim) => claim.chapter === 'outcome' && claim.band <= 1 },
  { id: 'problems', title: 'Problems', speaks: (claim) => claim.chapter === 'problems' && claim.band <= 2 },
  { id: 'progress', title: 'Progress', speaks: (claim) => claim.chapter === 'progress' && claim.band <= 4 },
  { id: 'decisions', title: 'Decisions', speaks: (claim) => claim.chapter === 'decisions' && claim.band <= 3 },
  { id: 'changes', title: 'Changes', speaks: (claim) => claim.chapter === 'changes' && claim.band <= 3 },
  { id: 'details', title: 'Details', speaks: (claim) => claim.chapter === 'details' && claim.band <= 4 },
];

export type NarrationSegment = Readonly<{
  id: string;
  text: string;
  maxSeconds: number;
  exact: boolean;
  claimIds: ReadonlyArray<string>;
  evidenceIds: ReadonlyArray<string>;
}>;

export type NarrationChapter = Readonly<{
  id: string;
  title: string;
  segments: ReadonlyArray<NarrationSegment>;
  evidenceIds: ReadonlyArray<string>;
}>;

export type CompiledClaim = Readonly<{
  id: string;
  kind: DerivedClaim['kind'];
  text: string;
  evidenceIds: ReadonlyArray<string>;
  supported: boolean;
  agentReported: boolean;
}>;

export type CompiledNarration = Readonly<{
  verbosity: NarrationVerbosity;
  chapters: ReadonlyArray<NarrationChapter>;
  claims: ReadonlyArray<CompiledClaim>;
  suppressed: DerivedStream['suppressed'];
}>;

export type CompileNarrationInput = Readonly<{
  run: NarrationRun;
  verbosity: NarrationVerbosity;
  exactReading?: Readonly<{ text: string }> | null;
}>;

/** The positive time budget one utterance declares, never more than the 40 second ceiling. */
function segmentSeconds(words: number): number {
  return Math.min(MAX_SEGMENT_SECONDS, Math.max(1, Math.ceil(words / WORDS_PER_SECOND)));
}

function splitWords(text: string): ReadonlyArray<string> {
  return text.trim().split(/\s+/u).filter((word) => word.length > 0);
}

/** Splits text into word runs of at most `limit` words, so one segment stays inside its budget. */
function chunkWords(text: string, limit: number): ReadonlyArray<string> {
  const words = splitWords(text);
  if (words.length <= limit) return words.length === 0 ? [] : [words.join(' ')];
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += limit) {
    chunks.push(words.slice(index, index + limit).join(' '));
  }
  return chunks;
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

type SegmentDraft = Readonly<{
  text: string;
  claimIds: ReadonlyArray<string>;
  evidenceIds: ReadonlyArray<string>;
  exact: boolean;
}>;

/** Groups consecutive claims into utterance-sized segments (a promise of one short update each). */
function packClaims(claims: ReadonlyArray<DerivedClaim>): ReadonlyArray<ReadonlyArray<DerivedClaim>> {
  const groups: Array<Array<DerivedClaim>> = [];
  let current: Array<DerivedClaim> = [];
  let words = 0;
  for (const claim of claims) {
    const weight = wordCount(claim.text);
    if (current.length > 0 && (current.length >= SEGMENT_MAX_CLAIMS || words + weight > SEGMENT_TARGET_WORDS)) {
      groups.push(current);
      current = [];
      words = 0;
    }
    current.push(claim);
    words += weight;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function segmentFromDraft(runId: string, ordinal: number, draft: SegmentDraft): NarrationSegment {
  const words = wordCount(draft.text);
  return {
    id: `segment-${runId}-${String(ordinal).padStart(3, '0')}`,
    text: draft.text,
    maxSeconds: segmentSeconds(words),
    exact: draft.exact,
    claimIds: draft.claimIds,
    evidenceIds: draft.evidenceIds,
  };
}

/** One chapter's segments: packed claims, split again when a single claim is long, ceiling-bounded. */
function chapterSegments(
  runId: string,
  claims: ReadonlyArray<DerivedClaim>,
  ceiling: number,
  ordinalStart: number,
): Readonly<{ segments: ReadonlyArray<NarrationSegment>; nextOrdinal: number }> {
  const drafts: SegmentDraft[] = [];
  let chapterWords = 0;
  let ordinal = ordinalStart;
  for (const group of packClaims(claims)) {
    const text = group.map((claim) => claim.text).join(' ');
    const pieces = chunkWords(text, MAX_SEGMENT_WORDS);
    if (pieces.length === 0) continue;
    const weight = wordCount(text);
    if (chapterWords + weight > ceiling && drafts.length > 0) break;
    for (const piece of pieces) {
      drafts.push({
        text: piece,
        claimIds: group.map((claim) => claim.id),
        evidenceIds: unique(group.flatMap((claim) => [...claim.evidenceIds])),
        exact: false,
      });
      ordinal += 1;
    }
    chapterWords += weight;
  }
  return {
    segments: drafts.map((draft, index) => segmentFromDraft(runId, ordinalStart + index + 1, draft)),
    nextOrdinal: ordinal,
  };
}

/** The observed events whose stream line is part of an exact request; falls back to the stream itself. */
function exactEvidence(run: NarrationRun, expected: string): ReadonlyArray<string> {
  const matched: string[] = [];
  let firstObserved: string | null = null;
  for (const event of run.events) {
    if (firstObserved === null && event.kind !== 'agent_message') firstObserved = event.eventId;
    const payload: unknown = run.payloads[event.payloadRef];
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
    const line = (payload as Record<string, unknown>).line;
    if (typeof line !== 'string') continue;
    const normalized = line.replace(/\s+/gu, ' ').trim();
    if (normalized.length > 0 && expected.includes(normalized)) matched.push(event.eventId);
  }
  if (matched.length > 0) return unique(matched);
  const fallback = firstObserved ?? run.events[0]?.eventId;
  return fallback === undefined ? [] : [fallback];
}

/** The exact-reading claim: the user asked to hear this text; it is never a verified run fact. */
function exactClaim(runId: string, chunkCount: number, evidenceIds: ReadonlyArray<string>): CompiledClaim {
  return {
    id: `claim-${runId}-exact`,
    kind: 'verification',
    text: `Exact reading: the requested stream text is spoken verbatim in ${chunkCount} bounded segment${chunkCount === 1 ? '' : 's'}.`,
    evidenceIds,
    supported: false,
    agentReported: true,
  };
}

/**
 * Verbatim, bounded exact-reading chapters: the request is normalized to single spaces, cut into
 * word runs, grouped into chapters that respect the verbosity ceiling where it fits, and emitted in
 * the order the user asked for. Only these segments may carry the raw text.
 */
function exactChapters(
  run: NarrationRun,
  request: string,
  claimId: string,
  ceiling: number,
  available: number,
  ordinalStart: number,
): Readonly<{ chapters: ReadonlyArray<NarrationChapter>; nextOrdinal: number }> {
  const expected = request.replace(/\s+/gu, ' ').trim();
  if (expected.length === 0 || available <= 0) return { chapters: [], nextOrdinal: ordinalStart };
  const chunks = chunkWords(expected, EXACT_CHUNK_WORDS);
  if (chunks.length === 0) return { chapters: [], nextOrdinal: ordinalStart };
  const evidenceIds = exactEvidence(run, expected);

  let chapters: Array<NarrationChapter> = [];
  let current: Array<NarrationSegment> = [];
  let words = 0;
  let ordinal = ordinalStart;
  const flush = (): void => {
    if (current.length === 0) return;
    chapters.push({
      id: `exact-${chapters.length + 1}`,
      title: 'Exact reading',
      segments: current,
      evidenceIds: unique(current.flatMap((segment) => [...segment.evidenceIds])),
    });
    current = [];
    words = 0;
  };
  for (const chunk of chunks) {
    const weight = wordCount(chunk);
    if (current.length > 0 && words + weight > ceiling) flush();
    ordinal += 1;
    current.push(segmentFromDraft(run.runId, ordinal, { text: chunk, claimIds: [claimId], evidenceIds, exact: true }));
    words += weight;
  }
  flush();

  if (chapters.length > available) {
    const perChapter = Math.ceil(chapters.length / available);
    const merged: Array<NarrationChapter> = [];
    for (let index = 0; index < chapters.length; index += perChapter) {
      const slice = chapters.slice(index, index + perChapter);
      merged.push({
        id: `exact-${merged.length + 1}`,
        title: 'Exact reading',
        segments: slice.flatMap((chapter) => [...chapter.segments]),
        evidenceIds: unique(slice.flatMap((chapter) => [...chapter.evidenceIds])),
      });
    }
    chapters = merged;
  }
  return { chapters, nextOrdinal: ordinal };
}

/**
 * Reduces one run to the spoken digest at the requested budget. Deterministic and synchronous:
 * identical input always yields the identical chapters, claims and suppressed counters.
 */
export function compileNarration(input: CompileNarrationInput): CompiledNarration {
  const { run, verbosity } = input;
  const tier = VERBOSITY_TIER[verbosity];
  const ceiling = CHAPTER_WORD_CEILING[verbosity];
  const derived = deriveClaims(run);

  const chapters: Array<NarrationChapter> = [];
  let ordinal = 0;
  for (const plan of CHAPTER_PLAN) {
    if (chapters.length >= MAX_CHAPTERS) break;
    const claims = derived.claims.filter((claim) => claim.band >= 1 && claim.band <= tier && plan.speaks(claim));
    if (claims.length === 0) continue;
    const built = chapterSegments(run.runId, claims, ceiling, ordinal);
    ordinal = built.nextOrdinal;
    if (built.segments.length === 0) continue;
    chapters.push({
      id: plan.id,
      title: plan.title,
      segments: built.segments,
      evidenceIds: unique(built.segments.flatMap((segment) => [...segment.evidenceIds])),
    });
  }

  const claims: Array<CompiledClaim> = [...derived.claims];
  const request = input.exactReading ?? null;
  if (request !== null && request.text.trim().length > 0) {
    const expected = request.text.replace(/\s+/gu, ' ').trim();
    const chunks = chunkWords(expected, EXACT_CHUNK_WORDS);
    const reading = exactClaim(run.runId, chunks.length, exactEvidence(run, expected));
    claims.push(reading);
    // The exact reading is an explicit user request, so it is never dropped: the ordinary chapters
    // keep the anti-redraw cap, and at least one verbatim chapter is always appended after them.
    const exact = exactChapters(run, request.text, reading.id, ceiling, Math.max(1, MAX_CHAPTERS - chapters.length), ordinal);
    ordinal = exact.nextOrdinal;
    chapters.push(...exact.chapters);
  }

  return { verbosity, chapters, claims, suppressed: derived.suppressed };
}

export { deriveClaims };
export type { DerivedClaim, DerivedStream, NarrationChapterId, NarrationRun };
export type { EventEnvelope };
