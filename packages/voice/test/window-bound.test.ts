/**
 * V01 window-bound regression — the frozen acceptance test only drives 20 ms packets, but the
 * exported judgment is "keep ASR windows ≤ 15 seconds" for every accepted `AudioFrame`. A host that
 * hands the session one oversized packet must not be able to open a window (or hand the local
 * engine PCM) longer than `ASR_MAX_WINDOW_MS`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ASR_MAX_WINDOW_MS, createLocalVoiceSession } from '../src/index.js';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1_000;

type AudioFrame = Readonly<{
  sequence: number;
  sampleRate: number;
  channels: number;
  monotonicNs: string;
  pcm: Uint8Array;
}>;

type LocalAsrWindow = Readonly<{
  utteranceId: string;
  startMs: number;
  sampleRate: number;
  channels: number;
  pcm: Uint8Array;
}>;

function silentFrame(sequence: number, durationMs: number, monotonicStartMs: number): AudioFrame {
  return {
    sequence,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    monotonicNs: String(BigInt(monotonicStartMs) * 1_000_000n),
    pcm: new Uint8Array(Math.round(durationMs * BYTES_PER_MS)),
  };
}

function windowDurationMs(window: LocalAsrWindow): number {
  return (window.pcm.byteLength / (window.channels * 2) / window.sampleRate) * 1_000;
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

test('one oversized frame cannot open an ASR window longer than the 15 s bound', async () => {
  const windows: LocalAsrWindow[] = [];
  let onFrame: ((frame: AudioFrame) => void) | null = null;
  const session = createLocalVoiceSession({
    host: {
      permission: () => 'granted',
      startCapture: async (listener) => { onFrame = listener; },
      stopCapture: async () => { onFrame = null; },
      captureActive: () => onFrame !== null,
      onEvent: () => () => undefined,
    },
    asr: {
      transcribe: async (window) => {
        windows.push(window);
        // Display-only results: the engine has not endpointed, so the utterance stays open.
        return { text: '', words: [], endpoint: false };
      },
    },
    maxQueuedFrames: 100,
  });

  await session.start();
  assert.equal(session.status().input, 'listening');

  const frameDurationMs = 16_000;
  const oversized = silentFrame(0, frameDurationMs, 1_000);
  await session.pushInput(oversized);

  // Without the split, the first partial hands the engine the whole 16 s packet.
  await waitUntil(() => windows.length >= 2);
  for (const window of windows) {
    assert.ok(
      windowDurationMs(window) <= ASR_MAX_WINDOW_MS,
      `ASR window at ${window.startMs} ms is ${windowDurationMs(window)} ms (> ${ASR_MAX_WINDOW_MS} ms)`,
    );
  }
  assert.ok(windows.length >= 2, 'the oversized frame was cut into several ASR windows');

  const last = windows[windows.length - 1];
  assert.ok(last, 'the engine received windows');
  assert.equal(
    last.startMs + windowDurationMs(last),
    frameDurationMs,
    'the split still covers all 16 s of the frame',
  );
  assert.ok(
    windows.reduce((total, window) => total + window.pcm.byteLength, 0) >= oversized.pcm.byteLength,
    'no PCM was dropped while splitting the frame',
  );

  await session.close();
});
