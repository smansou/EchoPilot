import Foundation
import Audio
#if canImport(CoreML)
import CoreML
#endif

/// The bundled Silero VAD model, injected by the helper's packaging step (ONNX Runtime / CoreML).
public protocol SileroVADModel: AnyObject {
    func load(from modelDirectory: URL) throws
    func speechProbability(samples: [Float]) throws -> Double
    func reset()
}

public enum SileroVADError: Error, Equatable {
    case modelPackMissing(String)
    case backendUnavailable(String)
}

/// The bundled Silero v5 pack. The pack is resolved from disk (override, helper environment or the
/// app bundle); nothing here downloads a model or touches the network.
public enum SileroVADModelPack {
    public static let compiledModelName = "silero_vad.mlmodelc"
    public static let sourceModelName = "silero_vad.mlmodel"
    public static let onnxModelName = "silero_vad.onnx"

    public static func isPack(at directory: URL) -> Bool {
        let manager = FileManager.default
        return [compiledModelName, sourceModelName, onnxModelName].contains { name in
            manager.fileExists(atPath: directory.appendingPathComponent(name).path)
        }
    }

    /// Search order: the packaged helper's explicit override, the app-bundle resources, then the
    /// folder next to the executable.
    public static func defaultSearchPaths(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [URL] {
        var paths: [URL] = []
        if let override = environment["ECHOPILOT_SILERO_MODEL_DIR"], !override.isEmpty {
            paths.append(URL(fileURLWithPath: override, isDirectory: true))
        }
        let bundle = Bundle.main
        if let resource = bundle.resourceURL {
            paths.append(resource.appendingPathComponent("Silero", isDirectory: true))
            paths.append(resource)
        }
        if let executable = bundle.executableURL {
            paths.append(executable.deletingLastPathComponent().appendingPathComponent("Silero", isDirectory: true))
        }
        return paths
    }

    public static func resolve(searchPaths: [URL] = defaultSearchPaths()) -> URL? {
        searchPaths.first { isPack(at: $0) }
    }
}

public struct SileroVADConfiguration: Sendable {
    /// Silero v5 expects 512-sample frames at 16 kHz (32 ms).
    public var frameSamples = 512
    public var speechThreshold = 0.5
    public var releaseThreshold = 0.35
    public var minSpeechMs = 250
    /// 450 ms of trailing silence closes the utterance (plan §5.5).
    public var endSilenceMs = 450
    public var modelDirectory: URL?
    /// Test/development stand-in only; production fails closed when the model pack is missing.
    public var allowEnergyFallback = false

    public init() {}
}

public struct VADState: Sendable, Equatable {
    public let speechProbability: Double
    public let isSpeech: Bool
    public let trailingSilenceMs: Int
    public let endpoint: Bool
}

/// Streaming Silero VAD with hysteresis and an explicit endpoint after 450 ms of silence.
public final class SileroVAD {
    private let configuration: SileroVADConfiguration
    private let model: SileroVADModel
    private var pending: [Float] = []
    private var spokeInUtterance = false
    private var trailingSilenceMs = 0
    private var lastProbability = 0.0

    public init(configuration: SileroVADConfiguration = SileroVADConfiguration()) throws {
        self.configuration = configuration
        if let directory = configuration.modelDirectory {
            // A packaged runtime registered by the helper wins; otherwise the CoreML pack shipped
            // with the signed build is used, so production never depends on the test-only energy
            // stand-in.
            if let backend = SileroVADBackendRegistry.makeBackend() {
                do {
                    try backend.load(from: directory)
                    self.model = backend
                    return
                } catch {
                    if !configuration.allowEnergyFallback { throw error }
                }
            }
            if SileroVADModelPack.isPack(at: directory), let backend = SileroVADProductionBackend.make() {
                do {
                    try backend.load(from: directory)
                    self.model = backend
                    return
                } catch {
                    if !configuration.allowEnergyFallback { throw error }
                }
            }
        }
        if configuration.allowEnergyFallback {
            self.model = EnergyVADModel()
        } else {
            let path = configuration.modelDirectory?.appendingPathComponent(SileroVADModelPack.compiledModelName).path
                ?? SileroVADModelPack.compiledModelName
            throw SileroVADError.modelPackMissing(path)
        }
    }

    public func reset() {
        pending.removeAll(keepingCapacity: true)
        spokeInUtterance = false
        trailingSilenceMs = 0
        lastProbability = 0
        model.reset()
    }

