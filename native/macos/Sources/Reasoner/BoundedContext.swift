import Foundation

public struct DialogueItem: Codable, Sendable, Equatable {
    public let id: String
    public let text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

public struct EvidenceItem: Codable, Sendable, Equatable {
    public let id: String
    public let text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

public struct ImageDescriptor: Codable, Sendable, Equatable {
    public let id: String
    public let width: Int
    public let height: Int

    public init(id: String, width: Int, height: Int) {
        self.id = id
        self.width = width
        self.height = height
    }
}

public struct ToolDescriptor: Codable, Sendable, Equatable {
    public let name: String
    public let schema: JSONValue

    public init(name: String, schema: JSONValue) {
        self.name = name
        self.schema = schema
    }
}

public struct AssembleRequest: Sendable {
    public var model: ModelDescriptor
    public var instruction: String
    public var request: String?
    public var card: String?
    public var dialogue: [DialogueItem]
    public var evidence: [EvidenceItem]
    public var images: [ImageDescriptor]
    public var tools: [ToolDescriptor]
    /// Dialogue that does not fit is only admitted through this compaction hook. A hook that throws
    /// (deliberately failed compaction) drops the unadmitted dialogue and marks coverage partial.
    public var compactDialogue: (@Sendable ([DialogueItem]) throws -> [DialogueItem])?

    public init(
        model: ModelDescriptor,
        instruction: String,
        request: String? = nil,
        card: String? = nil,
        dialogue: [DialogueItem] = [],
        evidence: [EvidenceItem] = [],
        images: [ImageDescriptor] = [],
        tools: [ToolDescriptor] = [],
        compactDialogue: (@Sendable ([DialogueItem]) throws -> [DialogueItem])? = nil
    ) {
        self.model = model
        self.instruction = instruction
        self.request = request
        self.card = card
        self.dialogue = dialogue
        self.evidence = evidence
        self.images = images
        self.tools = tools
        self.compactDialogue = compactDialogue
    }
}

/// Swift mirror of `createContextAssembler` in packages/memory/src/context/index.ts: the same
/// admission order, the same exact-tokenizer charges, and the same failure semantics, so the
/// invariant holds no matter which side builds the request.
public struct ContextAssembler {
    private let tokenizer: TokenCounting
    private let imageProcessor: ImageTokenProcessing

    public init(tokenizer: TokenCounting, imageProcessor: ImageTokenProcessing) {
        self.tokenizer = tokenizer
        self.imageProcessor = imageProcessor
    }

    public func assemble(_ request: AssembleRequest) throws -> AssembledContext {
        let budget = try BoundedBudget(model: request.model)
        var coverage = ContextCoverage.complete
        var remaining = max(0, budget.input - BoundedBudget.formatReserveTokens)

        func markPartial() { coverage = .partial }

        var system = try trim(request.instruction, to: remaining)
        if system.truncated { markPartial() }
        remaining -= system.tokens

        var requestSection = try trim(request.request ?? "", to: remaining)
        if requestSection.truncated { markPartial() }
        remaining -= requestSection.tokens

        let cards = try trim(request.card ?? "", to: remaining)
        if cards.truncated { markPartial() }
        remaining -= cards.tokens

        var admittedEvidence: [EvidenceItem] = []
        var evidenceTokens = 0
        for item in request.evidence {
            let admission = try trim(item.text, to: remaining)
            if admission.truncated { markPartial() }
            if admission.tokens == 0 && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                markPartial()
                continue
            }
            remaining -= admission.tokens
            evidenceTokens += admission.tokens
            admittedEvidence.append(EvidenceItem(id: item.id, text: admission.value))
        }

        var admittedImages: [AdmittedImage] = []
        var imageTokensTotal = 0
        for descriptor in request.images {
            let measured = try imageProcessor.imageTokens(width: descriptor.width, height: descriptor.height)
            let cost = max(1, measured)
            if cost > remaining {
                markPartial()
                continue
            }
            remaining -= cost
            imageTokensTotal += cost
            admittedImages.append(AdmittedImage(
                id: descriptor.id,
                width: descriptor.width,
                height: descriptor.height,
                tokens: cost
            ))
        }

        var admittedTools: [(name: String, schemaText: String)] = []
        var toolTokens = 0
        for tool in request.tools {
            let schemaText = tool.schema.serialized()
            // Charge exactly the text the prompt below sends: the `Tool <name>: ` wrapper plus the
            // serialized schema.
            let cost = tokenizer.count("Tool \(tool.name): ") + tokenizer.count(schemaText)
            if cost > remaining {
                markPartial()
                continue
            }
            remaining -= cost
            toolTokens += cost
            admittedTools.append((tool.name, schemaText))
        }

