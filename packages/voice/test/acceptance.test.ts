/**
 * V01 acceptance test — initial voice tracer bullet:
 * Speak → native audio → local ASR → widget transcript → mute.
 *
 * The signed native helper needs Xcode, a signing identity, and a real microphone prompt, so the
 * deterministic acceptance path drives the TypeScript tracer through the fake native host
 * contract ("use the fake host contract for TS unit work"); the signed helper feeds the same
 * shapes in the app. `packages/voice/src/index.ts` must export:
 *
 *   ASR_MAX_WINDOW_MS = 15_000
 *     Hard bound for one local ASR window (plan §5.5: "maximum 15-second rolling window with
 *     1-second overlap, committing stable prefixes").
 *
 *   createLocalVoiceSession({ host, asr, maxQueuedFrames }) → LocalVoiceSession
 *
 *     host — the native audio boundary:
 *       permission()          → 'granted' | 'denied' | 'unknown'
 *       startCapture(onFrame) → Promise<void>; opens the microphone graph
 *       stopCapture()         → Promise<void>; releases the device (mute must call it)
 *       captureActive()       → boolean
 *       onEvent(listener)     → unsubscribe; reports permission_denied | device_removed |
 *                               system_locked | helper_crash
 *
 *     asr — local Silero VAD + WhisperKit small.en stand-in:
 *       transcribe({ utteranceId, startMs, sampleRate, channels, pcm })
 *         → { text, words: [{ text, startMs, endMs }], endpoint }
 *       `startMs` and every returned word time are milliseconds relative to the start of the
 *       window. The engine reports only words it has fully heard and sets `endpoint` when the
 *       window ends with at least 450 ms of trailing silence.
 *
 *     maxQueuedFrames — the bounded transport ring. While the consumer stalls, overflow must drop
 *       audio, increment `discontinuityCount`, and reset the affected ASR state; the pipeline
 *       must never hold more than this many packets.
 *
 *     session:
 *       start()     resolves even when the microphone is denied or the helper is broken; the
 *                   condition is reported through status() instead of thrown. A denied
 *                   microphone never opens capture and leaves input at 'closed'; an accepted
 *                   session reaches 'listening'.
 *       pushInput() accepts one native PCM packet and does not wait on the ASR consumer.
 *       mute()      stops native capture, drops queued and pending audio, and clears partial text.
 *       status()    → { input, microphone, error, queuedFrames, discontinuityCount }
 *                     input ∈ closed | listening | speech_candidate | utterance_open |
 *                             committing | muted
 *                     queuedFrames counts PCM packets still waiting for the ASR consumer
 *                     error = { code: mic_denied | device_removed | locked | helper_crash,
 *                               message: string }; a terminal host failure closes capture and
 *                               keeps the state visible without blocking later calls.
 *       subscribe() → display updates; `partial` updates are display-only and only `final`
 *                     updates are committed (judgment: never route partial text).
 *       transcript() → committed utterances whose word timestamps are relative to the start of
 *                     the utterance, not to an individual ASR window.
 *       close()     releases capture and settles without leaving work behind.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/** Two seconds of 20 ms packets — the bounded transport ring from plan §5.3. */
const MAX_QUEUED_FRAMES = 100;
/** Plan §5.5: endpoint after 450 ms of silence. */
const ENDPOINT_SILENCE_MS = 450;
/** Word timestamps are computed from native monotonic clocks, so allow a small quantization. */
const TIMESTAMP_TOLERANCE_MS = 250;
const BASE_MONOTONIC_NS = 4_000_000_000n;
const FIXTURE_DIR = new URL('../../../fixtures/audio/', import.meta.url);

type WordTimestamp = Readonly<{ text: string; startMs: number; endMs: number }>;

type AudioFixture = Readonly<{
  id: string;
  sampleRate: number;
  channels: number;
  packetMs: number;
  durationMs: number;
  /** End of speech; the trailing silence after this point closes the utterance. */
  speechEndMs: number;
  words: ReadonlyArray<WordTimestamp>;
}>;

