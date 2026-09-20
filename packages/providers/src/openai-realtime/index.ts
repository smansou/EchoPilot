/**
 * V04 — BYOK OpenAI `gpt-realtime` provider seam (plan §5.8): one bounded provider session at a
 * time, manual response leases, actual-playback truncation, usage accounting and a compact
 * handoff across every forced restart.
 *
 * The provider never creates a response on its own (`turn_detection: null`): the caller asks for
 * one response at a time, and every egress operation (`connect`, `input_audio`, `response_create`)
 * goes through the S01 policy frontier. The provider-history budget is the M02 allocation
 * `boundedBudget(model)`: audio is admitted only while `contextTokens + chunk <= budget.input`, and
 * a chunk that would cross the bound rotates the session first, resumes it from exactly one
 * compact textual handoff item and uploads the chunk there — never into the retired session.
 *
 * Invariants kept here, and verified by `acceptance.test.ts` against an instrumented transport and
 * a manual monotonic clock:
 *   - audio before `session.created` is held in a local ring and uploaded exactly once, after ready;
 *   - a session rotates at the token bound or at `sessionMaxMs` on the injected clock, closes the
 *     old socket cleanly, and the replacement session starts from the handoff, not a history replay;
 *   - a suspended grant (key revocation, cost cap, revoked grant) and network loss cancel the live
 *     generation immediately: late provider events from a cancelled response never surface, nothing
 *     is uploaded while cancelled, and audio buffered during an outage is dropped rather than
 *     replayed into the replacement session;
 *   - the raw BYOK key only ever travels in the transport request headers; it is never retained in
 *     provider state, so `status()` is safe to serialize.
 */

import { boundedBudget } from '../../../memory/src/context/index.js';
import type { AudioFrame } from '../../../voice/src/index.js';

export type RealtimeVoice = 'marin' | 'cedar';
export type RealtimeSuspensionReason = 'key_revoked' | 'cost_cap' | 'grant_revoked';
export type RealtimeCancelReason = RealtimeSuspensionReason | 'network_loss';
export type RealtimeEgressOperation = 'connect' | 'input_audio' | 'response_create';
export type RealtimeRotationReason = 'token_budget' | 'time_rotation';
export type RealtimeHandoffReason = RealtimeRotationReason | 'reconnect';
export type RealtimeSessionState = 'closed' | 'connecting' | 'ready' | 'rotating';

export type OpenAiRealtimeManifest = Readonly<{
  model: 'gpt-realtime';
  protocol: 'openai-realtime-ws-v1';
  endpoint: string;
  defaultVoice: RealtimeVoice;
  voices: ReadonlyArray<RealtimeVoice>;
  contextCapacity: number;
  audioChunkMaxMs: number;
  sessionMaxMs: number;
  budgetRatio: number;
}>;

export const OPENAI_REALTIME_MANIFEST: OpenAiRealtimeManifest = Object.freeze({
  model: 'gpt-realtime',
  protocol: 'openai-realtime-ws-v1',
  endpoint: 'wss://api.openai.com/v1/realtime',
  defaultVoice: 'marin',
  voices: Object.freeze(['marin', 'cedar'] as const),
  contextCapacity: 32_768,
  audioChunkMaxMs: 10_000,
  sessionMaxMs: 300_000,
  budgetRatio: 0.25,
});

/** The WebSocket boundary; `headers` carries the only copy of the raw key. */
export type RealtimeSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): () => void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: (event: { code: number; reason: string }) => void): () => void;
};

export type RealtimeTransport = (
  request: { url: string; headers: Readonly<Record<string, string>> },
) => RealtimeSocket;

export type RealtimeToolSchema = Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>;

export type RealtimeAuthorization = Readonly<{ status: 'granted' }>
  | Readonly<{ status: 'denied'; reason: string }>;

export type RealtimePolicy = {
  apiKey(): Promise<string | null>;
  authorize(request: Readonly<{ op: RealtimeEgressOperation; generation: number }>): Promise<RealtimeAuthorization>;
  onSuspend(listener: (reason: string) => void): () => void;
};

export type RealtimeHandoffRequest = Readonly<{
  reason: RealtimeHandoffReason;
  contextTokens: number;
  transcript: ReadonlyArray<string>;
}>;

