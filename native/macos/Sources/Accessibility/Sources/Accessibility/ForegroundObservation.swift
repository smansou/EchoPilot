import Foundation

// The read-only foreground observation seam: one request names an explicit project scope, and the
// observer returns a bounded evidence snapshot of the frontmost non-EchoPilot application's
// focused window. It performs no write of any kind — no AX attribute write, no action, no pointer,
// no key, no screenshot, no OCR, no polling, no network. Every read is an AX attribute copy or an
// NSWorkspace query, executed once per request; the traversal, sensitivity filter, and every bound
// are pure logic over `AXObservationNode`s, so the deterministic fake-tree tests exercise exactly
// the code the live source drives.

/// The frontmost application as the OS reported it at the instant of one observation.
public struct ObservedApplication: Codable, Equatable, Sendable {
    public let pid: Int32
    public let bundleId: String
    public let name: String

    public init(pid: Int32, bundleId: String, name: String) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
    }
}

/// One node of the observed AX tree. The observer reads lazily and in a fixed order: role and
/// subrole first, so a sensitive control is filtered before any label or value is requested, and a
/// sensitive node's children are never enumerated.
public protocol AXObservationNode: AnyObject {
    func role() -> String?
    func subrole() -> String?
    /// The node's own `AXTitle`; used for the window descriptor.
    func title() -> String?
    /// The control's label: title, description, help text, placeholder, or title UI element.
    func label() -> String?
    func value() -> String?
    /// Up to `limit` children in AX order; `truncated` is true when more exist than were returned.
    func children(limit: Int) -> AXObservationChildren
}

public struct AXObservationChildren {
    public let nodes: [AXObservationNode]
    public let truncated: Bool

    public init(nodes: [AXObservationNode], truncated: Bool) {
        self.nodes = nodes
        self.truncated = truncated
    }
}

/// The read-only OS boundary. `SystemForegroundObservationSource` is the real NSWorkspace and
/// AXUIElement implementation; the tests use a deterministic fake tree that records every read.
public protocol ForegroundObservationSource: AnyObject {
    /// Whether this process holds the Accessibility permission (`AXIsProcessTrusted`).
    func accessibilityGranted() -> Bool
    /// The frontmost application right now, or nil when none is determinable.
    func frontmostApplication() -> ObservedApplication?
    /// The AX application element for the given application, or nil when it cannot be created.
    func applicationNode(for application: ObservedApplication) -> AXObservationNode?
    /// The focused window, falling back to the main window; nil when the application has neither.
    func windowNode(ofApplicationNode applicationNode: AXObservationNode) -> AXObservationNode?
}

/// Sensitive control identification, applied before any value read. Roles and subroles are
/// compared against the SDK constants and then, defensively, matched as substrings so a vendor
/// role that merely mentions "secure" or "password" is still treated as sensitive.
public enum AXSensitivity {
    public static let sensitiveRoles: Set<String> = ["AXSecureTextField"]
    public static let sensitiveSubroles: Set<String> = ["AXSecureTextField"]

    public static func isSensitive(role: String?, subrole: String?) -> Bool {
        for candidate in [role, subrole].compactMap({ $0 }) {
            if sensitiveRoles.contains(candidate) || sensitiveSubroles.contains(candidate) {
                return true
            }
            let lowered = candidate.lowercased()
            if lowered.contains("secure") || lowered.contains("password") {
                return true
            }
        }
        return false
    }
}

