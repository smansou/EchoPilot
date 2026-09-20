/**
 * V04 acceptance oracle — provider half. BYOK OpenAI `gpt-realtime` over WebSocket: manual
 * response leases, actual-playback truncation, usage accounting and the §5.8 provider-history
 * budget that must never be exceeded.
 *
 * The paid API and the §4.4 reference-machine numbers stay opt-in, so this file drives the same
 * provider seam through an instrumented fake WebSocket and a manual monotonic clock: every budget,
 * rollover, truncation and cancellation property below is decidable without network access, a key
 * or hardware. The recorded exchange in `fixtures/providers/v04-recorded-realtime-session.json`
 * supplies the protocol script and the usage numbers; the live BYOK path is the opt-in test in the
 * sibling oracle `packages/voice/src/backends/acceptance.test.ts`.
 *
 * `packages/providers/src/openai-realtime/index.ts` must export:
 *
 *   OPENAI_REALTIME_MANIFEST = {
 *     model: 'gpt-realtime', protocol: 'openai-realtime-ws-v1',
 *     endpoint: 'wss://api.openai.com/v1/realtime',
 *     defaultVoice: 'marin', voices: ['marin', 'cedar'], contextCapacity: 32_768,
 *     audioChunkMaxMs: 10_000, sessionMaxMs: 300_000, budgetRatio: 0.25,
 *   }
 *
 *   createOpenAiRealtimeProvider(options) → OpenAiRealtimeProvider
 *
 *     options.transport({ url, headers }) → RealtimeSocket
 *       The WebSocket boundary. `url` is the pinned endpoint plus `?model=gpt-realtime`; `headers`
 *       carries `Authorization: Bearer <key>` and `OpenAI-Beta: realtime=v1` and is the only place
 *       the raw key ever goes. A socket exposes send(data), close(code?, reason?),
 *       onOpen(listener), onMessage(listener) and onClose(listener); every on* returns an
 *       unsubscribe function.
 *
 *     options.clock — monotonic milliseconds: now(): number. §5.8's five-minute rotation bound is
 *       measured on this clock, never on wall time.
 *
 *     options.tokenizer — the M02 exact text counter: count(text): number.
 *
 *     options.model = { modelId, contextCapacity }. The session budget is `boundedBudget(model)`
 *       from `packages/memory/src/context` (B = min(8192, floor(0.25 * C))), so
 *       `status().budgetTokens` is that input allocation and no provider session may exceed it.
 *
 *     options.policy — the S01 frontier:
 *       apiKey(): Promise<string | null>
 *       authorize({ op: 'connect' | 'input_audio' | 'response_create', generation }) →
 *         Promise<{ status: 'granted' } | { status: 'denied'; reason: string }>
 *       onSuspend(listener: (reason: 'key_revoked' | 'cost_cap' | 'grant_revoked') => void)
 *         → unsubscribe
 *       Every egress operation is authorized, and a suspension cancels the live generation
 *       immediately: revocation must never wait for the next user turn.
 *
 *     options.cost = { capMicroUsd, priceMicroUsdPerToken: { textInput, audioInput, output } }
 *       Usage is accounted from the provider's own `response.done` numbers and exposed as
 *       `status().spentMicroUsd`. A response is never started when the remaining cap is below the
 *       reserved maximum output cost (boundedBudget(model).outputReservation * price.output).
 *
 *     options.handoff({ reason: 'token_budget' | 'time_rotation' | 'reconnect', contextTokens,
 *       transcript }) → Promise<string>
 *       The compact textual handoff; compaction itself stays with the memory/context owner. A
 *       fresh session starts with no handoff, and every replacement session starts with exactly
 *       this one item instead of a replay of the previous session's items.
 *
 *     options.tools — read-oriented tool schemas forwarded in `session.update` (§5.5).
 *     options.audioTokensPerSecond — the declared conservative audio-token bound. When it is
 *       absent, §5.8's reduced premium mode applies and no audio is streamed at all.
 *     options.voice — 'marin' (default) or 'cedar' (the second curated voice).
 *
 *     provider:
 *       start(): Promise<void> — opens and configures one session; resolves after `session.created`.
 *       close(): Promise<void>
 *       status(): { session: 'closed' | 'connecting' | 'ready' | 'rotating'; generation; voice;
 *         contextTokens; budgetTokens; spentMicroUsd; capMicroUsd;
 *         cancelReason: 'network_loss' | 'key_revoked' | 'cost_cap' | 'grant_revoked' | null;
 *         droppedInputMs; pendingInputMs }
 *       onEvent(listener) → unsubscribe; events:
 *         { type: 'session_ready', generation }
 *         { type: 'response_started', generation, responseId }
 *         { type: 'transcript', generation, responseId, itemId, contentIndex, text }
 *         { type: 'audio', generation, responseId, itemId, contentIndex, pcm, durationMs,
 *           sampleRate, channels }
 *         { type: 'tool_call', generation, responseId, callId, name, arguments }
 *         { type: 'response_done', generation, responseId, transcript }
 *         { type: 'rotated', generation, reason: 'token_budget' | 'time_rotation', handoffTokens }
 *         { type: 'cancelled', generation, reason }
 *       admitInput(frame) → 'sent' | 'held' | 'dropped'
 *         One frame is cut into appends of at most audioChunkMaxMs. Audio is charged
 *         ceil(durationMs / 1000 * audioTokensPerSecond) and is admitted only while the session
 *         total stays inside the budget; otherwise the session rotates first, at that audio
 *         boundary. A frame that arrives before the session is ready is 'held' in the bounded local
 *         ring and drained exactly once. A frame that arrives while the session is disconnected,
 *         suspended or has no declared bound is 'dropped' and is never uploaded later.
 *       requestResponse({ userText?, instruction? }) → 'requested' | 'withheld'
 *         Manual response leases: `session.update` configures the session once with the pinned
 *         voice, the forwarded tool schemas and `turn_detection: null` (automatic response
 *         creation and automatic interruption stay off). `response.create` is only ever sent from
 *         this call, at most one response is live at a time, and nothing is sent while the session
 *         is cancelled, out of budget, unauthorized or rotating. `userText` creates exactly one
 *         user message item first; `instruction` rides the response request.
 *       sendToolResult({ generation, callId, result }) → 'sent' | 'dropped'
 *         Answers a tool call with a `conversation.item.create` function_call_output and never
 *         creates a response by itself. Stale generations are dropped.
 *       interrupt({ generation, itemId, playedMs, reason: 'barge_in' | 'explicit_stop' })
 *         Cancels the live response and truncates the provider item at the audio duration that
 *         actually reached the device. Late audio from the cancelled response never becomes a
 *         provider event, and the session itself stays usable.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { boundedBudget } from '../../../memory/src/context/index.js';
import type { AudioFrame } from '../../../voice/src/index.js';

type JsonObject = Record<string, unknown>;
type ClientFrame = JsonObject & { type: string };
type ServerFrame = JsonObject & { type: string };

type RealtimeSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(listener: () => void): () => void;
  onMessage(listener: (data: string) => void): () => void;
  onClose(listener: (event: { code: number; reason: string }) => void): () => void;
};
type RealtimeTransportLike = (
  request: { url: string; headers: Readonly<Record<string, string>> },
) => RealtimeSocketLike;
type ToolSchemaLike = { name: string; description: string; parameters: JsonObject };
type HandoffRequestLike = { reason: string; contextTokens: number; transcript: readonly string[] };
type AuthorizationLike = { op: string; generation: number };
type SuspensionReason = 'key_revoked' | 'cost_cap' | 'grant_revoked';

type ProviderSeam = typeof import('./index.js');
type ProviderLike = ReturnType<ProviderSeam['createOpenAiRealtimeProvider']>;

const FIXTURE_URL = new URL('../../../../fixtures/providers/v04-recorded-realtime-session.json', import.meta.url);

/** Input budget for a 4K-capacity model: min(8192, floor(0.25 * 4096)) - 256 output reservation. */
const SMALL_MODEL = { modelId: 'gpt-realtime', contextCapacity: 4_096 } as const;
/** The conservative preflight bound this instrumented test declares for audio input. */
const AUDIO_TOKENS_PER_SECOND = 10;
const DEFAULT_COST = { capMicroUsd: 100_000, priceMicroUsdPerToken: { textInput: 1, audioInput: 5, output: 2 } } as const;
const DEFAULT_HANDOFF = 'Handoff: desktop auth decision PKCE; pending deploy follow-up on the parser.';
const DEFAULT_TOOLS: readonly ToolSchemaLike[] = [
  {
    name: 'search_memory',
    description: 'Search the scoped project memory and return evidence ids with a bounded summary.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1_000;
const PROVIDER_KEY = 'sk-test-v04-not-a-real-key';

const ORACLE_TOKENIZER = {
  count(text: string): number {
    return Math.max(1, text.trim().split(/\s+/).filter((part) => part.length > 0).length);
  },
};

let seamPromise: Promise<ProviderSeam> | null = null;

/**
 * The seam is loaded lazily so the red baseline reports the missing capability instead of a bare
 * module-resolution crash, and so the same file passes unchanged once the seam exists.
 */
async function providerModule(): Promise<ProviderSeam> {
  seamPromise ??= import('./index.js').catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'V04 provider seam missing: packages/providers/src/openai-realtime/index.ts must export '
      + `OPENAI_REALTIME_MANIFEST and createOpenAiRealtimeProvider (${detail})`,
    );
  });
  return seamPromise;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

