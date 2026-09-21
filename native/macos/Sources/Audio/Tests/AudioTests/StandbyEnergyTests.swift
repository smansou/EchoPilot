import XCTest

@testable import Audio

/// The standby gate is only meaningful if its numbers are measured, so these tests exercise the
/// same pieces the signed helper runs: the sampler reads this process's own kernel counters, the
/// detector scores real PCM packets, and the monitor turns both into the report the widget shows.
final class StandbyEnergyTests: XCTestCase {
    // MARK: - Detector

    private func packet(
        amplitude: Double,
        frequency: Double = 440,
        silenceRatio: Double = 0,
        spikeAmplitude: Double = 0,
        sequence: UInt64 = 0
    ) -> PCMPacket {
        let count = 320
        var samples = [Int16](repeating: 0, count: count)
        for index in 0..<count {
            let position = Double(index) / Double(count)
            let carrier = sin(2 * Double.pi * frequency * Double(index) / 16_000)
            let value: Double
            if spikeAmplitude > 0, silenceRatio > 0, position < silenceRatio {
                value = spikeAmplitude * (carrier >= 0 ? 1 : -1)
            } else {
                value = amplitude * carrier
            }
            samples[index] = Int16(max(-32_768, min(32_767, (value * 32_767).rounded())))
        }
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        return PCMPacket(sequence: sequence, monotonicNs: 0, pcm: data)
    }

    func testSilentWindowIsQuietExposureAndNoDetection() {
        var detector = StandbyWakeDetector(threshold: 0.8)
        let window = detector.finishWindow(durationMs: 2_500)
        XCTAssertEqual(window.environment, "quiet")
        XCTAssertFalse(window.detected)
        XCTAssertEqual(window.confidence, 0, accuracy: 0.001)
        XCTAssertEqual(window.durationMs, 2_500, accuracy: 0.5)
    }

    func testSteadyLoudProgramAudioIsMeasuredAsTvWithoutClaimingAWake() {
        var detector = StandbyWakeDetector(threshold: 0.8)
        for index in 0..<125 {
            detector.ingest(packet(amplitude: 0.1, sequence: UInt64(index)))
        }
        let window = detector.finishWindow(durationMs: 2_500)
        XCTAssertEqual(window.environment, "tv")
        XCTAssertFalse(window.detected, "a TV at conversational level must not cross the wake gate")
        XCTAssertGreaterThan(window.confidence, 0.6)
    }

    func testDistantSpeechIsLabeledBackgroundSpeechFromItsCrestFactor() {
        var detector = StandbyWakeDetector(threshold: 0.8)
        for index in 0..<125 {
            detector.ingest(packet(amplitude: 0.001, silenceRatio: 0.03, spikeAmplitude: 0.08, sequence: UInt64(index)))
        }
        let window = detector.finishWindow(durationMs: 2_500)
        XCTAssertEqual(window.environment, "background_speech")
        XCTAssertFalse(window.detected)
    }

    func testLoudNearFieldAudioCrossesTheGateAsAttentionOnly() {
        var detector = StandbyWakeDetector(threshold: 0.8)
        for index in 0..<125 {
            detector.ingest(packet(amplitude: 1.0, sequence: UInt64(index)))
        }
        let window = detector.finishWindow(durationMs: 2_500)
        XCTAssertTrue(window.detected)
        XCTAssertEqual(window.threshold, 0.8, accuracy: 0.001)
        // The detector exposes a decision to the app; the app is what has to keep it action-free.
        XCTAssertEqual(window.environment, "tv")
    }

    func testWindowResetsSoOneLoudWindowCannotBleedIntoTheNext() {
        var detector = StandbyWakeDetector(threshold: 0.8)
        detector.ingest(packet(amplitude: 1.0))
        XCTAssertTrue(detector.finishWindow(durationMs: 2_500).detected)
        XCTAssertEqual(detector.finishWindow(durationMs: 2_500).environment, "quiet")
    }

    // MARK: - Gate

    func testMonitorReportsTheBudgetEntriesATraceCrossed() {
        let monitor = StandbyEnergyMonitor()
        monitor.record(StandbyEnergySample(durationMs: 1_000, cpuPercent: 4, wakeups: 100, residentMemoryMB: 20))
        let report = monitor.report()
        XCTAssertFalse(report.passed)
        XCTAssertEqual(report.violations, ["average_cpu", "wakeups_per_minute"])
        XCTAssertEqual(report.averageCPUPercent, 4, accuracy: 0.001)
        XCTAssertEqual(report.wakeupsPerMinute, 6_000, accuracy: 1)
    }

    func testMonitorPassesAWithinBudgetTraceAndWeightsCpuByDuration() {
        let monitor = StandbyEnergyMonitor()
        monitor.record(StandbyEnergySample(durationMs: 60_000, cpuPercent: 0.4, wakeups: 20, residentMemoryMB: 50))
        let report = monitor.report()
        XCTAssertTrue(report.passed, "\(report)")
        XCTAssertEqual(report.violations, [])
        XCTAssertEqual(report.averageCPUPercent, 0.4, accuracy: 0.001)
        XCTAssertEqual(report.wakeupsPerMinute, 20, accuracy: 0.5)
        XCTAssertEqual(report.sampleCount, 1)
    }

    // MARK: - Sampler

    func testSamplerMeasuresThisProcessCPUAndFootprint() {
        let sampler = StandbyEnergySampler()
        var accumulator = 0.0
        let deadline = Date().addingTimeInterval(0.3)
        while Date() < deadline {
            accumulator += accumulator.squareRoot() + 1
        }
        XCTAssertGreaterThan(accumulator, 0)
        let sample = sampler.sample()
        XCTAssertGreaterThan(sample.durationMs, 0)
        XCTAssertGreaterThan(sample.cpuPercent, 0, "CPU time is read from the kernel, not assumed")
        XCTAssertGreaterThan(sample.residentMemoryMB, 0, "the memory reading is this process's footprint")
        XCTAssertGreaterThanOrEqual(sample.wakeups, 0)
    }

    func testSamplerReportsKernelWakeupsForItsOwnTimer() {
        let sampler = StandbyEnergySampler()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "audio.test.standby"))
        timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
        timer.setEventHandler {}
        timer.resume()
        Thread.sleep(forTimeInterval: 0.7)
        timer.cancel()
        let sample = sampler.sample()
        XCTAssertGreaterThanOrEqual(sample.durationMs, 500)
        XCTAssertGreaterThanOrEqual(sample.wakeups, 1, "macOS charges the standby loop's timer wakeups to the process")
    }

    func testResetRebaselinesSoAClosedStandbyCycleIsNotChargedToTheNext() {
        let sampler = StandbyEnergySampler()
        Thread.sleep(forTimeInterval: 0.25)
        sampler.reset()
        let sample = sampler.sample()
        XCTAssertLessThan(sample.durationMs, 200)
    }
}
