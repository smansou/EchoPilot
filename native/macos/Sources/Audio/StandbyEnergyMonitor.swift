import Darwin
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
    /// The exact budget entries this trace crossed; empty exactly when `passed` is true.
    public let violations: [String]
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
        var violations: [String] = []
        if averageCPU > budget.maxAverageCPUPercent { violations.append("average_cpu") }
        if wakeupRate > budget.maxWakeupsPerMinute { violations.append("wakeups_per_minute") }
        if peakMemoryMB > budget.maxResidentMemoryMB { violations.append("resident_memory") }
        return StandbyEnergyReport(
            durationMs: durationMs,
            averageCPUPercent: averageCPU,
            wakeupsPerMinute: wakeupRate,
            peakResidentMemoryMB: peakMemoryMB,
            sampleCount: samples,
            passed: violations.isEmpty,
            violations: violations
        )
    }
}

/// Measures this process's own standby footprint from the kernel's counters.
///
/// The standby host must not guess its energy: every reading is a delta of the `proc_pid_rusage`
/// numbers macOS keeps for the process — CPU time, physical footprint, and the wakeups the system
/// charged to it between two samples. A standby loop that wakes too often therefore produces a
/// real violation instead of a configured one, and the same readings feed the gate that is
/// reported to the widget.
///
/// Sampling is caller-driven: `sample()` never polls on its own, so the monitor cannot create the
/// wakeup loop it is measuring.
public final class StandbyEnergySampler: @unchecked Sendable {
    /// One instantaneous kernel reading, in the units the gate needs.
    public struct Reading: Sendable, Equatable {
        public let cpuMs: Double
        public let footprintMB: Double
        public let wakeups: Int

        public init(cpuMs: Double, footprintMB: Double, wakeups: Int) {
            self.cpuMs = cpuMs
            self.footprintMB = footprintMB
            self.wakeups = wakeups
        }
    }

    private let lock = NSLock()
    private var previous: Reading
    private var previousWallMs: Double
    private let clock: @Sendable () -> Double

    /// `clock` is the caller's monotonic-ish millisecond clock, so a suspend/resume shows up as a
    /// long, low-CPU window instead of a hidden gap; tests can inject a deterministic one.
    public init(clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1_000 }) {
        self.clock = clock
        self.previous = StandbyEnergySampler.reading()
        self.previousWallMs = clock()
    }

    /// The process counters right now. Returns zeros if the kernel refuses the query.
    public static func reading() -> Reading {
        var info = rusage_info_v6()
        let result = withUnsafeMutablePointer(to: &info) { pointer -> Int32 in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { rebound in
                proc_pid_rusage(getpid(), RUSAGE_INFO_V6, rebound)
            }
        }
        guard result == 0 else { return Reading(cpuMs: 0, footprintMB: 0, wakeups: 0) }
        return Reading(
            cpuMs: (Double(info.ri_user_time) + Double(info.ri_system_time)) / 1_000_000,
            footprintMB: Double(info.ri_phys_footprint) / (1024 * 1024),
            wakeups: Int(info.ri_interrupt_wkups &+ info.ri_pkg_idle_wkups)
        )
    }

    /// The delta since the previous call, ready for `StandbyEnergyMonitor.record(_:)`.
    public func sample() -> StandbyEnergySample {
        lock.lock()
        defer { lock.unlock() }
        let nowMs = clock()
        let durationMs = max(1, nowMs - previousWallMs)
        let current = StandbyEnergySampler.reading()
        let cpuMs = max(0, current.cpuMs - previous.cpuMs)
        let wakeups = max(0, current.wakeups - previous.wakeups)
        previous = current
        previousWallMs = nowMs
        return StandbyEnergySample(
            durationMs: durationMs,
            cpuPercent: cpuMs / durationMs * 100,
            wakeups: wakeups,
            residentMemoryMB: current.footprintMB
        )
    }

    /// Re-baselines the counters so the first sample of a new standby session covers that session
    /// only, instead of charging it for everything the process did while standby was closed.
    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        previous = StandbyEnergySampler.reading()
        previousWallMs = clock()
    }
}
