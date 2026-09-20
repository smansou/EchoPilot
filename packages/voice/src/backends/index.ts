/**
 * V04 — BYOK voice backend: provider session → scoped memory/tool question → interrupt → local
 * continuity.
 *
 * This seam binds the OpenAI Realtime provider to the shared memory scope, the contracts attention
 * lease, the V02 native playback sink and the §5.5 action broker. The model never speaks on its
 * own: every provider response needs a granted speech lease, and only audio the device actually
 * rendered is ever reported by `heardText()` — generated narration that was cancelled, never
 * queued, or only partially played stays unheard.
 *
 * Invariants kept here, and verified by `acceptance.test.ts`:
 *   - a read tool call is answered inside the session scope with the contracts evidence bundle and
 *     is followed by exactly one grounded continuation response, but only while the lease holds;
 *   - `propose_action` reaches the broker and resolves to a proposal, never an execution;
 *   - barge-in stops local playback, truncates the provider item at the audio the device rendered
 *     and drops late audio from the cancelled response without marking it heard;
 *   - a provider cancellation (network loss, revocation, cost cap) flushes the cancelled narration,
 *     keeps the audio device open and announces local continuity exactly once.
 */

import type { Attention, EvidenceBundle, Memory, Scope, SpeechLease } from '../../../contracts/src/index.js';
import type { AudioFrame } from '../index.js';
import type { NativePlaybackSink, PlaybackFrame, PlaybackOutputFormat } from '../playback/index.js';

type JsonObject = Record<string, unknown>;

/** The §5.8 retrieval allocation: evidence never exceeds it, whatever the caller asks for. */
export const EVIDENCE_BUDGET_TOKENS_MAX = 1_536;
export const DEFAULT_EVIDENCE_BUDGET_TOKENS = 1_024;

export type RealtimeToolSchema = Readonly<{
  name: string;
  description: string;
  parameters: JsonObject;
}>;

const QUERY_PARAMETERS: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string', description: 'What to look up in the scoped memory.' } },
  required: ['query'],
};

/** The premium path's read-oriented tool set (§5.5); the caller forwards it to the provider. */
export const REALTIME_TOOL_SCHEMAS: ReadonlyArray<RealtimeToolSchema> = Object.freeze([
  Object.freeze({
    name: 'get_context',
    description: 'Read the bounded working context card for the current session scope.',
    parameters: { ...QUERY_PARAMETERS },
  }),
  Object.freeze({
    name: 'search_memory',
    description: 'Search the scoped project memory and return evidence ids with a bounded summary.',
    parameters: { ...QUERY_PARAMETERS },
  }),
  Object.freeze({
    name: 'read_event',
    description: 'Read one stored event (or a memory query) from the scoped project memory.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id to read; a query string is also accepted.' },
        query: { type: 'string', description: 'Optional text query when no event id is given.' },
      },
      required: [],
    },
  }),
  Object.freeze({
    name: 'propose_action',
    description: 'Propose a side-effecting action to the user; the broker never executes from here.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to propose.' },
        target: { type: 'string', description: 'Target of the proposed action.' },
      },
      required: ['action'],
    },
  }),
]);

export type BackendProviderEvent =
  | Readonly<{ type: 'session_ready'; generation: number }>
  | Readonly<{ type: 'response_started'; generation: number; responseId: string }>
  | Readonly<{
    type: 'transcript'; generation: number; responseId: string;
    itemId: string; contentIndex: number; text: string;
  }>
  | Readonly<{
    type: 'audio'; generation: number; responseId: string; itemId: string; contentIndex: number;
    pcm: Uint8Array; durationMs: number; sampleRate: number; channels: number;
  }>
  | Readonly<{
    type: 'tool_call'; generation: number; responseId: string;
    callId: string; name: string; arguments: JsonObject;
  }>
  | Readonly<{ type: 'response_done'; generation: number; responseId: string; transcript: string }>
  | Readonly<{ type: 'rotated'; generation: number; reason: 'token_budget' | 'time_rotation'; handoffTokens: number }>
  | Readonly<{ type: 'cancelled'; generation: number; reason: string }>;

