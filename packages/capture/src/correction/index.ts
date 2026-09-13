/**
 * A02 dictation correction — speech + screenshot + project memory → evidence-backed correction →
 * insertion (IMPLEMENTATION_PLAN.md §7.2 A02; plan §5.4 correction rules, §4.4 dictation latency).
 *
 * This module is the frozen A02 seam between the A01 dictation controller and the F01/M02 Reasoner
 * and context contracts. It answers one question: given the committed ASR transcript, the redacted
 * capture bundle, the permitted screenshot, the prior project glossary, and the project memory
 * evidence, what text may dictation insert — and what is the proof?
 *
 *   createDictationCorrector({ reasoner, assembler, model, now }) → DictationCorrector
 *
 *     correct(request) assembles one bounded request through the injected M02 assembler
 *     (`B = min(8192, floor(0.25·capacity))`, images charged with the processor's own
 *     `imageTokens`), calls `reasoner.run(task, assembledContext, CORRECTION_OUTPUT_SCHEMA, signal)`
 *     exactly once per non-verbatim correction, validates the response, and applies only the
 *     substitutions that clear every rule:
 *
 *       1. protected token (number, negation, flag, path, quoted literal) → blocked
 *          `protected_token`; the model's confidence is never an authorization signal;
 *       2. basis `evidence` → an admitted evidence text must contain the replacement
 *          (case-insensitive); otherwise blocked `missing_evidence`. The applied edit cites the
 *          corroborating ids, and the citation is checked against the bounded prompt that was
 *          actually sent, not against the evidence that was merely offered;
 *       3. basis `acoustic_normalization` → the reason must be one of the pinned reasons and the
 *          raw/replacement pair must verify deterministically on its own; otherwise blocked
 *          `invalid_acoustic_reason`.
 *
 *     Blocked candidates survive as `unresolvedSpans` `{ start, end, raw, alternative, reason }`,
 *     so the user is offered the alternative and never silently gets it. An invalid, inconsistent,
 *     or failed model response falls back to the raw transcript with no edits, no unresolved
 *     spans, and a `fallback` reason — dictation never loses the committed words.
 *
 *     Verbatim is the escape hatch: it returns the raw transcript without calling the reasoner,
 *     without admitting evidence, and with a zero warm latency, because it never assembles a
 *     request at all.
 *
 *     Gates are measured, never asserted: `warmLatencyMs` is the injected clock's reading around
 *     the bounded request plus the model call (plan §4.4: ≤3 s p95, warm local model), and
 *     `harmfulEditsApplied` re-scans the raw and the corrected text for protected tokens. An
 *     over-budget correction is still returned with `withinWarmBudget: false`; the gate reports, it
 *     does not discard the user's text.
 *
 *     `history()` keeps one entry per correction so the raw and the corrected text stay separately
 *     inspectable after insertion. The A01 controller still owns literal insertion: this module
 *     produces the text, it never writes it.
 */

import {
  boundedBudget,
  type AssembledContext,
  type ContextAssembler,
  type ModelDescriptor,
} from '../../../memory/src/context/index.js';
import {
  deriveDictationEvidence,
  type DictationEvidenceItem,
  type GlossaryEntry,
  type ProjectMemoryEvidence,
} from '../context/index.js';
import type { ContextBundle } from '../types.js';
import { corroboratingEvidenceIds } from './citations.js';
import { applyEditSpans, parseCorrectionResponse } from './response.js';
import {
  ACOUSTIC_NORMALIZATION_REASONS,
  CORRECTION_MODES,
  EDIT_BLOCK_REASONS,
  PROTECTED_TOKEN_KINDS,
  harmfulProtectedTokenEdits,
  isAcousticNormalizationReason,
  isCorrectionMode,
  protectedTokenInventory,
  protectedTokenKind,
  verifyAcousticNormalization,
  type AcousticNormalizationReason,
  type CorrectionBasis,
  type CorrectionMode,
  type EditBlockReason,
  type ProtectedTokenKind,
} from './rules.js';

export {
  ACOUSTIC_NORMALIZATION_REASONS,
  CORRECTION_MODES,
  EDIT_BLOCK_REASONS,
  PROTECTED_TOKEN_KINDS,
  harmfulProtectedTokenEdits,
  isAcousticNormalizationReason,
  isCorrectionMode,
  protectedTokenInventory,
  protectedTokenKind,
  verifyAcousticNormalization,
};
export type {
  AcousticNormalizationReason,
  CorrectionBasis,
  CorrectionMode,
  EditBlockReason,
  ProtectedTokenKind,
};