    /// Feeds 16 kHz mono Int16 packets; returns the VAD state, including the endpoint flag.
    public func process(pcm: Data, sampleRate: Int) -> VADState {
        guard sampleRate == PCMPacket.sampleRate else {
            return VADState(speechProbability: 0, isSpeech: false, trailingSilenceMs: trailingSilenceMs, endpoint: false)
        }
        pending.append(contentsOf: Self.floatSamples(from: pcm))
        let frameMs = Double(configuration.frameSamples) / Double(sampleRate) * 1_000

        while pending.count >= configuration.frameSamples {
            let frame = Array(pending[0..<configuration.frameSamples])
            pending.removeFirst(configuration.frameSamples)
            let probability = (try? model.speechProbability(samples: frame)) ?? 0
            lastProbability = probability
            let isSpeech: Bool
            if spokeInUtterance {
                isSpeech = probability > configuration.releaseThreshold
            } else {
                isSpeech = probability >= configuration.speechThreshold
            }
            if isSpeech {
                spokeInUtterance = true
                trailingSilenceMs = 0
            } else if spokeInUtterance {
                trailingSilenceMs += Int(frameMs.rounded())
            }
        }

        let measuredTrailingSilenceMs = trailingSilenceMs
        let endpoint = spokeInUtterance && measuredTrailingSilenceMs >= configuration.endSilenceMs
        if endpoint {
            // The endpoint closes the utterance: clear the per-utterance state here, or every later
            // packet of trailing silence would keep reporting `endpoint: true` and end the next
            // utterance before it was ever heard. `spokeInUtterance` only turns true again once
            // speech crosses the entry threshold, so a new utterance starts from silence.
            spokeInUtterance = false
            trailingSilenceMs = 0
        }
        return VADState(
            speechProbability: lastProbability,
            isSpeech: lastProbability > configuration.releaseThreshold,
            trailingSilenceMs: measuredTrailingSilenceMs,
            endpoint: endpoint
        )
    }

    static func floatSamples(from pcm: Data) -> [Float] {
        let count = pcm.count / 2
        var samples = [Float](repeating: 0, count: count)
        pcm.withUnsafeBytes { raw in
            for index in 0..<count {
                let low = UInt16(raw[index * 2])
                let high = UInt16(raw[index * 2 + 1])
                let value = Int16(bitPattern: high << 8 | low)
                samples[index] = Float(value) / 32_768
            }
        }
        return samples
    }
}

/// Backend registry: the packaged helper registers its ONNX Runtime / CoreML implementation.
public enum SileroVADBackendRegistry {
    private static var factory: (() -> SileroVADModel)?
    private static let lock = NSLock()

    public static func register(_ make: @escaping () -> SileroVADModel) {
        lock.lock()
        defer { lock.unlock() }
        factory = make
    }

    /// True once production (or a harness) registered a Silero runtime.
    public static var hasRegisteredBackend: Bool {
        lock.lock()
        defer { lock.unlock() }
        return factory != nil
    }

    static func makeBackend() -> SileroVADModel? {
        lock.lock()
        defer { lock.unlock() }
        return factory?()
    }
}

/// The Silero runtime the signed helper ships: the CoreML build of the v5 pack, driven with the
/// same 512-sample frames, 16 kHz rate and recurrent state the ONNX pack uses.
public enum SileroVADProductionBackend {
    public static func make() -> SileroVADModel? {
        #if canImport(CoreML)
        return SileroVADCoreMLBackend()
        #else
        return nil
        #endif
    }
}

#if canImport(CoreML)
/// CoreML Silero streaming backend, including v5 combined state and the pinned v6.2.1
/// conversion's 64-sample left context plus separate LSTM hidden/cell tensors.
public final class SileroVADCoreMLBackend: SileroVADModel {
    private static let stateShape: [NSNumber] = [2, 1, 128]

    private let lock = NSLock()
    private var model: MLModel?
    private var state: MLMultiArray?
    private var inputName = "input"
    private var outputName = "output"
    private var stateInputName: String?
    private var stateOutputName: String?
    private var sampleRateInputName: String?
    private var audioShape: [NSNumber] = [1, 512]
    private var audioDataType: MLMultiArrayDataType = .float32
    private var context: [Float] = []
    private var splitStates: [String: MLMultiArray] = [:]

    public init() {}