/// Hard bounds for one observation. Every bound is enforced by `ForegroundObserver`, so the same
/// numbers describe the fake-tree tests and the live snapshot. Every string field that reaches the
/// snapshot is capped in UTF-8 bytes, and `maxResponseBytes` caps the encoded snapshot itself.
public struct ForegroundObservationBounds: Equatable, Sendable {
    /// Deepest node depth emitted; a nonempty child list at this depth is reported as truncated.
    public var maxDepth: Int
    /// Most nodes inspected per observation, counting redacted ones; also caps nodes enqueued.
    public var maxVisitedNodes: Int
    /// Most evidence nodes in the snapshot.
    public var maxEmittedNodes: Int
    /// Children enumerated per node; the AX child array beyond this is reported as truncated.
    public var maxChildrenPerNode: Int
    /// Most UTF-8 bytes kept from a node's label or value.
    public var maxStringBytes: Int
    /// Most UTF-8 bytes kept from the window title.
    public var maxWindowTitleBytes: Int
    /// Most UTF-8 bytes kept from a role or subrole, redacted nodes included.
    public var maxRoleBytes: Int
    /// Most UTF-8 bytes kept from the application bundle id or name.
    public var maxApplicationFieldBytes: Int
    /// Most UTF-8 bytes accepted for the scope's project id; a longer id is refused, never cut.
    public var maxProjectIdBytes: Int
    /// Largest sum of encoded node objects the traversal accumulates before it stops early.
    public var maxTotalBytes: Int
    /// Ceiling in UTF-8 bytes for the whole encoded evidence snapshot. The observer encodes with
    /// the deterministic JSON encoder and drops trailing evidence nodes until the snapshot fits,
    /// so this bounds keys, values, array framing, and the fixed envelope, not just an estimate of
    /// node content. With zero nodes the snapshot is bounded by `responseEnvelopeCeiling`; set
    /// `maxResponseBytes` at or above that value to guarantee the ceiling is always met with a
    /// readable envelope.
    public var maxResponseBytes: Int
    /// Wall-clock budget for the node traversal; see `ForegroundObserver` for the best-effort
    /// overrun of one in-flight AX call.
    public var maxTraversalSeconds: Double

    public init(
        maxDepth: Int = 6,
        maxVisitedNodes: Int = 512,
        maxEmittedNodes: Int = 200,
        maxChildrenPerNode: Int = 40,
        maxStringBytes: Int = 160,
        maxWindowTitleBytes: Int = 120,
        maxRoleBytes: Int = 64,
        maxApplicationFieldBytes: Int = 256,
        maxProjectIdBytes: Int = 256,
        maxTotalBytes: Int = 24_000,
        maxResponseBytes: Int = 32_768,
        maxTraversalSeconds: Double = 2.0
    ) {
        self.maxDepth = maxDepth
        self.maxVisitedNodes = maxVisitedNodes
        self.maxEmittedNodes = maxEmittedNodes
        self.maxChildrenPerNode = maxChildrenPerNode
        self.maxStringBytes = maxStringBytes
        self.maxWindowTitleBytes = maxWindowTitleBytes
        self.maxRoleBytes = maxRoleBytes
        self.maxApplicationFieldBytes = maxApplicationFieldBytes
        self.maxProjectIdBytes = maxProjectIdBytes
        self.maxTotalBytes = maxTotalBytes
        self.maxResponseBytes = maxResponseBytes
        self.maxTraversalSeconds = maxTraversalSeconds
    }

    /// A conservative upper bound on the encoded snapshot with zero nodes: every byte-bounded
    /// string at its limit, every fixed key and scalar, and slack for JSON framing, flags, and
    /// escaping. A `maxResponseBytes` at or above this value is met even when the ceiling trims
    /// every evidence node away.
    public var responseEnvelopeCeiling: Int {
        maxProjectIdBytes
            + 2 * maxApplicationFieldBytes
            + maxRoleBytes
            + maxWindowTitleBytes
            + 1_024
    }
}

/// Which applications the observer refuses to look at. EchoPilot's own bundle identifiers are
/// excluded by default; the helper adds its own bundle identifier and process ids at runtime, so
/// the frontmost EchoPilot window is never observed.
public struct ForegroundObservationPolicy: Sendable {
    public static let echoPilotBundleIdentifiers: Set<String> = [
        "com.echopilot.desktop",
        "com.echopilot.widget",
        "com.echopilot.voice",
        "com.echopilot.platformhost",
    ]

