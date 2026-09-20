/**
 * V04 acceptance oracle — voice-backend half. BYOK voice → memory/tool question → interrupt →
 * bounded provider restart: the seam that binds the OpenAI Realtime provider to the shared memory
 * scope, the attention lease, the native playback graph and the local fallback.
 *
 * Criterion 1 is the only part that needs the paid service and a real audio device; it is the
 * opt-in `live:` test at the bottom (ECHOPILOT_REALTIME_LIVE=1 plus a dedicated low-cap
 * OPENAI_API_KEY). Everything decidable off-device is enforced here against an instrumented
 * provider double plus the frozen held-out fixture `fixtures/providers/v04-grounded-question.json`:
 * scoped tool calls, a granted speech lease per response, actual-playback truncation, heard markers
 * that never include generated-but-unheard narration, and local continuity announced exactly once.
 *
 * `packages/voice/src/backends/index.ts` must export:
 *
 *   REALTIME_TOOL_SCHEMAS — the premium path's read-oriented tool set (§5.5): exactly
 *     `get_context`, `search_memory`, `read_event` and `propose_action`, each with a non-empty
 *     description and a JSON-object parameter schema. It is the caller's job to hand these to
 *     `createOpenAiRealtimeProvider({ tools })`.
 *
 *   createRealtimeVoiceBackend(options) → RealtimeVoiceBackend
 *
 *     options.provider — the V04 provider client from `packages/providers/src/openai-realtime`:
 *       start(), close(), status(), onEvent(listener),
 *       admitInput(frame) → 'sent' | 'held' | 'dropped',
 *       requestResponse({ userText?, instruction? }) → 'requested' | 'withheld',
 *       sendToolResult({ generation, callId, result }) → 'sent' | 'dropped',
 *       interrupt({ generation, itemId, playedMs, reason }) → Promise<void>
 *     options.playback — the V02 native sink (`NativePlaybackSink`): what the device actually
 *       rendered, never what was generated.
 *     options.memory — the contracts `Memory.query(query, scope, budget)` boundary.
 *     options.actions — the §5.5 `propose_action` broker: propose(request) → { proposalId,
 *       summary }. It has no execute method, so a model tool call can never be direct permission.
 *     options.attention — the shared contracts `Attention`; `canSpeak(lease)` gates every response.
 *     options.scope — the memory scope every tool call is filtered to (project isolation).
 *     options.evidenceBudgetTokens — optional, ≤ 1536 (the §5.8 retrieval allocation) and > 0.
 *
 *     backend:
 *       start(): Promise<void> — starts the provider session.
 *       pushInput(frame): Promise<'sent' | 'held' | 'dropped'> — delegates to the provider.
 *       ask({ lease, question }): Promise<'requested' | 'withheld'> — manual response lease:
 *         without a granted lease no provider request is made. With one, the question is sent as
 *         the user item; a read tool call is answered with the contracts EvidenceBundle
 *         (`{ evidenceIds, summary }`) returned by `memory.query`, a `propose_action` call is
 *         answered with `{ status: 'proposed', proposalId }`, and while the lease still holds
 *         exactly one grounded continuation response is requested per read-tool round trip.
 *       interrupt(reason: 'barge_in' | 'explicit_stop'): Promise<void> — stops local playback and
 *         asks the provider to cancel and truncate at the audio that actually reached the device.
 *       heardText(): string — the exact local readback: the transcript of fully rendered narration
 *         segments, in order, and nothing that was generated but not played.
 *       status(): { backend: 'premium' | 'local'; generation; output: 'idle' | 'speaking' |
 *         'cancelled'; fallbackAnnounced: boolean }
 *       onNotice(listener) → unsubscribe; notices: { type: 'local_fallback', reason } — §V-F6
 *         local continuity is enabled by default and announced once.
 *       close(): Promise<void>
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Attention, Memory, Scope, SpeechLease } from '../../../contracts/src/index.js';
import type { AudioFrame } from '../index.js';
import type { NativePlaybackSink, PlaybackFrame, PlaybackProgress } from '../playback/index.js';

type JsonObject = Record<string, unknown>;
type ClientFrame = JsonObject & { type: string };

type ProviderSeam = typeof import('../../../providers/src/openai-realtime/index.js');
type BackendSeam = typeof import('./index.js');
type BackendLike = ReturnType<BackendSeam['createRealtimeVoiceBackend']>;

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

type ProviderEvent =
  | { type: 'session_ready'; generation: number }
  | { type: 'response_started'; generation: number; responseId: string }
  | { type: 'transcript'; generation: number; responseId: string; itemId: string; contentIndex: number; text: string }
  | {
    type: 'audio'; generation: number; responseId: string; itemId: string; contentIndex: number;
    pcm: Uint8Array; durationMs: number; sampleRate: number; channels: number;
  }
  | { type: 'tool_call'; generation: number; responseId: string; callId: string; name: string; arguments: JsonObject }
  | { type: 'response_done'; generation: number; responseId: string; transcript: string }
  | { type: 'rotated'; generation: number; reason: 'token_budget' | 'time_rotation'; handoffTokens: number }
  | { type: 'cancelled'; generation: number; reason: string };

/** The V04 provider client boundary, as pinned by the provider oracle. */
type BackendProviderPort = {
  start(): Promise<void>;
  close(): Promise<void>;
  status(): { session: string; generation: number; cancelReason: string | null };
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  admitInput(frame: AudioFrame): Promise<'sent' | 'held' | 'dropped'>;
  requestResponse(request: { userText?: string; instruction?: string }): Promise<'requested' | 'withheld'>;
  sendToolResult(request: { generation: number; callId: string; result: unknown }): Promise<'sent' | 'dropped'>;
  interrupt(request: {
    generation: number; itemId: string; playedMs: number; reason: 'barge_in' | 'explicit_stop';
  }): Promise<void>;
};

