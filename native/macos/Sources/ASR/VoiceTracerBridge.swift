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
    /// A closed session is finished: `start()` must never resurrect it and open capture again.
    private var closed = false
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
        // Mute and close are capture guarantees, not just pipeline pauses: a session that was
        // already muted (or already closed) must never open the microphone graph later, no matter
        // when the widget sends `start`. The visible state it was given stays the same.
        let blocked = stateQueue.sync { failed || muted || closed }
        guard !blocked else { return }
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
            closed = true
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
        //
        // The "still accepting audio" check and the enqueue are one critical section shared with
        // `mute()` / the failure handler: a packet that raced the mute can therefore neither land
        // in the ring after it was cleared nor reopen the window the mute just reset.
        let accepted = stateQueue.sync { () -> Bool in
            guard running, !muted, !failed else { return false }
            host.pcmChannel.enqueue(packet)
            return true
        }
        guard accepted else { return }
        signal.yield(())
    }

    /// True while the session consumes audio: false before `start()`, after `mute()`, after
    /// `close()` and after a visible host failure. Always read under `stateQueue`.
    private var isPipelineActive: Bool {
        stateQueue.sync { running && !muted && !failed }
    }

    private func drainAndProcess() async {
        while isPipelineActive {
            var batch: [PCMPacket] = []
            var discontinuity = false
            host.pcmChannel.setConsumer(
                onPacket: { batch.append($0) },
                onDiscontinuity: { discontinuity = true }
            )
            host.pcmChannel.drain()
            guard isPipelineActive else { return }
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
        guard isPipelineActive else { return }
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
        guard isPipelineActive else { return }
        let epoch = stateQueue.sync { pipelineEpoch }
        let transcription = Task { [transcriber] in try await transcriber.transcribe(window) }
        stateQueue.sync { inFlightTranscription = transcription }
        do {
            let result = try await transcription.value
            // Mute, close or a host failure may have landed while the engine was running: the
            // pending window is gone, so its late result must not be applied or emitted. The check
            // and the apply share one critical section, so the reset can never land between them.
            applyEngineResult(
                epoch: epoch,
                result: ASRWindowResult(
                    text: result.text,
                    words: result.words,
                    endpoint: result.endpoint || endpoint
                ),
                window: window,
                sealed: sealed
            )
        } catch {
            let handled = stateQueue.sync { () -> Bool in
                guard pipelineEpoch == epoch, running, !muted, !failed else { return false }
                inFlightTranscription = nil
                planner.markDiscontinuity()
                return true
            }
            guard handled else { return }
            setInput("listening")
        }
    }

    /// The session's single commit boundary: the epoch check, the planner apply and the append to
    /// `committed` all happen inside one `stateQueue` critical section. A mute, `close()` or a
    /// visible host failure can therefore never land between "the result is still current" and
    /// "the result is committed": a transcription that answers after the pipeline moved on is
    /// dropped, never appended to the widget transcript and never emitted.
    ///
    /// Returns the update that was emitted, or `nil` when the result belonged to a stale epoch.
    @discardableResult
    func applyEngineResult(
        epoch: Int,
        result: ASRWindowResult,
        window: ASRWindow,
        sealed: Bool
    ) -> VoiceTranscriptUpdate? {
        enum Applied {
            case stale
            case update(VoiceTranscriptUpdate, nextInput: String?)
            case quiet
        }

        let applied: Applied = stateQueue.sync {
            guard pipelineEpoch == epoch, running, !muted, !failed else { return .stale }
            inFlightTranscription = nil
            switch planner.apply(result: result, window: window, sealed: sealed) {
            case let .committed(commit):
                committed.append(commit)
                return .update(Self.finalUpdate(for: commit), nextInput: "utterance_open")
            case let .ended(commit):
                committed.append(commit)
                return .update(Self.finalUpdate(for: commit), nextInput: "listening")
            case let .displayOnly(text, words):
                return .update(
                    VoiceTranscriptUpdate(
                        phase: "partial",
                        utteranceId: planner.currentUtteranceId ?? "utterance-unknown",
                        text: text,
                        words: words
                    ),
                    nextInput: nil
                )
            case .unchanged:
                return .quiet
            }
        }

        switch applied {
        case .stale, .quiet:
            return nil
        case let .update(update, nextInput):
            if let nextInput { setInput(nextInput) }
            emit(update)
            return update
        }
    }

    private static func finalUpdate(for commit: ASRCommit) -> VoiceTranscriptUpdate {
        VoiceTranscriptUpdate(
            phase: "final",
            utteranceId: commit.utteranceId,
            text: commit.text,
            words: commit.words
        )
    }

    /// The pipeline generation a result must carry to be accepted by `applyEngineResult`. `mute()`,
    /// `close()` and every visible host failure bump it, which invalidates anything in flight.
    var currentPipelineEpoch: Int {
        stateQueue.sync { pipelineEpoch }
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
