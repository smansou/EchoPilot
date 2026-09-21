import Audio
import Foundation

/// The signed helper's standby half: microphone lifecycle, energy sampling and the acoustic
/// windows the widget's false-trigger report is built from.
///
/// The desktop app drives this with `voice-command` frames on the helper's private stdin and
/// consumes the `voice-ack` / `voice-observation` frames this type emits. Every number is measured:
/// the energy readings are `proc_pid_rusage` deltas for this process (CPU time, physical footprint
/// and the wakeups macOS charged to it) and each acoustic window is scored from the 16 kHz packets
/// `MicrophoneGraph` actually captured. A standby loop that wakes faster than the budget allows
/// therefore produces a real violation, in the same frame the app's activation lifecycle consumes.
///
/// A wake window is attention, never authorization: the observation carries a detection flag and a
/// confidence, and the app's `ConversationActivationController` decides whether an *enabled*
/// standby session reopens the conversation. Nothing in this file performs an action.
actor StandbyVoiceHost {
    /// Merges `protocolVersion` + `token` and writes one stdout frame; `main.swift` owns the wire.
    typealias Emit = @Sendable ([String: Any]) -> Void

    /// Default cadence: one 2.5 s window per tick, i.e. 24 wakeups/minute against the 30/minute
    /// standby budget. The acoustic window and the energy sample share the tick so a report row
    /// and the window it covers always describe the same interval.
    static let defaultTickMs = 2_500
    /// Confidence at which a window is reported as a detection (attention), never an action.
    static let defaultThreshold = 0.8

    private let emit: Emit
    private let log: @Sendable (String) -> Void
    private let graph: MicrophoneGraph
    private let monitor: StandbyEnergyMonitor
    private let sampler: StandbyEnergySampler
    private let tickMs: Int
    private let threshold: Double
    private var detector: StandbyWakeDetector
    private var wakeModelLoaded = false
    private var loop: Task<Void, Never>?

    init(
        tickMs: Int = StandbyVoiceHost.defaultTickMs,
        threshold: Double = StandbyVoiceHost.defaultThreshold,
        graph: MicrophoneGraph = MicrophoneGraph(),
        monitor: StandbyEnergyMonitor = StandbyEnergyMonitor(),
        sampler: StandbyEnergySampler = StandbyEnergySampler(),
        emit: @escaping Emit,
        log: @escaping @Sendable (String) -> Void
    ) {
        self.tickMs = max(250, tickMs)
        self.threshold = min(1, max(0, threshold))
        self.graph = graph
        self.monitor = monitor
        self.sampler = sampler
        self.emit = emit
        self.log = log
        self.detector = StandbyWakeDetector(threshold: min(1, max(0, threshold)))
    }

    /// Routes one `voice-command`. Acks are emitted here so an unknown or refused command always
    /// reaches the app as an authenticated refusal instead of a timeout.
    func handle(_ command: [String: Any]) async {
        let id = command["id"] as? String ?? ""
        guard let name = command["name"] as? String, !name.isEmpty else {
            acknowledge(id: id, ok: false, error: "Voice command is missing a name.")
            return
        }
        switch name {
        case "load-wake-model":
            detector.reset()
            wakeModelLoaded = true
            acknowledge(id: id, ok: true)
        case "unload-wake-model":
            await closeStandby()
            wakeModelLoaded = false
            acknowledge(id: id, ok: true)
        case "close-microphone":
            await closeStandby()
            acknowledge(id: id, ok: true)
        case "open-microphone":
            await openStandbyMicrophone(id: id, mode: command["mode"] as? String)
        default:
            acknowledge(id: id, ok: false, error: "Unsupported voice command '\(name)'.")
        }
    }

    /// Releases capture for a clean helper exit (`quit` / stdin EOF).
    func shutdown() async {
        await closeStandby()
    }

    private func openStandbyMicrophone(id: String, mode: String?) async {
        guard mode == "standby" else {
            // Conversation capture belongs to the local voice worker, which owns the ASR pack; this
            // helper only ever holds the always-on wake listener's microphone.
            acknowledge(id: id, ok: false, error: "Conversation capture belongs to the local voice worker.")
            return
        }
        guard wakeModelLoaded else {
            acknowledge(id: id, ok: false, error: "The wake model is not loaded.")
            return
        }
        if graph.captureActive() {
            acknowledge(id: id, ok: true)
            return
        }
        do {
            try await graph.startCapture { [weak self] packet in
                guard let self else { return }
                Task { await self.ingest(packet) }
            }
        } catch MicrophoneGraphError.microphoneDenied {
            acknowledge(id: id, ok: false, error: "Microphone permission is denied.")
            return
        } catch {
            acknowledge(id: id, ok: false, error: "Standby capture did not start: \(error).")
            return
        }
        sampler.reset()
        startLoop()
        log("standby microphone open (\(tickMs) ms windows, threshold \(threshold))")
        acknowledge(id: id, ok: true)
    }

    private func closeStandby() async {
        let wasOpen = graph.captureActive()
        stopLoop()
        await graph.stopCapture()
        detector.reset()
        if wasOpen { log("standby microphone closed") }
    }

    private func startLoop() {
        stopLoop()
        loop = Task { [tickMs] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(tickMs) * 1_000_000)
                if Task.isCancelled { return }
                self.tick()
            }
        }
    }

    private func stopLoop() {
        loop?.cancel()
        loop = nil
    }

    /// One standby tick: a measured energy reading for this process, and the acoustic window that
    /// ended with it. Both are reported — including the windows nothing was detected in, because
    /// those are the exposure denominator of the false-trigger rate.
    private func tick() {
        let sample = sampler.sample()
        monitor.record(sample)
        let report = monitor.report()
        emit([
            "type": "voice-observation",
            "observation": [
                "kind": "standby-energy",
                "sample": [
                    "durationMs": sample.durationMs,
                    "cpuPercent": sample.cpuPercent,
                    "wakeups": sample.wakeups,
                    "residentMemoryMb": sample.residentMemoryMB,
                ],
                "report": [
                    "durationMs": report.durationMs,
                    "averageCpuPercent": report.averageCPUPercent,
                    "wakeupsPerMinute": report.wakeupsPerMinute,
                    "peakResidentMemoryMb": report.peakResidentMemoryMB,
                    "sampleCount": report.sampleCount,
                    "passed": report.passed,
                    "violations": report.violations,
                ],
            ],
        ])
        let window = detector.finishWindow(durationMs: sample.durationMs)
        emit([
            "type": "voice-observation",
            "observation": [
                "kind": "standby-window",
                "environment": window.environment,
                "durationMs": window.durationMs,
                "detected": window.detected,
                "confidence": window.confidence,
                "threshold": window.threshold,
            ],
        ])
        if window.detected {
            log("standby window flagged attention (\(window.environment), confidence \(window.confidence)); "
                + "the app decides whether to reopen the conversation")
        }
    }

    private func ingest(_ packet: PCMPacket) {
        detector.ingest(packet)
    }

    private func acknowledge(id: String, ok: Bool, error: String? = nil) {
        var frame: [String: Any] = ["type": "voice-ack", "id": id, "ok": ok]
        if let error { frame["error"] = error }
        emit(frame)
    }
}
