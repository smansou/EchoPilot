import AppKit
import ScreenCaptureKit
import Vision

/// Optional local fallback. Captures only the explicitly shared foreground window in memory;
/// never prompts for permission, saves an image, takes focus, or calls a network provider.
public enum LocalWindowOCR {
    public static func enrich(_ evidence: ForegroundEvidence) -> ForegroundEvidence {
        guard #available(macOS 14.0, *), CGPreflightScreenCaptureAccess(),
              eligible(evidence),
              let frame = evidence.window.frame, stillCurrent(evidence) else { return evidence }
        guard let image = capture(pid: evidence.application.pid, frame: frame), stillCurrent(evidence) else { return evidence }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil, stillCurrent(evidence) else { return evidence }
        var nodes = evidence.nodes
        let encoder = JSONEncoder()
        for observation in (request.results ?? []).prefix(40) {
            guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.6 else { continue }
            let bounded = ForegroundObserver.boundedBytes(candidate.string, limit: 160)
            let text = bounded.value
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let box = logicalFrame(normalized: observation.boundingBox, window: frame)
            guard box.validated != nil else { continue }
            nodes.append(ForegroundEvidenceNode(depth: 1, role: "AXStaticText", subrole: "LocalOCRText",
                         label: nil, value: text, labelTruncated: false,
                         valueTruncated: bounded.truncated, redacted: false, frame: box))
            let result = copy(evidence, nodes: nodes)
            if (try? encoder.encode(result).count) ?? Int.max > 32_768 { nodes.removeLast(); break }
        }
        return copy(evidence, nodes: nodes)
    }

    /// Fail closed when a bounded AX traversal could have missed a secure subtree. Permission,
    /// current foreground identity, and image capture are separate checks in enrich().
    public static func eligible(_ evidence: ForegroundEvidence) -> Bool {
        !evidence.truncated && evidence.window.frame != nil && evidence.window.id != nil &&
        !evidence.nodes.contains(where: { $0.redacted }) &&
        !evidence.nodes.contains(where: { $0.frame != nil && ($0.label != nil || $0.value != nil || !($0.textRegions ?? []).isEmpty) })
    }

    /// Vision uses bottom-left normalized image coordinates; AX/Quartz use top-left desktop points.
    public static func logicalFrame(normalized: CGRect, window: ObservationFrame) -> ObservationFrame {
        ObservationFrame(x: window.x + normalized.minX * window.width,
                         y: window.y + (1 - normalized.maxY) * window.height,
                         width: normalized.width * window.width, height: normalized.height * window.height)
    }

    private static func copy(_ evidence: ForegroundEvidence, nodes: [ForegroundEvidenceNode]) -> ForegroundEvidence {
        ForegroundEvidence(observedAtMs: evidence.observedAtMs, projectId: evidence.projectId,
                           application: evidence.application, window: evidence.window, nodes: nodes,
                           quality: evidence.quality, truncated: evidence.truncated, truncations: evidence.truncations,
                           stats: ForegroundEvidenceStats(visitedNodes: evidence.stats.visitedNodes, emittedNodes: nodes.count,
                                  maxDepthReached: evidence.stats.maxDepthReached,
                                  estimatedBytes: (try? JSONEncoder().encode(nodes).count) ?? evidence.stats.estimatedBytes))
    }

    private static func stillCurrent(_ evidence: ForegroundEvidence) -> Bool {
        let source = SystemForegroundObservationSource()
        guard let application = source.frontmostApplication(), application.pid == evidence.application.pid,
              let app = source.applicationNode(for: application), let window = source.windowNode(ofApplicationNode: app),
              window.observationIdentity() == evidence.window.id,
              window.frame() == evidence.window.frame, window.title() == evidence.window.title else { return false }
        return true
    }

    @available(macOS 14.0, *)
    private static func capture(pid: Int32, frame: ObservationFrame) -> CGImage? {
        let contentReady = DispatchSemaphore(value: 0)
        let contentBox = LockedOCRBox<SCShareableContent>()
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
            contentBox.set(content); contentReady.signal()
        }
        guard contentReady.wait(timeout: .now() + 1) == .success, let content = contentBox.get(),
              let window = content.windows.first(where: {
                  $0.owningApplication?.processID == pid &&
                  abs($0.frame.minX - frame.x) < 2 && abs($0.frame.minY - frame.y) < 2 &&
                  abs($0.frame.width - frame.width) < 2 && abs($0.frame.height - frame.height) < 2
              }) else { return nil }
        let configuration = SCStreamConfiguration()
        // OCR at <= 1600 px width bounds local processing cost; output maps back to logical points.
        configuration.width = max(1, min(1600, Int(frame.width)))
        configuration.height = max(1, min(1600, Int(Double(configuration.width) * frame.height / frame.width)))
        configuration.showsCursor = false
        let ready = DispatchSemaphore(value: 0)
        let imageBox = LockedOCRBox<CGImage>()
        SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window),
                                       configuration: configuration) { image, _ in
            imageBox.set(image); ready.signal()
        }
        guard ready.wait(timeout: .now() + 2) == .success else { return nil }
        return imageBox.get()
    }
}

/// Callbacks can outlive a timeout; this lock makes their short-lived result storage race-free.
private final class LockedOCRBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?
    func set(_ value: Value?) { lock.lock(); defer { lock.unlock() }; self.value = value }
    func get() -> Value? { lock.lock(); defer { lock.unlock() }; return value }
}
