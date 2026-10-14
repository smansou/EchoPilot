import Foundation

/// §5.9 confirmation expiry: an authorization is live for at most 30 s after the grant.
public let maxAuthorizationMs: Double = 30_000

/// The explicit project association every proposal carries (mirrors `Scope` in the contracts
/// package; `restricted` is the contract's `private` sensitivity).
public struct ActionScope: Codable, Equatable, Sendable {
    public enum Sensitivity: String, Codable, Sendable {
        case normal
        case restricted = "private"
        case secret
    }

    public let profileId: String
    public let projectId: String?
    public let worktreeId: String?
    public let sessionId: String?
    public let sensitivity: Sensitivity

    public init(
        profileId: String,
        projectId: String? = nil,
        worktreeId: String? = nil,
        sessionId: String? = nil,
        sensitivity: Sensitivity
    ) {
        self.profileId = profileId
        self.projectId = projectId
        self.worktreeId = worktreeId
        self.sessionId = sessionId
        self.sensitivity = sensitivity
    }
}

/// §5.9 effect classification; bound into the argument hash so a grant cannot change the effect.
public enum ActionEffect: String, Codable, Sendable {
    case read
    case localWrite = "local_write"
    case external
}

/// The recognized voice request or grant utterance. No speech recognition runs in this seam.
public struct ActionUtterance: Codable, Equatable, Sendable {
    public let utteranceId: String
    public let text: String

    public init(utteranceId: String, text: String) {
        self.utteranceId = utteranceId
        self.text = text
    }
}

/// One ordered step of a proposed action.
public struct ActionStep: Codable, Equatable, Sendable {
    public let stepId: String
    public let operation: AXOperation
    public let targetRef: AXTargetRef
    public let targetFingerprint: String
    /// The requested value for `set_value`; the scroll direction for `scroll`; unused otherwise.
    public let value: String
    /// Optional compare-before-write guard for reversible edits, bound into authorization.
    public let expectedValue: String?

    public init(
        stepId: String,
        operation: AXOperation,
        targetRef: AXTargetRef,
        targetFingerprint: String,
        value: String,
        expectedValue: String? = nil
    ) {
        self.stepId = stepId
        self.operation = operation
        self.targetRef = targetRef
        self.targetFingerprint = targetFingerprint
        self.value = value
        self.expectedValue = expectedValue
    }
}

/// A voice request becomes this proposal; a proposal never executes by itself.
public struct ActionProposal: Codable, Equatable, Sendable {
    public let proposalId: String
    public let actionId: String
    public let state: String
    /// Binds the ordered steps (operation, target ref, target fingerprint, value) and the scope.
    public let argumentHash: String
    public let scope: ActionScope
}

/// The voice grant. It binds the proposal's argument hash and expires at most 30 s after it.
public struct ActionAuthorization: Codable, Equatable, Sendable {
    public let authorizationId: String
    public let proposalId: String
    public let authorized: Bool
    public let argumentHash: String
    public let expiresAt: String
}

public enum ActionStopReason: String, Codable, Sendable {
    case notAuthorized = "not_authorized"
    case grantExpired = "grant_expired"
    case focusChanged = "focus_changed"
    case targetIdentityChanged = "target_identity_changed"
    case targetDisabled = "target_disabled"
    case verificationFailed = "verification_failed"
    case cancelledByUser = "cancelled_by_user"
}

public enum ActionStatus: String, Codable, Sendable {
    case inProgress = "in_progress"
    case completed
    case denied
    case failed
    case cancelled
}

public enum StepStatus: String, Codable, Sendable {
    case completed
    case unexecuted
    case failed
}

/// How strongly a step's result was verified, so a receipt never implies more than was checked:
/// `value_readback` is C02's strong guarantee, `presence_only` only means the target survived the
/// action, and `none` marks a read that wrote nothing.
public enum VerificationKind: String, Codable, Sendable {
    case valueReadback = "value_readback"
    case focusReadback = "focus_readback"
    case selectedReadback = "selected_readback"
    case presenceOnly = "presence_only"
    case none
}

public struct StepReceipt: Codable, Equatable, Sendable {
    public let stepId: String
    public let status: StepStatus
    public let before: String?
    public let after: String?
    public let evidenceIds: [String]
    public let verification: VerificationKind?
}

