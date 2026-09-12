import Foundation

/// One ASR window: `startMs` and every word time inside it are window-relative milliseconds.
public struct ASRWindow: Sendable, Equatable {
    public let utteranceId: String
    public let startMs: Int
    public let sampleRate: Int
    public let channels: Int
    public let pcm: Data

    public init(utteranceId: String, startMs: Int, sampleRate: Int, channels: Int, pcm: Data) {
        self.utteranceId = utteranceId
        self.startMs = startMs
        self.sampleRate = sampleRate
        self.channels = channels
        self.pcm = pcm
    }

    public var durationMs: Double {
        guard sampleRate > 0, channels > 0 else { return 0 }
        return (Double(pcm.count) / Double(channels * 2)) / Double(sampleRate) * 1_000
    }
}

public struct ASRWordTimestamp: Sendable, Equatable, Codable {
    public let text: String
    public let startMs: Int
    public let endMs: Int

    public init(text: String, startMs: Int, endMs: Int) {
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
    }

    public var jsonObject: [String: Any] {
        ["text": text, "startMs": startMs, "endMs": endMs]
    }
}

public struct ASRWindowResult: Sendable, Equatable {
    public let text: String
    public let words: [ASRWordTimestamp]
    /// Set by the local engine (Silero VAD) when the window ends with enough trailing silence.
    public let endpoint: Bool

    public init(text: String, words: [ASRWordTimestamp], endpoint: Bool) {
        self.text = text
        self.words = words
        self.endpoint = endpoint
    }
}

/// One committed, stable prefix. Word times are relative to the start of the utterance.
public struct ASRCommit: Sendable, Equatable {
    public let utteranceId: String
    public let text: String
    public let words: [ASRWordTimestamp]

    public var jsonObject: [String: Any] {
        ["utteranceId": utteranceId, "text": text, "words": words.map(\.jsonObject)]
    }
}

public enum ASRPlannerEvent: Sendable, Equatable {
    case partial(ASRWindow)
    /// The window hit the 15 s bound: commit its stable prefix, then roll with the 1 s overlap.
    case seal(ASRWindow)
}

public enum ASRPlannerOutcome: Sendable, Equatable {
    /// A sealed window committed its stable prefix; the utterance stays open.
    case committed(ASRCommit)
    /// The endpoint committed the utterance (text may be empty) and closed it.
    case ended(ASRCommit)
    case displayOnly(text: String, words: [ASRWordTimestamp])
    case unchanged
}

/// Rolling-window rules of the V01 tracer: ≤ 15 s windows with a 1 s overlap, stable-prefix
/// commits only on a window boundary or on an endpoint, and word times that stay relative to the
/// start of the utterance rather than to an individual window.
public final class ASRWindowPlanner {
    public struct Configuration: Sendable {
        public var maxWindowMs = 15_000
        public var overlapMs = 1_000
        public var partialIntervalMs = 400
        public var sampleRate = PCMPacket.sampleRate
        public var channels = PCMPacket.channels

        public init() {}
    }

    private let configuration: Configuration
    private var windowStartMs = 0
    private var windowBytes: [UInt8] = []
    private var windowDurationMs = 0.0
    private var lastTranscribedMs = 0.0
    private var baseNs: UInt64?
    private var utteranceSeq = 0
    private var utteranceId: String?
    private var utteranceStartMs = 0
    private var committedWords: [ASRWordTimestamp] = []
    private var committedEndAbsMs = Int.min
    private var lastPartialText: String?

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    public var currentUtteranceId: String? { utteranceId }

    public func committedPrefix() -> ASRCommit? {
        guard let utteranceId, !committedWords.isEmpty else { return nil }
        return ASRCommit(
            utteranceId: utteranceId,
            text: committedWords.map(\.text).joined(separator: " "),
            words: committedWords
        )
    }

    /// Feeds one native packet and reports whether the current window is due for the engine.
    public func append(packet: PCMPacket) -> ASRPlannerEvent? {
        let packetMs = packet.durationMs
        let segmentLimitMs = Double(configuration.maxWindowMs - configuration.overlapMs)
        if packetMs > segmentLimitMs, packetMs > 0, packet.sampleRate > 0, packet.channels > 0 {
            return appendOversized(packet: packet, segmentLimitMs: segmentLimitMs)
        }
        return appendSegment(
            pcm: packet.pcm,
            durationMs: packetMs,
            startMs: timelineMs(for: packet)
        )
    }

    /// One packet longer than `maxWindowMs - overlapMs` (a host that does not send 20 ms packets)
    /// must not open a window past the 15 s bound: cut it into segments any roll-over tail can
    /// absorb, and report the strongest event the segments produced.
    private func appendOversized(packet: PCMPacket, segmentLimitMs: Double) -> ASRPlannerEvent? {
        let bytesPerFrame = packet.channels * 2
        let dataStart = packet.pcm.startIndex
        let frameCount = packet.pcm.count / bytesPerFrame
        guard frameCount > 0 else { return nil }
        let framesPerSegment = max(1, Int((segmentLimitMs / 1_000) * Double(packet.sampleRate)))
        let baseNs = UInt64(packet.monotonicNs)
        let fallbackStartMs = timelineMs(for: packet)
        var sealed: ASRPlannerEvent?
        var partial: ASRPlannerEvent?
        var offset = 0
        while offset < frameCount {
            let take = min(framesPerSegment, frameCount - offset)
            let start = offset * bytesPerFrame
            let end = start + take * bytesPerFrame
            let offsetMs = (Double(offset) / Double(packet.sampleRate)) * 1_000
            let startMs = baseNs.map { ns -> Int in
                let absolute = ns &+ UInt64((offsetMs * 1_000_000).rounded())
                return timelineMs(ns: absolute, fallbackMs: fallbackStartMs + Int(offsetMs.rounded()))
            } ?? fallbackStartMs + Int(offsetMs.rounded())
            let event = appendSegment(
                pcm: packet.pcm.subdata(in: (dataStart + start)..<(dataStart + end)),
                durationMs: (Double(take) / Double(packet.sampleRate)) * 1_000,
                startMs: startMs
            )
            switch event {
            case .seal: sealed = event
            case .partial: partial = event
            case nil: break
            }
            offset += take
        }
        // A sealed window carries the committed prefix, so it outranks a display-only partial.
        return sealed ?? partial
    }

