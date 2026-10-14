# Original-ticket acceptance ledger

This maps every `BACKLOG.json` ticket to implementation and executable evidence. A test's
existence or a fixture passing is not proof that the original real-world acceptance is met.
The repository's historical ticket state is not rewritten by this ledger. “Remaining” is
work or measurement required to claim the original ticket completely accepted, even when
the local API-first app has a useful working implementation.

## Evidence obtained in this completion session

- Local packaging tests: 26/26 passed (`node --test scripts/package-local.test.mjs`),
  including relative Electron framework symlink preservation during packaging.
- Delivered local checkpoint: `artifacts/local-app/EchoPilot-0.1.0-2026-09-30-203106Z-0316f8.app`.
  Its adjacent `.app.qualification.json` records `local-qualified` at
  `2026-09-30T20:31:49.932Z`: strict deep signature/plist verification; two hidden
  disposable-profile launches exercising IPC, settings persistence, private-session guards,
  encrypted memory/forget, renderer isolation and restart identity; and real microphone capture,
  Whisper model loading followed by capture/model release (`voiceCaptureChecked: true`).
  Both ASR/VAD packs and the helper's VAD copy match measured manifest digests. A physical
  payload inventory found no denied files, user records, credentials or local reasoner pack.
  Electron launches require the approved execution environment outside the tool sandbox;
  the preliminary sandbox-aborted run was replaced by the successful full qualification.
  This is ad-hoc signed, not notarized and not distributable; it does not establish the
  outstanding live interaction, hardware, model-quality or original-ticket performance gates.
- Voice playback acceptance harness: 3/3 passed (`node --import tsx --test
  packages/voice/src/playback/acceptance.test.ts`). These use simulated devices/workers,
  so they do not prove original Pocket TTS runtime availability.
- Native VAD/bootstrap tests: 2/2 passed (`swift test --package-path
  native/macos/Sources/ASR --filter Silero`).
- Actual pinned neural VAD: 1/1 passed with `ECHOPILOT_SILERO_MODEL_DIR=<repo>/models/asr
  swift test --package-path native/macos/Sources/ASR --filter RealSileroPackTests`.
  This loads the real CoreML model and tests FP16 recurrent inference and reset.
- Silero vendor verification recomputed the actual directory SHA256 and size:
  `63c7e43a7bffa7c3562cc05187f549537bf8b02a137b4c4af817295c7c239891`, 640986 bytes.
- Native voice helper rebuilt, ad-hoc signed and strict signature verified. Its linked
  dependencies are Apple/system libraries, not a developer's Swift build directory.
- Full ASR suite: 20 pipeline tests passed; actual Silero integration passed. The
  actual Whisper speech test then passed separately (1/1, 7.16 s) using a disposable
  synthetic macOS-narrated 16 kHz mono fixture; no private microphone recording was used.
- Actual helper startup loaded the real WhisperKit weights, sent its hello, and quit
  cleanly in 3,636 ms on this Mac. The local implementation caches a CPU/GPU WhisperKit
  per session; ANE cold specialization exceeded 30 seconds during investigation.
- Packaged launch and microphone evidence are written per artifact by
  `pnpm package:verify <bundle.app> [--voice]`; inspect the dated JSON next to that app.
  A report without `voiceCaptureChecked: true` does not establish a microphone grant.
- Full project tests/build/typecheck and interactive app evidence are recorded in the
  integration handoff and local qualification report, rather than inferred from this inventory.

## Ticket map

Paths below are repository-relative. “Harness” means deterministic or injected tests;
“live” means the real helper/service/desktop, when separately evidenced.

