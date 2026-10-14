import Foundation
import XCTest
import DesktopAX

final class ObservationRegionsTests: XCTestCase {
    func testRejectsNonfiniteAndEmptyFramesButKeepsNegativeDisplayOrigins() {
        XCTAssertNil(ObservationFrame(x: .nan, y: 0, width: 2, height: 2).validated)
        XCTAssertNil(ObservationFrame(x: 0, y: 0, width: 0, height: 2).validated)
        XCTAssertNotNil(ObservationFrame(x: -1920, y: -200, width: 1920, height: 1080).validated)
    }
    func testSegmentationUsesUTF16RangesAndBoundsWork() {
        let text = "Hello 😀. Second sentence.\nAnother paragraph."
        let spans = ObservationTextSegmentation.spans(text, limit: 12)
        XCTAssertTrue(spans.contains { $0.kind == "sentence" })
        XCTAssertTrue(spans.contains { $0.kind == "paragraph" })
        for span in spans {
            XCTAssertEqual((text as NSString).substring(with: NSRange(location: span.start, length: span.length)), span.text)
        }
        XCTAssertEqual(ObservationTextSegmentation.spans(text, limit: 1).count, 1)
        XCTAssertTrue(ObservationTextSegmentation.spans(text, limit: 0).isEmpty)
    }
    func testOCRMappingFlipsVerticalAxisWithoutRetinaMultiplication() {
        let window = ObservationFrame(x: -1200, y: 100, width: 1000, height: 600)
        let mapped = LocalWindowOCR.logicalFrame(normalized: CGRect(x: 0.1, y: 0.7, width: 0.3, height: 0.2), window: window)
        XCTAssertEqual(mapped.x, -1100, accuracy: 0.01)
        XCTAssertEqual(mapped.y, 160, accuracy: 0.01)
        XCTAssertEqual(mapped.width, 300, accuracy: 0.01)
        XCTAssertEqual(mapped.height, 120, accuracy: 0.01)
    }
    func testOCRFailsClosedForSecureOrIncompleteTreesAndPrefersAX() {
        let frame = ObservationFrame(x: 0, y: 0, width: 500, height: 400)
        func evidence(_ nodes: [ForegroundEvidenceNode], truncated: Bool = false) -> ForegroundEvidence {
            ForegroundEvidence(observedAtMs: 1, projectId: "test",
                application: ForegroundEvidenceApplication(pid: 1, bundleId: "test", name: "test"),
                window: ForegroundEvidenceWindow(role: "AXWindow", title: "test", titleTruncated: false, frame: frame, id: "ax-test"),
                nodes: nodes, quality: "full", truncated: truncated, truncations: [],
                stats: ForegroundEvidenceStats(visitedNodes: nodes.count, emittedNodes: nodes.count, maxDepthReached: 1, estimatedBytes: 0))
        }
        let secure = ForegroundEvidenceNode(depth: 1, role: "AXSecureTextField", subrole: nil, label: nil, value: nil,
                         labelTruncated: false, valueTruncated: false, redacted: true)
        let accessible = ForegroundEvidenceNode(depth: 1, role: "AXButton", subrole: nil, label: "Save", value: nil,
                         labelTruncated: false, valueTruncated: false, redacted: false, frame: frame)
        XCTAssertTrue(LocalWindowOCR.eligible(evidence([])))
        XCTAssertFalse(LocalWindowOCR.eligible(evidence([secure])))
        XCTAssertFalse(LocalWindowOCR.eligible(evidence([], truncated: true)))
        XCTAssertFalse(LocalWindowOCR.eligible(evidence([accessible])))
    }
    func testLongDocumentsStillIncludeSentencesAndBoundUnicodeBytes() {
        let document = (0..<30).map { "Paragraph \($0). Another sentence." }.joined(separator: "\n")
        let spans = ObservationTextSegmentation.spans(document, limit: 12)
        XCTAssertEqual(spans.count, 12)
        XCTAssertEqual(spans.filter { $0.kind == "paragraph" }.count, 6)
        XCTAssertEqual(spans.filter { $0.kind == "sentence" }.count, 6)
        let unicode = String(repeating: "😀", count: 100)
        XCTAssertTrue(ObservationTextSegmentation.spans(unicode, limit: 2).allSatisfy { $0.text.utf8.count <= 160 })
    }
}