class FakeSocket implements RealtimeSocketLike {
  readonly sent: ClientFrame[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly openListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(data: string) => void> = [];
  private readonly closeListeners: Array<(event: { code: number; reason: string }) => void> = [];

  constructor(readonly request: { url: string; headers: Readonly<Record<string, string>> }) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(code = 1000, reason = ''): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    for (const listener of [...this.closeListeners]) listener({ code, reason });
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.push(listener);
    return () => undefined;
  }

  onMessage(listener: (data: string) => void): () => void {
    this.messageListeners.push(listener);
    return () => undefined;
  }

  onClose(listener: (event: { code: number; reason: string }) => void): () => void {
    this.closeListeners.push(listener);
    return () => undefined;
  }

  fireOpen(): void {
    for (const listener of [...this.openListeners]) listener();
  }

  serverSend(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const listener of [...this.messageListeners]) listener(data);
  }

  /** Network loss, as the OS reports it: an abnormal close with no close handshake. */
  dropNetwork(): void {
    if (this.closedWith) return;
    this.closedWith = { code: 1006, reason: 'network lost' };
    for (const listener of [...this.closeListeners]) listener({ code: 1006, reason: 'network lost' });
  }
}

class FakePolicy {
  key = PROVIDER_KEY;
  private revoked = false;
  private denied: { op: string; reason: string } | null = null;
  readonly authorized: AuthorizationLike[] = [];
  readonly suspensions: Array<(reason: string) => void> = [];

