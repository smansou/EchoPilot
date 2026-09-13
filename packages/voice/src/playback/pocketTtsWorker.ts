/**
 * App-side port for the bundled Pocket TTS worker (`workers/pocket-tts/`).
 *
 * The Electron main process owns the process: it starts `workers/pocket-tts/run.sh` (bundled
 * CPython inside the worker directory, denied network, no downloads — see the worker's
 * `runtime.json`) and hands this module the stdio pipe pair. This module therefore has no process,
 * socket or filesystem surface of its own: it frames one JSON request per segment, correlates the
 * `frame` / `done` / `cancelled` lines back to the segment that asked for them, and decodes the
 * base64 int16 packets into the playback session's `synthesize()` iterable.
 */

import type { PcmFrame, SpeechSynthesisWorker, SynthesisRequest } from './index.js';

/** One line-oriented pipe pair to the bundled worker. */
export type PocketTtsTransport = Readonly<{
  write(line: string): void;
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
}>;

export type PocketTtsReady = Readonly<{
  sampleRate: number;
  channels: number;
  packetMs: number;
  model: string;
  voices: ReadonlyArray<string>;
}>;

export type PocketTtsWorkerPort = SpeechSynthesisWorker &
  Readonly<{
    /** Resolves with the worker's `ready` line; rejects when the bundle is unusable. */
    ready(): Promise<PocketTtsReady>;
    close(): Promise<void>;
  }>;

type Waiter = {
  resolve(result: IteratorResult<PcmFrame>): void;
  reject(error: Error): void;
};

/** A single-consumer push queue: the worker pump pushes, the session's `for await` pulls. */
function createFrameQueue(): {
  push(frame: PcmFrame): void;
  end(): void;
  fail(error: Error): void;
  iterable: AsyncIterable<PcmFrame>;
} {
  const buffered: PcmFrame[] = [];
  const waiters: Waiter[] = [];
  let finished = false;
  let failure: Error | null = null;

  const deliver = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) return;
      if (buffered.length > 0) {
        const frame = buffered.shift();
        if (!frame) return;
        waiter.resolve({ value: frame, done: false });
        continue;
      }
      if (failure) {
        waiter.reject(failure);
        continue;
      }
      if (finished) {
        waiter.resolve({ value: undefined as never, done: true });
        continue;
      }
      return;
    }
  };

  return {
    push: (frame) => {
      if (finished) return;
      buffered.push(frame);
      deliver();
    },
    end: () => {
      if (finished) return;
      finished = true;
      deliver();
    },
    fail: (error) => {
      if (finished) return;
      failure = error;
      finished = true;
      deliver();
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<PcmFrame> {
        return {
          next: (): Promise<IteratorResult<PcmFrame>> => {
            const frame = buffered.shift();
            if (frame) return Promise.resolve({ value: frame, done: false });
            if (failure) return Promise.reject(failure);
            if (finished) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise<IteratorResult<PcmFrame>>((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return: (): Promise<IteratorResult<PcmFrame>> => {
            finished = true;
            buffered.length = 0;
            deliver();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    },
  };
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decodePcm(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(String(value ?? ''), 'base64'));
}

export function createPocketTtsWorker(options: Readonly<{ transport: PocketTtsTransport }>): PocketTtsWorkerPort {
  const { transport } = options;
  const queues = new Map<string, ReturnType<typeof createFrameQueue>>();
  let pump: Promise<void> | null = null;
  let ready: PocketTtsReady | null = null;
  let readyFailure: Error | null = null;
  let resolveReady: ((value: PocketTtsReady) => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;

  const readyPromise = new Promise<PocketTtsReady>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The worker is expected to be usable whether or not a caller awaits `ready()`.
  readyPromise.catch(() => undefined);

  const queueFor = (segmentId: string): ReturnType<typeof createFrameQueue> => {
    const existing = queues.get(segmentId);
    if (existing) return existing;
    const created = createFrameQueue();
    queues.set(segmentId, created);
    return created;
  };

  const handleLine = (line: string): void => {
    const text = line.trim();
    if (text === '') return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      // A malformed line is a worker bug, not audio; the segment that is waiting times out instead
      // of receiving a frame nobody can vouch for.
      return;
    }
    const type = optionalString(message.type);
    if (type === 'ready') {
      ready = {
        sampleRate: Number(message.sampleRate ?? 0),
        channels: Number(message.channels ?? 0),
        packetMs: Number(message.packetMs ?? 0),
        model: optionalString(message.model),
        voices: Array.isArray(message.voices) ? message.voices.map((voice) => String(voice)) : [],
      };
      resolveReady?.(ready);
      return;
    }
    const segmentId = optionalString(message.segmentId);
    const queue = queues.get(segmentId);
    if (type === 'frame') {
      if (!queue) return;
      const sequence = Number(message.sequence ?? 0);
      const sampleRate = Number(message.sampleRate ?? 0);
      const channels = Number(message.channels ?? 0);
      queue.push({ sequence, sampleRate, channels, pcm: decodePcm(message.pcm) });
      return;
    }
    if (type === 'done' || type === 'cancelled') {
      queue?.end();
      queues.delete(segmentId);
      return;
    }
    if (type === 'error') {
      const failure = new Error(
        `pocket-tts worker error ${optionalString(message.code) || 'unknown'}: `
        + `${optionalString(message.message) || 'no detail'}`,
      );
      if (queue) {
        queue.fail(failure);
        queues.delete(segmentId);
      }
      if (ready === null) {
        readyFailure = failure;
        rejectReady?.(failure);
      }
    }
  };

  const ensurePump = (): void => {
    pump ??= (async () => {
      try {
        for await (const line of transport.lines()) handleLine(line);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const queue of queues.values()) queue.fail(failure);
        queues.clear();
        if (ready === null) {
          readyFailure = failure;
          rejectReady?.(failure);
        }
        return;
      }
      // The worker exited: every segment still waiting is over, and `ready` never arrived.
      for (const queue of queues.values()) queue.fail(new Error('the pocket-tts worker exited'));
      queues.clear();
      if (ready === null) {
        readyFailure = new Error('the pocket-tts worker exited before it reported ready');
        rejectReady?.(readyFailure);
      }
    })();
  };

  const synthesize = (request: SynthesisRequest): AsyncIterable<PcmFrame> => {
    ensurePump();
    const queue = queueFor(request.segmentId);
    transport.write(JSON.stringify({
      type: 'synthesize',
      planId: request.planId,
      segmentId: request.segmentId,
      text: request.text,
      voiceId: request.voiceId,
      epoch: request.epoch,
    }));
    request.signal?.addEventListener('abort', () => {
      if (!queues.has(request.segmentId)) return;
      transport.write(JSON.stringify({ type: 'cancel', segmentId: request.segmentId }));
    });
    return queue.iterable;
  };

  return {
    synthesize,
    ready: () => {
      // Awaiting `ready()` before the first synthesis must still start the stdout pump.
      ensurePump();
      if (ready !== null) return Promise.resolve(ready);
      return readyFailure === null ? readyPromise : Promise.reject(readyFailure);
    },
    close: async () => {
      transport.write(JSON.stringify({ type: 'close' }));
      await transport.close();
      await pump?.catch(() => undefined);
    },
  };
}