/** Plan §4.4: end of utterance → corrected insertion ≤1.5 s p50 / 3 s p95 for ≤15-second utterances. */
export const WARM_CORRECTION_BUDGET_MS = 3000;

/**
 * The JSON Schema handed to `Reasoner.run`. The model returns the corrected text plus the exact
 * substitutions it made, so the engine can check the text against its own edit list and gate every
 * span before anything is inserted.
 */
export const CORRECTION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['text', 'edits'],
  properties: Object.freeze({
    text: Object.freeze({
      type: 'string',
      description: 'the committed transcript with every declared edit applied, character for character',
    }),
    edits: Object.freeze({
      type: 'array',
      description: 'the substitutions made, ordered and non-overlapping, spans of the raw transcript',
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'original', 'replacement', 'basis', 'acousticReason', 'confidence'],
        properties: Object.freeze({
          start: Object.freeze({ type: 'integer', minimum: 0, description: 'inclusive raw offset' }),
          end: Object.freeze({ type: 'integer', minimum: 0, description: 'exclusive raw offset' }),
          original: Object.freeze({ type: 'string', description: 'the raw transcript at [start, end)' }),
          replacement: Object.freeze({ type: 'string', description: 'what replaces that span' }),
          basis: Object.freeze({
            type: 'string',
            enum: ['evidence', 'acoustic_normalization'],
            description: 'evidence needs a cited admitted evidence text; acoustic_normalization needs a verifiable reason',
          }),
          acousticReason: Object.freeze({ type: ['string', 'null'], enum: [...ACOUSTIC_NORMALIZATION_REASONS, null] }),
          confidence: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
        }),
      }),
    }),
  }),
});

/**
 * The F01 Reasoner contract as this feature consumes it: the second argument is always the context
 * module's `AssembledContext`, so every request carries its measured accounting and the correction
 * can cite exactly the evidence the bounded request admitted.
 */
export interface CorrectionReasoningTask {
  readonly taskId: string;
  readonly instruction: string;
}

export interface ReasonerContract {
  run(
    task: CorrectionReasoningTask,
    boundedContext: AssembledContext,
    outputSchema: Readonly<Record<string, unknown>>,
    abortSignal: AbortSignal,
  ): Promise<unknown>;
}

export interface ScreenshotInput {
  readonly ref: string;
  readonly width: number;
  readonly height: number;
}

export interface CorrectionRequest {
  readonly rawTranscript: string;
  readonly mode: CorrectionMode;
  /** The A01 redacted preview bundle for this utterance. */
  readonly bundle: ContextBundle | null;
  /** The permitted screenshot, or `null` when the utterance had none. */
  readonly screenshot: ScreenshotInput | null;
  /** Prior project glossary entries, in retrieval order. */
  readonly glossary: ReadonlyArray<GlossaryEntry> | null;
  /** M02 evidence items already scoped to the project. */
  readonly memoryEvidence: ReadonlyArray<ProjectMemoryEvidence> | null;
}

export interface CorrectionEdit {
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly basis: CorrectionBasis;
  readonly evidenceIds: ReadonlyArray<string>;
  readonly acousticReason: AcousticNormalizationReason | null;
  readonly confidence: number;
}

export interface UnresolvedSpan {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly alternative: string;
  readonly reason: EditBlockReason;
}

export type CorrectionCoverage = 'complete' | 'partial';
export type CorrectionFallback = 'none' | 'invalid_model_response' | 'reasoner_error';

export interface CorrectionGates {
  readonly warmLatencyMs: number;
  readonly warmBudgetMs: number;
  readonly withinWarmBudget: boolean;
  readonly harmfulEditsApplied: number;
}

export interface CorrectionResult {
  readonly rawText: string;
  readonly text: string;
  readonly mode: CorrectionMode;
  readonly edits: ReadonlyArray<CorrectionEdit>;
  readonly unresolvedSpans: ReadonlyArray<UnresolvedSpan>;
  readonly evidenceIds: ReadonlyArray<string>;
  readonly coverage: CorrectionCoverage;
  readonly fallback: CorrectionFallback;
  readonly gates: CorrectionGates;
}

export interface CorrectionHistoryEntry {
  readonly rawText: string;
  readonly text: string;
  readonly mode: CorrectionMode;
  readonly fallback: CorrectionFallback;
}

