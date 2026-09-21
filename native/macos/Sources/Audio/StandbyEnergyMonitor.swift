import Foundation

/// A low-overhead accumulator used by the native standby capture path.
///
/// Production sampling can feed task CPU, wakeup and resident-memory readings;
/// tests feed the same structure deterministically. The monitor performs no
/// polling of its own, so it cannot create a standby wakeup loop.
public struct StandbyEnergySample: Sendable, Equatable {
    public let durationMs: Double
    public let cpuPercent: Double
    public let wakeups: Int
    public let residentMemoryMB: Double

    public init(durationMs: Double, cpuPercent: Double, wakeups: Int, residentMemoryMB: Double) {
        self.durationMs = durationMs
        self.cpuPercent = cpuPercent
        self.wakeups = wakeups
        self.residentMemoryMB = residentMemoryMB
    }
}

public struct StandbyEnergyBudget: Sendable, Equatable {
    public let maxAverageCPUPercent: Double
    public let maxWakeupsPerMinute: Double
    public let maxResidentMemoryMB: Double

    public init(
        maxAverageCPUPercent: Double = 2,
        maxWakeupsPerMinute: Double = 30,
        maxResidentMemoryMB: Double = 96
    ) {
        self.maxAverageCPUPercent = maxAverageCPUPercent
        self.maxWakeupsPerMinute = maxWakeupsPerMinute
        self.maxResidentMemoryMB = maxResidentMemoryMB
    }
}

public struct StandbyEnergyReport: Sendable, Equatable {
    public let durationMs: Double
    public let averageCPUPercent: Double
    public let wakeupsPerMinute: Double
    public let peakResidentMemoryMB: Double
    public let sampleCount: Int
    public let passed: Bool
}

/// Thread-safe because capture metrics and renderer reporting use different queues.
public final class StandbyEnergyMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private let budget: StandbyEnergyBudget
    private var durationMs: Double = 0
    private var weightedCPU: Double = 0
    private var wakeups: Int = 0
    private var peakMemoryMB: Double = 0
    private var samples: Int = 0

    public init(budget: StandbyEnergyBudget = StandbyEnergyBudget()) {
        self.budget = budget
    }

    public func record(_ sample: StandbyEnergySample) {
        guard sample.durationMs.isFinite, sample.durationMs > 0 else { return }
        lock.lock()
        defer { lock.unlock() }
        durationMs += sample.durationMs
        weightedCPU += max(0, sample.cpuPercent) * sample.durationMs
        wakeups += max(0, sample.wakeups)
        peakMemoryMB = max(peakMemoryMB, max(0, sample.residentMemoryMB))
        samples += 1
    }

    public func report() -> StandbyEnergyReport {
        lock.lock()
        defer { lock.unlock() }
        let averageCPU = durationMs == 0 ? 0 : weightedCPU / durationMs
        let wakeupRate = durationMs == 0 ? 0 : Double(wakeups) * 60_000 / durationMs
        return StandbyEnergyReport(
            durationMs: durationMs,
            averageCPUPercent: averageCPU,
            wakeupsPerMinute: wakeupRate,
            peakResidentMemoryMB: peakMemoryMB,
            sampleCount: samples,
            passed: averageCPU <= budget.maxAverageCPUPercent
                && wakeupRate <= budget.maxWakeupsPerMinute
                && peakMemoryMB <= budget.maxResidentMemoryMB
        )
    }
}