type MemoryPort = { query: Memory['query'] };

const FIXTURE_URL = new URL('../../../../fixtures/providers/v04-grounded-question.json', import.meta.url);
const PROVIDER_SAMPLE_RATE = 24_000;
const PROVIDER_CHANNELS = 1;

let backendSeamPromise: Promise<BackendSeam> | null = null;
let providerSeamPromise: Promise<ProviderSeam> | null = null;

/** Loaded lazily so the red baseline names the missing capability instead of crashing on import. */
async function backendModule(): Promise<BackendSeam> {
  backendSeamPromise ??= import('./index.js').catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'V04 voice-backend seam missing: packages/voice/src/backends/index.ts must export '
      + `REALTIME_TOOL_SCHEMAS and createRealtimeVoiceBackend (${detail})`,
    );
  });
  return backendSeamPromise;
}

async function providerModule(): Promise<ProviderSeam> {
  providerSeamPromise ??= import('../../../providers/src/openai-realtime/index.js').catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'V04 provider seam missing: packages/providers/src/openai-realtime/index.ts must export '
      + `OPENAI_REALTIME_MANIFEST and createOpenAiRealtimeProvider (${detail})`,
    );
  });
  return providerSeamPromise;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

type GroundedFixture = {
  scope: Scope;
  question: string;
  tool: string;
  tool_arguments: { query: string };
  evidence: Array<{ evidenceId: string; text: string }>;
  evidence_summary: string;
  grounded_fact: string;
  answer_segments: Array<{ text: string; durationMs: number }>;
};

async function groundedFixture(): Promise<GroundedFixture> {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as GroundedFixture;
}

function providerPcm(durationMs: number, fill = 0): Uint8Array {
  return new Uint8Array(Math.round((durationMs * PROVIDER_SAMPLE_RATE * PROVIDER_CHANNELS * 2) / 1_000)).fill(fill);
}

/**
 * One provider answer as the wire delivers it: a transcript delta and its audio delta per segment,
 * with a scheduling turn between segments so the device-open of the first frame cannot reorder the
 * stream the way a single synchronous burst would.
 */
