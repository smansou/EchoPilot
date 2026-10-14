#!/bin/bash
# Build and locally sign the EchoPilot desktop observation helper.
#
#   bash native/macos/Sources/Accessibility/build.sh [output-path]
#
# The helper is built through its own SwiftPM manifest, which depends only on the package's own
# `DesktopAX` library and the system frameworks, so the build resolves offline. Defaults to
# dist/native/echopilot-desktop, which is exactly where apps/desktop/src/main/desktop-observe.ts
# looks for the packaged helper (derived from the main bundle directory, never the process cwd).
# Set ECHOPILOT_CODESIGN_IDENTITY to a Developer ID to produce a notarizable signature; without it
# the script falls back to an ad-hoc signature with a stable identifier so local runs keep the
# helper's identity recognizable across rebuilds. No system-wide install and no network download.
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$source_dir/../../../.." && pwd)"
output="${1:-$repo_root/dist/native/echopilot-desktop}"
identity="${ECHOPILOT_CODESIGN_IDENTITY:--}"

if ! command -v swift >/dev/null 2>&1; then
  echo "swift not found. Install Xcode command line tools to build the desktop observation helper." >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
mkdir -p "$source_dir/.build/module-cache"
env CLANG_MODULE_CACHE_PATH="$source_dir/.build/module-cache" SWIFT_MODULECACHE_PATH="$source_dir/.build/module-cache" \
  swift build --package-path "$source_dir" -c release --product echopilot-desktop --disable-sandbox
cp "$source_dir/.build/release/echopilot-desktop" "$output"

codesign --force --options runtime --timestamp=none \
  --identifier com.echopilot.desktop.observation \
  --sign "$identity" "$output"

echo "Signed desktop observation helper: $output"
echo "Verify with: codesign --verify --strict --verbose=2 '$output'"
