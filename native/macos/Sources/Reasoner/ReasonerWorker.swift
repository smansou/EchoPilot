import Foundation

public struct ReasonerRequest: Codable, Sendable {
    public let task: ReasoningTask
    public let context: AssembledContext
    public let outputSchema: OutputSchema
}

public struct ReasonerResponse: Codable, Sendable {
    public static let ok = "ok"
    public static let failed = "failed"

    public let taskId: String
    public let status: String
    public let output: JSONValue?
    public let coverage: ContextCoverage
    public let error: String?
    public let totalTokens: Int
    public let maxTokens: Int
    public let outputReservation: Int
    public let evidenceIds: [String]

    public func jsonLine() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else {
            return #"{"taskId":"unknown","status":"failed","coverage":"partial","error":"response encoding failed"}"#
        }
        return text
    }
}

/// The stdio worker: every request is re-checked against the shared budget before the model runs,
/// decoding is measured against the reserved output allowance, and citations are verified against
/// the evidence that was actually presented. Failures are reported as `failed` + `partial` so the
/// caller's deterministic fallback takes over instead of an unverified reply.
public struct ReasonerWorker {
    let bundle: Qwen35Bundle

    public init(bundle: Qwen35Bundle) {
        self.bundle = bundle
    }

    /// The verified budget this worker enforces, for logs and health checks.
    public var budgetDescription: String {
        "model=\(bundle.manifest.id) B=\(bundle.budget.ceiling) "
            + "input=\(bundle.budget.input) outputReservation=\(bundle.budget.outputReservation)"
    }

    public func handle(line: String) -> ReasonerResponse {
        guard let data = line.data(using: .utf8),
              let request = try? JSONDecoder().decode(ReasonerRequest.self, from: data) else {
            return failure(taskId: "unknown", context: nil, error: "request line is not a Reasoner request")
        }
        return handle(request)
    }

    public func handle(_ request: ReasonerRequest) -> ReasonerResponse {
        do {
            try request.context.verify(against: bundle.budget)
        } catch {
            return failure(taskId: request.task.taskId, context: request.context, error: String(describing: error))
        }
        let title = request.outputSchema.title
        guard title == OutputSchema.memoryExtraction || title == OutputSchema.memoryAnswer else {
            return failure(
                taskId: request.task.taskId,
                context: request.context,
                error: String(describing: ReasonerContractError.schemaMismatch(expected: "memory.*", received: title))
            )
        }
        let raw: String
        do {
            raw = try bundle.backend.generate(
                task: request.task,
                prompt: request.context.prompt,
                images: request.context.images.map {
                    ImageDescriptor(id: $0.id, width: $0.width, height: $0.height)
                },
                maxOutputTokens: request.context.outputReservation,
                outputSchema: request.outputSchema
            )
        } catch {
            return failure(taskId: request.task.taskId, context: request.context, error: String(describing: error))
        }
        // The generated reply is measured with the same exact tokenizer that charged the prompt;
        // the entire decoded string (fences included) counts against the reservation.
        let measured = bundle.tokenizer.count(raw)
        guard measured <= request.context.outputReservation else {
            return failure(
                taskId: request.task.taskId,
                context: request.context,
                error: String(describing: ReasonerContractError.outputExceededReservation(
                    counted: measured,
                    reservation: request.context.outputReservation
                ))
            )
        }
        guard let output = JSONValue.parse(extractJSONObject(from: raw)), let object = output.objectValue else {
            return failure(
                taskId: request.task.taskId,
                context: request.context,
                error: String(describing: ReasonerContractError.invalidOutput(message: "no JSON object in reply"))
            )
        }
        if let problem = validate(object, title: title, presentedEvidenceIds: request.context.evidenceIds) {
            return failure(taskId: request.task.taskId, context: request.context, error: problem)
        }
        return ReasonerResponse(
            taskId: request.task.taskId,
            status: ReasonerResponse.ok,
            output: output,
            coverage: request.context.coverage,
            error: nil,
            totalTokens: request.context.totalTokens,
            maxTokens: request.context.maxTokens,
            outputReservation: request.context.outputReservation,
            evidenceIds: request.context.evidenceIds
        )
    }

    private func failure(taskId: String, context: AssembledContext?, error: String) -> ReasonerResponse {
        ReasonerResponse(
            taskId: taskId,
            status: ReasonerResponse.failed,
            output: nil,
            coverage: .partial,
            error: error,
            totalTokens: context?.totalTokens ?? 0,
            maxTokens: context?.maxTokens ?? 0,
            outputReservation: context?.outputReservation ?? 0,
            evidenceIds: context?.evidenceIds ?? []
        )
    }

    /// Tolerates a fenced or chatty reply, but only by extracting the JSON object itself.
    private func extractJSONObject(from text: String) -> String {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end else {
            return text
        }
        return String(text[start...end])
    }

    private func validate(
        _ object: [String: JSONValue],
        title: String,
        presentedEvidenceIds: [String]
    ) -> String? {
        if title == OutputSchema.memoryExtraction {
            guard object["decisions"]?.arrayValue != nil else {
                return "memory.extraction output has no decisions array"
            }
            guard object["facts"]?.arrayValue != nil else {
                return "memory.extraction output has no facts array"
            }
            return nil
        }
        guard let text = object["text"]?.stringValue,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "memory.answer output has no answer text"
        }
        guard let ids = object["evidenceIds"]?.arrayValue else {
            return "memory.answer output has no evidenceIds array"
        }
        let presented = Set(presentedEvidenceIds)
        let cited = ids.compactMap(\.stringValue).filter { !$0.isEmpty }
        guard !cited.isEmpty else {
            return "memory.answer output cites no evidence"
        }
        guard cited.allSatisfy({ presented.contains($0) }) else {
            return "memory.answer cited evidence that was never presented"
        }
        return nil
    }
}
