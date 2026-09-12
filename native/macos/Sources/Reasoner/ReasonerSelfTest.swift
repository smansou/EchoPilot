import Foundation

/// Deterministic self-test for the native half of M02. It runs without model weights, a download,
/// or a network: a tiny bundle directory exercises the tokenizer, the bounded-context assembler and
/// the stdio worker hand-in-hand, so the parts the TypeScript oracle cannot see are still checked.
///
/// Run with:  ECHOPILOT_REASONER_SELFTEST=1 ./echopilot-reasoner
public enum ReasonerSelfTest {
    public static func run() -> Int32 {
        Checker().run()
    }
}

private final class Checker {
    private var failures: [String] = []

    func run() -> Int32 {
        guard let root = makeTemporaryDirectory() else {
            FileHandle.standardError.write(Data("selftest: cannot create a temporary directory\n".utf8))
            return 1
        }
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            try checkTokenizer(root: root)
            try checkBundleLoading(root: root)
            try checkAssembledContextAndWorker(root: root)
        } catch {
            failures.append("unexpected error: \(error)")
        }
        for line in failures {
            FileHandle.standardError.write(Data("selftest FAIL: \(line)\n".utf8))
        }
        guard failures.isEmpty else { return 1 }
        FileHandle.standardOutput.write(
            Data("selftest ok: tokenizer, bundle loading, bounded context and worker\n".utf8)
        )
        return 0
    }

    private func check(_ label: String, _ condition: Bool) {
        if condition {
            FileHandle.standardOutput.write(Data("selftest ok: \(label)\n".utf8))
        } else {
            failures.append(label)
        }
    }

    private func makeTemporaryDirectory() -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("echopilot-reasoner-selftest-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        } catch {
            return nil
        }
    }

    /// A toy vocabulary whose merge ranks make "abc" and its space-led twin single tokens.
    private func tokenizerJSON(merges: String) -> String {
        """
        {
          "version": "1.0",
          "model": {"type": "BPE", "vocab": {"a": 0, "b": 1, "c": 2, "ab": 3, "abc": 4, "Ġ": 5,
                     "Ġa": 6, "Ġab": 7, "Ġabc": 8, "Ċ": 9}, "merges": \(merges)},
          "pre_tokenizer": {"type": "Sequence", "pretokenizers": [
            {"type": "Split", "pattern": {"Regex": "\\\\s*\\\\p{L}+"}, "behavior": "Isolated"},
            {"type": "ByteLevel", "add_prefix_space": false}
          ]}
        }
        """
    }

    private func manifestJSON() -> String {
        """
        {"id":"qwen3.5-4b-q4","displayName":"Qwen3.5-4B (4-bit)","parameterCountBillion":4.0,
         "quantization":"q4","contextCapacity":32768,"visionPatchSize":28,
         "weights":"weights/model.safetensors","tokenizer":"tokenizer.json"}
        """
    }

    private func write(_ text: String, to url: URL) throws {
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func checkTokenizer(root: URL) throws {
        let legacyURL = root.appendingPathComponent("tokenizer-legacy.json")
        let pairsURL = root.appendingPathComponent("tokenizer-pairs.json")
        try write(
            tokenizerJSON(merges: #"["Ġ a","Ġa b","Ġab c","a b","ab c"]"#),
            to: legacyURL
        )
        try write(
            tokenizerJSON(merges: #"[["Ġ","a"],["Ġa","b"],["Ġab","c"],["a","b"],["ab","c"]]"#),
            to: pairsURL
        )
        let legacy = try Qwen35Tokenizer(contentsOf: legacyURL)
        let pairs = try Qwen35Tokenizer(contentsOf: pairsURL)
        check("tokenizer reads the bundle vocabulary", legacy.size == 10)
        check("legacy string merges count like the model (abc abc = 2)", legacy.count("abc abc") == 2)
        check("array merges count identically (abc abc = 2)", pairs.count("abc abc") == 2)
        check("a newline is charged, not dropped (a\\nb = 3)", legacy.count("a\nb") == 3)
        check("whitespace-only text is not free", legacy.count(" ") > 0)
        check("empty text costs nothing", legacy.count("") == 0)

        let brokenURL = root.appendingPathComponent("tokenizer-broken.json")
        try write(#"{"model":{"vocab":["a","b"],"merges":[123]}}"#, to: brokenURL)
        do {
            _ = try Qwen35Tokenizer(contentsOf: brokenURL)
            check("a broken merges table is rejected", false)
        } catch let ReasonerContractError.invalidTokenizer(_, reason) {
            check("a broken merges table is rejected", !reason.isEmpty)
        }
    }

    /// A bundle whose tokenizer.json exists but cannot be parsed must fail loudly, never fall back
    /// to whitespace counting behind the caller's back.
    private func checkBundleLoading(root: URL) throws {
        let pairsURL = root.appendingPathComponent("tokenizer-pairs.json")
        let backend = ScriptedStandInBackend(replies: [:], fallback: "{}")

        let brokenURL = root.appendingPathComponent("bundle-broken")
        try FileManager.default.createDirectory(at: brokenURL, withIntermediateDirectories: true)
        try write(manifestJSON(), to: brokenURL.appendingPathComponent("model.json"))
        try write(#"{"model":{"vocab":["a","b"],"merges":"not a table"}}"#, to: brokenURL.appendingPathComponent("tokenizer.json"))
        do {
            _ = try Qwen35Bundle.load(at: brokenURL, backend: backend)
            check("an unparseable tokenizer.json is never replaced by a fixture counter", false)
        } catch {
            check("an unparseable tokenizer.json is never replaced by a fixture counter", true)
        }

        let goodURL = root.appendingPathComponent("bundle-good")
        try FileManager.default.createDirectory(at: goodURL, withIntermediateDirectories: true)
        try write(manifestJSON(), to: goodURL.appendingPathComponent("model.json"))
        try Data(contentsOf: pairsURL).write(to: goodURL.appendingPathComponent("tokenizer.json"))
        let bundle = try Qwen35Bundle.load(at: goodURL, backend: backend)
        check("a loadable bundle keeps the real tokenizer", bundle.tokenizer is Qwen35Tokenizer)
        check(
            "the bundle budget is B = min(8192, C/4)",
            bundle.budget.ceiling == 8192 && bundle.budget.outputReservation == 2048 && bundle.budget.input == 6144
        )

        let standInURL = root.appendingPathComponent("bundle-standin")
        try FileManager.default.createDirectory(at: standInURL, withIntermediateDirectories: true)
        try write(manifestJSON(), to: standInURL.appendingPathComponent("model.json"))
        let standIn = try Qwen35Bundle.load(at: standInURL, backend: backend)
        check(
            "a stand-in bundle without tokenizer.json uses the fixture counter",
            standIn.tokenizer is ScriptedFixtureTokenizer
        )
    }

    private func checkAssembledContextAndWorker(root: URL) throws {
        let tokenizer = try Qwen35Tokenizer(contentsOf: root.appendingPathComponent("tokenizer-pairs.json"))
        let assembler = ContextAssembler(tokenizer: tokenizer, imageProcessor: Qwen35VisionProcessor())
        let assembled = try assembler.assemble(AssembleRequest(
            model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 32768),
            instruction: "Extract memory from the bounded segment.",
            request: "Extract the decision recorded in the segment abc.",
            card: "Project card: abc abc.",
            evidence: [EvidenceItem(id: "evt-1", text: "The decision abc abc was recorded.")],
            images: [ImageDescriptor(id: "shot-1", width: 896, height: 896)],
            tools: [ToolDescriptor(name: "memory_query", schema: .object(["text": .string("abc abc")]))]
        ))
        check("an admitted image is charged with the processor calculation", assembled.accounting.images == 32 * 32)
        check(
            "the charged image is transmitted with the context",
            assembled.images == [AdmittedImage(id: "shot-1", width: 896, height: 896, tokens: 1024)]
        )
        check("accounting sums to totalTokens", assembled.accounting.total == assembled.totalTokens)
        check(
            "totalTokens is input plus the output reservation",
            assembled.totalTokens == assembled.inputTokens + assembled.outputReservation
        )
        check("the exact prompt fits the accounted input", tokenizer.count(assembled.prompt) <= assembled.inputTokens)
        check("the request stays inside B", assembled.totalTokens <= assembled.maxTokens)
        check("a healthy assembly keeps complete coverage", assembled.coverage == .complete)
        try assembled.verify(against: BoundedBudget(
            model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 32768)
        ))

        let reply = #"{"decisions":[],"facts":[],"summary":"abc abc"}"#
        let bundle = try Qwen35Bundle(
            manifest: .bundled,
            tokenizer: tokenizer,
            imageProcessor: Qwen35VisionProcessor(),
            backend: ScriptedStandInBackend(replies: ["memory.extraction.t1": reply], fallback: reply)
        )
        let worker = ReasonerWorker(bundle: bundle)
        let contextJSON = String(data: try JSONEncoder().encode(assembled), encoding: .utf8) ?? "{}"
        let requestLine = """
        {"task":{"taskId":"memory.extraction.t1","instruction":"extract"},"context":\(contextJSON),\
        "outputSchema":{"title":"memory.extraction","type":"object"}}
        """
        let response = worker.handle(line: requestLine)
        check("the worker accepts a grounded extraction reply", response.status == ReasonerResponse.ok)
        check("the worker reports the bounded accounting", response.totalTokens == assembled.totalTokens)
        let refused = worker.handle(line: requestLine.replacingOccurrences(of: "memory.extraction", with: "memory.unknown"))
        check("an unexpected schema is refused", refused.status == ReasonerResponse.failed)
        check("a refusal marks coverage partial", refused.coverage == .partial)
    }
}