    public var bounds: ForegroundObservationBounds
    public var excludedBundleIdentifiers: Set<String>
    public var excludedProcessIdentifiers: Set<Int32>

    public init(
        bounds: ForegroundObservationBounds = ForegroundObservationBounds(),
        excludedBundleIdentifiers: Set<String> = ForegroundObservationPolicy.echoPilotBundleIdentifiers,
        excludedProcessIdentifiers: Set<Int32> = []
    ) {
        self.bounds = bounds
        self.excludedBundleIdentifiers = excludedBundleIdentifiers
        self.excludedProcessIdentifiers = excludedProcessIdentifiers
    }

    public func excludes(_ application: ObservedApplication) -> Bool {
        if excludedProcessIdentifiers.contains(application.pid) {
            return true
        }
        let normalized = application.bundleId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return false }
        return excludedBundleIdentifiers.contains {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalized
        }
    }

    public func isSensitive(role: String?, subrole: String?) -> Bool {
        AXSensitivity.isSensitive(role: role, subrole: subrole)
    }
}

/// The application block of one snapshot. `bundleId` and `name` are byte-bounded by
/// `ForegroundObservationBounds.maxApplicationFieldBytes`, with a truncation flag per field so a
/// partial identity is never mistaken for the real one.
public struct ForegroundEvidenceApplication: Codable, Equatable, Sendable {
    public let pid: Int32
    public let bundleId: String
    public let name: String
    public let bundleIdTruncated: Bool
    public let nameTruncated: Bool

    public init(
        pid: Int32,
        bundleId: String,
        name: String,
        bundleIdTruncated: Bool = false,
        nameTruncated: Bool = false
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
        self.bundleIdTruncated = bundleIdTruncated
        self.nameTruncated = nameTruncated
    }
}

/// The window block of one snapshot; the role is bounded by `maxRoleBytes` and the title by
/// `maxWindowTitleBytes`, each with its truncation flag.
public struct ForegroundEvidenceWindow: Codable, Equatable, Sendable {
    public let role: String
    public let roleTruncated: Bool
    public let title: String
    public let titleTruncated: Bool

    public init(role: String, roleTruncated: Bool = false, title: String, titleTruncated: Bool) {
        self.role = role
        self.roleTruncated = roleTruncated
        self.title = title
        self.titleTruncated = titleTruncated
    }
}

/// One evidence node. A redacted node reports its role and subrole and nothing else: no label, no
/// value, and no children were read. Role and subrole are byte-bounded even for redacted nodes, and
/// every string carries its truncation flag.
public struct ForegroundEvidenceNode: Codable, Equatable, Sendable {
    public let depth: Int
    public let role: String
    public let subrole: String?
    public let label: String?
    public let value: String?
    public let labelTruncated: Bool
    public let valueTruncated: Bool
    public let redacted: Bool
    public let roleTruncated: Bool
    public let subroleTruncated: Bool

    public init(
        depth: Int,
        role: String,
        subrole: String?,
        label: String?,
        value: String?,
        labelTruncated: Bool,
        valueTruncated: Bool,
        redacted: Bool,
        roleTruncated: Bool = false,
        subroleTruncated: Bool = false
    ) {
        self.depth = depth
        self.role = role
        self.subrole = subrole
        self.label = label
        self.value = value
        self.labelTruncated = labelTruncated
        self.valueTruncated = valueTruncated
        self.redacted = redacted
        self.roleTruncated = roleTruncated
        self.subroleTruncated = subroleTruncated
    }
}

public struct ForegroundEvidenceStats: Codable, Equatable, Sendable {
    public let visitedNodes: Int
    public let emittedNodes: Int
    public let maxDepthReached: Int
    /// Cumulative encoded size of the node objects the traversal accumulated before the response
    /// ceiling ran, including JSON keys and escaping; this is what `maxTotalBytes` caps. The whole
    /// snapshot is separately capped by `maxResponseBytes`.
    public let estimatedBytes: Int