export type RealtimeProviderEvent =
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
    callId: string; name: string; arguments: Record<string, unknown>;
  }>
  | Readonly<{ type: 'response_done'; generation: number; responseId: string; transcript: string }>
  | Readonly<{ type: 'rotated'; generation: number; reason: RealtimeRotationReason; handoffTokens: number }>
  | Readonly<{ type: 'cancelled'; generation: number; reason: RealtimeCancelReason }>;

export type RealtimeProviderStatus = Readonly<{
  session: RealtimeSessionState;
  generation: number;
  voice: RealtimeVoice;
  contextTokens: number;
  budgetTokens: number;
  spentMicroUsd: number;
  capMicroUsd: number;
  cancelReason: RealtimeCancelReason | null;
  droppedInputMs: number;
  pendingInputMs: number;
}>;

export type OpenAiRealtimeProviderOptions = Readonly<{
  transport: RealtimeTransport;
  clock: Readonly<{ now(): number }>;
  tokenizer: Readonly<{ count(text: string): number }>;
  model: Readonly<{ modelId: string; contextCapacity: number }>;
  policy: RealtimePolicy;
  cost: Readonly<{
    capMicroUsd: number;
    priceMicroUsdPerToken: Readonly<{ textInput: number; audioInput: number; output: number }>;
  }>;
  handoff(request: RealtimeHandoffRequest): Promise<string>;
  tools?: ReadonlyArray<RealtimeToolSchema>;
  audioTokensPerSecond?: number;
  voice?: RealtimeVoice;
}>;

