/**
 * V02 acceptance oracle — approved speech plan → local synthesis → playback → replay/cancel while
 * the microphone keeps transcribing.
 *
 * The signed app, the bundled CPython + Pocket TTS worker and the native AVAudioEngine output need
 * Xcode, a signing identity and real hardware, so the deterministic acceptance path drives the same
 * frozen boundaries with local fakes: the real V01 input session (microphone → local ASR) from
 * `../index.js`, a push-driven synthesis worker and a fake native playback sink that reports actual
 * rendered positions. `packages/voice/src/playback/index.ts` must export:
 *
 *   createLocalPlaybackSession({ input, worker, sink, voiceId, outputFormat }) → LocalPlaybackSession
 *
 *     input — the V01 `LocalVoiceSession` (`../index.ts`). `start()`/`close()` drive it together
 *       with the output device so listening stays active while a plan is spoken.
 *     worker — the bundled Pocket TTS boundary (no network, no system Python):
 *       synthesize({ planId, segmentId, text, voiceId, epoch, signal? }) → AsyncIterable<PcmFrame>
 *       with PcmFrame = { sequence, sampleRate, channels, pcm } in the `outputFormat` below.
 *     sink — the native playback boundary, opened with `outputFormat`:
 *       open(format) / write({ epoch, planId, segmentId, sequence, sampleRate, channels, pcm }) /
 *       onProgress(({ epoch, planId, segmentId, renderedMs }) => void) / flush() / close() /
 *       isOpen(). `write` is the device queue; `onProgress` reports what the device actually
 *       rendered, so generated-but-unheard audio is never treated as heard.
 *     voiceId — the cleared voice preset the worker synthesizes with.
 *
 *     session:
 *       start()   opens the sink and starts `input` capture; listening continues while speaking.
 *       submitSpeech(plan, lease) — plan and lease come from the shared speech-lease contract
 *         (`packages/contracts/src/index.ts`, §5.3). A lease that is not approved (expired) resolves
 *         `[]` with no worker call and no audible frame. Otherwise the plan's segments are
 *         synthesized in order, returned PCM is written to the sink, and the promise resolves with
 *         one VoiceOutputEvent per segment once the plan ends: 'completed' only when the sink
 *         reported every frame of the segment rendered, 'cancelled' when the generation epoch was
 *         interrupted, with positionMs = actually rendered milliseconds.
 *       interrupt(reason) — advances the generation epoch, flushes the sink and resolves the
 *         in-flight submitSpeech. No frame of the interrupted epoch may reach the sink after
 *         interrupt() resolves, and no frame already queued for that epoch may become audible.
 *       replay(segmentId?) — replays retained audio: the given segment, or the last completed
 *         sentence when omitted. Audio that never became audible is not replayable, and replay
 *         reuses the retained PCM instead of synthesizing again.
 *       status()  → { output: idle | generating | buffering | speaking | paused | cancelled, epoch }
 *       close()   flushes and closes the sink and the input session.
 *
 * The packaging criterion is checked against the frozen artifacts instead of a live worker:
 *
 *   models/manifest.json { "assets": [ { id, kind: 'model' | 'voice', license, revision, sha256 } ] }
 *     — exactly one kind 'model' asset for Pocket TTS english_2026-04 with its CC-BY-4.0 weights
 *     license, and exactly four kind 'voice' presets (Alba, Anna, Charles, Jean) with their own
 *     licenses; every asset has a pinned source revision and a distinct 64-hex SHA-256 source hash.
 *   workers/pocket-tts/runtime.json { python: { bundled: true, path, version }, network: 'denied',
 *     dependencies: [ { name, version, sha256 } ] } — a CPython runtime that stays inside the worker
 *     directory, locked hashed dependencies and a denied network, with no system-Python or download
 *     reference anywhere in the worker sources.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createLocalVoiceSession } from '../index.js';
import type { AudioFrame, LocalAsrEngine, LocalVoiceSession, NativeAudioHost } from '../index.js';
import type { SpeechLease, SpeechPlan, VoiceOutputEvent } from '../../../contracts/src/index.js';

const OUTPUT_SAMPLE_RATE = 24_000;
const OUTPUT_CHANNELS = 1;
/** Native voice packets are 20 ms; the fake worker synthesizes in the same shape. */
const PACKET_MS = 20;
const CLEARED_VOICE_ID = 'alba';
const FUTURE_EXPIRY = '2100-01-01T00:00:00.000Z';
const EXPIRED_AT = '2001-01-01T00:00:00.000Z';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MODEL_MANIFEST_PATH = join(REPO_ROOT, 'models', 'manifest.json');
const WORKER_DIRECTORY = join(REPO_ROOT, 'workers', 'pocket-tts');
const WORKER_RUNTIME_PATH = join(WORKER_DIRECTORY, 'runtime.json');