    public init(visitedNodes: Int, emittedNodes: Int, maxDepthReached: Int, estimatedBytes: Int) {
        self.visitedNodes = visitedNodes
        self.emittedNodes = emittedNodes
        self.maxDepthReached = maxDepthReached
        self.estimatedBytes = estimatedBytes
    }
}

/// The bounded, read-only evidence snapshot. `quality` is "full" while no bound cut the snapshot
/// short and "partial" once any truncation fired; `truncations` names the bounds that fired.
public struct ForegroundEvidence: Codable, Equatable, Sendable {
    public let kind: String
    public let observedAtMs: Double
    public let projectId: String
    public let application: ForegroundEvidenceApplication
    public let window: ForegroundEvidenceWindow
    public let nodes: [ForegroundEvidenceNode]
    public let quality: String
    public let truncated: Bool
    public let truncations: [String]
    public let stats: ForegroundEvidenceStats

    public init(
        kind: String = "desktop_observe",
        observedAtMs: Double,
        projectId: String,
        application: ForegroundEvidenceApplication,
        window: ForegroundEvidenceWindow,
        nodes: [ForegroundEvidenceNode],
        quality: String,
        truncated: Bool,
        truncations: [String],
        stats: ForegroundEvidenceStats
    ) {
        self.kind = kind
        self.observedAtMs = observedAtMs
        self.projectId = projectId
        self.application = application
        self.window = window
        self.nodes = nodes
        self.quality = quality
        self.truncated = truncated
        self.truncations = truncations
        self.stats = stats
    }
}

/// The stable names of the bounds that can fire during one traversal.
public enum ForegroundObservationTruncation: String, CaseIterable, Sendable {
    /// A nonempty child list at `maxDepth` was not entered.
    case depth
    /// The `maxVisitedNodes` or `maxEmittedNodes` budget stopped the walk.
    case nodes
    /// A node had more children than `maxChildrenPerNode`.
    case children
    /// A label, value, role, subrole, window title, or identity string exceeded its byte bound.
    case strings
    /// The encoded node objects reached `maxTotalBytes`.
    case bytes
    /// The encoded snapshot exceeded `maxResponseBytes`; trailing evidence nodes were dropped.
    case response
    /// The traversal exceeded `maxTraversalSeconds`.
    case time
}

/// What one observation produced. The failing cases are distinct so the host can tell an
/// Accessibility denial from a missing window and from a window with nothing readable in it, and
/// none of them carries any evidence.
public enum ForegroundObservationOutcome: Equatable, Sendable {
    case evidence(ForegroundEvidence)
    /// `AXIsProcessTrusted` is false; no AX read was attempted.
    case accessibilityDenied
    /// The frontmost application is EchoPilot itself (or another excluded bundle/process).
    case excludedApplication(bundleId: String)
    /// No frontmost application, no application element, or no focused/main window.
    case noWindow(reason: String)
    /// The window exists but holds no readable title and no readable nodes.
    case emptyEvidence(application: ObservedApplication, window: ForegroundEvidenceWindow)
}

public extension ForegroundObservationOutcome {
    /// The stable code for a failing outcome; nil for evidence. The helper reports
    /// `observe:<code>[:<detail>]` so the denial, no-window, and empty-evidence cases stay distinct.
    var failureCode: String? {
        switch self {
        case .evidence: return nil
        case .accessibilityDenied: return "accessibility_denied"
        case .excludedApplication: return "excluded_application"
        case .noWindow: return "no_window"
        case .emptyEvidence: return "empty_evidence"
        }
    }

    var failureDetail: String? {
        switch self {
        case .evidence, .accessibilityDenied:
            return nil
        case let .excludedApplication(bundleId):
            return bundleId.isEmpty ? nil : bundleId
        case let .noWindow(reason):
            return reason
        case let .emptyEvidence(application, _):
            return application.bundleId.isEmpty ? "no_readable_nodes" : application.bundleId
        }
    }