/** The frozen `VoiceSession.pushInput` frame shape. */
type AudioFrame = Readonly<{
  sequence: number;
  sampleRate: number;
  channels: number;
  monotonicNs: string;
  pcm: Uint8Array;
}>;

type TranscriptUpdate = Readonly<{
  phase: 'partial' | 'final';
  utteranceId: string;
  text: string;
  words: ReadonlyArray<WordTimestamp>;
}>;

type CommittedUtterance = Readonly<{
  utteranceId: string;
  text: string;
  words: ReadonlyArray<WordTimestamp>;
}>;

type VoiceErrorCode = 'mic_denied' | 'device_removed' | 'locked' | 'helper_crash';

type VoiceStatus = Readonly<{
  input: 'closed' | 'listening' | 'speech_candidate' | 'utterance_open' | 'committing' | 'muted';
  microphone: 'granted' | 'denied' | 'unknown';
  error: Readonly<{ code: VoiceErrorCode; message: string }> | null;
  queuedFrames: number;
  discontinuityCount: number;
}>;

type LocalAsrWindow = Readonly<{
  utteranceId: string;
  startMs: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

type LocalAsrResult = Readonly<{
  text: string;
  words: ReadonlyArray<WordTimestamp>;
  endpoint: boolean;
}>;

type LocalAsrEngine = Readonly<{
  transcribe(window: LocalAsrWindow): Promise<LocalAsrResult>;
}>;

type AudioHostEvent =
  | Readonly<{ type: 'permission_denied' }>
  | Readonly<{ type: 'device_removed'; deviceId: string }>
  | Readonly<{ type: 'system_locked' }>
  | Readonly<{ type: 'helper_crash' }>;

type NativeAudioHost = Readonly<{
  permission(): 'granted' | 'denied' | 'unknown';
  startCapture(onFrame: (frame: AudioFrame) => void): Promise<void>;
  stopCapture(): Promise<void>;
  captureActive(): boolean;
  onEvent(listener: (event: AudioHostEvent) => void): () => void;
}>;

type LocalVoiceSession = Readonly<{
  start(): Promise<void>;
  pushInput(frame: AudioFrame): Promise<void>;
  mute(): Promise<void>;
  status(): VoiceStatus;
  subscribe(listener: (update: TranscriptUpdate) => void): () => void;
  transcript(): ReadonlyArray<CommittedUtterance>;
  close(): Promise<void>;
}>;

type VoiceModule = Readonly<{
  ASR_MAX_WINDOW_MS: number;
  createLocalVoiceSession(options: Readonly<{
    host: NativeAudioHost;
    asr: LocalAsrEngine;
    maxQueuedFrames: number;
  }>): LocalVoiceSession;
}>;

let voiceModulePromise: Promise<VoiceModule> | undefined;

function loadVoiceModule(): Promise<VoiceModule> {
  voiceModulePromise ??= (async () => {
    const fail = (detail: string): never => assert.fail(
      'V01 required voice behavior is not implemented yet: packages/voice/src/index.ts must export '
      + `ASR_MAX_WINDOW_MS and createLocalVoiceSession({ host, asr, maxQueuedFrames }). ${detail}`,
    );
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import('../src/index.js')) as unknown as Record<string, unknown>;
    } catch (error) {
      return fail(`importing ../src/index.js failed: ${(error as Error).message}`);
    }
    if (typeof loaded.ASR_MAX_WINDOW_MS !== 'number') return fail('ASR_MAX_WINDOW_MS is not exported');
    if (typeof loaded.createLocalVoiceSession !== 'function') {
      return fail('createLocalVoiceSession(...) is not exported');
    }
    return loaded as unknown as VoiceModule;
  })();
  return voiceModulePromise;
}

const voice = await loadVoiceModule();

