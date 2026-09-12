import AVFoundation
import CoreAudio
import Foundation

/// Host events of the frozen native audio contract, forwarded to the widget session.
public enum AudioHostEvent: Sendable, Equatable {
    case permissionDenied
    case deviceRemoved(deviceId: String)
    case systemLocked
    case helperCrash(message: String)

    public var wireType: String {
        switch self {
        case .permissionDenied: return "permission_denied"
        case .deviceRemoved: return "device_removed"
        case .systemLocked: return "system_locked"
        case .helperCrash: return "helper_crash"
        }
    }

    public var jsonObject: [String: Any] {
        switch self {
        case .permissionDenied, .systemLocked, .helperCrash:
            return ["type": wireType]
        case let .deviceRemoved(deviceId):
            return ["type": wireType, "deviceId": deviceId]
        }
    }
}

public enum MicrophoneGraphError: Error, Equatable {
    case microphoneDenied
    case microphoneUnknown
    case engineStartFailed(String)
}

/// The AVAudioEngine microphone graph: 16 kHz mono Int16 packets on a monotonic clock, a bounded
/// PCM channel for the consumer, device enumeration and explicit active-session permissions.
///
/// The graph implements the same boundary the TypeScript session drives through its fake host:
/// `permission()`, `startCapture(onFrame:)`, `stopCapture()`, `captureActive()` and `onEvent(_:)`.
public final class MicrophoneGraph: @unchecked Sendable {
    public typealias FrameListener = (PCMPacket) -> Void
    public typealias EventListener = (AudioHostEvent) -> Void

    private let engine = AVAudioEngine()
    private let channel: BoundedPCMChannel
    private let stateQueue = DispatchQueue(label: "voice.audio.graph")
    private var frameListener: FrameListener?
    private var eventListeners: [UUID: EventListener] = [:]
    private var converter: AVAudioConverter?
    private var packetizer = AudioPacketizer()
    private var running = false
    private var tapInstalled = false
    private var activeInputUID: String?
    private var deviceObserver: AudioDeviceObserver?
    private var notificationTokens: [NSObjectProtocol] = []

    public init(maxQueuedFrames: Int = 100) {
        self.channel = BoundedPCMChannel(maxQueuedFrames: maxQueuedFrames)
    }

    public var pcmChannel: BoundedPCMChannel { channel }

    public func permission() -> MicrophonePermission {
        MicrophonePermissionProbe.current()
    }

    public func enumerateInputDevices() throws -> [AudioInputDevice] {
        try AudioDeviceEnumerator.inputDevices()
    }

    public func captureActive() -> Bool {
        stateQueue.sync { running }
    }

    /// Starts capture. A denied microphone never opens the graph; an undetermined one is asked
    /// explicitly as part of this active session before anything is opened.
    public func startCapture(onFrame: @escaping FrameListener) async throws {
        stateQueue.sync { frameListener = onFrame }
        switch MicrophonePermissionProbe.current() {
        case .denied:
            emit(.permissionDenied)
            throw MicrophoneGraphError.microphoneDenied
        case .unknown:
            guard await MicrophonePermissionProbe.request() == .granted else {
                emit(.permissionDenied)
                throw MicrophoneGraphError.microphoneDenied
            }
        case .granted:
            break
        }
        try startEngine()
    }

    public func stopCapture() async {
        releaseCapture()
    }

    /// Releases capture without ever holding `stateQueue` while the engine is touched.
    ///
    /// Removing a tap (and stopping the engine) waits for an in-flight audio-tap block, and that
    /// block takes `stateQueue.sync` at its start: holding the state lock across `removeTap` /
    /// `engine.stop()` would deadlock mute, failure-stop and lock-stop while audio is flowing.
    private func releaseCapture() {
        let hadTap: Bool? = stateQueue.sync {
            guard running || tapInstalled else { return nil }
            let installed = tapInstalled
            running = false
            tapInstalled = false
            return installed
        }
        guard let hadTap else { return }
        if hadTap { engine.inputNode.removeTap(onBus: 0) }
        engine.stop()
        clearSessionState()
    }

    /// Drops the per-session state once the engine is released. Only short mutations stay under
    /// `stateQueue`, so the tap path can always take the lock and finish.
    private func clearSessionState() {
        let observer: AudioDeviceObserver? = stateQueue.sync {
            converter = nil
            packetizer.reset()
            frameListener = nil
            channel.clear()
            let current = deviceObserver
            deviceObserver = nil
            return current
        }
        observer?.stop()
        let tokens: [NSObjectProtocol] = stateQueue.sync {
            let current = notificationTokens
            notificationTokens.removeAll()
            return current
        }
        for token in tokens { DistributedNotificationCenter.default().removeObserver(token) }
    }

    /// The parent process calls this when the helper exits; a crash is a visible widget state.
    public func reportHelperCrash(_ message: String) async {
        emit(.helperCrash(message: message))
        await stopCapture()
    }

