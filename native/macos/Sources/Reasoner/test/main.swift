import Foundation

/**
 * M02 native acceptance oracle — owned by the test role, never by the implementer.
 *
 * Finding f-4a271ed5a779 ("the argument '--approve-for-me' cannot be used with '--sandbox
 * <SANDBOX_MODE>'") came from an oracle that re-entered an agent CLI with incompatible flags and
 * aborted before any behavioral assertion ran. This oracle starts no agent CLI and takes no
 * sandbox/approval flags: it is a plain Swift program compiled by
 * `packages/memory/src/consolidation/test/check.mjs` with `swiftc` and run directly, so that
 * failure cannot recur.
 *
 * It asserts the M02 scope the TypeScript stand-in seam cannot see, directly against the
 * production Sources/Reasoner API:
 *  * the shared budget B = min(8192, floor(0.25 * C)) with a reserved output allowance;
 *  * exact tokenizer accounting from the bundle's vocab + merges (spaces and newlines charged,
 *    malformed merges rejected instead of counted heuristically);
 *  * image-token accounting with the processor's own calculation, never zero;
 *  * the assembler's invariant (totalTokens = sum(accounting) = input + reserved output <= B) and
 *    its disclosure of deliberately failed compaction as partial coverage;
 *  * the worker's bounded accounting, schema routing and citation grounding.
 *
 * Compile (production main.swift excluded): every top-level .swift file under Sources/Reasoner
 * except main.swift, plus this file, with plain swiftc; then run the binary. Exit code 0 = all
 * checks pass.
 */

var failures: [String] = []
var passed = 0

func check(_ label: String, _ condition: Bool) {
    if condition {
        passed += 1
        print("oracle ok: \(label)")
    } else {
        failures.append(label)
        print("oracle FAIL: \(label)")
    }
}

func checkThrows(_ label: String, _ body: () throws -> Void) {
    do {
        try body()
        failures.append(label)
        print("oracle FAIL: \(label) — no error was thrown")
    } catch {
        passed += 1
        print("oracle ok: \(label)")
    }
}

func checkPasses(_ label: String, _ body: () throws -> Void) {
    do {
        try body()
        passed += 1
        print("oracle ok: \(label)")
    } catch {
        failures.append(label)
        print("oracle FAIL: \(label) — \(error)")
    }
}

let fileManager = FileManager.default
let root = fileManager.temporaryDirectory
    .appendingPathComponent("echopilot-m02-native-oracle-\(UUID().uuidString)")
try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fileManager.removeItem(at: root) }

func write(_ text: String, to url: URL) throws {
    try text.write(to: url, atomically: true, encoding: .utf8)
}

