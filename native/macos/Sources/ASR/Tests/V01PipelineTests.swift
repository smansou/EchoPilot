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

    // MARK: - 3. Mute settles and clears pending input

    func testMuteSettlesAndClearsPendingAudio() async throws {
        let host = MicrophoneGraph(maxQueuedFrames: 64)
        let (bridge, _) = try makeBridge(host: host)
        addTeardownBlock { await bridge.close() }

        host.deliverForTesting(samples: silentSamples(packetCount: 4), startNs: 0)
        let muteStart = Date()
        await bridge.mute()
        XCTAssertLessThan(
            Date().timeIntervalSince(muteStart),
            2,
            "mute settles without hanging the widget"
        )
        XCTAssertEqual(host.pcmChannel.status().queuedFrames, 0, "mute clears pending audio")
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
}
