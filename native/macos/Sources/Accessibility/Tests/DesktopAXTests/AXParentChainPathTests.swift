import Testing
@testable import DesktopAX

struct AXParentChainPathTests {
    private struct Node: Equatable { let id: String }

    @Test func resolvesDeepFocusedNodeWithoutWalkingUnrelatedAppBranches() throws {
        let root = Node(id: "application")
        let window = Node(id: "window")
        let webArea = Node(id: "web-area")
        let field = Node(id: "focused-field")
        let siblings = (0..<130).map { Node(id: "unrelated-\($0)") } + [field]
        let parents = [window.id: root, webArea.id: window, field.id: webArea]
        let children = [root.id: [window], window.id: [webArea], webArea.id: siblings]

        let path = AXParentChainPath.resolve(
            root: root,
            target: field,
            maxDepth: 16,
            equals: ==,
            parent: { parents[$0.id] },
            children: { children[$0.id] }
        )

        #expect(path == [0, 0, 130])
    }

    @Test func refusesDetachedOrOverDeepTargetInsteadOfGuessing() {
        let root = Node(id: "application")
        let detached = Node(id: "detached")
        #expect(AXParentChainPath.resolve(
            root: root,
            target: detached,
            maxDepth: 16,
            equals: ==,
            parent: { _ in nil },
            children: { _ in nil }
        ) == nil)

        let chain = (0..<18).map { Node(id: "node-\($0)") }
        let parents = Dictionary(uniqueKeysWithValues: (1..<chain.count).map { (chain[$0].id, chain[$0 - 1]) })
        let children = Dictionary(uniqueKeysWithValues: (0..<(chain.count - 1)).map { (chain[$0].id, [chain[$0 + 1]]) })
        #expect(AXParentChainPath.resolve(
            root: chain[0],
            target: chain.last!,
            maxDepth: 16,
            equals: ==,
            parent: { parents[$0.id] },
            children: { children[$0.id] }
        ) == nil)
    }
}
