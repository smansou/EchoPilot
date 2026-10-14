import Foundation

/// Global Quartz/AX screen coordinates, top-left origin, in desktop logical points.
/// Negative origins are retained for displays arranged left/above the primary display.
public struct ObservationFrame: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    public var validated: ObservationFrame? {
        guard [x, y, width, height].allSatisfy({ $0.isFinite }), width > 0, height > 0,
              width <= 100_000, height <= 100_000 else { return nil }
        return self
    }
}

public struct ObservationTextRegion: Codable, Equatable, Sendable {
    public let kind: String
    public let text: String
    public let frame: ObservationFrame
    public let rangeStart: Int
    public let rangeLength: Int
    public init(kind: String, text: String, frame: ObservationFrame, rangeStart: Int, rangeLength: Int) {
        self.kind = kind; self.text = text; self.frame = frame
        self.rangeStart = rangeStart; self.rangeLength = rangeLength
    }
}

/// UTF-16 ranges match AX CFRange semantics even for emoji and non-ASCII text.
public enum ObservationTextSegmentation {
    public struct Span: Equatable {
        public let kind: String
        public let text: String
        public let start: Int
        public let length: Int
    }
    public static func spans(_ text: String, limit: Int) -> [Span] {
        guard limit > 0 else { return [] }
        var result: [Span] = []
        for (options, kind) in [(String.EnumerationOptions.byParagraphs, "paragraph"), (.bySentences, "sentence")] {
            text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: options) { substring, range, _, stop in
                guard let substring, !substring.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                let nsRange = NSRange(range, in: text)
                result.append(Span(kind: kind, text: ForegroundObserver.boundedBytes(substring, limit: 160).value, start: nsRange.location, length: nsRange.length))
                if result.count >= (kind == "paragraph" ? max(1, limit / 2) : limit) { stop = true }
            }
            if result.count >= limit { break }
        }
        return result
    }
}
