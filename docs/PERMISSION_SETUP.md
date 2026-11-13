# Native permission flow

Cleo uses platform requests directly, without its own permission modal or draggable-file guide. Microphone/camera use Electron's `systemPreferences.askForMediaAccess`. Screen access uses `desktopCapturer.getSources` (the native capture path) with thumbnails disabled during the permission request. Accessibility uses Apple's `AXIsProcessTrustedWithOptions` with the prompt option in the desktop process that performs AX work; that process stays alive while the person responds.

Permission requests happen on a user action: starting dictation, requesting an individual permission in Settings, enabling screen context, or starting gaze. Passive status checks never prompt. Screen context is in Settings → Permissions & privacy, persists its preference, and waits for required access before starting. Disabling it stops context. Backend screen tools no longer silently enable an off setting.

The status path is independent of provider/Keychain startup, refreshes on focus/activation and while the app window is visible, and publishes changes to Settings. There is no Check Permissions button. Screen Recording uses the capturing app's status, not a conjunction with the unrelated helper's screen-capture status. Desktop helper failures appear as unavailable status, not as a false permission denial. Camera/microphone status comes only from the app that uses them. For denied media, Settings offers the native pane plus a restart recovery action, because Electron documents that manual changes can require a restart. Another process’s media grant is never presented as authorization for Cleo.

macOS owns the dialogs and permission switches. Accessibility and previously denied media access can require Apple's Settings pane; camera/microphone changes can require restart. Cleo opens the appropriate native pane when the native request cannot be repeated. It does not claim to bypass those restrictions.

Provider credentials retain the existing Keychain services/profile/encryption namespace and per-launch read cache. No signing trust, Keychain ACL, TCC database, or permission grant was modified automatically.

## Sources used

- Apple Human Interface Guidelines, Privacy: request when the feature needs access; use system authorization and clear purpose strings: https://developer.apple.com/design/human-interface-guidelines/privacy
- Apple's ScreenCaptureKit sample: native screen request and restart considerations: https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos
- Electron's established media request/status APIs and denial/restart behavior: https://www.electronjs.org/docs/latest/api/system-preferences
- Apple AX prompt API: https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions

## Verification boundaries

Permission-controller tests cover native request routing, external/manual changes, status independence, denied access, restart-required media state, and helper failures. The Electron UI fixture checks that screen context is absent from Home, appears in Settings, has no custom guide/manual check step, and displays permission changes automatically. The rebuilt native helper’s status schema is checked through its real stdio protocol without requesting access. Native helper tests also run.

These checks do not grant macOS permissions and are not proof of a completed live authorization flow on the user's current installation.
