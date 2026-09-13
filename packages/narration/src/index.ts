/**
 * `@echopilot/narration` — N01 tracer bullet: agent test result → durable event → concise spoken
 * outcome → replay.
 *
 * The public seam is `createNarrationTracer({ attention, voice, now })`, which the N01 acceptance
 * oracle in `../test/n01.acceptance.test.ts` drives with the normalized managed app-server journal
 * in `fixtures/narration/basic/managed-readonly-tests.json` and deterministic attention/voice
 * doubles. `attention` is the shared §5.7 speech-lease granter; `voice` is the V02 `submitSpeech`
 * boundary; `memory` (optional) is the M01 heard-receipt sink.
 *
 * See `../README.md` for the behavior the tracer guarantees and what stays out of N01's scope.
 */
export { createNarrationTracer } from './tracer.js';
export {
  CONCISE_MAX_WORDS,
  completionSpokenText,
  estimateSeconds,
  gapSpokenText,
  spokenArtifactName,
  spokenLiteral,
  truncateToWords,
  wordCount,
} from './format.js';
export { countChecks, reduceTurn } from './outcome.js';
export {
  TURN_COMPLETED_METHOD,
  exitCode,
  isObservedToolReceipt,
  readAgentText,
  readSessionState,
  readToolCompletion,
  readToolStart,
} from './extract.js';
export type {
  NarrationAttention,
  NarrationHeardSink,
  NarrationIngestInput,
  NarrationIngestResult,
  NarrationReplayRecord,
  NarrationTracer,
  NarrationTracerOptions,
  NarrationVoice,
} from './tracer.js';
export type { CheckCounts, NarrationOutcome, NarrationStatus, TaskReceipt, TurnReduction } from './outcome.js';
export type { CompletionSpeechInput } from './format.js';
export type { SessionStatePayload, ToolCompletion, ToolStart } from './extract.js';
