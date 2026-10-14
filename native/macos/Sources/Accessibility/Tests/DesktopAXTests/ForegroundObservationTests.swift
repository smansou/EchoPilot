import Foundation
import XCTest

import DesktopAX

/// The read-only foreground observation oracle. `ForegroundObserver` drives these fake trees through
/// exactly the code the live `AXUIElement` source feeds, and every fake node records each accessor
/// call, so the sensitive-field filter and each bound are pinned without touching a live window.
final class ForegroundObservationTests: XCTestCase {

    // MARK: - fake tree

    /// One node of the fake AX tree. Reads are counted so a test can prove a value was never read
    /// (secure fields) or a subtree was never walked (depth, child, and node bounds).
    final class FakeAXNode: AXObservationNode {
        let roleValue: String?
        let subroleValue: String?
        let titleValue: String?
        let labelValue: String?
        let valueValue: String?
        let childNodes: [FakeAXNode]
        let reportsExtraChildren: Bool

        private(set) var roleReads = 0
        private(set) var subroleReads = 0
        private(set) var titleReads = 0
        private(set) var labelReads = 0
        private(set) var valueReads = 0
        private(set) var childrenReads = 0
        private(set) var childLimits: [Int] = []

        init(
            role: String? = nil,
            subrole: String? = nil,
            title: String? = nil,
            label: String? = nil,
            value: String? = nil,
            children: [FakeAXNode] = [],
            reportsExtraChildren: Bool = false
        ) {
            self.roleValue = role
            self.subroleValue = subrole
            self.titleValue = title
            self.labelValue = label
            self.valueValue = value
            self.childNodes = children
            self.reportsExtraChildren = reportsExtraChildren
        }

        func role() -> String? {
            roleReads += 1
            return roleValue
        }

        func subrole() -> String? {
            subroleReads += 1
            return subroleValue
        }

        func title() -> String? {
            titleReads += 1
            return titleValue
        }

        func label() -> String? {
            labelReads += 1
            return labelValue
        }

        func value() -> String? {
            valueReads += 1
            return valueValue
        }

        func children(limit: Int) -> AXObservationChildren {
            childrenReads += 1
            childLimits.append(limit)
            let bounded = Array(childNodes.prefix(max(0, limit)))
            return AXObservationChildren(
                nodes: bounded,
                truncated: reportsExtraChildren || childNodes.count > limit
            )
        }
    }

    final class FakeObservationSource: ForegroundObservationSource {
        var granted = true
        var frontmost: ObservedApplication? = ObservedApplication(
            pid: 4_242,
            bundleId: "com.example.notes",
            name: "Notes"
        )
        var applicationNodeValue: FakeAXNode? = FakeAXNode(role: "AXApplication")
        var windowNodeValue: FakeAXNode?
        private(set) var applicationNodeRequests = 0
        private(set) var windowNodeRequests = 0

        func accessibilityGranted() -> Bool { granted }

        func frontmostApplication() -> ObservedApplication? { frontmost }

        func applicationNode(for application: ObservedApplication) -> AXObservationNode? {
            applicationNodeRequests += 1
            return applicationNodeValue
        }

        func windowNode(ofApplicationNode applicationNode: AXObservationNode) -> AXObservationNode? {
            windowNodeRequests += 1
            return windowNodeValue
        }
    }

    final class TestClock {
        static let defaultStart = Date(timeIntervalSince1970: 1_756_000_000)
        static let defaultStartMs: Double = 1_756_000_000_000

        private var current: Date
        private let step: TimeInterval

        init(start: Date = TestClock.defaultStart, step: TimeInterval = 0) {
            self.current = start
            self.step = step
        }

        func now() -> Date {
            let value = current
            current = current.addingTimeInterval(step)
            return value
        }
    }

    // MARK: - harness

    private func scope(projectId: String? = "atlas") -> ActionScope {
        ActionScope(profileId: "profile-observe", projectId: projectId, sensitivity: .normal)
    }

    private func observe(
        _ source: FakeObservationSource,
        policy: ForegroundObservationPolicy = ForegroundObservationPolicy(),
        scope scopeOverride: ActionScope? = nil
    ) throws -> ForegroundObservationOutcome {
        let observer = ForegroundObserver(source: source, policy: policy, now: TestClock().now)
        return try observer.observe(scope: scopeOverride ?? scope())
    }

