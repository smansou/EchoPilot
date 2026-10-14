/** Bind an utterance at its first observed partial/final, so late ASR cannot cross privacy/scope changes. */
export function createVoiceCaptureScope() {
  const captured = new Map<string, number>();
  return {
    accept(utteranceId: string, generation: number): boolean {
      if (!captured.has(utteranceId)) {
        captured.set(utteranceId, generation);
        if (captured.size > 512) captured.delete(captured.keys().next().value!);
      }
      return captured.get(utteranceId) === generation;
    },
  };
}
