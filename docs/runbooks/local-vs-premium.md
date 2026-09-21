# Local vs premium: what runs where

EchoPilot ships two execution profiles. Both produce the same dictation, local conversation,
memory and narration features; they differ in *where the reasoning runs*, not in what the app can
do.

## Local (bundled, no account, no key)

The full offline installer embeds every model asset: Whisper `small.en` for dictation, Qwen3.5-4B
(4-bit) for local conversation and routing, Pocket TTS weights and a cleared voice preset for
narration, plus the bundled CPython runtime the worker executes in. `models/manifest.json`
publishes the exact revision, byte length, licence and SHA-256 pin for each asset, and
`scripts/release/verify-pack.mjs` refuses to install a pack whose bytes do not match. Local work
runs with **no API key** and performs no runtime downloads, so dictation continues on a plane, in
a locked-down office, or on a fresh Mac with no account at all.

## Premium / BYOK (bring your own key)

If you configure a provider API key (**Settings → Intelligence → Premium**), EchoPilot may send
the requests you opt into to that provider for larger models, cross-document summaries or the
provider's own speech engine. Premium is additive: when the key is missing, expired or the network
is unavailable, the app falls back to the bundled local assets and labels the session "local
fallback" rather than failing the utterance.

## No substitution

EchoPilot never substitutes a provider or model behind your back. A local session cannot be
silently upgraded to a cloud call, and a premium request is never quietly answered by the small
local model while still being billed as premium — the active engine is shown in the session
header and written into the memory record. Premium requests also never receive data you did not
include: no ambient transcripts, no screen context, no memory export, unless you select that
context for the request.

## Choosing

Choose local for anything sensitive, offline or latency-critical. Choose premium when you need a
larger model's breadth and have reviewed your provider's data policy. Switching is per-request,
reversible, and logged with the engine that produced each answer.