/// The action receipt: the complete, ordered account of what happened to every step.
public struct ActionReceipt: Codable, Equatable, Sendable {
    public let actionId: String
    public let proposalId: String
    public let status: ActionStatus
    public let reason: ActionStopReason?
    public let steps: [StepReceipt]
    /// Union of the step evidence, in step order; derived, never invented.
    public let evidenceIds: [String]
}

public enum ActionServiceError: Error, Equatable {
    case invalidInput(String)
    case unknownProposal(String)
    case idempotencyConflict(String)
}

/// C02's native lifecycle: proposal → grant → preflight → one AX step → verified receipt, with
/// cancel between steps. It is the Swift counterpart of `packages/desktop-tools/src/actions/`, so
/// the offline TypeScript oracle and the real AX session obey one rule set — the guards are
/// re-checked for every step, a stopped step stays unexecuted, and a write is only reported
/// completed when the read-back agrees (or, for non-value operations, when the read-back proves the
/// weaker property named in the receipt's `verification`).
public final class DesktopActionService {
    public typealias Clock = () -> Date

    private enum Fate {
        case proposed
        case inProgress
        case completed
        case failed
        case cancelled
    }

    private enum StopState {
        case none
        case denied(ActionStopReason)
    }

    private final class StepRecord {
        let step: ActionStep
        var status: StepStatus
        var before: String?
        var after: String?
        var evidenceIds: [String]
        var verification: VerificationKind?

        init(step: ActionStep) {
            self.step = step
            self.status = .unexecuted
            self.before = nil
            self.after = nil
            self.evidenceIds = []
            self.verification = nil
        }
    }

    private final class Record {
        let proposal: ActionProposal
        let effect: ActionEffect
        let idempotencyKey: String
        var fate: Fate = .proposed
        var authorization: ActionAuthorization?
        var authorizationExpiresAtMs: Double?
        var stop: StopState = .none
        var steps: [StepRecord]

        init(proposal: ActionProposal, effect: ActionEffect, idempotencyKey: String, steps: [ActionStep]) {
            self.proposal = proposal
            self.effect = effect
            self.idempotencyKey = idempotencyKey
            self.steps = steps.map(StepRecord.init)
        }
    }

    private let ax: AXDriver
    private let clock: Clock
    private let scope: ActionScope
    private var proposals: [String: Record] = [:]
    private var proposalsByIdempotencyKey: [String: Record] = [:]
    private var grantSequence = 0
    private let isoFormatter: ISO8601DateFormatter

    public init(ax: AXDriver, now: @escaping Clock, scope: ActionScope) {
        self.ax = ax
        self.clock = now
        self.scope = scope
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        self.isoFormatter = formatter
    }

    // MARK: - proposal

    public func propose(
        actionId: String,
        idempotencyKey: String,
        utterance: ActionUtterance,
        effect: ActionEffect,
        steps: [ActionStep]
    ) throws -> ActionProposal {
        try DesktopActionService.requireText(actionId, "actionId")
        try DesktopActionService.requireText(idempotencyKey, "idempotencyKey")
        try DesktopActionService.requireText(utterance.utteranceId, "utterance.utteranceId")
        try DesktopActionService.requireText(utterance.text, "utterance.text")
        guard !steps.isEmpty else {
            throw ActionServiceError.invalidInput("a proposal needs at least one step")
        }
        var seen = Set<String>()
        for step in steps {
            try DesktopActionService.requireText(step.stepId, "step.stepId")
            try DesktopActionService.requireText(step.targetRef.rawValue, "step.targetRef")
            try DesktopActionService.requireText(step.targetFingerprint, "step.targetFingerprint")
            guard seen.insert(step.stepId).inserted else {
                throw ActionServiceError.invalidInput("duplicate step id \(step.stepId)")
            }
        }

        let argumentHash = argumentHashFor(actionId: actionId, effect: effect, steps: steps)
        if let replay = proposalsByIdempotencyKey[idempotencyKey] {
            guard replay.proposal.actionId == actionId, replay.proposal.argumentHash == argumentHash else {
                throw ActionServiceError.idempotencyConflict(
                    "idempotency key \(idempotencyKey) is already bound to different arguments"
                )
            }
            return replay.proposal
        }

        let proposalId = "proposal-" + String(self.proposalIdHash(
            actionId: actionId,
            idempotencyKey: idempotencyKey,
            argumentHash: argumentHash
        ).prefix(16))
        let proposal = ActionProposal(
            proposalId: proposalId,
            actionId: actionId,
            state: "proposed",
            argumentHash: argumentHash,
            scope: scope
        )
        let record = Record(proposal: proposal, effect: effect, idempotencyKey: idempotencyKey, steps: steps)
        proposals[proposalId] = record
        proposalsByIdempotencyKey[idempotencyKey] = record
        return proposal
    }

