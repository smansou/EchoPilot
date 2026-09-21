import Foundation

/// Scores one standby window from the packets the microphone graph captured.
///
/// The window is measured in two dimensions — overall level, and how peaky it is — which is enough
/// to gate attention and to separate the environments the false-trigger report keeps apart: a
/// silent room is `quiet`, loud sustained program audio is `tv`, and speech at a distance keeps the
/// high peak-to-average ratio that `background_speech` is labeled by. Labeling an actual wake
/// phrase is the conversation model's job; this detector only decides whether a window is worth the
/// app's attention, and a detection it returns is never an action grant.
public struct StandbyWakeDetector: Sendable {
    public struct Window: Sendable, Equatable {
        public let environment: String
        public let durationMs: Double
        public let detected: Bool
        public let confidence: Double
        public let threshold: Double
    }

    /// Level below which the room counts as quiet, on the 16-bit full-scale dBFS scale.
    public static let quietFloorDb = -58.0
    /// Sustained level at which a window reads as program audio (a TV playing at normal volume).
    public static let loudFloorDb = -28.0
    /// Peak-to-average ratio that reads as speech rather than steady program audio.
    public static let speechCrestDb = 12.0

    public let threshold: Double
    private var sumSquares = 0.0
    private var peak = 0.0
    private var sampleCount = 0

    public init(threshold: Double = 0.8) {
        self.threshold = min(1, max(0, threshold))
    }

    public mutating func reset() {
        sumSquares = 0
        peak = 0
        sampleCount = 0
    }

    /// Accumulates one 20 ms packet of 16 kHz mono little-endian Int16 samples.
    public mutating func ingest(_ packet: PCMPacket) {
        packet.pcm.withUnsafeBytes { raw in
            let count = raw.count / MemoryLayout<Int16>.size
            for index in 0..<count {
                let value = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                let normalized = Double(value) / 32_768
                sumSquares += normalized * normalized
                peak = max(peak, abs(normalized))
                sampleCount += 1
            }
        }
    }

    /// Closes the window. A window that captured nothing is still reported: it is a measured quiet
    /// interval, and dropping it would shorten the exposure the false-trigger rate divides by.
    public mutating func finishWindow(durationMs: Double) -> Window {
        let rms = sampleCount > 0 ? (sumSquares / Double(sampleCount)).squareRoot() : 0
        let rmsDb = rms > 0 ? 20 * log10(rms) : -120
        let confidence = min(1, max(0, (rmsDb - Self.quietFloorDb) / (0 - Self.quietFloorDb)))
        let environment: String
        if rmsDb < Self.quietFloorDb {
            environment = "quiet"
        } else if rmsDb >= Self.loudFloorDb {
            environment = "tv"
        } else {
            let peakDb = peak > 0 ? 20 * log10(peak) : -120
            environment = (peakDb - rmsDb) >= Self.speechCrestDb ? "background_speech" : "other"
        }
        let window = Window(
            environment: environment,
            durationMs: max(1, durationMs),
            detected: confidence >= threshold,
            confidence: confidence,
            threshold: threshold
        )
        reset()
        return window
    }
}