export type OpenAiRealtimeProvider = Readonly<{
  start(): Promise<void>;
  close(): Promise<void>;
  status(): RealtimeProviderStatus;
  onEvent(listener: (event: RealtimeProviderEvent) => void): () => void;
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

type JsonObject = Record<string, unknown>;

const BYTES_PER_SAMPLE = 2;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function frameDurationMs(frame: AudioFrame): number {
  const frameBytes = frame.sampleRate * frame.channels * BYTES_PER_SAMPLE;
  if (frameBytes <= 0) return 0;
  return (frame.pcm.byteLength / frameBytes) * 1_000;
}

/**
 * The production transport. Node's global `WebSocket` does not accept request headers, so the raw
 * BYOK key is offered as the documented insecure-subprotocol fallback when the runtime rejects the
 * header-bearing constructor options; the deterministic oracles always inject their own transport.
 */
export function createRealtimeWebSocketTransport(): RealtimeTransport {
  type MinimalWebSocket = {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
  };
  type WebSocketConstructor = new (url: string, protocolsOrOptions?: unknown) => MinimalWebSocket;

  return (request) => {
    const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
    if (typeof ctor !== 'function') {
      throw new Error('gpt-realtime requires a WebSocket implementation in this runtime');
    }
    const construct = ctor as WebSocketConstructor;
    const authorization = request.headers.Authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    let socket: MinimalWebSocket;
    try {
      socket = new construct(request.url, { headers: { ...request.headers } });
    } catch {
      socket = new construct(
        request.url,
        bearer.length === 0 ? [] : ['realtime', `openai-insecure-api-key.${bearer}`],
      );
    }
    const wrap = (listener: () => void): () => void => {
      const handler = (): void => { listener(); };
      socket.addEventListener('open', handler);
      return () => { socket.removeEventListener('open', handler); };
    };
    return {
      send: (data) => { socket.send(data); },
      close: (code, reason) => { socket.close(code, reason); },
      onOpen: wrap,
      onMessage: (listener) => {
        const handler = (event: unknown): void => {
          const data = asString(asJsonObject(event).data);
          if (data !== null) listener(data);
        };
        socket.addEventListener('message', handler);
        return () => { socket.removeEventListener('message', handler); };
      },
      onClose: (listener) => {
        const handler = (event: unknown): void => {
          const detail = asJsonObject(event);
          listener({ code: asNumber(detail.code) ?? 1006, reason: asString(detail.reason) ?? '' });
        };
        socket.addEventListener('close', handler);
        return () => { socket.removeEventListener('close', handler); };
      },
    };
  };
}

export function createOpenAiRealtimeProvider(options: OpenAiRealtimeProviderOptions): OpenAiRealtimeProvider {
  const manifest = OPENAI_REALTIME_MANIFEST;
  const budget = boundedBudget(options.model);
  const voice: RealtimeVoice = options.voice ?? manifest.defaultVoice;
  const tools = options.tools ?? [];
  const audioTokensPerSecond = options.audioTokensPerSecond ?? null;
  const price = options.cost.priceMicroUsdPerToken;
  const outputReservationMicroUsd = budget.outputReservation * price.output;

  let sessionState: RealtimeSessionState = 'closed';
  let socket: RealtimeSocket | null = null;
  let socketUnsubscribers: Array<() => void> = [];
  let intentionalClose = false;
  let generation = 0;
  let cancelReason: RealtimeCancelReason | null = null;
  let suspendedReason: RealtimeSuspensionReason | null = null;
  let contextTokens = 0;
  let spentMicroUsd = 0;
  let droppedInputMs = 0;
  let pendingFrames: AudioFrame[] = [];
  let pendingInputMs = 0;
  let sessionStartMs = 0;
  let hadSession = false;
  let leaseActive = false;
  let liveResponseId: string | null = null;
  let responseTranscript = '';
  let readySignal: { resolve(): void; reject(error: Error): void } | null = null;
  const transcriptLines: string[] = [];
  const supersededResponses = new Set<string>();
  const observedToolCalls = new Set<string>();
  const listeners = new Set<(event: RealtimeProviderEvent) => void>();

  options.policy.onSuspend((reason) => {
    if (reason === 'key_revoked' || reason === 'cost_cap' || reason === 'grant_revoked') {
      suspend(reason);
    }
  });

  function emit(event: RealtimeProviderEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function remainingMicroUsd(): number {
    return options.cost.capMicroUsd - spentMicroUsd;
  }

  function resetSocket(): void {
    for (const unsubscribe of socketUnsubscribers) unsubscribe();
    socketUnsubscribers = [];
  }

  function closeSocket(reason: string): void {
    const current = socket;
    socket = null;
    intentionalClose = true;
    resetSocket();
    if (current !== null) current.close(1000, reason);
  }

  /** Cancels the live generation: the provider is told, and its late events are blackholed. */
  function cancelLiveResponse(sendCancel: boolean): void {
    const target = socket;
    const responseId = liveResponseId;
    if (sendCancel && target !== null && responseId !== null) {
      target.send(JSON.stringify({ type: 'response.cancel', response_id: responseId }));
      supersededResponses.add(responseId);
    }
    leaseActive = false;
    liveResponseId = null;
    responseTranscript = '';
  }

  function accountUsage(response: JsonObject): void {
    const usage = asJsonObject(response.usage);
    const details = asJsonObject(usage.input_token_details);
    const textTokens = asNumber(details.text_tokens) ?? 0;
    const audioTokens = asNumber(details.audio_tokens) ?? 0;
    const outputTokens = asNumber(usage.output_tokens) ?? 0;
    spentMicroUsd += textTokens * price.textInput
      + audioTokens * price.audioInput
      + outputTokens * price.output;
  }

  function responseIdOf(frame: JsonObject): string | null {
    const direct = asString(frame.response_id);
    if (direct !== null) return direct;
    return asString(asJsonObject(frame.response).id);
  }

  function isSuperseded(responseId: string | null): boolean {
    return responseId !== null && supersededResponses.has(responseId);
  }

  function handleMessage(data: string): void {
    let frame: JsonObject;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isJsonObject(parsed)) return;
      frame = parsed;
    } catch {
      return;
    }
    const type = asString(frame.type);
    if (type === null) return;
    const responseId = responseIdOf(frame);
    switch (type) {
      case 'session.created': {
        if (sessionState !== 'connecting') return;
        sessionState = 'ready';
        sessionStartMs = options.clock.now();
        const signal = readySignal;
        readySignal = null;
        signal?.resolve();
        emit({ type: 'session_ready', generation });
        return;
      }
      case 'response.created': {
        if (isSuperseded(responseId)) return;
        leaseActive = true;
        liveResponseId = responseId;
        responseTranscript = '';
        emit({ type: 'response_started', generation, responseId: responseId ?? '' });
        return;
      }
      case 'response.output_audio_transcript.delta': {
        if (isSuperseded(responseId)) return;
        const text = asString(frame.delta) ?? '';
        if (text.length === 0) return;
        responseTranscript += text;
        emit({
          type: 'transcript',
          generation,
          responseId: responseId ?? '',
          itemId: asString(frame.item_id) ?? '',
          contentIndex: asNumber(frame.content_index) ?? 0,
          text,
        });
        return;
      }
      case 'response.output_audio.delta': {
        if (isSuperseded(responseId)) return;
        const encoded = asString(frame.delta) ?? '';
        if (encoded.length === 0) return;
        const pcm = new Uint8Array(Buffer.from(encoded, 'base64'));
        const sampleRate = asNumber(frame.sample_rate) ?? 24_000;
        const channels = asNumber(frame.channels) ?? 1;
        const measuredMs = sampleRate * channels * BYTES_PER_SAMPLE;
        emit({
          type: 'audio',
          generation,
          responseId: responseId ?? '',
          itemId: asString(frame.item_id) ?? '',
          contentIndex: asNumber(frame.content_index) ?? 0,
          pcm,
          durationMs: asNumber(frame.duration_ms)
            ?? (measuredMs > 0 ? Math.round((pcm.byteLength / measuredMs) * 1_000) : 0),
          sampleRate,
          channels,
        });
        return;
      }
      case 'response.function_call_arguments.done':
      case 'response.output_item.done': {
        if (isSuperseded(responseId)) return;
        const item = type === 'response.output_item.done' ? asJsonObject(frame.item) : frame;
        if (type === 'response.output_item.done' && asString(item.type) !== 'function_call') return;
        const callId = asString(item.call_id) ?? '';
        if (callId.length === 0 || observedToolCalls.has(callId)) return;
        observedToolCalls.add(callId);
        emit({
          type: 'tool_call',
          generation,
          responseId: responseId ?? '',
          callId,
          name: asString(item.name) ?? '',
          arguments: asJsonObject(
            typeof item.arguments === 'string' ? safeParse(item.arguments) : item.arguments,
          ),
        });
        return;
      }
      case 'response.done': {
        const response = asJsonObject(frame.response);
        accountUsage(response);
        if (isSuperseded(responseId)) {
          if (responseId !== null) supersededResponses.delete(responseId);
          return;
        }
        const transcript = responseTranscript;
        responseTranscript = '';
        leaseActive = false;
        liveResponseId = null;
        if (transcript.trim().length > 0) transcriptLines.push(transcript);
        emit({ type: 'response_done', generation, responseId: responseId ?? '', transcript });
        return;
      }
      default:
        return;
    }
  }

  function safeParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  function handleClose(): void {
    if (intentionalClose) return;
    resetSocket();
    socket = null;
    if (sessionState === 'connecting') {
      // The audio held for this attempt belongs to the session that never became ready:
      // it is dropped here so a later reconnect can never replay private audio.
      for (const frame of pendingFrames) droppedInputMs += frameDurationMs(frame);
      pendingFrames = [];
      pendingInputMs = 0;
      sessionState = 'closed';
      const signal = readySignal;
      readySignal = null;
      signal?.reject(new Error('gpt-realtime session closed before session.created'));
      return;
    }
    sessionState = 'closed';
    if (cancelReason !== null) return;
    cancelReason = 'network_loss';
    cancelLiveResponse(false);
    emit({ type: 'cancelled', generation, reason: 'network_loss' });
  }

  async function authorize(op: RealtimeEgressOperation): Promise<RealtimeAuthorization> {
    return options.policy.authorize({ op, generation: generation + 1 });
  }

  async function connect(handoffText: string | null): Promise<void> {
    if (suspendedReason !== null) throw new Error(`session unavailable: ${suspendedReason}`);
    const apiKey = await options.policy.apiKey();
    if (apiKey === null || apiKey.length === 0) throw new Error('connect denied: key_revoked');
    const nextGeneration = generation + 1;
    if (suspendedReason !== null) throw new Error(`session unavailable: ${suspendedReason}`);
    const authorization = await options.policy.authorize({ op: 'connect', generation: nextGeneration });
    if (authorization.status !== 'granted') throw new Error(`connect denied: ${authorization.reason}`);
    generation = nextGeneration;
    sessionState = 'connecting';
    const ready = new Promise<void>((resolve, reject) => {
      readySignal = { resolve, reject };
    });
    const opened = options.transport({
      url: `${manifest.endpoint}?model=${encodeURIComponent(manifest.model)}`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    socket = opened;
    intentionalClose = false;
    socketUnsubscribers = [
      opened.onMessage((data) => { handleMessage(data); }),
      opened.onClose(() => { handleClose(); }),
      opened.onOpen(() => undefined),
    ];
    await ready;
    const sessionConfig: JsonObject = {
      voice,
      turn_detection: null,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
    };
    if (tools.length > 0) {
      sessionConfig.tools = tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }
    opened.send(JSON.stringify({ type: 'session.update', session: sessionConfig }));
    contextTokens = 0;
    if (handoffText !== null) {
      opened.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: handoffText }],
        },
      }));
      contextTokens = options.tokenizer.count(handoffText);
    }
    cancelReason = null;
    hadSession = true;
    await drainPending();
  }

  async function sendFrame(frame: AudioFrame): Promise<'sent' | 'dropped'> {
    const audioTokens = audioTokensPerSecond;
    if (audioTokens === null || audioTokens <= 0) {
      droppedInputMs += frameDurationMs(frame);
      return 'dropped';
    }
    const bytesPerMs = (frame.sampleRate * frame.channels * BYTES_PER_SAMPLE) / 1_000;
    if (bytesPerMs <= 0) {
      droppedInputMs += frameDurationMs(frame);
      return 'dropped';
    }
    let offset = 0;
    while (offset < frame.pcm.byteLength) {
      const target = socket;
      if (target === null || sessionState !== 'ready') {
        droppedInputMs += (frame.pcm.byteLength - offset) / bytesPerMs;
        return 'dropped';
      }
      const remainingMs = (frame.pcm.byteLength - offset) / bytesPerMs;
      const chunkBytes = Math.min(
        frame.pcm.byteLength - offset,
        Math.max(1, Math.round(Math.min(remainingMs, manifest.audioChunkMaxMs) * bytesPerMs)),
      );
      const chunkMs = chunkBytes / bytesPerMs;
      const chunkTokens = Math.ceil((chunkMs / 1_000) * audioTokens);
      if (contextTokens + chunkTokens > budget.input) {
        await rotate('token_budget');
        if (contextTokens + chunkTokens > budget.input) {
          droppedInputMs += (frame.pcm.byteLength - offset) / bytesPerMs;
          return 'dropped';
        }
        continue;
      }
      const authorization = await options.policy.authorize({ op: 'input_audio', generation });
      if (authorization.status !== 'granted') {
        droppedInputMs += (frame.pcm.byteLength - offset) / bytesPerMs;
        return 'dropped';
      }
      target.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(frame.pcm.subarray(offset, offset + chunkBytes)).toString('base64'),
      }));
      contextTokens += chunkTokens;
      offset += chunkBytes;
    }
    return 'sent';
  }

  async function drainPending(): Promise<void> {
    if (pendingFrames.length === 0) return;
    const held = pendingFrames;
    pendingFrames = [];
    pendingInputMs = 0;
    for (const frame of held) await sendFrame(frame);
  }

  function rotationDue(): boolean {
    return sessionState === 'ready' && options.clock.now() - sessionStartMs >= manifest.sessionMaxMs;
  }

  async function rotate(reason: RealtimeRotationReason): Promise<void> {
    if (sessionState !== 'ready') return;
    sessionState = 'rotating';
    cancelLiveResponse(true);
    const transcript = [...transcriptLines];
    const handoffText = await options.handoff({ reason, contextTokens, transcript });
    const handoffTokens = options.tokenizer.count(handoffText);
    closeSocket(`rotate:${reason}`);
    await connect(handoffText);
    emit({ type: 'rotated', generation, reason, handoffTokens });
  }

  function suspend(reason: RealtimeSuspensionReason): void {
    if (suspendedReason !== null) return;
    suspendedReason = reason;
    cancelReason = reason;
    cancelLiveResponse(true);
    closeSocket(`suspend:${reason}`);
    sessionState = 'closed';
    emit({ type: 'cancelled', generation, reason });
  }

  return {
    async start(): Promise<void> {
      if (suspendedReason !== null) throw new Error(`session unavailable: ${suspendedReason}`);
      if (sessionState === 'ready' || sessionState === 'connecting' || sessionState === 'rotating') return;
      let handoffText: string | null = null;
      if (hadSession) {
        handoffText = await options.handoff({
          reason: 'reconnect',
          contextTokens,
          transcript: [...transcriptLines],
        });
      }
      await connect(handoffText);
    },

    async close(): Promise<void> {
      cancelLiveResponse(true);
      closeSocket('close');
      sessionState = 'closed';
      pendingFrames = [];
      pendingInputMs = 0;
    },

    status(): RealtimeProviderStatus {
      return {
        session: sessionState,
        generation,
        voice,
        contextTokens,
        budgetTokens: budget.input,
        spentMicroUsd,
        capMicroUsd: options.cost.capMicroUsd,
        cancelReason,
        droppedInputMs,
        pendingInputMs,
      };
    },

    onEvent(listener: (event: RealtimeProviderEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    async admitInput(frame: AudioFrame): Promise<'sent' | 'held' | 'dropped'> {
      if (audioTokensPerSecond === null || audioTokensPerSecond <= 0) {
        droppedInputMs += frameDurationMs(frame);
        return 'dropped';
      }
      if (cancelReason !== null || suspendedReason !== null) {
        droppedInputMs += frameDurationMs(frame);
        return 'dropped';
      }
      if (sessionState === 'connecting' || sessionState === 'rotating') {
        pendingFrames.push(frame);
        pendingInputMs += frameDurationMs(frame);
        return 'held';
      }
      if (sessionState !== 'ready') {
        droppedInputMs += frameDurationMs(frame);
        return 'dropped';
      }
      if (rotationDue()) await rotate('time_rotation');
      return sendFrame(frame);
    },

    async requestResponse(request: Readonly<{ userText?: string; instruction?: string }>): Promise<'requested' | 'withheld'> {
      if (cancelReason !== null || suspendedReason !== null) return 'withheld';
      if (sessionState !== 'ready') return 'withheld';
      if (leaseActive) return 'withheld';
      if (remainingMicroUsd() < outputReservationMicroUsd) return 'withheld';
      if (rotationDue()) {
        await rotate('time_rotation');
        if (sessionState !== 'ready') return 'withheld';
      }
      const authorization = await options.policy.authorize({ op: 'response_create', generation });
      if (authorization.status !== 'granted') return 'withheld';
      const target = socket;
      if (target === null) return 'withheld';
      const userText = request.userText;
      if (typeof userText === 'string' && userText.length > 0) {
        target.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: userText }],
          },
        }));
        contextTokens += options.tokenizer.count(userText);
      }
      const responseConfig: JsonObject = {};
      if (typeof request.instruction === 'string' && request.instruction.length > 0) {
        responseConfig.instructions = request.instruction;
      }
      target.send(JSON.stringify({ type: 'response.create', response: responseConfig }));
      leaseActive = true;
      liveResponseId = null;
      responseTranscript = '';
      return 'requested';
    },

    async sendToolResult(request: Readonly<{ generation: number; callId: string; result: unknown }>): Promise<'sent' | 'dropped'> {
      if (request.generation !== generation) return 'dropped';
      if (cancelReason !== null || suspendedReason !== null) return 'dropped';
      if (sessionState !== 'ready') return 'dropped';
      const target = socket;
      if (target === null) return 'dropped';
      const authorization = await options.policy.authorize({ op: 'response_create', generation });
      if (authorization.status !== 'granted') return 'dropped';
      const output = JSON.stringify(request.result ?? null);
      target.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: request.callId, output },
      }));
      contextTokens += options.tokenizer.count(output);
      return 'sent';
    },

    async interrupt(request: Readonly<{
      generation: number;
      itemId: string;
      playedMs: number;
      reason: 'barge_in' | 'explicit_stop';
    }>): Promise<void> {
      if (request.generation !== generation) return;
      const target = socket;
      if (target === null || sessionState !== 'ready') return;
      const responseId = liveResponseId;
      const cancelFrame: JsonObject = responseId === null
        ? { type: 'response.cancel' }
        : { type: 'response.cancel', response_id: responseId };
      target.send(JSON.stringify(cancelFrame));
      if (responseId !== null) supersededResponses.add(responseId);
      target.send(JSON.stringify({
        type: 'conversation.item.truncate',
        item_id: request.itemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.round(request.playedMs)),
      }));
      leaseActive = false;
      liveResponseId = null;
      responseTranscript = '';
    },
  };
}