    var failureText: String? {
        guard let failureCode else { return nil }
        return (["observe", failureCode, failureDetail].compactMap { $0 }).joined(separator: ":")
    }
}

/// One read-only observation of the frontmost non-EchoPilot window. `observe` is expected to be
/// called once per request: it neither polls nor retries, and every failing path returns without
/// evidence rather than guessing. Every string that reaches the snapshot is capped in UTF-8 bytes
/// and the encoded snapshot is capped by `maxResponseBytes`; the traversal deadline is checked
/// before each node's read group and before child enumeration, so no new OS call starts after the
/// deadline, and the deadline is best effort by at most one in-flight AX call (the per-call
/// messaging timeout in `SystemForegroundObservationSource`).
public final class ForegroundObserver {
    public typealias Clock = () -> Date

    private let source: ForegroundObservationSource
    private let policy: ForegroundObservationPolicy
    private let clock: Clock

    public init(
        source: ForegroundObservationSource,
        policy: ForegroundObservationPolicy = ForegroundObservationPolicy(),
        now: @escaping Clock = Date.init
    ) {
        self.source = source
        self.policy = policy
        self.clock = now
    }

    public func observe(scope: ActionScope) throws -> ForegroundObservationOutcome {
        let bounds = policy.bounds
        let projectId = try ForegroundObserver.requireProjectId(scope, maxBytes: bounds.maxProjectIdBytes)

        guard source.accessibilityGranted() else { return .accessibilityDenied }
        guard let application = source.frontmostApplication() else {
            return .noWindow(reason: "frontmost_application_unavailable")
        }
        if policy.excludes(application) {
            return .excludedApplication(bundleId: application.bundleId)
        }
        guard let applicationNode = source.applicationNode(for: application) else {
            return .noWindow(reason: "application_element_unavailable")
        }
        guard let windowNode = source.windowNode(ofApplicationNode: applicationNode) else {
            return .noWindow(reason: "no_focused_or_main_window")
        }

        let started = clock()
        let deadline = started.addingTimeInterval(bounds.maxTraversalSeconds)

        var reasons: Set<ForegroundObservationTruncation> = []
        let (windowRole, windowRoleTruncated) = ForegroundObserver.boundedBytes(
            ForegroundObserver.reportedWindowRole(windowNode.role()),
            limit: bounds.maxRoleBytes
        )
        if windowRoleTruncated {
            reasons.insert(.strings)
        }
        let (windowTitle, titleTruncated) = ForegroundObserver.boundedBytes(
            windowNode.title() ?? "",
            limit: bounds.maxWindowTitleBytes
        )
        if titleTruncated {
            reasons.insert(.strings)
        }
        let window = ForegroundEvidenceWindow(
            role: windowRole,
            roleTruncated: windowRoleTruncated,
            title: windowTitle,
            titleTruncated: titleTruncated
        )
        let collected = collect(window: windowNode, deadline: deadline, reasons: &reasons)

        if collected.nodes.isEmpty && windowTitle.isEmpty {
            return .emptyEvidence(application: application, window: window)
        }

        // The observed identity is byte-bounded too, so a hostile or broken bundle id or name
        // cannot escape `maxResponseBytes`.
        let (bundleId, bundleIdTruncated) = ForegroundObserver.boundedBytes(
            application.bundleId,
            limit: bounds.maxApplicationFieldBytes
        )
        let (name, nameTruncated) = ForegroundObserver.boundedBytes(
            application.name,
            limit: bounds.maxApplicationFieldBytes
        )
        if bundleIdTruncated || nameTruncated {
            reasons.insert(.strings)
        }

        let evidence = fit(
            nodes: collected.nodes,
            visited: collected.visited,
            maxDepthReached: collected.maxDepthReached,
            estimatedBytes: collected.estimatedBytes,
            observedAtMs: started.timeIntervalSince1970 * 1000,
            projectId: projectId,
            application: ForegroundEvidenceApplication(
                pid: application.pid,
                bundleId: bundleId,
                name: name,
                bundleIdTruncated: bundleIdTruncated,
                nameTruncated: nameTruncated
            ),
            window: window,
            reasons: &reasons
        )
        return .evidence(evidence)
    }

