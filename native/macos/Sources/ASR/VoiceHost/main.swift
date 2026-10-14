// echopilot-voice — the production entry point of V01's local tracer bullet.
//
// The binary owns the local half of "Speak → native audio → local ASR → widget transcript → mute":
// it registers the CoreML Silero runtime, loads the pinned WhisperKit small.en pack from disk,
// instantiates `VoiceTracerBridge` and speaks the same newline-delimited JSON protocol the app's
// other helpers use. It opens no socket and no port, and nothing it does reaches the network.
//
// stdout frames (one JSON object per line):
//   {"type":"hello","protocolVersion":1,"capabilities":["voice.session","voice.mute"],"status":{…}}
//   {"type":"status","protocolVersion":1,"status":{…}}
//   {"type":"transcript","protocolVersion":1,"update":{"phase":"partial"|"final", …}}
//   {"type":"error","protocolVersion":1,"error":{"code":"…","message":"…"}}
// stdin commands (one JSON object per line):
//   {"type":"start"} | {"type":"mute"} | {"type":"status"} | {"type":"transcript"}
//   {"type":"close"} | {"type":"quit"}
//
// Launch environment:
//   ECHOPILOT_ASR_MODEL_DIR      folder holding the small.en WhisperKit pack (required)
//   ECHOPILOT_SILERO_MODEL_DIR   folder holding the Silero pack (optional; else searched on disk)
//   ECHOPILOT_MAX_QUEUED_FRAMES  bounded transport ring size (optional, default 100 = 2 s)
import ASR
import Audio
import Foundation

let protocolVersion = 1
let outputLock = NSLock()

func writeFrame(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    var text = String(data: data, encoding: .utf8)
  else { return }
  text.append("\n")
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(Data(text.utf8))
}

func writeError(_ code: String, _ message: String) {
  writeFrame([
    "type": "error",
    "protocolVersion": protocolVersion,
    "error": ["code": code, "message": message],
  ])
}

func writeStatus(_ session: VoiceTracerBridge) {
  writeFrame([
    "type": "status",
    "protocolVersion": protocolVersion,
    "status": session.status().jsonObject,
  ])
}

/// Runs one async session call to completion on the command thread; the widget is never left
/// waiting on a capture release that never returns.
func perform(_ work: @escaping () async -> Void) {
  let done = DispatchSemaphore(value: 0)
  // Top-level executable code may inherit MainActor. The command thread waits synchronously,
  // so the async work must start on the cooperative executor instead of that blocked actor.
  Task.detached {
    await work()
    done.signal()
  }
  done.wait()
}

// Keep async closures out of top-level MainActor inference: this stdio host has no UI actor.
func runHost() {
  let configuration: VoiceHostConfiguration
  do {
    configuration = try VoiceHostConfiguration.fromEnvironment()
  } catch {
    writeError("model_pack_missing", "\(error)")
    exit(2)
  }

  let session: VoiceTracerBridge
  do {
    session = try VoiceSessionBootstrap.makeLocalSession(configuration)
  } catch {
    writeError("model_pack_missing", "\(error)")
    exit(2)
  }

  _ = session.subscribe { update in
    writeFrame([
      "type": "transcript",
      "protocolVersion": protocolVersion,
      "update": update.jsonObject,
    ])
  }

  var modelLoadError: Error?
  perform {
    do { try await session.prepareModels() } catch { modelLoadError = error }
  }
  if let modelLoadError {
    writeError("model_load_failed", "\(modelLoadError)")
    exit(2)
  }

  writeFrame([
    "type": "hello",
    "protocolVersion": protocolVersion,
    "capabilities": ["voice.session", "voice.mute"],
    "status": session.status().jsonObject,
  ])

  while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard
      let data = trimmed.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = object["type"] as? String
    else {
      writeError("invalid_command", "expected a JSON object with a 'type' field")
      continue
    }

    switch type {
    case "start":
      perform { await session.start() }
      writeStatus(session)
    case "mute":
      perform { await session.mute() }
      writeStatus(session)
    case "status":
      writeStatus(session)
    case "transcript":
      writeFrame([
        "type": "transcript",
        "protocolVersion": protocolVersion,
        "committed": session.transcript().map(\.jsonObject),
      ])
    case "close", "quit":
      perform { await session.close() }
      writeStatus(session)
      exit(0)
    default:
      writeError("invalid_command", "unknown command '\(type)'")
    }
  }

  // stdin closed: release capture and exit cleanly.
  perform { await session.close() }
  writeStatus(session)
}

runHost()
