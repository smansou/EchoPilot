import AppKit
import ApplicationServices
import Foundation

/// The real read-only source behind the observation seam. It asks NSWorkspace for the frontmost
/// application and then reads AX attributes through `AXUIElementCopyAttributeValue` and the bounded
/// range reads `AXUIElementGetAttributeValueCount`/`AXUIElementCopyAttributeValues`: this file
/// contains no `AXUIElementSetAttributeValue`, no `AXUIElementPerformAction`, no pointer, key,
/// screenshot, OCR, polling, or network call. Every element read carries a small AX messaging
/// timeout so a hung application cannot stall the helper for long, and the traversal bounds stay in
/// `ForegroundObserver`.
public final class SystemForegroundObservationSource: ForegroundObservationSource {
    /// Seconds a single AX round trip may take before it fails, per element. The observer's
    /// traversal deadline is best effort: it is checked before every group of reads, so the worst
    /// case overrun is one in-flight round trip of this duration.
    public static let messagingTimeoutSeconds: Float = 0.25

    public init() {}

    public func accessibilityGranted() -> Bool {
        AXIsProcessTrusted()
    }

    public func frontmostApplication() -> ObservedApplication? {
        guard let application = NSWorkspace.shared.frontmostApplication else { return nil }
        return ObservedApplication(
            pid: application.processIdentifier,
            bundleId: application.bundleIdentifier ?? "",
            name: application.localizedName ?? ""
        )
    }

    public func applicationNode(for application: ObservedApplication) -> AXObservationNode? {
        let element = AXUIElementCreateApplication(application.pid)
        _ = AXUIElementSetMessagingTimeout(element, SystemForegroundObservationSource.messagingTimeoutSeconds)
        return AXElementObservationNode(element: element)
    }

    public func windowNode(ofApplicationNode applicationNode: AXObservationNode) -> AXObservationNode? {
        guard let element = applicationNode as? AXElementObservationNode else { return nil }
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if let window = element.elementAttribute(attribute) {
                return AXElementObservationNode(element: window)
            }
        }
        return nil
    }
}

/// One AX element read through attribute copies only. The node reads lazily and in the order the
/// observer asks; a sensitive control's label is refused at this layer too, so even a direct call
/// cannot derive a label out of a secure field's value.
private final class AXElementObservationNode: AXObservationNode {
    let element: AXUIElement

    init(element: AXUIElement) {
        self.element = element
        _ = AXUIElementSetMessagingTimeout(element, SystemForegroundObservationSource.messagingTimeoutSeconds)
    }

    func role() -> String? {
        stringAttribute(kAXRoleAttribute)
    }

    func subrole() -> String? {
        stringAttribute(kAXSubroleAttribute)
    }

    func title() -> String? {
        stringAttribute(kAXTitleAttribute)
    }

    func label() -> String? {
        if AXSensitivity.isSensitive(role: role(), subrole: subrole()) {
            return nil
        }
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXPlaceholderValueAttribute] {
            if let value = stringAttribute(attribute), !value.isEmpty {
                return value
            }
        }
        if let titleElement = elementAttribute(kAXTitleUIElementAttribute) {
            let titleNode = AXElementObservationNode(element: titleElement)
            if !AXSensitivity.isSensitive(role: titleNode.role(), subrole: titleNode.subrole()) {
                for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                    if let value = titleNode.stringAttribute(attribute), !value.isEmpty {
                        return value
                    }
                }
            }
        }
        return nil
    }

    func value() -> String? {
        stringAttribute(kAXValueAttribute)
    }

    /// The bounded range read: the attribute's count is asked for first, then at most `limit`
    /// values are copied with `AXUIElementCopyAttributeValues` starting at index 0, so the whole
    /// child array is never materialized. Order is the AX array order, and `truncated` reports the
    /// children past `limit`. A failed count or range copy returns no children rather than falling
    /// back to an unbounded copy.
    func children(limit: Int) -> AXObservationChildren {
        let attribute = kAXChildrenAttribute as CFString
        var total: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, attribute, &total) == .success else {
            return AXObservationChildren(nodes: [], truncated: false)
        }
        let asked = max(0, min(total, limit))
        guard asked > 0 else {
            return AXObservationChildren(nodes: [], truncated: total > 0)
        }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, attribute, 0, asked, &values) == .success,
              let array = values else {
            return AXObservationChildren(nodes: [], truncated: false)
        }
        let copied = CFArrayGetCount(array)
        var nodes: [AXObservationNode] = []
        nodes.reserveCapacity(copied)
        for index in 0..<copied {
            guard let raw = CFArrayGetValueAtIndex(array, index) else { continue }
            let item = unsafeBitCast(raw, to: CFTypeRef.self)
            guard CFGetTypeID(item) == AXUIElementGetTypeID() else { continue }
            nodes.append(AXElementObservationNode(element: unsafeBitCast(item, to: AXUIElement.self)))
        }
        return AXObservationChildren(nodes: nodes, truncated: total > asked)
    }

    // MARK: - attribute reads

    func copyAttribute(_ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard error == .success else { return nil }
        return value
    }

    func stringAttribute(_ attribute: String) -> String? {
        guard let value = copyAttribute(attribute), CFGetTypeID(value) == CFStringGetTypeID() else {
            return nil
        }
        return value as? String
    }

    func elementAttribute(_ attribute: String) -> AXUIElement? {
        guard let value = copyAttribute(attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
}