  async apiKey(): Promise<string | null> {
    return this.revoked ? null : this.key;
  }

  async authorize(request: AuthorizationLike): Promise<{ status: 'granted' } | { status: 'denied'; reason: string }> {
    this.authorized.push({ op: request.op, generation: request.generation });
    if (this.revoked) return { status: 'denied', reason: 'key_revoked' };
    if (this.denied && this.denied.op === request.op) return { status: 'denied', reason: this.denied.reason };
    return { status: 'granted' };
  }

  onSuspend(listener: (reason: string) => void): () => void {
    this.suspensions.push(listener);
    return () => {
      const index = this.suspensions.indexOf(listener);
      if (index >= 0) this.suspensions.splice(index, 1);
    };
  }

  deny(op: string, reason: string): void {
    this.denied = { op, reason };
  }

  suspend(reason: SuspensionReason): void {
    if (reason === 'key_revoked') this.revoked = true;
    for (const listener of [...this.suspensions]) listener(reason);
  }
}

type Harness = Readonly<{
  provider: ProviderLike;
  sockets: FakeSocket[];
  policy: FakePolicy;
  handoffs: HandoffRequestLike[];
  events: unknown[];
  advanceClock(ms: number): void;
  /** Withhold `session.created` for the next socket so a frame can arrive before the session is ready. */
  holdNextSession(): void;
}>;

type HarnessOverrides = {
  model?: { modelId: string; contextCapacity: number };
  audioTokensPerSecond?: number;
  tools?: readonly ToolSchemaLike[];
  handoffText?: string;
  policy?: FakePolicy;
  cost?: { capMicroUsd: number; priceMicroUsdPerToken: { textInput: number; audioInput: number; output: number } };
};

async function createHarness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const seam = await providerModule();
  const sockets: FakeSocket[] = [];
  let held: number | null = null;
  const transport: RealtimeTransportLike = (request) => {
    const socket = new FakeSocket(request);
    sockets.push(socket);
    const index = sockets.length;
    const withhold = held === index;
    if (withhold) held = null;
    queueMicrotask(() => socket.fireOpen());
    queueMicrotask(() => {
      if (!withhold) {
        socket.serverSend({ type: 'session.created', session: { id: `sess-v04-${index}`, model: 'gpt-realtime' } });
      }
    });
    return socket;
  };
  const clockState = { nowMs: 1_000 };
  const handsOff: HandoffRequestLike[] = [];
  const policy = overrides.policy ?? new FakePolicy();
  const events: unknown[] = [];
  const provider = seam.createOpenAiRealtimeProvider({
    transport,
    clock: { now: () => clockState.nowMs },
    tokenizer: ORACLE_TOKENIZER,
    model: overrides.model ?? SMALL_MODEL,
    policy,
    cost: overrides.cost ?? DEFAULT_COST,
    tools: overrides.tools ?? DEFAULT_TOOLS,
    handoff: async (request) => {
      handsOff.push({ reason: request.reason, contextTokens: request.contextTokens, transcript: [...request.transcript] });
      return overrides.handoffText ?? DEFAULT_HANDOFF;
    },
    ...(overrides.audioTokensPerSecond === undefined ? {} : { audioTokensPerSecond: overrides.audioTokensPerSecond }),
  });
  provider.onEvent((event) => { events.push(event); });
  return {
    provider,
    sockets,
    policy,
    handoffs: handsOff,
    events,
    advanceClock(ms: number): void { clockState.nowMs += ms; },
    holdNextSession(): void { held = sockets.length + 1; },
  };
}

