import Foundation

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
        if let directory = configuration.modelDirectory,
           FileManager.default.fileExists(atPath: directory.appendingPathComponent("silero_vad.onnx").path),
           let backend = SileroVADBackendRegistry.makeBackend() {
            try backend.load(from: directory)
            self.model = backend
        } else if configuration.allowEnergyFallback {
            self.model = EnergyVADModel()
        } else {
            let path = configuration.modelDirectory?.appendingPathComponent("silero_vad.onnx").path ?? "silero_vad.onnx"
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

        let endpoint = spokeInUtterance && trailingSilenceMs >= configuration.endSilenceMs
        return VADState(
            speechProbability: lastProbability,
            isSpeech: lastProbability > configuration.releaseThreshold,
            trailingSilenceMs: trailingSilenceMs,
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

    static func makeBackend() -> SileroVADModel? {
        lock.lock()
        defer { lock.unlock() }
        return factory?()
    }
}

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
