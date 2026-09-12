import Foundation
import Security

enum HelperError: Error, CustomStringConvertible {
    case invalidParams(String)
    case unsupported(String)
    case keychain(OSStatus)
    case capture(String)

    var code: String {
        switch self {
        case .invalidParams: return "invalid-params"
        case .unsupported: return "unsupported-capability"
        case .keychain: return "keychain"
        case .capture: return "capture"
        }
    }

    var description: String {
        switch self {
        case .invalidParams(let detail): return "invalid parameters: \(detail)"
        case .unsupported(let capability): return "unsupported capability '\(capability)'"
        case .keychain(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "keychain error: \(message)"
        case .capture(let detail): return "capture error: \(detail)"
        }
    }
}
