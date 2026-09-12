/**
 * M02 context module — the one owner of shared context budgeting (IMPLEMENTATION_PLAN §5.8).
 *
 * Every feature that needs a bounded prompt consumes `createContextAssembler(...)` instead of
 * inventing a compaction loop of its own. The invariants enforced here:
 *
 *   B = min(CONTEXT_CEILING_TOKENS, floor(0.25 * contextCapacity))
 *   totalTokens = inputTokens + accounting.output = sum(accounting.*) <= maxTokens = B
 *   inputTokens <= B - outputReservation
 *
 * Images are charged with the processor's own `imageTokens` calculation (never zero), tool schemas
 * are charged together with their call wrapper, and a deliberately failed compaction drops the
 * unadmitted dialogue while keeping the deterministic card, marking coverage `partial` without
 * ever crossing B.
 *
 * The budget describes what the request actually sends: tool charges use the exact `Tool <name>: `
 * wrapper that reaches the prompt, `reserve` is the exact tokenizer's measurement of the assembled
 * prompt minus its counted content sections, and the admitted image descriptors (with their
 * measured charge) travel on the assembled context so the vision tower receives what was charged.
 */

export const CONTEXT_CEILING_TOKENS = 8192;
export const DEFAULT_OUTPUT_RESERVATION_TOKENS = 2048;
/**
 * Admission allowance for wrappers/separators. Content is admitted only while this much room stays
 * free; the returned `accounting.reserve` is then the exact measured formatting overhead, so an
 * unusual tokenizer cannot smuggle uncounted headers past the ceiling.
 */
export const FORMAT_RESERVE_TOKENS = 64;

export interface ModelDescriptor {
  readonly modelId: string;
  readonly contextCapacity: number;
}

export interface BoundedBudget {
  readonly modelId: string;
  readonly capacity: number;
  readonly ceiling: number;
  readonly outputReservation: number;
  readonly input: number;
}

/**
 * The single budget every request must obey. A model without a declared, positive, finite context
 * capacity has no verified window and is rejected instead of being guessed at.
 */
export function boundedBudget(model: ModelDescriptor): BoundedBudget {
  const candidate = model as { modelId?: unknown; contextCapacity?: unknown } | null | undefined;
  const modelId = typeof candidate?.modelId === 'string' ? candidate.modelId.trim() : '';
  const capacity = candidate?.contextCapacity;
  if (modelId.length === 0) {
    throw new TypeError('boundedBudget requires a model with a declared modelId');
  }
  if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) {
    throw new RangeError(
      `boundedBudget requires a declared, positive, finite context capacity for ${modelId} `
      + `(received ${String(capacity)})`,
    );
  }
  const ceiling = Math.min(CONTEXT_CEILING_TOKENS, Math.floor(0.25 * capacity));
  const outputReservation = Math.min(DEFAULT_OUTPUT_RESERVATION_TOKENS, Math.max(1, Math.floor(ceiling / 4)));
  return { modelId, capacity, ceiling, outputReservation, input: ceiling - outputReservation };
}

export interface Tokenizer {
  count(text: string): number;
}

