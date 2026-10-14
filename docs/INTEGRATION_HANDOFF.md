# EchoPilot integration checkpoint — 2026-09-28

Working checkout: `feature/complete-app` at `/Users/sobhi/Documents/ChatGPT/EchoPilot/.worktrees/complete-app`, based on `codex/autonomous`. The older `codex/bootstrap` checkout and its pre-existing changes were left untouched. Current changes are uncommitted. No EchoPilot process is running.

Done in this pass:

- Replaced the demo dashboard with the Signal Room Mission Control UI, including overview, Work, Voice, Memory, Desktop, Privacy, Providers, Settings, and Diagnostics. Normal launches no longer seed the synthetic event.
- Added validated, persistent profile settings with search, reset, import/export, and a tested write path. A visual Electron check confirmed navigation and persistence; the test change to the Anna voice was reset to the default.
- Wired managed Codex app-server sessions to Work: project selection, session start, account status, browser sign-in, prompt delivery, interrupt, approval, event display, and bounded agent-message readback. The installed CLI is protocol-compatible (`0.154.0`). A signed-out test correctly blocks Send; completing real account sign-in requires the user in the browser.
- Built the Swift voice, reasoner, Keychain, platform, desktop Accessibility, and execution helpers. The PlatformHost was ad-hoc signed and verified; its live handshake reported granted microphone and capture permissions. A temporary Keychain put/get/delete test passed.
- Connected the encrypted memory profile to Keychain and managed session events. Added Memory timeline/forget UI and a dedicated privacy preload channel for private sessions and encrypted export/restore. These newly composed paths need a final in-app interaction test.
- Added `scripts/dev.mjs` so `pnpm dev` attempts native builds before Electron; added honest voice errors and actual component/release readiness diagnostics.

Verification: `pnpm check` passed outside the restricted sandbox, as did `pnpm smoke`. Swift builds and their release-validation checks passed. The final `pnpm typecheck` passed after the latest edits. `pnpm release:validate` is still **incomplete** because there is no `package` script or ticket acceptance ledger. The S04 child-process test fails only in the sandbox and passes outside it. The V02 manifest assertion was updated to accept the newer ASR/reasoner/runtime asset kinds.

Continue with: (1) in-app test of Work sign-in, real reply, memory timeline, private session, export/restore; (2) connect available domain services to real desktop/voice flows and finish the UI; (3) obtain and verify the missing Whisper, Qwen, Pocket TTS, voice, and Python payloads; (4) repair packaging and provision a real Apple Developer ID/signing policy; (5) run clean-machine and hardware qualification, leaving physical gaze testing until last. The checked-in model hashes and `TEAMID` release identity are unverified placeholders, and the advertised vendor step is absent. The README still describes the old demo and needs updating.
