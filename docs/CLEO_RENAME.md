# Cleo display name

The app is now named Cleo in its interface, menus, window and document titles, assistant prompts, account registration hints, macOS package display name, and executable. Local app bundles use `Cleo-*.app`.

Existing technical identifiers remain stable: bundle ID, package/workspace names, IPC, native helper paths, archive format, profile directory, and Keychain services. This preserves upgrade compatibility without moving user data.

Electron 44 configures the macOS Safe Storage service from its app name before readiness. Keep the legacy internal name until readiness, then set the visible runtime name to Cleo. See the pinned Electron source: https://github.com/electron/electron/blob/v44.3.0/shell/browser/electron_browser_main_parts.cc#L591. No existing credentials were read during the rename verification.

The user approved option F as the provisional icon. `assets/branding/cleo.svg` is its source, with generated PNG and macOS ICNS assets alongside it. Run `node scripts/build-app-icon.mjs` on macOS to regenerate them. Packaging copies the ICNS into bundle Resources and sets `CFBundleIconFile`. The browser studio remains available for the final composition.

Validation: TypeScript, 785 project tests, 27 packaging tests, local build, and packaged startup qualification.
