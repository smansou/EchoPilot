/**
 * V01 — initial voice tracer bullet: Speak → native audio → local ASR → widget transcript → mute.
 *
 * The signed native helper owns the microphone graph, the bounded PCM channel, Silero VAD and
 * WhisperKit small.en (see native/macos/Sources/Audio and native/macos/Sources/ASR). This module is
 * the session the widget drives, and it is verified against the fake native host contract so the
 * tracer can be exercised without a signing identity or a live microphone prompt.
 *
 * Invariants kept here mirror the native pipeline:
 *   - an ASR window never exceeds ASR_MAX_WINDOW_MS (15 s) and rolls with a 1 s overlap;
 *   - only fully heard words are committed, and only on a window boundary or on an endpoint —
 *     "commit stable prefixes"; partial text is display-only and is never routed;
 *   - the transport ring is bounded by maxQueuedFrames: overflow drops audio, counts a
 *     discontinuity and resets the affected ASR state instead of growing without bound;
 *   - mute closes native capture, drops queued and pending audio and clears partial text;
 *   - permission and host failures (denial, device removal, lock, helper crash) surface through
 *     status() as visible states instead of throwing or hanging the widget.
 */

/** Hard bound for one local ASR window (plan §5.5): 15 s, rolling with a 1 s overlap. */
export const ASR_MAX_WINDOW_MS = 15_000;
/** Plan §5.5: an endpoint closes the utterance after 450 ms of trailing silence. */
export const ASR_ENDPOINT_SILENCE_MS = 450;

/** Rolling overlap between consecutive ASR windows of one utterance. */
const ASR_OVERLAP_MS = 1_000;
/** How often the widget receives a display-only partial while speech stays open. */
const PARTIAL_INTERVAL_MS = 400;
/** Non-zero RMS floor for the widget's speech states; the engine owns the real Silero VAD. */
const VAD_RMS_FLOOR = 120;
const DEFAULT_MAX_QUEUED_FRAMES = 100;

export type WordTimestamp = Readonly<{ text: string; startMs: number; endMs: number }>;

export type AudioFrame = Readonly<{
  sequence: number;
  sampleRate: number;
  channels: number;
  monotonicNs: string;
  pcm: Uint8Array;
}>;

export type TranscriptUpdate = Readonly<{
  phase: 'partial' | 'final';
  utteranceId: string;
  text: string;
  words: ReadonlyArray<WordTimestamp>;
}>;

export type CommittedUtterance = Readonly<{
  utteranceId: string;
  text: string;
  words: ReadonlyArray<WordTimestamp>;
}>;

export type VoiceErrorCode = 'mic_denied' | 'device_removed' | 'locked' | 'helper_crash';

export type VoiceStatus = Readonly<{
  input: 'closed' | 'listening' | 'speech_candidate' | 'utterance_open' | 'committing' | 'muted';
  microphone: 'granted' | 'denied' | 'unknown';
  error: Readonly<{ code: VoiceErrorCode; message: string }> | null;
  queuedFrames: number;
  discontinuityCount: number;
}>;