    // MARK: - grant

    public func authorize(proposalId: String, utterance: ActionUtterance) throws -> ActionAuthorization {
        let record = try requireProposal(proposalId)
        try DesktopActionService.requireText(utterance.utteranceId, "utterance.utteranceId")
        try DesktopActionService.requireText(utterance.text, "utterance.text")
        let issuedAtMs = self.nowMs()

        switch record.fate {
        case .completed, .failed, .cancelled:
            // A grant never re-opens decided work.
            return ActionAuthorization(
                authorizationId: "grant-" + String(authorizationIdHash(
                    proposalId: record.proposal.proposalId,
                    argumentHash: record.proposal.argumentHash,
                    utteranceId: utterance.utteranceId,
                    issuedAtMs: issuedAtMs,
                    sequence: grantSequence
                ).prefix(16)),
                proposalId: record.proposal.proposalId,
                authorized: false,
                argumentHash: record.proposal.argumentHash,
                expiresAt: isoFormatter.string(from: Date(timeIntervalSince1970: issuedAtMs / 1000))
            )
        case .proposed, .inProgress:
            break
        }

        grantSequence += 1
        let expiresAtMs = issuedAtMs + maxAuthorizationMs
        let authorization = ActionAuthorization(
            authorizationId: "grant-" + String(authorizationIdHash(
                proposalId: record.proposal.proposalId,
                argumentHash: record.proposal.argumentHash,
                utteranceId: utterance.utteranceId,
                issuedAtMs: issuedAtMs,
                sequence: grantSequence
            ).prefix(16)),
            proposalId: record.proposal.proposalId,
            authorized: true,
            argumentHash: record.proposal.argumentHash,
            expiresAt: isoFormatter.string(from: Date(timeIntervalSince1970: expiresAtMs / 1000))
        )
        record.authorization = authorization
        record.authorizationExpiresAtMs = expiresAtMs
        // A fresh grant clears the previous guard stop so the step can be preflighted again.
        record.stop = .none
        return authorization
    }

    // MARK: - advance

    public func advance(proposalId: String) throws -> ActionReceipt {
        let record = try requireProposal(proposalId)
        switch record.fate {
        case .completed, .failed, .cancelled:
            // Decided actions never execute again; the stored receipt is returned unchanged.
            return receipt(for: record)
        case .proposed, .inProgress:
            break
        }

        if let stop = authorizationStopReason(record, atMs: nowMs()) {
            record.stop = .denied(stop)
            return receipt(for: record)
        }

        guard let index = record.steps.firstIndex(where: { $0.status == .unexecuted }) else {
            record.fate = .completed
            record.stop = .none
            return receipt(for: record)
        }

        // Preflight: the live control is read here, and that read is the step's before evidence.
        let entry = record.steps[index]
        guard let state = try ax.inspect(entry.step.targetRef) else {
            record.stop = .denied(.targetIdentityChanged)
            return receipt(for: record)
        }
        if let stop = guardStopReason(entry.step, state) {
            record.stop = .denied(stop)
            return receipt(for: record)
        }

        let before = state.value
        if entry.step.operation == .read {
            // A read observes one state: before and after are that read, and there is no write to
            // verify, so only the before evidence exists.
            entry.status = .completed
            entry.before = before
            entry.after = before
            entry.evidenceIds = [beforeEvidenceId(entry.step.stepId)]
            entry.verification = VerificationKind.none
            record.stop = .none
            record.fate = record.steps.contains { $0.status == .unexecuted } ? .inProgress : .completed
            return receipt(for: record)
        }

        try execute(entry.step)
        let readBack = try ax.inspect(entry.step.targetRef)
        let after = readBack?.value
        let evidenceIds = [beforeEvidenceId(entry.step.stepId), afterEvidenceId(entry.step.stepId)]

        guard verified(entry.step, readBack: readBack, before: state) else {
            // The application accepted the AX call but the read-back disagrees: not a verified result.
            entry.status = .failed
            entry.before = before
            entry.after = after
            entry.evidenceIds = evidenceIds
            entry.verification = verificationKind(for: entry.step.operation)
            record.fate = .failed
            record.stop = .none
            return receipt(for: record)
        }

        entry.status = .completed
        entry.before = before
        entry.after = after
        entry.evidenceIds = evidenceIds
        entry.verification = verificationKind(for: entry.step.operation)
        record.stop = .none
        record.fate = record.steps.contains { $0.status == .unexecuted } ? .inProgress : .completed
        return receipt(for: record)
    }

