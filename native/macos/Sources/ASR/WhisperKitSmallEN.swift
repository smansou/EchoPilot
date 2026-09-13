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

/// The on-disk layout of the WhisperKit pack this build runs. WhisperKit's own
/// `loadTokenizerIfNeeded` falls back to a Hub download whenever `tokenizer.json` is missing *or*
/// fails to load locally — even with `download: false` — so a present-but-incomplete pack would
/// reach the network from the advertised local-only path. The helper validates this layout before
/// capture opens and fails closed instead of trusting the fallback.
public enum WhisperModelPackLayout {
    /// The three CoreML bundles WhisperKit loads before it can transcribe.
    public static let modelNames = ["MelSpectrogram", "AudioEncoder", "TextDecoder"]
    public static let tokenizerName = "tokenizer.json"
    public static let tokenizerConfigName = "tokenizer_config.json"
    public static let modelConfigName = "config.json"

    /// Mirrors WhisperKit's `ModelUtilities.detectModelURL(inFolder:named:)`: a compiled
    /// `.mlmodelc` bundle, else the `.mlpackage` source bundle.
    public static func modelFileURL(inPack packFolder: URL, named name: String) -> URL? {
        let manager = FileManager.default
        let compiled = packFolder.appendingPathComponent("\(name).mlmodelc", isDirectory: true)
        if manager.fileExists(atPath: compiled.path) { return compiled }
        let package = packFolder.appendingPathComponent(
            "\(name).mlpackage/Data/com.apple.CoreML/model.mlmodel"
        )
        if manager.fileExists(atPath: package.path) { return package }
        return nil
    }

    /// Rejects a pack that cannot serve the whole pipeline from disk: the three model bundles, a
    /// `tokenizer.json` WhisperKit can parse, and the tokenizer/model config its local loader needs
    /// to classify the tokenizer. Throws `ASRError.modelPackMissing` naming the first gap.
    public static func validate(packFolder: URL) throws {
        let manager = FileManager.default
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: packFolder.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            throw ASRError.modelPackMissing(packFolder.path)
        }
        for name in modelNames {
            guard let url = modelFileURL(inPack: packFolder, named: name) else {
                throw ASRError.modelPackMissing(
                    "\(packFolder.path) has no \(name).mlmodelc or \(name).mlpackage"
                )
            }
            guard manager.fileExists(atPath: url.path) else {
                throw ASRError.modelPackMissing(url.path)
            }
        }
        try validateJSONObject(
            at: packFolder.appendingPathComponent(tokenizerName),
            requiring: "model"
        )
        // WhisperKit loads the tokenizer locally only when it can classify it: `tokenizer.json`
        // alone leaves it throwing, and a throw is the code path that falls back to the Hub.
        let tokenizerConfig = packFolder.appendingPathComponent(tokenizerConfigName)
        let modelConfig = packFolder.appendingPathComponent(modelConfigName)
        let hasTokenizerConfig = manager.fileExists(atPath: tokenizerConfig.path)
        let hasModelConfig = manager.fileExists(atPath: modelConfig.path)
        guard hasTokenizerConfig || hasModelConfig else {
            throw ASRError.modelPackMissing(
                "\(packFolder.path) has neither \(tokenizerConfigName) nor \(modelConfigName); "
                    + "WhisperKit would download the tokenizer from the Hub"
            )
        }
        if hasTokenizerConfig { try validateJSONObject(at: tokenizerConfig, requiring: nil) }
        if hasModelConfig { try validateJSONObject(at: modelConfig, requiring: nil) }
    }

    /// A file that is absent, unreadable, empty, not a JSON object, or missing the section
    /// WhisperKit expects makes its local load throw — the path that silently falls back to the
    /// network, so it must fail closed here instead.
    public static func validateJSONObject(at url: URL, requiring key: String?) throws {
        guard let data = try? Data(contentsOf: url), !data.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw ASRError.modelPackMissing("\(url.path) is missing or is not valid JSON")
        }
        if let key, object[key] == nil {
            throw ASRError.modelPackMissing("\(url.path) is not a tokenizer file (no '\(key)' section)")
        }
    }
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
        let packPath = configuration.modelDirectory.appendingPathComponent(
            configuration.pack.name,
            isDirectory: true
        )
        // Fail closed before capture: an incomplete pack would otherwise let WhisperKit's
        // tokenizer loader reach the Hub at transcribe time.
        try WhisperModelPackLayout.validate(packFolder: packPath)
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
