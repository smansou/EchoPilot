#!/bin/bash
# Build and sign the EchoPilot PlatformHost helper.
#
#   bash native/macos/Sources/PlatformHost/build.sh [output-path]
#
# Defaults to dist/native/PlatformHost, which is exactly where apps/desktop/src/main/native-host.ts
# looks for the signed helper. Set ECHOPILOT_CODESIGN_IDENTITY to a Developer ID to produce a
# notarizable signature; without it the script falls back to an ad-hoc signature so local runs keep
# the helper's identity stable across rebuilds.
#
# TypeScript developers without Xcode never need this script: point ECHOPILOT_NATIVE_HOST at
# apps/desktop/src/main/fake-native-host.ts to get the same wire protocol from Node.
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$source_dir/../../../.." && pwd)"
output="${1:-$repo_root/dist/native/PlatformHost}"
identity="${ECHOPILOT_CODESIGN_IDENTITY:--}"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode command line tools, or use the Node fake host instead:" >&2
  echo "  ECHOPILOT_NATIVE_HOST=apps/desktop/src/main/fake-native-host.ts pnpm dev" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
swiftc -O -whole-module-optimization \
  -target arm64-apple-macos13.0 \
  -framework AVFoundation -framework CoreGraphics \
  -o "$output" \
  "$source_dir/main.swift"

codesign --force --options runtime --timestamp=none \
  --entitlements "$source_dir/PlatformHost.entitlements" \
  --sign "$identity" "$output"

echo "Signed PlatformHost helper: $output"
echo "Verify with: codesign --verify --deep --strict --verbose=2 '$output'"