    // MARK: - traversal

    private struct Collection {
        let nodes: [ForegroundEvidenceNode]
        let visited: Int
        let maxDepthReached: Int
        let estimatedBytes: Int
    }

    /// Depth-first preorder walk of the window's descendants under every bound. Role and subrole
    /// are read first; a sensitive node is emitted redacted and its subtree is never enumerated, so
    /// no secure value can be read or surfaced. Depth, node, child, string, byte, and time bounds
    /// each stop the walk with a named truncation instead of silently growing the snapshot. The
    /// deadline is rechecked before the label/value reads and before child enumeration, so no new
    /// AX call starts after the budget; only an in-flight call can overrun it.
    private func collect(
        window: AXObservationNode,
        deadline: Date,
        reasons: inout Set<ForegroundObservationTruncation>
    ) -> Collection {
        let bounds = policy.bounds
        let encoder = JSONEncoder()
        var nodes: [ForegroundEvidenceNode] = []
        var visited = 0
        var maxDepthReached = 0
        var estimatedBytes = 0

        if deadlinePassed(deadline) {
            reasons.insert(.time)
            return Collection(nodes: [], visited: 0, maxDepthReached: 0, estimatedBytes: 0)
        }
        let windowChildren = window.children(limit: bounds.maxChildrenPerNode)
        if windowChildren.truncated {
            reasons.insert(.children)
        }
        let initial = Array(windowChildren.nodes.prefix(max(0, bounds.maxVisitedNodes)))
        if initial.count < windowChildren.nodes.count {
            reasons.insert(.nodes)
        }
        var queued = initial.count
        var stack = initial.reversed().map { (node: $0, depth: 1) }

        traversal: while let (node, depth) = stack.popLast() {
            if deadlinePassed(deadline) {
                reasons.insert(.time)
                break traversal
            }
            if visited >= bounds.maxVisitedNodes || nodes.count >= bounds.maxEmittedNodes {
                reasons.insert(.nodes)
                break traversal
            }
            visited += 1
            maxDepthReached = max(maxDepthReached, depth)

            let rawRole = node.role()
            let rawSubrole = node.subrole()
            let (role, roleTruncated) = ForegroundObserver.boundedBytes(
                rawRole ?? "AXUnknown",
                limit: bounds.maxRoleBytes
            )
            let subrole: String?
            var subroleTruncated = false
            if let rawSubrole {
                let boundedSubrole = ForegroundObserver.boundedBytes(rawSubrole, limit: bounds.maxRoleBytes)
                subrole = boundedSubrole.value
                subroleTruncated = boundedSubrole.truncated
            } else {
                subrole = nil
            }
            if roleTruncated || subroleTruncated {
                reasons.insert(.strings)
            }

            let entry: ForegroundEvidenceNode
            if policy.isSensitive(role: rawRole, subrole: rawSubrole) {
                entry = ForegroundEvidenceNode(
                    depth: depth,
                    role: role,
                    subrole: subrole,
                    label: nil,
                    value: nil,
                    labelTruncated: false,
                    valueTruncated: false,
                    redacted: true,
                    roleTruncated: roleTruncated,
                    subroleTruncated: subroleTruncated
                )
            } else {
                if deadlinePassed(deadline) {
                    reasons.insert(.time)
                    break traversal
                }
                let (label, labelTruncated) = ForegroundObserver.boundedBytes(
                    node.label() ?? "",
                    limit: bounds.maxStringBytes
                )
                let (value, valueTruncated) = ForegroundObserver.boundedBytes(
                    node.value() ?? "",
                    limit: bounds.maxStringBytes
                )
                if labelTruncated || valueTruncated {
                    reasons.insert(.strings)
                }
                entry = ForegroundEvidenceNode(
                    depth: depth,
                    role: role,
                    subrole: subrole,
                    label: label.isEmpty ? nil : label,
                    value: value.isEmpty ? nil : value,
                    labelTruncated: labelTruncated,
                    valueTruncated: valueTruncated,
                    redacted: false,
                    roleTruncated: roleTruncated,
                    subroleTruncated: subroleTruncated
                )
            }

            // The byte budget now counts the actual encoded node object, keys and escaping
            // included, instead of a hand estimate of its strings.
            let cost = ForegroundObserver.encodedByteCount(of: entry, using: encoder)
            if estimatedBytes + cost > bounds.maxTotalBytes {
                reasons.insert(.bytes)
                break traversal
            }
            estimatedBytes += cost
            nodes.append(entry)

            if entry.redacted {
                // A sensitive control's descendants are part of the sensitive subtree: skip them.
                continue
            }

            if deadlinePassed(deadline) {
                reasons.insert(.time)
                break traversal
            }
            let children = node.children(limit: bounds.maxChildrenPerNode)
            if children.truncated {
                reasons.insert(.children)
            }
            guard !children.nodes.isEmpty else { continue }
            guard depth < bounds.maxDepth else {
                reasons.insert(.depth)
                continue
            }
            let room = bounds.maxVisitedNodes - queued
            guard room > 0 else {
                reasons.insert(.nodes)
                continue
            }
            let accepted = Array(children.nodes.prefix(room))
            if accepted.count < children.nodes.count {
                reasons.insert(.nodes)
            }
            queued += accepted.count
            stack.append(contentsOf: accepted.reversed().map { ($0, depth + 1) })
        }

        return Collection(
            nodes: nodes,
            visited: visited,
            maxDepthReached: maxDepthReached,
            estimatedBytes: estimatedBytes
        )
    }