export interface DictationCorrector {
  correct(request: CorrectionRequest): Promise<CorrectionResult>;
  history(): ReadonlyArray<CorrectionHistoryEntry>;
}

export interface CreateDictationCorrectorOptions {
  reasoner: ReasonerContract;
  assembler: ContextAssembler;
  model: ModelDescriptor;
  /** Injected monotonic clock (ms); the warm correction gate is measured with it. */
  now?: () => number;
}

const TECHNICAL_CLEANUP_INSTRUCTION = [
  'You are the EchoPilot dictation corrector in technical-cleanup mode.',
  'The committed transcript is the request text; the evidence section is the only context you may use.',
  'Substitute a technical token only when an admitted evidence text supports the replacement, or when the substitution is a verifiable acoustic normalization.',
  'Preserve numbers, negation, flags, paths, and quoted literals character for character.',
  'Return the corrected text and the exact substitution spans.',
].join(' ');

const REWRITE_INSTRUCTION = [
  'You are the EchoPilot dictation rewriter.',
  'Rewrite the committed transcript so it reads clearly, keeping the speaker\'s meaning and every protected token intact.',
  'Change punctuation and word order freely, but substitute a technical token only when an admitted evidence text supports the replacement or the substitution is a verifiable acoustic normalization.',
  'Never introduce a number, flag, path, quoted literal, or negation the speaker did not say.',
  'Return the rewritten text and the exact substitution spans.',
].join(' ');

/** The model must be told which correction level is active; the two levels are not interchangeable. */
export function instructionForMode(mode: CorrectionMode): string {
  return mode === 'rewrite' ? REWRITE_INSTRUCTION : TECHNICAL_CLEANUP_INSTRUCTION;
}

interface CandidateEdit {
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
}

