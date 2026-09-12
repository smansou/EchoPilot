//
// V01 native pipeline regression — the helper's acceptance path must hand every PCM packet to the
// ASR consumer exactly once, and no ASR window may exceed 15 s.
//
// The tests drive `MicrophoneGraph` + `VoiceTracerBridge` through the same packetizer/frame-listener
// path the audio tap uses, without asking for microphone permission or opening a device. Build and
// run with (see Audio/README.md):
//
//   swiftc -module-cache-path "$(mktemp -d)" -o /tmp/v01-native-tests \
//     native/macos/Sources/Audio/*.swift native/macos/Sources/ASR/*.swift \
//     native/macos/Sources/Audio/Tests/main.swift && /tmp/v01-native-tests
//
// This directory is test-only: the signed helper target must compile Sources/Audio and Sources/ASR
// without it.
import Foundation

var failureCount = 0

func check(_ condition: Bool, _ name: String) {
    if condition {
        print("PASS \(name)")
    } else {
        failureCount += 1
        print("FAIL \(name)")
    }
}

/// A strictly increasing ramp: a duplicated packet repeats values, a dropped packet skips them.
func rampSamples(packetCount: Int) -> [Int16] {
    let total = packetCount * PCMPacket.samplesPerPacket
    var samples = [Int16](repeating: 0, count: total)
    for index in 0..<total { samples[index] = Int16(index % 30_000) }
    return samples
}

func silentSamples(packetCount: Int) -> [Int16] {
    [Int16](repeating: 0, count: packetCount * PCMPacket.samplesPerPacket)
}

func pcmData(_ samples: [Int16]) -> Data {
    samples.withUnsafeBufferPointer { Data(buffer: $0) }
}

func int16Samples(_ data: Data) -> [Int16] {
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

final class RecordingTranscriber: LocalTranscriber, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [ASRWindow] = []

    private func record(_ window: ASRWindow) {
        lock.lock()
        recorded.append(window)
        lock.unlock()
    }

    var windows: [ASRWindow] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func transcribe(_ window: ASRWindow) async throws -> ASRWindowResult {
        record(window)
        return ASRWindowResult(text: "", words: [], endpoint: false)
    }
}

// MARK: - 1. One producer into the bounded ring

// With the shipped bridge, `MicrophoneGraph` must hand each packet to the frame listener once and
// never enqueue its own second copy: two producers doubled every packet, halved the ring's
// capacity and made the VAD/planner advance at twice the real audio rate.
let graphOnly = MicrophoneGraph(maxQueuedFrames: 64)
var observedSequences: [UInt64] = []
graphOnly.attachFrameListenerForTesting { packet in observedSequences.append(packet.sequence) }
graphOnly.deliverForTesting(samples: rampSamples(packetCount: 20), startNs: 1_000_000)

check(
    observedSequences == (0..<20).map(UInt64.init),
    "frame listener receives each of the 20 packets exactly once, in order"
)
check(
    graphOnly.pcmChannel.status().queuedFrames == 0,
    "MicrophoneGraph does not enqueue a second copy of the packet into the ring"
)

// MARK: - 2. Graph + bridge: each packet reaches the VAD/planner exactly once

let host = MicrophoneGraph(maxQueuedFrames: 64)
var vadConfiguration = SileroVADConfiguration()
vadConfiguration.allowEnergyFallback = true
let vad = try SileroVAD(configuration: vadConfiguration)
let transcriber = RecordingTranscriber()
let planner = ASRWindowPlanner()
let bridge = VoiceTracerBridge(host: host, vad: vad, transcriber: transcriber, planner: planner)
bridge.beginSessionForTesting()
host.attachFrameListenerForTesting(bridge.frameListenerForTesting())
host.deliverForTesting(samples: rampSamples(packetCount: 20), startNs: 9_000_000)

let drainDeadline = Date().addingTimeInterval(5)
while transcriber.windows.isEmpty, Date() < drainDeadline {
    try? await Task.sleep(nanoseconds: 10_000_000)
}

let firstWindow = transcriber.windows.first
check(firstWindow != nil, "the bridge transcribed the first 400 ms window")
if let firstWindow {
    let samples = int16Samples(firstWindow.pcm)
    check(
        firstWindow.pcm.count == 20 * PCMPacket.samplesPerPacket * 2,
        "the first window holds exactly 20 packets of PCM (no duplicated audio)"
    )
    var contiguous = samples.count == 20 * PCMPacket.samplesPerPacket
    if contiguous {
        for index in 0..<samples.count where samples[index] != Int16(index) {
            contiguous = false
            break
        }
    }
    check(contiguous, "the window PCM is one in-order ramp: every packet arrived exactly once")
}
check(host.pcmChannel.status().queuedFrames == 0, "the ring drains to empty once the consumer runs")
check(host.pcmChannel.status().discontinuityCount == 0, "exactly-once delivery drops no audio")

// MARK: - 3. Mute settles and clears pending input

let muteStart = Date()
await bridge.mute()
check(Date().timeIntervalSince(muteStart) < 2, "mute settles without hanging the widget")
check(host.pcmChannel.status().queuedFrames == 0, "mute clears pending audio")

// The tap path keeps delivering while the stop runs. Releasing capture must never hold the state
// lock across `removeTap`/`engine.stop()` (those wait for an in-flight tap block, and the tap block
// takes the state lock), or mute/lock/device-removal stops would hang the widget.
final class Flag: @unchecked Sendable {
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

let flowing = MicrophoneGraph(maxQueuedFrames: 16)
let keepDelivering = Flag()
keepDelivering.set(true)
let tapQueue = DispatchQueue(label: "v01.test.audio-tap", attributes: .concurrent)
tapQueue.async {
    while keepDelivering.isSet {
        flowing.deliverForTesting(samples: silentSamples(packetCount: 1), startNs: 0)
    }
}
let stopStart = Date()
await flowing.stopCapture()
let stopDuration = Date().timeIntervalSince(stopStart)
keepDelivering.set(false)
check(stopDuration < 2, "stopCapture settles while the tap path keeps delivering audio")

// MARK: - 4. One oversized packet can never open a window past 15 s

let boundPlanner = ASRWindowPlanner()
let oversized = PCMPacket(
    sequence: 0,
    monotonicNs: 0,
    pcm: pcmData(rampSamples(packetCount: 800)) // 16 s in one packet
)
var emittedWindows: [ASRWindow] = []
var oversizedPackets: [PCMPacket] = [oversized]
for index in 1...60 {
    oversizedPackets.append(PCMPacket(
        sequence: UInt64(index),
        monotonicNs: 16_000_000_000 + UInt64(index) * 20_000_000,
        pcm: pcmData(silentSamples(packetCount: 1))
    ))
}
for packet in oversizedPackets {
    guard let event = boundPlanner.append(packet: packet) else { continue }
    switch event {
    case let .partial(window), let .seal(window): emittedWindows.append(window)
    }
}
check(!emittedWindows.isEmpty, "the oversized packet still produced ASR windows")
check(
    emittedWindows.allSatisfy { $0.durationMs <= 15_000.0 },
    "no ASR window exceeds ASR_MAX_WINDOW_MS = 15 s"
)

if failureCount > 0 {
    print("\(failureCount) check(s) failed")
    exit(1)
}
print("all native V01 pipeline checks passed")
