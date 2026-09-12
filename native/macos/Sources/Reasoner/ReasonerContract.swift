import Foundation

/// A model the Reasoner may serve. A capacity is part of the identity: without a declared,
/// positive, finite `contextCapacity` there is no verified window and the contract refuses to
/// pretend otherwise.
public struct ModelDescriptor: Codable, Sendable, Equatable {
    public let modelId: String
    public let contextCapacity: Int

    public init(modelId: String, contextCapacity: Int) {
        self.modelId = modelId
        self.contextCapacity = contextCapacity
    }
}

/// The task handed to the Reasoner. `taskId` is the caller's durable job identity, so a retried or
/// duplicated job is recognisable from the response alone.
public struct ReasoningTask: Codable, Sendable, Equatable {
    public let taskId: String
    public let instruction: String

    public init(taskId: String, instruction: String) {
        self.taskId = taskId
        self.instruction = instruction
    }
}

public enum ReasonerContractError: Error, CustomStringConvertible, Equatable {
    case undeclaredCapacity(modelId: String)
    case missingBundle(path: String)
    case missingTokenizer(path: String)
    case missingWeights(path: String)
    case unboundedRequest(reason: String)
    case schemaMismatch(expected: String, received: String)
    case modelFailure(message: String)
    case invalidOutput(message: String)
    case outputExceededReservation(counted: Int, reservation: Int)
    case invalidImageDescriptor(id: String)

    public var description: String {
        switch self {
        case .undeclaredCapacity(let modelId):
            return "model \(modelId) has no declared, positive context capacity"
        case .missingBundle(let path):
            return "no Qwen3.5 bundle at \(path)"
        case .missingTokenizer(let path):
            return "bundle tokenizer is missing at \(path); exact counting is required"
        case .missingWeights(let path):
            return "bundle weights are missing at \(path)"
        case .unboundedRequest(let reason):
            return "request violates the shared bounded-context invariant: \(reason)"
        case .schemaMismatch(let expected, let received):
            return "output schema title \(received) does not match \(expected)"
        case .modelFailure(let message):
            return "model failure: \(message)"
        case .invalidOutput(let message):
            return "model output is not valid JSON: \(message)"
        case .outputExceededReservation(let counted, let reservation):
            return "decoded reply used \(counted) tokens, over the reserved \(reservation)"
        case .invalidImageDescriptor(let id):
            return "image \(id) has no positive pixel dimensions"
        }
    }
}

/// The one budget every request must obey. Mirrors `packages/memory/src/context/index.ts`.
public struct BoundedBudget: Sendable, Equatable {
    public static let contextCeilingTokens = 8192
    public static let defaultOutputReservation = 2048
    /// Wrapper/separator/formatting allowance, charged to `accounting.reserve`.
    public static let formatReserveTokens = 64

    public let modelId: String
    public let capacity: Int
    public let ceiling: Int
    public let outputReservation: Int
    public let input: Int

    public init(model: ModelDescriptor) throws {
        let modelId = model.modelId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !modelId.isEmpty, model.contextCapacity > 0 else {
            throw ReasonerContractError.undeclaredCapacity(modelId: model.modelId)
        }
        let capacity = model.contextCapacity
        let ceiling = min(BoundedBudget.contextCeilingTokens, (capacity * 1) / 4)
        let outputReservation = min(
            BoundedBudget.defaultOutputReservation,
            max(1, ceiling / 4)
        )
        self.modelId = modelId
        self.capacity = capacity
        self.ceiling = ceiling
        self.outputReservation = outputReservation
        self.input = ceiling - outputReservation
    }
}

/// The bounded window the worker admits: the caller's measured accounting plus the exact prompt.
public enum ContextCoverage: String, Codable, Sendable {
    case complete
    case partial
}

public struct ContextAccounting: Codable, Sendable, Equatable {
    public var system: Int
    public var request: Int
    public var cards: Int
    public var dialogue: Int
    public var evidence: Int
    public var images: Int
    public var tools: Int
    public var reserve: Int
    public var output: Int

    public init(
        system: Int, request: Int, cards: Int, dialogue: Int, evidence: Int,
        images: Int, tools: Int, reserve: Int, output: Int
    ) {
        self.system = system
        self.request = request
        self.cards = cards
        self.dialogue = dialogue
        self.evidence = evidence
        self.images = images
        self.tools = tools
        self.reserve = reserve
        self.output = output
    }

    public var total: Int {
        system + request + cards + dialogue + evidence + images + tools + reserve + output
    }
}

public struct AssembledContext: Codable, Sendable {
    public let modelId: String
    public let maxTokens: Int
    public let outputReservation: Int
    public let inputTokens: Int
    public let totalTokens: Int
    public let accounting: ContextAccounting
    public let evidenceIds: [String]
    public let prompt: String
    public let coverage: ContextCoverage

    public init(
        modelId: String, maxTokens: Int, outputReservation: Int, inputTokens: Int,
        totalTokens: Int, accounting: ContextAccounting, evidenceIds: [String],
        prompt: String, coverage: ContextCoverage
    ) {
        self.modelId = modelId
        self.maxTokens = maxTokens
        self.outputReservation = outputReservation
        self.inputTokens = inputTokens
        self.totalTokens = totalTokens
        self.accounting = accounting
        self.evidenceIds = evidenceIds
        self.prompt = prompt
        self.coverage = coverage
    }

    /// Re-checks the shared invariant before the model is touched.
    public func verify(against budget: BoundedBudget) throws {
        guard modelId == budget.modelId else {
            throw ReasonerContractError.unboundedRequest(reason: "context model \(modelId) != \(budget.modelId)")
        }
        guard maxTokens > 0, maxTokens <= budget.ceiling else {
            throw ReasonerContractError.unboundedRequest(reason: "maxTokens \(maxTokens) outside B \(budget.ceiling)")
        }
        guard outputReservation > 0, outputReservation == accounting.output else {
            throw ReasonerContractError.unboundedRequest(reason: "output allowance is not reserved")
        }
        guard totalTokens == inputTokens + outputReservation else {
            throw ReasonerContractError.unboundedRequest(reason: "totalTokens is not input + output reservation")
        }
        guard totalTokens == accounting.total else {
            throw ReasonerContractError.unboundedRequest(reason: "totalTokens is not the sum of the accounting sections")
        }
        guard totalTokens <= maxTokens else {
            throw ReasonerContractError.unboundedRequest(reason: "totalTokens \(totalTokens) exceeds B \(maxTokens)")
        }
        guard inputTokens <= budget.input else {
            throw ReasonerContractError.unboundedRequest(reason: "input \(inputTokens) exceeds the input cap \(budget.input)")
        }
    }
}

/// Minimal schema descriptor: the worker routes on the title exactly like the F01 contract does.
public struct OutputSchema: Codable, Sendable, Equatable {
    public static let memoryExtraction = "memory.extraction"
    public static let memoryAnswer = "memory.answer"

    public let title: String
    public var type: String?

    public init(title: String, type: String? = "object") {
        self.title = title
        self.type = type
    }
}
