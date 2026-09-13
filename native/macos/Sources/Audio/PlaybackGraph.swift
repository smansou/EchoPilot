import AVFoundation
import Foundation

/// One frame of locally synthesized speech as it enters the output device queue.
///
/// This is the same shape the TypeScript playback session writes (`PlaybackFrame` in
/// `packages/voice/src/playback/index.ts`): 20 ms of little-endian Int16 PCM in the session's
/// declared output format, stamped with the generation epoch that produced it.
public struct PlaybackFrame: Sendable, Equatable {
    public let epoch: Int
    public let planId: String
    public let segmentId: String
    /// Position of the frame inside its segment; replay restarts the count under a fresh epoch.
    public let sequence: Int
    public let sampleRate: Double
    public let channels: Int
    public let pcm: Data

    public init(
        epoch: Int,
        planId: String,
        segmentId: String,
        sequence: Int,
        sampleRate: Double,
        channels: Int,
        pcm: Data
    ) {
        self.epoch = epoch
        self.planId = planId
        self.segmentId = segmentId
        self.sequence = sequence
        self.sampleRate = sampleRate
        self.channels = channels
        self.pcm = pcm
    }

    public var durationMs: Double {
        guard sampleRate > 0, channels > 0 else { return 0 }
        let samples = Double(pcm.count) / Double(channels * 2)
        return samples / sampleRate * 1_000
    }

    public var jsonObject: [String: Any] {
        [
            "epoch": epoch,
            "planId": planId,
            "segmentId": segmentId,
            "sequence": sequence,
            "sampleRate": sampleRate,
            "channels": channels,
            "pcm": pcm.base64EncodedString(),
        ]
    }
}

/// What the device actually rendered, per segment. Generated-but-unheard audio never appears here,
/// so the widget never reports a sentence as spoken because the worker happened to be fast.
public struct PlaybackProgress: Sendable, Equatable {
    public let epoch: Int
    public let planId: String
    public let segmentId: String
    public let renderedMs: Double

    public init(epoch: Int, planId: String, segmentId: String, renderedMs: Double) {
        self.epoch = epoch
        self.planId = planId
        self.segmentId = segmentId
        self.renderedMs = renderedMs
    }

    public var jsonObject: [String: Any] {
        [
            "epoch": epoch,
            "planId": planId,
            "segmentId": segmentId,
            "renderedMs": renderedMs,
        ]
    }
}

/// The format the session opens the device queue with; frames must match it.
public struct PlaybackFormat: Sendable, Equatable {
    public let sampleRate: Double
    public let channels: Int

    public init(sampleRate: Double, channels: Int) {
        self.sampleRate = sampleRate
        self.channels = channels
    }
}

public enum PlaybackGraphError: Error, Equatable {
    case unsupportedFormat(String)
    case engineStartFailed(String)
}

/// The native playback boundary: an `AVAudioPlayerNode` device queue with a generation epoch.
///
/// Contract (V02 acceptance: "cancel prevents all late frames from an old epoch from becoming
/// audible"):
///   - `write` schedules one frame and reports progress from the player's `.dataPlayedBack`
///     completion, which fires only after the device rendered that buffer;
///   - `flush` stops the node, which discards every buffer that was queued but not yet rendered —
///     cancel is a device operation, not a race with the producer;
///   - `interrupt(epoch:)` adopts a newer generation and drops anything older, so a worker that
///     produces a frame after the cancel writes into an epoch the device no longer accepts;
///   - `staleFrameCount` makes the drops observable instead of silent.
///
/// The engine is touched only on the state queue, and progress listeners are always invoked from
/// that queue, so the widget's callbacks never observe a half-applied flush.
public final class PlaybackGraph: @unchecked Sendable {
    public typealias ProgressListener = (PlaybackProgress) -> Void

    private struct SegmentKey: Hashable {
        let epoch: Int
        let planId: String
        let segmentId: String
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let stateQueue = DispatchQueue(label: "voice.audio.playback")
    private var opened = false
    private var bufferFormat: AVAudioFormat?
    private var currentEpoch = 0
    /// Bumped on every flush/interrupt; a completion handler from an older generation is ignored.
    private var flushGeneration = 0
    private var renderedMs: [SegmentKey: Double] = [:]
    private var listeners: [UUID: ProgressListener] = [:]
    private var staleFrames = 0

    public init() {}

    /// Frames dropped because they belonged to a superseded epoch or did not match the format.
    public var staleFrameCount: Int { stateQueue.sync { staleFrames } }

    public func isOpen() -> Bool { stateQueue.sync { opened } }