async function loadFixture(fileName: string): Promise<AudioFixture> {
  const fixture = JSON.parse(
    await readFile(new URL(fileName, FIXTURE_DIR), 'utf8'),
  ) as AudioFixture;
  assert.ok(fixture.words.length > 0, `${fileName} must carry a word timeline`);
  assert.equal(fixture.sampleRate, 16_000, `${fileName} must carry the 16 kHz ASR rate`);
  assert.equal(fixture.channels, 1, `${fileName} must be mono`);
  return fixture;
}

const utteranceFixture = await loadFixture('v01-utterance-15s.json');
const continuousFixture = await loadFixture('v01-continuous-18s.json');

function expectedText(fixture: AudioFixture): string {
  return fixture.words.map((word) => word.text).join(' ');
}

function frameAt(fixture: AudioFixture, index: number): AudioFrame {
  const samplesPerPacket = (fixture.sampleRate * fixture.packetMs) / 1_000;
  const pcm = new Uint8Array(samplesPerPacket * fixture.channels * 2);
  const packetMidMs = index * fixture.packetMs + fixture.packetMs / 2;
  const voiced = fixture.words.some((word) => packetMidMs >= word.startMs && packetMidMs < word.endMs);
  if (voiced) {
    for (let sample = 0; sample < samplesPerPacket; sample += 1) {
      const value = Math.round(2_400 * Math.sin(sample / 5));
      pcm[sample * 2] = value & 0xff;
      pcm[sample * 2 + 1] = (value >> 8) & 0xff;
    }
  }
  return {
    sequence: index,
    sampleRate: fixture.sampleRate,
    channels: fixture.channels,
    monotonicNs: (BASE_MONOTONIC_NS + BigInt(index * fixture.packetMs) * 1_000_000n).toString(),
    pcm,
  };
}

function* framesFor(
  fixture: AudioFixture,
  fromMs = 0,
  toMs: number = fixture.durationMs,
): Generator<AudioFrame> {
  const first = Math.ceil(fromMs / fixture.packetMs);
  const last = Math.ceil(toMs / fixture.packetMs);
  for (let index = first; index < last; index += 1) yield frameAt(fixture, index);
}

function packetDurationMs(window: LocalAsrWindow): number {
  return (window.pcm.byteLength / (window.channels * 2)) / window.sampleRate * 1_000;
}

