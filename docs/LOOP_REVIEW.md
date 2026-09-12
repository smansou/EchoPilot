# Loop review — 12 September 2026

## What went wrong

The first runner conflated orchestration errors, provider limits, legitimate quiet reasoning, and implementation defects. It then interrupted the user instead of continuing independent work. My earlier fixes addressed individual symptoms without establishing sufficiently strong integration evidence.

The replacement loop improved retained worktrees and test separation, but inspection found these concrete defects:

1. `pnpm test` runs only core tests. Security, memory, harness, and desktop tests could be omitted while a candidate appeared green.
2. Integration rebases after dependency installation but does not reinstall afterward. A candidate can acquire workspace manifests without the matching dependency state.
3. Review issues are concatenated and truncated to 4,000 characters. Repairs lose findings and later reviews rediscover them.
4. `testIssue` immediately blocks a ticket. The implementation phase cannot change the frozen oracle, but no independent oracle-repair phase exists.
5. Failures are routed by a regex over prose. A test-related phrase can send the candidate back to the wrong phase.
6. `feat(ID)` commit subjects are treated as completion evidence. A commit title does not establish acceptance, coverage, or publication.
7. Direct subprocess execution reinstated a three-minute fatal silence timeout; quiet reasoning is not proof of a dead worker.
8. All roles share a provider home, with all roles defaulting to DeepSeek. Selecting an OpenAI review model alone would still send it through the worker provider configuration.
9. The control and integration checkout are the same. Supervisor edits and candidate integration can interfere.
10. State recovery and duplicate-start control were insufficient: corrupt JSON could silently become an empty state, and process exclusion depended too heavily on the dashboard port.

## Evidence from existing product code

Six tickets are recorded as done: F01, F02, S01, H01, M01, Q01. A fresh direct run of all 14 discovered app/package test files passed 43 tests. That is broader than the previous default root test command. Evidence is saved locally in `.loop/audits/existing-tests.json` and `.loop/audits/existing-tests.log`.

This does not establish release readiness. The checked-in native Package.swift currently declares only the Secrets executable. M01 explicitly substitutes field-level AES encryption for the SQLCipher implementation required by the original plan. Its existing canary tests pass, but they do not validate equivalence to SQLCipher, encrypted WAL/FTS requirements, or every durability/security requirement. Those deviations require explicit resolution and verification, not a rewritten completion claim.

## Architecture decision

Keep a deterministic scheduler. Use DeepSeek `deepseek-flash`, max effort, under `/Users/sobhi/.codex-deepseek-worker` for test authoring and implementation. Use GPT-5.6 Sol, high effort, under `/Users/sobhi/.codex` for bounded independent reviews. The expensive model does not poll, manage processes, choose ready tickets, or rerun successful phases. Two active tickets is the starting limit; path overlap still controls effective concurrency.

Retain candidates, frozen oracle history, the dashboard, and working native/product code. Put the control scripts in the ordinary checkout, accepted product commits in a dedicated `codex/autonomous` integration worktree, and persistent state/candidates/logs in the original `.loop` directory. Control-plane changes are not worker-owned.

Acceptance checks must be tied to the candidate commit. Rebase, reinstall, validate ownership and frozen hashes, run the frozen command plus discovered app/package tests, typecheck and build, then review. Native changes need a buildable package target; mocks are not hardware qualification. Review findings have stable IDs, full descriptions, scope, and explicit verification before closure. Missing evidence stays missing.

## Treatment of the proposed eleven pillars

Adopt executable ownership/test contracts, isolated candidates, comprehensive relevant gates, phase-aware recovery, durable findings, bounded review, clean integration, process exclusion, crash reconciliation, and separate release validation.

Use independent oracle repair only when the oracle itself is defective. Avoid paying for a new test-author model call on every ordinary repair. Keep a retained candidate for repair rather than discarding useful work on every invocation. Fresh model context is still mandatory.

Do not add a model-driven watchdog, a multi-service orchestration platform, or exhaustive unrelated testing after every edit. Native/signing/device checks belong in the relevant gates and final release qualification. Do not automatically promote models or lift retry/cost limits without recorded evidence.

## Success criteria

A successful unattended run means eligible work proceeds, transient failures recover with bounded backoff, repairs retain all blocking findings, and completion points to reproducible checks and review evidence for the integrated commit. It does not mean the scheduler can guarantee completion of this entire multi-subsystem product in a few hours. Final readiness requires clean installation, full test/build coverage, native and desktop smoke checks, packaging, and requirements-to-evidence reconciliation.