type OutputState = 'idle' | 'generating' | 'buffering' | 'speaking' | 'paused' | 'cancelled';

type PcmFrame = Readonly<{
  sequence: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

type SynthesisRequest = Readonly<{
  planId: string;
  segmentId: string;
  text: string;
  voiceId: string;
  epoch: number;
  signal?: AbortSignal;
}>;

type SpeechSynthesisWorker = Readonly<{
  synthesize(request: SynthesisRequest): AsyncIterable<PcmFrame>;
}>;

type PlaybackFrame = Readonly<{
  epoch: number;
  planId: string;
  segmentId: string;
  sequence: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

type PlaybackProgress = Readonly<{
  epoch: number;
  planId: string;
  segmentId: string;
  renderedMs: number;
}>;

type NativePlaybackSink = Readonly<{
  open(format: Readonly<{ sampleRate: number; channels: number }>): Promise<void>;
  write(frame: PlaybackFrame): void;
  onProgress(listener: (progress: PlaybackProgress) => void): () => void;
  flush(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
}>;

type LocalPlaybackSession = Readonly<{
  start(): Promise<void>;
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
  interrupt(reason: string): Promise<void>;
  replay(segmentId?: string): Promise<void>;
  status(): Readonly<{ output: OutputState; epoch: number }>;
  close(): Promise<void>;
}>;

type LocalPlaybackSessionOptions = Readonly<{
  input: LocalVoiceSession;
  worker: SpeechSynthesisWorker;
  sink: NativePlaybackSink;
  voiceId: string;
  outputFormat: Readonly<{ sampleRate: number; channels: number }>;
}>;

type PlaybackModule = Readonly<{
  createLocalPlaybackSession(options: LocalPlaybackSessionOptions): LocalPlaybackSession;
}>;

let playbackModulePromise: Promise<PlaybackModule> | undefined;

function loadPlaybackModule(): Promise<PlaybackModule> {
  playbackModulePromise ??= (async () => {
    const fail = (detail: string): never => assert.fail(
      'V02 required playback behavior is not implemented yet: packages/voice/src/playback/index.ts '
      + 'must export createLocalPlaybackSession({ input, worker, sink, voiceId, outputFormat }). '
      + detail,
    );
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import('./index.js')) as unknown as Record<string, unknown>;
    } catch (error) {
      return fail(
        'packages/voice/src/playback/index.ts does not exist yet (it is imported here as the '
        + `TypeScript ESM specifier "./index.js"): ${(error as Error).message}`,
      );
    }
    if (typeof loaded.createLocalPlaybackSession !== 'function') {
      return fail('createLocalPlaybackSession(...) is not exported');
    }
    return loaded as unknown as PlaybackModule;
  })();
  return playbackModulePromise;
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error(`${label} did not settle within ${timeoutMs} ms`)); },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

/** Let session-side microtasks and async iterators drain before asserting on absence. */
async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

function forbidNetwork(): Readonly<{ calls: string[]; restore: () => void }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error('local speech must not reach the network');
  }) as typeof fetch;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class ForbiddenWebSocket {
    constructor() {
      calls.push('websocket');
      throw new Error('local speech must not reach the network');
    }
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
    },
  };
}

function speechPlan(
  planId: string,
  epoch: number,
  segments: ReadonlyArray<Readonly<{ id: string; text: string }>>,
): SpeechPlan {
  return {
    planId,
    epoch,
    priority: 'completion',
    expiresAt: FUTURE_EXPIRY,
    dedupeKey: `${planId}-dedupe`,
    segments: segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      evidenceIds: [`evidence-${segment.id}`],
      exact: false,
      maxSeconds: 8,
    })),
    resume: 'automatic',
  };
}

function speechLease(epoch: number, expiresAt: string): SpeechLease {
  return { eventId: `event-${epoch}`, epoch, expiresAt };
}

function synthFrames(segmentId: string, count: number): ReadonlyArray<PcmFrame> {
  const frameSamples = Math.round((OUTPUT_SAMPLE_RATE * PACKET_MS) / 1_000);
  const seed = segmentId
    .split('')
    .reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const frames: PcmFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    const pcm = new Uint8Array(frameSamples * OUTPUT_CHANNELS * 2);
    for (let sample = 0; sample < frameSamples; sample += 1) {
      const value = Math.round(1_400 * Math.sin((sample + seed + index * 11) / 6));
      pcm[sample * 2] = value & 0xff;
      pcm[sample * 2 + 1] = (value >> 8) & 0xff;
    }
    frames.push({ sequence: index, sampleRate: OUTPUT_SAMPLE_RATE, channels: OUTPUT_CHANNELS, pcm });
  }
  return frames;
}

