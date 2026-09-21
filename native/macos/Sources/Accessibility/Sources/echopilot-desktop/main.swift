import DesktopAX
import Foundation

// `echopilot-desktop` is the private stdio helper the Electron main process spawns for a granted
// desktop action (C02). One JSON request per line in, one JSON response per line out; it listens on
// no socket and no port, like the other EchoPilot native helpers. Nothing here decides policy: the
// request carries the scope and the granted proposal, and `DesktopActionService` applies the
// lifecycle — proposal, grant, per-step preflight, one AX step, read-back verification, cancel.
//
// Requests (one line each, `scope` required on `propose`):
//   {"operation":"status"}
//   {"operation":"propose","scope":{...},"actionId":"...","idempotencyKey":"...",
//    "utterance":{"utteranceId":"...","text":"..."},"effect":"local_write",
//    "steps":[{"stepId":"...","operation":"set_value","targetRef":"ax:<pid>:<path>",
//              "targetFingerprint":"...","value":"..."}]}
//   {"operation":"authorize","proposalId":"...","utterance":{...}}
//   {"operation":"advance","proposalId":"..."}
//   {"operation":"cancel","proposalId":"..."}
//   {"operation":"inspect","targetRef":"ax:<pid>:<path>"}
//   {"operation":"argument-hash","scope":{...},"actionId":"...","effect":"local_write","steps":[...]}
// Responses: {"ok":true,"result":...} or {"ok":false,"error":"..."}.

/// A request line. Unknown fields are ignored; missing fields for an operation are reported as an
/// error response rather than a crash, so the host always gets one answer per request.
private struct Request: Decodable {
    let operation: String
    let scope: ActionScope?
    let actionId: String?
    let idempotencyKey: String?
    let utterance: ActionUtterance?
    let effect: ActionEffect?
    let steps: [ActionStep]?
    let proposalId: String?
    let targetRef: AXTargetRef?
}

private struct Response: Encodable {
    let ok: Bool
    let result: ResultBox?
    let error: String?

    struct ResultBox: Encodable {
        let type: String
        let payload: String
    }

    static func success<Value: Encodable>(_ value: Value, encoder: JSONEncoder) throws -> Data {
        let payload = String(decoding: try encoder.encode(value), as: UTF8.self)
        return try encoder.encode(Response(ok: true, result: ResultBox(type: "json", payload: payload), error: nil))
    }

    static func failure(_ message: String, encoder: JSONEncoder) throws -> Data {
        try encoder.encode(Response(ok: false, result: nil, error: message))
    }
}

private struct StatusReport: Encodable {
    let helper = "echopilot-desktop"
    let permission: SystemAXDriver.PermissionStatus
}

private struct HashReport: Encodable {
    let argumentHash: String
}

/// One service per explicit scope, so a proposal can never be advanced under another project.
private final class DesktopHost {
    private let driver = SystemAXDriver()
    private var services: [String: DesktopActionService] = [:]

    func service(for scope: ActionScope) -> DesktopActionService {
        let key = [
            scope.profileId,
            scope.projectId ?? "",
            scope.worktreeId ?? "",
            scope.sessionId ?? "",
            scope.sensitivity.rawValue,
        ].joined(separator: "\u{1f}")
        if let existing = services[key] {
            return existing
        }
        let service = DesktopActionService(ax: driver, now: Date.init, scope: scope)
        services[key] = service
        return service
    }
}

private let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
}()

private let decoder = JSONDecoder()
private let host = DesktopHost()
private let maxRequestBytes = 64 * 1024

private func require<T>(_ value: T?, _ field: String) throws -> T {
    guard let value else {
        throw ActionServiceError.invalidInput("missing \(field)")
    }
    return value
}

private func handle(_ line: String) throws -> Data {
    let request = try decoder.decode(Request.self, from: Data(line.utf8))
    switch request.operation {
    case "status":
        return try Response.success(StatusReport(permission: SystemAXDriver.permissionStatus), encoder: encoder)
    case "propose":
        let scope = try require(request.scope, "scope")
        let service = host.service(for: scope)
        let proposal = try service.propose(
            actionId: try require(request.actionId, "actionId"),
            idempotencyKey: try require(request.idempotencyKey, "idempotencyKey"),
            utterance: try require(request.utterance, "utterance"),
            effect: try require(request.effect, "effect"),
            steps: try require(request.steps, "steps")
        )
        return try Response.success(proposal, encoder: encoder)
    case "authorize":
        let scope = try require(request.scope, "scope")
        let authorization = try host.service(for: scope).authorize(
            proposalId: try require(request.proposalId, "proposalId"),
            utterance: try require(request.utterance, "utterance")
        )
        return try Response.success(authorization, encoder: encoder)
    case "advance":
        let scope = try require(request.scope, "scope")
        let receipt = try host.service(for: scope).advance(
            proposalId: try require(request.proposalId, "proposalId")
        )
        return try Response.success(receipt, encoder: encoder)
    case "cancel":
        let scope = try require(request.scope, "scope")
        let receipt = try host.service(for: scope).cancel(
            proposalId: try require(request.proposalId, "proposalId")
        )
        return try Response.success(receipt, encoder: encoder)
    case "inspect":
        guard let state = try SystemAXDriver().inspect(try require(request.targetRef, "targetRef")) else {
            return try Response.failure("target does not exist", encoder: encoder)
        }
        return try Response.success(state, encoder: encoder)
    case "argument-hash":
        let scope = try require(request.scope, "scope")
        let service = host.service(for: scope)
        let hash = service.argumentHashFor(
            actionId: try require(request.actionId, "actionId"),
            effect: try require(request.effect, "effect"),
            steps: try require(request.steps, "steps")
        )
        return try Response.success(HashReport(argumentHash: hash), encoder: encoder)
    default:
        throw ActionServiceError.invalidInput("unsupported operation \(request.operation)")
    }
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    let response: Data
    if line.utf8.count > maxRequestBytes {
        response = (try? Response.failure("request line exceeds \(maxRequestBytes) bytes", encoder: encoder))
            ?? Data(#"{"ok":false,"error":"request too large"}"#.utf8)
    } else {
        do {
            response = try handle(line)
        } catch {
            response = (try? Response.failure("\(error)", encoder: encoder))
                ?? Data(#"{"ok":false,"error":"unhandled request error"}"#.utf8)
        }
    }
    FileHandle.standardOutput.write(response)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
