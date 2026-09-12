import Foundation

/// Exact counting is a contract, not an estimate: every admitted section is measured with the
/// bundled tokenizer, and a bundle without a usable tokenizer refuses to serve requests at all.
public protocol TokenCounting: Sendable {
    func count(_ text: String) -> Int
}

/// Byte-pair tokenizer for the bundled Qwen3.5 vocabulary.
///
/// The count is the model's own count, so whitespace and newlines are charged the way the model
/// charges them:
///
///  * the vocabulary and merge table are read from `tokenizer.json`; both the legacy string form
///    (`"Ġ t"`) and the newer pair form (`["Ġ", "t"]`) are supported;
///  * merges are keyed by the exact pair of tokens, so a rank is only applied to the pair the
///    merge table lists (a re-joined string can never match);
///  * the pre-tokenizer split pattern from the bundle is applied when present, and every chunk is
///    byte-level encoded (space -> `Ġ`, newline -> `Ċ`) before merging, exactly like the model's
///    ByteLevel pre-tokenizer.
public struct Qwen35Tokenizer: TokenCounting, @unchecked Sendable {
    /// The exact pair key of a merge: `left` and `right` are the two token strings, never a
    /// re-joined string that could collide with a different pair.
    private struct MergeKey: Hashable {
        let left: String
        let right: String
    }

    private let ranks: [MergeKey: Int]
    private let vocabularySize: Int
    private let splitRegex: NSRegularExpression?

    public init(vocab: [String], merges: [String]) throws {
        try self.init(
            vocabularySize: vocab.count,
            mergePairs: Qwen35Tokenizer.mergePairs(from: merges, path: "tokenizer.json"),
            splitPattern: nil
        )
    }

    public init(
        vocabularySize: Int,
        mergePairs: [(left: String, right: String)],
        splitPattern: String?
    ) throws {
        var ranks: [MergeKey: Int] = [:]
        ranks.reserveCapacity(mergePairs.count)
        for (index, pair) in mergePairs.enumerated() {
            ranks[MergeKey(left: pair.left, right: pair.right)] = index
        }
        self.ranks = ranks
        self.vocabularySize = vocabularySize
        if let splitPattern, !splitPattern.isEmpty {
            guard let regex = try? NSRegularExpression(pattern: splitPattern) else {
                throw ReasonerContractError.invalidTokenizer(
                    path: "tokenizer.json",
                    reason: "pre_tokenizer pattern is not a usable regex"
                )
            }
            self.splitRegex = regex
        } else {
            self.splitRegex = nil
        }
    }

