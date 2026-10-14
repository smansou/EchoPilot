#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$source_dir/../../../.." && pwd)"
output="${1:-$repo_root/dist/native/echopilot-gaze}"
identity="${ECHOPILOT_CODESIGN_IDENTITY:--}"
mkdir -p "$(dirname "$output")" "$source_dir/.build/module-cache"
env CLANG_MODULE_CACHE_PATH="$source_dir/.build/module-cache" SWIFT_MODULECACHE_PATH="$source_dir/.build/module-cache" \
  swift build --package-path "$source_dir" -c release --product echopilot-gaze --disable-sandbox
cp "$source_dir/.build/release/echopilot-gaze" "$output"
codesign --force --options runtime --timestamp=none --identifier com.echopilot.gaze \
  --entitlements "$source_dir/Gaze.entitlements" --sign "$identity" "$output"
codesign --verify --strict "$output"
echo "Signed gaze helper: $output"