    // MARK: - cancel

    public func cancel(proposalId: String) throws -> ActionReceipt {
        let record = try requireProposal(proposalId)
        switch record.fate {
        case .completed, .failed, .cancelled:
            // Cancelling cannot rewrite a decided action: the receipt stays exactly as it was.
            return receipt(for: record)
        case .proposed, .inProgress:
            record.fate = .cancelled
            record.stop = .none
            return receipt(for: record)
        }
    }

    // MARK: - guards

    private func authorizationStopReason(_ record: Record, atMs: Double) -> ActionStopReason? {
        guard let authorization = record.authorization, authorization.authorized else {
            return .notAuthorized
        }
        guard let expiresAtMs = record.authorizationExpiresAtMs else {
            return .notAuthorized
        }
        return atMs > expiresAtMs ? .grantExpired : nil
    }

    private func guardStopReason(_ step: ActionStep, _ state: AXControlState) -> ActionStopReason? {
        if state.fingerprint != step.targetFingerprint {
            return .targetIdentityChanged
        }
        if let expected = step.expectedValue, state.value != expected { return .targetIdentityChanged }
        if step.operation.acts {
            if !state.enabled { return .targetDisabled }
            if !state.focused { return .focusChanged }
        }
        return nil
    }

    // MARK: - execution and verification

    private func execute(_ step: ActionStep) throws {
        switch step.operation {
        case .read:
            return
        case .setValue:
            try ax.setValue(step.targetRef, value: step.value)
        case .navigate:
            try ax.focus(step.targetRef)
        case .click:
            try ax.perform(step.targetRef, action: .press)
        case .select:
            try ax.perform(step.targetRef, action: .pick)
        case .scroll:
            try ax.perform(step.targetRef, action: scrollAction(for: step.value))
        }
    }

    private func verified(_ step: ActionStep, readBack: AXControlState?, before: AXControlState) -> Bool {
        switch step.operation {
        case .read:
            return true
        case .setValue:
            return readBack?.value == step.value
        case .navigate:
            return readBack?.focused == true
        case .select:
            return readBack?.selected == true
        case .click, .scroll:
            // A press or a page scroll may legitimately change no value; the verified claim is only
            // that the same control (same fingerprint) is still there afterwards.
            return readBack != nil && readBack?.fingerprint == step.targetFingerprint
                && readBack?.fingerprint == before.fingerprint
        }
    }

    private func verificationKind(for operation: AXOperation) -> VerificationKind {
        switch operation {
        case .read: return .none
        case .setValue: return .valueReadback
        case .navigate: return .focusReadback
        case .select: return .selectedReadback
        case .click, .scroll: return .presenceOnly
        }
    }

    private func scrollAction(for value: String) -> AXAction {
        switch value.lowercased() {
        case "up": return .scrollUpByPage
        case "left": return .scrollLeftByPage
        case "right": return .scrollRightByPage
        default: return .scrollDownByPage
        }
    }

    // MARK: - receipts

