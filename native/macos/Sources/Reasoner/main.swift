import Foundation

/// EchoPilot bundled Reasoner worker (M02): Qwen3.5-4B served behind the F01 contract over stdio.
///
///   ECHOPILOT_QWEN35_BUNDLE  bundle directory (model.json + tokenizer.json + weights)
///   ECHOPILOT_REASONER_SCRIPT  optional scripted stand-in replies (no weights required)
///
/// One JSON request per line in, one JSON response per line out. The process never exits on a
/// failed model call: it reports `status:"failed"` with `partial` coverage so the caller applies
/// its deterministic, evidence-backed template.

func makeWorker(environment: [String: String]) -> Result<ReasonerWorker, ReasonerContractError> {
    let scriptPath = environment["ECHOPILOT_REASONER_SCRIPT"]
    let bundlePath = environment["ECHOPILOT_QWEN35_BUNDLE"]
    if let scriptPath, !scriptPath.isEmpty {
        guard let backend = try? ScriptedStandInBackend.load(from: URL(fileURLWithPath: scriptPath)) else {
            return .failure(.missingBundle(path: scriptPath))
        }
        if let bundlePath, !bundlePath.isEmpty, FileManager.default.fileExists(atPath: bundlePath) {
            guard let bundle = try? Qwen35Bundle.load(at: URL(fileURLWithPath: bundlePath), backend: backend) else {
                return .failure(.missingBundle(path: bundlePath))
            }
            return .success(ReasonerWorker(bundle: bundle))
        }
        guard let bundle = try? Qwen35Bundle(
            manifest: .bundled, tokenizer: ScriptedFixtureTokenizer(),
            imageProcessor: Qwen35VisionProcessor(), backend: backend
        ) else {
            return .failure(.missingTokenizer(path: scriptPath))
        }
        return .success(ReasonerWorker(bundle: bundle))
    }
    guard let bundlePath, !bundlePath.isEmpty else {
        return .failure(.missingBundle(path: "ECHOPILOT_QWEN35_BUNDLE is not set"))
    }
    do {
        let bundle = try Qwen35Bundle.load(at: URL(fileURLWithPath: bundlePath))
        return .success(ReasonerWorker(bundle: bundle))
    } catch let error as ReasonerContractError {
        return .failure(error)
    } catch {
        return .failure(.missingBundle(path: bundlePath))
    }
}

let environment = ProcessInfo.processInfo.environment
let worker: ReasonerWorker
switch makeWorker(environment: environment) {
case .success(let ready):
    worker = ready
    FileHandle.standardError.write(Data("echopilot-reasoner ready: \(ready.budgetDescription)\n".utf8))
case .failure(let error):
    FileHandle.standardError.write(Data("echopilot-reasoner cannot start: \(error)\n".utf8))
    exit(2)
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    if trimmed == "quit" { break }
    let response = worker.handle(line: trimmed)
    FileHandle.standardOutput.write(Data((response.jsonLine() + "\n").utf8))
}
