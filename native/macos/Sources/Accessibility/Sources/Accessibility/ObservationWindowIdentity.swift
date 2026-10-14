import Foundation

/// Metadata only: stable Quartz window numbers survive short-lived native helper processes.
/// Matching is conservative; ambiguous/missing windows produce no ID rather than a guess.
struct QuartzObservationWindow: Equatable {
    let pid: Int32
    let number: UInt32
    let frame: ObservationFrame
    let title: String?
}

enum ObservationWindowIdentity {
    static func match(pid: Int32, frame: ObservationFrame, title: String?,
                      windows: [QuartzObservationWindow], tolerance: Double = 2) -> String? {
        guard frame.validated != nil, tolerance.isFinite, tolerance >= 0 else { return nil }
        let candidates = windows.filter { window in
            guard window.pid == pid, window.number > 0, window.frame.validated != nil,
                  abs(window.frame.x - frame.x) <= tolerance,
                  abs(window.frame.y - frame.y) <= tolerance,
                  abs(window.frame.width - frame.width) <= tolerance,
                  abs(window.frame.height - frame.height) <= tolerance else { return false }
            // Quartz may omit names without Screen Recording permission. Never request it for IDs.
            if let title, !title.isEmpty, let candidateTitle = window.title, !candidateTitle.isEmpty {
                return title == candidateTitle
            }
            return true
        }
        guard candidates.count == 1, let candidate = candidates.first else { return nil }
        return "cg-\(candidate.number)"
    }
}
