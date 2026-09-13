"""Pocket TTS worker host: JSON lines in, PCM frames out, on stdio only.

The app starts this process with the interpreter bundled inside this directory (see `runtime.json`
and `run.sh`), never with the host's own interpreter, and every import resolves inside the bundled
`site-packages`. The engine weights and the four cleared voice presets live under `models/` and are
verified against `models/manifest.json` before they are loaded, so a bundle that lost or changed an
asset fails loudly instead of speaking audio that its license record does not cover. Nothing here
opens a socket: the only transport is the stdio pipe pair the app owns.

Protocol, one JSON object per line:

  in  {"type": "synthesize", "planId", "segmentId", "text", "voiceId", "epoch", "sampleRate", "channels"}
  in  {"type": "cancel", "segmentId"}         # honored between packets of that segment
  in  {"type": "close"}
  out {"type": "ready", "sampleRate", "channels", "packetMs", "model", "voices"}
  out {"type": "frame", "segmentId", "sequence", "sampleRate", "channels", "pcm"}   # pcm: base64 int16
  out {"type": "done", "segmentId", "packets"}
  out {"type": "cancelled", "segmentId", "packets"}
  out {"type": "error", "segmentId", "code", "message"}
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import sys
import threading
from typing import Any, Iterator, Mapping

WORKER_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
REPOSITORY_ROOT = os.path.dirname(os.path.dirname(WORKER_DIRECTORY))
MANIFEST_PATH = os.path.join(REPOSITORY_ROOT, "models", "manifest.json")

OUTPUT_SAMPLE_RATE = 24_000
OUTPUT_CHANNELS = 1
PACKET_MS = 20
PACKET_SAMPLES = OUTPUT_SAMPLE_RATE * PACKET_MS // 1_000
BYTES_PER_SAMPLE = 2
PACKET_BYTES = PACKET_SAMPLES * OUTPUT_CHANNELS * BYTES_PER_SAMPLE
HASH_BLOCK_BYTES = 1 << 20


class WorkerError(Exception):
    """A request that cannot be served; reported to the app as a single error line."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def emit(payload: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload), separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def hash_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(HASH_BLOCK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def load_assets() -> list[dict[str, Any]]:
    manifest = read_json(MANIFEST_PATH)
    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        raise WorkerError("manifest_invalid", "models/manifest.json lists no assets")
    return [dict(asset) for asset in assets]


def asset_path(asset: Mapping[str, Any]) -> str:
    relative = str(asset.get("path", ""))
    asset_id = str(asset.get("id", "<unnamed>"))
    if not relative:
        raise WorkerError("manifest_invalid", f"asset {asset_id} has no path")
    path = os.path.normpath(os.path.join(REPOSITORY_ROOT, relative))
    if not path.startswith(REPOSITORY_ROOT + os.sep):
        raise WorkerError("manifest_invalid", f"asset {asset_id} escapes the repository")
    return path


def verify_asset(asset: Mapping[str, Any]) -> str:
    """The manifest is the license record and the integrity pin; both are checked before load."""
    asset_id = str(asset.get("id", "<unnamed>"))
    for field in ("license", "revision", "sha256"):
        if not str(asset.get(field, "")).strip():
            raise WorkerError("manifest_invalid", f"asset {asset_id} has no {field}")
    path = asset_path(asset)
    if not os.path.exists(path):
        raise WorkerError("asset_missing", f"{asset_id} is not vendored; run the packaging step")
    digest = hash_file(path).lower()
    if digest != str(asset["sha256"]).lower():
        raise WorkerError("asset_hash_mismatch", f"{asset_id} does not match its pinned digest")
    return path


def select_asset(assets: list[dict[str, Any]], kind: str, voice_id: str = "") -> dict[str, Any]:
    for asset in assets:
        if asset.get("kind") != kind:
            continue
        if kind == "model" or str(asset.get("voiceId", "")).lower() == voice_id.lower():
            return asset
    raise WorkerError("asset_unknown", f"models/manifest.json has no {kind} asset {voice_id!r}")


def load_engine(model_path: str, voice_path: str) -> Any:
    """The bundled Pocket TTS runtime; a bundle without it fails instead of faking audio."""
    try:
        from pocket_tts_runtime import PocketTts  # type: ignore[import-not-found]
    except ImportError as error:
        raise WorkerError("engine_missing", f"the bundled pocket-tts engine is missing: {error}") from error
    return PocketTts(model_path=model_path, voice_path=voice_path)


