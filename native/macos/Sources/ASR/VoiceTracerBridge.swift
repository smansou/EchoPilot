import Foundation
import Audio

public struct VoiceErrorState: Sendable, Equatable {
    public let code: String
    public let message: String

    public var jsonObject: [String: Any] { ["code": code, "message": message] }
}

public struct VoiceStatusSnapshot: Sendable, Equatable {
    /// closed | listening | speech_candidate | utterance_open | committing | muted
    public let input: String
    /// granted | denied | unknown
    public let microphone: String
    public let error: VoiceErrorState?
    public let queuedFrames: Int
    public let discontinuityCount: Int

    public var jsonObject: [String: Any] {
        [
            "input": input,
            "microphone": microphone,
            "error": error?.jsonObject ?? NSNull(),
            "queuedFrames": queuedFrames,
            "discontinuityCount": discontinuityCount,
        ]
    }
}

public struct VoiceTranscriptUpdate: Sendable, Equatable {
    /// partial updates are display-only; only final updates are committed.
    public let phase: String
    public let utteranceId: String
    public let text: String
    public let words: [ASRWordTimestamp]

    public var jsonObject: [String: Any] {
        ["phase": phase, "utteranceId": utteranceId, "text": text, "words": words.map(\.jsonObject)]
    }
}

/// Wires the native microphone graph, Silero VAD, WhisperKit small.en and the window planner into
/// the same session shape the TypeScript widget drives through the fake host contract:
/// status(), subscribe(), transcript(), mute(), close().
public final class VoiceTracerBridge: @unchecked Sendable {
    private let host: MicrophoneGraph
    private let vad: SileroVAD
    private let transcriber: LocalTranscriber
    private let planner: ASRWindowPlanner
    private let stateQueue = DispatchQueue(label: "voice.session")

    private let signals: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    private var consumer: Task<Void, Never>?
    private var listeners: [UUID: (VoiceTranscriptUpdate) -> Void] = [:]
    private var committed: [ASRCommit] = []
    private var input = "closed"
    private var error: VoiceErrorState?
    private var unsubscribeHost: (() -> Void)?
    private var running = false
    private var muted = false
    /// A visible host failure (denial, device removal, lock, helper crash) is terminal for the
    /// session: the widget keeps the error state and the pipeline stops consuming audio.
    private var failed = false
    /// Bumped whenever the buffered audio stops being trustworthy (mute, host failure, close). A
    /// transcription that is still in flight when the epoch moves is invalidated: its result can
    /// never be applied or emitted, and the planner no longer owns the window it was cut from.
    private var pipelineEpoch = 0
    private var inFlightTranscription: Task<ASRWindowResult, Error>?

    public init(
        host: MicrophoneGraph,
        vad: SileroVAD,
        transcriber: LocalTranscriber,
        planner: ASRWindowPlanner = ASRWindowPlanner()
    ) {
        self.host = host
        self.vad = vad
        self.transcriber = transcriber
        self.planner = planner
        var continuation: AsyncStream<Void>.Continuation!
        self.signals = AsyncStream<Void> { continuation = $0 }
        self.signal = continuation
        host.pcmChannel.setConsumer(
            onPacket: { [signal] _ in signal.yield(()) },
            onDiscontinuity: { [signal] in signal.yield(()) }
        )
    }

    public func start() async {
        guard !failed else { return }
        beginSession()
        do {
            try await host.startCapture(onFrame: frameListener())
            setInput("listening")
        } catch {
            handleStartFailure(error)
        }
    }

    private func beginSession() {
        guard !running else { return }
        running = true
        unsubscribeHost = host.onEvent { [weak self] event in
            self?.handle(event)
        }
        consumer = Task { [weak self] in
            guard let self else { return }
            for await _ in self.signals {
                await self.drainAndProcess()
            }
        }
    }

    /// The one frame listener the session registers with the host. The listener owns the transport
    /// ring: `MicrophoneGraph` must not enqueue the same packet a second time.
    private func frameListener() -> (PCMPacket) -> Void {
        { [weak self] packet in self?.blockingEnqueue(packet) }
    }

