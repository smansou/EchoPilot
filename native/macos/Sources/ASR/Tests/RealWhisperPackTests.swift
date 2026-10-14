import ASR
import AVFoundation
import Foundation
import XCTest

final class RealWhisperPackTests: XCTestCase {
    func testPinnedPackTranscribesLocalSpeechFixture() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let modelDirectory = environment["ECHOPILOT_ASR_MODEL_DIR"],
              let fixturePath = environment["ECHOPILOT_ASR_FIXTURE_WAV"] else {
            throw XCTSkip("Set ECHOPILOT_ASR_MODEL_DIR and ECHOPILOT_ASR_FIXTURE_WAV for real-model validation")
        }
        let transcriber = try WhisperKitSmallEN(configuration: .init(
            modelDirectory: URL(fileURLWithPath: modelDirectory, isDirectory: true)
        ))
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: fixturePath))
        XCTAssertEqual(file.processingFormat.sampleRate, 16_000)
        XCTAssertEqual(file.processingFormat.channelCount, 1)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buffer)
        guard let samples = buffer.floatChannelData?[0] else {
            return XCTFail("Fixture could not be decoded to mono float samples")
        }
        var pcm = Data(capacity: Int(buffer.frameLength) * 2)
        for index in 0..<Int(buffer.frameLength) {
            let clamped = max(-1.0, min(1.0, samples[index]))
            let sample = Int16((clamped * 32_767.0).rounded())
            pcm.append(UInt8(truncatingIfNeeded: sample))
            pcm.append(UInt8(truncatingIfNeeded: sample >> 8))
        }
        let result = try await transcriber.transcribe(ASRWindow(
            utteranceId: "real-pack-check", startMs: 0, sampleRate: 16_000, channels: 1, pcm: pcm
        ))
        let normalized = result.text.lowercased().filter { $0.isLetter }
        XCTAssertTrue(normalized.contains("echopilot"), "Unexpected transcript: \(result.text)")
    }
}
