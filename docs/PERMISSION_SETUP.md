# Guided permission setup

The Permissions & privacy buttons open the specific macOS pane and a small floating Cleo guide. Accessibility offers the exact desktop helper used by dictation and app observation. Screen Recording offers both the app bundle (for screenshots) and desktop helper (for local text/OCR). Each item supports native file drag through Electron `webContents.startDrag`, with a Finder reveal fallback. Paths are resolved in the main process from the currently running app, never accepted from renderer input.

The guide polls read-only permission status while open, shows success once macOS reports access, and updates the main Settings page. macOS still controls the permission switches, authentication, and any required app restart. Camera and microphone first use the standard system prompt when undecided, then show toggle instructions; those panes do not accept dragged apps.

The guide has its own restricted IPC. Only its exact main-frame URL and owned window can invoke guide actions or start a drag. It does not become a trusted general desktop/account renderer.

## Credentials across updates

The existing profile directory, Keychain service names, bundle ID, and encryption namespace are retained across the Cleo rename and updates. Provider keys remain in Keychain. Successful provider-key reads are cached only in the main process for one app launch, sharing concurrent reads. Replacement/deletion invalidates the cache; missing keys and failures are not cached. The cache is cleared at quit.

This reduces repeated Keychain reads during voice tool requests. It does not bypass macOS authorization or guarantee that Keychain/TCC approval survives an ad-hoc rebuild or a changed installation path. This Mac currently has no valid code-signing identity available. Stable trusted signing and a consistent installed app path are needed for reliable approval continuity. No certificate trust, Keychain ACL, or macOS permission was changed automatically.

## Verification

- Typecheck and full project suite: 791 tests passed.
- New tests cover exact permission target selection, non-draggable camera/microphone guidance, concurrent Keychain read sharing, replacement/deletion races, and failed-read recovery.
- Electron UI fixture verifies the guide's draggable item and access controls, alongside existing application UI checks.
- The actual drop into System Settings and permission grants need the user's local acceptance test; automated checks do not grant or bypass them.

Official native drag API: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop/