function pcmFrame(sequence: number, durationMs: number, fill: number): AudioFrame {
  return {
    sequence,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    monotonicNs: String(BigInt(sequence) * 20_000_000n),
    pcm: new Uint8Array(Math.round(durationMs * BYTES_PER_MS)).fill(fill),
  };
}

function base64(pcm: Uint8Array): string {
  return Buffer.from(pcm).toString('base64');
}

function framesOfType(socket: FakeSocket, type: string): ClientFrame[] {
  return socket.sent.filter((frame) => frame.type === type);
}

function appendDurationsMs(socket: FakeSocket): number[] {
  return framesOfType(socket, 'input_audio_buffer.append').map(
    (frame) => Buffer.from(String(frame.audio ?? ''), 'base64').byteLength / BYTES_PER_MS,
  );
}

function appendTokens(socket: FakeSocket): number {
  return appendDurationsMs(socket).reduce(
    (total, ms) => total + Math.ceil((ms / 1_000) * AUDIO_TOKENS_PER_SECOND),
    0,
  );
}

function eventsOfType(events: readonly unknown[], type: string): JsonObject[] {
  return events.filter(
    (event): event is JsonObject => typeof event === 'object' && event !== null
      && (event as { type?: unknown }).type === type,
  );
}

async function openSession(harness: Harness): Promise<FakeSocket> {
  await harness.provider.start();
  await flush();
  const socket = harness.sockets.at(-1);
  assert.ok(socket, 'the provider opened a socket through the injected transport');
  return socket;
}

async function reconnect(harness: Harness): Promise<FakeSocket> {
  await harness.provider.start();
  await flush();
  const socket = harness.sockets.at(-1);
  assert.ok(socket, 'the provider opened a socket for the replacement session');
  return socket;
}

type RecordedFixture = {
  manifest: { model: string; protocol: string; endpoint: string; voice: string; contextCapacity: number };
  pricing_micro_usd_per_token: { textInput: number; audioInput: number; output: number };
  cap_micro_usd: number;
  session: { question: string; client: ClientFrame[]; server: ServerFrame[] };
};

async function recordedFixture(): Promise<RecordedFixture> {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as RecordedFixture;
}

function recordedAudioFrame(event: ServerFrame): ServerFrame {
  const bytes = Number(event.audio_bytes);
  assert.ok(Number.isInteger(bytes) && bytes > 0, 'the recording stores an audio byte count');
  return { ...event, delta: Buffer.alloc(bytes).toString('base64') };
}

test('the manifest pins the tested gpt-realtime model, the curated voices and the §5.8 bounds', async () => {
  const { OPENAI_REALTIME_MANIFEST } = await providerModule();
  const fixture = await recordedFixture();

  assert.equal(OPENAI_REALTIME_MANIFEST.model, 'gpt-realtime');
  assert.equal(OPENAI_REALTIME_MANIFEST.protocol, 'openai-realtime-ws-v1');
  assert.equal(OPENAI_REALTIME_MANIFEST.endpoint, 'wss://api.openai.com/v1/realtime');
  assert.equal(OPENAI_REALTIME_MANIFEST.defaultVoice, 'marin');
  assert.deepEqual([...OPENAI_REALTIME_MANIFEST.voices], ['marin', 'cedar']);
  assert.equal(OPENAI_REALTIME_MANIFEST.contextCapacity, 32_768);
  assert.ok(
    OPENAI_REALTIME_MANIFEST.audioChunkMaxMs <= 10_000,
    `§5.8 admits audio in at most 10 s chunks, manifest says ${OPENAI_REALTIME_MANIFEST.audioChunkMaxMs} ms`,
  );
  assert.ok(
    OPENAI_REALTIME_MANIFEST.sessionMaxMs <= 300_000,
    `§5.8 rotates at five minutes at the latest, manifest says ${OPENAI_REALTIME_MANIFEST.sessionMaxMs} ms`,
  );
  assert.equal(OPENAI_REALTIME_MANIFEST.budgetRatio, 0.25);
  assert.equal(fixture.manifest.model, OPENAI_REALTIME_MANIFEST.model);
  assert.equal(
    boundedBudget({ modelId: OPENAI_REALTIME_MANIFEST.model, contextCapacity: OPENAI_REALTIME_MANIFEST.contextCapacity }).input,
    6_144,
  );
});

