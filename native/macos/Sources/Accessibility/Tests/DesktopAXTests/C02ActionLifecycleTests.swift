import Foundation
import XCTest

import DesktopAX

/// C02's native oracle: the same lifecycle the frozen TypeScript oracle pins, driven against a
/// deterministic `AXDriver` stub instead of `AXUIElement`s. It loads the frozen scenario corpus
/// (`fixtures/desktop/actions/c02-actions.json`) so the native half executes the identical edit,
/// guard mutations, and cancel scenario, and it pins the cross-language argument hash so the
/// TypeScript grant and the Swift session name the same bytes.
final class C02ActionLifecycleTests: XCTestCase {

    // MARK: - fixture

    struct Fixture: Decodable {
        struct Project: Decodable { let projectId: String }
        struct App: Decodable { let bundleId: String; let windowTitle: String }
        struct VoiceRequest: Decodable { let utteranceId: String; let text: String; let grantText: String }
        struct Control: Decodable {
            let ref: String
            let role: String
            let label: String
            let value: String
            let enabled: Bool
            let focused: Bool
            let fingerprint: String
        }
        struct Edit: Decodable {
            let actionId: String
            let idempotencyKey: String
            let stepId: String
            let targetRef: String
            let value: String
            let untouchedRef: String
        }
        struct MultiStep: Decodable {
            struct Step: Decodable { let stepId: String; let targetRef: String; let value: String }
            let actionId: String
            let idempotencyKey: String
            let steps: [Step]
        }
        struct Guard: Decodable {
            struct Patch: Decodable {
                struct State: Decodable { let focused: Bool?; let enabled: Bool?; let label: String? }
                let ref: String
                let state: State
            }
            let key: String
            let reason: String
            let patch: [Patch]?
            let clockOffsetMs: Double?
        }
        let profileId: String
        let project: Project
        let app: App
        let voiceRequest: VoiceRequest
        let controls: [Control]
        let edit: Edit
        let multiStep: MultiStep
        let guards: [Guard]
    }

    static let now = Date(timeIntervalSince1970: 1_789_984_800) // 2026-09-21T10:00:00.000Z
    static let grantedAtMs: Double = 1_789_984_800_000