async function emitAnswer(provider: FakeProvider, fixture: GroundedFixture, responseId: string): Promise<void> {
  provider.emit({ type: 'response_started', generation: 1, responseId });
  for (const [index, segment] of fixture.answer_segments.entries()) {
    provider.emit({
      type: 'transcript',
      generation: 1,
      responseId,
      itemId: 'item-1',
      contentIndex: index,
      text: segment.text,
    });
    provider.emit({
      type: 'audio',
      generation: 1,
      responseId,
      itemId: 'item-1',
      contentIndex: index,
      pcm: providerPcm(segment.durationMs, index + 1),
      durationMs: segment.durationMs,
      sampleRate: PROVIDER_SAMPLE_RATE,
      channels: PROVIDER_CHANNELS,
    });
    await flush();
  }
}

function frameDurationMs(frame: PlaybackFrame): number {
  return (frame.pcm.byteLength / (frame.channels * 2) / frame.sampleRate) * 1_000;
}

class FakeProvider implements BackendProviderPort {
  session = 'ready';
  generation = 1;
  cancelReason: string | null = null;
  admitResult: 'sent' | 'held' | 'dropped' = 'sent';
  requestResult: 'requested' | 'withheld' = 'requested';
  readonly calls: Array<{ method: string; request?: unknown }> = [];
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];

  async start(): Promise<void> {
    this.calls.push({ method: 'start' });
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close' });
  }

  status(): { session: string; generation: number; cancelReason: string | null } {
    return { session: this.session, generation: this.generation, cancelReason: this.cancelReason };
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  async admitInput(frame: AudioFrame): Promise<'sent' | 'held' | 'dropped'> {
    this.calls.push({ method: 'admitInput', request: frame });
    return this.admitResult;
  }

  async requestResponse(request: { userText?: string; instruction?: string }): Promise<'requested' | 'withheld'> {
    this.calls.push({ method: 'requestResponse', request });
    return this.requestResult;
  }

  async sendToolResult(request: { generation: number; callId: string; result: unknown }): Promise<'sent' | 'dropped'> {
    this.calls.push({ method: 'sendToolResult', request });
    return 'sent';
  }

  async interrupt(request: {
    generation: number; itemId: string; playedMs: number; reason: 'barge_in' | 'explicit_stop';
  }): Promise<void> {
    this.calls.push({ method: 'interrupt', request });
  }

  emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  requests(method: string): Array<{ method: string; request?: unknown }> {
    return this.calls.filter((call) => call.method === method);
  }
}

class FakeSink implements NativePlaybackSink {
  readonly written: PlaybackFrame[] = [];
  openCalls = 0;
  flushCalls = 0;
  closeCalls = 0;
  private opened = false;
  private readonly progressListeners: Array<(progress: PlaybackProgress) => void> = [];

  async open(): Promise<void> {
    this.openCalls += 1;
    this.opened = true;
  }

  write(frame: PlaybackFrame): void {
    this.written.push(frame);
  }

  onProgress(listener: (progress: PlaybackProgress) => void): () => void {
    this.progressListeners.push(listener);
    return () => undefined;
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.opened = false;
  }

  isOpen(): boolean {
    return this.opened;
  }

  render(frame: PlaybackFrame, renderedMs: number): void {
    for (const listener of [...this.progressListeners]) {
      listener({ epoch: frame.epoch, planId: frame.planId, segmentId: frame.segmentId, renderedMs });
    }
  }

  renderAll(): void {
    for (const frame of this.written) this.render(frame, frameDurationMs(frame));
  }
}

class FakeAttention implements Attention {
  allowed = true;
  private epoch = 1;

  requestSpeech(eventId: string, expiresAt: string): SpeechLease | null {
    this.epoch += 1;
    return { eventId, epoch: this.epoch, expiresAt };
  }

  canSpeak(): boolean {
    return this.allowed;
  }

  revokeSpeech(_reason?: string): void {
    this.allowed = false;
  }
}

