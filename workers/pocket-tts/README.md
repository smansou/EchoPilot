# workers/pocket-tts — bundled offline speech worker

The local synthesis half of the V02 tracer. The app spawns `run.sh` with stdio pipes only; the
launcher runs the interpreter bundled in `python/`, so the worker needs **no system Python** and
**no download** at run time (`runtime.json`: `python.bundled`, `network: "denied"`,
`offline: true`, plus the hashed `dependencies` lock and `requirements.lock`).

| File | Role |
| --- | --- |
| `run.sh` | Launcher. Resolves the bundled interpreter relative to itself and execs `serve.py`; fails loudly when the bundle is incomplete. |
| `serve.py` | JSON-lines host on stdio: verifies the requested model + voice assets against `models/manifest.json` (license, revision, SHA-256) and streams 20 ms base64 int16 packets back. |
| `runtime.json` | The runtime contract the app reads: bundled CPython pin, denied network, locked hashed dependencies, declared output format. |
| `requirements.lock` | The same pins in lock form; the packaging step vendors exactly these archives into `python/lib/python3.12/site-packages`. |

The protocol is one JSON object per line (`ready`, `frame`, `done`, `cancelled`, `error`; see the
`serve.py` docstring). `packages/voice/src/playback/pocketTtsWorker.ts` is the app-side port that
frames those lines and decodes the packets into the playback session's `synthesize()` iterable.

The weights and the four cleared voice presets are vendored under `models/` by the packaging step
and are not checked in; every asset is verified against its manifest digest before a model or a
voice is loaded, and a missing or mismatched asset is reported as an error line rather than spoken.