| Ticket | Implemented code and test evidence | Runtime acceptance still required |
| --- | --- | --- |
| F01 | Electron main/preload/renderer; `scripts/smoke.mjs` validates IPC, private encrypted memory, persistence/restart, isolation and dashboard lifecycle. | Packaged disposable-profile smoke must pass for the delivered artifact. |
| F02 | PlatformHost + tray/shortcuts/widget; helper message validation and disconnect recovery. | Full-screen, workspace switching, focus retention, shortcut conflict and OS matrix. |
| F03 | `packages/core/src/settings`, control settings surfaces; `f03.effective-settings` and `f03.settings-surface` tests. | VoiceOver and keyboard traversal of every primary control on the delivered build. |
| S01 | Capability grants/revocation and native Keychain secrets; `packages/security/test/acceptance`. | Real Keychain provider configuration/revocation across restart, with approved account/key. |
| S02 | Scoped broker, durable outbox, permission history; `s02` broker/outbox/history tests. | Real managed harness approval/receipt reconciliation under transport loss. |
| S03 | Private mode, encrypted export/forget and import tombstones; privacy/deletion tests and smoke. | Full installed-profile export/restore/forget journey, including all cached speech text. |
| S04 | Execution grants, managed process observations; security/desktop command `s04` tests. | VM mount/network canary isolation and native host process-group cancel measurements. |
| V01 | Microphone graph, local WhisperKit, real pinned Silero, voice helper; V01 pipeline + real model tests. | Real 15-second utterance with timestamps, bounded capture, denial/removal/lock/crash journeys on packaged app. |
| V02 | Speech planning/playback epochs/replay, macOS system narration; playback harness passes. | Original Pocket TTS weights + standalone runtime are absent/gated; signed offline duplex/replay quality not qualified. System narration is an available local implementation, not evidence of Pocket TTS completion. |
| V03 | Duplex interruption classification and cancellation; duplex fixture harness. | Reference-machine p95 interruption timing and held-out human backchannel precision. |
| V04 | BYOK realtime adapter and restart/cost/privacy budgets; recorded provider harness. | Explicitly opted-in real provider test, grounded answer, barge-in and rollover; no paid call assumed. |
| V05 | Voice residency, inactivity/standby control and energy harness. | 20-minute live hands-free interaction, actual energy measurement and TV false-trigger report. |
| A01 | Scoped capture, native compare-write insertion and target binding; capture + DictationCompareWrite tests. | Live VS Code/TextEdit/browser insertion, undo and changed-focus draft preservation matrix. |
| A02 | Evidence-bound technical correction; paired correction fixtures and tests. | Warm real-model latency and harmful-edit gates on held-out speech/screenshots. |
| A03 | Project glossary and committed-window concatenation; glossary acceptance. | Live corrected proper-name reuse across restart and long dictation. |
| A04 | Dictation eval and corpus validator; `a04.acceptance`. | Real held-out ≥25% technical-term improvement/≤1% harmful edits and app/clipboard/undo measurements. |
| H01 | Codex app-server adapter, project/task handoff; `h01` and managed-work tests. | Real installed Codex session, approved task, interrupt/resume and observation receipts. |
| H02 | Claude managed/hook adapter; harness acceptance. | Installed Claude hook timing/installation/removal and actual managed second prompt. |
| H03 | Bounded JSONL/text import parser and timeline preview; generic import fixtures. | Actual 10 GB generated log memory/resume/rotation measurements. |
| H04 | Session registry, routing destination, reconciliation; `h04.acceptance`. | Two real Codex and one real Claude sessions under disconnect/reconnect. |
| M01 | Encrypted durable event storage/source links and idempotency; store acceptance + smoke. | Full DB/WAL/FTS canary and crash cursor validation on installed profile. |
| M02 | Bounded consolidation, extraction, API-first grounded answers; consolidation/project-answer tests. | Original local extraction reasoner pack/runtime absent; real-model multi-turn quality/compaction measurements. |
| M03 | Resumable imported observations and preview coverage; import acceptance. | Killed 10 GB real import and live/import equivalence at scale. |
| M04 | Temporal memory records, user corrections/evidence; records acceptance. | Interactive decision-reversal journey with current/historical answers and visible extraction coverage. |
| M05 | Hybrid retrieval, retention capsules, quotas; retrieval/retention acceptance. | Multi-day held-out temporal QA/model quality and quota/worker-failure measurements. |
| N01 | Evidence-grounded outcome narration and replay; `n01.acceptance`. | Real managed observed test exit → one spoken outcome; provider/installed narration check. |
| N02 | Typed claims and concise/thorough chapters; `n02.acceptance`. | Held-out 200-run critical recall/factuality gates, human listening quality. |
| N03 | Speech queue budgets, supersession and unheard chapters; `n03.acceptance`. | Three real concurrent sessions and interrupted spoken digest journey. |
| R01 | Grounded questions vs named-agent routing; routing acceptance + project answers. | Real voice memory question and authorized managed-session delivery; held-out ≥99% auto-dispatch precision. |
| R02 | Shared attention/lease policy and late output suppression; `r02.acceptance`. | Live all-pillar lease revoke/preemption with actual output device and user speech. |
| R03 | Bound conversation state, expiry and stop-all receipts; `r03` adversarial/dialogue tests. | Real managed stop acknowledgments plus explicit reporting of external processes still running. |
| C01 | Scope-bound foreground AX observation + desktop question panel/API-first explanation; C01/desktop-observe/desktop-answer tests. | Browser error/IDE control live answers, approved provider and native AX permission; screenshot path separately measured. |
| C02 | Target-bound proposals/grants/AX before-after receipts; C02 action/lifecycle/native cross-language tests. | Live authorized field edits, changed-focus rejection and between-step cancellation. |
| C03 | Structured editor/browser integrations + stale visual target checks; C03 integration/visual tests. | Real authenticated extension/browser/editor workflows with measured focus interference. |
| C04 | Compact desktop history and changed-only sampling; C04 history/sampling tests. | Day-long live/replay capture energy/frequency measurements and revoke/private purge checks. |
| G01 | Webcam calibration/sample schema and uncertainty resolver; G01 fixture tests. | Actual camera calibration, held-out participant target improvement and no-frame-retention inspection. |
| G02 | Explicit consequential-action confirmation and stale target rejection; G02 action tests. | Real gaze + spoken ambiguity/confirmation interaction through native targets. |
| G03 | Dedicated-device bridge/schema and quality reporting; G03 device/eval tests. | Actual supported device/SDK/OS test matrix and participant variation/abstention measurements. |
| Q01 | Deterministic replay/scored reports and adversarial fixtures. | Separately reported actual model quality and human ratings; fixture correctness alone is insufficient. |
| Q02 | Accelerated replay/backpressure/recovery counters and scheduler acceptance. | Dated ≤10-minute reference-Mac qualification with actual resource peaks and all required failure counters. |
| Q03 | Installer staging/verification/rollback code + Q03 harness; honest local ad-hoc packaging. | Fresh Mac offline A+B, original complete model/runtime pack, provisioned Developer ID signing, notarization/stapling and measured quality gates. |
| Q04 | Adversarial/recovery/reliability qualification CLIs + Q04 harness. | Full A–D real use, native fault drills and ≥1,000 beta session crash-free ledger; no synthetic ledger substitutes for beta measurement. |

## Known external/runtime gates

Pocket TTS's [official model repository](https://huggingface.co/kyutai/pocket-tts) requires
the user to accept access conditions and share contact information. This session has not
accepted those terms, authenticated to download it, or replaced its required original
asset with an unaudited mirror. Existing Pocket TTS/runtime/reasoner manifest rows are
unverified planned artifact records, not evidence that those payloads exist locally.
The actual Whisper/Silero pins are measured local records and identified as such.

`scripts/release/installers.json` describes the intended distribution contract. Its
`TEAMID`/signing anchor remain provisioning placeholders. The local app is ad-hoc signed,
not notarized and not a complete offline release. `scripts/validate-release.mjs` remains
incomplete until a real distributable exists and original ticket gates are evidenced.
