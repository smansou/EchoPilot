import XCTest
@testable import DesktopAX

final class SemanticTargetAncestorTests: XCTestCase {
    final class Node {
        let role: String
        let subrole: String?
        var parent: Node?
        init(_ role: String, subrole: String? = nil, parent: Node? = nil) {
            self.role = role; self.subrole = subrole; self.parent = parent
        }
    }
    func select(_ node: Node, role: String?, max: Int = 32, budget: () -> Bool = { true }) throws -> Node? {
        try SemanticTargetAncestor.select(hit: node, preferredRole: role, maxAncestors: max,
            withinBudget: budget, role: { $0.role }, subrole: { $0.subrole }, parent: { $0.parent })
    }
    func testButtonLabelResolvesNearestButtonAndDefaultKeepsHit() throws {
        let outer = Node("AXButton")
        let inner = Node("AXButton", parent: outer)
        let label = Node("AXStaticText", parent: inner)
        XCTAssertTrue(try select(label, role: "AXButton") === inner)
        XCTAssertTrue(try select(label, role: nil) === label)
    }
    func testScrollContentFindsAreaAndMissingRoleRefuses() throws {
        let scroll = Node("AXScrollArea")
        let text = Node("AXStaticText", parent: scroll)
        XCTAssertTrue(try select(text, role: "AXScrollArea") === scroll)
        XCTAssertNil(try select(text, role: "AXLink"))
    }
    func testSecureAncestorsRefuseEvenWhenNearestCandidateMatches() {
        let secure = Node("AXTextField", subrole: "AXSecureTextField")
        let button = Node("AXButton", parent: secure)
        let label = Node("AXStaticText", parent: button)
        XCTAssertThrowsError(try select(label, role: "AXButton"))
        XCTAssertThrowsError(try select(Node("VendorPasswordContainer"), role: "AXTextField"))
    }
    func testCyclesDeepChainsAndExpiredBudgetFailClosed() throws {
        let cyclic = Node("AXButton")
        cyclic.parent = cyclic
        XCTAssertNil(try select(cyclic, role: "AXButton"))
        let root = Node("AXButton")
        let label = Node("AXStaticText", parent: Node("AXGroup", parent: root))
        XCTAssertNil(try select(label, role: "AXButton", max: 2))
        XCTAssertNil(try select(root, role: "AXButton", budget: { false }))
    }
    func testUnknownPreferredRoleIsRejected() {
        XCTAssertThrowsError(try select(Node("AXStaticText"), role: "AXStaticText"))
        XCTAssertThrowsError(try select(Node("AXButton"), role: "button"))
    }
}