    /// Opens the output device with the session's declared format and starts the queue.
    public func open(format: PlaybackFormat) throws {
        try stateQueue.sync {
            guard !opened else { return }
            guard format.sampleRate > 0, format.channels > 0 else {
                throw PlaybackGraphError.unsupportedFormat(
                    "the playback format needs a positive sample rate and channel count"
                )
            }
            guard let pcmFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: format.sampleRate,
                channels: AVAudioChannelCount(format.channels),
                interleaved: true
            ) else {
                throw PlaybackGraphError.unsupportedFormat(
                    "no Int16 PCM format for \(format.sampleRate) Hz / \(format.channels) channels"
                )
            }
            bufferFormat = pcmFormat
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: pcmFormat)
            engine.prepare()
            do {
                try engine.start()
            } catch {
                engine.disconnectNodeOutput(player)
                engine.detach(player)
                bufferFormat = nil
                throw PlaybackGraphError.engineStartFailed("the output device did not start: \(error)")
            }
            player.play()
            opened = true
        }
    }

    /// Queues one frame. Returns `false` — audibly a no-op — when the frame is stale or malformed.
    @discardableResult
    public func write(_ frame: PlaybackFrame) -> Bool {
        stateQueue.sync {
            guard opened, let format = bufferFormat else { return false }
            guard frame.epoch >= currentEpoch else {
                staleFrames += 1
                return false
            }
            // Epochs only move forward: the first frame of a newer generation closes the older one,
            // so a late frame from a cancelled plan is dropped even if the caller forgot to
            // announce the interrupt explicitly.
            currentEpoch = frame.epoch
            guard frame.sampleRate == format.sampleRate,
                  frame.channels == Int(format.channelCount),
                  let buffer = makeBuffer(frame, format: format)
            else {
                staleFrames += 1
                return false
            }
            let key = SegmentKey(epoch: frame.epoch, planId: frame.planId, segmentId: frame.segmentId)
            let durationMs = frame.durationMs
            let generation = flushGeneration
            player.scheduleBuffer(
                buffer,
                at: nil,
                options: [],
                completionCallbackType: .dataPlayedBack
            ) { [weak self] _ in
                self?.reportRendered(key, durationMs: durationMs, generation: generation)
            }
            return true
        }
    }

    /// Adopts a newer generation and drops everything still queued for the older ones.
    public func interrupt(epoch: Int) {
        stateQueue.sync {
            currentEpoch = max(currentEpoch, epoch)
            guard opened else { return }
            flushGeneration += 1
            // `stop` discards the buffers that were scheduled but never rendered; `play` keeps the
            // node ready for the next epoch instead of restarting the whole engine graph.
            player.stop()
            player.play()
        }
    }

    /// Drops queued audio without changing the epoch (the session's own cancel path).
    public func flush() {
        stateQueue.sync {
            guard opened else { return }
            flushGeneration += 1
            player.stop()
            player.play()
        }
    }

    public func close() {
        stateQueue.sync {
            guard opened else { return }
            opened = false
            flushGeneration += 1
            player.stop()
            engine.stop()
            engine.disconnectNodeOutput(player)
            engine.detach(player)
            bufferFormat = nil
            listeners.removeAll()
            renderedMs.removeAll()
        }
    }

    /// Registers a rendered-progress listener; the returned closure removes it.
    @discardableResult
    public func onProgress(_ listener: @escaping ProgressListener) -> () -> Void {
        let identifier = UUID()
        stateQueue.sync { listeners[identifier] = listener }
        return { [weak self] in
            guard let self else { return }
            self.stateQueue.async { self.listeners.removeValue(forKey: identifier) }
        }
    }

    /// Rendered cursor of one segment, in milliseconds; 0 for audio that never became audible.
    public func renderedMs(epoch: Int, planId: String, segmentId: String) -> Double {
        stateQueue.sync {
            renderedMs[SegmentKey(epoch: epoch, planId: planId, segmentId: segmentId)] ?? 0
        }
    }

    private func makeBuffer(_ frame: PlaybackFrame, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frames = frame.pcm.count / (frame.channels * 2)
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channelData = buffer.int16ChannelData
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        frame.pcm.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            channelData[0].update(from: base.assumingMemoryBound(to: Int16.self), count: frames)
        }
        return buffer
    }

    /// Called by the player once a buffer has been rendered; a stale generation is ignored so a
    /// flushed buffer can never be mistaken for audio the user heard.
    private func reportRendered(_ key: SegmentKey, durationMs: Double, generation: Int) {
        stateQueue.async { [weak self] in
            guard let self, generation == self.flushGeneration else { return }
            let rendered = (self.renderedMs[key] ?? 0) + durationMs
            self.renderedMs[key] = rendered
            let progress = PlaybackProgress(
                epoch: key.epoch,
                planId: key.planId,
                segmentId: key.segmentId,
                renderedMs: rendered
            )
            for listener in self.listeners.values { listener(progress) }
        }
    }
}
