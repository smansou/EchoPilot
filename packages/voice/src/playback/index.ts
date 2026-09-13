/**
 * V02 — approved speech plan → local synthesis → playback → replay/cancel while listening.
 *
 * The widget hands this session an approved `SpeechPlan` plus the `SpeechLease` that authorizes it,
 * the session asks the bundled local worker for PCM and writes every accepted frame to the native
 * playback boundary. Capture never stops: the V01 input session (`../index.ts`) keeps owning the
 * microphone graph and the transcript, so the user is still transcribed while a plan is spoken.
 *
 * Invariants kept here, and verified by `acceptance.test.ts`:
 *   - a plan is only synthesized when its lease is approved; a lease or plan that has expired
 *     resolves `[]` without touching the worker or the device;
 *   - the generation epoch is the cancel currency: every frame written to the sink carries the
 *     epoch it was produced under, `interrupt()` advances the epoch and flushes the device queue,
 *     and a frame from a superseded epoch is dropped instead of becoming audible;
 *   - only audio the device actually rendered counts as heard: a segment is reported `completed`
 *     with `positionMs` = rendered milliseconds, and a segment that was never audible is not
 *     replayable;
 *   - replay re-uses the retained PCM of the last completed sentence (or a named segment) instead
 *     of synthesizing again, under a fresh epoch so a cancel can still silence it.
 *
 * The session is also the contracts' `VoiceSession` seam: `pushInput` and `mute` delegate to the
 * V01 input session, so the widget drives one object for capture and playback.
 */

import type { SpeechLease, SpeechPlan, VoiceOutputEvent } from '../../../contracts/src/index.js';
import type { AudioFrame, LocalVoiceSession } from '../index.js';

