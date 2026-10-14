# Native live voice

Updated October 3, 2026. This document supersedes the earlier GPT-Realtime implementation.

## Product and setup

Dictation and live conversation are separate. Control+Option+Space records, refines and inserts text. Option+Space opens a continuous native audio conversation in the same notch. Press it again to finish. No local speech model download is required.

General → Your connection offers Gemini and OpenAI presets. Advanced separates live voice from reasoning/dictation. To use OpenRouter, enable custom choices, select OpenRouter for reasoning, enter its model and save its key; choose Gemini or OpenAI for native live voice and save that service's key too. A ChatGPT subscription is not an API key. A saved key is labeled “Keys saved,” not a verified provider connection.

The interface uses mint/violet accents, a softly animated orb, a compact dark notch, visible focus states and reduced-motion support. Customization remains available without putting protocol controls in normal conversation.

## Architecture

- `live-session.ts` owns conversation fragments, shared context, delegated work, cancellation, history and provider-independent state.
- `openai-live.ts` connects GPT-Live-1 over WebRTC with an authenticated main-process sideband. Client delegation feeds EchoPilot's backend. There are no old Realtime `response.create` or direct voice-model tool definitions.
- `gemini-live.ts` connects Gemini 3.8 Live over a main-process WebSocket. Renderer AudioWorklet capture sends 16 kHz PCM; the renderer plays 24 kHz output and flushes queued audio on provider interruption. The key never reaches the renderer.
- `agent-backend.ts` is a bounded tool loop using the separately selected OpenAI-compatible reasoning provider: OpenAI, Gemini or OpenRouter. The live provider does not dictate the backend.
- `desktop-session.ts` handles dictation only. Gemini dictation uses native audio understanding; OpenAI and OpenRouter use their transcription endpoints.

Startup context reserves space for sourced briefs and recent conversation before the session catalogue. Each field is bounded without splitting Unicode, and the complete structured seed stays within 7,000 UTF-8 bytes. Long discovery lists cannot crowd known context out. Abridged briefs are labeled so missing details can be retrieved.

Live models answer from their existing conversation when possible. They delegate missing evidence or actions; no forced lookup runs on every question. The backend can list saved Claude/Codex sessions, retrieve sourced briefs, inspect screen/gaze evidence, prepare a supported desktop action, and commit after a new exact spoken confirmation. These are the implemented tools; arbitrary shell execution and control of another coding agent are not exposed.

Local session discovery needs no separate coding-agent setup. Bounded evidence goes to a research model, which produces a brief with validated references and explicit uncertainty. Up to three briefs are retained; unchanged questions reuse cached evidence, and changed sources can refresh quietly while idle. This supports questions and brainstorming, but saved records are not guaranteed live agent state.

Screen context uses Accessibility first, with a single screenshot fallback where permitted and useful. Secure/excluded observations do not trigger fallback. Gaze is a recent stable cluster and target description, not a mouse movement or continuous image stream.

The backend validates supported operations, target identity and a later spoken confirmation. Cancellation and request revisions prevent stale actions; late answers are not announced as current. OpenAI closure waits for `session.closed` before transport teardown, with a bounded timeout and explicit unconfirmed finalization. No generic “thinking level” is sent to voice models that do not support it.

## Verification and limits

Protocol tests cover both native adapters, context bounds, tool scheduling, finalization and cancellation. Shared tests cover retained knowledge, late transcripts, stale results, tool ordering and spoken confirmation.

- `node scripts/realtime-media-smoke.mjs`: actual local bidirectional Chromium WebRTC with synthetic tones; microphone release verified.
- `node scripts/live-pcm-smoke.mjs`: actual AudioWorklet capture, 640-byte PCM frames, playback, interruption and cleanup, using synthetic tones.
- `node scripts/desktop-ui-smoke.mjs`: rendered settings and provider selection checks with disposable fixtures; screenshots in `artifacts/ui-live`.
- `docs/OPENROUTER_LIVE_BACKEND_ACCEPTANCE.json`: real paid OpenRouter tool loop on invented session evidence, with no microphone or project data. Discovery and research returned the correct offline-SQLite rationale in about four seconds.

`docs/OPENROUTER_DICTATION_ACCEPTANCE.json` records real WebM/Opus transcription and strict refinement on a locally synthesized sentence. Transcription took 1,316 ms; the corrected refinement took 1,237 ms and reproduced the intended sentence exactly. The first refinement added an unsupported modifier; the stricter prompt corrected it. No microphone or actual project content was used.

Native OpenAI and Gemini service conversations have NOT been tested with valid direct keys. Local transport and mock protocol tests do not establish provider account access, actual speech latency/quality or long-session reliability. Real cross-app insertion, microphone interruptions and gaze accuracy still need device acceptance. The current app is an ad-hoc signed local development build, not a notarized release.

Removed: OpenAI GPT-Realtime-specific application path and obsolete provider simulator, reviewed-text premium voice runtime/playback/IPC, the dead Mission Control renderer, and the turn-based dictation-as-agent path. Original backlog documents may still describe historical architectures.

## Protocol references

- [OpenAI GPT-Live migration](https://developers.openai.com/api/docs/guides/live-migration)
- [OpenAI delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)
- [Gemini FunctionResponse schema](https://ai.google.dev/api/generate-content#FunctionResponse) (the scheduling field is on the function response, not nested in arbitrary result data)
- [Gemini live tools](https://ai.google.dev/gemini-api/docs/live-api/tools)
- [OpenRouter transcription](https://openrouter.ai/docs/api/api-reference/stt/create-transcription)
