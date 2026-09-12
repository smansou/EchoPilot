import type { NormalizedEvent, SourceCapsule } from './model.js';

/** Narrows an unknown payload to a plain JSON object without throwing on malformed input. */
export function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function truncate(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Concise, deterministic capsule summary. It is a pure function of the envelope and payload, so a
 * reopened store rebuilds byte-identical summaries.
 */
export function summarizeEvent(event: NormalizedEvent, payload: unknown): string {
  const record = asPayloadRecord(payload);
  switch (event.kind) {
    case 'user_utterance':
    case 'agent_message':
      return truncate(asText(record.text) ?? event.payloadRef);
    case 'decision': {
      const question = asText(record.question) ?? 'Decision';
      const choice = asText(record.choice) ?? 'no recorded choice';
      return truncate(`${question} — ${choice}`);
    }
    case 'tool_started': {
      const tool = asText(record.tool) ?? 'tool';
      const detail = asText(record.title) ?? asText(record.command) ?? event.payloadRef;
      return truncate(`${tool} started: ${detail}`);
    }
    case 'tool_completed': {
      const tool = asText(record.tool) ?? 'tool';
      const detail = asText(record.command) ?? asText(record.title) ?? event.payloadRef;
      const exitCode = typeof record.exitCode === 'number' ? record.exitCode : undefined;
      const verdict = exitCode === undefined || exitCode === 0 ? 'completed' : 'failed';
      return truncate(`${tool} ${verdict}: ${detail}${exitCode === undefined ? '' : ` (exit ${exitCode})`}`);
    }
    default: {
      const serialized = safeSerialize(record);
      return serialized.length > 2 ? truncate(`${event.kind}: ${serialized}`) : event.kind;
    }
  }
}

/** Lexical match text kept inside the encrypted capsule (never a plaintext SQLite FTS token). */
export function lexicalText(event: NormalizedEvent, payload: unknown, summary: string): string {
  const record = asPayloadRecord(payload);
  const pieces = [
    summary,
    event.kind,
    event.payloadRef,
    asText(record.text),
    asText(record.question),
    asText(record.choice),
    asText(record.rationale),
    asText(record.command),
    asText(record.output),
    asText(record.title),
  ];
  return pieces
    .filter((piece): piece is string => piece !== undefined && piece.length > 0)
    .join('\n')
    .toLowerCase();
}

export function reduceSourceCapsule(event: NormalizedEvent, payload: unknown): SourceCapsule {
  const summary = summarizeEvent(event, payload);
  return {
    id: event.eventId,
    kind: event.kind,
    summary,
    occurredAt: event.occurredAt,
    trust: event.trust,
    sourceEventIds: [event.eventId],
    searchText: lexicalText(event, payload, summary),
  };
}
