/**
 * A03 dictation glossary model — the one vocabulary shared by the durable glossary store, the
 * deterministic correction pass, the rolling-window commit and the renderer's glossary controls.
 *
 * Two numbers here are frozen by plan §4.4 ("a maximum 15-second rolling window … with 1-second
 * overlap"), and they are the same budget the ASR pipeline rolls at, so the commit side and the
 * audio side cannot drift apart: a window the recorder would never produce is refused instead of
 * being committed, and an overlap wider than the rolling overlap is reported instead of being
 * silently stitched into the transcript.
 *
 * The entry view is deliberately the A02 `GlossaryEntry` plus the ownership bookkeeping the scope
 * rules and the UI need (`ownerProjectId`, `grantedTo`, `negativeExamples`): the same object the
 * store persists is what `deriveDictationEvidence` turns into `ctx:glossary:<i>` evidence and what
 * the renderer paints, so no layer re-derives scope or ownership on its own.
 */
import type { GlossaryEntry } from '../context/index.js';

/** The pinned scopes (judgment A-F6): a term is project vocabulary or global vocabulary, never both. */
export const GLOSSARY_SCOPES: readonly GlossaryScope[] = Object.freeze(['project', 'global'] as const);

export type GlossaryScope = 'project' | 'global';

/** Plan §4.4: one local ASR window is at most 15 seconds. */
export const MAX_DICTATION_WINDOW_MS = 15_000;

/** Plan §4.4: consecutive ASR windows roll with a 1-second overlap. */
export const MAX_DICTATION_OVERLAP_MS = 1_000;

export function isGlossaryScope(value: unknown): value is GlossaryScope {
  return value === 'project' || value === 'global';
}

/**
 * One glossary entry as every A03 consumer sees it. `ownerProjectId` is the project that learned
 * the term (`null` once it is global vocabulary), `grantedTo` lists the projects the owner shared
 * it with, and `negativeExamples` are the case-sensitive spans the user refused to have rewritten.
 */
export interface DictationGlossaryEntry extends GlossaryEntry {
  readonly ownerProjectId: string | null;
  readonly grantedTo: readonly string[];
  readonly negativeExamples: readonly string[];
}

/** One substitution the deterministic correction pass applied, named so the user can undo it. */
export interface AppliedCorrection {
  readonly term: string;
  readonly variant: string;
  readonly scope: GlossaryScope;
}

export interface CorrectionApplication {
  readonly text: string;
  readonly applied: readonly AppliedCorrection[];
}

/** One committed dictation window: the audio span, its words, and its measured overlap. */
export interface CommittedDictationWindow {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** The window's words, normalized to single spaces; `commitDictationWindows` drops the overlap. */
  readonly text: string;
  /** Measured overlap with the previous committed window (0 for the first one). */
  readonly overlapMs: number;
}

export type DictationRejectionReason = 'audio_window_exceeded' | 'audio_overlap_exceeded';

export interface RejectedDictationWindow {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly reason: DictationRejectionReason;
}

/** The whole committed transcript plus the windows that were reported instead of transcribed. */
export interface DictationCommitResult {
  readonly committed: readonly CommittedDictationWindow[];
  readonly rejected: readonly RejectedDictationWindow[];
  readonly text: string;
}

/** One bounded correction chunk; `chunks.map(chunk => chunk.text).join(' ')` is the input text. */
export interface DictationChunk {
  readonly index: number;
  readonly text: string;
  readonly tokenCount: number;
}

export interface DictationChunkPlan {
  readonly chunks: readonly DictationChunk[];
  readonly totalTokens: number;
  readonly maxChunkTokens: number;
}