class FakeMemory implements MemoryPort {
  readonly queries: Array<{ query: string; scope: Scope; budget: number }> = [];

  constructor(private readonly fixture: GroundedFixture) {}

  async query(query: string, scope: Scope, budget: number): Promise<{ evidenceIds: readonly string[]; summary: string }> {
    this.queries.push({ query, scope, budget });
    return {
      evidenceIds: this.fixture.evidence.map((entry) => entry.evidenceId),
      summary: this.fixture.evidence_summary,
    };
  }
}

class FakeActions {
  readonly proposals: JsonObject[] = [];
  executions = 0;

  async propose(request: JsonObject): Promise<{ proposalId: string; summary: string }> {
    this.proposals.push(request);
    return { proposalId: 'prop-v04-1', summary: 'Broker proposal: restart the parser session after confirmation.' };
  }
}

type BackendHarness = Readonly<{
  backend: BackendLike;
  provider: FakeProvider;
  sink: FakeSink;
  memory: FakeMemory;
  actions: FakeActions;
  attention: FakeAttention;
  notices: unknown[];
}>;

async function createBackend(fixture: GroundedFixture): Promise<BackendHarness> {
  const seam = await backendModule();
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const memory = new FakeMemory(fixture);
  const actions = new FakeActions();
  const attention = new FakeAttention();
  const notices: unknown[] = [];
  const backend = seam.createRealtimeVoiceBackend({
    provider,
    playback: sink,
    memory,
    actions,
    attention,
    scope: fixture.scope,
  });
  backend.onNotice((notice) => { notices.push(notice); });
  return { backend, provider, sink, memory, actions, attention, notices };
}

test('a memory/tool question is answered from scoped evidence while a lease is granted', async () => {
  const fixture = await groundedFixture();
  const harness = await createBackend(fixture);
  await harness.backend.start();
  assert.equal(harness.provider.requests('start').length, 1);

  const lease = harness.attention.requestSpeech('evt-v04-1', '2026-09-13T10:05:00.000Z');
  assert.ok(lease);
  assert.equal(await harness.backend.ask({ lease, question: fixture.question }), 'requested');
  const started = harness.provider.requests('requestResponse');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]?.request, { userText: fixture.question });
  assert.equal(harness.memory.queries.length, 0, 'no memory is read before the model asks for it');

  harness.provider.emit({
    type: 'tool_call',
    generation: 1,
    responseId: 'resp-1',
    callId: 'call-1',
    name: fixture.tool,
    arguments: fixture.tool_arguments,
  });
  await flush();

  assert.equal(harness.memory.queries.length, 1);
  assert.equal(harness.memory.queries[0]?.query, fixture.tool_arguments.query);
  assert.deepEqual(harness.memory.queries[0]?.scope, fixture.scope, 'tool reads stay inside the session scope');
  const budget = harness.memory.queries[0]?.budget ?? 0;
  assert.ok(budget > 0 && budget <= 1_536, `retrieval stays inside the §5.8 evidence allocation, saw ${budget}`);

  const toolResults = harness.provider.requests('sendToolResult');
  assert.equal(toolResults.length, 1);
  const result = toolResults[0]?.request as {
    generation: number; callId: string; result: { evidenceIds?: readonly string[]; summary?: string };
  };
  assert.equal(result.generation, 1);
  assert.equal(result.callId, 'call-1');
  assert.deepEqual([...(result.result.evidenceIds ?? [])], fixture.evidence.map((entry) => entry.evidenceId));
  assert.equal(result.result.summary, fixture.evidence_summary);

  const continuations = harness.provider.requests('requestResponse');
  assert.equal(continuations.length, 2, 'one continuation response per answered tool call');
  const instruction = (continuations[1]?.request as { instruction?: string }).instruction ?? '';
  assert.ok(instruction.trim().length > 0, 'the continuation carries the grounded answer instruction');

  await emitAnswer(harness.provider, fixture, 'resp-2');
  harness.provider.emit({
    type: 'response_done',
    generation: 1,
    responseId: 'resp-2',
    transcript: fixture.answer_segments.map((segment) => segment.text).join(''),
  });
  await flush();

  assert.equal(harness.sink.written.length, fixture.answer_segments.length);
  assert.equal(harness.sink.openCalls, 1, 'the device is opened once for the provider stream');
  assert.equal(
    harness.sink.written[0]?.sampleRate,
    PROVIDER_SAMPLE_RATE,
    'provider audio reaches the sink in the negotiated format',
  );
  harness.sink.renderAll();
  await flush();
  assert.ok(
    harness.backend.heardText().includes(fixture.grounded_fact),
    `the grounded answer reached the device: ${harness.backend.heardText()}`,
  );
  assert.equal(harness.backend.status().output, 'idle');
  assert.equal(harness.backend.status().backend, 'premium');

  // Without a granted lease nothing is sent to the provider.
  harness.attention.revokeSpeech('microphone muted');
  const denied = harness.attention.requestSpeech('evt-v04-2', '2026-09-13T10:06:00.000Z');
  assert.ok(denied);
  assert.equal(await harness.backend.ask({ lease: denied, question: 'and again?' }), 'withheld');
  assert.equal(harness.provider.requests('requestResponse').length, 2);

  // A lease revoked mid-turn still answers the tool call, but never starts a new response.
  harness.attention.allowed = true;
  const third = harness.attention.requestSpeech('evt-v04-3', '2026-09-13T10:07:00.000Z');
  assert.ok(third);
  assert.equal(await harness.backend.ask({ lease: third, question: 'summarize that decision' }), 'requested');
  const beforeToolCall = harness.provider.requests('requestResponse').length;
  harness.attention.revokeSpeech('user interrupted');
  harness.provider.emit({
    type: 'tool_call',
    generation: 1,
    responseId: 'resp-3',
    callId: 'call-2',
    name: fixture.tool,
    arguments: fixture.tool_arguments,
  });
  await flush();
  assert.equal(harness.provider.requests('sendToolResult').length, 2, 'the tool call is still answered');
  assert.equal(
    harness.provider.requests('requestResponse').length,
    beforeToolCall,
    'a revoked speech lease never creates another provider response',
  );
});

