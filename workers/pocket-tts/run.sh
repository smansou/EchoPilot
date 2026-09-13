#!/bin/sh
# Pocket TTS worker launcher.
#
# The worker runs the interpreter bundled inside this directory (see runtime.json), resolved
# relative to this script, so the app never depends on the host's interpreter, a virtual
# environment or a download at run time. Nothing here touches the network.
set -eu

worker_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
interpreter="$worker_directory/python/bin/python3"

if [ ! -x "$interpreter" ]; then
  echo "pocket-tts: the bundled interpreter is missing; the worker bundle is incomplete" >&2
  exit 78
fi

exec "$interpreter" "$worker_directory/serve.py" "$@"