    @discardableResult
    public func onEvent(_ listener: @escaping EventListener) -> () -> Void {
        let token = UUID()
        stateQueue.sync { eventListeners[token] = listener }
        return { [weak self] in
            guard let self else { return }
            self.stateQueue.sync { self.eventListeners[token] = nil }
        }
    }

    private func startEngine() throws {
        let alreadyRunning = stateQueue.sync { running }
        if alreadyRunning { return }
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw MicrophoneGraphError.engineStartFailed("no capture-capable input device")
        }
        guard
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Double(PCMPacket.sampleRate),
                channels: AVAudioChannelCount(PCMPacket.channels),
                interleaved: true
            ),
            let converter = AVAudioConverter(from: inputFormat, to: target)
        else {
            throw MicrophoneGraphError.engineStartFailed("cannot build the 16 kHz mono converter")
        }

        let activeUID = try? AudioDeviceEnumerator.defaultInputDevice()?.uid
        stateQueue.sync {
            self.converter = converter
            self.packetizer.reset()
            self.activeInputUID = activeUID
        }

        input.installTap(
            onBus: 0,
            bufferSize: AVAudioFrameCount(PCMPacket.samplesPerPacket * 4),
            format: inputFormat
        ) { [weak self] buffer, when in
            self?.handle(buffer: buffer, at: when)
        }
        stateQueue.sync { tapInstalled = true }

        observeSystemEvents()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            releaseCapture()
            throw MicrophoneGraphError.engineStartFailed(String(describing: error))
        }
        stateQueue.sync { running = true }
    }

    private func handle(buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        let currentConverter = stateQueue.sync { converter }
        let captureRunning = stateQueue.sync { running }
        guard let converter = currentConverter, captureRunning else { return }
        let target = converter.outputFormat
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var provided = false
        var conversionError: NSError?
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if provided {
                outStatus.pointee = AVAudioConverterInputStatus.noDataNow
                return nil
            }
            provided = true
            outStatus.pointee = AVAudioConverterInputStatus.haveData
            return buffer
        }
        let status = converter.convert(to: output, error: &conversionError, withInputFrom: inputBlock)
        guard
            status != AVAudioConverterOutputStatus.error,
            output.frameLength > 0,
            let samples = output.int16ChannelData?[0]
        else { return }

        let startNs = time.isHostTimeValid
            ? AudioHostClock.nanoseconds(fromHostTime: time.hostTime)
            : AudioHostClock.nowNs()
        deliver(samples: samples, count: Int(output.frameLength), startNs: startNs)
    }

    /// Re-chunks converted samples into 20 ms packets and hands each packet to the frame listener
    /// exactly once. The listener owns the transport ring (`VoiceTracerBridge.blockingEnqueue`), so
    /// the graph must not enqueue a second copy: doing so doubled every packet in the ring, halved
    /// its capacity and made the ASR windows/endpoints advance at twice the real audio rate.
    private func deliver(samples: UnsafePointer<Int16>, count: Int, startNs: UInt64) {
        var emitted: [PCMPacket] = []
        stateQueue.sync {
            packetizer.append(samples: samples, count: count, startNs: startNs) { packet in
                emitted.append(packet)
            }
        }
        guard let listener = stateQueue.sync(execute: { frameListener }) else { return }
        for packet in emitted { listener(packet) }
    }

    // MARK: - Test seams

    /// Installs the session frame listener exactly like `startCapture(_:)` does, without asking for
    /// permission or opening a device. Used by the V01 native pipeline regression.
    func attachFrameListenerForTesting(_ listener: @escaping FrameListener) {
        stateQueue.sync { frameListener = listener }
    }

    /// Pushes already-converted 16 kHz mono Int16 samples through the same packetizer + listener
    /// path the audio tap uses.
    func deliverForTesting(samples: [Int16], startNs: UInt64 = 0) {
        guard !samples.isEmpty else { return }
        samples.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            deliver(samples: base, count: buffer.count, startNs: startNs)
        }
    }

    private func observeSystemEvents() {
        if deviceObserver == nil {
            let activeUID = stateQueue.sync { activeInputUID }
            deviceObserver = try? AudioDeviceObserver { [weak self] devices in
                guard let self else { return }
                if let activeUID, !devices.contains(where: { $0.uid == activeUID }) {
                    self.emit(.deviceRemoved(deviceId: activeUID))
                    Task { await self.stopCapture() }
                }
            }
        }
        if notificationTokens.isEmpty {
            let locked = DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name("com.apple.screenIsLocked"),
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                self.emit(.systemLocked)
                Task { await self.stopCapture() }
            }
            notificationTokens.append(locked)
        }
    }

    private func emit(_ event: AudioHostEvent) {
        let listeners = stateQueue.sync { Array(eventListeners.values) }
        for listener in listeners { listener(event) }
    }
}