        var admittedDialogue: [DialogueItem] = []
        var dialogueTokens = 0
        if !request.dialogue.isEmpty {
            let rawCost = request.dialogue.reduce(0) { $0 + tokenizer.count($1.text) }
            if rawCost <= remaining {
                admittedDialogue = request.dialogue
                dialogueTokens = rawCost
                remaining -= rawCost
            } else if let compact = request.compactDialogue {
                let compacted = (try? compact(request.dialogue)) ?? []
                if compacted.isEmpty {
                    markPartial()
                } else {
                    for item in compacted {
                        let admission = try trim(item.text, to: remaining)
                        if admission.truncated { markPartial() }
                        if admission.tokens == 0 && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            markPartial()
                            continue
                        }
                        remaining -= admission.tokens
                        dialogueTokens += admission.tokens
                        admittedDialogue.append(DialogueItem(id: item.id, text: admission.value))
                    }
                }
            } else {
                markPartial()
            }
        }

        func renderPrompt() -> String {
            var parts: [String] = ["[system]\n\(system.value)", "[request]\n\(requestSection.value)"]
            if !cards.value.isEmpty { parts.append("[card]\n\(cards.value)") }
            if !admittedDialogue.isEmpty {
                parts.append("[dialogue]\n" + admittedDialogue.map(\.text).joined(separator: "\n"))
            }
            if !admittedEvidence.isEmpty {
                parts.append("[evidence]\n" + admittedEvidence.map(\.text).joined(separator: "\n"))
            }
            if !admittedImages.isEmpty {
                parts.append("[images]\n" + admittedImages.map { "Image \($0.id) \($0.width)x\($0.height)" }
                    .joined(separator: "\n"))
            }
            if !admittedTools.isEmpty {
                parts.append("[tools]\n" + admittedTools.map { "Tool \($0.name): \($0.schemaText)" }.joined(separator: "\n"))
            }
            return parts.joined(separator: "\n\n")
        }

        /// Measure what is actually sent: `reserve` is the exact tokenizer's count of the assembled
        /// prompt minus its counted content sections, so headers and separators can never be
        /// smuggled past the ceiling uncharged.
        func measure() -> (prompt: String, reserve: Int, inputTokens: Int) {
            let prompt = renderPrompt()
            let bodyTokens = system.tokens
                + requestSection.tokens
                + cards.tokens
                + dialogueTokens
                + evidenceTokens
                + toolTokens
            let reserve = max(0, tokenizer.count(prompt) - bodyTokens)
            return (prompt, reserve, bodyTokens + imageTokensTotal + reserve)
        }

        var fitted = measure()
        // An unusual tokenizer or an image-heavy request never pushes the prompt past B: drop the
        // least-grounded admitted parts until the exact measurement plus the transmitted images fits.
        while fitted.inputTokens > budget.input {
            markPartial()
            if let dropped = admittedDialogue.popLast() {
                dialogueTokens -= tokenizer.count(dropped.text)
                fitted = measure()
                continue
            }
            if let dropped = admittedTools.popLast() {
                toolTokens -= tokenizer.count("Tool \(dropped.name): ") + tokenizer.count(dropped.schemaText)
                fitted = measure()
                continue
            }
            if let dropped = admittedImages.popLast() {
                imageTokensTotal -= dropped.tokens
                fitted = measure()
                continue
            }
            if let dropped = admittedEvidence.popLast() {
                evidenceTokens -= tokenizer.count(dropped.text)
                fitted = measure()
                continue
            }
            if requestSection.tokens > 0 {
                requestSection = (value: "", tokens: 0, truncated: true)
                fitted = measure()
                continue
            }
            if system.tokens > 0 {
                system = (value: "", tokens: 0, truncated: true)
                fitted = measure()
                continue
            }
            break
        }

        let accounting = ContextAccounting(
            system: system.tokens,
            request: requestSection.tokens,
            cards: cards.tokens,
            dialogue: dialogueTokens,
            evidence: evidenceTokens,
            images: imageTokensTotal,
            tools: toolTokens,
            reserve: fitted.reserve,
            output: budget.outputReservation
        )
        let inputTokens = accounting.total - accounting.output
        let totalTokens = inputTokens + accounting.output
        guard totalTokens <= budget.ceiling, inputTokens <= budget.input else {
            throw ReasonerContractError.unboundedRequest(reason: "assembler exceeded B while building the prompt")
        }
        return AssembledContext(
            modelId: budget.modelId,
            maxTokens: budget.ceiling,
            outputReservation: budget.outputReservation,
            inputTokens: inputTokens,
            totalTokens: totalTokens,
            accounting: accounting,
            evidenceIds: admittedEvidence.map(\.id),
            images: admittedImages,
            prompt: fitted.prompt,
            coverage: coverage
        )
    }

    private func trim(_ text: String, to limit: Int) throws -> (value: String, tokens: Int, truncated: Bool) {
        let measured = tokenizer.count(text)
        if measured <= limit { return (text, measured, false) }
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var low = 0
        var high = words.count
        var best = 0
        while low < high {
            let middle = (low + high + 1) / 2
            let candidate = words[0..<middle].joined(separator: " ")
            if tokenizer.count(candidate) <= limit {
                best = middle
                low = middle
            } else {
                high = middle - 1
            }
        }
        let value = best == 0 ? "" : words[0..<best].joined(separator: " ")
        return (value, tokenizer.count(value), true)
    }
}
