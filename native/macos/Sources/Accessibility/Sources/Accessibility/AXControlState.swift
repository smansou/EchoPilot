import Foundation

/// What one control reports right now. `inspect` returns this (or nil when the control no longer
/// exists); it is raw observed state, never a conclusion about the application.
public struct AXControlState: Equatable, Codable, Sendable {
    public let appBundleId: String
    public let windowTitle: String
    public let role: String
    public let label: String
    public let value: String
    public let enabled: Bool
    public let focused: Bool
    /// The AXSelected attribute; false when the control does not expose one.
    public let selected: Bool
    /// Covers the control's app, window, role, and label identity, so a replaced control or a
    /// replaced window never passes a stale fingerprint.
    public let fingerprint: String

    public init(
        appBundleId: String,
        windowTitle: String,
        role: String,
        label: String,
        value: String,
        enabled: Bool,
        focused: Bool,
        selected: Bool
    ) {
        self.appBundleId = appBundleId
        self.windowTitle = windowTitle
        self.role = role
        self.label = label
        self.value = value
        self.enabled = enabled
        self.focused = focused
        self.selected = selected
        self.fingerprint = AXControlState.fingerprint(
            appBundleId: appBundleId,
            windowTitle: windowTitle,
            role: role,
            label: label
        )
    }

    /// The resolver's target fingerprint: SHA-256 over the app, window, role, and label identity.
    /// A renamed or replaced control, or the same control in a replaced window, changes it.
    public static func fingerprint(
        appBundleId: String,
        windowTitle: String,
        role: String,
        label: String
    ) -> String {
        sha256Hex(CanonicalJSON.object([
            "appBundleId": .string(appBundleId),
            "windowTitle": .string(windowTitle),
            "role": .string(role),
            "label": .string(label),
        ]).encoded)
    }
}