test('manual response leases: the session creates a response only on an explicit request', async () => {
  const harness = await createHarness();
  const socket = await openSession(harness);

  assert.equal(harness.provider.status().session, 'ready');
  assert.equal(harness.provider.status().voice, 'marin');
  assert.ok(
    socket.request.url.startsWith('wss://api.openai.com/v1/realtime'),
    `the session opens on the pinned endpoint, saw ${socket.request.url}`,
  );
  assert.match(socket.request.url, /model=gpt-realtime/);
  assert.equal(socket.request.headers.Authorization, `Bearer ${PROVIDER_KEY}`);
  assert.equal(socket.request.headers['OpenAI-Beta'], 'realtime=v1');

  const sessionUpdates = framesOfType(socket, 'session.update');
  assert.equal(sessionUpdates.length, 1, 'the session is configured exactly once');
  const session = (sessionUpdates[0]?.session ?? {}) as JsonObject;
  assert.equal(session.voice, 'marin');
  assert.equal(session.turn_detection, null, 'automatic response creation and interruption stay off');
  const tools = (session.tools ?? []) as Array<{ name?: string }>;
  assert.deepEqual(tools.map((tool) => tool.name), ['search_memory']);
  assert.equal(framesOfType(socket, 'response.create').length, 0, 'no automatic response is ever created');

  const question = (await recordedFixture()).session.question;
  assert.equal(await harness.provider.requestResponse({ userText: question }), 'requested');
  const userItems = framesOfType(socket, 'conversation.item.create').filter((frame) => {
    const item = (frame.item ?? {}) as JsonObject;
    return item.role === 'user';
  });
  assert.equal(userItems.length, 1, 'the question is created exactly once');
  const item = userItems[0]?.item as JsonObject;
  const content = (item.content ?? []) as Array<{ text?: string }>;
  assert.equal(content[0]?.text, question);
  assert.equal(framesOfType(socket, 'response.create').length, 1);

  assert.equal(await harness.provider.requestResponse({}), 'withheld', 'one response is live at a time');
  assert.equal(framesOfType(socket, 'response.create').length, 1);

  socket.serverSend({ type: 'response.done', response: { id: 'resp-manual-1', status: 'completed' } });
  await flush();
  assert.equal(await harness.provider.requestResponse({ instruction: 'Answer in one sentence.' }), 'requested');
  const creates = framesOfType(socket, 'response.create');
  assert.equal(creates.length, 2);
  assert.equal(creates[1]?.response && (creates[1]?.response as JsonObject).instructions, 'Answer in one sentence.');
});

test('the provider-history budget is enforced at the §5.8 25% bound and rolls over from a compact handoff', async () => {
  const harness = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  const budget = boundedBudget(SMALL_MODEL);
  const socket = await openSession(harness);
  assert.equal(harness.provider.status().budgetTokens, budget.input);

  // §5.8: one oversized device frame is cut into appends of at most 10 s.
  assert.equal(await harness.provider.admitInput(pcmFrame(0, 16_000, 1)), 'sent');
  assert.deepEqual(appendDurationsMs(socket), [10_000, 6_000]);
  for (let index = 0; index < 6; index += 1) {
    assert.equal(await harness.provider.admitInput(pcmFrame(index + 1, 10_000, index + 2)), 'sent');
  }
  assert.equal(appendDurationsMs(socket).length, 8);
  assert.equal(appendTokens(socket), 760);
  assert.equal(harness.provider.status().contextTokens, 760);
  assert.ok(appendTokens(socket) <= budget.input, 'the live session stays inside the configured budget');
  assert.equal(harness.handoffs.length, 0, 'a fresh session starts without a handoff');

  // The next chunk would cross the budget, so the session rotates before admitting it.
  const overflowing = pcmFrame(99, 10_000, 9);
  assert.equal(await harness.provider.admitInput(overflowing), 'sent');
  await flush();

  assert.equal(harness.sockets.length, 2, 'the provider opened a replacement session');
  assert.equal(socket.closedWith?.code, 1000, 'the old session is closed cleanly at the audio boundary');
  assert.equal(harness.handoffs.length, 1);
  assert.equal(harness.handoffs[0]?.reason, 'token_budget');
  assert.equal(harness.handoffs[0]?.contextTokens, 760);
  const rotated = harness.sockets[1];
  assert.ok(rotated);
  const handoffItems = framesOfType(rotated, 'conversation.item.create');
  assert.equal(handoffItems.length, 1, 'the replacement session starts from the handoff, not a history replay');
  assert.ok(
    JSON.stringify(handoffItems[0]).includes(DEFAULT_HANDOFF),
    'the compact textual handoff is the first item of the replacement session',
  );
  assert.deepEqual(appendDurationsMs(rotated), [10_000]);
  assert.equal(
    appendTokens(rotated) + ORACLE_TOKENIZER.count(DEFAULT_HANDOFF),
    harness.provider.status().contextTokens,
  );
  assert.ok(
    appendTokens(rotated) + ORACLE_TOKENIZER.count(DEFAULT_HANDOFF) <= budget.input,
    'the replacement session also stays inside the configured budget',
  );
  assert.equal(harness.provider.status().generation, 2);
  assert.equal(harness.provider.status().session, 'ready');
  assert.ok(
    JSON.stringify(rotated.sent).includes(base64(overflowing.pcm)),
    'the chunk that crossed the bound is admitted exactly once, in the new session',
  );
  assert.ok(
    !JSON.stringify(socket.sent).includes(base64(overflowing.pcm)),
    'the chunk that crossed the bound never reaches the old session',
  );
  assert.ok(
    eventsOfType(harness.events, 'rotated').some((event) => event.reason === 'token_budget'),
    'the rotation is observable',
  );
});