def packetize(engine: Any, text: str, voice_id: str, sample_rate: int) -> Iterator[bytes]:
    """Pulls one 20 ms packet at a time so a cancel can land between two packets."""
    stream = engine.stream(text=text, voice=voice_id, sample_rate=sample_rate)
    buffered = bytearray()
    for block in stream:
        buffered.extend(bytes(block))
        while len(buffered) >= PACKET_BYTES:
            yield bytes(buffered[:PACKET_BYTES])
            del buffered[:PACKET_BYTES]
    if buffered:
        padded = bytes(buffered) + bytes(PACKET_BYTES - len(buffered))
        yield padded


class Cancellations:
    """Segment ids the app asked to stop, readable from the stdio reader thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ids: set[str] = set()

    def cancel(self, segment_id: str) -> None:
        with self._lock:
            self._ids.add(segment_id)

    def take(self, segment_id: str) -> bool:
        with self._lock:
            if segment_id not in self._ids:
                return False
            self._ids.discard(segment_id)
            return True


def serve_synthesis(
    request: Mapping[str, Any],
    assets: list[dict[str, Any]],
    cancellations: Cancellations,
) -> None:
    segment_id = str(request.get("segmentId", ""))
    voice_id = str(request.get("voiceId", ""))
    text = str(request.get("text", ""))
    sample_rate = int(request.get("sampleRate", OUTPUT_SAMPLE_RATE))
    channels = int(request.get("channels", OUTPUT_CHANNELS))
    if not segment_id or not text:
        raise WorkerError("request_invalid", "a synthesis request needs a segmentId and text")
    if sample_rate != OUTPUT_SAMPLE_RATE or channels != OUTPUT_CHANNELS:
        raise WorkerError("format_unsupported", f"the bundle speaks {OUTPUT_SAMPLE_RATE} Hz mono only")

    model = select_asset(assets, "model")
    voice = select_asset(assets, "voice", voice_id)
    engine = load_engine(verify_asset(model), verify_asset(voice))

    packets = 0
    for packet in packetize(engine, text, voice_id, sample_rate):
        if cancellations.take(segment_id):
            emit({"type": "cancelled", "segmentId": segment_id, "packets": packets})
            return
        emit({
            "type": "frame",
            "segmentId": segment_id,
            "sequence": packets,
            "sampleRate": sample_rate,
            "channels": channels,
            "pcm": base64.b64encode(packet).decode("ascii"),
        })
        packets += 1
    emit({"type": "done", "segmentId": segment_id, "packets": packets})


def main() -> int:
    requests: queue.Queue[dict[str, Any]] = queue.Queue()
    cancellations = Cancellations()

    def read_requests() -> None:
        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            try:
                request = json.loads(text)
            except json.JSONDecodeError as error:
                emit({"type": "error", "segmentId": "", "code": "request_invalid", "message": str(error)})
                continue
            if not isinstance(request, dict):
                emit({"type": "error", "segmentId": "", "code": "request_invalid", "message": "not an object"})
                continue
            kind = str(request.get("type", ""))
            if kind == "cancel":
                cancellations.cancel(str(request.get("segmentId", "")))
                continue
            requests.put(request)
        # stdin closed: the app is gone, so the worker stops once the queued work is drained.
        requests.put({"type": "eof"})

    threading.Thread(target=read_requests, name="pocket-tts-stdio", daemon=True).start()

    try:
        assets = load_assets()
    except WorkerError as error:
        emit({"type": "error", "segmentId": "", "code": error.code, "message": error.message})
        return 1
    model = select_asset(assets, "model")
    voices = [str(asset.get("voiceId", "")) for asset in assets if asset.get("kind") == "voice"]
    emit({
        "type": "ready",
        "sampleRate": OUTPUT_SAMPLE_RATE,
        "channels": OUTPUT_CHANNELS,
        "packetMs": PACKET_MS,
        "model": str(model.get("id", "")),
        "voices": voices,
    })

    while True:
        request = requests.get()
        kind = str(request.get("type", ""))
        if kind in ("close", "eof"):
            break
        if kind != "synthesize":
            emit({
                "type": "error",
                "segmentId": str(request.get("segmentId", "")),
                "code": "request_unsupported",
                "message": f"unsupported request {kind!r}",
            })
            continue
        try:
            serve_synthesis(request, assets, cancellations)
        except WorkerError as error:
            emit({
                "type": "error",
                "segmentId": str(request.get("segmentId", "")),
                "code": error.code,
                "message": error.message,
            })
    return 0


if __name__ == "__main__":
    sys.exit(main())