    /// Test seam: starts the session consumer without opening (or prompting for) a capture device.
    func beginSessionForTesting() {
        beginSession()
    }

    /// Test seam: the frame listener `start()` hands to the host.
    func frameListenerForTesting() -> (PCMPacket) -> Void {
        frameListener()
    }

    public func mute() async {
        stateQueue.sync {
            // Set the capture guarantee first: no further packet opens a window after this point.
            muted = true
            pipelineEpoch &+= 1
            planner.reset()
            host.pcmChannel.clear()
            inFlightTranscription?.cancel()
            inFlightTranscription = nil
            // Mute is a capture guarantee, not an error: a healthy session shows `muted`, while a
            // session that already surfaced a host failure keeps that error state visible.
            if error == nil { input = "muted" }
        }
        await host.stopCapture()
    }

    public func close() async {
        stateQueue.sync {
            running = false
            pipelineEpoch &+= 1
            planner.reset()
            inFlightTranscription?.cancel()
            inFlightTranscription = nil
        }
        signal.finish()
        consumer?.cancel()
        consumer = nil
        unsubscribeHost?()
        unsubscribeHost = nil
        await host.stopCapture()
    }

    public func status() -> VoiceStatusSnapshot {
        stateQueue.sync {
            VoiceStatusSnapshot(
                input: input,
                microphone: host.permission().rawValue,
                error: error,
                queuedFrames: host.pcmChannel.status().queuedFrames,
                discontinuityCount: host.pcmChannel.status().discontinuityCount
            )
        }
    }

    @discardableResult
    public func subscribe(_ listener: @escaping (VoiceTranscriptUpdate) -> Void) -> () -> Void {
        let token = UUID()
        stateQueue.sync { listeners[token] = listener }
        return { [weak self] in
            guard let self else { return }
            self.stateQueue.sync { self.listeners[token] = nil }
        }
    }

    public func transcript() -> [ASRCommit] {
        stateQueue.sync { committed }
    }

    private func blockingEnqueue(_ packet: PCMPacket) {
        // Capture callbacks must never block on the ASR consumer; the ring absorbs stalls. Once
        // the session is muted or a host failure is visible, late packets are dropped instead of
        // being transcribed after the widget stopped showing them.
        guard stateQueue.sync(execute: { running && !muted && !failed }) else { return }
        host.pcmChannel.enqueue(packet)
        signal.yield(())
    }

    private func drainAndProcess() async {
        while running, !muted, !failed {
            var batch: [PCMPacket] = []
            var discontinuity = false
            host.pcmChannel.setConsumer(
                onPacket: { batch.append($0) },
                onDiscontinuity: { discontinuity = true }
            )
            host.pcmChannel.drain()
            if failed || muted { return }
            if discontinuity {
                stateQueue.sync { planner.markDiscontinuity() }
                setInput("listening")
            }
            guard !batch.isEmpty else { return }
            for packet in batch {
                await process(packet)
            }
        }
    }

    private func process(_ packet: PCMPacket) async {
        guard !failed, !muted else { return }
        let vadState = vad.process(pcm: packet.pcm, sampleRate: packet.sampleRate)
        if vadState.isSpeech, status().input == "listening" {
            setInput("speech_candidate")
        }
        // The mute/failure flag and the planner append share one lock: a packet that raced the mute
        // can never reopen the window the mute just cleared.
        let event = stateQueue.sync { () -> ASRPlannerEvent? in
            guard running, !muted, !failed else { return nil }
            return planner.append(packet: packet)
        }
        guard let event else { return }
        switch event {
        case let .partial(window):
            setInput("utterance_open")
            await run(window: window, sealed: false, endpoint: vadState.endpoint)
        case let .seal(window):
            setInput("committing")
            await run(window: window, sealed: true, endpoint: vadState.endpoint)
        }
    }

