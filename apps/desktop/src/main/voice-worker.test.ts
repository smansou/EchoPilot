import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createVoiceWorkerHost, resolveVoiceWorkerCommand } from './voice-worker';

test('the local worker forwards a validated final transcript to its desktop listener', async () => {
  const env = {
    ...process.env,
    ECHOPILOT_VOICE_WORKER: resolve('apps/desktop/src/main/fake-voice-worker.ts'),
    ECHOPILOT_FAKE_TRANSCRIPT_INTERVAL_MS: '30',
    ECHOPILOT_FAKE_TRANSCRIPT_COUNT: '1',
  };
  const worker = createVoiceWorkerHost({ command: resolveVoiceWorkerCommand(env), env });
  try {
    await worker.load();
    const heard = new Promise<string>((resolveHeard, reject) => {
      const timer = setTimeout(() => reject(new Error('No final transcript arrived.')), 2_000);
      const stop = worker.onTranscript((update) => {
        if (update.phase !== 'final') return;
        clearTimeout(timer);
        stop();
        resolveHeard(update.text);
      });
    });
    await worker.openMicrophone();
    assert.equal(await heard, 'hands-free exchange 1');
  } finally {
    await worker.unload();
    worker.dispose();
  }
});
