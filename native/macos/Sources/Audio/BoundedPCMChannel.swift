import Foundation

/// The bounded transport ring between the microphone tap (producer) and the local ASR consumer.
///
/// Contract (V01 acceptance: "audio buffers stay bounded during a stalled consumer"):
///   - `enqueue` never blocks and never grows the ring past `maxQueuedFrames`;
///   - overflow drops the oldest audio, counts one discontinuity and marks the ASR state dirty so
///     the consumer resets its window instead of splicing non-contiguous audio;
///   - `drain` delivers packets and the discontinuity marker outside the lock, so a consumer that
///     enqueues again can never deadlock the producer.
public final class BoundedPCMChannel: @unchecked Sendable {
    public struct Status: Sendable, Equatable {
        public let queuedFrames: Int
        public let droppedFrames: Int
        public let discontinuityCount: Int
    }

    private let limit: Int
    private let lock = NSLock()
    private var ring: [PCMPacket] = []
    private var droppedFrames = 0
    private var discontinuityCount = 0
    private var discontinuityDirty = false
    private var onPacket: ((PCMPacket) -> Void)?
    private var onDiscontinuity: (() -> Void)?

    public init(maxQueuedFrames: Int) {
        self.limit = max(1, maxQueuedFrames)
    }

    public var maxQueuedFrames: Int { limit }

    /// Wires the ASR consumer. `onDiscontinuity` fires before the packets that follow the gap.
    public func setConsumer(
        onPacket: @escaping (PCMPacket) -> Void,
        onDiscontinuity: @escaping () -> Void
    ) {
        lock.lock()
        defer { lock.unlock() }
        self.onPacket = onPacket
        self.onDiscontinuity = onDiscontinuity
    }

    public func clearConsumer() {
        lock.lock()
        defer { lock.unlock() }
        onPacket = nil
        onDiscontinuity = nil
    }

    /// Returns `false` when the packet forced an overflow drop.
    @discardableResult
    public func enqueue(_ packet: PCMPacket) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        var overflowed = false
        if ring.count >= limit {
            ring.removeFirst()
            droppedFrames += 1
            overflowed = true
            if !discontinuityDirty {
                discontinuityDirty = true
                discontinuityCount += 1
            }
        }
        ring.append(packet)
        return !overflowed
    }

    /// Drains up to `maximum` packets to the consumer (all of them by default).
    public func drain(maximum: Int = .max) {
        var batch: [PCMPacket] = []
        var pendingDiscontinuity = false
        lock.lock()
        let count = min(maximum, ring.count)
        if count > 0 {
            batch = Array(ring.prefix(count))
            ring.removeFirst(count)
        }
        if discontinuityDirty {
            pendingDiscontinuity = true
            discontinuityDirty = false
        }
        let consumer = onPacket
        let discontinuity = onDiscontinuity
        lock.unlock()

        if pendingDiscontinuity { discontinuity?() }
        guard let consumer else { return }
        for packet in batch { consumer(packet) }
    }

    /// Drops queued audio (mute, failure, or session close) without touching the counters.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        ring.removeAll(keepingCapacity: false)
        discontinuityDirty = false
    }

    public func status() -> Status {
        lock.lock()
        defer { lock.unlock() }
        return Status(
            queuedFrames: ring.count,
            droppedFrames: droppedFrames,
            discontinuityCount: discontinuityCount
        )
    }
}
