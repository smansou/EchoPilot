import AppKit
import ApplicationServices
import Foundation

/// The real `AXUIElement` adapter behind the C02 seam. It reads state, performs one write or one
/// action, and moves focus — nothing else. It never decides whether an action is allowed, never
/// verifies, and never retries; the lifecycle in `ActionLifecycle.swift` owns those rules, so the
/// same guards are exercised by the offline stubs and by this driver.
///
/// Every AX call is bounded: `AXUIElementSetMessagingTimeout` keeps a hung or unresponsive
/// application from stalling the helper, and a target that cannot be resolved reports `nil` (it is
/// gone) instead of matching a stale element. Reading another process still requires the user to
/// have granted Accessibility permission; without it the driver refuses work rather than guessing.
public final class SystemAXDriver: AXDriver {
    /// Seconds an AX round trip may take before it fails, per element.
    public static let messagingTimeoutSeconds: Float = 2.0
    /// The deepest child-index path this resolver walks; deeper trees are refused, not guessed.
    public static let maxPathDepth = 64
    /// Depth bound for the parent walk that finds the containing window title.
    private static let maxParentWalk = 32

    public enum PermissionStatus: String, Codable, Sendable {
        case granted
        case denied
    }

    public init() {}

    /// Whether this process holds the Accessibility permission (`AXIsProcessTrusted`).
    public static var permissionStatus: PermissionStatus {
        AXIsProcessTrusted() ? .granted : .denied
    }

    // MARK: - AXDriver

    public func inspect(_ target: AXTargetRef) throws -> AXControlState? {
        try requirePermission()
        guard let element = try element(for: target) else { return nil }
        guard let role = stringAttribute(element, kAXRoleAttribute) else {
            // The element resolved through the tree but no longer reports a role: it is gone.
            return nil
        }
        // Secure values never cross private stdio, even through the explicit inspect operation.
        guard role != "AXSecureTextField", stringAttribute(element, kAXSubroleAttribute) != "AXSecureTextField" else {
            throw AXDriverError.unsupportedOperation("secure_field")
        }
        let value = stringAttribute(element, kAXValueAttribute) ?? ""
        guard value.utf8.count <= 16_384 else { throw AXDriverError.unsupportedOperation("target_too_large") }
        return AXControlState(
            appBundleId: appBundleId(pid: address(of: target)?.pid),
            windowTitle: windowTitle(of: element),
            role: role,
            label: label(of: element),
            value: value,
            enabled: boolAttribute(element, kAXEnabledAttribute) ?? true,
            focused: (boolAttribute(element, kAXFocusedAttribute) ?? false)
                && NSWorkspace.shared.frontmostApplication?.processIdentifier == address(of: target)?.pid,
            selected: boolAttribute(element, kAXSelectedAttribute) ?? false
        )
    }

    public func setValue(_ target: AXTargetRef, value: String) throws {
        try requirePermission()
        guard let element = try element(for: target) else {
            throw AXDriverError.resolutionFailed(target.rawValue)
        }
        guard stringAttribute(element, kAXRoleAttribute) != "AXSecureTextField", stringAttribute(element, kAXSubroleAttribute) != "AXSecureTextField" else {
            throw AXDriverError.unsupportedOperation("secure_field")
        }
        let error = AXUIElementSetAttributeValue(
            element,
            kAXValueAttribute as CFString,
            value as CFString
        )
        guard error == .success else {
            throw AXDriverError.attributeWriteFailed(attribute: "AXValue", code: error.rawValue)
        }
    }

    public func perform(_ target: AXTargetRef, action: AXAction) throws {
        try requirePermission()
        guard let element = try element(for: target) else {
            throw AXDriverError.resolutionFailed(target.rawValue)
        }
        let error = AXUIElementPerformAction(element, action.rawValue as CFString)
        guard error == .success else {
            throw AXDriverError.actionFailed(action: action.rawValue, code: error.rawValue)
        }
    }

    public func focus(_ target: AXTargetRef) throws {
        try requirePermission()
        guard let element = try element(for: target) else {
            throw AXDriverError.resolutionFailed(target.rawValue)
        }
        let error = AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        guard error == .success else {
            throw AXDriverError.attributeWriteFailed(attribute: "AXFocused", code: error.rawValue)
        }
    }

    // MARK: - resolution

    /// Resolves the frontmost app's focused editable control with a bounded child walk.
    ///
    /// - Returns: A stable tree address, or nil for unsupported or missing controls.
    /// - Throws: When Accessibility permission is absent or the focused control is secure.
    public func focusedTarget(editableOnly: Bool = true) throws -> AXTargetRef? {
        try requirePermission()
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != getpid(), app.processIdentifier != getppid(),
              !(app.bundleIdentifier ?? "").lowercased().contains("echopilot") else { return nil }
        let application = appElement(pid: app.processIdentifier)
        guard let focused = elementAttribute(application, kAXFocusedUIElementAttribute) else { return nil }
        guard stringAttribute(focused, kAXSubroleAttribute) != "AXSecureTextField" else {
            throw AXDriverError.unsupportedOperation("secure_field")
        }
        if editableOnly && !["AXTextField", "AXTextArea"].contains(stringAttribute(focused, kAXRoleAttribute) ?? "") { return nil }
        var pending: [(AXUIElement, [Int])] = [(application, [])]
        var visited = 0
        let deadline = Date().addingTimeInterval(3)
        while let (element, path) = pending.popLast() {
            visited += 1
            guard visited <= 256, Date() < deadline else { return nil }
            if CFEqual(element, focused) { return AXTargetAddress(pid: app.processIdentifier, path: path).targetRef }
            if path.count < 16, let descendants = children(of: element) {
                for (index, child) in descendants.prefix(64).enumerated().reversed() {
                    pending.append((child, path + [index]))
                }
            }
        }
        return nil
    }