    private func receipt(for record: Record) -> ActionReceipt {
        let steps = record.steps.map { entry -> StepReceipt in
            StepReceipt(
                stepId: entry.step.stepId,
                status: entry.status,
                before: entry.status == .unexecuted ? nil : entry.before,
                after: entry.status == .unexecuted ? nil : entry.after,
                evidenceIds: entry.status == .unexecuted ? [] : entry.evidenceIds,
                verification: entry.status == .unexecuted ? nil : entry.verification
            )
        }
        let base = (
            actionId: record.proposal.actionId,
            proposalId: record.proposal.proposalId,
            steps: steps,
            evidenceIds: steps.flatMap(\.evidenceIds)
        )
        switch record.fate {
        case .completed:
            return ActionReceipt(
                actionId: base.actionId,
                proposalId: base.proposalId,
                status: .completed,
                reason: nil,
                steps: base.steps,
                evidenceIds: base.evidenceIds
            )
        case .failed:
            return ActionReceipt(
                actionId: base.actionId,
                proposalId: base.proposalId,
                status: .failed,
                reason: .verificationFailed,
                steps: base.steps,
                evidenceIds: base.evidenceIds
            )
        case .cancelled:
            return ActionReceipt(
                actionId: base.actionId,
                proposalId: base.proposalId,
                status: .cancelled,
                reason: .cancelledByUser,
                steps: base.steps,
                evidenceIds: base.evidenceIds
            )
        case .proposed, .inProgress:
            if case let .denied(reason) = record.stop {
                return ActionReceipt(
                    actionId: base.actionId,
                    proposalId: base.proposalId,
                    status: .denied,
                    reason: reason,
                    steps: base.steps,
                    evidenceIds: base.evidenceIds
                )
            }
            return ActionReceipt(
                actionId: base.actionId,
                proposalId: base.proposalId,
                status: .inProgress,
                reason: nil,
                steps: base.steps,
                evidenceIds: base.evidenceIds
            )
        }
    }

    // MARK: - derived ids

    /// Binds every ordered step, the declared effect, and the explicit project scope. The canonical
    /// encoding matches `argumentHashFor` in `packages/desktop-tools/src/actions/arguments.ts`.
    public func argumentHashFor(actionId: String, effect: ActionEffect, steps: [ActionStep]) -> String {
        sha256Hex(CanonicalJSON.object([
            "actionId": .string(actionId),
            "effect": .string(effect.rawValue),
            "scope": .object([
                "profileId": .string(scope.profileId),
                "projectId": scope.projectId.map(CanonicalJSON.string) ?? .null,
                "worktreeId": scope.worktreeId.map(CanonicalJSON.string) ?? .null,
                "sessionId": scope.sessionId.map(CanonicalJSON.string) ?? .null,
                "sensitivity": .string(scope.sensitivity.rawValue),
            ]),
            "steps": .array(steps.map { step in
                var fields: [String: CanonicalJSON] = [
                    "stepId": .string(step.stepId),
                    "operation": .string(step.operation.rawValue),
                    "targetRef": .string(step.targetRef.rawValue),
                    "targetFingerprint": .string(step.targetFingerprint),
                    "value": .string(step.value),
                ]
                if let expected = step.expectedValue { fields["expectedValue"] = .string(expected) }
                return .object(fields)
            }),
        ]).encoded)
    }

    private func proposalIdHash(actionId: String, idempotencyKey: String, argumentHash: String) -> String {
        sha256Hex(CanonicalJSON.object([
            "scope": .object([
                "profileId": .string(scope.profileId),
                "projectId": scope.projectId.map(CanonicalJSON.string) ?? .null,
                "worktreeId": scope.worktreeId.map(CanonicalJSON.string) ?? .null,
                "sessionId": scope.sessionId.map(CanonicalJSON.string) ?? .null,
                "sensitivity": .string(scope.sensitivity.rawValue),
            ]),
            "actionId": .string(actionId),
            "idempotencyKey": .string(idempotencyKey),
            "argumentHash": .string(argumentHash),
        ]).encoded)
    }

    private func authorizationIdHash(
        proposalId: String,
        argumentHash: String,
        utteranceId: String,
        issuedAtMs: Double,
        sequence: Int
    ) -> String {
        sha256Hex(CanonicalJSON.object([
            "proposalId": .string(proposalId),
            "argumentHash": .string(argumentHash),
            "utteranceId": .string(utteranceId),
            "issuedAtMs": .number(issuedAtMs),
            "sequence": .number(Double(sequence)),
        ]).encoded)
    }

    // MARK: - helpers

    public func beforeEvidenceId(_ stepId: String) -> String { "act:before:\(stepId)" }
    public func afterEvidenceId(_ stepId: String) -> String { "act:after:\(stepId)" }

    private func requireProposal(_ proposalId: String) throws -> Record {
        guard let record = proposals[proposalId] else {
            throw ActionServiceError.unknownProposal(proposalId)
        }
        return record
    }

    private func nowMs() -> Double {
        clock().timeIntervalSince1970 * 1000
    }

    private static func requireText(_ value: String, _ field: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ActionServiceError.invalidInput("\(field) must be a non-empty string")
        }
    }
}