function frameDurationMs(frame: Readonly<{ sampleRate: number; channels: number; pcm: Uint8Array }>): number {
  const samples = frame.pcm.byteLength / (frame.channels * 2);
  return (samples / frame.sampleRate) * 1_000;
}

function pcmDigest(frames: ReadonlyArray<Readonly<{ pcm: Uint8Array }>>): string {
  const total = frames.reduce((sum, frame) => sum + frame.pcm.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    merged.set(frame.pcm, offset);
    offset += frame.pcm.byteLength;
  }
  return Buffer.from(merged).toString('base64');
}

type PushStream<T> = Readonly<{
  push(value: T): void;
  end(): void;
  readonly pending: number;
  readonly iterable: AsyncIterable<T>;
}>;

function createPushStream<T>(): PushStream<T> {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let finished = false;

  const deliver = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (!waiter) return;
      if (buffer.length > 0) {
        waiters.shift();
        const value = buffer.shift();
        if (value === undefined) return;
        waiter({ value, done: false });
        continue;
      }
      if (finished) {
        waiters.shift();
        waiter({ value: undefined as never, done: true });
        continue;
      }
      return;
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: (): Promise<IteratorResult<T>> => {
          if (buffer.length > 0) {
            const value = buffer.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
          }
          if (finished) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<T>>((resolve) => { waiters.push(resolve); });
        },
        return: (): Promise<IteratorResult<T>> => {
          finished = true;
          buffer.length = 0;
          deliver();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push: (value: T): void => { buffer.push(value); deliver(); },
    end: (): void => { finished = true; deliver(); },
    get pending(): number { return buffer.length; },
  };
}

type FakeWorker = Readonly<{
  port: SpeechSynthesisWorker;
  requests: SynthesisRequest[];
  emit(segmentId: string, frames: ReadonlyArray<PcmFrame>): void;
  end(segmentId: string): void;
  hasRequest(segmentId: string): boolean;
}>;

function createFakeWorker(): FakeWorker {
  const requests: SynthesisRequest[] = [];
  const streams = new Map<string, PushStream<PcmFrame>>();
  const streamFor = (segmentId: string): PushStream<PcmFrame> => {
    const existing = streams.get(segmentId);
    if (existing) return existing;
    const created = createPushStream<PcmFrame>();
    streams.set(segmentId, created);
    return created;
  };
  return {
    port: {
      synthesize: (request) => {
        requests.push(request);
        return streamFor(request.segmentId).iterable;
      },
    },
    requests,
    emit: (segmentId, frames) => {
      const stream = streamFor(segmentId);
      for (const frame of frames) stream.push(frame);
    },
    end: (segmentId) => { streamFor(segmentId).end(); },
    hasRequest: (segmentId) => requests.some((request) => request.segmentId === segmentId),
  };
}

type FakeSink = Readonly<{
  port: NativePlaybackSink;
  writes: PlaybackFrame[];
  renders: PlaybackProgress[];
  openedFormat(): Readonly<{ sampleRate: number; channels: number }> | null;
  renderFrames(count: number): void;
  renderAll(): void;
  renderedMs(segmentId: string): number;
  writeCount(segmentId: string): number;
  pendingFrames(): number;
}>;

function createFakeSink(): FakeSink {
  const writes: PlaybackFrame[] = [];
  const renders: PlaybackProgress[] = [];
  const listeners = new Set<(progress: PlaybackProgress) => void>();
  const pending: PlaybackFrame[] = [];
  const renderedBySegment = new Map<string, number>();
  let opened: Readonly<{ sampleRate: number; channels: number }> | null = null;

  const renderFrames = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      const frame = pending.shift();
      if (!frame) return;
      const renderedMs = (renderedBySegment.get(frame.segmentId) ?? 0) + frameDurationMs(frame);
      renderedBySegment.set(frame.segmentId, renderedMs);
      const progress: PlaybackProgress = {
        epoch: frame.epoch,
        planId: frame.planId,
        segmentId: frame.segmentId,
        renderedMs,
      };
      renders.push(progress);
      for (const listener of [...listeners]) listener(progress);
    }
  };

  return {
    port: {
      open: async (format) => { opened = { sampleRate: format.sampleRate, channels: format.channels }; },
      write: (frame) => {
        assert.ok(opened !== null, 'the native playback sink must be opened before frames are written');
        writes.push({ ...frame, pcm: frame.pcm.slice() });
        pending.push({ ...frame, pcm: frame.pcm.slice() });
      },
      onProgress: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      flush: async () => { pending.length = 0; },
      close: async () => { pending.length = 0; opened = null; },
      isOpen: () => opened !== null,
    },
    writes,
    renders,
    openedFormat: () => (opened === null ? null : { ...opened }),
    renderFrames,
    renderAll: () => { renderFrames(pending.length); },
    renderedMs: (segmentId) => renderedBySegment.get(segmentId) ?? 0,
    writeCount: (segmentId) => writes.filter((frame) => frame.segmentId === segmentId).length,
    pendingFrames: () => pending.length,
  };
}

