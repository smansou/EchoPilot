import Foundation

/// Exact counting is a contract, not an estimate: every admitted section is measured with the
/// bundled tokenizer, and a bundle without a tokenizer refuses to serve requests at all.
public protocol TokenCounting: Sendable {
    func count(_ text: String) -> Int
}

/// Byte-pair tokenizer for the bundled Qwen3.5 vocabulary (`vocab` + `merges` from tokenizer.json).
/// Counting uses the same merges the model uses, so the accounting the caller sees is the model's.
public struct Qwen35Tokenizer: TokenCounting, @unchecked Sendable {
    private let ranks: [String: Int]
    private let vocabularySize: Int

    public init(vocab: [String], merges: [String]) {
        var ranks: [String: Int] = [:]
        for (index, merge) in merges.enumerated() {
            ranks[merge] = index
        }
        self.ranks = ranks
        self.vocabularySize = vocab.count
    }

    public init(contentsOf url: URL) throws {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ReasonerContractError.missingTokenizer(path: url.path)
        }
        let vocab = (root["vocab"] as? [String]) ?? (root["model"] as? [String: Any])?["vocab"] as? [String] ?? []
        let merges = (root["merges"] as? [String]) ?? []
        guard !vocab.isEmpty, !merges.isEmpty else {
            throw ReasonerContractError.missingTokenizer(path: url.path)
        }
        self.init(vocab: vocab, merges: merges)
    }

    public func count(_ text: String) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0 }
        var total = 0
        for word in trimmed.split(whereSeparator: { $0.isWhitespace }) {
            total += encode(Array(word)).count
        }
        return total
    }

    public var size: Int { vocabularySize }

    private func encode(_ characters: [Character]) -> [String] {
        var parts = characters.map(String.init)
        guard parts.count > 1 else { return parts }
        while true {
            var bestRank = Int.max
            var bestIndex = -1
            for index in 0..<(parts.count - 1) {
                let merged = parts[index] + parts[index + 1]
                if let rank = ranks[merged], rank < bestRank {
                    bestRank = rank
                    bestIndex = index
                }
            }
            if bestIndex < 0 { break }
            parts.replaceSubrange(bestIndex...(bestIndex + 1), with: [parts[bestIndex] + parts[bestIndex + 1]])
        }
        return parts
    }
}

/// Whitespace counting used only by the scripted stand-in path, mirroring the fixture stand-in the
/// M02 acceptance test supplies through the same seam. Production bundles always use Qwen35Tokenizer.
public struct ScriptedFixtureTokenizer: TokenCounting {
    public init() {}

    public func count(_ text: String) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0 }
        return trimmed.split(whereSeparator: { $0.isWhitespace }).count
    }
}
