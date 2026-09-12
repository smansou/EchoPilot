import Foundation

/// On-disk contract for the bundled Qwen3.5-4B worker. `contextCapacity` is mandatory: the shared
/// budget B derives from it, so a manifest without a positive capacity is rejected at load time.
public struct Qwen35BundleManifest: Codable, Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let parameterCountBillion: Double
    public let quantization: String
    public let contextCapacity: Int
    public let visionPatchSize: Int
    public let weights: String
    public let tokenizer: String

    public init(
        id: String, displayName: String, parameterCountBillion: Double, quantization: String,
        contextCapacity: Int, visionPatchSize: Int, weights: String, tokenizer: String
    ) {
        self.id = id
        self.displayName = displayName
        self.parameterCountBillion = parameterCountBillion
        self.quantization = quantization
        self.contextCapacity = contextCapacity
        self.visionPatchSize = visionPatchSize
        self.weights = weights
        self.tokenizer = tokenizer
    }

    /// The bundled worker: Qwen3.5-4B, 4-bit, 32K window -> B = min(8192, 8192) = 8192.
    public static let bundled = Qwen35BundleManifest(
        id: "qwen3.5-4b-q4",
        displayName: "Qwen3.5-4B (4-bit)",
        parameterCountBillion: 4.0,
        quantization: "q4",
        contextCapacity: 32768,
        visionPatchSize: Qwen35VisionProcessor.patchSize,
        weights: "weights/model.safetensors",
        tokenizer: "tokenizer.json"
    )
}

/// The local model runtime, kept behind a protocol so the bounded-context and grounding behavior can
/// be exercised end-to-end without weights, a download, or a paid call.
public protocol LocalModelBackend: Sendable {
    /// `images` are the descriptors the bounded context charged and admits; a backend forwards them
    /// to the vision tower, so the accounting matches what the model actually receives.
    func generate(
        task: ReasoningTask,
        prompt: String,
        images: [ImageDescriptor],
        maxOutputTokens: Int,
        outputSchema: OutputSchema
    ) throws -> String
}

/// Deterministic stand-in driven by a script (`{"<taskId>": "<json>", "*": "<json>"}`).
public struct ScriptedStandInBackend: LocalModelBackend {
    private let replies: [String: String]
    private let fallbackReply: String
    private let faults: Set<String>

    public init(replies: [String: String], fallback: String, faults: Set<String> = []) {
        self.replies = replies
        self.fallbackReply = fallback
        self.faults = faults
    }

    public static func load(from url: URL) throws -> ScriptedStandInBackend {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ReasonerContractError.missingBundle(path: url.path)
        }
        var replies: [String: String] = [:]
        var faults = Set<String>()
        for (key, value) in root {
            if key == "faults", let listed = value as? [String] {
                faults = Set(listed)
                continue
            }
            guard let text = value as? String else { continue }
            replies[key] = text
        }
        return ScriptedStandInBackend(
            replies: replies,
            fallback: replies["*"] ?? #"{"decisions":[],"facts":[],"summary":"Scripted stand-in produced no records."}"#,
            faults: faults
        )
    }

    public func generate(
        task: ReasoningTask,
        prompt: String,
        images: [ImageDescriptor],
        maxOutputTokens: Int,
        outputSchema: OutputSchema
    ) throws -> String {
        // The scripted stand-in has no vision tower; the descriptors are still the ones that were
        // charged, which is what the budget contract is about.
        _ = images
        if faults.contains(task.taskId) {
            throw ReasonerContractError.modelFailure(message: "scripted crash for \(task.taskId)")
        }
        return replies[task.taskId] ?? fallbackReply
    }
}

public struct Qwen35Bundle {
    public let manifest: Qwen35BundleManifest
    public let budget: BoundedBudget
    public let tokenizer: TokenCounting
    public let imageProcessor: ImageTokenProcessing
    public let backend: LocalModelBackend

    public var model: ModelDescriptor {
        ModelDescriptor(modelId: manifest.id, contextCapacity: manifest.contextCapacity)
    }

    public init(
        manifest: Qwen35BundleManifest,
        tokenizer: TokenCounting,
        imageProcessor: ImageTokenProcessing,
        backend: LocalModelBackend
    ) throws {
        // The manifest is validated here, so a loaded bundle always carries a verified budget.
        self.budget = try BoundedBudget(model: ModelDescriptor(
            modelId: manifest.id,
            contextCapacity: manifest.contextCapacity
        ))
        self.manifest = manifest
        self.tokenizer = tokenizer
        self.imageProcessor = imageProcessor
        self.backend = backend
    }

    /// Loads a bundle directory. Weights are required unless a stand-in backend is supplied, and
    /// a tokenizer that exists but does not parse is never silently replaced: exact accounting
    /// cannot quietly degrade into an estimate.
    public static func load(at url: URL, backend suppliedBackend: LocalModelBackend? = nil) throws -> Qwen35Bundle {
        let manifestURL = url.appendingPathComponent("model.json")
        guard let data = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONDecoder().decode(Qwen35BundleManifest.self, from: data) else {
            throw ReasonerContractError.missingBundle(path: url.path)
        }
        guard manifest.contextCapacity > 0, !manifest.id.isEmpty else {
            throw ReasonerContractError.undeclaredCapacity(modelId: manifest.id)
        }
        let tokenizerURL = url.appendingPathComponent(manifest.tokenizer)
        let weightsURL = url.appendingPathComponent(manifest.weights)
        let backend: LocalModelBackend
        if let suppliedBackend {
            backend = suppliedBackend
        } else {
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                throw ReasonerContractError.missingWeights(path: weightsURL.path)
            }
            // The bundle ships the manifest, tokenizer and weights; linking the MLX runtime that
            // executes them is a separate build step, so a missing runtime is reported instead of
            // pretending a loaded bundle can generate.
            throw ReasonerContractError.missingWeights(
                path: "\(weightsURL.path): no local runtime is linked; supply a LocalModelBackend "
                    + "(the Qwen3.5-4B MLX runtime is deferred)"
            )
        }
        let tokenizer: TokenCounting
        if FileManager.default.fileExists(atPath: tokenizerURL.path) {
            // Present means loadable: a malformed tokenizer.json at the stand-in seam used to fall
            // back to whitespace counting, which silently changed every measured request.
            tokenizer = try Qwen35Tokenizer(contentsOf: tokenizerURL)
        } else if suppliedBackend is ScriptedStandInBackend {
            // Fixture seam only: a stand-in bundle without a tokenizer file still needs a counter.
            tokenizer = ScriptedFixtureTokenizer()
        } else {
            throw ReasonerContractError.missingTokenizer(path: tokenizerURL.path)
        }
        return try Qwen35Bundle(
            manifest: manifest,
            tokenizer: tokenizer,
            imageProcessor: Qwen35VisionProcessor(),
            backend: backend
        )
    }
}