    static var fixture: Fixture = {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent("fixtures/desktop/actions/c02-actions.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                do {
                    return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
                } catch {
                    fatalError("C02 native oracle: cannot decode \(candidate.path): \(error)")
                }
            }
            directory.deleteLastPathComponent()
        }
        fatalError("C02 native oracle: fixtures/desktop/actions/c02-actions.json not found above \(#filePath)")
    }()

    // MARK: - stub boundary

    /// One control in the stub's synthetic window; the fingerprint is derived the way the real
    /// resolver derives it, so a replaced or renamed control changes it.
    final class StubAXDriver: AXDriver {
        struct Control {
            var appBundleId: String
            var windowTitle: String
            var role: String
            var label: String
            var value: String
            var enabled: Bool
            var focused: Bool
            var selected: Bool = false
        }

        struct Write: Equatable { let targetRef: String; let value: String }
        struct ActionCall: Equatable { let targetRef: String; let action: AXAction }

        private(set) var controls: [String: Control]
        private(set) var writes: [Write] = []
        private(set) var inspections: [String] = []
        private(set) var actions: [ActionCall] = []
        private(set) var focusMoves: [String] = []
        /// Models an AX write the application accepts but never applies.
        var applyWrites = true

        init(controls: [String: Control]) { self.controls = controls }

        func patch(_ targetRef: String, _ patch: (inout Control) -> Void) {
            guard var control = controls[targetRef] else { fatalError("unknown stub control \(targetRef)") }
            patch(&control)
            controls[targetRef] = control
        }

        func value(of targetRef: String) -> String? { controls[targetRef]?.value }

        func liveFingerprint(of targetRef: String) -> String? { state(of: targetRef)?.fingerprint }

        func inspect(_ target: AXTargetRef) throws -> AXControlState? {
            inspections.append(target.rawValue)
            return state(of: target.rawValue)
        }

        func setValue(_ target: AXTargetRef, value: String) throws {
            writes.append(Write(targetRef: target.rawValue, value: value))
            guard var control = controls[target.rawValue] else {
                throw AXDriverError.resolutionFailed(target.rawValue)
            }
            if applyWrites {
                control.value = value
                controls[target.rawValue] = control
            }
        }

        func perform(_ target: AXTargetRef, action: AXAction) throws {
            actions.append(ActionCall(targetRef: target.rawValue, action: action))
            guard controls[target.rawValue] != nil else {
                throw AXDriverError.resolutionFailed(target.rawValue)
            }
        }

        func focus(_ target: AXTargetRef) throws {
            focusMoves.append(target.rawValue)
            guard var control = controls[target.rawValue] else {
                throw AXDriverError.resolutionFailed(target.rawValue)
            }
            control.focused = true
            controls[target.rawValue] = control
        }

        private func state(of targetRef: String) -> AXControlState? {
            guard let control = controls[targetRef] else { return nil }
            return AXControlState(
                appBundleId: control.appBundleId,
                windowTitle: control.windowTitle,
                role: control.role,
                label: control.label,
                value: control.value,
                enabled: control.enabled,
                focused: control.focused,
                selected: control.selected
            )
        }
    }

    // MARK: - harness

    struct Harness {
        let driver: StubAXDriver
        let service: DesktopActionService
        let fixture: Fixture
        private let clock: Clock

        final class Clock {
            var currentMs: Double
            init(_ currentMs: Double) { self.currentMs = currentMs }
            func advance(byMs ms: Double) { currentMs += ms }
            func set(_ ms: Double) { currentMs = ms }
        }

        init(fixture: Fixture) {
            self.fixture = fixture
            let clock = Clock(C02ActionLifecycleTests.grantedAtMs)
            self.clock = clock
            var controls: [String: StubAXDriver.Control] = [:]
            for control in fixture.controls {
                controls[control.ref] = StubAXDriver.Control(
                    appBundleId: fixture.app.bundleId,
                    windowTitle: fixture.app.windowTitle,
                    role: control.role,
                    label: control.label,
                    value: control.value,
                    enabled: control.enabled,
                    focused: control.focused
                )
            }
            let driver = StubAXDriver(controls: controls)
            self.driver = driver
            self.service = DesktopActionService(
                ax: driver,
                now: { Date(timeIntervalSince1970: clock.currentMs / 1000) },
                scope: ActionScope(
                    profileId: fixture.profileId,
                    projectId: fixture.project.projectId,
                    sensitivity: .normal
                )
            )
        }

        func advanceClock(byMs ms: Double) { clock.advance(byMs: ms) }

        /// Binds the live fingerprint the stub resolver captured, the way a granted target is bound.
        func step(_ stepId: String, _ targetRef: String, _ value: String) -> ActionStep {
            guard let fingerprint = driver.liveFingerprint(of: targetRef) else {
                fatalError("the stub must define control \(targetRef)")
            }
            return ActionStep(
                stepId: stepId,
                operation: .setValue,
                targetRef: AXTargetRef(targetRef),
                targetFingerprint: fingerprint,
                value: value
            )
        }

        /// Binds the fixture's synthetic fingerprint label: what the frozen TypeScript oracle
        /// drives, so the cross-language argument hash can be compared byte for byte.
        func fixtureStep(_ stepId: String, _ targetRef: String, _ value: String) -> ActionStep {
            guard let control = fixture.controls.first(where: { $0.ref == targetRef }) else {
                fatalError("the fixture must define control \(targetRef)")
            }
            return ActionStep(
                stepId: stepId,
                operation: .setValue,
                targetRef: AXTargetRef(targetRef),
                targetFingerprint: control.fingerprint,
                value: value
            )
        }

        func editSteps() -> [ActionStep] {
            [step(fixture.edit.stepId, fixture.edit.targetRef, fixture.edit.value)]
        }

        func multiSteps() -> [ActionStep] {
            fixture.multiStep.steps.map { step($0.stepId, $0.targetRef, $0.value) }
        }

        func fixtureEditSteps() -> [ActionStep] {
            [fixtureStep(fixture.edit.stepId, fixture.edit.targetRef, fixture.edit.value)]
        }

        func fixtureMultiSteps() -> [ActionStep] {
            fixture.multiStep.steps.map { fixtureStep($0.stepId, $0.targetRef, $0.value) }
        }

        func propose(
            actionId: String,
            idempotencyKey: String,
            steps: [ActionStep]
        ) throws -> ActionProposal {
            try service.propose(
                actionId: actionId,
                idempotencyKey: idempotencyKey,
                utterance: ActionUtterance(
                    utteranceId: fixture.voiceRequest.utteranceId,
                    text: fixture.voiceRequest.text
                ),
                effect: .localWrite,
                steps: steps
            )
        }

        func proposeEdit() throws -> ActionProposal {
            try propose(actionId: fixture.edit.actionId, idempotencyKey: fixture.edit.idempotencyKey, steps: editSteps())
        }

        func proposeMultiStep() throws -> ActionProposal {
            try propose(
                actionId: fixture.multiStep.actionId,
                idempotencyKey: fixture.multiStep.idempotencyKey,
                steps: multiSteps()
            )
        }

        func grant(_ proposalId: String) throws -> ActionAuthorization {
            try service.authorize(
                proposalId: proposalId,
                utterance: ActionUtterance(
                    utteranceId: "\(fixture.voiceRequest.utteranceId)-grant",
                    text: fixture.voiceRequest.grantText
                )
            )
        }

        var subjectValue: String? { driver.value(of: fixture.edit.targetRef) }
        var bodyValue: String? { driver.value(of: fixture.edit.untouchedRef) }

        func step(_ receipt: ActionReceipt, _ stepId: String) -> StepReceipt {
            guard let found = receipt.steps.first(where: { $0.stepId == stepId }) else {
                fatalError("the receipt must report step \(stepId); got \(receipt.steps)")
            }
            return found
        }

        func evidence(_ stepId: String) -> [String] { ["act:before:\(stepId)", "act:after:\(stepId)"] }
    }

    func harness() -> Harness { Harness(fixture: Self.fixture) }

    func unexecuted(_ receipt: StepReceipt, _ description: String) {
        XCTAssertEqual(receipt.status, .unexecuted, description)
        XCTAssertNil(receipt.before, description)
        XCTAssertNil(receipt.after, description)
        XCTAssertEqual(receipt.evidenceIds, [], description)
        XCTAssertNil(receipt.verification, description)
    }

    // MARK: - criterion 1

    func testVoiceRequestBecomesAProposalAndTheGrantedEditIsVerified() throws {
        let run = harness()

        let proposal = try run.proposeEdit()
        XCTAssertEqual(proposal.state, "proposed", "a voice request only creates a proposal")
        XCTAssertEqual(proposal.actionId, Self.fixture.edit.actionId)
        XCTAssertEqual(proposal.argumentHash.count, 64, "the proposal binds its arguments")
        XCTAssertEqual(proposal.scope.projectId, Self.fixture.project.projectId)
        XCTAssertEqual(run.driver.writes.count, 0, "proposing never writes to the desktop")
        XCTAssertEqual(run.driver.inspections.count, 0, "proposing never reads the desktop")

        let blocked = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(blocked.status, .denied, "an unauthorized proposal never executes")
        XCTAssertEqual(blocked.reason, .notAuthorized, "the receipt names the missing grant")
        XCTAssertEqual(run.driver.writes.count, 0, "no AX write happens before the voice grant")
        unexecuted(run.step(blocked, Self.fixture.edit.stepId), "the ungranted step stays unexecuted")
        XCTAssertEqual(blocked.evidenceIds, [], "a stopped step has no before/after evidence")

        let authorization = try run.grant(proposal.proposalId)
        XCTAssertTrue(authorization.authorized, "the voice grant authorizes the proposal")
        XCTAssertEqual(authorization.argumentHash, proposal.argumentHash, "the grant binds the proposal arguments")
        XCTAssertEqual(authorization.expiresAt, "2026-09-21T10:00:30.000Z", "the grant expires 30 s after it was issued")

        let outcome = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(outcome.status, .completed, "the granted step completes")
        XCTAssertNil(outcome.reason, "a completed action carries no stop reason")
        XCTAssertEqual(outcome.actionId, Self.fixture.edit.actionId)
        let step = run.step(outcome, Self.fixture.edit.stepId)
        XCTAssertEqual(step.status, .completed)
        XCTAssertEqual(step.before, "Quarterly draft")
        XCTAssertEqual(step.after, "Final report")
        XCTAssertEqual(step.evidenceIds, run.evidence(Self.fixture.edit.stepId))
        XCTAssertEqual(step.verification, .valueReadback, "a set_value is only completed by a value read-back")
        XCTAssertEqual(outcome.evidenceIds, run.evidence(Self.fixture.edit.stepId))
        XCTAssertEqual(run.subjectValue, Self.fixture.edit.value, "the intended field holds the requested value")
        XCTAssertEqual(run.bodyValue, "Body text stays put", "the rest of the window is untouched")
        XCTAssertEqual(run.driver.writes.map(\.targetRef), [Self.fixture.edit.targetRef])
        XCTAssertEqual(run.driver.writes.map(\.value), [Self.fixture.edit.value])
        XCTAssertEqual(run.driver.inspections, [Self.fixture.edit.targetRef, Self.fixture.edit.targetRef],
                       "one preflight read and one read-back, and nothing else")
    }

    // MARK: - criterion 2

    func testChangedFocusIdentityDisabledStateOrExpiredGrantStopsExecution() throws {
        XCTAssertEqual(Self.fixture.guards.map(\.reason),
                       ["focus_changed", "target_identity_changed", "target_disabled", "grant_expired"],
                       "the fixture carries exactly the four acceptance guards")

        for guarded in Self.fixture.guards {
            let run = harness()
            let proposal = try run.proposeEdit()
            _ = try run.grant(proposal.proposalId)

            for patch in guarded.patch ?? [] {
                run.driver.patch(patch.ref) { control in
                    if let focused = patch.state.focused { control.focused = focused }
                    if let enabled = patch.state.enabled { control.enabled = enabled }
                    if let label = patch.state.label { control.label = label }
                }
            }
            if let offset = guarded.clockOffsetMs { run.advanceClock(byMs: offset) }

            let outcome = try run.service.advance(proposalId: proposal.proposalId)

            XCTAssertEqual(outcome.status, .denied, "\(guarded.key): the guarded step is stopped")
            XCTAssertEqual(outcome.reason?.rawValue, guarded.reason, "\(guarded.key): the receipt names the guard")
            XCTAssertEqual(run.driver.writes.count, 0, "\(guarded.key): stopped means no AX write")
            unexecuted(run.step(outcome, Self.fixture.edit.stepId), "\(guarded.key): the step is reported unexecuted")
            XCTAssertEqual(outcome.evidenceIds, [], "\(guarded.key): a stopped step has no before/after evidence")
            XCTAssertEqual(run.subjectValue, "Quarterly draft", "\(guarded.key): the target keeps its value")
        }
    }

    func testGuardStopLeavesTheStepResumableAfterAFreshGrant() throws {
        let run = harness()
        let proposal = try run.proposeEdit()
        _ = try run.grant(proposal.proposalId)

        run.driver.patch(Self.fixture.edit.targetRef) { $0.enabled = false }
        let stopped = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(stopped.status, .denied)
        XCTAssertEqual(stopped.reason, .targetDisabled)
        XCTAssertEqual(run.driver.writes.count, 0)

        run.driver.patch(Self.fixture.edit.targetRef) { $0.enabled = true }
        let renewed = try run.grant(proposal.proposalId)
        XCTAssertTrue(renewed.authorized)
        let resumed = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(resumed.status, .completed, "a stopped step stays unexecuted, so a fresh grant can preflight it again")
        XCTAssertEqual(run.step(resumed, Self.fixture.edit.stepId).status, .completed)
        XCTAssertEqual(run.driver.writes.count, 1, "only the resumed step reaches AX")
    }

    func testGrantForADecidedActionIsRefusedAndAnExpiredGrantStopsBeforeAnyRead() throws {
        let run = harness()
        let proposal = try run.proposeEdit()
        _ = try run.grant(proposal.proposalId)
        _ = try run.service.advance(proposalId: proposal.proposalId)

        let inspectionsAfterCompletion = run.driver.inspections.count
        let refused = try run.grant(proposal.proposalId)
        XCTAssertFalse(refused.authorized, "a completed action is never re-opened by a late grant")
        let replay = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(replay.status, .completed, "a decided action returns its stored receipt")
        XCTAssertEqual(run.driver.inspections.count, inspectionsAfterCompletion, "a decided action never reads AX again")

        let second = try run.proposeMultiStep()
        _ = try run.grant(second.proposalId)
        run.advanceClock(byMs: 30_001)
        let before = run.driver.inspections.count
        let expired = try run.service.advance(proposalId: second.proposalId)
        XCTAssertEqual(expired.status, .denied)
        XCTAssertEqual(expired.reason, .grantExpired, "the clock moved past the 30 s authorization")
        XCTAssertEqual(run.driver.inspections.count, before, "an expired grant stops before any AX read")
        XCTAssertEqual(run.driver.writes.count, 1, "the second action never reached AX")
    }

    // MARK: - criterion 3

    func testCancellingBetweenStepsReportsCompletedVersusUnexecutedSteps() throws {
        let run = harness()
        let proposal = try run.proposeMultiStep()
        _ = try run.grant(proposal.proposalId)
        let steps = Self.fixture.multiStep.steps

        let first = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(first.status, .inProgress, "the first of two steps leaves the action in progress")
        let clear = run.step(first, steps[0].stepId)
        XCTAssertEqual(clear.status, .completed)
        XCTAssertEqual(clear.before, "Quarterly draft")
        XCTAssertEqual(clear.after, steps[0].value)
        XCTAssertEqual(clear.evidenceIds, run.evidence(steps[0].stepId))
        unexecuted(run.step(first, steps[1].stepId), "the second step is still unexecuted")
        XCTAssertEqual(run.subjectValue, steps[0].value, "the completed step changed its field")
        XCTAssertEqual(run.driver.writes.count, 1, "only the completed step reached AX")

        let cancelled = try run.service.cancel(proposalId: proposal.proposalId)
        XCTAssertEqual(cancelled.status, .cancelled, "cancelling stops the remaining steps")
        XCTAssertEqual(cancelled.reason, .cancelledByUser)
        XCTAssertEqual(run.step(cancelled, steps[0].stepId).status, .completed, "the completed step stays reported as completed")
        XCTAssertEqual(run.step(cancelled, steps[0].stepId).evidenceIds, run.evidence(steps[0].stepId))
        unexecuted(run.step(cancelled, steps[1].stepId), "the remaining step is reported unexecuted")
        XCTAssertEqual(cancelled.evidenceIds, run.evidence(steps[0].stepId), "only completed work carries evidence")
        XCTAssertEqual(run.driver.writes.count, 1, "cancel stops the remaining steps before AX")
        XCTAssertEqual(run.subjectValue, steps[0].value, "the unexecuted step never wrote its value")
        XCTAssertEqual(run.bodyValue, "Body text stays put", "the other field stays untouched")

        let resumed = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(resumed.status, .cancelled, "a cancelled action never resumes")
        XCTAssertEqual(run.driver.writes.count, 1, "a cancelled action never reaches AX again")
    }

    func testAGuardChangeBetweenStepsStopsTheRestOfTheAction() throws {
        let run = harness()
        let proposal = try run.proposeMultiStep()
        _ = try run.grant(proposal.proposalId)
        let steps = Self.fixture.multiStep.steps

        let first = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(first.status, .inProgress)

        run.driver.patch(steps[1].targetRef) { $0.enabled = false }
        let stopped = try run.service.advance(proposalId: proposal.proposalId)

        XCTAssertEqual(stopped.status, .denied, "the second step is preflighted against the live control")
        XCTAssertEqual(stopped.reason, .targetDisabled)
        XCTAssertEqual(run.step(stopped, steps[0].stepId).status, .completed, "already completed work stays reported")
        unexecuted(run.step(stopped, steps[1].stepId), "the disabled second step is reported unexecuted")
        XCTAssertEqual(run.driver.writes.count, 1, "the disabled step never reaches AX")
        XCTAssertEqual(run.subjectValue, steps[0].value, "the disabled target keeps the completed value")
    }

    // MARK: - verification strength

    func testAWriteTheApplicationDoesNotApplyIsNeverReportedCompleted() throws {
        let run = harness()
        let proposal = try run.proposeEdit()
        _ = try run.grant(proposal.proposalId)
        run.driver.applyWrites = false

        let outcome = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(outcome.status, .failed, "a disagreeing read-back is never a completed action")
        XCTAssertEqual(outcome.reason, .verificationFailed)
        let step = run.step(outcome, Self.fixture.edit.stepId)
        XCTAssertEqual(step.status, .failed)
        XCTAssertEqual(step.before, "Quarterly draft")
        XCTAssertEqual(step.after, "Quarterly draft", "the read-back disagrees, so the step is not verified")
        XCTAssertEqual(step.evidenceIds, run.evidence(Self.fixture.edit.stepId))
        XCTAssertEqual(run.driver.writes.count, 1)
        XCTAssertEqual(run.subjectValue, "Quarterly draft", "the field kept its value")

        let replay = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(replay.status, .failed, "a verification failure is terminal, never retried")
        XCTAssertEqual(run.driver.writes.count, 1, "a failed step is never blindly repeated")
    }

    func testIdempotentReplayAndChangedArguments() throws {
        let run = harness()
        let first = try run.proposeEdit()
        let replay = try run.proposeEdit()
        XCTAssertEqual(replay.proposalId, first.proposalId, "the same request replays the same proposal")
        XCTAssertEqual(replay.argumentHash, first.argumentHash)

        XCTAssertThrowsError(try run.propose(
            actionId: Self.fixture.edit.actionId,
            idempotencyKey: Self.fixture.edit.idempotencyKey,
            steps: [run.step(Self.fixture.edit.stepId, Self.fixture.edit.targetRef, "Different value")]
        )) { error in
            XCTAssertEqual(error as? ActionServiceError,
                           .idempotencyConflict("idempotency key \(Self.fixture.edit.idempotencyKey) is already bound to different arguments"),
                           "changed arguments never reuse the bound proposal")
        }
        XCTAssertEqual(run.driver.writes.count, 0)
    }

    func testReadAndClickStepsVerifyTheirOwnWeakerProperties() throws {
        let run = harness()
        let control = Self.fixture.controls[0]
        let liveFingerprint = try XCTUnwrap(run.driver.liveFingerprint(of: control.ref))
        let readStep = ActionStep(
            stepId: "step-read",
            operation: .read,
            targetRef: AXTargetRef(control.ref),
            targetFingerprint: liveFingerprint,
            value: ""
        )
        let proposal = try run.propose(actionId: "act-c02-read", idempotencyKey: "idem-c02-read", steps: [readStep])
        _ = try run.grant(proposal.proposalId)
        run.driver.patch(control.ref) { $0.focused = false }

        let read = try run.service.advance(proposalId: proposal.proposalId)
        XCTAssertEqual(read.status, .completed, "a read observes state and needs no focus")
        let readReceipt = run.step(read, "step-read")
        XCTAssertEqual(readReceipt.before, "Quarterly draft")
        XCTAssertEqual(readReceipt.after, "Quarterly draft")
        XCTAssertEqual(readReceipt.evidenceIds, ["act:before:step-read"], "a read writes nothing, so only the read is evidence")
        XCTAssertEqual(readReceipt.verification, VerificationKind.none)
        XCTAssertEqual(run.driver.writes.count, 0)

        let clickStep = ActionStep(
            stepId: "step-press",
            operation: .click,
            targetRef: AXTargetRef(control.ref),
            targetFingerprint: liveFingerprint,
            value: ""
        )
        let press = try run.propose(actionId: "act-c02-press", idempotencyKey: "idem-c02-press", steps: [clickStep])
        _ = try run.grant(press.proposalId)
        run.driver.patch(control.ref) { $0.focused = true }
        let clicked = try run.service.advance(proposalId: press.proposalId)
        XCTAssertEqual(clicked.status, .completed)
        XCTAssertEqual(clicked.reason, nil)
        XCTAssertEqual(run.driver.actions, [StubAXDriver.ActionCall(targetRef: control.ref, action: .press)])
        XCTAssertEqual(run.step(clicked, "step-press").verification, .presenceOnly,
                       "a press claims only that the same control survived it, never a value change")
    }
}
