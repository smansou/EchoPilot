/**
 * V05 fake local voice worker — a drop-in stand-in for `echopilot-voice`.
 *
 * `voice-worker.ts` treats the worker as *model residency*: `hello` means the conversation pack is
 * loaded, `{"type":"start"}` opens the microphone and reports `listening`, `{"type":"close"}` frees
 * the pack and exits. This stand-in speaks exactly that stdio protocol so the hands-free lifecycle
 * can be driven end to end without the pinned ASR pack or a microphone:
 *
 *   ECHOPILOT_VOICE_WORKER=apps/desktop/src/main/fake-voice-worker.ts pnpm dev
 *   ECHOPILOT_FAKE_TRANSCRIPT_INTERVAL_MS=2500   periodic transcript frames (conversation activity)
 *   ECHOPILOT_FAKE_TRANSCRIPT_COUNT=6            stop after this many frames (0 = keep talking)
 *
 * A transcript frame is what renews the session: the lifecycle listens to the same activity the
 * conversation produces, not to UI events, so a long exchange never needs a keepalive.
 */
import { createInterface } from 'node:readline';

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

send({ type: 'hello', status: { input: 'idle', asr: 'fake-small.en', models: 'resident' } });

const transcriptIntervalMs = Number(process.env.ECHOPILOT_FAKE_TRANSCRIPT_INTERVAL_MS ?? '0');
const transcriptCount = Math.trunc(Number(process.env.ECHOPILOT_FAKE_TRANSCRIPT_COUNT ?? '0'));
let transcriptTimer: NodeJS.Timeout | null = null;
let transcriptIndex = 0;

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let type: unknown;
  try {
    type = (JSON.parse(trimmed) as { type?: unknown }).type;
  } catch {
    process.stderr.write('fake-voice-worker ignored a non-JSON command\n');
    return;
  }
  if (type === 'start') {
    send({ type: 'status', status: { input: 'listening', asr: 'fake-small.en', models: 'resident' } });
    if (Number.isFinite(transcriptIntervalMs) && transcriptIntervalMs > 0) {
      transcriptTimer = setInterval(() => {
        if (transcriptCount > 0 && transcriptIndex >= transcriptCount) {
          if (transcriptTimer) clearInterval(transcriptTimer);
          transcriptTimer = null;
          return;
        }
        transcriptIndex += 1;
        send({ type: 'transcript', text: `hands-free exchange ${transcriptIndex}`, final: false });
      }, transcriptIntervalMs);
    }
    return;
  }
  if (type === 'close') {
    if (transcriptTimer) clearInterval(transcriptTimer);
    transcriptTimer = null;
    input.close();
    process.exit(0);
  }
});
input.on('close', () => { process.exit(0); });
