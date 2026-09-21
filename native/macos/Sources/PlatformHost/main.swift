// EchoPilot PlatformHost — the signed macOS helper for F02's hello/status exchange and V05's
// hands-free standby lifecycle.
//
// The helper reports macOS permission state for microphone and screen capture over a
// newline-delimited JSON protocol on stdout, authenticating every message with the per-launch
// token it was started with. It renders no UI; all AppKit behavior beyond status queries stays in
// Electron unless the signed-app test matrix proves a gap.
//
// V05 adds the standby half: `voice-command` frames drive the wake model and the always-on
// microphone (`StandbyVoiceHost`), and while that microphone is open the helper streams measured
// `voice-observation` frames — this process's energy trace and one acoustic window per tick. The
// conversation itself belongs to the local voice worker; this helper only listens for attention,
// and a detection it reports is never an action (see `VoiceHost.swift`).
//
// Wire format (one JSON object per line, stdout):
//   {"type":"hello","protocolVersion":1,"token":"<per-launch secret>","status":{...}}
//   {"type":"status","protocolVersion":1,"token":"<per-launch secret>","status":{...}}
//   {"type":"log","protocolVersion":1,"token":"...","message":"..."}
//   {"type":"voice-ack","protocolVersion":1,"token":"...","id":"voice-1","ok":true}
//   {"type":"voice-observation","protocolVersion":1,"token":"...","observation":{...}}
// stdin commands: {"type":"status"} re-announces, {"type":"permissions-changed"} re-announces,
//                 {"type":"voice-command","id":"...","name":"...","mode":"..."} drives standby,
//                 {"type":"quit"} exits cleanly.

import Audio
import AVFoundation
import CoreGraphics
import Darwin
import Foundation

let protocolVersion = 1

func argument(named name: String) -> String? {
    let prefix = "--\(name)="
    return CommandLine.arguments.first(where: { $0.hasPrefix(prefix) })?.dropFirst(prefix.count).description
}

guard let token = argument(named: "token") ?? ProcessInfo.processInfo.environment["ECHOPILOT_NATIVE_TOKEN"],
      token.count >= 16 else {
    FileHandle.standardError.write(Data("PlatformHost requires --token=<per-launch secret>\n".utf8))
    exit(2)
}

let environment = ProcessInfo.processInfo.environment
let provider = environment["ECHOPILOT_PROVIDER"] ?? "local"
let targetSession = environment["ECHOPILOT_TARGET_SESSION"]

func microphoneState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "unknown"
    @unknown default: return "unknown"
    }
}

func captureState() -> String {
    CGPreflightScreenCaptureAccess() ? "granted" : "denied"
}

func status() -> [String: Any] {
    [
        "microphone": microphoneState(),
        "capture": captureState(),
        "output": "ready",
        "targetSession": targetSession as Any? ?? NSNull(),
        "provider": provider,
    ]
}

/// Serializes whole stdout lines: the helper has one writer, however many threads produced a frame.
let outputLock = NSLock()

/// Writes one authenticated frame. These are `@Sendable` closures because the standby host emits
/// observations from its own concurrency domain while the stdin loop can still be answering status
/// requests; the lock above is what makes the two writers one line-oriented stream.
let emit: @Sendable ([String: Any]) -> Void = { message in
    var payload = message
    payload["protocolVersion"] = protocolVersion
    payload["token"] = token
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(Data(line.utf8))
}

let log: @Sendable (String) -> Void = { message in
    emit(["type": "log", "message": message])
}

func numberFromEnvironment(_ name: String, fallback: Double) -> Double {
    guard let raw = ProcessInfo.processInfo.environment[name], let value = Double(raw),
          value.isFinite, value >= 0 else { return fallback }
    return value
}

/// The standby microphone and its measurements. Defaults keep the cadence (24 wakeups/minute)
/// inside the standby energy budget, so a gate failure is a measured violation rather than a
/// configuration that was never going to pass. Only the resident-memory entry can be restated
/// (`ECHOPILOT_STANDBY_MEMORY_BUDGET_MB`), and the desktop app reads the same knob for its own
/// copy of the gate, so both ends judge the one measured trace against the same budget.
let standbyHost = StandbyVoiceHost(
    tickMs: Int(numberFromEnvironment("ECHOPILOT_STANDBY_TICK_MS", fallback: Double(StandbyVoiceHost.defaultTickMs))),
    threshold: numberFromEnvironment("ECHOPILOT_STANDBY_WAKE_THRESHOLD", fallback: StandbyVoiceHost.defaultThreshold),
    monitor: StandbyEnergyMonitor(budget: StandbyEnergyBudget(
        maxResidentMemoryMB: numberFromEnvironment(
            "ECHOPILOT_STANDBY_MEMORY_BUDGET_MB",
            fallback: StandbyEnergyBudget().maxResidentMemoryMB
        )
    )),
    emit: { emit($0) },
    log: { log($0) }
)

emit(["type": "hello", "status": status()])
log("PlatformHost ready (microphone: \(microphoneState()), capture: \(captureState()))")

/// Closes the standby microphone before the process goes away, bounded so a wedged engine cannot
/// keep the helper alive after the app asked it to quit.
func shutdownAndExit() -> Never {
    let group = DispatchGroup()
    group.enter()
    Task {
        await standbyHost.shutdown()
        group.leave()
    }
    _ = group.wait(timeout: .now() + 1.0)
    exit(0)
}

while let line = readLine(strippingNewline: true) {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty,
          let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = command["type"] as? String else {
        log("ignored a malformed stdin command")
        continue
    }
    switch type {
    case "status", "permissions-changed":
        emit(["type": "status", "status": status()])
    case "voice-command":
        guard (command["protocolVersion"] as? Int) == protocolVersion else {
            emit([
                "type": "voice-ack",
                "id": command["id"] as? String ?? "",
                "ok": false,
                "error": "Unsupported voice protocol version.",
            ])
            continue
        }
        // Commands are handled in arrival order on the host's actor, so an open/close pair cannot
        // be reordered by a slow permission prompt.
        Task { await standbyHost.handle(command) }
    case "quit":
        shutdownAndExit()
    default:
        log("unsupported stdin command: \(type)")
    }
}
shutdownAndExit()
