import DesktopAX
import Foundation
import CoreGraphics

// `echopilot-desktop` is the private stdio helper the Electron main process spawns for a granted
// desktop action (C02). One JSON request per line in, one JSON response per line out; it listens on
// no socket and no port, like the other EchoPilot native helpers. Nothing here decides policy: the
// request carries the scope and the granted proposal, and `DesktopActionService` applies the
// lifecycle — proposal, grant, per-step preflight, one AX step, read-back verification, cancel.
//
// Requests (one line each, `scope` required on `propose` and `observe`):
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
//   {"operation":"observe","scope":{...}}
// Responses: {"ok":true,"result":...} or {"ok":false,"error":"..."}.
//
// `observe` is the read-only foreground seam: it requires an explicit scope with a nonempty
// projectId, performs one NSWorkspace/AXUIElement read of the frontmost non-EchoPilot window, and
// returns a bounded evidence snapshot. It never writes AX state, moves the pointer, sends keys,
// captures pixels, recognizes text, polls, or touches the network. The failing cases keep the
// current framing and stay distinguishable by their stable prefixes: `observe:accessibility_denied`,
// `observe:excluded_application:<bundleId>`, `observe:no_window:<reason>`, and
// `observe:empty_evidence:<bundleId>`.

/// A request line. Unknown fields are ignored; missing fields for an operation are reported as an
/// error response rather than a crash, so the host always gets one answer per request.
private struct Request: Decodable {
    let operation: String
    let allowLocalOCR: Bool?
    let interactive: Bool?
    let preferredRole: String?
    let scope: ActionScope?
    let actionId: String?
    let idempotencyKey: String?
    let utterance: ActionUtterance?
    let effect: ActionEffect?
    let steps: [ActionStep]?
    let proposalId: String?
    let targetRef: AXTargetRef?
    let x: Double?
    let y: Double?
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
    let screenRecording: Bool
}

private struct HashReport: Encodable {
    let argumentHash: String
}

private struct FocusedTargetReport: Encodable {
    let selection: [String: Int]?
    let targetRef: AXTargetRef
    let state: AXControlState
}

/// The observation policy for this helper: EchoPilot's own bundle identifiers are excluded by
/// default, and the helper adds its own bundle id plus its own and its parent's process id, so a
/// frontmost EchoPilot window (including a development Electron run) is never observed.
private let observationPolicy: ForegroundObservationPolicy = {
    var policy = ForegroundObservationPolicy()
    if let ownBundle = Bundle.main.bundleIdentifier?.lowercased(), !ownBundle.isEmpty {
        policy.excludedBundleIdentifiers.insert(ownBundle)
    }
    policy.excludedProcessIdentifiers.insert(ProcessInfo.processInfo.processIdentifier)
    policy.excludedProcessIdentifiers.insert(getppid())
    return policy
}()

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
    case "target-at-point":
        let driver = SystemAXDriver()
        guard let target = try driver.targetAtPoint(x: require(request.x, "x"), y: require(request.y, "y"), preferredRole: request.preferredRole), let state = try driver.inspect(target) else { return try Response.failure("unsupported_target", encoder: encoder) }
        return try Response.success(FocusedTargetReport(selection: nil, targetRef: target, state: state), encoder: encoder)
    case "focused-target", "focused-control":
        let driver = SystemAXDriver()
        guard let target = try driver.focusedTarget(editableOnly: request.operation == "focused-target"), let state = try driver.inspect(target) else {
            return try Response.failure("unsupported_target", encoder: encoder)
        }
        return try Response.success(FocusedTargetReport(selection: try driver.selectionRange(target), targetRef: target, state: state), encoder: encoder)
    case "status":
        return try Response.success(StatusReport(permission: SystemAXDriver.permissionStatus, screenRecording: CGPreflightScreenCaptureAccess()), encoder: encoder)
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
    case "observe":
        let scope = try require(request.scope, "scope")
        var policy = observationPolicy
        // Interactive regions expire after 1.2 seconds in the host. Reserve time
        // for process startup and delivery instead of spending two seconds in AX.
        if request.interactive == true { policy.bounds.maxTraversalSeconds = 0.45 }
        let observer = ForegroundObserver(source: SystemForegroundObservationSource(), policy: policy)
        let outcome = try observer.observe(scope: scope)
        switch outcome {
        case let .evidence(evidence):
            return try Response.success(request.allowLocalOCR == true ? LocalWindowOCR.enrich(evidence) : evidence, encoder: encoder)
        default:
            return try Response.failure(outcome.failureText ?? "observe:failed", encoder: encoder)
        }
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