/** One 20 ms packet of locally synthesized PCM in the session's declared output format. */
export type PcmFrame = Readonly<{
  sequence: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

export type SynthesisRequest = Readonly<{
  planId: string;
  segmentId: string;
  text: string;
  voiceId: string;
  epoch: number;
  signal?: AbortSignal;
}>;

/** The bundled Pocket TTS boundary: no network, no system interpreter (see workers/pocket-tts). */
export type SpeechSynthesisWorker = Readonly<{
  synthesize(request: SynthesisRequest): AsyncIterable<PcmFrame>;
}>;

export type PlaybackOutputFormat = Readonly<{ sampleRate: number; channels: number }>;

/** A frame as it enters the device queue: stamped with the generation epoch that produced it. */
export type PlaybackFrame = Readonly<{
  epoch: number;
  planId: string;
  segmentId: string;
  sequence: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

/** What the device actually rendered. Generated-but-unheard audio never shows up here. */
export type PlaybackProgress = Readonly<{
  epoch: number;
  planId: string;
  segmentId: string;
  renderedMs: number;
}>;

/**
 * The native playback boundary (`native/macos/Sources/Audio/PlaybackGraph.swift` in the app).
 * `write` is the device queue, `onProgress` reports rendered positions and `flush` drops the
 * queue — that is what makes a cancel inaudible instead of merely unlucky timing.
 */
export type NativePlaybackSink = Readonly<{
  open(format: PlaybackOutputFormat): Promise<void>;
  write(frame: PlaybackFrame): void;
  onProgress(listener: (progress: PlaybackProgress) => void): () => void;
  flush(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
}>;

export type OutputState = 'idle' | 'generating' | 'buffering' | 'speaking' | 'paused' | 'cancelled';

export type PlaybackStatus = Readonly<{ output: OutputState; epoch: number }>;

export type LocalPlaybackSession = Readonly<{
  start(): Promise<void>;
  pushInput(frame: AudioFrame): Promise<void>;
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
  interrupt(reason: string): Promise<void>;
  mute(): Promise<void>;
  replay(segmentId?: string): Promise<void>;
  status(): PlaybackStatus;
  close(): Promise<void>;
}>;

export type LocalPlaybackSessionOptions = Readonly<{
  input: LocalVoiceSession;
  worker: SpeechSynthesisWorker;
  sink: NativePlaybackSink;
  voiceId: string;
  outputFormat: PlaybackOutputFormat;
}>;

type RenderOutcome = 'rendered' | 'cancelled';

type RetainedSegment = {
  planId: string;
  segmentId: string;
  epoch: number;
  frames: PlaybackFrame[];
  totalMs: number;
  renderedMs: number;
  /** True once any part of the segment reached the device clock. */
  audible: boolean;
  /** True only when the device rendered every frame of the segment. */
  completed: boolean;
  order: number;
};

type SegmentRun = RetainedSegment & {
  controller: AbortController;
  resolve: ((outcome: RenderOutcome) => void) | null;
};

type OutputRun = {
  readonly epoch: number;
  readonly segments: Map<string, SegmentRun>;
  readonly events: VoiceOutputEvent[];
  readonly settled: Promise<void>;
  readonly settle: () => void;
  cancelled: boolean;
  reason: string | null;
  iterator: AsyncIterator<PcmFrame> | null;
};

type ReplayRun = {
  readonly epoch: number;
  readonly planId: string;
  readonly segmentId: string;
  readonly totalMs: number;
  renderedMs: number;
};

/**
 * A lease is the only way to speak: the plan and the lease must describe the same epoch and both
 * must still be in the future. Anything else is treated as unapproved and stays silent.
 */
function isLeaseApproved(plan: SpeechPlan, lease: SpeechLease, nowMs: number): boolean {
  if (lease.epoch !== plan.epoch) return false;
  const leaseExpiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiry) || leaseExpiry <= nowMs) return false;
  const planExpiry = Date.parse(plan.expiresAt);
  if (!Number.isFinite(planExpiry) || planExpiry <= nowMs) return false;
  return true;
}

function frameDurationMs(frame: Readonly<{ sampleRate: number; channels: number; pcm: Uint8Array }>): number {
  if (frame.sampleRate <= 0 || frame.channels <= 0) return 0;
  const samples = frame.pcm.byteLength / (frame.channels * 2);
  return (samples / frame.sampleRate) * 1_000;
}

export function createLocalPlaybackSession(options: LocalPlaybackSessionOptions): LocalPlaybackSession {
  const { input, worker, sink, voiceId, outputFormat } = options;

  let started = false;
  let closed = false;
  let output: OutputState = 'idle';
  /**
   * Generation epoch. It advances on every approved plan, on every replay and on every cancel, so
   * "is this frame still wanted?" is a number comparison instead of a race with the worker.
   */
  let epoch = 0;
  let activeRun: OutputRun | null = null;
  let activeReplay: ReplayRun | null = null;
  let unsubscribeProgress: (() => void) | null = null;
  const retained = new Map<string, SegmentRun>();
  let retentionOrder = 0;

  const setOutput = (state: OutputState): void => {
    if (!closed) output = state;
  };

  /** A frame or a segment is stale once its run was cancelled, superseded or the session closed. */
  const staleFor = (run: OutputRun): boolean => run.cancelled || run.epoch !== epoch || closed;

  const handleProgress = (progress: PlaybackProgress): void => {
    const run = activeRun;
    if (run && !run.cancelled && run.epoch === progress.epoch) {
      const segment = run.segments.get(progress.segmentId);
      if (segment) {
        segment.renderedMs = Math.max(segment.renderedMs, progress.renderedMs);
        if (segment.renderedMs > 0) segment.audible = true;
        if (segment.renderedMs >= segment.totalMs) {
          const resolve = segment.resolve;
          segment.resolve = null;
          resolve?.('rendered');
        } else {
          setOutput('speaking');
        }
      }
    }
    const replay = activeReplay;
    if (replay && replay.epoch === progress.epoch && replay.segmentId === progress.segmentId) {
      replay.renderedMs = Math.max(replay.renderedMs, progress.renderedMs);
      if (replay.renderedMs >= replay.totalMs) {
        activeReplay = null;
        setOutput('idle');
      } else if (replay.renderedMs > 0) {
        setOutput('speaking');
      }
    }
  };

  /** Resolves once the device reports every frame of the segment rendered, or on cancel. */
  const waitForRendered = (run: OutputRun, segment: SegmentRun): Promise<RenderOutcome> => {
    if (staleFor(run)) return Promise.resolve('cancelled');
    if (segment.renderedMs >= segment.totalMs) return Promise.resolve('rendered');
    return new Promise<RenderOutcome>((resolve) => {
      segment.resolve = (outcome) => {
        segment.resolve = null;
        resolve(outcome);
      };
    });
  };

  /** Stops a worker stream so no further frame can be produced for it. */
  const releaseIterator = async (iterator: AsyncIterator<PcmFrame> | null): Promise<void> => {
    if (!iterator?.return) return;
    try {
      await iterator.return();
    } catch {
      // A worker stream that is already closed needs no second goodbye.
    }
  };

  /**
   * Marks a run cancelled without awaiting anything: every later await in its producer re-checks
   * this flag, so a cancel is observed before the next frame can be written.
   */
  const markCancelled = (run: OutputRun, reason: string): void => {
    if (run.cancelled) return;
    run.cancelled = true;
    run.reason = reason;
    for (const segment of run.segments.values()) {
      const resolve = segment.resolve;
      segment.resolve = null;
      resolve?.('cancelled');
      segment.controller.abort();
    }
    setOutput('cancelled');
  };

  /** Marks a run cancelled, unblocks its waiters and lets it settle before the caller continues. */
  const cancelRun = async (run: OutputRun, reason: string): Promise<void> => {
    markCancelled(run, reason);
    const iterator = run.iterator;
    run.iterator = null;
    await releaseIterator(iterator);
    if (activeRun === run) activeRun = null;
    await run.settled;
  };

  const segmentFrame = (run: OutputRun, segment: SegmentRun, frame: PcmFrame, sequence: number): PlaybackFrame => ({
    epoch: run.epoch,
    planId: segment.planId,
    segmentId: segment.segmentId,
    sequence,
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    pcm: frame.pcm,
  });

  /** Streams one segment from the local worker into the device queue under this run's epoch. */
  const synthesizeSegment = async (
    run: OutputRun,
    segment: SegmentRun,
    text: string,
  ): Promise<void> => {
    const stream = worker.synthesize({
      planId: segment.planId,
      segmentId: segment.segmentId,
      text,
      voiceId,
      epoch: run.epoch,
      signal: segment.controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    run.iterator = iterator;
    let sequence = 0;
    let wrote = false;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        // The guard runs after every await: a cancel that landed while the worker was producing
        // this frame wins, and the frame is dropped instead of becoming audible.
        if (staleFor(run)) return;
        const frame = next.value;
        const playbackFrame = segmentFrame(run, segment, frame, sequence);
        sink.write(playbackFrame);
        sequence += 1;
        // Retained byte-for-byte for replay: the device queue may keep the original buffer, but the
        // worker is free to reuse its own once the frame is handed over.
        segment.frames.push({ ...playbackFrame, pcm: frame.pcm.slice() });
        segment.totalMs += frameDurationMs(frame);
        if (!wrote) {
          wrote = true;
          setOutput('buffering');
        }
      }
    } finally {
      run.iterator = null;
      await releaseIterator(iterator);
    }
  };

  const cancelEvent = (planId: string, segment: SegmentRun): VoiceOutputEvent => ({
    planId,
    segmentId: segment.segmentId,
    positionMs: segment.renderedMs,
    status: 'cancelled',
  });

  const completeEvent = (planId: string, segment: SegmentRun): VoiceOutputEvent => ({
    planId,
    segmentId: segment.segmentId,
    positionMs: segment.renderedMs,
    status: 'completed',
  });

  /**
   * Speaks an approved plan sentence by sentence: synthesize, queue, and only move on once the
   * device rendered the sentence that was queued before it.
   */
  const runPlan = async (plan: SpeechPlan, run: OutputRun): Promise<void> => {
    for (const spec of plan.segments) {
      if (staleFor(run)) {
        run.events.push({
          planId: plan.planId,
          segmentId: spec.id,
          positionMs: 0,
          status: 'cancelled',
        });
        continue;
      }
      const segment: SegmentRun = {
        planId: plan.planId,
        segmentId: spec.id,
        epoch: run.epoch,
        frames: [],
        totalMs: 0,
        renderedMs: 0,
        audible: false,
        completed: false,
        order: retentionOrder,
        controller: new AbortController(),
        resolve: null,
      };
      retentionOrder += 1;
      run.segments.set(spec.id, segment);
      setOutput('generating');
      await synthesizeSegment(run, segment, spec.text);
      retained.set(segment.segmentId, segment);
      if (staleFor(run)) {
        run.events.push(cancelEvent(plan.planId, segment));
        continue;
      }
      const outcome = await waitForRendered(run, segment);
      if (outcome !== 'rendered' || staleFor(run)) {
        // A sentence the device never rendered is not "heard" and is reported as cancelled, so the
        // widget can tell the difference between spoken and merely generated speech.
        run.events.push(cancelEvent(plan.planId, segment));
        continue;
      }
      segment.completed = true;
      segment.audible = true;
      run.events.push(completeEvent(plan.planId, segment));
    }
  };

  const lastCompletedSegment = (): SegmentRun | undefined => {
    let best: SegmentRun | undefined;
    for (const segment of retained.values()) {
      if (!segment.completed) continue;
      if (best === undefined || segment.order >= best.order) best = segment;
    }
    return best;
  };

  const start = async (): Promise<void> => {
    if (started || closed) return;
    started = true;
    if (unsubscribeProgress === null) unsubscribeProgress = sink.onProgress(handleProgress);
    await sink.open(outputFormat);
    await input.start();
  };

  const submitSpeech = async (
    plan: SpeechPlan,
    lease: SpeechLease,
  ): Promise<ReadonlyArray<VoiceOutputEvent>> => {
    if (closed) return [];
    if (!isLeaseApproved(plan, lease, Date.now())) return [];
    if (activeRun) await interrupt('superseded');
    if (!started) await start();
    if (closed) return [];

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run: OutputRun = {
      epoch: epoch + 1,
      segments: new Map(),
      events: [],
      settled,
      settle,
      cancelled: false,
      reason: null,
      iterator: null,
    };
    epoch = run.epoch;
    activeRun = run;
    setOutput('generating');
    try {
      await runPlan(plan, run);
      return run.events;
    } finally {
      if (activeRun === run) activeRun = null;
      // A cancelled run keeps reporting the cancel; a finished run goes back to idle.
      setOutput(run.cancelled ? 'cancelled' : 'idle');
      settle();
    }
  };

  const interrupt = async (reason: string): Promise<void> => {
    const run = activeRun;
    activeReplay = null;
    // The epoch advances first: every frame still in flight is stale from this point on, whether
    // or not the run below ever produces another packet.
    epoch += 1;
    if (run) markCancelled(run, reason);
    try {
      // The device queue is dropped before the run finishes unwinding, so nothing that was queued
      // for the cancelled epoch can be rendered while the worker is still being stopped.
      await sink.flush();
    } catch {
      // Flushing is a local guarantee: a device that is already gone cannot make audio audible.
    }
    if (run) await cancelRun(run, reason);
  };

  const replay = async (segmentId?: string): Promise<void> => {
    if (closed) return;
    if (activeRun) await interrupt('replay');
    const target = segmentId === undefined ? lastCompletedSegment() : retained.get(segmentId);
    // Unheard audio is not replayable: a segment only earns a retained cursor once the device
    // rendered part of it, and only a completed sentence is replayed by default.
    if (!target || !target.audible || target.frames.length === 0) return;
    if (!sink.isOpen()) return;

    const generation = epoch + 1;
    epoch = generation;
    activeReplay = {
      epoch: generation,
      planId: target.planId,
      segmentId: target.segmentId,
      totalMs: target.totalMs,
      renderedMs: 0,
    };
    setOutput('buffering');
    let sequence = 0;
    for (const frame of target.frames) {
      if (closed || epoch !== generation) break;
      sink.write({
        epoch: generation,
        planId: target.planId,
        segmentId: target.segmentId,
        sequence,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        pcm: frame.pcm,
      });
      sequence += 1;
    }
  };

  const mute = async (): Promise<void> => {
    if (closed) return;
    await interrupt('mute');
    await input.mute();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    const run = activeRun;
    closed = true;
    activeReplay = null;
    epoch += 1;
    if (run) await cancelRun(run, 'close');
    if (unsubscribeProgress) {
      unsubscribeProgress();
      unsubscribeProgress = null;
    }
    try {
      await sink.flush();
    } catch {
      // Closing must settle even when the device is already gone.
    }
    try {
      await sink.close();
    } catch {
      // Closing must settle even when the device is already gone.
    }
    try {
      await input.close();
    } catch {
      // The microphone graph is released on a best-effort basis; the session is closed either way.
    }
    if (run) await run.settled;
  };

  return {
    start,
    pushInput: (frame) => input.pushInput(frame),
    submitSpeech,
    interrupt,
    mute,
    replay,
    status: () => ({ output, epoch }),
    close,
  };
}