    // MARK: - response ceiling

    /// Assemble the snapshot and enforce `maxResponseBytes` on the actual encoded bytes: while the
    /// encoding is over the ceiling, trailing evidence nodes are dropped and the drop is reported
    /// as `.response`, so the returned snapshot keeps the readable preorder prefix. With zero nodes
    /// the snapshot is bounded by `ForegroundObservationBounds.responseEnvelopeCeiling`.
    private func fit(
        nodes: [ForegroundEvidenceNode],
        visited: Int,
        maxDepthReached: Int,
        estimatedBytes: Int,
        observedAtMs: Double,
        projectId: String,
        application: ForegroundEvidenceApplication,
        window: ForegroundEvidenceWindow,
        reasons: inout Set<ForegroundObservationTruncation>
    ) -> ForegroundEvidence {
        let bounds = policy.bounds
        let encoder = JSONEncoder()
        var kept = nodes
        while true {
            let candidate = snapshot(
                nodes: kept,
                visited: visited,
                maxDepthReached: maxDepthReached,
                estimatedBytes: estimatedBytes,
                observedAtMs: observedAtMs,
                projectId: projectId,
                application: application,
                window: window,
                reasons: reasons
            )
            if ForegroundObserver.encodedByteCount(of: candidate, using: encoder) <= bounds.maxResponseBytes {
                return candidate
            }
            reasons.insert(.response)
            if kept.isEmpty {
                // Nothing readable is left to drop; the envelope is bounded by
                // responseEnvelopeCeiling, so this only happens when maxResponseBytes was set
                // below the bounded envelope, and the flag records it.
                return snapshot(
                    nodes: kept,
                    visited: visited,
                    maxDepthReached: maxDepthReached,
                    estimatedBytes: estimatedBytes,
                    observedAtMs: observedAtMs,
                    projectId: projectId,
                    application: application,
                    window: window,
                    reasons: reasons
                )
            }
            kept.removeLast()
        }
    }