test('barge-in truncates at the actually rendered audio and never marks unheard narration as heard', async () => {
  const fixture = await groundedFixture();
  const harness = await createBackend(fixture);
  await harness.backend.start();
  const lease = harness.attention.requestSpeech('evt-v04-barge-in', '2026-09-13T10:05:00.000Z');
  assert.ok(lease);
  assert.equal(await harness.backend.ask({ lease, question: fixture.question }), 'requested');

  await emitAnswer(harness.provider, fixture, 'resp-1');
  assert.equal(harness.sink.written.length, fixture.answer_segments.length);
  assert.deepEqual(
    harness.sink.written.map((frame) => frame.segmentId),
    ['item-1:0', 'item-1:1', 'item-1:2', 'item-1:3'],
    'provider audio reaches the device in stream order',
  );
  assert.equal(harness.backend.status().output, 'speaking');

  const segments = fixture.answer_segments;
  const first = harness.sink.written[0];
  const second = harness.sink.written[1];
  const third = harness.sink.written[2];
  assert.ok(first && second && third);
  harness.sink.render(first, segments[0]?.durationMs ?? 0);
  harness.sink.render(second, segments[1]?.durationMs ?? 0);
  harness.sink.render(third, 150);
  await flush();

  await harness.backend.interrupt('barge_in');
  const interruptions = harness.provider.requests('interrupt');
  assert.equal(interruptions.length, 1);
  assert.deepEqual(interruptions[0]?.request, {
    generation: 1,
    itemId: 'item-1',
    playedMs: 950,
    reason: 'barge_in',
  });
  assert.equal(harness.sink.flushCalls, 1, 'local playback is flushed on barge-in');

  const heard = harness.backend.heardText();
  assert.equal(heard, `${segments[0]?.text ?? ''}${segments[1]?.text ?? ''}`);
  assert.ok(!heard.includes('It was reconfirmed'), 'a partially rendered segment is not heard');
  assert.ok(!heard.includes('Nothing else is pending'), 'generated-but-unheard narration is never marked as heard');

  harness.provider.emit({
    type: 'audio',
    generation: 1,
    responseId: 'resp-1',
    itemId: 'item-1',
    contentIndex: 3,
    pcm: providerPcm(400, 9),
    durationMs: 400,
    sampleRate: PROVIDER_SAMPLE_RATE,
    channels: PROVIDER_CHANNELS,
  });
  await flush();
  assert.equal(harness.sink.written.length, segments.length, 'late audio from the cancelled response is dropped');
  assert.equal(harness.backend.heardText(), heard);
  assert.equal(harness.backend.status().output, 'cancelled');
});

