import AudioToolbox
import Foundation

/// One native PCM packet: 20 ms of 16 kHz mono little-endian Int16 samples.
///
/// This is the exact shape of the frozen `VoiceSession.pushInput` frame, so the helper can hand
/// packets to the widget without any per-packet allocation of a different representation.
public struct PCMPacket: Sendable, Equatable {
    public static let sampleRate = 16_000
    public static let channels = 1
    public static let packetMs = 20
    public static let samplesPerPacket = sampleRate * packetMs / 1_000
    public static let packetDurationNs = UInt64(packetMs) * 1_000_000

    /// Monotonic packet counter; a dropped packet leaves a visible gap in the sequence.
    public let sequence: UInt64
    public let sampleRate: Int
    public let channels: Int
    /// Start of the packet on the native monotonic clock, in nanoseconds (wire format: string).
    public let monotonicNs: String
    public let pcm: Data

    public init(
        sequence: UInt64,
        sampleRate: Int = PCMPacket.sampleRate,
        channels: Int = PCMPacket.channels,
        monotonicNs: UInt64,
        pcm: Data
    ) {
        self.sequence = sequence
        self.sampleRate = sampleRate
        self.channels = channels
        self.monotonicNs = String(monotonicNs)
        self.pcm = pcm
    }

    public var durationMs: Double {
        guard sampleRate > 0, channels > 0 else { return 0 }
        return (Double(pcm.count) / Double(channels * 2)) / Double(sampleRate) * 1_000
    }

    /// The wire representation of the frozen host contract.
    public var jsonObject: [String: Any] {
        [
            "sequence": sequence,
            "sampleRate": sampleRate,
            "channels": channels,
            "monotonicNs": monotonicNs,
            "pcm": pcm.base64EncodedString(),
        ]
    }
}

public enum AudioHostClock {
    /// Monotonic clock used for frame and word timestamps; never wall-clock, never adjusted.
    public static func nowNs() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }

    /// Converts an `AVAudioTime.hostTime` (mach absolute time) into the monotonic nanosecond scale.
    public static func nanoseconds(fromHostTime hostTime: UInt64) -> UInt64 {
        AudioConvertHostTimeToNanos(hostTime)
    }
}

/// Re-chunks converted samples into 20 ms packets, keeping packet start times on the audio clock.
public struct AudioPacketizer {
    private var pending: [Int16] = []
    private var sequence: UInt64 = 0
    private var nextStartNs: UInt64?

    public init() {}

    public mutating func reset() {
        pending.removeAll(keepingCapacity: true)
        nextStartNs = nil
    }

    /// Appends converted 16 kHz mono samples and emits every complete packet. The `emit` closure
    /// must not block on the ASR consumer: the bounded transport ring is the only queue.
    public mutating func append(
        samples: UnsafePointer<Int16>,
        count: Int,
        startNs: UInt64,
        emit: (PCMPacket) -> Void
    ) {
        if nextStartNs == nil { nextStartNs = startNs }
        pending.append(contentsOf: UnsafeBufferPointer(start: samples, count: count))
        while pending.count >= PCMPacket.samplesPerPacket {
            let chunk = Array(pending[0..<PCMPacket.samplesPerPacket])
            pending.removeFirst(PCMPacket.samplesPerPacket)
            let packetStartNs = nextStartNs ?? startNs
            let pcm = chunk.withUnsafeBufferPointer { Data(buffer: $0) }
            emit(PCMPacket(sequence: sequence, monotonicNs: packetStartNs, pcm: pcm))
            sequence += 1
            nextStartNs = packetStartNs &+ PCMPacket.packetDurationNs
        }
    }
}