    public func load(from modelDirectory: URL) throws {
        let compiled = modelDirectory.appendingPathComponent(SileroVADModelPack.compiledModelName)
        let source = modelDirectory.appendingPathComponent(SileroVADModelPack.sourceModelName)
        let modelURL: URL
        if FileManager.default.fileExists(atPath: compiled.path) {
            modelURL = compiled
        } else if FileManager.default.fileExists(atPath: source.path) {
            modelURL = try MLModel.compileModel(at: source)
        } else {
            throw SileroVADError.modelPackMissing(source.path)
        }

        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        let loaded = try MLModel(contentsOf: modelURL, configuration: configuration)
        let inputs = loaded.modelDescription.inputDescriptionsByName
        let outputs = loaded.modelDescription.outputDescriptionsByName
        guard let audioInput = ["input", "audio", "input_1"].first(where: { inputs[$0] != nil })
            ?? inputs.keys.sorted().first
        else {
            throw SileroVADError.backendUnavailable("the Silero pack declares no audio input")
        }
        let probabilityOutput = ["output", "probability", "prob", "speech"].first(where: { outputs[$0] != nil })
            ?? outputs.keys.sorted().first ?? "output"
        let nextStateOutput = ["stateN", "state_out", "state_out_0"].first(where: { outputs[$0] != nil })
        let recurrentStateInput = ["state", "state_in", "state_in_0"].first(where: { inputs[$0] != nil })

        lock.lock()
        defer { lock.unlock() }
        model = loaded
        inputName = audioInput
        outputName = probabilityOutput
        stateInputName = recurrentStateInput
        stateOutputName = nextStateOutput
        sampleRateInputName = inputs["sr"] != nil ? "sr" : nil
        if let constraint = inputs[audioInput]?.multiArrayConstraint {
            audioShape = constraint.shape
            audioDataType = constraint.dataType
        }
        let inputSamples = audioShape.last?.intValue ?? 512
        guard inputSamples == 512 || inputSamples == 576 else {
            throw SileroVADError.backendUnavailable("Silero requires a 512-sample streaming model, received \(inputSamples) input samples")
        }
        context = Array(repeating: 0, count: max(0, inputSamples - 512))
        splitStates.removeAll()
        for name in ["h", "c"] {
            if let constraint = inputs[name]?.multiArrayConstraint {
                let fresh = try MLMultiArray(shape: constraint.shape, dataType: constraint.dataType)
                zero(fresh)
                splitStates[name] = fresh
            }
        }
        if recurrentStateInput != nil {
            let fresh = try MLMultiArray(shape: Self.stateShape, dataType: .float32)
            zero(fresh)
            state = fresh
        } else {
            state = nil
        }
    }

    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        if let state { zero(state) }
        for value in splitStates.values { zero(value) }
        context = Array(repeating: 0, count: context.count)
    }

    public func speechProbability(samples: [Float]) throws -> Double {
        lock.lock()
        defer { lock.unlock() }
        guard let model else {
            throw SileroVADError.backendUnavailable("the Silero pack is not loaded")
        }

        guard samples.count == 512 else {
            throw SileroVADError.backendUnavailable("Silero streaming frames must contain 512 samples")
        }
        let framed = context + samples
        let audio = try MLMultiArray(shape: audioShape, dataType: audioDataType)
        for index in framed.indices { audio[index] = NSNumber(value: framed[index]) }

        var features: [String: MLFeatureValue] = [inputName: MLFeatureValue(multiArray: audio)]
        if let stateInputName, let state {
            features[stateInputName] = MLFeatureValue(multiArray: state)
        }
        for (name, value) in splitStates { features[name] = MLFeatureValue(multiArray: value) }
        if let sampleRateInputName {
            let rate = try MLMultiArray(shape: [1], dataType: .int32)
            rate[0] = NSNumber(value: PCMPacket.sampleRate)
            features[sampleRateInputName] = MLFeatureValue(multiArray: rate)
        }

        let prediction = try model.prediction(from: try MLDictionaryFeatureProvider(dictionary: features))
        if let stateOutputName, let next = prediction.featureValue(for: stateOutputName)?.multiArrayValue {
            state = next
        }
        for name in Array(splitStates.keys) {
            guard let next = prediction.featureValue(for: "\(name)_out")?.multiArrayValue else {
                throw SileroVADError.backendUnavailable("Silero produced no recurrent \(name) state")
            }
            splitStates[name] = next
        }
        if !context.isEmpty { context = Array(samples.suffix(context.count)) }
        guard let probability = prediction.featureValue(for: outputName)?.multiArrayValue,
              probability.count > 0
        else {
            throw SileroVADError.backendUnavailable("the Silero pack produced no speech probability")
        }
        return probability[0].doubleValue
    }

    private func zero(_ array: MLMultiArray) {
        for index in 0..<array.count { array[index] = 0 }
    }
}
#endif

/// Energy stand-in used only by development harnesses (`allowEnergyFallback`); the acceptance path
/// for the model pack itself is the bundled Silero model.
public final class EnergyVADModel: SileroVADModel {
    public init() {}

    public func load(from modelDirectory: URL) {}
    public func reset() {}

    public func speechProbability(samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        let meanSquare = samples.reduce(0) { $0 + Double($1 * $1) } / Double(samples.count)
        let rms = meanSquare.squareRoot()
        return min(1, rms / 0.05)
    }
}