export function createDictationCorrector(options: CreateDictationCorrectorOptions): DictationCorrector {
  const reasoner = options?.reasoner;
  if (reasoner === undefined || typeof reasoner.run !== 'function') {
    throw new TypeError(
      'createDictationCorrector requires a Reasoner with run(task, assembledContext, outputSchema, signal)',
    );
  }
  const assembler = options?.assembler;
  if (assembler === undefined || typeof assembler.assemble !== 'function') {
    throw new TypeError('createDictationCorrector requires the shared context assembler');
  }
  // Rejects a model without a declared, positive, finite capacity before any correction runs.
  boundedBudget(options.model);
  const model: ModelDescriptor = options.model;
  const clock = typeof options.now === 'function' ? options.now : (): number => Date.now();

  const history: CorrectionHistoryEntry[] = [];
  let sequence = 0;

  const correct = async (request: CorrectionRequest): Promise<CorrectionResult> => {
    if (request === null || typeof request !== 'object') {
      throw new TypeError('correct requires a correction request');
    }
    const mode = request.mode;
    if (!isCorrectionMode(mode)) {
      throw new TypeError(`correct requires a mode in [${CORRECTION_MODES.join(', ')}]`);
    }
    const rawTranscript = request.rawTranscript;
    if (typeof rawTranscript !== 'string') {
      throw new TypeError('correct requires the committed raw transcript as a string');
    }

    const record = (
      text: string,
      edits: ReadonlyArray<CorrectionEdit>,
      unresolvedSpans: ReadonlyArray<UnresolvedSpan>,
      evidenceIds: ReadonlyArray<string>,
      coverage: CorrectionCoverage,
      fallback: CorrectionFallback,
      warmLatencyMs: number,
    ): CorrectionResult => {
      const result: CorrectionResult = Object.freeze({
        rawText: rawTranscript,
        text,
        mode,
        edits: Object.freeze([...edits]),
        unresolvedSpans: Object.freeze([...unresolvedSpans]),
        evidenceIds: Object.freeze([...evidenceIds]),
        coverage,
        fallback,
        gates: Object.freeze({
          warmLatencyMs,
          warmBudgetMs: WARM_CORRECTION_BUDGET_MS,
          withinWarmBudget: warmLatencyMs <= WARM_CORRECTION_BUDGET_MS,
          harmfulEditsApplied: harmfulProtectedTokenEdits(rawTranscript, text),
        }),
      });
      history.push(Object.freeze({ rawText: rawTranscript, text, mode, fallback }));
      return result;
    };

    // Verbatim never assembles a request, never admits evidence, and never calls the model.
    if (mode === 'verbatim') {
      return record(rawTranscript, [], [], [], 'complete', 'none', 0);
    }

    const startedAt = clock();
    const elapsed = (): number => Math.max(0, clock() - startedAt);
    const screenshot = request.screenshot ?? null;
    const evidence: ReadonlyArray<DictationEvidenceItem> = deriveDictationEvidence({
      bundle: request.bundle ?? null,
      glossary: request.glossary ?? null,
      memoryEvidence: request.memoryEvidence ?? null,
    });
    const instruction = instructionForMode(mode);

    let assembled: AssembledContext;
    try {
      assembled = await assembler.assemble({
        model,
        instruction,
        request: rawTranscript,
        evidence,
        // A screenshot is admitted as an image whose id is its ref, charged with the processor's
        // own image-token calculation; a filename would not be multimodal input.
        images: screenshot === null
          ? []
          : [{ id: screenshot.ref, width: screenshot.width, height: screenshot.height }],
      });
    } catch {
      // The bounded request could not be built; dictation still has the committed words.
      return record(rawTranscript, [], [], [], 'partial', 'reasoner_error', elapsed());
    }

    const admittedIds = assembled.evidenceIds;
    const admitted = evidence.filter((item) => admittedIds.includes(item.id));
    const abort = new AbortController();
    sequence += 1;
    let response: unknown;
    try {
      response = await reasoner.run(
        { taskId: `dictation.correction.${mode}.${sequence}`, instruction },
        assembled,
        CORRECTION_OUTPUT_SCHEMA,
        abort.signal,
      );
    } catch {
      return record(rawTranscript, [], [], admittedIds, assembled.coverage, 'reasoner_error', elapsed());
    } finally {
      abort.abort();
    }

    const parsed = parseCorrectionResponse(rawTranscript, response);
    if (parsed === null) {
      return record(
        rawTranscript,
        [],
        [],
        admittedIds,
        assembled.coverage,
        'invalid_model_response',
        elapsed(),
      );
    }

    const edits: CorrectionEdit[] = [];
    const unresolvedSpans: UnresolvedSpan[] = [];
    const offered = (candidate: CandidateEdit, reason: EditBlockReason): void => {
      unresolvedSpans.push({
        start: candidate.start,
        end: candidate.end,
        raw: candidate.original,
        alternative: candidate.replacement,
        reason,
      });
    };
    // Applying a candidate is only safe when it leaves the protected-token inventory of the text
    // untouched — the span-level rule above cannot see a boundary that splits a token.
    const changesProtectedTokens = (candidate: CandidateEdit): boolean => {
      const before = applyEditSpans(rawTranscript, edits);
      const after = applyEditSpans(rawTranscript, [...edits, candidate]);
      return harmfulProtectedTokenEdits(before, after) > 0;
    };

    for (const proposal of parsed.edits) {
      if (proposal.original === proposal.replacement) continue;
      if (protectedTokenKind(proposal.original, proposal.replacement) !== null) {
        offered(proposal, 'protected_token');
        continue;
      }
      if (proposal.basis === 'evidence') {
        const cited = corroboratingEvidenceIds(assembled.prompt, admitted, proposal.replacement);
        if (cited.length === 0) {
          offered(proposal, 'missing_evidence');
          continue;
        }
        if (changesProtectedTokens(proposal)) {
          offered(proposal, 'protected_token');
          continue;
        }
        edits.push({
          start: proposal.start,
          end: proposal.end,
          original: proposal.original,
          replacement: proposal.replacement,
          basis: 'evidence',
          evidenceIds: Object.freeze([...cited]),
          acousticReason: null,
          confidence: proposal.confidence,
        });
        continue;
      }
      const reason = proposal.acousticReason;
      if (reason === null
        || !isAcousticNormalizationReason(reason)
        || !verifyAcousticNormalization(proposal.original, proposal.replacement, reason)) {
        offered(proposal, 'invalid_acoustic_reason');
        continue;
      }
      if (changesProtectedTokens(proposal)) {
        offered(proposal, 'protected_token');
        continue;
      }
      edits.push({
        start: proposal.start,
        end: proposal.end,
        original: proposal.original,
        replacement: proposal.replacement,
        basis: 'acoustic_normalization',
        evidenceIds: Object.freeze([]),
        acousticReason: reason,
        confidence: proposal.confidence,
      });
    }

    const text = applyEditSpans(rawTranscript, edits);
    return record(text, edits, unresolvedSpans, admittedIds, assembled.coverage, 'none', elapsed());
  };

  return Object.freeze({ correct, history: (): ReadonlyArray<CorrectionHistoryEntry> => history });
}
