#if canImport(WhisperKit)
  import Foundation
  @preconcurrency import WhisperKit

  /// Owns one loaded WhisperKit per voice helper session, rather than loading every ASR window.
  actor WhisperSessionRuntime {
    private let configuration: WhisperKitSmallEN.Configuration
    private var loading: Task<Void, Error>?
    // WhisperKit 1.1.0 predates Sendable. This instance never leaves this actor.
    private var kit: WhisperKit?

    init(configuration: WhisperKitSmallEN.Configuration) {
      self.configuration = configuration
    }

    func prepareModels() async throws {
      if kit != nil { return }
      if let loading { return try await loading.value }
      let task = Task { try await self.loadModels() }
      loading = task
      do { try await task.value } catch {
        loading = nil
        throw error
      }
    }

    private func loadModels() async throws {
      if ProcessInfo.processInfo.environment["ECHOPILOT_VOICE_DEBUG_MODELS"] == "1" {
        FileHandle.standardError.write(Data("EchoPilot: loading local WhisperKit weights\n".utf8))
      }
      let folder = configuration.modelDirectory.appendingPathComponent(configuration.pack.name)
      // The parent validates every tokenizer file before this can run. Both model and
      // tokenizer resolve from the shipped pack; no machine-level Hub cache is used.
      kit = try await WhisperKit(
        WhisperKitConfig(
          model: configuration.pack.name,
          modelFolder: folder.path,
          tokenizerFolder: folder,
          // ANE specialization of this converted pack can exceed the helper's first-launch
          // budget. CPU/GPU supports the same local model without that ANE compiler wait.
          computeOptions: ModelComputeOptions(
            audioEncoderCompute: .cpuAndGPU, textDecoderCompute: .cpuAndGPU),
          download: false
        ))
      if ProcessInfo.processInfo.environment["ECHOPILOT_VOICE_DEBUG_MODELS"] == "1" {
        FileHandle.standardError.write(Data("EchoPilot: local WhisperKit weights ready\n".utf8))
      }
    }

    func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult {
      try await prepareModels()
      guard let kit else {
        throw ASRError.backendUnavailable("WhisperKit model loading did not complete")
      }
      let results = try await kit.transcribe(
        audioArray: SileroVAD.floatSamples(from: window.pcm),
        decodeOptions: DecodingOptions(
          language: configuration.pack.language,
          wordTimestamps: configuration.wordTimestamps
        )
      )
      let words = results.flatMap(\.allWords).map { word in
        ASRWordTimestamp(
          text: word.word.trimmingCharacters(in: .whitespacesAndNewlines),
          startMs: Int((word.start * 1_000).rounded()),
          endMs: Int((word.end * 1_000).rounded())
        )
      }.filter { !$0.text.isEmpty }
      return ASRWindowResult(
        text: words.map(\.text).joined(separator: " "), words: words, endpoint: false)
    }
  }
#endif