test('a held utterance drains exactly once, and the five-minute bound forces a rotation', async () => {
  const pending = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  pending.holdNextSession();
  const pendingFrame = pcmFrame(0, 1_000, 3);
  const started = pending.provider.start();
  await flush();
  const first = pending.sockets[0];
  assert.ok(first, 'the transport opened the session socket');
  assert.equal(await pending.provider.admitInput(pendingFrame), 'held', 'audio before ready stays in the local ring');
  assert.equal(pending.provider.status().pendingInputMs, 1_000);
  assert.equal(framesOfType(first, 'input_audio_buffer.append').length, 0, 'nothing is uploaded before the session is ready');
  first.serverSend({ type: 'session.created', session: { id: 'sess-v04-held', model: 'gpt-realtime' } });
  await started;
  await flush();
  assert.deepEqual(appendDurationsMs(first), [1_000]);
  assert.equal(pending.provider.status().pendingInputMs, 0);
  assert.equal(
    JSON.stringify(first.sent).split(base64(pendingFrame.pcm)).length - 1,
    1,
    'the held utterance is never replayed twice',
  );

  // §5.8: rotate at five minutes at the latest even with low usage.
  const timed = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  const before = await openSession(timed);
  const early = pcmFrame(0, 1_000, 5);
  assert.equal(await timed.provider.admitInput(early), 'sent');
  timed.advanceClock(300_001);
  const late = pcmFrame(1, 1_000, 6);
  assert.equal(await timed.provider.admitInput(late), 'sent');
  await flush();

  assert.equal(timed.sockets.length, 2);
  assert.equal(before.closedWith?.code, 1000);
  assert.equal(timed.handoffs.length, 1);
  assert.equal(timed.handoffs[0]?.reason, 'time_rotation');
  const replacement = timed.sockets[1];
  assert.ok(replacement);
  assert.deepEqual(appendDurationsMs(before), [1_000]);
  assert.deepEqual(appendDurationsMs(replacement), [1_000]);
  assert.equal(
    JSON.stringify([...before.sent, ...replacement.sent]).split(base64(late.pcm)).length - 1,
    1,
    'the utterance that arrived at the rotation boundary is sent exactly once',
  );
  assert.ok(!JSON.stringify(before.sent).includes(base64(late.pcm)), 'the pending utterance never lands in the old session');
  assert.equal(timed.provider.status().session, 'ready');
  assert.equal(timed.provider.status().generation, 2);
});

test('interrupt truncates the provider item at the actually played duration and drops late audio', async () => {
  const fixture = await recordedFixture();
  const harness = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  const socket = await openSession(harness);
  assert.equal(await harness.provider.requestResponse({ userText: fixture.session.question }), 'requested');

  const server = fixture.session.server;
  const created = server.find((frame) => frame.type === 'response.created');
  const firstTranscript = server.find((frame) => frame.type === 'response.output_audio_transcript.delta');
  const firstAudio = server.find((frame) => frame.type === 'response.output_audio.delta');
  const secondTranscript = server.filter((frame) => frame.type === 'response.output_audio_transcript.delta')[1];
  const secondAudio = server.filter((frame) => frame.type === 'response.output_audio.delta')[1];
  const done = server.find((frame) => frame.type === 'response.done');
  assert.ok(created && firstTranscript && firstAudio && secondTranscript && secondAudio && done);

  socket.serverSend(created);
  socket.serverSend(firstTranscript);
  socket.serverSend(recordedAudioFrame(firstAudio));
  await flush();

  const audioBefore = eventsOfType(harness.events, 'audio');
  assert.equal(audioBefore.length, 1);
  assert.equal(audioBefore[0]?.durationMs, 1_600);
  assert.equal((audioBefore[0]?.pcm as Uint8Array).byteLength, 76_800);
  assert.equal(audioBefore[0]?.sampleRate, 24_000);
  assert.equal(audioBefore[0]?.channels, 1);
  assert.equal(eventsOfType(harness.events, 'transcript')[0]?.text, firstTranscript.delta);

  await harness.provider.interrupt({ generation: 1, itemId: 'item-v04-1', playedMs: 1_250, reason: 'barge_in' });
  const cancels = framesOfType(socket, 'response.cancel');
  const truncations = framesOfType(socket, 'conversation.item.truncate');
  assert.equal(cancels.length, 1, 'the provider response is cancelled');
  assert.equal(cancels[0]?.response_id, 'resp-v04-1');
  assert.equal(truncations.length, 1);
  assert.equal(truncations[0]?.item_id, 'item-v04-1');
  assert.equal(truncations[0]?.audio_end_ms, 1_250, 'truncation uses the actual played audio duration');
  assert.ok(
    socket.sent.indexOf(cancels[0] as ClientFrame) < socket.sent.indexOf(truncations[0] as ClientFrame),
    'the response is cancelled before the item is truncated',
  );

  socket.serverSend(secondTranscript);
  socket.serverSend(recordedAudioFrame(secondAudio));
  socket.serverSend(done);
  await flush();
  assert.equal(eventsOfType(harness.events, 'audio').length, 1, 'late audio from the cancelled response is dropped');

  // The session survives barge-in: the next leased response is created normally.
  assert.equal(await harness.provider.requestResponse({ userText: 'continue' }), 'requested');
  await flush();
  assert.equal(framesOfType(socket, 'response.create').length, 2);
  assert.equal(harness.provider.status().session, 'ready');
  assert.equal(harness.provider.status().cancelReason, null);
});

