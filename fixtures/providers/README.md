# Provider fixtures (V04)

Normal CI never calls a paid service. The two files here are the recorded, redacted material the
V04 oracles replay:

- `v04-recorded-realtime-session.json` — one opt-in `gpt-realtime` WebSocket exchange with the
  client frames, the server event script, the negotiated 24 kHz PCM format and the provider usage
  numbers. Audio payloads are stored as `audio_bytes`/`duration_ms` pairs instead of base64 blobs;
  the oracle synthesizes zeroed PCM of the same length. The API key, the session key material and
  everything except the recorded answer text were removed before committing.
- `v04-grounded-question.json` — the held-out grounded session question, its memory scope, the
  evidence the memory tool must return, and the four answer segments used to assert that only
  actually played narration is ever marked as heard.

The paid path stays opt-in: `packages/voice/src/backends/acceptance.test.ts` runs the live
`gpt-realtime` test only when `ECHOPILOT_REALTIME_LIVE=1` and `OPENAI_API_KEY` are set, with a
dedicated low-cap test key (the ticket judgment). Without those variables the test is reported as
skipped and the deterministic fixtures above remain the acceptance evidence.
