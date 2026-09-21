import Foundation
import XCTest

import DesktopAX

/// Pins the one contract both halves of C02 must agree on: the canonical JSON encoding, the
/// SHA-256 argument hash, and the derived proposal/grant ids. The expected values below are the
/// values `packages/desktop-tools/src/actions/arguments.ts` produces for the frozen fixture
/// scenario (`fixtures/desktop/actions/c02-actions.json`), and the TypeScript lifecycle test pins
/// the identical constants, so a change in either implementation is caught on both sides.
final class C02CrossLanguageTests: XCTestCase {

    /// `sha256Hex(argumentHashFor(fixture edit))` from the TypeScript implementation.
    static let editArgumentHash = "4f63ca0fdcb18b837d50e82be720c543831534090f6b2d42e6e71a3b44488dc4"
    /// `proposalIdFor` for the same binding and the fixture idempotency key.
    static let editProposalId = "proposal-56f1aa973e94d704"
    /// `authorizationIdFor` for the fixture grant utterance at 2026-09-21T10:00:00.000Z, sequence 1.
    static let editGrantId = "grant-c1f65fadde95135a"
    /// `sha256Hex(argumentHashFor(fixture multi-step))` from the TypeScript implementation.
    static let multiStepArgumentHash = "d7a834a46f56177f881d78db5181db14d626498c634704e7043534c5cf5274ca"
    /// `canonicalJson({ b: 1, a: [1, 'x'] })` from the TypeScript implementation.
    static let canonicalSample = #"{"a":[1,"x"],"b":1}"#

    func testCanonicalJSONMatchesTheTypeScriptEncoding() {
        let sample = CanonicalJSON.object([
            "b": .number(1),
            "a": .array([.number(1), .string("x")]),
        ])
        XCTAssertEqual(sample.encoded, Self.canonicalSample, "object keys sort and arrays keep their order")
        XCTAssertEqual(CanonicalJSON.null.encoded, "null")
        XCTAssertEqual(CanonicalJSON.string("line\nquote\"slash\\").encoded, #""line\nquote\"slash\\""#)
        XCTAssertEqual(CanonicalJSON.object([:]).encoded, "{}")
        XCTAssertEqual(CanonicalJSON.number(-0.0).encoded, "0", "the encoder never emits a negative zero")
        XCTAssertEqual(CanonicalJSON.number(1_500).encoded, "1500")
    }

    func testSha256MatchesTheTypeScriptHash() {
        XCTAssertEqual(
            sha256Hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "the empty string is the standard SHA-256 vector both implementations use"
        )
    }

    /// The same fixture binding must produce the same argument hash, proposal id, and grant id in
    /// Swift as in TypeScript: the native session and the widget's proposal name the same bytes.
    func testFixtureScenarioHashesAndIdsMatchTheTypeScriptImplementation() throws {
        let fixture = C02ActionLifecycleTests.fixture
        let run = C02ActionLifecycleTests().harness()

        XCTAssertEqual(
            run.service.argumentHashFor(actionId: fixture.edit.actionId, effect: .localWrite, steps: run.fixtureEditSteps()),
            Self.editArgumentHash,
            "the edit argument hash is byte-identical across the TypeScript and Swift implementations"
        )
        XCTAssertEqual(
            run.service.argumentHashFor(actionId: fixture.multiStep.actionId, effect: .localWrite, steps: run.fixtureMultiSteps()),
            Self.multiStepArgumentHash,
            "the multi-step argument hash is byte-identical across the TypeScript and Swift implementations"
        )

        let proposal = try run.propose(
            actionId: fixture.edit.actionId,
            idempotencyKey: fixture.edit.idempotencyKey,
            steps: run.fixtureEditSteps()
        )
        XCTAssertEqual(proposal.proposalId, Self.editProposalId, "the proposal id derives from the same canonical bytes")
        let authorization = try run.grant(proposal.proposalId)
        XCTAssertEqual(authorization.authorizationId, Self.editGrantId, "the grant id derives from the same canonical bytes")
        XCTAssertEqual(authorization.expiresAt, "2026-09-21T10:00:30.000Z")
    }

    func testFingerprintCoversTheBoundTargetIdentity() {
        let fixture = C02ActionLifecycleTests.fixture
        let control = fixture.controls[0]
        func state(window: String, label: String) -> AXControlState {
            AXControlState(
                appBundleId: fixture.app.bundleId,
                windowTitle: window,
                role: control.role,
                label: label,
                value: control.value,
                enabled: control.enabled,
                focused: control.focused,
                selected: false
            )
        }
        let base = state(window: fixture.app.windowTitle, label: control.label)
        XCTAssertNotEqual(
            base.fingerprint,
            state(window: fixture.app.windowTitle, label: "Subject (replaced control)").fingerprint,
            "a renamed or replaced control changes the fingerprint"
        )
        XCTAssertNotEqual(
            base.fingerprint,
            state(window: "Draft — Fixture Notes", label: control.label).fingerprint,
            "a replaced window changes the fingerprint"
        )
        XCTAssertEqual(base.fingerprint.count, 64, "the fingerprint is the SHA-256 of the canonical identity")
        XCTAssertNotEqual(base.fingerprint, control.fingerprint,
                          "the fixture's synthetic fingerprint is a label, not the live identity hash")
    }
}