/** The V04 provider client boundary, as pinned by the provider oracle. */
export type RealtimeVoiceBackendProvider = Readonly<{
  start(): Promise<void>;
  close(): Promise<void>;
  status(): Readonly<{ session: string; generation: number; cancelReason: string | null }>;
  onEvent(listener: (event: BackendProviderEvent) => void): () => void;
  admitInput(frame: AudioFrame): Promise<'sent' | 'held' | 'dropped'>;
  requestResponse(request: Readonly<{ userText?: string; instruction?: string }>): Promise<'requested' | 'withheld'>;
  sendToolResult(request: Readonly<{ generation: number; callId: string; result: unknown }>): Promise<'sent' | 'dropped'>;
  interrupt(request: Readonly<{
    generation: number;
    itemId: string;
    playedMs: number;
    reason: 'barge_in' | 'explicit_stop';
  }>): Promise<void>;
}>;

export type RealtimeVoiceBackendNotice = Readonly<{ type: 'local_fallback'; reason: string }>;

export type RealtimeVoiceBackendStatus = Readonly<{
  backend: 'premium' | 'local';
  generation: number;
  output: 'idle' | 'speaking' | 'cancelled';
  fallbackAnnounced: boolean;
}>;

export type RealtimeVoiceBackendOptions = Readonly<{
  provider: RealtimeVoiceBackendProvider;
  playback: NativePlaybackSink;
  memory: Pick<Memory, 'query'>;
  actions: Readonly<{ propose(request: JsonObject): Promise<Readonly<{ proposalId: string; summary: string }>> }>;
  attention: Attention;
  scope: Scope;
  evidenceBudgetTokens?: number;
}>;

export type RealtimeVoiceBackend = Readonly<{
  start(): Promise<void>;
  pushInput(frame: AudioFrame): Promise<'sent' | 'held' | 'dropped'>;
  ask(request: Readonly<{ lease: SpeechLease; question: string }>): Promise<'requested' | 'withheld'>;
  interrupt(reason: 'barge_in' | 'explicit_stop'): Promise<void>;
  heardText(): string;
  status(): RealtimeVoiceBackendStatus;
  onNotice(listener: (notice: RealtimeVoiceBackendNotice) => void): () => void;
  close(): Promise<void>;
}>;

type Segment = {
  segmentId: string;
  itemId: string;
  responseId: string;
  epoch: number;
  text: string;
  durationMs: number;
  renderedMs: number;
  written: boolean;
};

