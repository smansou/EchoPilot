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
/// fails to load locally — even with `download: false` — and the local load throws as soon as it
/// cannot classify the tokenizer or read its vocabulary. A present-but-incomplete pack would
/// therefore reach the network from the advertised local-only path. The helper mirrors that local
/// load before capture opens and fails closed instead of trusting the fallback.
public enum WhisperModelPackLayout {
    /// The three CoreML bundles WhisperKit loads before it can transcribe.
    public static let modelNames = ["MelSpectrogram", "AudioEncoder", "TextDecoder"]
    public static let tokenizerName = "tokenizer.json"
    public static let tokenizerConfigName = "tokenizer_config.json"
    public static let modelConfigName = "config.json"

    /// WhisperKit 1.1.0's `TokenizerModel.knownTokenizers`: the tokenizer classes its local loader
    /// can actually construct. `TokenizerModel.from` throws `unsupportedTokenizer` for any other
    /// name, and `ModelUtilities.loadTokenizer` answers that throw with a Hub download.
    public static let supportedTokenizerClasses: Set<String> = [
        "BertTokenizer",
        "CodeGenTokenizer",
        "CodeLlamaTokenizer",
        "CohereTokenizer",
        "DistilbertTokenizer",
        "DistilBertTokenizer",
        "FalconTokenizer",
        "GemmaTokenizer",
        "GPT2Tokenizer",
        "LlamaTokenizer",
        "RobertaTokenizer",
        "T5Tokenizer",
        "TokenizersBackend",
        "PreTrainedTokenizer",
        "Qwen2Tokenizer",
        "WhisperTokenizer",
        "XLMRobertaTokenizer",
    ]

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
    /// `tokenizer.json` WhisperKit can parse, and the tokenizer configuration its local loader
    /// needs to classify *and* build the tokenizer. Throws `ASRError.modelPackMissing` naming the
    /// first gap.
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
        let tokenizerData = try jsonObject(
            at: packFolder.appendingPathComponent(tokenizerName),
            requiring: "model"
        )
        try validateTokenizerResolution(inPack: packFolder, tokenizerData: tokenizerData)
    }

    /// Mirrors WhisperKit's local tokenizer resolution (`LanguageModelConfigurationFromHub` +
    /// `AutoTokenizer.from(modelFolder:)`) so a pack whose local load would *throw* — and therefore
    /// send `ModelUtilities.loadTokenizer` to its Hub-download branch even though `download` is
    /// false — is rejected before capture opens:
    ///
    /// - `tokenizer_config.json` must exist and parse: without it WhisperKit's `tokenizerConfig` is
    ///   `nil` and `AutoTokenizer.from(modelFolder:)` throws `missingConfig`.
    /// - The pack must resolve a tokenizer class: the `tokenizer_class` the tokenizer config names,
    ///   else the `"<ModelType>Tokenizer"` class WhisperKit synthesizes from the `model_type` in
    ///   `config.json`. With neither, `TokenizerModel.from` throws `missingTokenizerClassInConfig`.
    /// - `config.json`, when present, must parse: WhisperKit reads it while it builds the local
    ///   tokenizer configuration, so a broken file is another Hub-fallback throw.
    /// - That class, with the `Fast` suffix WhisperKit strips, must be one its local loader can
    ///   build; anything else throws `unsupportedTokenizer`.
    /// - `tokenizer.json` must carry the data a local load reads from its `model` section: a
    ///   vocabulary for every class (`vocab` as an object for BPE/BERT, as `[token, score]` pairs
    ///   for Unigram) and the `merges` array for the BPE classes (`BPETokenizer` traps without it,
    ///   and a `missingVocab` throw takes the same Hub fallback).
    static func validateTokenizerResolution(
        inPack packFolder: URL,
        tokenizerData: [String: Any]
    ) throws {
        let tokenizerConfigPath = packFolder.appendingPathComponent(tokenizerConfigName)
        guard let tokenizerConfig = try? jsonObject(at: tokenizerConfigPath) else {
            throw ASRError.modelPackMissing(
                "\(tokenizerConfigPath.path) is missing or is not valid JSON; without it WhisperKit "
                    + "cannot resolve the local tokenizer and would download it from the Hub"
            )
        }

        // `config.json` is optional, but when it is on disk WhisperKit parses it while it builds
        // the local tokenizer configuration, so a broken file is a Hub-fallback throw too.
        let modelConfigPath = packFolder.appendingPathComponent(modelConfigName)
        var modelConfig: [String: Any]?
        if FileManager.default.fileExists(atPath: modelConfigPath.path) {
            modelConfig = try jsonObject(at: modelConfigPath)
        }

        let className: String
        if let configured = stringProperty(
            in: tokenizerConfig,
            names: ["tokenizer_class", "tokenizerClass"]
        ) {
            // A named class is authoritative even when it is empty: WhisperKit only consults
            // `config.json` when `tokenizer_class` is not a string at all.
            className = configured
        } else if let modelType = modelConfig.flatMap({
            stringProperty(in: $0, names: ["model_type", "modelType"])
        }), !modelType.isEmpty {
            // `LanguageModelConfigurationFromHub.tokenizerConfig` synthesizes this name from the
            // model config when the tokenizer config does not name a class.
            className = "\(modelType.capitalized)Tokenizer"
        } else {
            throw ASRError.modelPackMissing(
                "\(packFolder.path) resolves no local tokenizer class: \(tokenizerConfigName) has "
                    + "no tokenizer_class and \(modelConfigName) supplies no model_type; "
                    + "WhisperKit would download the tokenizer from the Hub"
            )
        }

        // WhisperKit strips a `Fast` suffix before it looks the class up.
        let localClassName = className.replacingOccurrences(of: "Fast", with: "")
        guard supportedTokenizerClasses.contains(localClassName) else {
            throw ASRError.modelPackMissing(
                "\(packFolder.path) asks for tokenizer class '\(className)', which WhisperKit's "
                    + "local loader cannot build; it would download the tokenizer from the Hub"
            )
        }

        guard let model = tokenizerData["model"] as? [String: Any] else {
            throw ASRError.modelPackMissing(
                "\(packFolder.path)/\(tokenizerName) has no 'model' object WhisperKit can read; "
                    + "it would download the tokenizer from the Hub"
            )
        }
        switch localClassName {
        case "XLMRobertaTokenizer":
            guard model["vocab"] is [Any] else {
                throw ASRError.modelPackMissing(
                    "\(packFolder.path)/\(tokenizerName) has no Unigram 'model.vocab' array; "
                        + "WhisperKit would download the tokenizer from the Hub"
                )
            }
        case "BertTokenizer":
            guard model["vocab"] is [String: Any] else {
                throw ASRError.modelPackMissing(
                    "\(packFolder.path)/\(tokenizerName) has no 'model.vocab' object; "
                        + "WhisperKit would download the tokenizer from the Hub"
                )
            }
        default:
            guard model["vocab"] is [String: Any], model["merges"] is [Any] else {
                throw ASRError.modelPackMissing(
                    "\(packFolder.path)/\(tokenizerName) has no BPE 'model.vocab' object or "
                        + "'model.merges' array; WhisperKit would download the tokenizer from the Hub"
                )
            }
        }
    }

    /// A file that is absent, unreadable, empty, not a JSON object, or missing the section
    /// WhisperKit expects makes its local load throw — the path that silently falls back to the
    /// network, so it must fail closed here instead.
    public static func validateJSONObject(at url: URL, requiring key: String?) throws {
        _ = try jsonObject(at: url, requiring: key)
    }

    /// Parses `url` into the JSON object WhisperKit's `HubApi.configuration(fileURL:)` needs and
    /// returns it, so the caller can inspect the sections the local loader reads.
    static func jsonObject(at url: URL, requiring key: String? = nil) throws -> [String: Any] {
        guard let data = try? Data(contentsOf: url), !data.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw ASRError.modelPackMissing("\(url.path) is missing or is not valid JSON")
        }
        if let key, object[key] == nil {
            throw ASRError.modelPackMissing("\(url.path) is not a tokenizer file (no '\(key)' section)")
        }
        return object
    }

    /// Reads a config string under either the snake_case key WhisperKit's loader looks up or the
    /// camelCase spelling its `Config` dynamic members un-camelcase.
    static func stringProperty(in object: [String: Any], names: [String]) -> String? {
        for name in names {
            if let value = object[name] as? String { return value }
        }
        return nil
    }

    /// Test seam: runs WhisperKit's own local tokenizer load — `AutoTokenizerWrapper.from(modelFolder:)`,
    /// the call `ModelUtilities.loadTokenizer` makes before it falls through to its Hub branch — and
    /// reports whether the pack loads from disk. The regression uses it to prove that a rejected
    /// pack really is the shape WhisperKit fails locally (so it would download the tokenizer) and
    /// that an accepted pack loads with no network involved.
    static func localTokenizerLoads(packFolder: URL) async -> Bool {
        #if canImport(WhisperKit)
        do {
            _ = try await AutoTokenizerWrapper.from(modelFolder: packFolder)
            return true
        } catch {
            return false
        }
        #else
        return false
        #endif
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
            // Pin WhisperKit's tokenizer search to the pack this helper validated. Without it the
            // loader also searches the machine-level Hub cache (`~/Documents/huggingface`) first,
            // where a present-but-broken tokenizer would take the same Hub-download fallback the
            // layout check just closed off.
            tokenizerFolder: packFolder,
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
