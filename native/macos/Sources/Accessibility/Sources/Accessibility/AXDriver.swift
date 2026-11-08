import Foundation

/// How a session names a target. The ref grammar is `ax:<pid>:<child-index>[.<child-index>...]`,
/// where the child indices walk `kAXChildrenAttribute` from the application element, so the same
/// ref resolves to the same control and a replaced window or control resolves elsewhere (or not at
/// all) instead of silently matching the old one.
public struct AXTargetRef: Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public var description: String { rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// A parsed target address for the system driver.
public struct AXTargetAddress: Equatable, Sendable {
    public let pid: Int32
    public let path: [Int]

    public init(pid: Int32, path: [Int]) {
        self.pid = pid
        self.path = path
    }

    public init?(targetRef: AXTargetRef) {
        let parts = targetRef.rawValue.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "ax", let pid = Int32(parts[1]) else { return nil }
        let indices = parts[2].split(separator: ".")
        var path: [Int] = []
        for index in indices {
            guard let value = Int(index), value >= 0 else { return nil }
            path.append(value)
        }
        self.pid = pid
        self.path = path
    }

    public var targetRef: AXTargetRef {
        AXTargetRef("ax:\(pid):\(path.map(String.init).joined(separator: "."))")
    }
}

/// Resolves a focused AX element by walking its reported parents back to the app root.
/// This avoids scanning large Electron/browser accessibility trees to rediscover a node that AX
/// already identified as focused. Child indices keep the serialized target ref re-resolvable by a
/// later helper process.
enum AXParentChainPath {
    static func resolve<Element>(
        root: Element,
        target: Element,
        maxDepth: Int,
        equals: (Element, Element) -> Bool,
        parent: (Element) -> Element?,
        children: (Element) -> [Element]?
    ) -> [Int]? {
        guard maxDepth >= 0 else { return nil }
        var current = target
        var reversed: [Int] = []
        for depth in 0...maxDepth {
            if equals(current, root) { return Array(reversed.reversed()) }
            guard depth < maxDepth,
                  let parentElement = parent(current),
                  let siblings = children(parentElement),
                  let index = siblings.firstIndex(where: { equals($0, current) }) else { return nil }
            reversed.append(index)
            current = parentElement
        }
        return nil
    }
}

/// The C02 operations the adapter can express through AX, plus the read that proves a target exists.
public enum AXOperation: String, Codable, Sendable {
    case read
    case navigate
    case click
    case select
    case scroll
    case setValue = "set_value"

    /// True for operations that act on the control and therefore need the disabled/focus guards.
    public var acts: Bool { self != .read }
}

/// The AX actions performed through `AXUIElementPerformAction`, named by their SDK constant.
public enum AXAction: String, Codable, Sendable {
    case press = "AXPress"
    case pick = "AXPick"
    case scrollDownByPage = "AXScrollDownByPage"
    case scrollUpByPage = "AXScrollUpByPage"
    case scrollLeftByPage = "AXScrollLeftByPage"
    case scrollRightByPage = "AXScrollRightByPage"
}

public enum AXDriverError: Error, Equatable {
    case invalidTargetRef(String)
    case resolutionFailed(String)
    case attributeWriteFailed(attribute: String, code: Int32)
    case actionFailed(action: String, code: Int32)
    case unsupportedOperation(String)
    case accessibilityNotGranted
}

/// The raw AX boundary. Implementations read state and perform single writes; they never decide
/// whether an action is allowed, never verify, and never retry. `SystemAXDriver` is the real
/// `AXUIElement` implementation and the tests use deterministic stubs.
public protocol AXDriver: AnyObject {
    /// Current state of one control, or nil when it no longer exists.
    func inspect(_ target: AXTargetRef) throws -> AXControlState?
    /// One AX value write (type/edit). Returning is not proof the application applied it.
    func setValue(_ target: AXTargetRef, value: String) throws
    /// One AX action (click/select/scroll).
    func perform(_ target: AXTargetRef, action: AXAction) throws
    /// One focus move (navigate).
    func focus(_ target: AXTargetRef) throws
}