function segmentIdOf(itemId: string, contentIndex: number): string {
  return `${itemId}:${contentIndex}`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function measuredDurationMs(pcm: Uint8Array, sampleRate: number, channels: number): number {
  const bytesPerMs = (sampleRate * channels * 2) / 1_000;
  return bytesPerMs > 0 ? Math.round(pcm.byteLength / bytesPerMs) : 0;
}

function readQuery(argumentsObject: JsonObject): string {
  return asString(argumentsObject.query)
    ?? asString(argumentsObject.eventId)
    ?? asString(argumentsObject.text)
    ?? JSON.stringify(argumentsObject);
}

export function createRealtimeVoiceBackend(options: RealtimeVoiceBackendOptions): RealtimeVoiceBackend {
  const { provider, playback, memory, actions, attention, scope } = options;
  const evidenceBudgetTokens = options.evidenceBudgetTokens ?? DEFAULT_EVIDENCE_BUDGET_TOKENS;
  if (!Number.isFinite(evidenceBudgetTokens) || evidenceBudgetTokens <= 0 || evidenceBudgetTokens > EVIDENCE_BUDGET_TOKENS_MAX) {
    throw new RangeError(
      `evidenceBudgetTokens must be within (0, ${EVIDENCE_BUDGET_TOKENS_MAX}], received ${String(options.evidenceBudgetTokens)}`,
    );
  }

  let backend: 'premium' | 'local' = 'premium';
  let fallbackAnnounced = false;
  let phase: 'active' | 'cancelled' = 'active';
  let liveResponseId: string | null = null;
  let currentResponseId: string | null = null;
  let cancelledResponseId: string | null = null;
  let currentItemId: string | null = null;
  let currentEpoch = provider.status().generation;
  let activeLease: SpeechLease | null = null;
  let sinkOpen: Promise<void> | null = null;
  let closed = false;
  let sequence = 0;
  const segments = new Map<string, Segment>();
  const segmentOrder: string[] = [];
  const handledCalls = new Set<string>();
  const noticeListeners = new Set<(notice: RealtimeVoiceBackendNotice) => void>();

  function isCancelled(responseId: string | null): boolean {
    if (phase !== 'cancelled') return false;
    if (cancelledResponseId === null) return true;
    return responseId !== null && responseId === cancelledResponseId;
  }

  function ensureSink(format: PlaybackOutputFormat): Promise<void> {
    sinkOpen ??= playback.open(format);
    return sinkOpen;
  }

  function segmentFor(event: Readonly<{ itemId: string; contentIndex: number; responseId: string; generation: number }>): Segment {
    const segmentId = segmentIdOf(event.itemId, event.contentIndex);
    const existing = segments.get(segmentId);
    if (existing) {
      existing.responseId = event.responseId;
      existing.epoch = event.generation;
      return existing;
    }
    const created: Segment = {
      segmentId,
      itemId: event.itemId,
      responseId: event.responseId,
      epoch: event.generation,
      text: '',
      durationMs: 0,
      renderedMs: 0,
      written: false,
    };
    segments.set(segmentId, created);
    segmentOrder.push(segmentId);
    return created;
  }

  function handleTranscript(event: Extract<BackendProviderEvent, { type: 'transcript' }>): void {
    if (isCancelled(event.responseId)) return;
    currentItemId = event.itemId;
    currentResponseId = event.responseId;
    segmentFor(event).text = event.text;
  }

  function handleAudio(event: Extract<BackendProviderEvent, { type: 'audio' }>): void {
    if (isCancelled(event.responseId)) return;
    currentItemId = event.itemId;
    currentResponseId = event.responseId;
    const segment = segmentFor(event);
    segment.durationMs = event.durationMs > 0
      ? event.durationMs
      : measuredDurationMs(event.pcm, event.sampleRate, event.channels);
    const frame: PlaybackFrame = {
      epoch: event.generation,
      planId: event.responseId,
      segmentId: segment.segmentId,
      sequence,
      sampleRate: event.sampleRate,
      channels: event.channels,
      pcm: event.pcm,
    };
    sequence += 1;
    void ensureSink({ sampleRate: event.sampleRate, channels: event.channels }).then(() => {
      if (isCancelled(event.responseId)) return;
      playback.write(frame);
      segment.written = true;
    });
  }

  function handleProgress(progress: { epoch: number; segmentId: string; renderedMs: number }): void {
    const segment = segments.get(progress.segmentId);
    if (!segment || segment.epoch !== progress.epoch) return;
    segment.renderedMs = Math.max(segment.renderedMs, progress.renderedMs);
  }

  function continuationInstruction(event: Extract<BackendProviderEvent, { type: 'tool_call' }>): string {
    if (event.name === 'propose_action') {
      return 'The action was proposed to the user and is pending confirmation. Say that it needs confirmation; never describe it as done.';
    }
    return 'Answer strictly from the tool evidence just returned and cite its evidence ids. If the evidence does not state it, say so instead of guessing.';
  }

  async function resolveToolResult(event: Extract<BackendProviderEvent, { type: 'tool_call' }>): Promise<unknown> {
    if (event.name === 'propose_action') {
      const proposal = await actions.propose(event.arguments);
      return { status: 'proposed', proposalId: proposal.proposalId, summary: proposal.summary };
    }
    const evidence: EvidenceBundle = await memory.query(readQuery(event.arguments), scope, evidenceBudgetTokens);
    return { evidenceIds: [...evidence.evidenceIds], summary: evidence.summary };
  }

  async function handleToolCall(event: Extract<BackendProviderEvent, { type: 'tool_call' }>): Promise<void> {
    if (handledCalls.has(event.callId)) return;
    handledCalls.add(event.callId);
    let result: unknown;
    try {
      result = await resolveToolResult(event);
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    await provider.sendToolResult({ generation: event.generation, callId: event.callId, result });
    if (activeLease !== null && phase === 'active' && attention.canSpeak(activeLease)) {
      await provider.requestResponse({ instruction: continuationInstruction(event) });
    }
  }

  function announceFallback(reason: string): void {
    backend = 'local';
    phase = 'cancelled';
    cancelledResponseId = currentResponseId;
    liveResponseId = null;
    activeLease = null;
    if (!fallbackAnnounced) {
      fallbackAnnounced = true;
      for (const listener of [...noticeListeners]) listener({ type: 'local_fallback', reason });
    }
    void playback.flush();
  }

  function handleEvent(event: BackendProviderEvent): void {
    switch (event.type) {
      case 'session_ready':
        currentEpoch = event.generation;
        backend = 'premium';
        return;
      case 'response_started':
        currentEpoch = event.generation;
        currentResponseId = event.responseId;
        liveResponseId = event.responseId;
        cancelledResponseId = null;
        phase = 'active';
        return;
      case 'transcript':
        currentEpoch = event.generation;
        handleTranscript(event);
        return;
      case 'audio':
        handleAudio(event);
        return;
      case 'tool_call':
        void handleToolCall(event);
        return;
      case 'response_done':
        if (liveResponseId === event.responseId) liveResponseId = null;
        if (cancelledResponseId === event.responseId) cancelledResponseId = null;
        return;
      case 'rotated':
        currentEpoch = event.generation;
        liveResponseId = null;
        currentResponseId = null;
        return;
      case 'cancelled':
        if (event.generation !== currentEpoch) return;
        announceFallback(event.reason);
        return;
      default:
        return;
    }
  }

  function heardText(): string {
    return segmentOrder
      .map((segmentId) => segments.get(segmentId))
      .filter((segment): segment is Segment => segment !== undefined
        && segment.written
        && segment.durationMs > 0
        && segment.renderedMs >= segment.durationMs)
      .map((segment) => segment.text)
      .join('');
  }

  function playedMs(): number {
    let total = 0;
    for (const segment of segments.values()) {
      if (segment.itemId !== currentItemId) continue;
      if (segment.epoch !== currentEpoch) continue;
      total += segment.durationMs > 0
        ? Math.min(Math.max(segment.renderedMs, 0), segment.durationMs)
        : Math.max(segment.renderedMs, 0);
    }
    return Math.round(total);
  }

  function outputState(): 'idle' | 'speaking' | 'cancelled' {
    if (phase === 'cancelled') return 'cancelled';
    if (liveResponseId !== null) return 'speaking';
    for (const segment of segments.values()) {
      if (segment.written && segment.durationMs > 0 && segment.renderedMs < segment.durationMs) return 'speaking';
    }
    return 'idle';
  }

  const unsubscribers: Array<() => void> = [
    provider.onEvent((event) => { handleEvent(event); }),
    playback.onProgress((progress) => { handleProgress(progress); }),
  ];

  return {
    async start(): Promise<void> {
      await provider.start();
      currentEpoch = provider.status().generation;
      phase = 'active';
      backend = 'premium';
    },

    async pushInput(frame: AudioFrame): Promise<'sent' | 'held' | 'dropped'> {
      return provider.admitInput(frame);
    },

    async ask(request: Readonly<{ lease: SpeechLease; question: string }>): Promise<'requested' | 'withheld'> {
      if (!attention.canSpeak(request.lease)) return 'withheld';
      activeLease = request.lease;
      const result = await provider.requestResponse({ userText: request.question });
      if (result === 'requested') {
        phase = 'active';
        cancelledResponseId = null;
      }
      return result;
    },

    async interrupt(reason: 'barge_in' | 'explicit_stop'): Promise<void> {
      const itemId = currentItemId;
      const generation = provider.status().generation;
      const renderedMs = playedMs();
      cancelledResponseId = currentResponseId;
      liveResponseId = null;
      activeLease = null;
      phase = 'cancelled';
      if (itemId !== null) {
        await provider.interrupt({ generation, itemId, playedMs: renderedMs, reason });
      }
      await playback.flush();
    },

    heardText,

    status(): RealtimeVoiceBackendStatus {
      return {
        backend,
        generation: provider.status().generation,
        output: outputState(),
        fallbackAnnounced,
      };
    },

    onNotice(listener: (notice: RealtimeVoiceBackendNotice) => void): () => void {
      noticeListeners.add(listener);
      return () => { noticeListeners.delete(listener); };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (sinkOpen !== null) {
        try {
          await sinkOpen;
        } catch {
          sinkOpen = null;
        }
      }
      if (playback.isOpen()) await playback.close();
      await provider.close();
    },
  };
}
