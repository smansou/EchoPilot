export type PlaybackState = Readonly<{
  phase: 'idle' | 'speaking' | 'paused' | 'unavailable' | 'failed';
  current: string | null;
  lastHeard: string | null;
  remaining: number;
  error: string | null;
}>;

export type SpeechEngine = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'>;
export type SystemPlayback = Readonly<{
  state(): PlaybackState;
  subscribe(listener: (state: PlaybackState) => void): () => void;
  configure(input: { voiceURI: string; rate: number }): void;
  setMuted(muted: boolean): void;
  speak(text: string): void;
  stop(): void;
  clear(): void;
  resume(): void;
  replay(): void;
  dispose(): void;
}>;

/** Sentence progress comes only from speech callbacks, never from generated text. */
export function createSystemPlayback(options: {
  engine: SpeechEngine | null;
  utterance(text: string): SpeechSynthesisUtterance;
}): SystemPlayback {
  let state: PlaybackState = { phase: options.engine ? 'idle' : 'unavailable', current: null, lastHeard: null, remaining: 0, error: null };
  let queue: string[] = [];
  let voiceURI = '';
  let rate = 1;
  let muted = false;
  let disposed = false;
  let generation = 0;
  const listeners = new Set<(state: PlaybackState) => void>();
  const publish = (next: Partial<PlaybackState>) => {
    state = { ...state, ...next, remaining: queue.length };
    for (const listener of listeners) listener(state);
  };
  const interrupt = () => {
    generation += 1;
    options.engine?.cancel();
    // A partially spoken sentence is retained for an explicit Resume, never labelled heard.
    if (state.current !== null) queue.unshift(state.current);
    publish({ phase: queue.length ? 'paused' : options.engine ? 'idle' : 'unavailable', current: null });
  };
  const playNext = () => {
    if (disposed || muted || !options.engine || queue.length === 0) return;
    const text = queue.shift()!;
    const token = ++generation;
    const utterance = options.utterance(text);
    utterance.lang = 'en-US';
    utterance.rate = rate;
    const voices = options.engine.getVoices().filter((voice) => voice.localService);
    utterance.voice = voices.find((voice) => voice.voiceURI === voiceURI)
      ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('en')) ?? null;
    utterance.lang = utterance.voice?.lang ?? 'en-US';
    utterance.onstart = () => { if (token === generation && !disposed) publish({ phase: 'speaking' }); };
    utterance.onend = () => {
      if (token !== generation || disposed) return;
      publish({ phase: 'idle', current: null, lastHeard: text });
      playNext();
    };
    utterance.onerror = () => {
      if (token !== generation || disposed) return;
      queue.unshift(text);
      publish({ phase: 'failed', current: null, error: 'Speech did not complete. You can retry with Resume.' });
    };
    publish({ phase: 'speaking', current: text, error: null });
    try { options.engine.speak(utterance); }
    catch { utterance.onerror?.({} as SpeechSynthesisErrorEvent); }
  };
  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    configure(input) { voiceURI = input.voiceURI.slice(0, 1_024); rate = Number.isFinite(input.rate) ? Math.min(1.4, Math.max(0.8, input.rate)) : 1; },
    setMuted(value) { muted = value; if (muted) interrupt(); },
    speak(text) {
      if (disposed || muted || !options.engine || !text.trim()) return;
      interrupt();
      queue = text.slice(0, 4_000).split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim()).filter(Boolean).slice(0, 24);
      playNext();
    },
    stop: interrupt,
    clear() { generation += 1; options.engine?.cancel(); queue = []; publish({ phase: options.engine ? 'idle' : 'unavailable', current: null, lastHeard: null, error: null }); },
    resume() { if (state.phase !== 'speaking') playNext(); },
    replay() { if (!state.lastHeard || muted || disposed) return; interrupt(); queue = [state.lastHeard]; playNext(); },
    dispose() { interrupt(); disposed = true; queue = []; listeners.clear(); },
  };
}