test('provider cancellation falls back to local continuity once and keeps unheard audio unheard', async () => {
  const fixture = await groundedFixture();
  const harness = await createBackend(fixture);
  await harness.backend.start();
  const lease = harness.attention.requestSpeech('evt-v04-fallback', '2026-09-13T10:05:00.000Z');
  assert.ok(lease);
  assert.equal(await harness.backend.ask({ lease, question: fixture.question }), 'requested');
  assert.equal(await harness.backend.pushInput(providerFrame()), 'sent', 'input is delegated to the provider');

  const first = fixture.answer_segments[0];
  assert.ok(first);
  harness.provider.emit({
    type: 'transcript',
    generation: 1,
    responseId: 'resp-1',
    itemId: 'item-1',
    contentIndex: 0,
    text: first.text,
  });
  harness.provider.emit({
    type: 'audio',
    generation: 1,
    responseId: 'resp-1',
    itemId: 'item-1',
    contentIndex: 0,
    pcm: providerPcm(first.durationMs, 4),
    durationMs: first.durationMs,
    sampleRate: PROVIDER_SAMPLE_RATE,
    channels: PROVIDER_CHANNELS,
  });
  await flush();
  harness.sink.renderAll();
  const heard = harness.backend.heardText();
  assert.ok(heard.includes(first.text.trim()));

  harness.provider.emit({ type: 'cancelled', generation: 1, reason: 'network_loss' });
  await flush();
  assert.equal(harness.backend.status().backend, 'local');
  assert.equal(harness.backend.status().fallbackAnnounced, true);
  assert.equal(harness.notices.length, 1);
  assert.equal((harness.notices[0] as { type?: string }).type, 'local_fallback');
  assert.equal((harness.notices[0] as { reason?: string }).reason, 'network_loss');
  assert.equal(harness.sink.closeCalls, 0, 'local continuity keeps the audio device open');
  assert.ok(harness.sink.flushCalls >= 1, 'cancelled narration is flushed');

  harness.provider.emit({ type: 'cancelled', generation: 1, reason: 'key_revoked' });
  await flush();
  assert.equal(harness.notices.length, 1, 'local continuity is announced exactly once');

  harness.provider.admitResult = 'dropped';
  assert.equal(await harness.backend.pushInput(providerFrame()), 'dropped');
  assert.equal(harness.sink.written.length, 1, 'no audio reaches the device after cancellation');
  assert.equal(harness.backend.heardText(), heard, 'cancelled narration is never retained as heard');
});

