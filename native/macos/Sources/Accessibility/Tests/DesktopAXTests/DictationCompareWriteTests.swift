import Foundation
import Testing
import DesktopAX

struct DictationCompareWriteTests {
    @Test func userEditAfterGrantStopsBeforeWrite() throws {
        let run = C02ActionLifecycleTests().harness()
        let control = run.fixture.controls[0]
        let fingerprint = try #require(run.driver.liveFingerprint(of: control.ref))
        let step = ActionStep(stepId: "dictation", operation: .setValue, targetRef: AXTargetRef(control.ref), targetFingerprint: fingerprint, value: "dictated", expectedValue: control.value)
        let proposal = try run.propose(actionId: "dictation", idempotencyKey: "dictation", steps: [step])
        _ = try run.grant(proposal.proposalId)
        run.driver.patch(control.ref) { $0.value = "The user's later edit" }
        let receipt = try run.service.advance(proposalId: proposal.proposalId)
        #expect(receipt.status == .denied)
        #expect(receipt.reason == .targetIdentityChanged)
        #expect(run.driver.writes.isEmpty)
    }

    @Test func beforeValueIsBoundIntoGrant() throws {
        let run = C02ActionLifecycleTests().harness()
        let control = run.fixture.controls[0]
        let fingerprint = try #require(run.driver.liveFingerprint(of: control.ref))
        let first = ActionStep(stepId: "dictation", operation: .setValue, targetRef: AXTargetRef(control.ref), targetFingerprint: fingerprint, value: "dictated", expectedValue: "one")
        let second = ActionStep(stepId: "dictation", operation: .setValue, targetRef: AXTargetRef(control.ref), targetFingerprint: fingerprint, value: "dictated", expectedValue: "two")
        #expect(run.service.argumentHashFor(actionId: "dictation", effect: .localWrite, steps: [first]) != run.service.argumentHashFor(actionId: "dictation", effect: .localWrite, steps: [second]))
    }
}