const INPUT_SAMPLE_RATE = 16_000;
const INPUT_CHANNELS = 1;
const INPUT_PACKET_MS = 20;
const INPUT_WORDS = [
  { text: 'still', startMs: 200, endMs: 520 },
  { text: 'listening', startMs: 600, endMs: 1_050 },
] as const;
const INPUT_SPEECH_END_MS = 1_100;
const INPUT_FRAMES = 100;

function inputFrameAt(index: number): AudioFrame {
  const samples = (INPUT_SAMPLE_RATE * INPUT_PACKET_MS) / 1_000;
  const pcm = new Uint8Array(samples * INPUT_CHANNELS * 2);
  const packetMidMs = index * INPUT_PACKET_MS + INPUT_PACKET_MS / 2;
  const voiced = INPUT_WORDS.some((word) => packetMidMs >= word.startMs && packetMidMs < word.endMs);
  if (voiced) {
    for (let sample = 0; sample < samples; sample += 1) {
      const value = Math.round(2_400 * Math.sin(sample / 5));
      pcm[sample * 2] = value & 0xff;
      pcm[sample * 2 + 1] = (value >> 8) & 0xff;
    }
  }
  return {
    sequence: index,
    sampleRate: INPUT_SAMPLE_RATE,
    channels: INPUT_CHANNELS,
    monotonicNs: String(BigInt(index * INPUT_PACKET_MS) * 1_000_000n),
    pcm,
  };
}

type InputHarness = Readonly<{
  session: LocalVoiceSession;
  captureActive(): boolean;
  pushUserUtterance(): Promise<void>;
}>;

/** The real V01 session (microphone → local ASR) driven by a scripted fake host and engine. */
function createInputHarness(): InputHarness {
  let onFrame: ((frame: AudioFrame) => void) | null = null;
  const host: NativeAudioHost = {
    permission: () => 'granted',
    startCapture: async (listener) => { onFrame = listener; },
    stopCapture: async () => { onFrame = null; },
    captureActive: () => onFrame !== null,
    onEvent: () => () => undefined,
  };
  const asr: LocalAsrEngine = {
    transcribe: async (window) => {
      const heardUntilMs = window.startMs
        + (window.pcm.byteLength / (window.channels * 2) / window.sampleRate) * 1_000;
      const words = INPUT_WORDS
        .filter((word) => word.startMs >= window.startMs && word.endMs <= heardUntilMs)
        .map((word) => ({
          text: word.text,
          startMs: word.startMs - window.startMs,
          endMs: word.endMs - window.startMs,
        }));
      return {
        text: words.map((word) => word.text).join(' '),
        words,
        endpoint: heardUntilMs >= INPUT_SPEECH_END_MS + 450,
      };
    },
  };
  const session = createLocalVoiceSession({ host, asr, maxQueuedFrames: INPUT_FRAMES });
  return {
    session,
    captureActive: () => onFrame !== null,
    pushUserUtterance: async () => {
      for (let index = 0; index < INPUT_FRAMES; index += 1) {
        await session.pushInput(inputFrameAt(index));
      }
    },
  };
}

async function waitForRequest(worker: FakeWorker, segmentId: string): Promise<void> {
  await waitFor(() => worker.hasRequest(segmentId), `the local worker to synthesize ${segmentId}`);
}

function completedSegmentIds(events: ReadonlyArray<VoiceOutputEvent>): string[] {
  return events.filter((event) => event.status === 'completed').map((event) => event.segmentId);
}