export interface ImageDescriptor {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface DialogueItem {
  readonly id: string;
  readonly text: string;
}

export interface EvidenceItem {
  readonly id: string;
  readonly text: string;
}

/**
 * An image that was admitted into the request: the descriptor the vision tower receives plus the
 * processor-owned token charge it contributed. Charging pixels that are never transmitted (or
 * transmitting pixels that were never charged) would misstate what the request actually sends.
 */
export interface AdmittedImage extends ImageDescriptor {
  readonly tokens: number;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly schema: unknown;
}

export type ContextCoverage = 'complete' | 'partial';

export interface AssembleRequest {
  model: ModelDescriptor;
  instruction: string;
  request?: string;
  card?: string;
  dialogue?: readonly DialogueItem[];
  evidence?: readonly EvidenceItem[];
  images?: readonly ImageDescriptor[];
  tools?: readonly ToolDescriptor[];
  compactDialogue?: (dialogue: readonly DialogueItem[]) => Promise<readonly DialogueItem[]>;
}

/** Fixed section names; `sum(accounting.*)` is the request's `totalTokens`. */
export interface ContextAccounting {
  system: number;
  request: number;
  cards: number;
  dialogue: number;
  evidence: number;
  images: number;
  tools: number;
  reserve: number;
  output: number;
}

export interface AssembledContext {
  readonly modelId: string;
  readonly maxTokens: number;
  readonly outputReservation: number;
  readonly inputTokens: number;
  readonly totalTokens: number;
  readonly accounting: ContextAccounting;
  readonly evidenceIds: readonly string[];
  /** The image descriptors (with their measured charge) this request actually transmits. */
  readonly images: readonly AdmittedImage[];
  readonly prompt: string;
  readonly coverage: ContextCoverage;
}

export interface ContextAssembler {
  assemble(request: AssembleRequest): Promise<AssembledContext>;
  /**
   * The exact tokenizer this budget owner measures with. Consumers that must bound their own text
   * (card levels, summaries) bound it with the same counter instead of inventing a second one.
   */
  readonly tokenizer: Tokenizer;
}

export interface CreateContextAssemblerOptions {
  tokenizer: Tokenizer;
  imageTokens(descriptor: ImageDescriptor): number;
}

const HEADERS = {
  system: '[system]',
  request: '[request]',
  card: '[card]',
  dialogue: '[dialogue]',
  evidence: '[evidence]',
  images: '[images]',
  tools: '[tools]',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function createContextAssembler(options: CreateContextAssemblerOptions): ContextAssembler {
  const tokenizer = options?.tokenizer;
  const imageTokenCounter = options?.imageTokens;
  if (tokenizer === undefined || typeof tokenizer.count !== 'function') {
    throw new TypeError('createContextAssembler requires an exact tokenizer with count(text)');
  }
  if (typeof imageTokenCounter !== 'function') {
    throw new TypeError('createContextAssembler requires the processor imageTokens(descriptor) calculation');
  }

  const count = (text: string): number => {
    const measured = tokenizer.count(text);
    return typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? Math.ceil(measured) : 0;
  };

  /** Largest prefix of `text` whose exact tokenizer count is <= limit. */
  const trimToLimit = (text: string, limit: number): { value: string; tokens: number; truncated: boolean } => {
    const measured = count(text);
    if (measured <= limit) return { value: text, tokens: measured, truncated: false };
    const parts = text.trim().split(/\s+/).filter((part) => part.length > 0);
    let low = 0;
    let high = parts.length;
    let best = 0;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (count(parts.slice(0, middle).join(' ')) <= limit) {
        best = middle;
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const value = best === 0 ? '' : parts.slice(0, best).join(' ');
    return { value, tokens: count(value), truncated: true };
  };

  return {
    tokenizer,
    async assemble(request: AssembleRequest): Promise<AssembledContext> {
      if (!isRecord(request)) throw new TypeError('assemble requires a request');
      const budget = boundedBudget(request.model);
      let coverage: ContextCoverage = 'complete';
      const markPartial = (): void => {
        coverage = 'partial';
      };

      // Everything admitted below fits inside `remaining`; the formatting overhead is measured
      // exactly after the prompt is assembled and charged to `accounting.reserve`, so
      // headers/separators can never push the prompt past B.
      let remaining = Math.max(0, budget.input - FORMAT_RESERVE_TOKENS);

      const instruction = typeof request.instruction === 'string' ? request.instruction : '';
      let system = trimToLimit(instruction, remaining);
      if (system.truncated) markPartial();
      remaining -= system.tokens;

      const requestText = typeof request.request === 'string' ? request.request : '';
      let requestSection = trimToLimit(requestText, remaining);
      if (requestSection.truncated) markPartial();
      remaining -= requestSection.tokens;

      const cardText = typeof request.card === 'string' ? request.card : '';
      const cards = trimToLimit(cardText, remaining);
      if (cards.truncated) markPartial();
      remaining -= cards.tokens;

      const admittedEvidence: EvidenceItem[] = [];
      let evidenceTokens = 0;
      for (const item of request.evidence ?? []) {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') {
          markPartial();
          continue;
        }
        const admission = trimToLimit(item.text, remaining);
        if (admission.truncated) markPartial();
        if (admission.tokens === 0 && item.text.trim().length > 0) {
          markPartial();
          continue;
        }
        remaining -= admission.tokens;
        evidenceTokens += admission.tokens;
        admittedEvidence.push({ id: item.id, text: admission.value });
      }

      const admittedImages: AdmittedImage[] = [];
      let imageTokensTotal = 0;
      for (const descriptor of request.images ?? []) {
        if (
          !isRecord(descriptor)
          || typeof descriptor.id !== 'string'
          || typeof descriptor.width !== 'number'
          || typeof descriptor.height !== 'number'
          || !Number.isFinite(descriptor.width)
          || !Number.isFinite(descriptor.height)
          || descriptor.width <= 0
          || descriptor.height <= 0
        ) {
          markPartial();
          continue;
        }
        const measured = imageTokenCounter(descriptor as unknown as ImageDescriptor);
        if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0) {
          throw new RangeError('imageTokens(descriptor) must return a finite, non-negative token count');
        }
        // The processor calculation is the floor: an image is never claimed to cost zero tokens.
        const cost = Math.max(1, Math.ceil(measured));
        if (cost > remaining) {
          markPartial();
          continue;
        }
        remaining -= cost;
        imageTokensTotal += cost;
        admittedImages.push({
          id: descriptor.id,
          width: descriptor.width,
          height: descriptor.height,
          tokens: cost,
        });
      }

      const admittedTools: { name: string; schemaText: string; tokens: number }[] = [];
      let toolTokens = 0;
      for (const tool of request.tools ?? []) {
        if (!isRecord(tool) || typeof tool.name !== 'string') {
          markPartial();
          continue;
        }
        const schemaText = safeSerialize(tool.schema);
        // Charge exactly the text the prompt below sends: the `Tool <name>: ` wrapper plus the
        // serialized schema. The raw schema text alone is never the whole charge.
        const cost = count(`Tool ${tool.name}: `) + count(schemaText);
        if (cost > remaining) {
          markPartial();
          continue;
        }
        remaining -= cost;
        toolTokens += cost;
        admittedTools.push({ name: tool.name, schemaText, tokens: cost });
      }

      const admittedDialogue: DialogueItem[] = [];
      let dialogueTokens = 0;
      const dialogue = request.dialogue ?? [];
      if (dialogue.length > 0) {
        const rawCost = dialogue.reduce(
          (total, item) => total + (isRecord(item) && typeof item.text === 'string' ? count(item.text) : 0),
          0,
        );
        if (rawCost <= remaining) {
          for (const item of dialogue) {
            if (!isRecord(item) || typeof item.text !== 'string') continue;
            admittedDialogue.push({ id: typeof item.id === 'string' ? item.id : '', text: item.text });
          }
          dialogueTokens = rawCost;
          remaining -= rawCost;
        } else {
          // Dialogue that does not fit is only admitted through `compactDialogue`.
          const compact = typeof request.compactDialogue === 'function' ? request.compactDialogue : undefined;
          if (compact === undefined) {
            markPartial();
          } else {
            let compacted: readonly DialogueItem[] | undefined;
            try {
              compacted = await compact(dialogue);
            } catch {
              // Deliberately failed compaction: drop the unadmitted dialogue, keep the card.
              compacted = undefined;
            }
            if (!Array.isArray(compacted) || compacted.length === 0) {
              markPartial();
            } else {
              for (const item of compacted) {
                if (!isRecord(item) || typeof item.text !== 'string') {
                  markPartial();
                  continue;
                }
                const admission = trimToLimit(item.text, remaining);
                if (admission.truncated) markPartial();
                if (admission.tokens === 0 && item.text.trim().length > 0) {
                  markPartial();
                  continue;
                }
                remaining -= admission.tokens;
                dialogueTokens += admission.tokens;
                admittedDialogue.push({ id: typeof item.id === 'string' ? item.id : '', text: admission.value });
              }
            }
          }
        }
      }

      const renderPrompt = (): string => {
        const parts: string[] = [
          `${HEADERS.system}\n${system.value}`,
          `${HEADERS.request}\n${requestSection.value}`,
        ];
        if (cards.value.length > 0) parts.push(`${HEADERS.card}\n${cards.value}`);
        if (admittedDialogue.length > 0) {
          parts.push(`${HEADERS.dialogue}\n${admittedDialogue.map((item) => item.text).join('\n')}`);
        }
        if (admittedEvidence.length > 0) {
          parts.push(`${HEADERS.evidence}\n${admittedEvidence.map((item) => item.text).join('\n')}`);
        }
        if (admittedImages.length > 0) {
          parts.push(`${HEADERS.images}\n${admittedImages
            .map((image) => `Image ${image.id} ${String(image.width)}x${String(image.height)}`)
            .join('\n')}`);
        }
        if (admittedTools.length > 0) {
          parts.push(`${HEADERS.tools}\n${admittedTools.map((tool) => `Tool ${tool.name}: ${tool.schemaText}`).join('\n')}`);
        }
        return parts.join('\n\n');
      };

      // Measure what is actually sent. The formatting overhead is the exact tokenizer's count of
      // the assembled prompt minus the counted content sections, so `reserve` can never understate
      // the headers and separators the model receives.
      const measure = (): { prompt: string; reserve: number; inputTokens: number } => {
        const prompt = renderPrompt();
        const bodyTokens = system.tokens
          + requestSection.tokens
          + cards.tokens
          + dialogueTokens
          + evidenceTokens
          + toolTokens;
        const reserve = Math.max(0, count(prompt) - bodyTokens);
        return { prompt, reserve, inputTokens: bodyTokens + imageTokensTotal + reserve };
      };

      let fitted = measure();
      // A tokenizer whose header/separator charge exceeds the nominal allowance, or an image-heavy
      // request, is still never allowed past B: drop the least-grounded admitted parts until the
      // exactly measured prompt plus the transmitted images fits the accounted input.
      while (fitted.inputTokens > budget.input) {
        markPartial();
        const droppedDialogue = admittedDialogue.pop();
        if (droppedDialogue !== undefined) {
          dialogueTokens -= count(droppedDialogue.text);
          fitted = measure();
          continue;
        }
        const droppedTool = admittedTools.pop();
        if (droppedTool !== undefined) {
          toolTokens -= droppedTool.tokens;
          fitted = measure();
          continue;
        }
        const droppedImage = admittedImages.pop();
        if (droppedImage !== undefined) {
          imageTokensTotal -= droppedImage.tokens;
          fitted = measure();
          continue;
        }
        const droppedEvidence = admittedEvidence.pop();
        if (droppedEvidence !== undefined) {
          evidenceTokens -= count(droppedEvidence.text);
          fitted = measure();
          continue;
        }
        if (requestSection.tokens > 0) {
          requestSection = { value: '', tokens: 0, truncated: true };
          fitted = measure();
          continue;
        }
        if (system.tokens > 0) {
          system = { value: '', tokens: 0, truncated: true };
          fitted = measure();
          continue;
        }
        break;
      }

      const accounting: ContextAccounting = {
        system: system.tokens,
        request: requestSection.tokens,
        cards: cards.tokens,
        dialogue: dialogueTokens,
        evidence: evidenceTokens,
        images: imageTokensTotal,
        tools: toolTokens,
        reserve: fitted.reserve,
        output: budget.outputReservation,
      };
      const inputTokens = accounting.system
        + accounting.request
        + accounting.cards
        + accounting.dialogue
        + accounting.evidence
        + accounting.images
        + accounting.tools
        + accounting.reserve;
      const totalTokens = inputTokens + accounting.output;
      if (totalTokens > budget.ceiling || inputTokens > budget.input) {
        throw new Error('context assembler budget invariant violated');
      }

      return {
        modelId: budget.modelId,
        maxTokens: budget.ceiling,
        outputReservation: budget.outputReservation,
        inputTokens,
        totalTokens,
        accounting,
        evidenceIds: admittedEvidence.map((item) => item.id),
        images: admittedImages,
        prompt: fitted.prompt,
        coverage,
      };
    },
  };
}