    private func encode(_ evidence: ForegroundEvidence) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(evidence), as: UTF8.self)
    }

    /// The encoded size the observer's own ceiling check measures.
    private func encodedSize<Value: Encodable>(_ value: Value) throws -> Int {
        try JSONEncoder().encode(value).count
    }

    // MARK: - scope

    func testObserveRequiresAnExplicitScopeWithNonemptyProjectId() {
        let source = FakeObservationSource()
        let observer = ForegroundObserver(source: source, now: TestClock().now)

        for projectId in [nil, "", "   "] as [String?] {
            XCTAssertThrowsError(
                try observer.observe(scope: ActionScope(profileId: "profile-observe", projectId: projectId, sensitivity: .normal))
            ) { error in
                XCTAssertEqual(
                    error as? ActionServiceError,
                    .invalidInput("observe requires an explicit scope with a nonempty projectId")
                )
            }
        }
        XCTAssertEqual(source.applicationNodeRequests, 0, "an invalid scope fails closed before any OS read")
        XCTAssertEqual(source.windowNodeRequests, 0)
        XCTAssertNil(source.windowNodeValue)
    }

    // MARK: - fail-closed outcomes

    func testAccessibilityDenialFailsClosed() throws {
        let source = FakeObservationSource()
        source.granted = false

        let outcome = try observe(source)
        XCTAssertEqual(outcome, .accessibilityDenied)
        XCTAssertEqual(outcome.failureCode, "accessibility_denied")
        XCTAssertEqual(outcome.failureText, "observe:accessibility_denied")
        XCTAssertEqual(source.applicationNodeRequests, 0, "denial never attempts an AX read")
        XCTAssertEqual(source.windowNodeRequests, 0)
    }

    func testSelfFrontmostApplicationIsExcluded() throws {
        let source = FakeObservationSource()
        source.frontmost = ObservedApplication(pid: 777, bundleId: "com.echopilot.widget", name: "EchoPilot")

        let outcome = try observe(source)
        XCTAssertEqual(outcome, .excludedApplication(bundleId: "com.echopilot.widget"))
        XCTAssertEqual(outcome.failureText, "observe:excluded_application:com.echopilot.widget")
        XCTAssertEqual(source.applicationNodeRequests, 0, "the excluded application is never inspected")

        let byProcess = FakeObservationSource()
        byProcess.frontmost = ObservedApplication(pid: 9_001, bundleId: "com.example.other", name: "Other")
        let pidOutcome = try observe(byProcess, policy: ForegroundObservationPolicy(excludedProcessIdentifiers: [9_001]))
        XCTAssertEqual(pidOutcome, .excludedApplication(bundleId: "com.example.other"))
        XCTAssertEqual(byProcess.applicationNodeRequests, 0)
    }

    func testNoWindowFailsClosedAndNamesItsReason() throws {
        let noApplication = FakeObservationSource()
        noApplication.frontmost = nil
        XCTAssertEqual(try observe(noApplication), .noWindow(reason: "frontmost_application_unavailable"))

        let noElement = FakeObservationSource()
        noElement.applicationNodeValue = nil
        XCTAssertEqual(try observe(noElement), .noWindow(reason: "application_element_unavailable"))

        let noWindow = FakeObservationSource()
        noWindow.windowNodeValue = nil
        let outcome = try observe(noWindow)
        XCTAssertEqual(outcome, .noWindow(reason: "no_focused_or_main_window"))
        XCTAssertEqual(outcome.failureText, "observe:no_window:no_focused_or_main_window")
    }

    func testEmptyEvidenceIsDistinctAndKeepsTheWindowIdentity() throws {
        let source = FakeObservationSource()
        source.windowNodeValue = FakeAXNode(role: "AXWindow", title: "")

        let outcome = try observe(source)
        XCTAssertEqual(
            outcome,
            .emptyEvidence(
                application: ObservedApplication(pid: 4_242, bundleId: "com.example.notes", name: "Notes"),
                window: ForegroundEvidenceWindow(role: "AXWindow", title: "", titleTruncated: false)
            )
        )
        XCTAssertEqual(outcome.failureCode, "empty_evidence")
        XCTAssertEqual(outcome.failureText, "observe:empty_evidence:com.example.notes")
    }

    func testWindowTitleAloneIsEvidenceNotEmptiness() throws {
        let source = FakeObservationSource()
        source.windowNodeValue = FakeAXNode(role: "AXWindow", title: "Fixture Notes")

        guard case let .evidence(evidence) = try observe(source) else {
            return XCTFail("a readable window title is evidence")
        }
        XCTAssertEqual(evidence.window.title, "Fixture Notes")
        XCTAssertTrue(evidence.nodes.isEmpty)
        XCTAssertEqual(evidence.quality, "full")
        XCTAssertFalse(evidence.truncated)
        XCTAssertEqual(evidence.truncations, [])
        XCTAssertEqual(evidence.stats.visitedNodes, 0)
    }

    // MARK: - sensitive controls

    func testSecureFieldsAreRedactedBeforeAnyValueReadAndTheirSubtreesAreSkipped() throws {
        let hiddenChild = FakeAXNode(role: "AXStaticText", label: "hidden", value: "hunter2-child")
        let secureByRole = FakeAXNode(role: "AXSecureTextField", label: "PIN", value: "4321", children: [hiddenChild])
        let secureBySubrole = FakeAXNode(role: "AXTextField", subrole: "AXSecureTextField", label: "Password", value: "hunter2")
        let safeField = FakeAXNode(role: "AXTextField", label: "Email", value: "person@example.com")
        let window = FakeAXNode(role: "AXWindow", title: "Sign in", children: [secureByRole, secureBySubrole, safeField])

        let source = FakeObservationSource()
        source.windowNodeValue = window
        guard case let .evidence(evidence) = try observe(source) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(secureByRole.valueReads, 0, "a secure field's value is never read")
        XCTAssertEqual(secureByRole.labelReads, 0)
        XCTAssertEqual(secureByRole.childrenReads, 0, "a sensitive subtree is never enumerated")
        XCTAssertEqual(hiddenChild.roleReads, 0)
        XCTAssertEqual(hiddenChild.valueReads, 0)
        XCTAssertEqual(secureBySubrole.valueReads, 0, "the subrole marks a sensitive control too")
        XCTAssertEqual(secureBySubrole.childrenReads, 0)
        XCTAssertEqual(safeField.valueReads, 1, "non-sensitive controls are read normally")
        XCTAssertEqual(safeField.labelReads, 1)

        let redacted = evidence.nodes.filter(\.redacted)
        XCTAssertEqual(redacted.count, 2)
        XCTAssertEqual(redacted.map(\.role), ["AXSecureTextField", "AXTextField"])
        XCTAssertTrue(redacted.allSatisfy { $0.label == nil && $0.value == nil })
        XCTAssertTrue(redacted.allSatisfy { $0.role == "AXSecureTextField" || $0.subrole == "AXSecureTextField" })

        let payload = try encode(evidence)
        for secret in ["hunter2", "4321", "hidden"] {
            XCTAssertFalse(payload.contains(secret), "\(secret) must never reach the snapshot")
        }
        XCTAssertTrue(payload.contains("person@example.com"))
    }

    func testSensitivityDetectionCoversRolesAndSubroles() {
        let policy = ForegroundObservationPolicy()
        XCTAssertTrue(policy.isSensitive(role: "AXSecureTextField", subrole: nil))
        XCTAssertTrue(policy.isSensitive(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertTrue(policy.isSensitive(role: "AXPasswordField", subrole: nil))
        XCTAssertTrue(policy.isSensitive(role: nil, subrole: "com.vendor.secure"))
        XCTAssertFalse(policy.isSensitive(role: "AXTextField", subrole: "AXSearchField"))
        XCTAssertFalse(policy.isSensitive(role: "AXStaticText", subrole: nil))
        XCTAssertFalse(policy.isSensitive(role: nil, subrole: nil))
    }

    func testARedactedOnlyWindowIsEvidenceNotEmpty() throws {
        let source = FakeObservationSource()
        source.windowNodeValue = FakeAXNode(
            role: "AXWindow",
            title: "",
            children: [FakeAXNode(role: "AXSecureTextField", value: "secret")]
        )

        guard case let .evidence(evidence) = try observe(source) else {
            return XCTFail("a redacted control is still read-only evidence, not emptiness")
        }
        XCTAssertEqual(evidence.nodes.count, 1)
        XCTAssertTrue(evidence.nodes[0].redacted)
        XCTAssertNil(evidence.nodes[0].value)
    }

    // MARK: - bounds and truncation

    func testDepthBoundStopsDescentAndMarksPartial() throws {
        let deepest = FakeAXNode(role: "AXStaticText", value: "too deep")
        let level2 = FakeAXNode(role: "AXGroup", children: [deepest])
        let level1 = FakeAXNode(role: "AXGroup", children: [level2])
        let window = FakeAXNode(role: "AXWindow", title: "Deep", children: [level1])

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(bounds: ForegroundObservationBounds(maxDepth: 2))
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.nodes.map(\.role), ["AXGroup", "AXGroup"])
        XCTAssertEqual(evidence.nodes.map(\.depth), [1, 2])
        XCTAssertEqual(evidence.truncations, ["depth"])
        XCTAssertEqual(evidence.quality, "partial")
        XCTAssertTrue(evidence.truncated)
        XCTAssertEqual(evidence.stats.maxDepthReached, 2)
        XCTAssertEqual(deepest.roleReads, 0, "the node past the depth bound is never inspected")
    }

    func testChildEnumerationIsBoundedPerNode() throws {
        let children = (0..<5).map { FakeAXNode(role: "AXStaticText", value: "row \($0)") }
        let window = FakeAXNode(role: "AXWindow", title: "Wide", children: children)

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(bounds: ForegroundObservationBounds(maxChildrenPerNode: 2))
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.nodes.count, 2)
        XCTAssertEqual(window.childLimits, [2], "every enumeration asks for at most maxChildrenPerNode")
        XCTAssertEqual(children[2].roleReads, 0, "children past the enumeration bound are never inspected")
        XCTAssertTrue(evidence.truncations.contains("children"))
    }

    func testStringAndTitleBoundsTruncateWithFlags() throws {
        let longLabel = String(repeating: "abcdefgh", count: 3)
        let longValue = String(repeating: "0123456789", count: 2)
        let node = FakeAXNode(role: "AXStaticText", label: longLabel, value: longValue)
        let window = FakeAXNode(role: "AXWindow", title: "Window Title", children: [node])

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(
            bounds: ForegroundObservationBounds(maxStringBytes: 8, maxWindowTitleBytes: 5)
        )
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.window.title, "Windo")
        XCTAssertTrue(evidence.window.titleTruncated)
        XCTAssertEqual(evidence.nodes[0].label, "abcdefgh")
        XCTAssertTrue(evidence.nodes[0].labelTruncated)
        XCTAssertEqual(evidence.nodes[0].value, "01234567")
        XCTAssertTrue(evidence.nodes[0].valueTruncated)
        XCTAssertTrue(evidence.truncations.contains("strings"))
        XCTAssertEqual(evidence.quality, "partial")
        XCTAssertEqual(longValue.count, 20, "the fake node keeps the full string; only the snapshot is bounded")
    }

    func testNodeBudgetsBoundVisitsAndEmission() throws {
        let emittedChildren = (0..<10).map { FakeAXNode(role: "AXStaticText", value: "emit \($0)") }
        let emittedWindow = FakeAXNode(role: "AXWindow", title: "Many", children: emittedChildren)
        let emittedSource = FakeObservationSource()
        emittedSource.windowNodeValue = emittedWindow
        let emittedPolicy = ForegroundObservationPolicy(bounds: ForegroundObservationBounds(maxEmittedNodes: 3))
        guard case let .evidence(emitted) = try observe(emittedSource, policy: emittedPolicy) else {
            return XCTFail("expected evidence")
        }
        XCTAssertEqual(emitted.nodes.count, 3)
        XCTAssertEqual(emitted.stats.visitedNodes, 3)
        XCTAssertEqual(emittedChildren[3].roleReads, 0, "the emitted budget stops the walk")
        XCTAssertTrue(emitted.truncations.contains("nodes"))

        let visitedChildren = (0..<10).map { FakeAXNode(role: "AXStaticText", value: "visit \($0)") }
        let visitedWindow = FakeAXNode(role: "AXWindow", title: "Many", children: visitedChildren)
        let visitedSource = FakeObservationSource()
        visitedSource.windowNodeValue = visitedWindow
        let visitedPolicy = ForegroundObservationPolicy(bounds: ForegroundObservationBounds(maxVisitedNodes: 3))
        guard case let .evidence(visited) = try observe(visitedSource, policy: visitedPolicy) else {
            return XCTFail("expected evidence")
        }
        XCTAssertEqual(visited.stats.visitedNodes, 3)
        XCTAssertEqual(visited.nodes.count, 3)
        XCTAssertTrue(visited.truncations.contains("nodes"))
    }

    func testByteBudgetBoundsTheEstimatedPayload() throws {
        let longValue = String(repeating: "x", count: 60)
        let children = (0..<6).map { _ in FakeAXNode(role: "AXStaticText", value: longValue) }
        let window = FakeAXNode(role: "AXWindow", title: "Heavy", children: children)

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(
            bounds: ForegroundObservationBounds(maxStringBytes: 60, maxTotalBytes: 300)
        )
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.nodes.count, 1)
        XCTAssertTrue(evidence.truncations.contains("bytes"))
        XCTAssertLessThanOrEqual(evidence.stats.estimatedBytes, 300)
        XCTAssertEqual(
            evidence.stats.estimatedBytes,
            try encodedSize(evidence.nodes[0]),
            "the byte budget counts the actual encoded node object, keys and escaping included"
        )
    }

    func testTimeBudgetStopsTraversalDeterministically() throws {
        let children = (0..<6).map { FakeAXNode(role: "AXStaticText", value: "row \($0)") }
        let window = FakeAXNode(role: "AXWindow", title: "Slow", children: children)

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(bounds: ForegroundObservationBounds(maxTraversalSeconds: 1.0))
        let observer = ForegroundObserver(source: source, policy: policy, now: TestClock(step: 0.25).now)
        guard case let .evidence(evidence) = try observer.observe(scope: scope()) else {
            return XCTFail("expected evidence")
        }

        XCTAssertTrue(evidence.truncations.contains("time"))
        XCTAssertEqual(evidence.stats.visitedNodes, 1)
        XCTAssertEqual(evidence.nodes.count, 1)
        XCTAssertEqual(evidence.observedAtMs, TestClock.defaultStartMs)
        XCTAssertEqual(children[0].childrenReads, 0, "the extra geometry/text budget check prevents children reads after the deadline")
        XCTAssertEqual(children[1].roleReads, 0, "the second node is never started after the deadline")
    }

    // MARK: - snapshot shape

    func testTraversalIsDeterministicPreorderAndReportsSnapshotIdentity() throws {
        let first = FakeAXNode(role: "AXStaticText", value: "a1")
        let second = FakeAXNode(role: "AXStaticText", value: "a2")
        let group = FakeAXNode(role: "AXGroup", children: [first, second])
        let button = FakeAXNode(role: "AXButton", label: "b")
        let window = FakeAXNode(role: "AXWindow", title: "Ordered", children: [group, button])

        let source = FakeObservationSource()
        source.windowNodeValue = window
        guard case let .evidence(evidence) = try observe(source) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.kind, "desktop_observe")
        XCTAssertEqual(evidence.projectId, "atlas")
        XCTAssertEqual(
            evidence.application,
            ForegroundEvidenceApplication(pid: 4_242, bundleId: "com.example.notes", name: "Notes")
        )
        XCTAssertEqual(
            evidence.window,
            ForegroundEvidenceWindow(role: "AXWindow", title: "Ordered", titleTruncated: false)
        )
        XCTAssertEqual(evidence.nodes.map(\.role), ["AXGroup", "AXStaticText", "AXStaticText", "AXButton"])
        XCTAssertEqual(evidence.nodes.map(\.value), [nil, "a1", "a2", nil])
        XCTAssertEqual(evidence.nodes.map(\.depth), [1, 2, 2, 1])
        XCTAssertEqual(evidence.quality, "full")
        XCTAssertFalse(evidence.truncated)
        XCTAssertEqual(evidence.truncations, [])
        XCTAssertEqual(evidence.stats.visitedNodes, 4)
        XCTAssertEqual(evidence.stats.emittedNodes, 4)
        XCTAssertEqual(evidence.stats.maxDepthReached, 2)
        XCTAssertEqual(evidence.observedAtMs, TestClock.defaultStartMs)
        XCTAssertNil(ForegroundObservationOutcome.evidence(evidence).failureText)
    }

    func testPolicyExcludesEchoPilotBundlesCaseInsensitivelyAndNamedProcesses() {
        let policy = ForegroundObservationPolicy()
        XCTAssertTrue(policy.excludes(ObservedApplication(pid: 1, bundleId: "com.echopilot.desktop", name: "EchoPilot")))
        XCTAssertTrue(policy.excludes(ObservedApplication(pid: 1, bundleId: "COM.EchoPilot.Widget", name: "EchoPilot")))
        XCTAssertFalse(policy.excludes(ObservedApplication(pid: 1, bundleId: "com.apple.Safari", name: "Safari")))
        XCTAssertFalse(policy.excludes(ObservedApplication(pid: 1, bundleId: "", name: "")))

        let byProcess = ForegroundObservationPolicy(excludedProcessIdentifiers: [42])
        XCTAssertTrue(byProcess.excludes(ObservedApplication(pid: 42, bundleId: "com.apple.Safari", name: "Safari")))
        XCTAssertFalse(byProcess.excludes(ObservedApplication(pid: 43, bundleId: "com.apple.Safari", name: "Safari")))
    }

    // MARK: - bounded output

    func testGiantIdentityAndStringFieldsAreByteBoundedAndTheSnapshotStaysUnderTheCeiling() throws {
        let giantBundleId = "com.example." + String(repeating: "b", count: 20_000)
        let giantName = String(repeating: "é", count: 20_000)
        let giantRole = "AXGroup" + String(repeating: "r", count: 20_000)
        let giantSubrole = "AXSubrole" + String(repeating: "s", count: 20_000)
        let giantLabel = String(repeating: "🙂", count: 5_000)
        let giantValue = String(repeating: "值", count: 5_000)
        let node = FakeAXNode(role: giantRole, subrole: giantSubrole, label: giantLabel, value: giantValue)
        let window = FakeAXNode(role: giantRole, title: String(repeating: "🙂", count: 5_000), children: [node])

        let source = FakeObservationSource()
        source.frontmost = ObservedApplication(pid: 4_242, bundleId: giantBundleId, name: giantName)
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy()
        let bounds = policy.bounds
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        let payload = try encode(evidence)
        XCTAssertLessThanOrEqual(try encodedSize(evidence), bounds.maxResponseBytes)
        XCTAssertLessThanOrEqual(payload.utf8.count, bounds.maxResponseBytes)
        XCTAssertFalse(payload.contains("\u{FFFD}"), "byte truncation must never split a scalar")

        XCTAssertTrue(evidence.truncated)
        XCTAssertEqual(evidence.quality, "partial")
        XCTAssertTrue(evidence.truncations.contains("strings"))

        XCTAssertTrue(evidence.application.bundleIdTruncated)
        XCTAssertTrue(evidence.application.nameTruncated)
        XCTAssertLessThanOrEqual(evidence.application.bundleId.utf8.count, bounds.maxApplicationFieldBytes)
        XCTAssertLessThanOrEqual(evidence.application.name.utf8.count, bounds.maxApplicationFieldBytes)

        XCTAssertTrue(evidence.window.roleTruncated)
        XCTAssertTrue(evidence.window.titleTruncated)
        XCTAssertLessThanOrEqual(evidence.window.role.utf8.count, bounds.maxRoleBytes)
        XCTAssertLessThanOrEqual(evidence.window.title.utf8.count, bounds.maxWindowTitleBytes)

        XCTAssertEqual(evidence.nodes.count, 1)
        let evidenceNode = evidence.nodes[0]
        XCTAssertFalse(evidenceNode.redacted)
        XCTAssertTrue(evidenceNode.roleTruncated)
        XCTAssertTrue(evidenceNode.subroleTruncated)
        XCTAssertTrue(evidenceNode.labelTruncated)
        XCTAssertTrue(evidenceNode.valueTruncated)
        XCTAssertLessThanOrEqual(evidenceNode.role.utf8.count, bounds.maxRoleBytes)
        XCTAssertLessThanOrEqual((evidenceNode.subrole ?? "").utf8.count, bounds.maxRoleBytes)
        XCTAssertLessThanOrEqual((evidenceNode.label ?? "").utf8.count, bounds.maxStringBytes)
        XCTAssertLessThanOrEqual((evidenceNode.value ?? "").utf8.count, bounds.maxStringBytes)
    }

    func testRedactedSensitiveNodeWithGiantStringsIsBoundedAndNeverReadsItsValues() throws {
        let giantSensitiveRole = "AXSecureTextField" + String(repeating: "🔒", count: 5_000)
        let giantSubrole = "AXSubrole" + String(repeating: "s", count: 5_000)
        let secure = FakeAXNode(role: giantSensitiveRole, subrole: giantSubrole, label: "PIN", value: "4321")
        let window = FakeAXNode(role: "AXWindow", title: "Sign in", children: [secure])

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy()
        let bounds = policy.bounds
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(secure.valueReads, 0, "a secure field's value is never read, however long its role")
        XCTAssertEqual(secure.labelReads, 0)
        XCTAssertEqual(secure.childrenReads, 0)

        let node = evidence.nodes[0]
        XCTAssertTrue(node.redacted)
        XCTAssertNil(node.label)
        XCTAssertNil(node.value)
        XCTAssertTrue(node.roleTruncated)
        XCTAssertTrue(node.subroleTruncated)
        XCTAssertLessThanOrEqual(node.role.utf8.count, bounds.maxRoleBytes)
        XCTAssertLessThanOrEqual((node.subrole ?? "").utf8.count, bounds.maxRoleBytes)
        XCTAssertLessThanOrEqual(try encodedSize(evidence), bounds.maxResponseBytes)
        XCTAssertFalse(try encode(evidence).contains("4321"))
    }

    func testMultibyteTruncationStopsOnScalarBoundaries() throws {
        let window = FakeAXNode(
            role: "AXWindow",
            title: String(repeating: "€", count: 100),
            children: [
                FakeAXNode(
                    role: "AXStaticText",
                    label: String(repeating: "🙂", count: 100),
                    value: String(repeating: "值", count: 100)
                )
            ]
        )
        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(
            bounds: ForegroundObservationBounds(maxStringBytes: 10, maxWindowTitleBytes: 7)
        )
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.window.title, String(repeating: "€", count: 2))
        XCTAssertTrue(evidence.window.titleTruncated)
        XCTAssertEqual(evidence.nodes[0].label, String(repeating: "🙂", count: 2))
        XCTAssertEqual(evidence.nodes[0].value, String(repeating: "值", count: 3))
        XCTAssertTrue(evidence.nodes[0].labelTruncated)
        XCTAssertTrue(evidence.nodes[0].valueTruncated)
        XCTAssertFalse((try encode(evidence)).contains("\u{FFFD}"))
    }

    func testWholeResponseCeilingDropsTrailingNodesAndReportsResponseTruncation() throws {
        let children = (0..<12).map { index in
            FakeAXNode(role: "AXStaticText", value: "v\(index)" + String(repeating: "x", count: 80))
        }
        let window = FakeAXNode(role: "AXWindow", title: "Ceiling", children: children)
        let source = FakeObservationSource()
        source.windowNodeValue = window

        let bounds = ForegroundObservationBounds(maxStringBytes: 90, maxResponseBytes: 2_048)
        XCTAssertLessThanOrEqual(
            bounds.responseEnvelopeCeiling,
            bounds.maxResponseBytes,
            "the configured ceiling must cover the bounded envelope"
        )
        let policy = ForegroundObservationPolicy(bounds: bounds)
        guard case let .evidence(evidence) = try observe(source, policy: policy) else {
            return XCTFail("expected evidence")
        }

        XCTAssertLessThanOrEqual(try encodedSize(evidence), bounds.maxResponseBytes)
        XCTAssertTrue(evidence.truncations.contains("response"))
        XCTAssertTrue(evidence.truncated)
        XCTAssertEqual(evidence.quality, "partial")
        XCTAssertGreaterThan(evidence.nodes.count, 0)
        XCTAssertLessThan(evidence.nodes.count, children.count)
        XCTAssertEqual(evidence.stats.visitedNodes, children.count)
        XCTAssertEqual(evidence.stats.emittedNodes, evidence.nodes.count)
        for (index, node) in evidence.nodes.enumerated() {
            XCTAssertEqual(node.value, children[index].valueValue, "the kept nodes are the preorder prefix")
            XCTAssertEqual(node.role, "AXStaticText")
        }
        XCTAssertEqual(
            children[evidence.nodes.count].roleReads,
            1,
            "the ceiling trims after the traversal, so every visited node was still inspected once"
        )
    }

    func testTheDocumentedEnvelopeCeilingCoversAWorstCaseNodeFreeSnapshot() throws {
        let bounds = ForegroundObservationBounds()
        let evidence = ForegroundEvidence(
            observedAtMs: 1_756_000_000_000,
            projectId: String(repeating: "p", count: bounds.maxProjectIdBytes),
            application: ForegroundEvidenceApplication(
                pid: Int32.max,
                bundleId: String(repeating: "b", count: bounds.maxApplicationFieldBytes),
                name: String(repeating: "n", count: bounds.maxApplicationFieldBytes),
                bundleIdTruncated: true,
                nameTruncated: true
            ),
            window: ForegroundEvidenceWindow(
                role: String(repeating: "r", count: bounds.maxRoleBytes),
                roleTruncated: true,
                title: String(repeating: "t", count: bounds.maxWindowTitleBytes),
                titleTruncated: true
            ),
            nodes: [],
            quality: "partial",
            truncated: true,
            truncations: ForegroundObservationTruncation.allCases.map(\.rawValue).sorted(),
            stats: ForegroundEvidenceStats(
                visitedNodes: .max,
                emittedNodes: 0,
                maxDepthReached: .max,
                estimatedBytes: bounds.maxTotalBytes
            )
        )

        XCTAssertLessThanOrEqual(try encodedSize(evidence), bounds.responseEnvelopeCeiling)
        XCTAssertLessThanOrEqual(bounds.responseEnvelopeCeiling, bounds.maxResponseBytes)
    }

    func testOverlongProjectIdIsRefusedBeforeAnyOsRead() {
        let source = FakeObservationSource()
        source.windowNodeValue = FakeAXNode(role: "AXWindow", title: "T")
        let observer = ForegroundObserver(source: source, now: TestClock().now)
        let bounds = ForegroundObservationBounds()
        let longId = String(repeating: "p", count: bounds.maxProjectIdBytes + 1)

        XCTAssertThrowsError(
            try observer.observe(scope: ActionScope(profileId: "profile-observe", projectId: longId, sensitivity: .normal))
        ) { error in
            XCTAssertEqual(
                error as? ActionServiceError,
                .invalidInput("observe requires a projectId of at most \(bounds.maxProjectIdBytes) UTF-8 bytes")
            )
        }
        XCTAssertEqual(source.applicationNodeRequests, 0, "an overlong scope fails closed before any OS read")
        XCTAssertEqual(source.windowNodeRequests, 0)
    }

    // MARK: - deadline checks

    func testDeadlineChecksStopChildEnumerationAndLaterReads() throws {
        let grandchild = FakeAXNode(role: "AXStaticText", value: "deep")
        let group = FakeAXNode(role: "AXGroup", children: [grandchild])
        let later = FakeAXNode(role: "AXButton", value: "later")
        let window = FakeAXNode(role: "AXWindow", title: "Deadline", children: [group, later])

        let source = FakeObservationSource()
        source.windowNodeValue = window
        let policy = ForegroundObservationPolicy(bounds: ForegroundObservationBounds(maxTraversalSeconds: 1.0))
        let observer = ForegroundObserver(source: source, policy: policy, now: TestClock(step: 0.3).now)
        guard case let .evidence(evidence) = try observer.observe(scope: scope()) else {
            return XCTFail("expected evidence")
        }

        XCTAssertEqual(evidence.stats.visitedNodes, 1, "the second node is never started")
        XCTAssertEqual(evidence.nodes.map(\.role), ["AXGroup"])
        XCTAssertTrue(evidence.truncations.contains("time"))
        XCTAssertEqual(group.labelReads, 1, "the read before the deadline still happened")
        XCTAssertEqual(group.childrenReads, 0, "no child enumeration starts after the deadline")
        XCTAssertEqual(grandchild.roleReads, 0)
        XCTAssertEqual(later.roleReads, 0, "no read happens after the deadline")
    }
}