test('an approved plan speaks locally while the user keeps being transcribed, and the last completed sentence replays', { timeout: 20_000 }, async () => {
  const playback = await loadPlaybackModule();
  const network = forbidNetwork();
  const input = createInputHarness();
  const worker = createFakeWorker();
  const sink = createFakeSink();
  const session = playback.createLocalPlaybackSession({
    input: input.session,
    worker: worker.port,
    sink: sink.port,
    voiceId: CLEARED_VOICE_ID,
    outputFormat: { sampleRate: OUTPUT_SAMPLE_RATE, channels: OUTPUT_CHANNELS },
  });

  try {
    await within('playback start', session.start());
    assert.equal(input.captureActive(), true, 'starting the session opens the microphone graph');
    assert.equal(sink.port.isOpen(), true, 'starting the session opens the native playback sink');
    assert.deepEqual(
      sink.openedFormat(),
      { sampleRate: OUTPUT_SAMPLE_RATE, channels: OUTPUT_CHANNELS },
      'the sink is opened with the declared output format',
    );
    assert.equal(session.status().output, 'idle', 'a session with no plan has idle output');

    // An expired lease is not an approved plan: nothing may be synthesized or become audible.
    const expired = await within('expired speech lease', session.submitSpeech(
      speechPlan('plan-expired', 1, [{ id: 's-expired', text: 'This must stay silent.' }]),
      speechLease(1, EXPIRED_AT),
    ));
    await settle();
    assert.deepEqual(expired, [], 'an expired speech lease resolves with no output events');
    assert.equal(worker.requests.length, 0, 'unapproved speech must not reach the local worker');
    assert.equal(sink.writes.length, 0, 'unapproved speech must stay silent');

    const firstFrames = synthFrames('s1', 60);
    const secondFrames = synthFrames('s2', 40);
    const spoken = session.submitSpeech(
      speechPlan('plan-1', 1, [
        { id: 's1', text: 'Sentence one.' },
        { id: 's2', text: 'Sentence two.' },
      ]),
      speechLease(1, FUTURE_EXPIRY),
    );

    await waitForRequest(worker, 's1');
    worker.emit('s1', firstFrames);
    worker.end('s1');
    await waitFor(() => sink.writeCount('s1') >= firstFrames.length, 'the first sentence to reach the device');
    sink.renderFrames(20);
    await waitFor(() => session.status().output === 'speaking', 'the output state to report speaking');

    // The microphone keeps transcribing while the plan is being spoken.
    await within('input while speaking', input.pushUserUtterance(), 10_000);
    await waitFor(() => input.session.transcript().length > 0, 'a committed transcript during playback');
    assert.equal(input.captureActive(), true, 'microphone capture stays open while the plan is spoken');
    assert.notEqual(session.status().output, 'idle', 'the plan is still in flight while the user speaks');

    sink.renderAll();
    await waitForRequest(worker, 's2');
    worker.emit('s2', secondFrames);
    worker.end('s2');
    await waitFor(() => sink.writeCount('s2') >= secondFrames.length, 'the second sentence to reach the device');
    sink.renderAll();
    const events = await within('plan completion', spoken);

    assert.deepEqual(
      completedSegmentIds(events),
      ['s1', 's2'],
      'both sentences must be reported completed once the device rendered them',
    );
    for (const event of events) {
      if (event.status !== 'completed') continue;
      const expectedMs = (event.segmentId === 's1' ? firstFrames.length : secondFrames.length) * PACKET_MS;
      assert.ok(
        Math.abs(event.positionMs - expectedMs) <= 1,
        `the completed ${event.segmentId} cursor is ${event.positionMs} ms instead of the rendered ${expectedMs} ms`,
      );
    }
    assert.equal(
      sink.writes.length,
      firstFrames.length + secondFrames.length,
      'the device receives each synthesized frame exactly once',
    );
    assert.equal(
      pcmDigest(sink.writes.filter((frame) => frame.segmentId === 's1')),
      pcmDigest(firstFrames),
      'the device receives exactly the locally synthesized s1 PCM',
    );
    assert.equal(
      pcmDigest(sink.writes.filter((frame) => frame.segmentId === 's2')),
      pcmDigest(secondFrames),
      'the device receives exactly the locally synthesized s2 PCM',
    );
    assert.deepEqual(
      worker.requests.map((request) => request.text),
      ['Sentence one.', 'Sentence two.'],
      'each approved sentence is synthesized exactly once, in plan order',
    );
    assert.ok(
      worker.requests.every((request) => request.voiceId === CLEARED_VOICE_ID),
      'the worker synthesizes with the cleared voice preset',
    );

    // Replay the last completed sentence from retained audio, without synthesizing again.
    const replayMark = sink.writes.length;
    const renderedMark = sink.renders.length;
    await within('replay', session.replay());
    await settle();
    const replayed = sink.writes.slice(replayMark);
    assert.ok(replayed.length > 0, 'the last completed sentence must replay');
    assert.deepEqual(
      [...new Set(replayed.map((frame) => frame.segmentId))],
      ['s2'],
      'replay must target the last completed sentence',
    );
    assert.equal(pcmDigest(replayed), pcmDigest(secondFrames), 'replay reuses the retained PCM byte for byte');
    assert.equal(worker.requests.length, 2, 'replay must not synthesize the sentence again');
    sink.renderAll();
    assert.ok(sink.renders.length > renderedMark, 'the replayed audio must reach the device clock');

    assert.equal(
      network.calls.length,
      0,
      `offline local speech must not touch the network: ${network.calls.join(', ')}`,
    );

    await within('playback close', session.close());
    assert.equal(input.captureActive(), false, 'closing the session releases microphone capture');
  } finally {
    await session.close().catch(() => undefined);
    await input.session.close();
    network.restore();
  }
});

