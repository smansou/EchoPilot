/**
 * Q04 cross-pillar evidence harness — the shared voice layer driven deterministically.
 *
 * The harness starts the *shipped* `createLocalVoiceSession` (`packages/voice/src/index.ts`) over a
 * scripted fake native host and a scripted local ASR engine, so the recovery drills and the
 * cross-pillar probe exercise the real permission, capture, transcript and host-event paths while
 * no microphone, worker or user data is involved.
 */
import { createLocalVoiceSession } from '../../../voice/src/index.js';
import type { AudioHostEvent, AudioFrame, LocalAsrEngine, LocalVoiceSession, NativeAudioHost } from '../../../voice/src/index.js';

export type VoiceHarnessOptions = Readonly<{
  permission?: 'granted' | 'denied' | 'unknown';
  /** Scripted utterances, consumed in order (cycled) by the fake local ASR engine. */
  utterances: readonly string[];
  sampleRate?: number;
  packetMs?: number;
}>;

export type VoiceHarness = Readonly<{
  session: LocalVoiceSession;
  pushFrames(count: number): Promise<void>;
  waitForCommitted(count: number, timeoutMs?: number): Promise<void>;
  transcriptTexts(): readonly string[];
  captureActive(): boolean;
  emit(event: AudioHostEvent): void;
}>;

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_PACKET_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createVoiceHarness(options: VoiceHarnessOptions): VoiceHarness {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const packetMs = options.packetMs ?? DEFAULT_PACKET_MS;
  const samplesPerPacket = Math.max(1, Math.round((sampleRate * packetMs) / 1_000));
  let onFrame: ((frame: AudioFrame) => void) | null = null;
  let listener: ((event: AudioHostEvent) => void) | null = null;
  let transcribeCall = 0;

  const host: NativeAudioHost = {
    permission: () => options.permission ?? 'granted',
    startCapture: async (frameListener) => {
      onFrame = frameListener;
    },
    stopCapture: async () => {
      onFrame = null;
    },
    captureActive: () => onFrame !== null,
    onEvent: (eventListener) => {
      listener = eventListener;
      return () => {
        listener = null;
      };
    },
  };

  const asr: LocalAsrEngine = {
    transcribe: async (window) => {
      const scripted = options.utterances[transcribeCall % Math.max(1, options.utterances.length)] ?? '';
      transcribeCall += 1;
      const words = scripted.split(/\s+/).filter((word) => word.length > 0);
      return {
        text: scripted,
        words: words.map((text, index) => ({
          text,
          startMs: index * 100,
          endMs: index * 100 + 90,
        })),
        // Endpoint every window: one scripted utterance commits per 400 ms partial window.
        endpoint: true,
      };
    },
  };

  const session = createLocalVoiceSession({ host, asr, maxQueuedFrames: 256 });

  const pushFrames = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      const pcm = new Uint8Array(samplesPerPacket * 2);
      for (let sample = 0; sample < samplesPerPacket; sample += 1) {
        const value = Math.round(2_400 * Math.sin(sample / 5));
        pcm[sample * 2] = value & 0xff;
        pcm[sample * 2 + 1] = (value >> 8) & 0xff;
      }
      await session.pushInput({
        sequence: index,
        sampleRate,
        channels: 1,
        monotonicNs: String(BigInt(index * packetMs) * 1_000_000n),
        pcm,
      });
    }
  };

  return {
    session,
    pushFrames,
    async waitForCommitted(count, timeoutMs = 5_000) {
      const startedAt = Date.now();
      while (session.transcript().length < count) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(
            `q04 voice harness: expected ${count} committed utterance(s) from the shared voice layer, `
            + `saw ${session.transcript().length} within ${timeoutMs} ms`,
          );
        }
        await sleep(5);
      }
    },
    transcriptTexts: () => session.transcript().map((entry) => entry.text),
    captureActive: () => host.captureActive(),
    emit: (event) => {
      listener?.(event);
    },
  };
}
