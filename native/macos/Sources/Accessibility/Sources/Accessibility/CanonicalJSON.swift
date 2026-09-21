import CryptoKit
import Foundation

/// A minimal JSON model with deterministic encoding, mirroring the TypeScript canonical encoding in
/// `packages/desktop-tools/src/actions/arguments.ts`: object keys sorted, no insignificant
/// whitespace, `undefined` absent rather than null, and the same string escaping. The same bound
/// arguments therefore produce the same SHA-256 argument hash — and the same derived proposal and
/// authorization ids — in both languages, so the TypeScript seam's grant and the native session's
/// grant name the same bytes. Keys in this contract are ASCII.
public enum CanonicalJSON: Equatable {
    case string(String)
    case bool(Bool)
    case number(Double)
    case array([CanonicalJSON])
    case object([String: CanonicalJSON])
    case null

    /// The canonical encoding: objects with sorted keys, arrays in order, shortest number form.
    public var encoded: String {
        switch self {
        case let .string(value):
            return CanonicalJSON.encodeString(value)
        case let .bool(value):
            return value ? "true" : "false"
        case let .number(value):
            guard value.isFinite else {
                return "null"
            }
            if value.rounded() == value, value >= Double(Int64.min), value <= Double(Int64.max) {
                return String(Int64(value))
            }
            return String(value)
        case let .array(entries):
            return "[" + entries.map(\.encoded).joined(separator: ",") + "]"
        case let .object(entries):
            let sorted = entries.sorted { left, right in
                left.key.utf8.lexicographicallyPrecedes(right.key.utf8)
            }
            let body = sorted
                .map { "\(CanonicalJSON.encodeString($0.key)):\($0.value.encoded)" }
                .joined(separator: ",")
            return "{" + body + "}"
        case .null:
            return "null"
        }
    }

    /// `JSON.stringify`-compatible escaping for well-formed strings.
    private static func encodeString(_ string: String) -> String {
        var encoded = "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": encoded += "\\\""
            case "\\": encoded += "\\\\"
            case "\n": encoded += "\\n"
            case "\r": encoded += "\\r"
            case "\t": encoded += "\\t"
            case Unicode.Scalar(0x08): encoded += "\\b"
            case Unicode.Scalar(0x0C): encoded += "\\f"
            default:
                if scalar.value < 0x20 {
                    encoded += String(format: "\\u%04x", scalar.value)
                } else {
                    encoded.unicodeScalars.append(scalar)
                }
            }
        }
        return encoded + "\""
    }
}

/// The hex SHA-256 of a UTF-8 string; the single hash primitive of the C02 argument binding.
public func sha256Hex(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}