test('cancel flushes the device queue and silences every late frame from the cancelled epoch', { timeout: 20_000 }, async () => {
  const playback = await loadPlaybackModule();
  const input = createInputHarness();
  const worker = createFakeWorker();
  const sink = createFakeSink();
  const session = playback.createLocalPlaybackSession({
    input: input.session,
    worker: worker.port,
    sink: sink.port,
    voiceId: CLEARED_VOICE_ID,
    outputFormat: { sampleRate: OUTPUT_SAMPLE_RATE, channels: OUTPUT_CHANNELS },
  });

  try {
    await within('playback start', session.start());

    const firstFrames = synthFrames('s1', 40);
    const secondFrames = synthFrames('s2', 40);
    const spoken = session.submitSpeech(
      speechPlan('plan-1', 1, [
        { id: 's1', text: 'First sentence.' },
        { id: 's2', text: 'Second sentence.' },
      ]),
      speechLease(1, FUTURE_EXPIRY),
    );

    await waitForRequest(worker, 's1');
    worker.emit('s1', firstFrames);
    worker.end('s1');
    await waitFor(() => sink.writeCount('s1') >= firstFrames.length, 'the first sentence to reach the device');
    sink.renderAll();
    await waitFor(
      () => sink.renderedMs('s1') >= firstFrames.length * PACKET_MS,
      'the first sentence to become audible',
    );

    await waitForRequest(worker, 's2');
    worker.emit('s2', secondFrames);
    await waitFor(() => sink.writeCount('s2') >= secondFrames.length, 'the second sentence to reach the device');
    assert.equal(sink.renderedMs('s2'), 0, 'the second sentence must still be unheard when it is cancelled');

    const epochBeforeCancel = session.status().epoch;
    await within('interrupt', session.interrupt('explicit_stop'));
    const writesAfterCancel = sink.writes.length;
    const rendersAfterCancel = sink.renders.length;
    assert.ok(
      session.status().epoch > epochBeforeCancel,
      'cancel must advance the generation epoch so late frames can be recognized as stale',
    );
    assert.notEqual(session.status().output, 'speaking', 'a cancelled plan must not keep reporting active playback');
    assert.equal(sink.renderedMs('s2'), 0, 'audio queued for the cancelled sentence must be flushed, not rendered');

    // Frames the worker produces after the cancel must never become audible.
    worker.emit('s2', synthFrames('s2-late', 5).map((frame, index) => ({
      ...frame,
      sequence: secondFrames.length + index,
    })));
    await settle();
    assert.equal(
      sink.writes.length,
      writesAfterCancel,
      'no frame from a cancelled epoch may reach the device after interrupt() resolves',
    );
    sink.renderAll();
    assert.equal(
      sink.renders.slice(rendersAfterCancel).filter((progress) => progress.segmentId === 's2').length,
      0,
      'no frame from a cancelled epoch may become audible after the cancel',
    );

    const events = await within('cancelled plan', spoken);
    assert.deepEqual(
      completedSegmentIds(events),
      ['s1'],
      'only sentences the device actually rendered may be reported completed',
    );
    const cancelled = events.find((event) => event.segmentId === 's2' && event.status === 'cancelled');
    assert.ok(cancelled, 'the interrupted sentence must be reported cancelled');
    assert.equal(Math.round(cancelled.positionMs), 0, 'unheard audio must not be counted as played');

    // Cancel while listening: capture continues, replay still works, late audio stays silent.
    assert.equal(input.captureActive(), true, 'cancel must not stop microphone capture');
    await input.pushUserUtterance();
    await waitFor(() => input.session.transcript().length > 0, 'a committed transcript after the cancel');

    const replayMark = sink.writes.length;
    await within('replay last completed', session.replay());
    await settle();
    const replayed = sink.writes.slice(replayMark);
    assert.ok(replayed.length > 0, 'the last completed sentence must replay after a cancel');
    assert.deepEqual(
      [...new Set(replayed.map((frame) => frame.segmentId))],
      ['s1'],
      'replay must target the last completed sentence, not the cancelled one',
    );
    assert.equal(pcmDigest(replayed), pcmDigest(firstFrames), 'replay reuses the retained first sentence');

    const unheardMark = sink.writes.length;
    await within('replay of unheard audio', session.replay('s2'));
    await settle();
    assert.equal(sink.writes.length, unheardMark, 'audio that never became audible must not be replayable');

    // A fresh epoch speaks normally, and the cancelled epoch stays silent for good.
    const thirdFrames = synthFrames('s3', 20);
    const next = session.submitSpeech(
      speechPlan('plan-2', 2, [{ id: 's3', text: 'Third sentence.' }]),
      speechLease(2, FUTURE_EXPIRY),
    );
    await waitForRequest(worker, 's3');
    worker.emit('s3', thirdFrames);
    worker.end('s3');
    await waitFor(() => sink.writeCount('s3') >= thirdFrames.length, 'the new epoch to reach the device');
    sink.renderAll();
    const nextEvents = await within('next plan', next);
    assert.deepEqual(
      completedSegmentIds(nextEvents),
      ['s3'],
      'a fresh generation epoch must speak normally after a cancel',
    );
    assert.equal(
      sink.writeCount('s2'),
      secondFrames.length,
      'late frames from the cancelled epoch must never reach the device',
    );
    const cancelledEpochs = new Set(
      sink.writes.filter((frame) => frame.segmentId === 's2').map((frame) => frame.epoch),
    );
    const freshEpochs = new Set(
      sink.writes.filter((frame) => frame.segmentId === 's3').map((frame) => frame.epoch),
    );
    assert.equal(freshEpochs.size, 1, 'every frame of a spoken plan carries its generation epoch');
    for (const epoch of freshEpochs) {
      assert.ok(!cancelledEpochs.has(epoch), 'the new plan must use a fresh generation epoch');
    }
  } finally {
    await session.close().catch(() => undefined);
    await input.session.close();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a non-empty string`);
  const text = String(value).trim();
  assert.ok(text.length > 0, `${label} must be a non-empty string`);
  return text;
}

async function readJson(path: string, label: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    assert.fail(`${label} is required by V02 but is not present at ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    assert.fail(`${label} at ${path} is not valid JSON: ${(error as Error).message}`);
  }
  assert.ok(isRecord(parsed), `${label} at ${path} must be a JSON object`);
  return parsed;
}

const WORKER_SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.build', 'test', 'tests', 'fixture', 'fixtures',
]);
const WORKER_RUNTIME_FILE = /\.(?:py|pyi|sh|command|json|toml|cfg|ini|txt|lock)$/i;
const WORKER_EXECUTABLE_SOURCE = /\.(?:py|sh|command)$/i;
const FORBIDDEN_RUNTIME_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/(?:usr|usr\/local|opt\/homebrew)\/bin\/python[0-9.]*/i, 'a system Python path'],
  [/\benv\s+python3?\b/, 'a PATH-resolved Python shebang'],
  [/\b(?:pip3?|python3?\s+-m\s+pip)\s+install\b/, 'a runtime package install'],
];

