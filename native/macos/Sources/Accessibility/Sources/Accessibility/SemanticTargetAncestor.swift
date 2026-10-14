import Foundation

/// Resolves a semantic highlight to its nearest control ancestor. This is read-only selection;
/// execution authorization and target fingerprint validation remain in the action lifecycle.
enum SemanticTargetAncestor {
    static let allowedRoles: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXScrollArea",
        "AXRow", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXComboBox"]

    static func select<Node>(hit: Node, preferredRole: String?, maxAncestors: Int = 32,
                             withinBudget: () -> Bool = { true }, role: (Node) -> String?,
                             subrole: (Node) -> String?, parent: (Node) -> Node?) throws -> Node? {
        guard let preferredRole else { return hit }
        guard allowedRoles.contains(preferredRole) else {
            throw AXDriverError.unsupportedOperation("unsupported_preferred_role")
        }
        var current: Node? = hit
        var selected: Node?
        for _ in 0..<max(0, maxAncestors) {
            guard withinBudget() else { return nil }
            guard let node = current else { return selected }
            let nodeRole = role(node)
            if AXSensitivity.isSensitive(role: nodeRole, subrole: subrole(node)) {
                throw AXDriverError.unsupportedOperation("secure_field")
            }
            if selected == nil && nodeRole == preferredRole { selected = node }
            current = parent(node)
            if current == nil { return selected }
        }
        // A cycle or oversized ancestry is refused; unread ancestors may be secure.
        return nil
    }
}
