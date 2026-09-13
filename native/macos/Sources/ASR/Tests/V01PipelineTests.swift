//
// V01 native pipeline regression — the helper's acceptance path must hand every PCM packet to the
// ASR consumer exactly once, no ASR window may exceed 15 s, and mute as well as an ordinary capture
// release must settle while audio is still flowing so the widget never hangs.
//
// The checks drive `MicrophoneGraph` + `VoiceTracerBridge` through the same packetizer/frame-listener
// path the audio tap uses, without asking for microphone permission or opening a device, so they run
// in the deterministic gate:
//
//   swift test --package-path native/macos/Sources/ASR
//
// They live in the ASR package because that package depends on Audio: the pipeline under test spans
// both modules, and the internal test seams are reached with `@testable import`.
import XCTest
@testable import ASR
@testable import Audio

final class V01PipelineTests: XCTestCase {
    /// A strictly increasing ramp: a duplicated packet repeats values, a dropped packet skips them.
    private func rampSamples(packetCount: Int) -> [Int16] {
        let total = packetCount * PCMPacket.samplesPerPacket
        return (0..<total).map { Int16($0 % 30_000) }
    }

    private func silentSamples(packetCount: Int) -> [Int16] {
        [Int16](repeating: 0, count: packetCount * PCMPacket.samplesPerPacket)
    }

    private func pcmData(_ samples: [Int16]) -> Data {
        samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private func int16Samples(_ data: Data) -> [Int16] {
        let count = data.count / 2
        var samples = [Int16](repeating: 0, count: count)
        data.withUnsafeBytes { raw in
            for index in 0..<count {
                let low = UInt16(raw[index * 2])
                let high = UInt16(raw[index * 2 + 1])
                samples[index] = Int16(bitPattern: high << 8 | low)
            }
        }
        return samples
    }

    /// One native packet on the monotonic clock the tap uses.
    private func packet(sequence: UInt64, samples: [Int16]) -> PCMPacket {
        PCMPacket(
            sequence: sequence,
            monotonicNs: sequence &* PCMPacket.packetDurationNs,
            pcm: pcmData(samples)
        )
    }

    /// Pushes 20 ms packets through one captured frame listener, exactly like a tap that is still
    /// delivering audio after mute or after a host failure.
    private func sendPackets(
        _ packetCount: Int,
        through listener: (PCMPacket) -> Void,
        startingAt sequence: UInt64 = 0
    ) {
        for index in 0..<packetCount {
            listener(PCMPacket(
                sequence: sequence + UInt64(index),
                monotonicNs: UInt64(index) * PCMPacket.packetDurationNs,
                pcm: pcmData(silentSamples(packetCount: 1))
            ))
        }
    }

    private final class RecordingTranscriber: LocalTranscriber, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [ASRWindow] = []

        var windows: [ASRWindow] {
            lock.lock()
            defer { lock.unlock() }
            return recorded
        }

        private func record(_ window: ASRWindow) {
            lock.lock()
            recorded.append(window)
            lock.unlock()
        }

        func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult {
            record(window)
            return ASRWindowResult(text: "", words: [], endpoint: false)
        }
    }

    /// Engine stand-in that answers the way the local pack does: it reports words whose times are
    /// relative to the window it was handed, records every window it ran on, and — like a real
    /// small.en pack — returns no words for a window that holds only silence.
    private final class ScriptedTranscriber: LocalTranscriber, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [ASRWindow] = []

        var windows: [ASRWindow] {
            lock.lock()
            defer { lock.unlock() }
            return recorded
        }

