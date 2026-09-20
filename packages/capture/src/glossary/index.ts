/**
 * A03 dictation glossary — user corrects a term → the glossary is updated → the next matching
 * dictation is better for it (IMPLEMENTATION_PLAN.md §7.2 A03; plan §4.4 dictation windows, §5.4
 * correction rules, judgment A-F6).
 *
 * This is the frozen A03 seam between the correction UI, the durable glossary store, and the
 * long-utterance correction path:
 *
 *   createDictationGlossary({ directory })   the durable store (see `store.ts`)
 *   commitDictationWindows({ windows, windowMs, overlapMs })
 *                                            overlapping ASR windows → one committed transcript
 *                                            (§4.4 window/overlap limits, no duplicated overlap)
 *   chunkLongDictation({ text, maxChunkTokens, tokenizer })
 *                                            committed text → ordered, bounded correction chunks
 *                                            (§4.4: a long dictation is a sequence of windows)
 *
 * The invariants the three pieces share:
 *
 *   - a learned term is project vocabulary until the user promotes it: `promoteToGlobal` is the
 *     only path to global visibility, a grant shares one entry while keeping scope `project`, and
 *     no other project sees a project-only identifier for retrieval or for correction;
 *   - learning and rejecting act on spans, so unrelated speech — and the exact reading a user
 *     rejected — comes back byte-identical;
 *   - the audio budget and the context budget are both enforced before anything is believed: an
 *     out-of-budget window is reported with its reason, and every chunk is measured with the
 *     caller's own tokenizer.
 */
export {
  GLOSSARY_SCOPES,
  MAX_DICTATION_OVERLAP_MS,
  MAX_DICTATION_WINDOW_MS,
  isGlossaryScope,
} from './model.js';
export {
  DICTATION_GLOSSARY_FILE,
  createDictationGlossary,
  dictationGlossaryPath,
} from './store.js';
export { commitDictationWindows } from './windows.js';
export { chunkLongDictation } from './chunking.js';
export {
  applyGlossaryCorrections,
  correctionSpans,
  findVariantMatches,
  protectedRanges,
  wordSpans,
} from './correction.js';
export type {
  CorrectionInput,
  DictationGlossary,
  DictationGlossaryOptions,
  GrantProjectAccessInput,
} from './store.js';
export type { CommitDictationWindowsInput, DictationWindow } from './windows.js';
export type { ChunkLongDictationInput } from './chunking.js';
export type { CorrectionSpans, VariantMatch, WordSpan } from './correction.js';
export type {
  AppliedCorrection,
  CommittedDictationWindow,
  CorrectionApplication,
  DictationChunk,
  DictationChunkPlan,
  DictationCommitResult,
  DictationGlossaryEntry,
  DictationRejectionReason,
  GlossaryScope,
  RejectedDictationWindow,
} from './model.js';