test('network loss cancels the generation and queued audio is never uploaded on reconnect', async () => {
  const harness = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  const socket = await openSession(harness);
  assert.equal(await harness.provider.requestResponse({ userText: 'Tell me the deploy status.' }), 'requested');
  socket.serverSend({ type: 'response.created', response: { id: 'resp-loss-1' } });
  await flush();

  socket.dropNetwork();
  await flush();
  assert.equal(harness.provider.status().session, 'closed');
  assert.equal(harness.provider.status().cancelReason, 'network_loss');
  assert.ok(
    eventsOfType(harness.events, 'cancelled').some((event) => event.reason === 'network_loss'),
    'the cancelled generation is observable',
  );
  assert.equal(harness.sockets.length, 1, 'the provider never reconnects on its own');

  const duringOutage = pcmFrame(0, 1_500, 7);
  assert.equal(await harness.provider.admitInput(duringOutage), 'dropped');
  assert.equal(harness.provider.status().droppedInputMs, 1_500);

  const replacement = await reconnect(harness);
  assert.equal(harness.handoffs.length, 1);
  assert.equal(harness.handoffs[0]?.reason, 'reconnect');
  assert.equal(
    framesOfType(replacement, 'input_audio_buffer.append').length,
    0,
    'no buffered private audio is uploaded on reconnect',
  );
  assert.ok(
    !JSON.stringify(replacement.sent).includes(base64(duringOutage.pcm)),
    'the audio captured during the outage never reaches the replacement session',
  );
  assert.ok(
    JSON.stringify(framesOfType(replacement, 'conversation.item.create')).includes(DEFAULT_HANDOFF),
    'the replacement session resumes from the compact handoff',
  );
  assert.equal(harness.provider.status().session, 'ready');
  assert.equal(harness.provider.status().generation, 2);
  assert.equal(harness.provider.status().cancelReason, null);

  const afterReconnect = pcmFrame(1, 1_000, 8);
  assert.equal(await harness.provider.admitInput(afterReconnect), 'sent');
  assert.deepEqual(appendDurationsMs(replacement), [1_000]);
  assert.equal(
    JSON.stringify(replacement.sent).split(base64(afterReconnect.pcm)).length - 1,
    1,
  );
  assert.ok(!JSON.stringify(replacement.sent).includes(base64(duringOutage.pcm)));
});

