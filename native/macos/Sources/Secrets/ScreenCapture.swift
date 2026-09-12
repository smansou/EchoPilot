import Foundation

/// The `capture.screen` capability backing the kernel's fake/local capture operation.
enum ScreenCapture {
    static func capture(params: [String: Any]) throws -> [String: Any] {
        let requestId = (params["requestId"] as? String) ?? UUID().uuidString
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("echopilot-captures", isDirectory: true)
        let url = directory
            .appendingPathComponent(SanitizedFileName.from(requestId))
            .appendingPathExtension("png")

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url)
        }

        // `screencapture` keeps this helper's capture path working without private API, and it only
        // ever sees a synthetic output path: no secret is handed to it.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-t", "png", url.path]
        let diagnostics = Pipe()
        process.standardError = diagnostics
        do {
            try process.run()
        } catch {
            throw HelperError.capture("could not start screencapture: \(error)")
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = diagnostics.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw HelperError.capture(detail.isEmpty ? "screencapture exited with status \(process.terminationStatus)" : detail)
        }

        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        return ["artifactRef": "file://\(url.path)", "bytes": size]
    }
}

enum SanitizedFileName {
    static func from(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let scalars = value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let name = String(scalars)
        return name.isEmpty ? UUID().uuidString : name
    }
}
