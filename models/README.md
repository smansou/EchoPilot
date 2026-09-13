# models — bundled speech assets

`manifest.json` is the single source of truth for the audio assets the app speaks with: the Pocket
TTS weights (`kind: "model"`, `english_2026-04`, CC-BY-4.0) and the four cleared voice presets
`alba`, `anna`, `charles`, `jean` (CC-BY-4.0, each with its own license file entry).

Rules the manifest carries:

- every asset is pinned to a source `revision` and a `sha256` source hash, plus the license that
  travels with it (`license`, `licenseFile`); `workers/pocket-tts/serve.py` re-hashes the vendored
  bytes against these pins before a model or a voice is loaded, and refuses to load on a mismatch;
- the four voice presets and the model are distinct assets with distinct hashes, so a voice can be
  swapped without silently changing the model;
- the declared `outputFormat` (24 kHz mono, 20 ms packets) is what the playback session is opened
  with and what the worker streams, so nothing resamples on the device queue's critical path.

The asset payloads are vendored by the packaging step (`vendor-pocket-tts`) from the pinned
revisions; they are not checked into this repository. The digests above are the pins that step
enforces — the packaging job downloads the pinned revision, hashes the artifact and refuses to
vendor it unless the digest equals the recorded value — and the worker verifies the vendored bytes
against the same pins at load time. Nothing in the app downloads at run time: the license and hash
record travels with the bundle.