    public init(contentsOf url: URL) throws {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ReasonerContractError.missingTokenizer(path: url.path)
        }
        let model = root["model"] as? [String: Any]
        // A real tokenizer.json stores the vocabulary as a token -> id object; the array form is
        // accepted too so a compacted bundle can carry the same information.
        let vocabularySize = (model?["vocab"] as? [String: Any])?.count
            ?? (root["vocab"] as? [String: Any])?.count
            ?? (model?["vocab"] as? [String])?.count
            ?? (root["vocab"] as? [String])?.count
            ?? 0
        guard vocabularySize > 0 else {
            throw ReasonerContractError.missingTokenizer(path: url.path)
        }
        let mergesValue = root["merges"] ?? model?["merges"]
        let pairs = try Qwen35Tokenizer.mergePairs(from: mergesValue, path: url.path)
        guard !pairs.isEmpty else {
            throw ReasonerContractError.missingTokenizer(path: url.path)
        }
        try self.init(
            vocabularySize: vocabularySize,
            mergePairs: pairs,
            splitPattern: Qwen35Tokenizer.splitPattern(in: root["pre_tokenizer"])
        )
    }

    public func count(_ text: String) -> Int {
        guard !text.isEmpty else { return 0 }
        var total = 0
        for chunk in chunks(of: text) {
            total += encode(byteLevelEncode(chunk)).count
        }
        return total
    }

    public var size: Int { vocabularySize }

    /// BPE merges over the byte-level characters of one pre-tokenized chunk.
    private func encode(_ chunk: String) -> [String] {
        var parts = chunk.map(String.init)
        guard parts.count > 1 else { return parts }
        while true {
            var bestRank = Int.max
            var bestIndex = -1
            for index in 0..<(parts.count - 1) {
                let key = MergeKey(left: parts[index], right: parts[index + 1])
                if let rank = ranks[key], rank < bestRank {
                    bestRank = rank
                    bestIndex = index
                }
            }
            if bestIndex < 0 { break }
            parts.replaceSubrange(bestIndex...(bestIndex + 1), with: [parts[bestIndex] + parts[bestIndex + 1]])
        }
        return parts
    }

    private func chunks(of text: String) -> [String] {
        if let splitRegex {
            let fullRange = NSRange(text.startIndex..<text.endIndex, in: text)
            let matches = splitRegex.matches(in: text, options: [], range: fullRange)
            var chunks: [String] = []
            chunks.reserveCapacity(matches.count)
            for match in matches where match.range.length > 0 {
                if let range = Range(match.range, in: text) {
                    chunks.append(String(text[range]))
                }
            }
            if !chunks.isEmpty { return chunks }
        }
        return Qwen35Tokenizer.heuristicChunks(text)
    }

    /// Fallback chunking for bundles without a Split pre-tokenizer: whitespace leads the word that
    /// follows it and trailing whitespace forms its own chunk — the shape of the ByteLevel split.
    private static func heuristicChunks(_ text: String) -> [String] {
        var chunks: [String] = []
        var pendingWhitespace = ""
        var word = ""
        func flush() {
            let chunk = pendingWhitespace + word
            if !chunk.isEmpty { chunks.append(chunk) }
            pendingWhitespace = ""
            word = ""
        }
        for character in text {
            if character.isWhitespace {
                if !word.isEmpty { flush() }
                pendingWhitespace.append(character)
            } else {
                word.append(character)
            }
        }
        flush()
        return chunks
    }

    /// GPT-2/Qwen byte-level alphabet: printable bytes map to themselves, the rest are shifted
    /// above U+0100 in ascending byte order. `Ġ` is the space byte, `Ċ` the newline byte.
    private func byteLevelEncode(_ chunk: String) -> String {
        var encoded = ""
        encoded.reserveCapacity(chunk.utf8.count)
        for byte in chunk.utf8 {
            encoded.append(Qwen35Tokenizer.byteAlphabet[Int(byte)])
        }
        return encoded
    }

    private static let byteAlphabet: [Character] = {
        let direct = Array(33...126) + Array(161...172) + Array(174...255)
        var table = [Character](repeating: "\u{FFFD}", count: 256)
        for value in direct {
            table[value] = Character(UnicodeScalar(UInt32(value))!)
        }
        var shifted = 256
        for value in 0..<256 where !direct.contains(value) {
            table[value] = Character(UnicodeScalar(UInt32(shifted))!)
            shifted += 1
        }
        return table
    }()

    private static func mergePairs(
        from merges: [String],
        path: String
    ) throws -> [(left: String, right: String)] {
        var pairs: [(left: String, right: String)] = []
        pairs.reserveCapacity(merges.count)
        for line in merges {
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else {
                throw ReasonerContractError.invalidTokenizer(
                    path: path,
                    reason: "merge entry \(line.debugDescription) is not a pair"
                )
            }
            pairs.append((left: String(parts[0]), right: String(parts[1])))
        }
        return pairs
    }

    private static func mergePairs(
        from value: Any?,
        path: String
    ) throws -> [(left: String, right: String)] {
        guard let list = value as? [Any], !list.isEmpty else {
            throw ReasonerContractError.invalidTokenizer(path: path, reason: "no merges table")
        }
        var pairs: [(left: String, right: String)] = []
        pairs.reserveCapacity(list.count)
        for entry in list {
            if let line = entry as? String {
                pairs.append(contentsOf: try mergePairs(from: [line], path: path))
                continue
            }
            guard let pair = entry as? [Any],
                  pair.count == 2,
                  let left = pair[0] as? String,
                  let right = pair[1] as? String,
                  !left.isEmpty,
                  !right.isEmpty else {
                throw ReasonerContractError.invalidTokenizer(
                    path: path,
                    reason: "merge entry \(String(describing: entry)) is not a token pair"
                )
            }
            pairs.append((left: left, right: right))
        }
        return pairs
    }

    /// The bundle's own Split pre-tokenizer pattern (`{"Regex": "..."}` or `{"String": "..."}`).
    private static func splitPattern(in node: Any?, depth: Int = 0) -> String? {
        guard depth < 8 else { return nil }
        if let object = node as? [String: Any] {
            if (object["type"] as? String) == "Split" {
                if let pattern = object["pattern"] as? [String: Any] {
                    if let regex = pattern["Regex"] as? String { return regex }
                    if let literal = pattern["String"] as? String { return NSRegularExpression.escapedPattern(for: literal) }
                }
                if let regex = object["pattern"] as? String { return regex }
            }
            if let children = object["pretokenizers"] as? [Any] {
                for child in children {
                    if let found = splitPattern(in: child, depth: depth + 1) { return found }
                }
            }
            if let child = object["pretokenizer"] {
                if let found = splitPattern(in: child, depth: depth + 1) { return found }
            }
        }
        if let children = node as? [Any] {
            for child in children {
                if let found = splitPattern(in: child, depth: depth + 1) { return found }
            }
        }
        return nil
    }
}

/// Whitespace counting used only by the scripted stand-in path, mirroring the fixture stand-in the
/// M02 acceptance test supplies through the same seam. Any bundle carrying a `tokenizer.json`
/// counts with `Qwen35Tokenizer`; this fallback exists solely for stand-in runs without one.
public struct ScriptedFixtureTokenizer: TokenCounting {
    public init() {}

    public func count(_ text: String) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0 }
        return trimmed.split(whereSeparator: { $0.isWhitespace }).count
    }
}