    /// Read the insertion range without modifying the user's cursor.
    public func selectionRange(_ target: AXTargetRef) throws -> [String: Int]? {
        guard let element = try element(for: target),
              let raw = copyAttribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(raw as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
        return ["location": range.location, "length": range.length]
    }

    /// Read-only hit testing for a virtual gaze point; never moves the system pointer.
    public func targetAtPoint(x: Double, y: Double) throws -> AXTargetRef? {
        try requirePermission()
        guard x.isFinite, y.isFinite, let app = NSWorkspace.shared.frontmostApplication,
              !(app.bundleIdentifier ?? "").lowercased().contains("echopilot") else { return nil }
        let application = appElement(pid: app.processIdentifier)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(x), Float(y), &hit) == .success,
              let hit else { return nil }
        var pending: [(AXUIElement, [Int])] = [(application, [])]
        var visited = 0
        let deadline = Date().addingTimeInterval(2)
        while let (element, path) = pending.popLast() {
            visited += 1
            guard visited <= 512, Date() < deadline else { return nil }
            if CFEqual(element, hit) { return AXTargetAddress(pid: app.processIdentifier, path: path).targetRef }
            if path.count < 20, let descendants = children(of: element) {
                for (index, child) in descendants.prefix(64).enumerated().reversed() { pending.append((child, path + [index])) }
            }
        }
        return nil
    }

    private func address(of target: AXTargetRef) -> AXTargetAddress? {
        AXTargetAddress(targetRef: target)
    }

    private func element(for target: AXTargetRef) throws -> AXUIElement? {
        guard let address = AXTargetAddress(targetRef: target) else {
            throw AXDriverError.invalidTargetRef(target.rawValue)
        }
        guard address.path.count <= SystemAXDriver.maxPathDepth else {
            throw AXDriverError.resolutionFailed("target path deeper than \(SystemAXDriver.maxPathDepth)")
        }
        let application = appElement(pid: address.pid)
        var element = application
        for index in address.path {
            guard let children = children(of: element), index < children.count else { return nil }
            element = children[index]
        }
        return element
    }

    private func appElement(pid: Int32) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetMessagingTimeout(element, SystemAXDriver.messagingTimeoutSeconds)
        return element
    }

    private func requirePermission() throws {
        guard SystemAXDriver.permissionStatus == .granted else {
            throw AXDriverError.accessibilityNotGranted
        }
    }

    // MARK: - attribute reads

    private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard error == .success else { return nil }
        return value
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == CFStringGetTypeID() else {
            return nil
        }
        return value as? String
    }

    private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == CFBooleanGetTypeID() else {
            return nil
        }
        return (value as? NSNumber)?.boolValue
    }

    private func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = copyAttribute(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func children(of element: AXUIElement) -> [AXUIElement]? {
        guard let value = copyAttribute(element, kAXChildrenAttribute),
              CFGetTypeID(value) == CFArrayGetTypeID() else {
            return nil
        }
        let array = unsafeBitCast(value, to: CFArray.self)
        var elements: [AXUIElement] = []
        for index in 0..<CFArrayGetCount(array) {
            guard let raw = CFArrayGetValueAtIndex(array, index) else { continue }
            let item = unsafeBitCast(raw, to: CFTypeRef.self)
            guard CFGetTypeID(item) == AXUIElementGetTypeID() else { continue }
            elements.append(unsafeBitCast(item, to: AXUIElement.self))
        }
        return elements
    }

    // MARK: - identity fields

    private func appBundleId(pid: Int32?) -> String {
        guard let pid else { return "" }
        return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
    }

    /// The containing window title: the element's own title when it is a window, otherwise the
    /// window it belongs to, otherwise the first window found by a bounded parent walk.
    private func windowTitle(of element: AXUIElement) -> String {
        if stringAttribute(element, kAXRoleAttribute) == kAXWindowRole {
            return stringAttribute(element, kAXTitleAttribute) ?? ""
        }
        if let window = elementAttribute(element, kAXWindowAttribute) {
            return stringAttribute(window, kAXTitleAttribute) ?? ""
        }
        var current = element
        for _ in 0..<SystemAXDriver.maxParentWalk {
            guard let parent = elementAttribute(current, kAXParentAttribute) else { break }
            if stringAttribute(parent, kAXRoleAttribute) == kAXWindowRole {
                return stringAttribute(parent, kAXTitleAttribute) ?? ""
            }
            current = parent
        }
        return ""
    }

    /// The control's label: its title, the label element a form control points at, its description,
    /// its help text, or its placeholder value — the first one that is present and non-empty.
    private func label(of element: AXUIElement) -> String {
        let direct = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXPlaceholderValueAttribute]
        for attribute in direct {
            if let value = stringAttribute(element, attribute), !value.isEmpty {
                return value
            }
        }
        if let titleElement = elementAttribute(element, kAXTitleUIElementAttribute) {
            for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                if let value = stringAttribute(titleElement, attribute), !value.isEmpty {
                    return value
                }
            }
        }
        return ""
    }
}
