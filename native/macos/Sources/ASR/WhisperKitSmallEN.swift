import Foundation
import Audio

#if canImport(WhisperKit)
import WhisperKit
#endif

public enum ASRError: Error, Equatable {
    case modelPackMissing(String)
    case backendUnavailable(String)
    case windowTooLong(Double)
    case emptyWindow
    case unsupportedLanguage(String)
    case networkDisabled(String)
}

/// The first model pack is English only: WhisperKit small.en, 16 kHz, ≤ 15 s windows.
public struct WhisperModelPack: Sendable, Equatable {
    public let name: String
    public let language: String
    public let sampleRate: Int
    public let maxWindowMs: Int
    public let isMultilingual: Bool

    public init(name: String, language: String, sampleRate: Int, maxWindowMs: Int, isMultilingual: Bool) {
        self.name = name
        self.language = language
        self.sampleRate = sampleRate
        self.maxWindowMs = maxWindowMs
        self.isMultilingual = isMultilingual
    }

    public static let englishSmall = WhisperModelPack(
        name: "small.en",
        language: "en",
        sampleRate: PCMPacket.sampleRate,
        maxWindowMs: 15_000,
        isMultilingual: false
    )
}

public protocol LocalTranscriber: AnyObject, Sendable {
    func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult
}

/// Local-only WhisperKit small.en. The model pack lives on disk; `allowsNetwork` is false and the
/// initializer refuses to build a transcriber that would download or route audio off the machine.
public final class WhisperKitSmallEN: LocalTranscriber {
    public struct Configuration: Sendable {
        public var modelDirectory: URL
        public var pack: WhisperModelPack = .englishSmall
        public var wordTimestamps = true
        public var allowsNetwork = false

        public init(modelDirectory: URL) {
            self.modelDirectory = modelDirectory
        }
    }

    public let configuration: Configuration

    /// True when this build actually links the pinned WhisperKit backend. The packaged helper must
    /// report `true`; a `false` here means `transcribe(_:)` can only throw `backendUnavailable`.
    public static var isBackendLinked: Bool {
        #if canImport(WhisperKit)
        return true
        #else
        return false
        #endif
    }

    public init(configuration: Configuration) throws {
        guard !configuration.allowsNetwork else {
            throw ASRError.networkDisabled("local mode must not download or route audio")
        }
        let packPath = configuration.modelDirectory.appendingPathComponent(configuration.pack.name)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: packPath.path, isDirectory: &isDirectory) else {
            throw ASRError.modelPackMissing(packPath.path)
        }
        self.configuration = configuration
    }

    public func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult {
        guard !window.pcm.isEmpty else { throw ASRError.emptyWindow }
        guard window.durationMs <= Double(configuration.pack.maxWindowMs) else {
            throw ASRError.windowTooLong(window.durationMs)
        }
        guard !configuration.pack.isMultilingual, configuration.pack.language == "en" else {
            throw ASRError.unsupportedLanguage(configuration.pack.language)
        }
        #if canImport(WhisperKit)
        return try await transcribeWithWhisperKit(window)
        #else
        throw ASRError.backendUnavailable(
            "WhisperKit small.en is not linked into this build; run the packaged helper"
        )
        #endif
    }

    #if canImport(WhisperKit)
    /// Pinned WhisperKit API: `WhisperKitConfig(model:modelFolder:download:)` + word timestamps.
    private func transcribeWithWhisperKit(_ window: ASRWindow) async throws -> ASRWindowResult {
        let packFolder = configuration.modelDirectory.appendingPathComponent(configuration.pack.name)
        let kit = try await WhisperKit(WhisperKitConfig(
            model: configuration.pack.name,
            modelFolder: packFolder.path,
            download: false
        ))
        let samples = SileroVAD.floatSamples(from: window.pcm)
        let options = DecodingOptions(
            language: configuration.pack.language,
            wordTimestamps: configuration.wordTimestamps
        )
        let results = try await kit.transcribe(audioArray: samples, decodeOptions: options)
        let words = results
            .flatMap(\.allWords)
            .map { word in
                ASRWordTimestamp(
                    text: word.word.trimmingCharacters(in: .whitespacesAndNewlines),
                    startMs: Int((word.start * 1_000).rounded()),
                    endMs: Int((word.end * 1_000).rounded())
                )
            }
            .filter { !$0.text.isEmpty }
        // Trailing-silence endpointing belongs to Silero VAD; the transcriber only reports words.
        return ASRWindowResult(
            text: words.map(\.text).joined(separator: " "),
            words: words,
            endpoint: false
        )
    }
    #endif
}