test('the premium tool set is read-oriented and propose_action yields a broker proposal', async () => {
  const { REALTIME_TOOL_SCHEMAS } = await backendModule();
  assert.deepEqual(
    REALTIME_TOOL_SCHEMAS.map((schema) => schema.name).sort(),
    ['get_context', 'propose_action', 'read_event', 'search_memory'],
  );
  for (const schema of REALTIME_TOOL_SCHEMAS) {
    assert.ok(schema.description.trim().length > 0, `${schema.name} needs a description`);
    assert.equal((schema.parameters as { type?: unknown }).type, 'object', `${schema.name} needs an object schema`);
  }

  const fixture = await groundedFixture();
  const harness = await createBackend(fixture);
  await harness.backend.start();
  const lease = harness.attention.requestSpeech('evt-v04-proposal', '2026-09-13T10:05:00.000Z');
  assert.ok(lease);
  assert.equal(await harness.backend.ask({ lease, question: 'restart the parser agent' }), 'requested');

  harness.provider.emit({
    type: 'tool_call',
    generation: 1,
    responseId: 'resp-1',
    callId: 'call-propose',
    name: 'propose_action',
    arguments: { action: 'restart', target: 'parser' },
  });
  await flush();

  assert.equal(harness.actions.proposals.length, 1);
  assert.deepEqual(harness.actions.proposals[0], { action: 'restart', target: 'parser' });
  const results = harness.provider.requests('sendToolResult');
  assert.equal(results.length, 1);
  const result = (results[0]?.request as { result?: JsonObject }).result ?? {};
  assert.equal(result.status, 'proposed');
  assert.equal(result.proposalId, 'prop-v04-1');
  assert.notEqual(result.executed, true, 'a model tool call is never direct permission');
  assert.equal(harness.actions.executions, 0);
});

function providerFrame(): AudioFrame {
  return {
    sequence: 0,
    sampleRate: 16_000,
    channels: 1,
    monotonicNs: '0',
    pcm: new Uint8Array(320),
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number, describe: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
  }
  assert.ok(condition(), `timed out after ${timeoutMs} ms waiting for ${describe}`);
}

class LiveSink implements NativePlaybackSink {
  readonly frames: PlaybackFrame[] = [];
  openCalls = 0;
  flushCalls = 0;
  closeCalls = 0;
  frozenMs: number | null = null;
  private opened = false;
  private queuedMs = 0;
  private readonly rendered = new Map<string, number>();
  private readonly durations = new Map<string, number>();
  private readonly progressListeners: Array<(progress: PlaybackProgress) => void> = [];
  private readonly timers: Array<NodeJS.Timeout> = [];

  async open(): Promise<void> {
    this.openCalls += 1;
    this.opened = true;
  }

  write(frame: PlaybackFrame): void {
    this.frames.push(frame);
    const durationMs = frameDurationMs(frame);
    const offsetMs = this.queuedMs;
    this.queuedMs += durationMs;
    this.durations.set(frame.segmentId, durationMs);
    this.timers.push(setTimeout(() => {
      this.rendered.set(frame.segmentId, durationMs);
      for (const listener of [...this.progressListeners]) {
        listener({ epoch: frame.epoch, planId: frame.planId, segmentId: frame.segmentId, renderedMs: durationMs });
      }
    }, offsetMs + durationMs));
  }

  onProgress(listener: (progress: PlaybackProgress) => void): () => void {
    this.progressListeners.push(listener);
    return () => undefined;
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
    this.frozenMs = this.fullyRenderedMs();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.opened = false;
    for (const timer of this.timers) clearTimeout(timer);
  }

  isOpen(): boolean {
    return this.opened;
  }

  fullyRenderedMs(): number {
    let total = 0;
    for (const [segmentId, renderedMs] of this.rendered) {
      if (renderedMs >= (this.durations.get(segmentId) ?? 0)) total += renderedMs;
    }
    return total;
  }
}

const LIVE_ENABLED = process.env.ECHOPILOT_REALTIME_LIVE === '1'
  && typeof process.env.OPENAI_API_KEY === 'string'
  && process.env.OPENAI_API_KEY.length > 0;