export type LocalAsrWindow = Readonly<{
  utteranceId: string;
  startMs: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

export type LocalAsrResult = Readonly<{
  text: string;
  words: ReadonlyArray<WordTimestamp>;
  endpoint: boolean;
}>;

export type LocalAsrEngine = Readonly<{
  transcribe(window: LocalAsrWindow): Promise<LocalAsrResult>;
}>;

export type AudioHostEvent =
  | Readonly<{ type: 'permission_denied' }>
  | Readonly<{ type: 'device_removed'; deviceId: string }>
  | Readonly<{ type: 'system_locked' }>
  | Readonly<{ type: 'helper_crash' }>;

export type NativeAudioHost = Readonly<{
  permission(): 'granted' | 'denied' | 'unknown';
  startCapture(onFrame: (frame: AudioFrame) => void): Promise<void>;
  stopCapture(): Promise<void>;
  captureActive(): boolean;
  onEvent(listener: (event: AudioHostEvent) => void): () => void;
}>;

export type LocalVoiceSession = Readonly<{
  start(): Promise<void>;
  pushInput(frame: AudioFrame): Promise<void>;
  mute(): Promise<void>;
  status(): VoiceStatus;
  subscribe(listener: (update: TranscriptUpdate) => void): () => void;
  transcript(): ReadonlyArray<CommittedUtterance>;
  close(): Promise<void>;
}>;

export type LocalVoiceSessionOptions = Readonly<{
  host: NativeAudioHost;
  asr: LocalAsrEngine;
  maxQueuedFrames: number;
}>;

const HOST_ERROR_MESSAGES: Readonly<Record<VoiceErrorCode, string>> = {
  mic_denied: 'Microphone access is not granted; allow it in System Settings to speak to the widget.',
  device_removed: 'The input device was removed; reconnect a microphone and start a new session.',
  locked: 'The Mac locked during capture; the voice session stopped and the widget shows the state.',
  helper_crash: 'The native audio helper stopped unexpectedly; capture was released.',
};

type PcmWindow = {
  startMs: number;
  sampleRate: number;
  channels: number;
  chunks: Uint8Array[];
  bytes: number;
  durationMs: number;
  lastTranscribedMs: number;
  voiced: boolean;
};

type AbsoluteWord = { text: string; absStartMs: number; absEndMs: number };

function pcmDurationMs(pcm: Uint8Array, sampleRate: number, channels: number): number {
  if (sampleRate <= 0 || channels <= 0) return 0;
  const frameCount = pcm.byteLength / (channels * 2);
  return (frameCount / sampleRate) * 1_000;
}

function packetDurationMs(frame: AudioFrame): number {
  return pcmDurationMs(frame.pcm, frame.sampleRate, frame.channels);
}

function parseMonotonicNs(value: string): bigint | null {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/** Cheap energy gate for the widget's speech states; Silero VAD runs in the native helper. */
function rms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const low = pcm[index * 2] ?? 0;
    const high = pcm[index * 2 + 1] ?? 0;
    const raw = (high << 8) | low;
    const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
    sum += signed * signed;
  }
  return Math.sqrt(sum / samples);
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function tailBytes(chunks: ReadonlyArray<Uint8Array>, byteCount: number): Uint8Array | null {
  if (byteCount <= 0 || chunks.length === 0) return null;
  let available = 0;
  for (let index = chunks.length - 1; index >= 0 && available < byteCount; index -= 1) {
    available += chunks[index]?.byteLength ?? 0;
  }
  if (available === 0) return null;
  const size = Math.min(available, byteCount);
  const tail = new Uint8Array(size);
  let write = size;
  for (let index = chunks.length - 1; index >= 0 && write > 0; index -= 1) {
    const chunk = chunks[index];
    if (!chunk || chunk.byteLength === 0) continue;
    const take = Math.min(chunk.byteLength, write);
    tail.set(chunk.subarray(chunk.byteLength - take), write - take);
    write -= take;
  }
  return tail;
}

export function createLocalVoiceSession(options: LocalVoiceSessionOptions): LocalVoiceSession {
  const { host, asr } = options;
  const queueLimit = Number.isFinite(options.maxQueuedFrames) && options.maxQueuedFrames >= 1
    ? Math.max(1, Math.floor(options.maxQueuedFrames))
    : DEFAULT_MAX_QUEUED_FRAMES;

  const listeners = new Set<(update: TranscriptUpdate) => void>();
  const committed: CommittedUtterance[] = [];
  const queue: AudioFrame[] = [];
  let workWaiters: Array<() => void> = [];

  let started = false;
  let closed = false;
  let muted = false;
  let fatal = false;
  let pump: Promise<void> | null = null;
  let unsubscribeHost: (() => void) | null = null;

  let input: VoiceStatus['input'] = 'closed';
  let microphone: VoiceStatus['microphone'] = 'unknown';
  let error: VoiceStatus['error'] = null;
  let discontinuityCount = 0;
  let discontinuityPending = false;
  /** Bumped whenever buffered audio stops being trustworthy; stale ASR results are discarded. */
  let pipelineEpoch = 0;

  let baseNs: bigint | null = null;
  let fallbackTimelineMs = 0;

  let utteranceSeq = 0;
  let utteranceId: string | null = null;
  let utteranceStartMs = 0;
  let utteranceWords: WordTimestamp[] = [];
  let committedEndAbsMs = Number.NEGATIVE_INFINITY;
  let lastPartialText: string | null = null;

  let window: PcmWindow | null = null;

  const notifyWork = (): void => {
    if (workWaiters.length === 0) return;
    const waiters = workWaiters;
    workWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const waitForWork = (): Promise<void> => new Promise<void>((resolve) => {
    workWaiters.push(resolve);
  });

  const emit = (update: TranscriptUpdate): void => {
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch {
        // A widget listener must never break the capture pipeline.
      }
    }
  };

  const resetUtterance = (): void => {
    utteranceId = null;
    utteranceStartMs = 0;
    utteranceWords = [];
    committedEndAbsMs = Number.NEGATIVE_INFINITY;
    lastPartialText = null;
  };

  const ensureUtterance = (): string => {
    if (utteranceId !== null) return utteranceId;
    utteranceSeq += 1;
    utteranceId = `utterance-${utteranceSeq}`;
    utteranceStartMs = window ? window.startMs : fallbackTimelineMs;
    utteranceWords = [];
    committedEndAbsMs = Number.NEGATIVE_INFINITY;
    lastPartialText = null;
    return utteranceId;
  };

  const commitWords = (words: ReadonlyArray<WordTimestamp>, absEnds: ReadonlyArray<number>): void => {
    const id = ensureUtterance();
    const entry: CommittedUtterance = {
      utteranceId: id,
      text: words.map((word) => word.text).join(' '),
      words: words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })),
    };
    committed.push(entry);
    utteranceWords = [...utteranceWords, ...entry.words];
    for (const end of absEnds) committedEndAbsMs = Math.max(committedEndAbsMs, end);
    emit({ phase: 'final', utteranceId: id, text: entry.text, words: entry.words });
  };

  const endUtterance = (): void => {
    resetUtterance();
    window = null;
    if (started && !muted && !fatal && !closed) input = 'listening';
  };

  const consumeDiscontinuity = (): void => {
    discontinuityPending = false;
    pipelineEpoch += 1;
    resetUtterance();
    window = null;
    if (started && !muted && !fatal && !closed) input = 'listening';
  };

  /** Applies one engine result: seal/endpoint results commit, everything else only displays. */
  const applyResult = (
    snapshot: LocalAsrWindow,
    result: LocalAsrResult,
    kind: 'partial' | 'seal',
  ): boolean => {
    const id = ensureUtterance();
    const absWords: AbsoluteWord[] = [];
    for (const word of result.words ?? []) {
      absWords.push({
        text: word.text,
        absStartMs: snapshot.startMs + word.startMs,
        absEndMs: snapshot.startMs + word.endMs,
      });
    }
    const fresh = absWords.filter((word) => word.absEndMs > committedEndAbsMs);
    const freshRelative: WordTimestamp[] = fresh.map((word) => ({
      text: word.text,
      startMs: Math.round(word.absStartMs - utteranceStartMs),
      endMs: Math.round(word.absEndMs - utteranceStartMs),
    }));
    const endpoint = result.endpoint === true;

    if (kind === 'seal' || endpoint) {
      if (freshRelative.length > 0 || endpoint) {
        commitWords(freshRelative, fresh.map((word) => word.absEndMs));
      }
      if (endpoint) {
        endUtterance();
        return true;
      }
      if (input !== 'closed' && input !== 'muted') {
        // A sealed window with no new stable words falls back to plain listening.
        input = freshRelative.length > 0 ? 'utterance_open' : 'listening';
      }
      return false;
    }

    if (freshRelative.length > 0) {
      if (input !== 'closed' && input !== 'muted') input = 'utterance_open';
      const displayWords = [...utteranceWords, ...freshRelative];
      const text = displayWords.map((word) => word.text).join(' ');
      if (text !== lastPartialText) {
        lastPartialText = text;
        emit({ phase: 'partial', utteranceId: id, text, words: displayWords });
      }
    }
    return false;
  };

  const transcribeWindow = async (kind: 'partial' | 'seal'): Promise<void> => {
    const active = window;
    if (!active || active.bytes === 0) return;
    const epoch = pipelineEpoch;
    const id = ensureUtterance();
    const snapshot: LocalAsrWindow = {
      utteranceId: id,
      startMs: Math.round(active.startMs),
      sampleRate: active.sampleRate,
      channels: active.channels,
      pcm: concatChunks(active.chunks),
    };
    active.lastTranscribedMs = active.durationMs;
    if (kind === 'seal' && input !== 'closed' && input !== 'muted') input = 'committing';

    let result: LocalAsrResult;
    try {
      result = await asr.transcribe(snapshot);
    } catch {
      // An engine failure loses the buffered window: surface it as a discontinuity and keep the
      // session alive instead of wedging the pipeline.
      if (closed || muted || fatal) return;
      pipelineEpoch += 1;
      window = null;
      if (!discontinuityPending) {
        discontinuityPending = true;
        discontinuityCount += 1;
      }
      return;
    }

    if (closed || muted || fatal) return;
    if (discontinuityPending) {
      consumeDiscontinuity();
      return;
    }
    if (epoch !== pipelineEpoch) return;

    const ended = applyResult(snapshot, result, kind);
    if (kind !== 'seal') return;
    if (ended || !window) return;

    // Roll forward with the 1 s overlap so a word straddling the boundary is still heard.
    const overlapMs = Math.min(ASR_OVERLAP_MS, window.durationMs);
    if (overlapMs <= 0) return;
    const overlapBytes = Math.round((overlapMs / 1_000) * window.sampleRate) * window.channels * 2;
    const tail = tailBytes(window.chunks, overlapBytes);
    window = {
      startMs: window.startMs + window.durationMs - overlapMs,
      sampleRate: window.sampleRate,
      channels: window.channels,
      chunks: tail ? [tail] : [],
      bytes: tail ? tail.byteLength : 0,
      durationMs: tail ? overlapMs : 0,
      lastTranscribedMs: tail ? overlapMs : 0,
      voiced: window.voiced,
    };
  };

  const timelineMs = (frame: AudioFrame): number => {
    const ns = parseMonotonicNs(frame.monotonicNs);
    if (ns === null) return fallbackTimelineMs;
    if (baseNs === null) baseNs = ns;
    const relativeMs = Number(ns - baseNs) / 1_000_000;
    if (Number.isFinite(relativeMs) && relativeMs >= 0) return relativeMs;
    return fallbackTimelineMs;
  };

  const appendFrame = (frame: AudioFrame, startMs: number, durationMs: number): void => {
    let active = window;
    if (!active) {
      active = {
        startMs,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        chunks: [],
        bytes: 0,
        durationMs: 0,
        lastTranscribedMs: 0,
        voiced: false,
      };
      window = active;
    }
    const pcm = frame.pcm.byteLength > 0 ? frame.pcm.slice() : frame.pcm;
    active.chunks.push(pcm);
    active.bytes += pcm.byteLength;
    active.durationMs += durationMs;
    if (rms(pcm) >= VAD_RMS_FLOOR) {
      active.voiced = true;
      if (input === 'listening') input = 'speech_candidate';
    }
  };

  const runPump = async (): Promise<void> => {
    try {
      while (!closed && !muted && !fatal) {
        if (discontinuityPending) consumeDiscontinuity();
        const frame = queue.shift();
        if (!frame) {
          await waitForWork();
          continue;
        }
        if (closed || muted || fatal) return;

        const frameStartMs = timelineMs(frame);
        const frameDurationMs = packetDurationMs(frame);
        fallbackTimelineMs = Math.max(fallbackTimelineMs, frameStartMs + frameDurationMs);

        if (window && window.durationMs + frameDurationMs > ASR_MAX_WINDOW_MS) {
          await transcribeWindow('seal');
          if (closed || muted || fatal) return;
          if (discontinuityPending) continue;
        }

        appendFrame(frame, frameStartMs, frameDurationMs);
        const active = window;
        if (active && active.durationMs - active.lastTranscribedMs >= PARTIAL_INTERVAL_MS) {
          await transcribeWindow('partial');
        }
      }
    } finally {
      pump = null;
    }
  };

  const ensurePump = (): void => {
    if (pump === null && !closed && !muted && !fatal) pump = runPump();
  };

  /** The bounded transport ring: overflow drops the oldest audio and counts one discontinuity. */
  const enqueueFrame = (frame: AudioFrame): void => {
    if (!started || closed || muted || fatal) return;
    if (queue.length >= queueLimit) {
      queue.shift();
      if (!discontinuityPending) {
        discontinuityPending = true;
        discontinuityCount += 1;
      }
    }
    queue.push(frame);
    notifyWork();
  };

  const handleHostEvent = (event: AudioHostEvent): void => {
    if (closed || fatal) return;
    const code: VoiceErrorCode = event.type === 'permission_denied'
      ? 'mic_denied'
      : event.type === 'device_removed'
        ? 'device_removed'
        : event.type === 'system_locked'
          ? 'locked'
          : 'helper_crash';
    fatal = true;
    pipelineEpoch += 1;
    queue.length = 0;
    discontinuityPending = false;
    resetUtterance();
    window = null;
    error = { code, message: HOST_ERROR_MESSAGES[code] };
    input = 'closed';
    notifyWork();
    void host.stopCapture().catch(() => undefined);
  };

  const start = async (): Promise<void> => {
    if (started || closed) return;
    started = true;
    if (muted) {
      input = 'muted';
      return;
    }
    microphone = host.permission();
    if (microphone !== 'granted') {
      error = {
        code: 'mic_denied',
        message: microphone === 'denied'
          ? HOST_ERROR_MESSAGES.mic_denied
          : 'Microphone permission is still unknown; the widget keeps input closed until it is granted.',
      };
      input = 'closed';
      return;
    }

    unsubscribeHost = host.onEvent(handleHostEvent);
    try {
      await host.startCapture((frame) => {
        enqueueFrame(frame);
      });
    } catch (cause) {
      fatal = true;
      error = {
        code: 'helper_crash',
        message: `${HOST_ERROR_MESSAGES.helper_crash} ${cause instanceof Error ? cause.message : String(cause)}`,
      };
      input = 'closed';
      void host.stopCapture().catch(() => undefined);
      return;
    }
    if (closed || fatal) {
      void host.stopCapture().catch(() => undefined);
      return;
    }
    input = 'listening';
    ensurePump();
  };

  const pushInput = async (frame: AudioFrame): Promise<void> => {
    enqueueFrame(frame);
  };

  const mute = async (): Promise<void> => {
    if (closed || muted) return;
    muted = true;
    pipelineEpoch += 1;
    queue.length = 0;
    discontinuityPending = false;
    resetUtterance();
    window = null;
    if (!fatal) {
      input = 'muted';
    }
    notifyWork();
    try {
      await host.stopCapture();
    } catch {
      // Mute is a local guarantee: the widget state stays muted even if the helper is gone.
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    pipelineEpoch += 1;
    queue.length = 0;
    discontinuityPending = false;
    window = null;
    notifyWork();
    if (unsubscribeHost) {
      unsubscribeHost();
      unsubscribeHost = null;
    }
    try {
      await host.stopCapture();
    } catch {
      // Closing must settle even when the native helper is already gone.
    }
  };

  return {
    start,
    pushInput,
    mute,
    status: (): VoiceStatus => ({
      input,
      microphone,
      error,
      queuedFrames: queue.length,
      discontinuityCount,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    transcript: () => [...committed],
    close,
  };
}
