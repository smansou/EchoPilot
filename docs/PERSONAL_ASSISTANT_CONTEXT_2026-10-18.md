# Personal assistant context, memory and wake voice

Source base: `df97a63` (the completed hands-free gaze work in **Fix gaze tracking and outlining**). Work is isolated on `feature/personal-assistant-context`. The other chat's checkout and the installed app have not been changed.

## Product behavior

- Claude Code and Codex session discovery includes archived Codex sessions. A local SQLite FTS5 index stays warm independently of voice questions. Opening metadata remains discoverable for older sessions; recent sessions retain richer excerpts. Explicit historical retrieval can page through 8 MiB ranges and includes recent tail evidence. Source references identify actual byte offsets; malformed or enormous tool records cannot block later progress.
- Initial voice context reserves space for explicit commitments, recent dialogue, sourced research, session identities and rich raw excerpts. Its default budget is 6,000 estimated o200k tokens, leaving room for screen evidence within GPT-Live's 8,192-token startup history limit. Text field limits and Unicode handling apply before expensive tokenizer work.
- Background changes push small dated updates, not repeated paid research calls. Question-time local retrieval starts after a 120 ms debounce, without requiring another cloud model call. Known follow-ups can use context already supplied. Deeper synthesis still uses the configured reasoning provider when needed.
- Saved-record timestamps and explicitly reported working/waiting/interrupted states are evidence, **not proof of an external process's current state**. Missing coverage is exposed rather than invented.
- User preferences, decisions and unfinished work have their own encrypted, bounded memory. New entries fail with a useful message at capacity; existing commitments are never evicted just because they are old. Users can remember/resolve items by voice or in Assistant & memory settings.
- GPT-Live's native background compaction remains enabled. Gemini has an explicit sliding window. App-owned commitments and CLI task receipts live outside those provider windows. Deduplicated app context has an append budget; at a quiet boundary, a replacement session restores current evidence, commitments and recent dialogue. This can briefly reconnect audio; it does not repeat a coding operation.
- Inactivity defaults to 60 seconds and can be set to 30 seconds, two minutes, five minutes or Never. Pending delegated work prevents idle teardown. Live audio disconnects on sleep; an optional local wake listener can remain active.
- “Hang up” and “go to sleep” work locally, including fragmented transcripts, without waiting for a reasoning request. Backend tools also expose these controls.
- Coding requests can run asynchronously through installed Codex or Claude Code CLIs. Existing source sessions are forked, and task status/results/cancellation are available through voice and settings. These tasks use the selected project's directory. Codex retains a workspace-write sandbox and refuses operations needing an unavailable approval; Claude retains its default permission mode. There are no permission-bypass flags. Permission denial, process exit without a completed turn, and cancellation cannot become a successful completion receipt. CLI authentication/version availability is required; no real coding task or paid call was run during this work.

## Offline wake phrases

The recognizer is upstream **sherpa-onnx 1.13.8**, using the Apache-2.0 GigaSpeech Zipformer KWS model. SentencePiece uses the model's own BPE vocabulary; there is no custom acoustic detector or hand-written tokenizer. Model archives and individual model files are checksum pinned in `models/wake-manifest.json`. `pnpm models:wake` reproduces the explicit model download; regular builds do not download anything.

Current wake phrase language is English. The user supplies a phrase, records three short positive attempts and ten seconds of background speech. The local worker evaluates four thresholds and selects measured sensitivity. Wake listening cannot be enabled until all three attempts are detected with no false-trigger sample. Changing the phrase disables listening and invalidates its calibration. The displayed 0–100 score is a **short calibration score, not a probability of real-world reliability**; it cannot establish a false-alarm rate from long background exposure. Recheck after a microphone or environment change.

Standby recognition runs in an isolated Node child; ONNX work does not block the UI. Capture, inference queues and opening speech buffers are bounded. The opening speech handoff retains audio while voice connects, plays speech at its original rate, and catches up during silence. Overflow reports a failure rather than silently discarding the beginning of a request. Private/muted state, recording failures, teardown and cancellation close local capture. Calibration audio is not written to disk. The local index is memory-only and its bounded restart snapshot uses Electron safeStorage with no plaintext fallback.

## Verification and practical limits

The user expressly requested **no opening apps, clicking, screenshots, camera or microphone use on their working screen**. Checks used Node processes, fake browser/media objects, synthetic filesystem fixtures and upstream public KWS audio. Nothing was installed or relaunched. A signed local development bundle is prepared at `artifacts/local-app/EchoPilot-assistant-context-20261018.app`; it is ad-hoc signed, not notarized or a distribution release. The Keychain helper is included from the existing qualified build; no key was accessed.

- Full project checks: **739 Node tests**, generated contracts, TypeScript and production build; **26 packaging tests** also passed. Restricted execution initially failed only the existing localhost connector fixtures; those passed with localhost access in the background host context.
- Session tests cover incremental appends, absent trailing newline, older discovery, 18 MiB tool records, paged historical decisions, deletion and privacy revocation.
- Continuity tests cover retained commitments and ordered dialogue across restart, capacity without eviction, token bounds, local prefetch, hang-up, sleep and canceled work.
- Media fixtures cover startup speech replay, catch-up, explicit eight-second overflow, microphone/peer cleanup and muting queued audio.
- Task fixtures verify argv/stdin isolation, source forks, capacity reservation, cancellation and truthful completion receipts without launching real coding agents.
- A synthetic **500-session** benchmark measured **0.735 ms p95** for warmed local search, **103 ms** cold index preparation and **16.42 ms** seed construction on this host. This is local retrieval performance, **not end-to-end voice response latency**.
- Real ONNX inference on the upstream 16.715-second public clip detected all three replayed positives at thresholds 0.2 and 0.35, with no detections on the ten-second silence sample; thresholds 0.5 and 0.65 missed the positives. Four-threshold evaluation took about 5.7 seconds under Node and 7.4 seconds under Electron's Node-only runtime. The fixture's WAV reader uses ordinary JavaScript-owned buffers because Electron rejects the native addon's external-buffer WAV helper; production already uses JavaScript-owned AudioWorklet buffers. Public replay does **not** establish accuracy for the user's voice, phrase, room or background speech.
- Electron's Node-only background runtime successfully created an in-memory SQLite FTS5 table. The signed packaged runtime also passed the same real KWS replay in about 6.1 seconds. These processes did not open a GUI.

Actual provider access, answer quality in spoken conversation, hardware microphone transitions, personal wake calibration, long background false-trigger exposure and real CLI task execution remain unverified. No screen-based acceptance is claimed.

## Sources and dependencies

- [OpenAI GPT-Live session management](https://developers.openai.com/api/docs/guides/live-conversations): startup input, timed append acknowledgments, native compaction and sleep/resume.
- [Google Live API](https://ai.google.dev/api/live): context-window compression.
- [sherpa-onnx keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html): open-vocabulary phrases and threshold tradeoffs.
- [KeywordSpotter Node API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_keyword_spotter.html).
- [Claude Code headless interface](https://code.claude.com/docs/en/headless), plus installed CLI help for the actual supported flags.
- `js-tiktoken@1.0.21` (MIT, only o200k ranks bundled), `@sctg/sentencepiece-js@1.3.3` (Apache-2.0), `sherpa-onnx-node@1.13.8` (Apache-2.0), bundled ONNX Runtime 1.28.2 (MIT). License texts are in `models/licenses/` and travel with local app bundles.