    private func run(window: ASRWindow, sealed: Bool, endpoint: Bool) async {
        let epoch = stateQueue.sync { pipelineEpoch }
        let transcription = Task { [transcriber] in try await transcriber.transcribe(window) }
        stateQueue.sync { inFlightTranscription = transcription }
        do {
            let result = try await transcription.value
            // Mute, close or a host failure may have landed while the engine was running: the
            // pending window is gone, so its late result must not be applied or emitted.
            guard isPipelineCurrent(epoch) else { return }
            stateQueue.sync { inFlightTranscription = nil }
            let outcome = stateQueue.sync {
                planner.apply(
                    result: ASRWindowResult(text: result.text, words: result.words, endpoint: result.endpoint || endpoint),
                    window: window,
                    sealed: sealed
                )
            }
            apply(outcome)
        } catch {
            guard isPipelineCurrent(epoch) else { return }
            stateQueue.sync { inFlightTranscription = nil }
            stateQueue.sync { planner.markDiscontinuity() }
            setInput("listening")
        }
    }

    /// True while the session still runs on the pipeline generation `epoch` captured when the
    /// engine call started: it is false after mute, close or a visible host failure.
    private func isPipelineCurrent(_ epoch: Int) -> Bool {
        stateQueue.sync { pipelineEpoch == epoch && running && !muted && !failed }
    }

    private func apply(_ outcome: ASRPlannerOutcome) {
        switch outcome {
        case let .committed(commit):
            commitAndEmit(commit)
            setInput("utterance_open")
        case let .ended(commit):
            commitAndEmit(commit)
            setInput("listening")
        case let .displayOnly(text, words):
            emit(VoiceTranscriptUpdate(
                phase: "partial",
                utteranceId: stateQueue.sync { planner.currentUtteranceId } ?? "utterance-unknown",
                text: text,
                words: words
            ))
        case .unchanged:
            break
        }
    }

    private func commitAndEmit(_ commit: ASRCommit) {
        stateQueue.sync { committed.append(commit) }
        emit(VoiceTranscriptUpdate(
            phase: "final",
            utteranceId: commit.utteranceId,
            text: commit.text,
            words: commit.words
        ))
    }

    private func emit(_ update: VoiceTranscriptUpdate) {
        let listeners = stateQueue.sync { Array(self.listeners.values) }
        for listener in listeners { listener(update) }
    }

    private func setInput(_ next: String) {
        stateQueue.sync {
            guard !muted, error == nil else { return }
            input = next
        }
    }

    private func handle(_ event: AudioHostEvent) {
        let mapped: VoiceErrorState
        switch event {
        case .permissionDenied:
            mapped = VoiceErrorState(code: "mic_denied", message: "Microphone access is not granted.")
        case let .deviceRemoved(deviceId):
            mapped = VoiceErrorState(code: "device_removed", message: "Input device \(deviceId) was removed.")
        case .systemLocked:
            mapped = VoiceErrorState(code: "locked", message: "The Mac locked during capture.")
        case let .helperCrash(message):
            mapped = VoiceErrorState(code: "helper_crash", message: message)
        }
        stateQueue.sync {
            failed = true
            pipelineEpoch &+= 1
            error = mapped
            input = "closed"
            planner.reset()
            host.pcmChannel.clear()
            inFlightTranscription?.cancel()
            inFlightTranscription = nil
        }
        Task { await host.stopCapture() }
    }

    private func handleStartFailure(_ failure: Error) {
        let code: String
        let message: String
        switch failure {
        case MicrophoneGraphError.microphoneDenied, MicrophoneGraphError.microphoneUnknown:
            code = "mic_denied"
            message = "Microphone access is not granted."
        case let MicrophoneGraphError.engineStartFailed(detail):
            code = "helper_crash"
            message = "The microphone graph failed to start: \(detail)"
        default:
            code = "helper_crash"
            message = String(describing: failure)
        }
        stateQueue.sync {
            failed = true
            pipelineEpoch &+= 1
            error = VoiceErrorState(code: code, message: message)
            input = "closed"
            planner.reset()
            host.pcmChannel.clear()
            inFlightTranscription?.cancel()
            inFlightTranscription = nil
        }
    }
}
