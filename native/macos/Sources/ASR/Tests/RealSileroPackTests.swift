import ASR
import Foundation
import Testing

/// Exercises the actual pinned model, including recurrent state and 64-sample context.
struct RealSileroPackTests {
  @Test(.enabled(if: ProcessInfo.processInfo.environment["ECHOPILOT_SILERO_MODEL_DIR"] != nil))
  func pinnedCoreMLModelPredictsAndResets() throws {
    guard let path = ProcessInfo.processInfo.environment["ECHOPILOT_SILERO_MODEL_DIR"] else {
      return
    }
    let backend = SileroVADCoreMLBackend()
    try backend.load(from: URL(fileURLWithPath: path, isDirectory: true))
    let silence = Array(repeating: Float(0), count: 512)
    let first = try backend.speechProbability(samples: silence)
    #expect(first.isFinite && first >= 0 && first < 0.5)
    for frame in 0..<20 {
      let wave = (0..<512).map { index in
        Float(sin(Double(frame * 512 + index) * 2 * .pi * 220 / 16_000)) * 0.1
      }
      let probability = try backend.speechProbability(samples: wave)
      #expect(probability.isFinite && probability >= 0 && probability <= 1)
    }
    backend.reset()
    let afterReset = try backend.speechProbability(samples: silence)
    #expect(abs(first - afterReset) < 0.0001)
  }
}
