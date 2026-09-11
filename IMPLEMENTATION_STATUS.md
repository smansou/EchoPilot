# Implementation status and continuation

## Strategy

Implement one complete user path at a time. Start with A contextual dictation plus a stateful B agent companion. Establish shared voice, memory, routing, and attention once; add desktop-wide tools and gaze later. Keep product logic in TypeScript and reserve Swift for system APIs that need it.

Use one integrating lead with at most two implementation subagents and one short review slot. Assign exclusive file ownership and a frozen interface before parallel work. Give each agent one bounded ticket or sub-slice, stop it when complete, and avoid duplicate research. The lead reviews and runs focused checks once, then commits a coherent result. Do not start blocked tickets merely to keep agents busy. No paid model benchmarks, broad soak tests, microphone prompts, or signing steps during ordinary autonomous checks.

## Current milestone

F01 working synthetic path implemented: Electron/React widget and dashboard, strict command/state IPC, renderer sandbox, custom local protocol, permission denial for unavailable prototype features, event journal replay, and revocable coordinator speech leases. Two subagents implemented core/contracts and renderer in parallel; the lead integrated Electron/build/security and requested a focused read-only review.

F01 is **in progress**, not fully closed. Remaining before completion: formal versioned subsystem interfaces (NativeHost, Memory, HarnessAdapter, VoiceSession, Attention, Reasoner), generated schemas/contracts, and their minimal fake adapters. The bootstrap uses small handwritten runtime validators and node:test rather than introducing the entire planned framework toolchain. Electron Forge packaging belongs in the packaging/native shell work; current build uses Vite and esbuild.

## Next work

1. Finish F01's interface/schema work against the working application, preserving strict IPC validation and synthetic-only storage.
2. After F01, parallelize S01 (permission/secret foundation), F02 (native shell status and shortcuts), and Q01 (small deterministic fixture replay). S01 must precede real sensitive inputs; native status must recover without an installed helper during TS development.
3. Follow the dependency graph to M01 and H01, then V01/A01. Ship the narrow path: a spoken, context-corrected instruction reaches one managed agent, its outcome is consolidated, and a useful response is narrated under the shared attention policy.
4. Add durable project memory and cold-log import before expanding to unrestricted desktop tools or gaze.

Use BACKLOG.json for dependencies. Do not mark a ticket complete solely because its UI exists. Record changed scope and verification evidence here as work progresses.

## Repository

Verified connected project: smansou/EchoPilot, repository ID 1357571568. Existing main commit 3e7899b6849a05ebbf9d134403b9019ebfb8ce7d, titled Initialize repository, dated 2026-09-04. Implementation branch: codex/bootstrap. Preserve the initial history. The local GitHub CLI credential was invalid, but git push succeeded through the existing Git credential configuration. The connected GitHub app was used to verify the repository and create the branch. Do not create a replacement repository or force-push main.

## Checks

Verified: pinned lockfile installation; TypeScript check; three focused core tests; production Vite/esbuild build; unattended hidden Electron smoke (rendered fixture text, IPC validation, mute, renderer isolation, dashboard lifecycle, and stable event identity over two launches). No hardware access or paid calls were required. No real ASR, TTS, harness, screen capture, gaze, encrypted memory, or native helper has been implemented yet.

## Lean autonomous loop (2026-09-11)

The previous multi-module runner and active dashboard were removed. `scripts/loop.mjs` is now the single orchestration implementation. It starts dependency-ready, non-overlapping tickets in fresh model contexts, retains code candidates, freezes red-test evidence during production implementation, runs deterministic checks, requests a blind read-only review, and serializes integration. Model selection is runtime configuration rather than ticket metadata; the default is `deepseek-flash`. Concurrency has no policy cap unless `LOOP_MAX_AGENTS` is set. Transient and substantive failures have finite limits, stale active work recovers on restart, and uncertain accepted integrations are reconciled from their commit receipt.
