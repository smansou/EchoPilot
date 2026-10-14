import Audio
import Foundation

/// Everything the signed voice helper needs to run the local tracer without Xcode: the on-disk
/// model packs, the bounded ring size and the session budget.
public struct VoiceHostConfiguration: Sendable {
    /// Folder that holds the English-only WhisperKit pack (`<folder>/small.en`).
    public var asrModelDirectory: URL
    /// Folder that holds the Silero pack. `nil` resolves the default search paths and then falls
    /// back to `asrModelDirectory`.
    public var vadModelDirectory: URL?
    /// Explicit local-development fallback when a Silero CoreML pack has not been vendored.
    public var allowEnergyFallback: Bool
    public var maxQueuedFrames: Int

    public init(asrModelDirectory: URL, vadModelDirectory: URL? = nil, maxQueuedFrames: Int = 100, allowEnergyFallback: Bool = false) {
        self.asrModelDirectory = asrModelDirectory
        self.vadModelDirectory = vadModelDirectory
        self.maxQueuedFrames = max(1, maxQueuedFrames)
        self.allowEnergyFallback = allowEnergyFallback
    }

    /// The helper's launch environment:
    ///   - `ECHOPILOT_ASR_MODEL_DIR`   — folder with the `small.en` pack (required);
    ///   - `ECHOPILOT_SILERO_MODEL_DIR` — folder with the Silero pack (optional, else searched);
    ///   - `ECHOPILOT_MAX_QUEUED_FRAMES` — bounded ring size (optional, default 100 = 2 s).
    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> VoiceHostConfiguration {
        guard let asrDirectory = environment["ECHOPILOT_ASR_MODEL_DIR"], !asrDirectory.isEmpty else {
            throw VoiceHostError.modelPackMissing(
                "ECHOPILOT_ASR_MODEL_DIR is not set; point the helper at the folder holding the small.en pack"
            )
        }
        let vadDirectory = environment["ECHOPILOT_SILERO_MODEL_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
        let queueFrames = Int(environment["ECHOPILOT_MAX_QUEUED_FRAMES"] ?? "") ?? 100
        return VoiceHostConfiguration(
            asrModelDirectory: URL(fileURLWithPath: asrDirectory, isDirectory: true),
            vadModelDirectory: vadDirectory,
            maxQueuedFrames: queueFrames,
            allowEnergyFallback: environment["ECHOPILOT_VAD_FALLBACK"] == "energy"
        )
    }
}

public enum VoiceHostError: Error, Equatable, CustomStringConvertible {
    case modelPackMissing(String)

    public var description: String {
        switch self {
        case let .modelPackMissing(detail): return detail
        }
    }
}

/// The production bootstrap of the local voice tracer. This is the code the signed helper's voice
/// entry point (`echopilot-voice`) runs: it registers the CoreML Silero runtime, builds the
/// WhisperKit small.en transcriber from the on-disk pack and hands both to a fresh
/// `VoiceTracerBridge`. No network access is involved at any point.
public enum VoiceSessionBootstrap {
    /// Registers the CoreML Silero v5 backend with the VAD registry. Idempotent; a harness that
    /// registered its own backend first keeps it.
    public static func registerProductionBackends() {
        #if canImport(CoreML)
        guard !SileroVADBackendRegistry.hasRegisteredBackend else { return }
        SileroVADBackendRegistry.register { SileroVADCoreMLBackend() }
        #endif
    }

    /// Builds the live session: microphone graph + Silero VAD + WhisperKit small.en + planner.
    /// A missing model pack throws before capture opens, so the helper can report a visible state
    /// instead of hanging the widget.
    public static func makeLocalSession(_ configuration: VoiceHostConfiguration) throws -> VoiceTracerBridge {
        registerProductionBackends()

        let transcriber = try WhisperKitSmallEN(
            configuration: WhisperKitSmallEN.Configuration(modelDirectory: configuration.asrModelDirectory)
        )
        var vadConfiguration = SileroVADConfiguration()
        vadConfiguration.modelDirectory = configuration.vadModelDirectory
            ?? SileroVADModelPack.resolve()
            ?? configuration.asrModelDirectory
        vadConfiguration.allowEnergyFallback = configuration.allowEnergyFallback
        let vad = try SileroVAD(configuration: vadConfiguration)
        let host = MicrophoneGraph(maxQueuedFrames: configuration.maxQueuedFrames)
        return VoiceTracerBridge(host: host, vad: vad, transcriber: transcriber)
    }
}