test('key revocation and a denied grant cancel the live generation and block further egress', async () => {
  const harness = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  const socket = await openSession(harness);
  assert.equal(await harness.provider.requestResponse({ userText: 'Long answer, please.' }), 'requested');
  socket.serverSend({ type: 'response.created', response: { id: 'resp-revoked-1' } });
  await flush();

  harness.policy.suspend('key_revoked');
  await flush();
  assert.equal(harness.provider.status().cancelReason, 'key_revoked');
  assert.equal(framesOfType(socket, 'response.cancel').length, 1, 'the live generation is cancelled immediately');
  assert.ok(
    eventsOfType(harness.events, 'cancelled').some((event) => event.reason === 'key_revoked'),
    'the cancellation is observable',
  );
  const framesAfterRevocation = socket.sent.length;
  const outageFrame = pcmFrame(0, 1_000, 11);
  assert.equal(await harness.provider.admitInput(outageFrame), 'dropped');
  assert.equal(await harness.provider.requestResponse({ userText: 'again' }), 'withheld');
  assert.equal(socket.sent.length, framesAfterRevocation, 'nothing is sent after revocation');
  await harness.provider.start().catch(() => undefined);
  await flush();
  assert.equal(harness.sockets.length, 1, 'a revoked key never opens another paid session');
  assert.ok(
    !JSON.stringify(harness.provider.status()).includes(PROVIDER_KEY),
    'the raw key never leaks into provider state',
  );

  const denied = await createHarness({ audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND });
  denied.policy.deny('input_audio', 'grant_revoked');
  const deniedSocket = await openSession(denied);
  assert.equal(await denied.provider.admitInput(pcmFrame(0, 1_000, 12)), 'dropped');
  assert.equal(framesOfType(deniedSocket, 'input_audio_buffer.append').length, 0);
  assert.equal(denied.provider.status().droppedInputMs, 1_000);
  assert.deepEqual(
    [...new Set(denied.policy.authorized.map((entry) => entry.op))].sort(),
    ['connect', 'input_audio'],
    'every egress operation is authorized through S01',
  );

  const blocked = await createHarness();
  blocked.policy.deny('connect', 'grant_revoked');
  await assert.rejects(blocked.provider.start(), /denied|grant/i);
  await flush();
  assert.equal(blocked.sockets.length, 0, 'a denied connect never opens a socket');
});

test('usage accounting applies the recorded prices, reserves output and honours the cost cap', async () => {
  const fixture = await recordedFixture();
  const usage = (fixture.session.server.find((frame) => frame.type === 'response.done')?.response as JsonObject | undefined)
    ?.usage as JsonObject;
  const details = usage.input_token_details as JsonObject;
  const textTokens = Number(details.text_tokens);
  const audioTokens = Number(details.audio_tokens);
  const outputTokens = Number(usage.output_tokens);
  const price = fixture.pricing_micro_usd_per_token;
  const expectedSpend = textTokens * price.textInput + audioTokens * price.audioInput + outputTokens * price.output;
  assert.ok(expectedSpend < fixture.cap_micro_usd, 'the recorded response alone stays inside the recorded cap');

  const harness = await createHarness({
    model: { modelId: fixture.manifest.model, contextCapacity: fixture.manifest.contextCapacity },
    audioTokensPerSecond: AUDIO_TOKENS_PER_SECOND,
    cost: { capMicroUsd: fixture.cap_micro_usd, priceMicroUsdPerToken: price },
  });
  const socket = await openSession(harness);
  assert.equal(await harness.provider.requestResponse({ userText: fixture.session.question }), 'requested');
  socket.serverSend({ type: 'response.created', response: { id: 'resp-cost-1' } });
  socket.serverSend({ type: 'response.done', response: { id: 'resp-cost-1', status: 'completed', usage } });
  await flush();
  assert.equal(harness.provider.status().spentMicroUsd, expectedSpend);
  assert.equal(harness.provider.status().capMicroUsd, fixture.cap_micro_usd);

  const budget = boundedBudget({ modelId: fixture.manifest.model, contextCapacity: fixture.manifest.contextCapacity });
  const reserved = budget.outputReservation * price.output;
  assert.ok(
    fixture.cap_micro_usd - expectedSpend < reserved,
    'the recorded exchange leaves less than the reserved maximum response cost',
  );
  const createsBefore = framesOfType(socket, 'response.create').length;
  assert.equal(
    await harness.provider.requestResponse({ userText: 'that answer was expensive' }),
    'withheld',
    'no new paid response starts while the remaining cap is under the reserved maximum cost',
  );
  assert.equal(framesOfType(socket, 'response.create').length, createsBefore);

  harness.policy.suspend('cost_cap');
  await flush();
  assert.equal(harness.provider.status().cancelReason, 'cost_cap');
  assert.ok(eventsOfType(harness.events, 'cancelled').some((event) => event.reason === 'cost_cap'));
  assert.equal(await harness.provider.admitInput(pcmFrame(0, 1_000, 13)), 'dropped');
  assert.equal(await harness.provider.requestResponse({}), 'withheld');
});

test('a model without a declared audio-token bound streams no audio (reduced premium mode)', async () => {
  const harness = await createHarness();
  const socket = await openSession(harness);
  assert.equal(await harness.provider.admitInput(pcmFrame(0, 1_000, 14)), 'dropped');
  assert.equal(framesOfType(socket, 'input_audio_buffer.append').length, 0);
  assert.equal(harness.provider.status().droppedInputMs, 1_000);
  assert.equal(harness.provider.status().contextTokens, 0);

  assert.equal(
    await harness.provider.requestResponse({ userText: 'text-only premium answer' }),
    'requested',
    'the bounded text-input fallback keeps the response path usable',
  );
  assert.equal(framesOfType(socket, 'response.create').length, 1);
  assert.ok(harness.provider.status().budgetTokens > 0);
});
