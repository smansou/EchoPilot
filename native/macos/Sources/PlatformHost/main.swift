// EchoPilot PlatformHost — the signed macOS helper for F02's hello/status exchange.
//
// The helper owns exactly one job: report macOS permission state for microphone and screen
// capture over a newline-delimited JSON protocol on stdout, authenticating every message with the
// per-launch token it was started with. It renders no UI; all AppKit behavior beyond status
// queries stays in Electron unless the signed-app test matrix proves a gap.
//
// Wire format (one JSON object per line, stdout):
//   {"type":"hello","protocolVersion":1,"token":"<per-launch secret>","status":{...}}
//   {"type":"status","protocolVersion":1,"token":"<per-launch secret>","status":{...}}
//   {"type":"log","protocolVersion":1,"token":"...","message":"..."}
// stdin commands: {"type":"status"} re-announces, {"type":"permissions-changed"} re-announces,
//                 {"type":"quit"} exits cleanly.

import AVFoundation
import CoreGraphics
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

func emit(_ message: [String: Any]) {
    var payload = message
    payload["protocolVersion"] = protocolVersion
    payload["token"] = token
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

func log(_ message: String) {
    emit(["type": "log", "message": message])
}

emit(["type": "hello", "status": status()])
log("PlatformHost ready (microphone: \(microphoneState()), capture: \(captureState()))")

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
    case "quit":
        exit(0)
    default:
        log("unsupported stdin command: \(type)")
    }
}
exit(0)
