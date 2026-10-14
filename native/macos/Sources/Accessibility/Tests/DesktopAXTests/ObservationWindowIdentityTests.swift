import XCTest
@testable import DesktopAX

final class ObservationWindowIdentityTests: XCTestCase {
    let frame = ObservationFrame(x: -1200, y: -180, width: 1000, height: 600)
    func window(pid: Int32 = 42, number: UInt32 = 123, frame: ObservationFrame? = nil, title: String? = "Fixture") -> QuartzObservationWindow {
        QuartzObservationWindow(pid: pid, number: number, frame: frame ?? self.frame, title: title)
    }
    func testUniqueOwnerAndGeometryProduceCrossProcessWindowNumber() {
        let windows = [window(pid: 1, number: 5), window()]
        XCTAssertEqual(ObservationWindowIdentity.match(pid: 42, frame: frame, title: "Fixture", windows: windows), "cg-123")
    }
    func testDuplicateCandidatesAndUnknownOwnerFailClosed() {
        XCTAssertNil(ObservationWindowIdentity.match(pid: 42, frame: frame, title: "Fixture", windows: [window(), window(number: 124)]))
        XCTAssertNil(ObservationWindowIdentity.match(pid: 41, frame: frame, title: "Fixture", windows: [window()]))
    }
    func testMissingQuartzTitleDoesNotRequireScreenPermission() {
        XCTAssertEqual(ObservationWindowIdentity.match(pid: 42, frame: frame, title: "Fixture", windows: [window(title: nil)]), "cg-123")
        XCTAssertEqual(ObservationWindowIdentity.match(pid: 42, frame: frame, title: nil, windows: [window()]), "cg-123")
        XCTAssertNil(ObservationWindowIdentity.match(pid: 42, frame: frame, title: "Other", windows: [window()]))
    }
    func testTitleCanDisambiguateButHiddenDuplicateTitlesCannot() {
        XCTAssertEqual(ObservationWindowIdentity.match(pid: 42, frame: frame, title: "Fixture", windows: [window(), window(number: 124, title: "Other")]), "cg-123")
        XCTAssertNil(ObservationWindowIdentity.match(pid: 42, frame: frame, title: "Fixture", windows: [window(title: nil), window(number: 124, title: nil)]))
    }
    func testGeometryTolerancePreservesNegativeOriginsAndRejectsLargerMismatch() {
        let nearby = ObservationFrame(x: -1199, y: -179, width: 1001, height: 599)
        XCTAssertEqual(ObservationWindowIdentity.match(pid: 42, frame: frame, title: nil, windows: [window(frame: nearby)]), "cg-123")
        let wrong = ObservationFrame(x: -1197, y: -180, width: 1000, height: 600)
        XCTAssertNil(ObservationWindowIdentity.match(pid: 42, frame: frame, title: nil, windows: [window(frame: wrong)]))
        XCTAssertNil(ObservationWindowIdentity.match(pid: 42, frame: frame, title: nil, windows: [window(number: 0)]))
    }
}
