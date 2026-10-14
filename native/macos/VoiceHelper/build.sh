#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
bundle="$repo_root/dist/native/EchoPilotVoice.app"
source="$repo_root/native/macos/.build/debug/echopilot-voice"
identity="${ECHOPILOT_CODESIGN_IDENTITY:--}"

mkdir -p "$repo_root/native/macos/.build/module-cache"
env CLANG_MODULE_CACHE_PATH="$repo_root/native/macos/.build/module-cache" SWIFT_MODULECACHE_PATH="$repo_root/native/macos/.build/module-cache" \
  swift build --package-path "$repo_root/native/macos" --product echopilot-voice --disable-sandbox
mkdir -p "$bundle/Contents/MacOS"
cp "$source" "$bundle/Contents/MacOS/echopilot-voice"
cp "$script_dir/Info.plist" "$bundle/Contents/Info.plist"
codesign --force --deep --options runtime --timestamp=none \
  --entitlements "$script_dir/entitlements.plist" --sign "$identity" "$bundle"
codesign --verify --deep --strict "$bundle"
echo "Signed local voice helper: $bundle"