async function listWorkerRuntimeFiles(directory: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (WORKER_SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...await listWorkerRuntimeFiles(join(directory, entry.name), relative));
    } else if (entry.isFile() && WORKER_RUNTIME_FILE.test(entry.name)) {
      files.push(relative);
    }
  }
  return files.sort();
}

test('the bundled worker needs no system Python or downloads and the model manifest carries licenses and source hashes', { timeout: 20_000 }, async () => {
  const manifest = await readJson(MODEL_MANIFEST_PATH, 'models/manifest.json (the V02 model manifest)');
  const rawAssets: unknown = manifest.assets;
  assert.ok(
    Array.isArray(rawAssets),
    'models/manifest.json must list the bundled model and voice assets under an "assets" array',
  );
  const assets = rawAssets.filter(isRecord);
  assert.equal(assets.length, rawAssets.length, 'every model-manifest asset entry must be a JSON object');
  assert.ok(
    assets.every((asset) => ['model', 'voice', 'asr', 'vad', 'reasoner', 'runtime'].includes(String(asset.kind))),
    'every asset entry must declare a known model-pack kind',
  );

  const models = assets.filter((asset) => asset.kind === 'model');
  const voices = assets.filter((asset) => asset.kind === 'voice');
  assert.equal(models.length, 1, 'the manifest must carry exactly one bundled TTS model');
  assert.equal(voices.length, 4, 'the manifest must carry the four cleared voice presets');
  const model = models[0];
  assert.ok(model, 'the bundled Pocket TTS model entry is missing');
  assert.match(
    requireText(model.id, 'the bundled model id'),
    /pocket[-_]?tts.*english[-_]2026[-_]04/i,
    'the bundled model must be Pocket TTS english_2026-04',
  );
  assert.match(
    requireText(model.license, 'the Pocket TTS model license'),
    /cc[-_ ]?by[-_ ]?4\.0/i,
    'the Pocket TTS weights are CC-BY-4.0; that license belongs in the manifest',
  );

  for (const asset of assets) {
    const id = requireText(asset.id, 'an asset id');
    requireText(asset.license, `the "${id}" license`);
    requireText(asset.revision, `the "${id}" source revision`);
    const sha256 = requireText(asset.sha256, `the "${id}" SHA-256`).toLowerCase();
    assert.match(sha256, /^[0-9a-f]{64}$/, `the "${id}" source hash must be a 64-hex SHA-256`);
    assert.ok(!/^0{64}$/.test(sha256), `the "${id}" hash is a placeholder, not a source hash`);
  }
  const ids = assets.map((asset) => String(asset.id));
  assert.equal(new Set(ids).size, ids.length, 'every bundled asset must be listed once');
  const hashes = assets.map((asset) => String(asset.sha256).toLowerCase());
  assert.equal(new Set(hashes).size, hashes.length, 'every audio/voice asset must carry its own source hash');
  for (const preset of ['alba', 'anna', 'charles', 'jean']) {
    assert.ok(
      voices.some((voice) => String(voice.id).toLowerCase().includes(preset)),
      `the cleared voice preset "${preset}" is missing from the manifest`,
    );
  }

  const runtime = await readJson(WORKER_RUNTIME_PATH, 'workers/pocket-tts/runtime.json (the worker runtime manifest)');
  const python = runtime.python;
  assert.ok(
    isRecord(python),
    'workers/pocket-tts/runtime.json must declare the worker\'s bundled "python" runtime',
  );
  assert.equal(python.bundled, true, 'the worker must bundle its own CPython instead of using the system interpreter');
  assert.match(
    requireText(python.version, 'the bundled CPython version'),
    /^3\.\d+\.\d+/,
    'the bundled CPython version must be pinned',
  );
  const interpreter = requireText(python.path, 'the bundled CPython path');
  assert.ok(
    !interpreter.startsWith('/') && !interpreter.startsWith('~') && !interpreter.split(/[\\/]/).includes('..'),
    `the bundled interpreter must live inside workers/pocket-tts/, not at "${interpreter}"`,
  );
  const network = String(runtime.network ?? '').toLowerCase();
  assert.ok(
    ['none', 'denied', 'disabled', 'offline'].includes(network) || runtime.offline === true,
    'the worker runtime manifest must deny runtime downloads and network access',
  );
  const rawDependencies: unknown = runtime.dependencies;
  assert.ok(
    Array.isArray(rawDependencies) && rawDependencies.length > 0,
    'the worker dependencies must be locked and hashed in the runtime manifest',
  );
  const dependencies = rawDependencies.filter(isRecord);
  assert.equal(dependencies.length, rawDependencies.length, 'every locked dependency entry must be a JSON object');
  for (const dependency of dependencies) {
    const name = requireText(dependency.name, 'a dependency name');
    assert.match(requireText(dependency.version, `the "${name}" version`), /^\d/, `"${name}" must pin an exact version`);
    assert.match(
      requireText(dependency.sha256, `the "${name}" SHA-256`).toLowerCase(),
      /^[0-9a-f]{64}$/,
      `"${name}" must pin the SHA-256 of its wheel or archive`,
    );
  }

  const workerFiles = await listWorkerRuntimeFiles(WORKER_DIRECTORY);
  assert.ok(
    workerFiles.length > 0,
    'workers/pocket-tts/ must contain the worker sources and its locked runtime manifest',
  );
  for (const relative of workerFiles) {
    const source = await readFile(join(WORKER_DIRECTORY, relative), 'utf8');
    for (const [pattern, reason] of FORBIDDEN_RUNTIME_PATTERNS) {
      assert.ok(
        !pattern.test(source),
        `workers/pocket-tts/${relative} references ${reason}; the bundle must not need system Python or install anything at runtime`,
      );
    }
    if (WORKER_EXECUTABLE_SOURCE.test(relative)) {
      assert.ok(
        !/https?:\/\//i.test(source),
        `workers/pocket-tts/${relative} contains a download URL; the worker must run fully offline`,
      );
    }
  }
});