        func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult {
            lock.lock()
            recorded.append(window)
            lock.unlock()
            // Pure silence decodes to nothing: the trailing-silence window the endpoint closes on
            // must not answer with words, or the regression that re-committed the stale window
            // would hide behind a stand-in that hears speech in silence.
            guard window.pcm.contains(where: { $0 != 0 }) else {
                return ASRWindowResult(text: "", words: [], endpoint: false)
            }
            return ASRWindowResult(
                text: "alpha beta",
                words: [
                    ASRWordTimestamp(text: "alpha", startMs: 50, endMs: 250),
                    ASRWordTimestamp(text: "beta", startMs: 500, endMs: 700),
                ],
                endpoint: false
            )
        }
    }

    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false

        func set(_ next: Bool) {
            lock.lock()
            value = next
            lock.unlock()
        }

        var isSet: Bool {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    /// Collects emitted updates from the session's listener thread without racing the test thread.
    private final class TranscriptRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var updates: [VoiceTranscriptUpdate] = []

        func record(_ update: VoiceTranscriptUpdate) {
            lock.lock()
            updates.append(update)
            lock.unlock()
        }

        var all: [VoiceTranscriptUpdate] {
            lock.lock()
            defer { lock.unlock() }
            return updates
        }
    }

    /// A transcriber whose engine call does not return until the test opens the gate. It drives the
    /// window between "engine call started" and "result lands" that mute and a host failure must
    /// invalidate: the released result is an endpoint that *would* commit a final transcript.
    private final class GatedTranscriber: LocalTranscriber, @unchecked Sendable {
        private let lock = NSLock()
        private var continuations: [CheckedContinuation<ASRWindowResult, Error>] = []
        private var startedCount = 0
        private var isOpen = false
        private let result = ASRWindowResult(
            text: "late words",
            words: [ASRWordTimestamp(text: "late", startMs: 0, endMs: 120)],
            endpoint: true
        )

        var started: Int {
            lock.lock()
            defer { lock.unlock() }
            return startedCount
        }

        /// Synchronous bookkeeping: the async entry point never touches the lock directly.
        private func beginCall() -> (alreadyOpen: Bool, late: ASRWindowResult) {
            lock.lock()
            defer { lock.unlock() }
            startedCount += 1
            return (isOpen, result)
        }

        private func suspendOrResume(_ continuation: CheckedContinuation<ASRWindowResult, Error>) {
            lock.lock()
            if isOpen {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                continuations.append(continuation)
                lock.unlock()
            }
        }

        func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult {
            let (alreadyOpen, late) = beginCall()
            if alreadyOpen { return late }
            return try await withCheckedThrowingContinuation { continuation in
                suspendOrResume(continuation)
            }
        }

        /// Releases every engine call that was still in flight.
        func open() {
            lock.lock()
            isOpen = true
            let pending = continuations
            continuations = []
            let late = result
            lock.unlock()
            for continuation in pending { continuation.resume(returning: late) }
        }
    }

    /// Session bridge wired to a graph without opening (or prompting for) a capture device.
    private func makeBridge(host: MicrophoneGraph) throws -> (bridge: VoiceTracerBridge, transcriber: RecordingTranscriber) {
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let vad = try SileroVAD(configuration: configuration)
        let transcriber = RecordingTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: vad,
            transcriber: transcriber,
            planner: ASRWindowPlanner()
        )
        bridge.beginSessionForTesting()
        host.attachFrameListenerForTesting(bridge.frameListenerForTesting())
        return (bridge, transcriber)
    }

    private func waitUntil(timeout: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    // MARK: - 1. One producer into the bounded ring

    // `MicrophoneGraph` must hand each packet to the frame listener once and never enqueue its own
    // second copy: two producers doubled every packet, halved the ring's capacity and made the
    // VAD/planner advance at twice the real audio rate.
    func testFrameListenerReceivesEachPacketExactlyOnce() {
        let graphOnly = MicrophoneGraph(maxQueuedFrames: 64)
        var observedSequences: [UInt64] = []
        graphOnly.attachFrameListenerForTesting { packet in observedSequences.append(packet.sequence) }
        graphOnly.deliverForTesting(samples: rampSamples(packetCount: 20), startNs: 1_000_000)

        XCTAssertEqual(
            observedSequences,
            (0..<20).map(UInt64.init),
            "frame listener receives each of the 20 packets exactly once, in order"
        )
        XCTAssertEqual(
            graphOnly.pcmChannel.status().queuedFrames,
            0,
            "MicrophoneGraph does not enqueue a second copy of the packet into the ring"
        )
    }

    // MARK: - 2. Graph + bridge: each packet reaches the VAD/planner exactly once

    func testBridgeWindowHoldsEachPacketExactlyOnce() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        let (bridge, transcriber) = try makeBridge(host: host)
        addTeardownBlock { await bridge.close() }

        host.deliverForTesting(samples: rampSamples(packetCount: 20), startNs: 9_000_000)
        await waitUntil { !transcriber.windows.isEmpty }

        let firstWindow = transcriber.windows.first
        XCTAssertNotNil(firstWindow, "the bridge transcribed the first 400 ms window")
        if let firstWindow {
            XCTAssertEqual(
                firstWindow.pcm.count,
                20 * PCMPacket.samplesPerPacket * 2,
                "the first window holds exactly 20 packets of PCM (no duplicated audio)"
            )
            let samples = int16Samples(firstWindow.pcm)
            var contiguous = samples.count == 20 * PCMPacket.samplesPerPacket
            if contiguous {
                for index in 0..<samples.count where samples[index] != Int16(index) {
                    contiguous = false
                    break
                }
            }
            XCTAssertTrue(contiguous, "the window PCM is one in-order ramp: every packet arrived exactly once")
        }
        XCTAssertEqual(host.pcmChannel.status().queuedFrames, 0, "the ring drains to empty once the consumer runs")
        XCTAssertEqual(host.pcmChannel.status().discontinuityCount, 0, "exactly-once delivery drops no audio")
    }

    // MARK: - 2b. A full 15-second utterance comes back as committed local text

    /// Drives 15 s of speech plus the trailing silence through the same tap → packetizer → bounded
    /// ring → Silero VAD → planner → bridge path the helper runs, with a local engine stand-in that
    /// reports words the way the pack does: times relative to the window it was handed. The
    /// committed transcript must carry the utterance text and the rebased word timestamps, the
    /// sealed window must sit on the 15 s bound, and nothing may be dropped — the audio stays on
    /// this machine and every engine call happens in-process.
    func testFifteenSecondUtteranceCommitsLocalTextWithTimestamps() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let transcriber = ScriptedTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: try SileroVAD(configuration: configuration),
            transcriber: transcriber
        )
        bridge.beginSessionForTesting()
        host.attachFrameListenerForTesting(bridge.frameListenerForTesting())
        addTeardownBlock { await bridge.close() }

        let listener = bridge.frameListenerForTesting()
        let speech = [Int16](repeating: 8_000, count: PCMPacket.samplesPerPacket)
        let silence = silentSamples(packetCount: 1)
        var sequence: UInt64 = 0
        // 750 × 20 ms = a 15-second utterance. The speech keeps Silero's utterance open; the ring
        // is drained every 5 packets so the bounded transport never overflows in the test.
        for index in 0..<750 {
            listener(packet(sequence: sequence, samples: speech))
            sequence += 1
            if index % 5 == 4 {
                await waitUntil { host.pcmChannel.status().queuedFrames == 0 }
            }
        }
        // 1.2 s of trailing silence: the endpoint fires after 450 ms and closes the utterance.
        for _ in 0..<60 {
            listener(packet(sequence: sequence, samples: silence))
            sequence += 1
            await waitUntil { host.pcmChannel.status().queuedFrames == 0 }
        }
        await waitUntil { bridge.status().input == "listening" && !bridge.transcript().isEmpty }

        let status = bridge.status()
        XCTAssertNil(status.error, "a healthy local session stays error-free")
        XCTAssertEqual(status.input, "listening", "the endpoint closed the utterance")
        XCTAssertEqual(status.queuedFrames, 0, "the bounded ring drains back to empty")
        XCTAssertEqual(status.discontinuityCount, 0, "no audio is dropped while the ring is drained")

        let windows = transcriber.windows
        XCTAssertFalse(windows.isEmpty, "the local engine ran on the captured audio")
        XCTAssertTrue(
            windows.allSatisfy { $0.durationMs <= 15_000.0 },
            "no ASR window may exceed the 15 s bound"
        )
        XCTAssertTrue(
            windows.contains { $0.durationMs >= 14_980.0 },
            "the utterance was sealed on the 15 s bound, not cut short"
        )

        let committed = bridge.transcript()
        guard let first = committed.first else {
            return XCTFail("a 15-second utterance must commit local text")
        }
        XCTAssertEqual(first.text, "alpha beta", "the stable prefix is committed verbatim")
        XCTAssertEqual(
            first.words,
            [
                ASRWordTimestamp(text: "alpha", startMs: 50, endMs: 250),
                ASRWordTimestamp(text: "beta", startMs: 500, endMs: 700),
            ],
            "committed text carries the word timestamps"
        )
        // Timestamps are relative to the start of *their* utterance: within the 15-second utterance
        // the seal commit comes first and the roll-over commit advances past 13 s, which only holds
        // if the window-relative engine times were rebased onto the utterance timeline.
        let utterance = committed.filter { $0.utteranceId == first.utteranceId }
        XCTAssertGreaterThanOrEqual(
            utterance.count,
            2,
            "the 15 s seal committed, and the roll-over kept committing afterwards"
        )
        let startTimes = utterance.flatMap(\.words).map(\.startMs)
        XCTAssertEqual(startTimes, startTimes.sorted(), "committed word times advance with the audio")
        XCTAssertGreaterThan(
            startTimes.last ?? 0,
            13_000,
            "word times are relative to the utterance, not to the window that heard them"
        )
        XCTAssertTrue(
            committed.flatMap(\.words).allSatisfy { $0.startMs >= 0 && $0.endMs >= $0.startMs },
            "every committed word carries a sane utterance-relative timestamp"
        )

        // The endpoint ended the utterance: it must close exactly once and drop its window, so the
        // trailing silence that keeps flowing afterwards can never re-transcribe the committed PCM
        // under a fresh utterance id and commit the same words again.
        XCTAssertEqual(
            Set(committed.map(\.utteranceId)),
            [first.utteranceId],
            "the 15 s utterance ended once; trailing silence did not open a second utterance"
        )
        let committedWordKeys = committed.flatMap(\.words).map { "\($0.text)@\($0.startMs)-\($0.endMs)" }
        XCTAssertEqual(
            Set(committedWordKeys).count,
            committedWordKeys.count,
            "every committed word is committed exactly once, not re-committed after the endpoint"
        )
        XCTAssertEqual(
            committedWordKeys.count,
            4,
            "only the 15 s seal and the endpoint committed words; trailing silence committed nothing"
        )
    }

    // MARK: - 2c. The endpoint is reported once and takes its window with it

    /// Silero's endpoint is a one-shot: after it closes an utterance the VAD starts from silence
    /// again, so the packets of trailing silence that keep arriving cannot report `endpoint: true`
    /// again and end the next utterance before it was heard.
    func testSileroVADReportsTheEndpointExactlyOnce() throws {
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let vad = try SileroVAD(configuration: configuration)
        let speech = pcmData([Int16](repeating: 8_000, count: PCMPacket.samplesPerPacket))
        let silence = pcmData(silentSamples(packetCount: 1))

        for _ in 0..<50 {
            _ = vad.process(pcm: speech, sampleRate: PCMPacket.sampleRate)
        }
        var endpoints = 0
        for _ in 0..<100 {
            if vad.process(pcm: silence, sampleRate: PCMPacket.sampleRate).endpoint {
                endpoints += 1
            }
        }
        XCTAssertEqual(
            endpoints,
            1,
            "the 450 ms endpoint fires once; trailing silence is a fresh, silent utterance"
        )
    }

    /// The endpoint commit ends the utterance, so its window goes with it: the next window holds
    /// only the audio that followed. Leaving the stale PCM behind let the next 400 ms boundary
    /// transcribe the already-committed window under a fresh utterance id and commit it again.
    func testPlannerEndpointDropsTheWindowItCommitted() {
        let planner = ASRWindowPlanner()

        var first: ASRWindow?
        for index in 0..<20 {
            if case let .partial(window)? = planner.append(
                packet: packet(
                    sequence: UInt64(index),
                    samples: rampSamples(packetCount: 1)
                )
            ) {
                first = window
            }
        }
        guard let first else {
            return XCTFail("the planner cut the first 400 ms window")
        }

        let outcome = planner.apply(
            result: ASRWindowResult(
                text: "alpha",
                words: [ASRWordTimestamp(text: "alpha", startMs: 50, endMs: 250)],
                endpoint: true
            ),
            window: first,
            sealed: false
        )
        guard case .ended = outcome else {
            return XCTFail("the endpoint ended the utterance, got \(outcome)")
        }

        var next: ASRWindow?
        for index in 20..<40 {
            if case let .partial(window)? = planner.append(
                packet: packet(
                    sequence: UInt64(index),
                    samples: rampSamples(packetCount: 1)
                )
            ) {
                next = window
            }
        }
        guard let next else {
            return XCTFail("the following packets opened a new window")
        }
        XCTAssertNotEqual(
            next.utteranceId,
            first.utteranceId,
            "the endpoint closed the utterance instead of continuing it"
        )
        XCTAssertEqual(
            next.pcm.count,
            20 * PCMPacket.samplesPerPacket * 2,
            "the new window holds only the audio that followed the endpoint"
        )
        XCTAssertEqual(next.startMs, 400, "the new window starts after the committed audio")
        XCTAssertEqual(
            next.durationMs,
            400,
            "no stale PCM was carried across the endpoint"
        )
    }

    // MARK: - 3. Mute settles and clears pending input

    func testMuteSettlesAndClearsPendingAudio() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        host.setPermissionOverrideForTesting(.granted)
        let (bridge, transcriber) = try makeBridge(host: host)
        addTeardownBlock { await bridge.close() }

        // Keep the one frame listener the session registered: after mute it must drop late audio.
        let listener = bridge.frameListenerForTesting()
        host.deliverForTesting(samples: silentSamples(packetCount: 25), startNs: 0)
        await waitUntil { !transcriber.windows.isEmpty }

        let muteStart = Date()
        await bridge.mute()
        XCTAssertLessThan(
            Date().timeIntervalSince(muteStart),
            2,
            "mute settles without hanging the widget"
        )
        let muted = bridge.status()
        XCTAssertEqual(muted.input, "muted", "mute is visible in the widget state")
        XCTAssertEqual(muted.microphone, "granted", "mute changes capture, not the OS permission")
        XCTAssertNil(muted.error, "mute is not an error state")
        XCTAssertEqual(host.pcmChannel.status().queuedFrames, 0, "mute clears pending audio")

        let windowsAtMute = transcriber.windows.count
        sendPackets(25, through: listener, startingAt: 1_000)
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(
            transcriber.windows.count,
            windowsAtMute,
            "audio delivered after mute must not reach the local ASR"
        )
        XCTAssertTrue(
            bridge.transcript().isEmpty,
            "mute discards the open utterance instead of finalizing it"
        )
    }

    // MARK: - 3b. The transport ring stays bounded while the consumer stalls

    /// A stalled ASR consumer must never grow the transport: the ring drops the oldest packets,
    /// counts one discontinuity for the gap and keeps `queuedFrames` at its configured maximum.
    func testBoundedRingNeverGrowsPastItsLimitWhileTheConsumerStalls() {
        let channel = BoundedPCMChannel(maxQueuedFrames: 8)
        for sequence in 0..<30 {
            channel.enqueue(packet(sequence: UInt64(sequence), samples: silentSamples(packetCount: 1)))
        }
        let status = channel.status()
        XCTAssertEqual(status.queuedFrames, 8, "a stalled consumer never grows the ring past its bound")
        XCTAssertEqual(status.droppedFrames, 22, "overflow drops the oldest audio")
        XCTAssertEqual(status.discontinuityCount, 1, "one overflow burst counts one discontinuity")
    }

    // MARK: - 4. Releasing capture never deadlocks the audio tap

    // The tap path keeps delivering while the stop runs. Releasing capture must never hold the state
    // lock across `removeTap`/`engine.stop()` (those wait for an in-flight tap block, and the tap
    // block takes the state lock), or mute/lock/device-removal stops would hang the widget.
    func testStopCaptureSettlesWhileAudioKeepsFlowing() async {
        let flowing = MicrophoneGraph(maxQueuedFrames: 16)
        let keepDelivering = Flag()
        keepDelivering.set(true)
        let silence = silentSamples(packetCount: 1)
        let tapQueue = DispatchQueue(label: "v01.test.audio-tap", attributes: .concurrent)
        tapQueue.async {
            while keepDelivering.isSet {
                flowing.deliverForTesting(samples: silence, startNs: 0)
            }
        }

        let stopStart = Date()
        await flowing.stopCapture()
        let stopDuration = Date().timeIntervalSince(stopStart)
        keepDelivering.set(false)
        await Task.yield()
        XCTAssertLessThan(stopDuration, 2, "stopCapture settles while the tap path keeps delivering audio")
    }

    // MARK: - 5. One oversized packet can never open a window past 15 s

    func testOversizedPacketCannotOpenWindowPastTheBound() {
        let planner = ASRWindowPlanner()
        let oversized = PCMPacket(
            sequence: 0,
            monotonicNs: 0,
            pcm: pcmData(rampSamples(packetCount: 800)) // 16 s in one packet
        )
        var packets: [PCMPacket] = [oversized]
        for index in 1...60 {
            packets.append(PCMPacket(
                sequence: UInt64(index),
                monotonicNs: 16_000_000_000 + UInt64(index) * 20_000_000,
                pcm: pcmData(silentSamples(packetCount: 1))
            ))
        }

        var emittedWindows: [ASRWindow] = []
        for packet in packets {
            guard let event = planner.append(packet: packet) else { continue }
            switch event {
            case let .partial(window), let .seal(window):
                emittedWindows.append(window)
            }
        }

        XCTAssertFalse(emittedWindows.isEmpty, "the oversized packet still produced ASR windows")
        XCTAssertTrue(
            emittedWindows.allSatisfy { $0.durationMs <= 15_000.0 },
            "no ASR window exceeds ASR_MAX_WINDOW_MS = 15 s"
        )
        let coveredBytes = emittedWindows.reduce(0) { $0 + $1.pcm.count }
        XCTAssertGreaterThanOrEqual(
            coveredBytes,
            oversized.pcm.count,
            "no PCM was dropped while splitting the frame"
        )
    }

    // MARK: - 6. Mic denial, device removal, lock and helper crash stay visible and stop the pipeline

    /// Mic denial: the graph never opens, `start()` settles, and the widget shows `mic_denied`.
    func testMicrophoneDenialIsVisibleWithoutOpeningCapture() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 16)
        host.setPermissionOverrideForTesting(.denied)
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let transcriber = RecordingTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: try SileroVAD(configuration: configuration),
            transcriber: transcriber
        )
        addTeardownBlock { await bridge.close() }

        let start = Date()
        await bridge.start()
        XCTAssertLessThan(
            Date().timeIntervalSince(start),
            2,
            "a denied microphone settles instead of hanging the widget"
        )

        let status = bridge.status()
        XCTAssertEqual(status.microphone, "denied", "the widget shows the permission state")
        XCTAssertEqual(status.input, "closed", "a denied microphone leaves input closed")
        XCTAssertEqual(status.error?.code, "mic_denied", "the failure stays visible in status()")
        XCTAssertFalse(
            status.error?.message.isEmpty ?? true,
            "the visible state needs a readable message"
        )
        XCTAssertFalse(host.captureActive(), "a denied microphone never opens capture")

        // Let the denial's capture release settle, then push audio like a tap that is still
        // delivering: a denied session must drop it instead of opening a window or committing text.
        try? await Task.sleep(nanoseconds: 200_000_000)
        sendPackets(25, through: bridge.frameListenerForTesting())
        XCTAssertEqual(
            bridge.status().queuedFrames,
            0,
            "a denied session drops late audio instead of buffering it"
        )
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(transcriber.windows.isEmpty, "a denied session must not transcribe audio")
        XCTAssertTrue(bridge.transcript().isEmpty, "a denied session must not commit text")
    }

    /// Device removal, lock and helper crash: each event is a visible terminal state, drops the
    /// pending ring, stops the consumer from opening new ASR windows, and still settles.
    func testHostFailureEventsAreVisibleAndStopConsumingAudio() async throws {
        let cases: [(label: String, event: AudioHostEvent, code: String)] = [
            ("device removal", .deviceRemoved(deviceId: "fixture-mic-2"), "device_removed"),
            ("lock", .systemLocked, "locked"),
            ("helper crash", .helperCrash(message: "helper exited"), "helper_crash"),
            ("permission denial event", .permissionDenied, "mic_denied"),
        ]

        for testCase in cases {
            // A ring that fits the pre-failure burst, so the window under test is the failure's
            // effect and not an overflow discontinuity.
            let host = MicrophoneGraph(maxQueuedFrames: 64)
            let (bridge, transcriber) = try makeBridge(host: host)
            let listener = bridge.frameListenerForTesting()

            // Speech is flowing (a display-only window exists) when the host reports the failure.
            host.deliverForTesting(samples: silentSamples(packetCount: 25), startNs: 0)
            await waitUntil { !transcriber.windows.isEmpty }
            let windowsBeforeFailure = transcriber.windows.count

            host.emitForTesting(testCase.event)
            await waitUntil { bridge.status().error != nil }

            let status = bridge.status()
            XCTAssertEqual(status.error?.code, testCase.code, "\(testCase.label): visible error code")
            XCTAssertFalse(
                status.error?.message.isEmpty ?? true,
                "\(testCase.label): the visible state needs a readable message"
            )
            XCTAssertEqual(status.input, "closed", "\(testCase.label): the stream is closed")
            XCTAssertEqual(
                status.queuedFrames,
                0,
                "\(testCase.label): the failure drops pending audio instead of buffering it"
            )

            sendPackets(25, through: listener, startingAt: 1_000)
            try? await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertEqual(
                transcriber.windows.count,
                windowsBeforeFailure,
                "\(testCase.label): a failed session must not open new ASR windows"
            )
            XCTAssertTrue(
                bridge.transcript().isEmpty,
                "\(testCase.label): a failed session must not commit text"
            )

            let closeStart = Date()
            await bridge.close()
            XCTAssertLessThan(
                Date().timeIntervalSince(closeStart),
                2,
                "\(testCase.label): close settles without hanging the widget"
            )
            XCTAssertEqual(
                bridge.status().error?.code,
                testCase.code,
                "\(testCase.label): the failure stays visible after close"
            )
        }
    }

    // MARK: - 7. The local model pack is English-only and never reaches the network

    func testLocalTranscriberIsOfflineAndFailsClosed() throws {
        XCTAssertEqual(WhisperModelPack.englishSmall.language, "en")
        XCTAssertFalse(WhisperModelPack.englishSmall.isMultilingual)
        XCTAssertEqual(WhisperModelPack.englishSmall.sampleRate, PCMPacket.sampleRate)
        XCTAssertEqual(WhisperModelPack.englishSmall.maxWindowMs, 15_000)

        let missingPack = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("v01-missing-model-pack-\(UUID().uuidString)")

        var networked = WhisperKitSmallEN.Configuration(modelDirectory: missingPack)
        networked.allowsNetwork = true
        XCTAssertThrowsError(try WhisperKitSmallEN(configuration: networked)) { error in
            guard case ASRError.networkDisabled = error else {
                return XCTFail("local mode must refuse a networked transcriber, got \(error)")
            }
        }

        var offline = WhisperKitSmallEN.Configuration(modelDirectory: missingPack)
        offline.allowsNetwork = false
        XCTAssertThrowsError(try WhisperKitSmallEN(configuration: offline)) { error in
            guard case ASRError.modelPackMissing = error else {
                return XCTFail("a missing model pack must fail closed, got \(error)")
            }
        }
    }

    // MARK: - 8. A late transcription can never survive mute or a host failure

    /// `mute()` must invalidate a transcription that is already in flight: the engine result that
    /// lands afterwards is dropped instead of being committed as a final transcript.
    func testMuteDropsTranscriptionThatWasInFlight() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let transcriber = GatedTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: try SileroVAD(configuration: configuration),
            transcriber: transcriber
        )
        bridge.beginSessionForTesting()
        host.attachFrameListenerForTesting(bridge.frameListenerForTesting())
        addTeardownBlock { await bridge.close() }

        let recorder = TranscriptRecorder()
        let unsubscribe = bridge.subscribe { recorder.record($0) }
        addTeardownBlock { unsubscribe() }

        host.deliverForTesting(samples: silentSamples(packetCount: 25), startNs: 0)
        await waitUntil { transcriber.started >= 1 }
        XCTAssertGreaterThanOrEqual(transcriber.started, 1, "the engine call is in flight before mute")

        await bridge.mute()
        transcriber.open()
        try? await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertTrue(
            bridge.transcript().isEmpty,
            "mute must not commit a transcription that answers after the microphone closed"
        )
        XCTAssertFalse(
            recorder.all.contains { $0.phase == "final" },
            "no final transcript is emitted after mute"
        )
        XCTAssertEqual(bridge.status().input, "muted", "mute stays visible")
        XCTAssertEqual(host.pcmChannel.status().queuedFrames, 0, "mute leaves no queued input behind")
    }

    /// The same invalidation holds for a visible host failure: the late result is dropped, the
    /// failure state stays visible, and the widget is not handed a transcript it cannot show.
    func testHostFailureDropsTranscriptionThatWasInFlight() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let transcriber = GatedTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: try SileroVAD(configuration: configuration),
            transcriber: transcriber
        )
        bridge.beginSessionForTesting()
        host.attachFrameListenerForTesting(bridge.frameListenerForTesting())
        addTeardownBlock { await bridge.close() }

        let recorder = TranscriptRecorder()
        let unsubscribe = bridge.subscribe { recorder.record($0) }
        addTeardownBlock { unsubscribe() }

        host.deliverForTesting(samples: silentSamples(packetCount: 25), startNs: 0)
        await waitUntil { transcriber.started >= 1 }
        XCTAssertGreaterThanOrEqual(transcriber.started, 1, "the engine call is in flight before the failure")

        host.emitForTesting(.deviceRemoved(deviceId: "fixture-mic-late"))
        await waitUntil { bridge.status().error != nil }
        transcriber.open()
        try? await Task.sleep(nanoseconds: 300_000_000)

        let status = bridge.status()
        XCTAssertEqual(status.error?.code, "device_removed", "the failure stays visible")
        XCTAssertEqual(status.input, "closed", "a failed session stays closed")
        XCTAssertTrue(status.error?.message.isEmpty == false, "the visible state needs a readable message")
        XCTAssertTrue(
            bridge.transcript().isEmpty,
            "a failed session must not commit a transcription that answers after the failure"
        )
        XCTAssertFalse(
            recorder.all.contains { $0.phase == "final" },
            "no final transcript is emitted after a host failure"
        )
    }

    /// The commit boundary is one critical section: the epoch check, the planner apply and the
    /// append to `committed` cannot be split by a mute. A result that answers after the mute is
    /// rejected even though the planner owned its window right up to the reset.
    func testStaleEpochResultIsRejectedAtTheCommitBoundary() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let transcriber = RecordingTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: try SileroVAD(configuration: configuration),
            transcriber: transcriber
        )
        bridge.beginSessionForTesting()
        host.attachFrameListenerForTesting(bridge.frameListenerForTesting())
        addTeardownBlock { await bridge.close() }

        let recorder = TranscriptRecorder()
        let unsubscribe = bridge.subscribe { recorder.record($0) }
        addTeardownBlock { unsubscribe() }

        host.deliverForTesting(samples: silentSamples(packetCount: 25), startNs: 0)
        await waitUntil { !transcriber.windows.isEmpty }
        guard let window = transcriber.windows.first else {
            return XCTFail("the pipeline cut no window to invalidate")
        }
        let epoch = bridge.currentPipelineEpoch

        // Control: on the live epoch the very same window still commits, so the boundary is a
        // guard against stale work and not a blanket refusal.
        XCTAssertNotNil(
            bridge.applyEngineResult(
                epoch: epoch,
                result: ASRWindowResult(
                    text: "early",
                    words: [ASRWordTimestamp(text: "early", startMs: 0, endMs: 120)],
                    endpoint: true
                ),
                window: window,
                sealed: true
            ),
            "a result from the live epoch still commits"
        )
        XCTAssertEqual(bridge.transcript().count, 1, "the live result reached the transcript")

        await bridge.mute()
        XCTAssertEqual(bridge.status().input, "muted", "mute stays visible")
        let finalsBefore = recorder.all.filter { $0.phase == "final" }.count

        let stale = bridge.applyEngineResult(
            epoch: epoch,
            result: ASRWindowResult(
                text: "late words",
                words: [ASRWordTimestamp(text: "late", startMs: 0, endMs: 120)],
                endpoint: true
            ),
            window: window,
            sealed: true
        )
        XCTAssertNil(stale, "a result from the muted epoch is rejected at the commit boundary")
        XCTAssertEqual(bridge.transcript().count, 1, "mute keeps pending input out of the transcript")
        XCTAssertEqual(
            recorder.all.filter { $0.phase == "final" }.count,
            finalsBefore,
            "the invalidated result is never emitted as a final update"
        )
    }

    /// Mute and the capture path share one critical section: audio the tap keeps delivering while
    /// the mute runs can neither stay in the ring nor reopen a window afterwards.
    func testPacketsRacingMuteLeaveNoQueuedInput() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        let (bridge, _) = try makeBridge(host: host)
        addTeardownBlock { await bridge.close() }
        let listener = bridge.frameListenerForTesting()
        let pcm = pcmData(silentSamples(packetCount: 1))

        let pumping = Flag()
        pumping.set(true)
        let tapQueue = DispatchQueue(label: "v01.test.mute-race", attributes: .concurrent)
        tapQueue.async {
            var sequence: UInt64 = 0
            while pumping.isSet {
                listener(PCMPacket(
                    sequence: sequence,
                    monotonicNs: sequence &* PCMPacket.packetDurationNs,
                    pcm: pcm
                ))
                sequence += 1
            }
        }

        try? await Task.sleep(nanoseconds: 50_000_000)
        await bridge.mute()
        pumping.set(false)
        await Task.yield()

        XCTAssertEqual(
            bridge.status().input,
            "muted",
            "mute stays visible while the tap keeps delivering audio"
        )
        XCTAssertEqual(
            host.pcmChannel.status().queuedFrames,
            0,
            "packets that raced the mute are dropped, never left in the ring"
        )
        XCTAssertTrue(bridge.transcript().isEmpty, "the raced utterance is never committed")

        // Audio that arrives after the mute settled keeps being dropped too.
        sendPackets(25, through: listener, startingAt: 100_000)
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(
            host.pcmChannel.status().queuedFrames,
            0,
            "audio delivered after the mute stays out of the ring"
        )
        XCTAssertTrue(bridge.transcript().isEmpty, "audio delivered after the mute is never committed")
    }

    /// Mute is a capture guarantee that does not depend on the order of the widget's calls: a
    /// session muted before `start()` must not open the microphone graph when the widget starts it
    /// later, and a closed session must not be resurrected by a late `start()`. Both cases stay
    /// visible without an error state and never run the local engine.
    func testMutedOrClosedSessionNeverOpensCaptureOnLateStart() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 16)
        host.setPermissionOverrideForTesting(.granted)
        var configuration = SileroVADConfiguration()
        configuration.allowEnergyFallback = true
        let transcriber = RecordingTranscriber()
        let bridge = VoiceTracerBridge(
            host: host,
            vad: try SileroVAD(configuration: configuration),
            transcriber: transcriber
        )
        addTeardownBlock { await bridge.close() }

        await bridge.mute()
        XCTAssertEqual(bridge.status().input, "muted", "mute is visible before the session starts")
        XCTAssertNil(bridge.status().error, "mute before start is not an error state")

        let startAfterMute = Date()
        await bridge.start()
        XCTAssertLessThan(
            Date().timeIntervalSince(startAfterMute),
            2,
            "a late start settles instead of hanging the widget"
        )
        XCTAssertFalse(
            host.captureActive(),
            "a session muted before start never opens the microphone"
        )
        XCTAssertEqual(bridge.status().input, "muted", "the muted state survives a late start")
        XCTAssertNil(bridge.status().error, "a late start does not turn mute into an error state")
        XCTAssertEqual(
            host.pcmChannel.status().queuedFrames,
            0,
            "a late start leaves no queued input behind"
        )

        await bridge.close()
        await bridge.start()
        XCTAssertFalse(
            host.captureActive(),
            "a closed session is not resurrected by a late start"
        )
        XCTAssertTrue(transcriber.windows.isEmpty, "neither late start ran the local engine")
    }

    // MARK: - 9. The production path links WhisperKit and registers the Silero runtime

    /// Writes the on-disk shape of a small.en pack — the three CoreML bundles plus the
    /// tokenizer/model JSON WhisperKit loads locally — so the fail-closed pack validation can be
    /// exercised without the multi-hundred-megabyte weights. The three JSON files default to the
    /// shape the pinned pack ships; `nil` leaves the file out, which is how the incomplete-pack
    /// cases below reproduce the shapes that send WhisperKit's tokenizer loader to the Hub.
    @discardableResult
    private func writeModelPack(
        at root: URL,
        tokenizerData: String? = #"{"model":{"type":"BPE","vocab":{},"merges":[]}}"#,
        tokenizerConfig: String? = #"{"tokenizer_class":"WhisperTokenizer"}"#,
        modelConfig: String? = #"{"model_type":"whisper"}"#
    ) throws -> URL {
        let pack = root.appendingPathComponent(WhisperModelPack.englishSmall.name, isDirectory: true)
        let manager = FileManager.default
        try manager.createDirectory(at: pack, withIntermediateDirectories: true)
        for name in WhisperModelPackLayout.modelNames {
            try manager.createDirectory(
                at: pack.appendingPathComponent("\(name).mlmodelc", isDirectory: true),
                withIntermediateDirectories: true
            )
        }
        let files: [(name: String, contents: String?)] = [
            (WhisperModelPackLayout.tokenizerName, tokenizerData),
            (WhisperModelPackLayout.tokenizerConfigName, tokenizerConfig),
            (WhisperModelPackLayout.modelConfigName, modelConfig),
        ]
        for file in files {
            let url = pack.appendingPathComponent(file.name)
            guard let contents = file.contents else {
                try? manager.removeItem(at: url)
                continue
            }
            try Data(contents.utf8).write(to: url)
        }
        return pack
    }

    @discardableResult
    private func writeCompleteModelPack(at root: URL) throws -> URL {
        try writeModelPack(at: root)
    }

    private func temporaryPackRoot() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("v01-model-pack-\(UUID().uuidString)")
    }

    /// Guards the wiring the reviewer asked for: the built package links WhisperKit small.en and
    /// production code registers a Silero backend, so `transcribe(_:)` cannot fall back to
    /// `backendUnavailable` and `SileroVAD` cannot fall back to the test-only energy stand-in.
    func testProductionBootstrapLinksWhisperKitAndRegistersSileroBackend() throws {
        XCTAssertTrue(
            WhisperKitSmallEN.isBackendLinked,
            "the packaged build links WhisperKit; otherwise transcribe(_:) only throws backendUnavailable"
        )
        VoiceSessionBootstrap.registerProductionBackends()
        XCTAssertTrue(
            SileroVADBackendRegistry.hasRegisteredBackend,
            "production code registers the Silero backend before capture opens"
        )

        let packRoot = temporaryPackRoot()
        try writeCompleteModelPack(at: packRoot)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: packRoot)
        }

        let transcriber = try WhisperKitSmallEN(configuration: .init(modelDirectory: packRoot))
        XCTAssertFalse(transcriber.configuration.allowsNetwork, "the production pack stays on disk")
        XCTAssertEqual(transcriber.configuration.pack, .englishSmall)

        // A pack folder without the Silero model fails closed in the factory: the helper reports a
        // visible error instead of opening capture without a VAD backend.
        XCTAssertThrowsError(try VoiceSessionBootstrap.makeLocalSession(
            VoiceHostConfiguration(asrModelDirectory: packRoot, vadModelDirectory: packRoot)
        )) { error in
            guard case SileroVADError.modelPackMissing = error else {
                return XCTFail("expected a missing Silero pack, got \(error)")
            }
        }
    }

    // MARK: - 10. A present-but-incomplete pack fails closed instead of reaching the network

    /// WhisperKit's `loadTokenizerIfNeeded` falls back to a Hub download when `tokenizer.json` is
    /// missing or fails to load locally, even with `download: false`. The helper therefore has to
    /// reject an incomplete pack up front: every case below would otherwise send the local-only
    /// path to the network, and no capture may open around it.
    func testIncompleteWhisperPackFailsClosedBeforeCapture() throws {
        // Control: the complete layout validates, so the failures below are the specific gaps and
        // not a blanket refusal.
        let completeRoot = temporaryPackRoot()
        addTeardownBlock { try? FileManager.default.removeItem(at: completeRoot) }
        try writeCompleteModelPack(at: completeRoot)
        XCTAssertNoThrow(
            try WhisperKitSmallEN(configuration: .init(modelDirectory: completeRoot)),
            "a pack with the model bundles, tokenizer.json, tokenizer_config.json and config.json loads"
        )

        let cases: [(label: String, damage: (URL) throws -> Void)] = [
            ("missing tokenizer.json", { pack in
                try FileManager.default.removeItem(
                    at: pack.appendingPathComponent(WhisperModelPackLayout.tokenizerName)
                )
            }),
            ("corrupt tokenizer.json", { pack in
                try Data("{ not json".utf8).write(
                    to: pack.appendingPathComponent(WhisperModelPackLayout.tokenizerName)
                )
            }),
            ("tokenizer.json without a model section", { pack in
                try Data(#"{"version":"1.0"}"#.utf8).write(
                    to: pack.appendingPathComponent(WhisperModelPackLayout.tokenizerName)
                )
            }),
            ("missing AudioEncoder model", { pack in
                try FileManager.default.removeItem(
                    at: pack.appendingPathComponent("AudioEncoder.mlmodelc")
                )
            }),
            ("no tokenizer config at all", { pack in
                try FileManager.default.removeItem(
                    at: pack.appendingPathComponent(WhisperModelPackLayout.tokenizerConfigName)
                )
                try FileManager.default.removeItem(
                    at: pack.appendingPathComponent(WhisperModelPackLayout.modelConfigName)
                )
            }),
            ("only config.json, no tokenizer_config.json", { pack in
                try FileManager.default.removeItem(
                    at: pack.appendingPathComponent(WhisperModelPackLayout.tokenizerConfigName)
                )
            }),
            ("tokenizer config with no class and no model config", { pack in
                try Data("{}".utf8).write(
                    to: pack.appendingPathComponent(WhisperModelPackLayout.tokenizerConfigName)
                )
                try FileManager.default.removeItem(
                    at: pack.appendingPathComponent(WhisperModelPackLayout.modelConfigName)
                )
            }),
        ]

        for testCase in cases {
            let root = temporaryPackRoot()
            let pack = try writeCompleteModelPack(at: root)
            try testCase.damage(pack)
            XCTAssertThrowsError(
                try WhisperKitSmallEN(configuration: .init(modelDirectory: root)),
                "\(testCase.label): the pack is rejected before capture"
            ) { error in
                guard case ASRError.modelPackMissing = error else {
                    return XCTFail("\(testCase.label): expected a fail-closed pack error, got \(error)")
                }
            }
            try? FileManager.default.removeItem(at: root)
        }
    }

    // MARK: - 11. The pack check mirrors WhisperKit's local tokenizer resolution

    /// WhisperKit's `ModelUtilities.loadTokenizer` answers *every* local-load throw with a Hub
    /// download, even though `download` is false. Its local load throws before it reads a single
    /// token when the tokenizer config is absent (`missingConfig`), when neither the tokenizer
    /// config nor `config.json` resolves a class (`missingTokenizerClassInConfig`), when the class
    /// is not one its `knownTokenizers` table can build (`unsupportedTokenizer`), and when
    /// `tokenizer.json` has no vocabulary for the resolved class (`missingVocab` — and a BPE
    /// model without `merges` traps outright). Each pack below is one of those shapes, so
    /// `WhisperKitSmallEN.init` has to reject it before capture opens; the shapes WhisperKit can
    /// classify and build locally must keep validating, or the check would be a blanket refusal.
    ///
    /// The assertions also run WhisperKit's own local loader (`AutoTokenizerWrapper.from`) on the
    /// same folders: an accepted pack must load from disk, and a rejected one must be exactly the
    /// shape whose local load throws — the throw `ModelUtilities.loadTokenizer` answers with its
    /// Hub download.
    func testTokenizerResolutionMirrorsWhisperKitLocalLoader() async throws {
        typealias PackShape = (
            label: String,
            tokenizerData: String,
            tokenizerConfig: String?,
            modelConfig: String?
        )
        let bpeData = #"{"model":{"type":"BPE","vocab":{},"merges":[]}}"#

        let loadable: [PackShape] = [
            (
                "tokenizer_class names a class WhisperKit builds",
                bpeData,
                #"{"tokenizer_class":"WhisperTokenizer"}"#,
                #"{"model_type":"whisper"}"#
            ),
            (
                "WhisperKit strips the tokenizer_class Fast suffix",
                bpeData,
                #"{"tokenizer_class":"WhisperTokenizerFast"}"#,
                nil
            ),
            (
                "config.json model_type synthesizes the class",
                bpeData,
                #"{"unk_token":"<|endoftext|>"}"#,
                #"{"model_type":"whisper"}"#
            ),
        ]
        for testCase in loadable {
            let root = temporaryPackRoot()
            let pack = try writeModelPack(
                at: root,
                tokenizerData: testCase.tokenizerData,
                tokenizerConfig: testCase.tokenizerConfig,
                modelConfig: testCase.modelConfig
            )
            let loadsLocally = await WhisperModelPackLayout.localTokenizerLoads(packFolder: pack)
            XCTAssertTrue(
                loadsLocally,
                "\(testCase.label): WhisperKit's local loader reads this pack from disk"
            )
            XCTAssertNoThrow(
                try WhisperKitSmallEN(configuration: .init(modelDirectory: root)),
                "\(testCase.label): WhisperKit loads this tokenizer locally, so the pack stays valid"
            )
            try? FileManager.default.removeItem(at: root)
        }

        typealias NetworkedPack = (
            label: String,
            tokenizerData: String,
            tokenizerConfig: String?,
            modelConfig: String?,
            localLoaderThrows: Bool
        )
        // `localLoaderThrows` is false only for the BPE pack without `merges`: WhisperKit traps
        // (`fatalError`) on that shape, which a regression cannot exercise in-process.
        let networked: [NetworkedPack] = [
            (
                "only config.json, no tokenizer_config.json",
                bpeData,
                nil,
                #"{"model_type":"whisper"}"#,
                true
            ),
            (
                "tokenizer config without a class and no config.json",
                bpeData,
                #"{"unk_token":"<|endoftext|>"}"#,
                nil,
                true
            ),
            (
                "tokenizer config without a class and config.json without a model_type",
                bpeData,
                "{}",
                "{}",
                true
            ),
            (
                "empty tokenizer_class",
                bpeData,
                #"{"tokenizer_class":""}"#,
                #"{"model_type":"whisper"}"#,
                true
            ),
            (
                "tokenizer_class WhisperKit cannot build",
                bpeData,
                #"{"tokenizer_class":"NotATokenizer"}"#,
                #"{"model_type":"whisper"}"#,
                true
            ),
            (
                "config.json present but not JSON",
                bpeData,
                #"{"tokenizer_class":"WhisperTokenizer"}"#,
                "{ not json",
                true
            ),
            (
                "tokenizer.json model without merges",
                #"{"model":{"type":"BPE","vocab":{}}}"#,
                #"{"tokenizer_class":"WhisperTokenizer"}"#,
                #"{"model_type":"whisper"}"#,
                false
            ),
            (
                "tokenizer.json model without vocab",
                #"{"model":{"type":"BPE","merges":[]}}"#,
                #"{"tokenizer_class":"WhisperTokenizer"}"#,
                #"{"model_type":"whisper"}"#,
                true
            ),
        ]
        for testCase in networked {
            let root = temporaryPackRoot()
            let pack = try writeModelPack(
                at: root,
                tokenizerData: testCase.tokenizerData,
                tokenizerConfig: testCase.tokenizerConfig,
                modelConfig: testCase.modelConfig
            )
            if testCase.localLoaderThrows {
                let loadsLocally = await WhisperModelPackLayout.localTokenizerLoads(packFolder: pack)
                XCTAssertFalse(
                    loadsLocally,
                    "\(testCase.label): WhisperKit's local load throws here, so it downloads instead"
                )
            }
            XCTAssertThrowsError(
                try WhisperKitSmallEN(configuration: .init(modelDirectory: root)),
                "\(testCase.label): WhisperKit would download the tokenizer from the Hub"
            ) { error in
                guard case ASRError.modelPackMissing = error else {
                    return XCTFail("\(testCase.label): expected a fail-closed pack error, got \(error)")
                }
            }
            try? FileManager.default.removeItem(at: root)
        }
    }
}