function createFakeAudioHost(permission: VoiceStatus['microphone']) {
  const listeners = new Set<(event: AudioHostEvent) => void>();
  const calls = { startCapture: 0, stopCapture: 0 };
  let onFrame: ((frame: AudioFrame) => void) | null = null;
  const port: NativeAudioHost = {
    permission: () => permission,
    startCapture: async (listener) => {
      calls.startCapture += 1;
      onFrame = listener;
    },
    stopCapture: async () => {
      calls.stopCapture += 1;
      onFrame = null;
    },
    captureActive: () => onFrame !== null,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    calls,
    captureActive: () => onFrame !== null,
    emit(event: AudioHostEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function transcribeFixtureWindow(fixture: AudioFixture, window: LocalAsrWindow): LocalAsrResult {
  const heardUntilMs = window.startMs + packetDurationMs(window);
  const words = fixture.words
    .filter((word) => word.startMs >= window.startMs && word.endMs <= heardUntilMs)
    .map((word) => ({
      text: word.text,
      startMs: word.startMs - window.startMs,
      endMs: word.endMs - window.startMs,
    }));
  return {
    text: words.map((word) => word.text).join(' '),
    words,
    endpoint: heardUntilMs >= fixture.speechEndMs + ENDPOINT_SILENCE_MS,
  };
}

function createFakeAsr(fixture: AudioFixture) {
  const windows: LocalAsrWindow[] = [];
  const held: Array<() => void> = [];
  let stalling = false;
  const engine: LocalAsrEngine = {
    transcribe: async (window) => {
      windows.push(window);
      // A stalled consumer holds the pipeline open; callers must keep the ring bounded instead of
      // waiting for this promise.
      if (stalling) await new Promise<void>((resolve) => { held.push(resolve); });
      return transcribeFixtureWindow(fixture, window);
    },
  };
  return {
    engine,
    windows,
    stall(): void {
      stalling = true;
    },
    release(): void {
      stalling = false;
      for (const resolve of held.splice(0, held.length)) resolve();
    },
  };
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pushFrames(session: LocalVoiceSession, frames: Iterable<AudioFrame>): Promise<void> {
  for (const frame of frames) await session.pushInput(frame);
}

test('a 15-second utterance yields committed local text with timestamps and no network access', { timeout: 30_000 }, async () => {
  assert.equal(voice.ASR_MAX_WINDOW_MS, 15_000, 'the first model pack keeps ASR windows at 15 s or less');
  assert.equal(utteranceFixture.durationMs, 15_000, 'the acceptance fixture is a 15-second utterance');

  const networkCalls: string[] = [];
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    networkCalls.push(`fetch ${String(input)}`);
    throw new Error('local mode must not reach the network');
  }) as typeof fetch;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class ForbiddenWebSocket {
    constructor() {
      networkCalls.push('websocket');
      throw new Error('local mode must not reach the network');
    }
  };

  const host = createFakeAudioHost('granted');
  const asr = createFakeAsr(utteranceFixture);
  const session = voice.createLocalVoiceSession({
    host: host.port,
    asr: asr.engine,
    maxQueuedFrames: MAX_QUEUED_FRAMES,
  });
  const updates: TranscriptUpdate[] = [];
  session.subscribe((update) => { updates.push(update); });

  try {
    assert.equal(session.status().input, 'closed', 'a session that has not started has no open input');
    await within('voice start', session.start());
    assert.equal(host.captureActive(), true, 'a granted microphone must open native capture');
    assert.equal(session.status().input, 'listening', 'an accepted session listens for the first utterance');

    await within('push the 15-second utterance', pushFrames(session, framesFor(utteranceFixture)), 10_000);
    await waitFor(
      () => session.transcript().length > 0,
      'the committed transcript of the 15-second utterance',
    );

    const committed = session.transcript();
    assert.equal(
      committed.map((entry) => entry.text).filter((text) => text.length > 0).join(' '),
      expectedText(utteranceFixture),
      'the committed local text must match the fixture transcript',
    );
    const committedWords = committed.flatMap((entry) => entry.words);
    assert.equal(
      committedWords.length,
      utteranceFixture.words.length,
      'every spoken word must be committed exactly once, with its timestamp',
    );
    committedWords.forEach((word, index) => {
      const expected = utteranceFixture.words[index];
      assert.ok(expected, `no fixture word at committed index ${index}`);
      assert.equal(word.text, expected.text, `committed word ${index} must keep its text`);
      assert.ok(
        Math.abs(word.startMs - expected.startMs) <= TIMESTAMP_TOLERANCE_MS,
        `committed word ${index} starts at ${word.startMs} ms instead of the utterance-relative ${expected.startMs} ms`,
      );
      assert.ok(
        Math.abs(word.endMs - expected.endMs) <= TIMESTAMP_TOLERANCE_MS,
        `committed word ${index} ends at ${word.endMs} ms instead of the utterance-relative ${expected.endMs} ms`,
      );
      assert.ok(word.startMs <= word.endMs, `committed word ${index} has an inverted timestamp`);
      const previous = committedWords[index - 1];
      if (previous) {
        assert.ok(word.startMs > previous.startMs, `committed word ${index} repeats an earlier timestamp`);
      }
    });

    const partials = updates.filter((update) => update.phase === 'partial');
    const finals = updates.filter((update) => update.phase === 'final');
    assert.ok(partials.length > 0, 'the widget needs display-only partial transcripts while speech is open');
    assert.ok(partials.some((update) => update.text.length > 0), 'at least one partial must carry text');
    assert.deepEqual(
      finals.map((update) => update.text),
      committed.map((entry) => entry.text),
      'the widget transcript must receive exactly the committed finals, in order',
    );

    assert.ok(asr.windows.length > 0, 'the utterance must be transcribed locally');
    for (const window of asr.windows) {
      const durationMs = packetDurationMs(window);
      assert.ok(durationMs > 0, 'an ASR window must carry audio');
      assert.ok(
        durationMs <= voice.ASR_MAX_WINDOW_MS,
        `an ASR window of ${durationMs} ms exceeds the 15-second bound`,
      );
      assert.equal(window.sampleRate, utteranceFixture.sampleRate, 'ASR windows keep the 16 kHz rate');
      assert.equal(window.channels, utteranceFixture.channels, 'ASR windows keep the mono channel');
    }
    assert.equal(session.status().error, null, 'a healthy local utterance must not raise an error state');
    assert.equal(networkCalls.length, 0, `local transcription must not touch the network: ${networkCalls.join(', ')}`);
  } finally {
    await within('voice close', session.close());
    globalThis.fetch = realFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
  }
});

test('mute clears pending input and closes capture, and a stalled consumer cannot grow the audio queue', { timeout: 30_000 }, async () => {
  const host = createFakeAudioHost('granted');
  const asr = createFakeAsr(utteranceFixture);
  const session = voice.createLocalVoiceSession({
    host: host.port,
    asr: asr.engine,
    maxQueuedFrames: MAX_QUEUED_FRAMES,
  });
  const updates: TranscriptUpdate[] = [];
  session.subscribe((update) => { updates.push(update); });

  try {
    await within('voice start', session.start());
    await within('push open speech', pushFrames(session, framesFor(utteranceFixture, 0, 3_000)), 10_000);
    await waitFor(
      () => updates.some((update) => update.phase === 'partial' && update.text.length > 0),
      'a display-only partial transcript',
    );
    assert.equal(session.transcript().length, 0, 'partial text must never be committed or routed');

    await within('mute', session.mute());
    assert.ok(host.calls.stopCapture >= 1, 'mute must tell the native host to release the microphone');
    assert.equal(host.captureActive(), false, 'mute must close microphone capture');
    const muted = session.status();
    assert.equal(muted.input, 'muted', 'mute must be visible in the widget state');
    assert.equal(muted.queuedFrames, 0, 'mute must clear pending input');
    assert.equal(muted.microphone, 'granted', 'mute changes capture, not the OS permission');

    const windowsAtMute = asr.windows.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(asr.windows.length, windowsAtMute, 'audio dropped by mute must not reach the ASR');
    assert.equal(session.transcript().length, 0, 'pending speech must not commit text after mute');
    assert.equal(
      updates.some((update) => update.phase === 'final'),
      false,
      'mute must discard the open utterance instead of finalizing it',
    );
    await within('pushInput after mute', session.pushInput(frameAt(utteranceFixture, 200)));
    assert.equal(session.transcript().length, 0, 'audio pushed after mute must stay out of the transcript');
  } finally {
    await within('voice close', session.close());
  }

  const stallHost = createFakeAudioHost('granted');
  const stallAsr = createFakeAsr(continuousFixture);
  const stallSession = voice.createLocalVoiceSession({
    host: stallHost.port,
    asr: stallAsr.engine,
    maxQueuedFrames: MAX_QUEUED_FRAMES,
  });

  try {
    await within('voice start (stalled consumer)', stallSession.start());
    await within(
      'push 18 s of continuous speech',
      pushFrames(stallSession, framesFor(continuousFixture)),
      10_000,
    );
    await waitFor(
      () => stallSession.transcript().length > 0,
      'a committed stable prefix while the speaker has not paused',
    );
    const prefix = stallSession.transcript()
      .map((entry) => entry.text)
      .filter((text) => text.length > 0)
      .join(' ');
    const spoken = expectedText(continuousFixture);
    assert.ok(prefix.length > 0, 'the committed prefix must carry text');
    assert.ok(
      spoken.startsWith(prefix),
      `the committed prefix "${prefix}" must be a stable prefix of the still-open utterance`,
    );

    const committedBeforeStall = stallSession.transcript().length;
    stallAsr.stall();
    await within(
      'push 42 s into a stalled consumer',
      pushFrames(stallSession, framesFor(continuousFixture, 18_000, 60_000)),
      10_000,
    );
    const stalled = stallSession.status();
    assert.ok(
      stalled.queuedFrames <= MAX_QUEUED_FRAMES,
      `the audio queue grew to ${stalled.queuedFrames} frames while the consumer was stalled`,
    );
    assert.ok(stalled.discontinuityCount >= 1, 'dropped audio must surface as a discontinuity');
    for (const window of stallAsr.windows) {
      const durationMs = packetDurationMs(window);
      assert.ok(
        durationMs <= voice.ASR_MAX_WINDOW_MS,
        `a stalled consumer still produced a ${durationMs} ms ASR window`,
      );
    }

    stallAsr.release();
    await within(
      'push 18 s after the stall clears',
      pushFrames(stallSession, framesFor(continuousFixture, 60_000, 78_000)),
      10_000,
    );
    await waitFor(
      () => stallSession.transcript().length > committedBeforeStall,
      'the pipeline resumes local transcription after the stall clears',
    );
    assert.equal(stallSession.status().error, null, 'a recovered stall must not leave a stuck error state');
  } finally {
    await within('voice close (stalled consumer)', stallSession.close());
  }
});

test('mic denial, device removal, lock, and helper crash produce visible states without hanging', { timeout: 30_000 }, async () => {
  async function expectVisibleFailure(options: Readonly<{
    label: string;
    permission: VoiceStatus['microphone'];
    code: VoiceErrorCode;
    trigger?: (host: ReturnType<typeof createFakeAudioHost>) => void;
  }>): Promise<void> {
    const host = createFakeAudioHost(options.permission);
    const asr = createFakeAsr(utteranceFixture);
    const session = voice.createLocalVoiceSession({
      host: host.port,
      asr: asr.engine,
      maxQueuedFrames: MAX_QUEUED_FRAMES,
    });
    try {
      await within(`${options.label}: start`, session.start());
      if (options.permission === 'denied') {
        assert.equal(host.calls.startCapture, 0, `${options.label}: a denied microphone must not be opened`);
        assert.equal(session.status().microphone, 'denied', `${options.label}: the widget shows the permission state`);
        assert.equal(session.status().input, 'closed', `${options.label}: no input stream is open`);
      } else {
        assert.equal(host.captureActive(), true, `${options.label}: a granted microphone must open capture`);
        options.trigger?.(host);
        await waitFor(
          () => session.status().error !== null,
          `${options.label}: a visible widget state`,
          2_000,
        );
        assert.equal(host.captureActive(), false, `${options.label}: the failure must close microphone capture`);
        assert.ok(host.calls.stopCapture >= 1, `${options.label}: the native host must release the device`);
      }

      const error = session.status().error;
      assert.ok(error, `${options.label}: the failure must stay visible in status()`);
      assert.equal(error.code, options.code, `${options.label}: expected the ${options.code} state`);
      assert.ok(error.message.length > 0, `${options.label}: the visible state needs a readable message`);
      await within(
        `${options.label}: pushInput after the failure`,
        session.pushInput(frameAt(utteranceFixture, 0)),
        2_000,
      );
      assert.equal(session.transcript().length, 0, `${options.label}: a failed session must not commit text`);
    } finally {
      await within(`${options.label}: close`, session.close(), 2_000);
    }
  }

  await expectVisibleFailure({ label: 'mic denial', permission: 'denied', code: 'mic_denied' });
  await expectVisibleFailure({
    label: 'device removal',
    permission: 'granted',
    code: 'device_removed',
    trigger: (host) => { host.emit({ type: 'device_removed', deviceId: 'fixture-mic-2' }); },
  });
  await expectVisibleFailure({
    label: 'lock',
    permission: 'granted',
    code: 'locked',
    trigger: (host) => { host.emit({ type: 'system_locked' }); },
  });
  await expectVisibleFailure({
    label: 'helper crash',
    permission: 'granted',
    code: 'helper_crash',
    trigger: (host) => { host.emit({ type: 'helper_crash' }); },
  });
});
