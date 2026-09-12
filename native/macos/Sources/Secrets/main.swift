import Foundation

/// The capabilities this helper advertises to the parent over the private stdio channel.
let advertisedCapabilities = ["keychain.put", "keychain.get", "keychain.delete", "capture.screen"]

func writeLine(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          var text = String(data: data, encoding: .utf8) else { return }
    text.append("\n")
    FileHandle.standardOutput.write(Data(text.utf8))
}

func respond(id: String, result: [String: Any]) {
    writeLine(["id": id, "ok": true, "result": result])
}

func respondError(id: String, error: Error) {
    let helper = error as? HelperError
    writeLine(["id": id, "ok": false, "error": ["code": helper?.code ?? "internal", "message": helper?.description ?? "\(error)"]])
}

func stringParam(_ params: [String: Any], _ name: String) throws -> String {
    guard let value = params[name] as? String, !value.isEmpty else {
        throw HelperError.invalidParams("missing '\(name)'")
    }
    return value
}

func dispatch(capability: String, params: [String: Any]) throws -> [String: Any] {
    switch capability {
    case "keychain.put":
        try KeychainStore.put(
            service: stringParam(params, "service"),
            account: stringParam(params, "account"),
            secretBase64: stringParam(params, "secretBase64"))
        return ["stored": true]
    case "keychain.get":
        let secret = try KeychainStore.get(
            service: stringParam(params, "service"),
            account: stringParam(params, "account"))
        return ["secretBase64": secret ?? NSNull()]
    case "keychain.delete":
        try KeychainStore.delete(
            service: stringParam(params, "service"),
            account: stringParam(params, "account"))
        return ["deleted": true]
    case "capture.screen":
        return try ScreenCapture.capture(params: params)
    default:
        throw HelperError.unsupported(capability)
    }
}

// Handshake first, then one JSON request per line. The parent is the only client: no ports, no
// sockets, and secrets arrive on stdin rather than argv or the environment.
writeLine(["protocol": 1, "event": "ready", "capabilities": advertisedCapabilities])

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = object["id"] as? String,
          let capability = object["capability"] as? String else { continue }
    let params = object["params"] as? [String: Any] ?? [:]
    do {
        respond(id: id, result: try dispatch(capability: capability, params: params))
    } catch {
        respondError(id: id, error: error)
    }
}