    /// Appends one contiguous segment (already short enough for the roll-over tail) and reports the
    /// window event it produced.
    private func appendSegment(pcm: Data, durationMs: Double, startMs: Int) -> ASRPlannerEvent? {
        if windowBytes.isEmpty, windowDurationMs == 0 {
            windowStartMs = startMs
        }
        if utteranceId == nil { openUtterance(startMs: windowStartMs) }

        // Seal before the window would cross the 15 s bound, then continue with the overlap.
        if windowDurationMs + durationMs > Double(configuration.maxWindowMs) {
            let sealedStartMs = windowStartMs
            let sealedDurationMs = windowDurationMs
            let sealed = makeWindow()
            rollOverlap()
            windowStartMs = Int(
                (Double(sealedStartMs) + sealedDurationMs - Double(configuration.overlapMs)).rounded()
            )
            windowBytes.append(contentsOf: pcm)
            windowDurationMs += durationMs
            return .seal(sealed)
        }

        windowBytes.append(contentsOf: pcm)
        windowDurationMs += durationMs
        if windowDurationMs - lastTranscribedMs >= Double(configuration.partialIntervalMs) {
            lastTranscribedMs = windowDurationMs
            return .partial(makeWindow())
        }
        return nil
    }

    /// Applies one engine result. Only sealed windows and endpoints commit; partials only display.
    public func apply(
        result: ASRWindowResult,
        window: ASRWindow,
        sealed: Bool
    ) -> ASRPlannerOutcome {
        let id = utteranceId ?? window.utteranceId
        let fresh = result.words.filter { window.startMs + $0.endMs > committedEndAbsMs }
        let relative = fresh.map { word in
            ASRWordTimestamp(
                text: word.text,
                startMs: window.startMs + word.startMs - utteranceStartMs,
                endMs: window.startMs + word.endMs - utteranceStartMs
            )
        }

        if sealed || result.endpoint {
            let commit = ASRCommit(
                utteranceId: id,
                text: relative.map(\.text).joined(separator: " "),
                words: relative
            )
            guard !relative.isEmpty || result.endpoint else { return .unchanged }
            committedWords.append(contentsOf: relative)
            committedEndAbsMs = max(
                committedEndAbsMs,
                fresh.map { window.startMs + $0.endMs }.max() ?? committedEndAbsMs
            )
            if result.endpoint {
                endUtterance()
                return .ended(commit)
            }
            return .committed(commit)
        }

        guard !relative.isEmpty else { return .unchanged }
        let words = committedWords + relative
        let text = words.map(\.text).joined(separator: " ")
        guard text != lastPartialText else { return .unchanged }
        lastPartialText = text
        return .displayOnly(text: text, words: words)
    }

    /// Audio was dropped: the open window is no longer contiguous, so it must not be committed.
    public func markDiscontinuity() {
        windowBytes.removeAll(keepingCapacity: true)
        windowDurationMs = 0
        lastTranscribedMs = 0
        windowStartMs = 0
        endUtterance()
    }

    public func reset() {
        windowBytes.removeAll(keepingCapacity: true)
        windowDurationMs = 0
        lastTranscribedMs = 0
        windowStartMs = 0
        baseNs = nil
        utteranceId = nil
        committedWords = []
        committedEndAbsMs = Int.min
        lastPartialText = nil
    }

    /// Native monotonic clock → session-relative milliseconds.
    private func timelineMs(for packet: PCMPacket) -> Int {
        timelineMs(
            ns: UInt64(packet.monotonicNs),
            fallbackMs: windowStartMs + Int(windowDurationMs.rounded())
        )
    }

    private func timelineMs(ns: UInt64?, fallbackMs: Int) -> Int {
        guard let ns else { return fallbackMs }
        if baseNs == nil { baseNs = ns }
        let base = baseNs ?? ns
        guard ns >= base else { return 0 }
        return Int((Double(ns - base) / 1_000_000).rounded())
    }

    private func openUtterance(startMs: Int) {
        utteranceSeq += 1
        utteranceId = "utterance-\(utteranceSeq)"
        utteranceStartMs = startMs
        committedWords = []
        committedEndAbsMs = Int.min
        lastPartialText = nil
    }

    private func endUtterance() {
        utteranceId = nil
        committedWords = []
        committedEndAbsMs = Int.min
        lastPartialText = nil
    }

    private func makeWindow() -> ASRWindow {
        ASRWindow(
            utteranceId: utteranceId ?? "utterance-unknown",
            startMs: windowStartMs,
            sampleRate: configuration.sampleRate,
            channels: configuration.channels,
            pcm: Data(windowBytes)
        )
    }

    /// Keeps the trailing overlap of the sealed window so a word straddling the bound is still heard.
    private func rollOverlap() {
        let overlapBytes = configuration.overlapMs * configuration.sampleRate
            * configuration.channels
            * 2 / 1_000
        let tail = windowBytes.suffix(max(0, overlapBytes))
        windowBytes = Array(tail)
        windowDurationMs = Double(windowBytes.count) / Double(configuration.sampleRate * configuration.channels * 2) * 1_000
        lastTranscribedMs = windowDurationMs
    }
}