    private func snapshot(
        nodes: [ForegroundEvidenceNode],
        visited: Int,
        maxDepthReached: Int,
        estimatedBytes: Int,
        observedAtMs: Double,
        projectId: String,
        application: ForegroundEvidenceApplication,
        window: ForegroundEvidenceWindow,
        reasons: Set<ForegroundObservationTruncation>
    ) -> ForegroundEvidence {
        let truncations = reasons.map(\.rawValue).sorted()
        return ForegroundEvidence(
            observedAtMs: observedAtMs,
            projectId: projectId,
            application: application,
            window: window,
            nodes: nodes,
            quality: truncations.isEmpty ? "full" : "partial",
            truncated: !truncations.isEmpty,
            truncations: truncations,
            stats: ForegroundEvidenceStats(
                visitedNodes: visited,
                emittedNodes: nodes.count,
                maxDepthReached: maxDepthReached,
                estimatedBytes: estimatedBytes
            )
        )
    }

    // MARK: - helpers

    /// The scope must name its project explicitly; an absent, empty, or whitespace project id is
    /// refused before any OS read, so an observation can never be attributed to a guessed project.
    /// An id longer than `maxBytes` UTF-8 bytes is refused rather than cut, because the project id
    /// is attribution, not evidence.
    static func requireProjectId(_ scope: ActionScope, maxBytes: Int) throws -> String {
        let trimmed = scope.projectId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else {
            throw ActionServiceError.invalidInput("observe requires an explicit scope with a nonempty projectId")
        }
        guard trimmed.utf8.count <= maxBytes else {
            throw ActionServiceError.invalidInput("observe requires a projectId of at most \(maxBytes) UTF-8 bytes")
        }
        return trimmed
    }

    /// True when the clock has passed the budget. Every expensive group of AX reads is preceded by
    /// this check, so no new OS call starts after the deadline; a single in-flight call can still
    /// overrun it by up to the AX messaging timeout, which is the best effort an AXRead can give.
    private func deadlinePassed(_ deadline: Date) -> Bool {
        clock() > deadline
    }

    /// Keep whole scalars while their UTF-8 bytes fit in `limit`, so the result is valid UTF-8,
    /// its `utf8.count` is at most `limit`, and no replacement character is introduced. A scalar
    /// wider than `limit` is dropped rather than split.
    static func boundedBytes(_ value: String, limit: Int) -> (value: String, truncated: Bool) {
        guard limit > 0 else {
            return ("", !value.isEmpty)
        }
        guard value.utf8.count > limit else { return (value, false) }
        var kept = ""
        var used = 0
        for scalar in value.unicodeScalars {
            let width = ForegroundObserver.utf8Width(of: scalar)
            if used + width > limit {
                break
            }
            used += width
            kept.unicodeScalars.append(scalar)
        }
        return (kept, true)
    }

    private static func utf8Width(of scalar: Unicode.Scalar) -> Int {
        switch scalar.value {
        case ..<0x80: return 1
        case ..<0x800: return 2
        case ..<0x1_0000: return 3
        default: return 4
        }
    }

    private static func reportedWindowRole(_ role: String?) -> String {
        guard let role, !role.isEmpty else { return "AXUnknown" }
        return role
    }

    /// The encoded size of one node object; `maxTotalBytes` accumulates this, so JSON keys, nulls,
    /// flags, and escaped strings are all inside the byte budget instead of a hand estimate.
    private static func encodedByteCount(of node: ForegroundEvidenceNode, using encoder: JSONEncoder) -> Int {
        guard let data = try? encoder.encode(node) else {
            return Int.max / 2
        }
        return data.count
    }

    private static func encodedByteCount(of evidence: ForegroundEvidence, using encoder: JSONEncoder) -> Int {
        guard let data = try? encoder.encode(evidence) else {
            return Int.max
        }
        return data.count
    }
}