test(
  'live: the paid BYOK session answers a grounded question and truncates at the barge-in point',
  { skip: LIVE_ENABLED ? false : 'opt-in: set ECHOPILOT_REALTIME_LIVE=1 and OPENAI_API_KEY (dedicated low-cap key)' },
  async () => {
    const providerSeam = await providerModule();
    const backendSeam = await backendModule();
    const fixture = await groundedFixture();
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const frames: ClientFrame[] = [];
    const realTransport = providerSeam.createRealtimeWebSocketTransport();
    const transport: RealtimeTransportLike = (request) => {
      const socket = realTransport(request);
      return {
        send(data: string): void {
          frames.push(JSON.parse(data) as ClientFrame);
          socket.send(data);
        },
        close(code?: number, reason?: string): void { socket.close(code, reason); },
        onOpen(listener: () => void): () => void { return socket.onOpen(listener); },
        onMessage(listener: (data: string) => void): () => void { return socket.onMessage(listener); },
        onClose(listener: (event: { code: number; reason: string }) => void): () => void { return socket.onClose(listener); },
      };
    };
    const provider = providerSeam.createOpenAiRealtimeProvider({
      transport,
      clock: { now: () => Date.now() },
      tokenizer: { count: (text: string) => Math.max(1, Math.ceil(text.length / 4)) },
      model: {
        modelId: providerSeam.OPENAI_REALTIME_MANIFEST.model,
        contextCapacity: providerSeam.OPENAI_REALTIME_MANIFEST.contextCapacity,
      },
      policy: {
        apiKey: async () => apiKey,
        authorize: async () => ({ status: 'granted' as const }),
        onSuspend: () => () => undefined,
      },
      cost: { capMicroUsd: 200_000, priceMicroUsdPerToken: { textInput: 1, audioInput: 5, output: 2 } },
      handoff: async () => 'Live opt-in handoff: one grounded question about the desktop auth decision.',
      tools: backendSeam.REALTIME_TOOL_SCHEMAS,
      audioTokensPerSecond: 25,
    });
    const sink = new LiveSink();
    const memory = new FakeMemory(fixture);
    const attention = new FakeAttention();
    const backend = backendSeam.createRealtimeVoiceBackend({
      provider,
      playback: sink,
      memory,
      actions: new FakeActions(),
      attention,
      scope: fixture.scope,
    });
    try {
      await backend.start();
      const groundedLease = attention.requestSpeech('evt-v04-live-1', new Date(Date.now() + 60_000).toISOString());
      assert.ok(groundedLease);
      assert.equal(await backend.ask({ lease: groundedLease, question: fixture.question }), 'requested');
      await waitFor(
        () => backend.heardText().includes(fixture.grounded_fact),
        60_000,
        `the grounded answer (memory evidence ${fixture.evidence.map((entry) => entry.evidenceId).join(', ')})`,
      );
      assert.ok(
        frames.some((frame) => frame.type === 'conversation.item.create' && JSON.stringify(frame).includes('ev-v04-1')),
        'the scoped memory evidence reached the provider as a function_call_output',
      );

      const bargeInLease = attention.requestSpeech('evt-v04-live-2', new Date(Date.now() + 60_000).toISOString());
      assert.ok(bargeInLease);
      assert.equal(
        await backend.ask({ lease: bargeInLease, question: 'Please describe that auth decision again in a longer sentence.' }),
        'requested',
      );
      await waitFor(() => sink.fullyRenderedMs() > 0, 60_000, 'playback of the second answer');
      const heardBeforeBargeIn = backend.heardText();
      await backend.interrupt('barge_in');
      const truncations = frames.filter((frame) => frame.type === 'conversation.item.truncate');
      assert.equal(truncations.length, 1, 'the barge-in truncates the provider item');
      const playedMs = Number(truncations[0]?.audio_end_ms);
      assert.ok(playedMs > 0, 'truncation uses the audio that actually reached the device');
      assert.ok(
        Math.abs(playedMs - (sink.frozenMs ?? 0)) <= 50,
        `truncation at ${playedMs} ms matches actual playback ${String(sink.frozenMs)} ms`,
      );
      assert.ok(
        frames.some((frame) => frame.type === 'response.cancel'),
        'barge-in cancels the provider response',
      );
      await new Promise<void>((resolve) => { setTimeout(resolve, 1_000); });
      assert.equal(backend.heardText(), heardBeforeBargeIn, 'unheard narration is never retained as heard');
    } finally {
      await backend.close();
    }
  },
);