/** A toy vocabulary whose merge ranks make "abc" and its space-led twin single tokens. */
func tokenizerJSON(merges: String) -> String {
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

func manifestJSON() -> String {
    """
    {"id":"qwen3.5-4b-q4","displayName":"Qwen3.5-4B (4-bit)","parameterCountBillion":4.0,
     "quantization":"q4","contextCapacity":32768,"visionPatchSize":28,
     "weights":"weights/model.safetensors","tokenizer":"tokenizer.json"}
    """
}

do {
    // ---------------------------------------------------------------- budget
    let bundledBudget = try BoundedBudget(
        model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 32768)
    )
    check("B = min(8192, floor(0.25 * 32768)) = 8192 on the bundled route", bundledBudget.ceiling == 8192)
    check("the bundled route reserves 2,048 output tokens", bundledBudget.outputReservation == 2048)
    check(
        "input + reserved output = B",
        bundledBudget.input == 6144 && bundledBudget.input + bundledBudget.outputReservation == bundledBudget.ceiling
    )
    let smallerBudget = try BoundedBudget(
        model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 20000)
    )
    check(
        "a smaller capacity scales B and the reservation down instead of overflowing",
        smallerBudget.ceiling == 5000 && smallerBudget.outputReservation > 0
            && smallerBudget.outputReservation <= 2048
            && smallerBudget.input + smallerBudget.outputReservation == smallerBudget.ceiling
    )
    let largerBudget = try BoundedBudget(
        model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 200000)
    )
    check("a larger capacity never raises B above 8,192", largerBudget.ceiling == 8192)
    checkThrows("a model declaring capacity 0 is rejected") {
        _ = try BoundedBudget(model: ModelDescriptor(modelId: "undeclared", contextCapacity: 0))
    }
    checkThrows("a model declaring a negative capacity is rejected") {
        _ = try BoundedBudget(model: ModelDescriptor(modelId: "undeclared", contextCapacity: -1))
    }

    // ---------------------------------------------------------------- tokenizer
    let legacyURL = root.appendingPathComponent("tokenizer-legacy.json")
    let pairsURL = root.appendingPathComponent("tokenizer-pairs.json")
    try write(tokenizerJSON(merges: #"["Ġ a","Ġa b","Ġab c","a b","ab c"]"#), to: legacyURL)
    try write(tokenizerJSON(merges: #"[["Ġ","a"],["Ġa","b"],["Ġab","c"],["a","b"],["ab","c"]]"#), to: pairsURL)
    let legacyTokenizer = try Qwen35Tokenizer(contentsOf: legacyURL)
    let pairTokenizer = try Qwen35Tokenizer(contentsOf: pairsURL)
    check("the bundle vocabulary and merges are read (10 tokens)", legacyTokenizer.size == 10)
    check("legacy string merges count like the model (abc abc = 2)", legacyTokenizer.count("abc abc") == 2)
    check("pair-form merges count identically (abc abc = 2)", pairTokenizer.count("abc abc") == 2)
    check(
        "both merge encodings agree on a longer sample",
        legacyTokenizer.count("abc abc abc") == pairTokenizer.count("abc abc abc")
    )
    check("a newline is charged, not dropped (a\\nb = 3)", legacyTokenizer.count("a\nb") == 3)
    check("whitespace-only text is not free", legacyTokenizer.count(" ") > 0)
    check("empty text costs nothing", legacyTokenizer.count("") == 0)
    let brokenTokenizerURL = root.appendingPathComponent("tokenizer-broken.json")
    try write(#"{"model":{"vocab":["a","b"],"merges":[123]}}"#, to: brokenTokenizerURL)
    checkThrows("a malformed merges table is rejected instead of counted heuristically") {
        _ = try Qwen35Tokenizer(contentsOf: brokenTokenizerURL)
    }

    // ---------------------------------------------------------------- bundle loading
    let bundleURL = root.appendingPathComponent("bundle")
    try fileManager.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    try write(manifestJSON(), to: bundleURL.appendingPathComponent("model.json"))
    try write(tokenizerJSON(merges: #"["Ġ a","Ġa b","Ġab c","a b","ab c"]"#), to: bundleURL.appendingPathComponent("tokenizer.json"))
    let standIn = ScriptedStandInBackend(replies: [:], fallback: "{}")
    let loadedBundle = try Qwen35Bundle.load(at: bundleURL, backend: standIn)
    check("a loadable bundle keeps the exact tokenizer (abc abc = 2)", loadedBundle.tokenizer.count("abc abc") == 2)
    check("the loaded bundle keeps B = 8192", loadedBundle.budget.ceiling == 8192)
    let brokenBundleURL = root.appendingPathComponent("bundle-broken")
    try fileManager.createDirectory(at: brokenBundleURL, withIntermediateDirectories: true)
    try write(manifestJSON(), to: brokenBundleURL.appendingPathComponent("model.json"))
    try write(#"{"model":{"vocab":["a","b"],"merges":[123]}}"#, to: brokenBundleURL.appendingPathComponent("tokenizer.json"))
    checkThrows("an unparseable bundle tokenizer is never replaced by a forgiving counter") {
        _ = try Qwen35Bundle.load(at: brokenBundleURL, backend: ScriptedStandInBackend(replies: [:], fallback: "{}"))
    }

    // ---------------------------------------------------------------- image accounting
    let vision = Qwen35VisionProcessor()
    check(
        "the processor charges ceil(w/28) * ceil(h/28) (896x896 = 1024)",
        (try? vision.imageTokens(width: 896, height: 896)) == 1024
    )
    check("a tiny image is never charged zero tokens (1x1 = 1)", (try? vision.imageTokens(width: 1, height: 1)) == 1)
    checkThrows("an image with no positive dimensions is rejected") {
        _ = try vision.imageTokens(width: 0, height: 10)
    }

    // ---------------------------------------------------------------- assembler invariant
    let assembler = ContextAssembler(tokenizer: legacyTokenizer, imageProcessor: vision)
    let assemblerBudget = loadedBundle.budget
    let cannedEvidence = EvidenceItem(
        id: "evt-atlas-decision-004",
        text: "Atlas decision: one encrypted database per project. Canary echopilotm02atlasdecision9d4c1e."
    )
    let assembled = try assembler.assemble(AssembleRequest(
        model: loadedBundle.model,
        instruction: "System policy and tool schemas for one Atlas memory request.",
        request: "What did we decide on 2026-09-08 about where Atlas keeps durable project memory?",
        card: "Project card: Atlas keeps one encrypted database per project.",
        evidence: [cannedEvidence],
        images: [ImageDescriptor(id: "artifact-atlas-screen", width: 896, height: 896)],
        tools: [ToolDescriptor(name: "memory_query", schema: .object(["type": .string("object")]))]
    ))
    check("accounting sums to totalTokens", assembled.totalTokens == assembled.accounting.total)
    check(
        "totalTokens is the counted input plus the reserved output allowance",
        assembled.totalTokens == assembled.inputTokens + assembled.outputReservation
    )
    check("totalTokens never exceeds B", assembled.totalTokens <= assembled.maxTokens && assembled.maxTokens <= 8192)
    check("the input stays inside the input cap", assembled.inputTokens <= assemblerBudget.input)
    check(
        "the output allowance is reserved, never zero",
        assembled.outputReservation == assemblerBudget.outputReservation && assembled.outputReservation > 0
    )
    check(
        "the admitted image is charged with the processor calculation and travels with the request",
        assembled.accounting.images == 1024 && assembled.images.count == 1 && assembled.images.first?.tokens == 1024
    )
    check("the exact prompt documents the image it transmits", assembled.prompt.contains("artifact-atlas-screen"))
    check(
        "a tool schema is charged with its call wrapper, not only the raw schema",
        assembled.accounting.tools > legacyTokenizer.count(#"{"type":"object"}"#)
            && assembled.prompt.contains("Tool memory_query: ")
    )
    check("formatting overhead is measured, not assumed", assembled.accounting.reserve > 0)
    check("the exact prompt fits the accounted input", legacyTokenizer.count(assembled.prompt) <= assembled.inputTokens)
    check("a healthy assembly keeps complete coverage", assembled.coverage == .complete)
    checkPasses("the assembled context verifies against the bundle budget") {
        try assembled.verify(against: assemblerBudget)
    }

    let dialogue = (0..<60).map { index in
        DialogueItem(
            id: "dialogue-\(index)",
            text: "dialogue-marker-\(String(format: "%03d", index)) "
                + String(repeating: "recent committed dialogue token ", count: 20)
        )
    }
    let smallBudget = try BoundedBudget(model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 20000))
    let failedCompaction = try assembler.assemble(AssembleRequest(
        model: ModelDescriptor(modelId: "qwen3.5-4b-q4", contextCapacity: 20000),
        instruction: "Extract structured memory.",
        request: "Extract the segment.",
        card: "Deterministic card: the decision canary.",
        dialogue: dialogue,
        evidence: [EvidenceItem(id: "evt-1", text: "evidence text")],
        tools: [ToolDescriptor(name: "memory_query", schema: .object(["type": .string("object")]))],
        compactDialogue: { _ in throw ReasonerContractError.modelFailure(message: "deliberately failed compaction") }
    ))
    check(
        "a deliberately failed compaction still returns an exactly measured context",
        failedCompaction.totalTokens == failedCompaction.accounting.total
            && failedCompaction.totalTokens == failedCompaction.inputTokens + failedCompaction.outputReservation
            && failedCompaction.totalTokens <= failedCompaction.maxTokens
    )
    check("a deliberately failed compaction is disclosed as partial coverage", failedCompaction.coverage == .partial)
    check("failed compaction keeps the deterministic card", failedCompaction.prompt.contains("Deterministic card: the decision canary."))
    check(
        "failed compaction drops the unadmitted dialogue instead of stuffing it",
        failedCompaction.accounting.dialogue == 0 && !failedCompaction.prompt.contains("dialogue-marker-000")
    )
    checkPasses("the partial context still verifies against its own budget") {
        try failedCompaction.verify(against: smallBudget)
    }

    // ---------------------------------------------------------------- worker
    let workerBundle = try Qwen35Bundle(
        manifest: .bundled,
        tokenizer: legacyTokenizer,
        imageProcessor: vision,
        backend: ScriptedStandInBackend(
            replies: [
                "job-extract": #"{"decisions":[{"question":"Where does Atlas keep durable project memory?","choice":"One encrypted database per project, with the profile registry stored separately.","sourceEventIds":["evt-atlas-decision-004"]}],"facts":[],"summary":"Grounded Atlas segment."}"#,
                "job-answer": #"{"text":"On 2026-09-08 Atlas decided: one encrypted database per project.","evidenceIds":["evt-atlas-decision-004"]}"#,
                "job-fabricate": #"{"text":"Fabricated answer.","evidenceIds":["evt-fabricated-999"]}"#,
            ],
            fallback: "{}",
            faults: ["job-crash"]
        )
    )
    let worker = ReasonerWorker(bundle: workerBundle)
    let workerAssembler = ContextAssembler(tokenizer: workerBundle.tokenizer, imageProcessor: vision)
    let extractionContext = try workerAssembler.assemble(AssembleRequest(
        model: workerBundle.model,
        instruction: "Extract structured memory from the segment.",
        request: "Extract the segment.",
        card: "Project card: Atlas keeps one encrypted database per project.",
        evidence: [cannedEvidence]
    ))
    let extraction = worker.handle(ReasonerRequest(
        task: ReasoningTask(taskId: "job-extract", instruction: "Extract structured memory from the segment."),
        context: extractionContext,
        outputSchema: OutputSchema(title: OutputSchema.memoryExtraction)
    ))
    check(
        "the worker accepts a grounded extraction reply",
        extraction.status == ReasonerResponse.ok && extraction.coverage == .complete
    )
    check(
        "the worker reports the bounded accounting it enforced",
        extraction.totalTokens == extractionContext.totalTokens
            && extraction.maxTokens == extractionContext.maxTokens
            && extraction.totalTokens <= extraction.maxTokens
            && extraction.outputReservation > 0
    )
    check(
        "the worker echoes exactly the evidence ids it presented",
        extraction.evidenceIds == extractionContext.evidenceIds
            && extraction.evidenceIds == ["evt-atlas-decision-004"]
    )
    check(
        "the accepted reply stays structured JSON, not raw model text",
        extraction.output?.objectValue?["decisions"]?.arrayValue?.isEmpty == false
    )
    let refusedSchema = worker.handle(ReasonerRequest(
        task: ReasoningTask(taskId: "job-extract", instruction: "Extract structured memory."),
        context: extractionContext,
        outputSchema: OutputSchema(title: "memory.unexpected")
    ))
    check(
        "an unexpected output schema is refused as a failed, partial job",
        refusedSchema.status == ReasonerResponse.failed && refusedSchema.coverage == .partial
            && (refusedSchema.error ?? "").contains("schema")
    )

    let answerContext = try workerAssembler.assemble(AssembleRequest(
        model: workerBundle.model,
        instruction: "Answer the dated question from the bounded evidence only.",
        request: "What did we decide on 2026-09-08 about where Atlas keeps durable project memory?",
        card: "Project card: Atlas keeps one encrypted database per project.",
        evidence: [cannedEvidence]
    ))
    func answerRequest(_ taskId: String) -> ReasonerRequest {
        ReasonerRequest(
            task: ReasoningTask(taskId: taskId, instruction: "Answer the dated project question."),
            context: answerContext,
            outputSchema: OutputSchema(title: OutputSchema.memoryAnswer)
        )
    }
    let grounded = worker.handle(answerRequest("job-answer"))
    check(
        "a grounded answer is accepted within the reserved output allowance",
        grounded.status == ReasonerResponse.ok && grounded.coverage == .complete
    )
    let fabricated = worker.handle(answerRequest("job-fabricate"))
    check(
        "an answer citing evidence that was never presented is refused",
        fabricated.status == ReasonerResponse.failed && fabricated.coverage == .partial
            && (fabricated.error ?? "").contains("never presented")
    )
    let crashed = worker.handle(answerRequest("job-crash"))
    check(
        "a model crash is reported as failed with partial coverage",
        crashed.status == ReasonerResponse.failed && crashed.coverage == .partial
    )

    let unbounded = AssembledContext(
        modelId: workerBundle.manifest.id,
        maxTokens: BoundedBudget.contextCeilingTokens * 2,
        outputReservation: 2048,
        inputTokens: 100,
        totalTokens: 2148,
        accounting: ContextAccounting(
            system: 100, request: 0, cards: 0, dialogue: 0,
            evidence: 0, images: 0, tools: 0, reserve: 0, output: 2048
        ),
        evidenceIds: ["evt-atlas-decision-004"],
        images: [],
        prompt: "[evidence]\nAtlas decision.",
        coverage: .complete
    )
    let unboundedRefusal = worker.handle(ReasonerRequest(
        task: ReasoningTask(taskId: "job-unbounded", instruction: "Extract structured memory."),
        context: unbounded,
        outputSchema: OutputSchema(title: OutputSchema.memoryExtraction)
    ))
    check(
        "a context whose maxTokens exceeds B is refused before the model runs",
        unboundedRefusal.status == ReasonerResponse.failed && unboundedRefusal.coverage == .partial
            && (unboundedRefusal.error ?? "").contains("outside B")
    )
} catch {
    failures.append("unexpected error: \(error)")
    print("oracle FAIL: unexpected error: \(error)")
}

if failures.isEmpty {
    print("M02 native oracle ok: \(passed) checks passed")
    exit(0)
} else {
    FileHandle.standardError.write(Data("M02 native oracle FAIL: \(failures.count) check(s)\n".utf8))
    for failure in failures {
        FileHandle.standardError.write(Data("  - \(failure)\n".utf8))
    }
    exit(1)
}
