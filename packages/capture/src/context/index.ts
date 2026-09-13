/**
 * A02 dictation context — the project-scoped evidence a correction request is allowed to see.
 *
 * Dictation correction is grounded or it does not happen (ticket A02; plan §5.4 correction rules).
 * The material a correction request may carry comes from exactly two places:
 *
 *   - the A01 redacted bundle for this utterance (selected text, non-secure AX node values, OCR
 *     spans read from the permitted screenshot), and
 *   - prior project knowledge that already exists before the utterance: the user's project
 *     glossary (term, spoken variants, positive examples) and the M02 evidence items scoped to the
 *     project. Neither is invented at correction time.
 *
 * Evidence ids are deterministic and derived only from the request, in this fixed order:
 *
 *   `ctx:selected-text`, `ctx:ax:<i>` (non-empty AX node values, original index), `ctx:ocr:<i>`
 *   (non-empty OCR spans, original index), `ctx:glossary:<i>` (retrieval order), then the memory
 *   evidence ids unchanged.
 *
 * A screenshot is not context by itself: the descriptor travels to the model as an admitted image
 * (charged with the processor's own image-token calculation by the shared M02 assembler), while
 * the text a model can read from that image arrives here as OCR/selected/AX evidence. A screenshot
 * therefore never degenerates into a filename in a prompt, and a correction can cite the pixels
 * that justified it.
 */

import type { ContextBundle } from '../types.js';

export const SELECTED_TEXT_EVIDENCE_ID = 'ctx:selected-text';

/** One prior project glossary entry, in retrieval order. */
export interface GlossaryEntry {
  readonly term: string;
  readonly variants: ReadonlyArray<string>;
  readonly scope: 'project' | 'global';
  readonly userConfirmed: boolean;
  readonly positiveExamples: ReadonlyArray<string>;
}

/** An M02 evidence item already scoped to the project (`EvidenceItem` from the context module). */
export interface ProjectMemoryEvidence {
  readonly id: string;
  readonly text: string;
}

export interface DictationEvidenceItem {
  readonly id: string;
  readonly text: string;
}

export interface DictationContextInput {
  readonly bundle: ContextBundle | null;
  readonly glossary: ReadonlyArray<GlossaryEntry> | null;
  readonly memoryEvidence: ReadonlyArray<ProjectMemoryEvidence> | null;
}

export function axEvidenceId(index: number): string {
  return `ctx:ax:${index}`;
}

export function ocrEvidenceId(index: number): string {
  return `ctx:ocr:${index}`;
}

export function glossaryEvidenceId(index: number): string {
  return `ctx:glossary:${index}`;
}

/**
 * The glossary entry as prompt evidence. The spoken variants and the positive examples are what
 * make a glossary term usable to a model: the term alone would not connect "sequel lite" to
 * `SQLite`, and a term without examples is a hint, not evidence.
 */
export function renderGlossaryEvidence(entry: GlossaryEntry): string {
  const scope = entry.scope === 'global' ? 'global' : 'project';
  const confirmation = entry.userConfirmed ? 'user-confirmed' : 'not yet confirmed by the user';
  const variants = entry.variants.length > 0
    ? `spoken variants: ${entry.variants.join(', ')}`
    : 'no recorded spoken variants';
  const examples = entry.positiveExamples.length > 0
    ? `; examples: ${entry.positiveExamples.join('; ')}`
    : '';
  return `${entry.term} — ${scope} glossary term (${confirmation}); ${variants}${examples}.`;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Deterministic evidence derivation. Empty selections/nodes/spans contribute nothing, so an id
 * that appears in a request is always backed by text the model actually receives; memory ids are
 * passed through unchanged because M02 already owns their identity.
 */
export function deriveDictationEvidence(input: DictationContextInput): ReadonlyArray<DictationEvidenceItem> {
  const items: DictationEvidenceItem[] = [];
  const bundle = input?.bundle ?? null;

  if (bundle !== null && isNonEmptyText(bundle.selectedText)) {
    items.push({ id: SELECTED_TEXT_EVIDENCE_ID, text: bundle.selectedText });
  }
  (bundle?.axNodes ?? []).forEach((node, index) => {
    if (isNonEmptyText(node.value)) items.push({ id: axEvidenceId(index), text: node.value });
  });
  (bundle?.ocrSpans ?? []).forEach((span, index) => {
    if (isNonEmptyText(span.text)) items.push({ id: ocrEvidenceId(index), text: span.text });
  });
  (input?.glossary ?? []).forEach((entry, index) => {
    items.push({ id: glossaryEvidenceId(index), text: renderGlossaryEvidence(entry) });
  });
  for (const item of input?.memoryEvidence ?? []) {
    if (isNonEmptyText(item?.id) && typeof item.text === 'string') {
      items.push({ id: item.id, text: item.text });
    }
  }

  return items;
}
