/**
 * V05 production reason sink for the standby/wake measurements.
 *
 * The activation package hands every measured reading to this sink: each raw standby sample (with
 * the signed helper's own gate next to it), the accumulated energy report, the wake false-trigger
 * report, and every wake outcome. Records are appended as JSON lines under the app's user-data
 * directory, so "the energy test passed" and "TV speech produced N false triggers/hour" are
 * auditable after the fact instead of living only in the memory of the process that measured them.
 *
 * The in-memory copy is kept for the deterministic tests and for the tray/widget summary; the file
 * is the durable artifact.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  StandbyEnergyReport,
  StandbyEnergySample,
  VoiceActivationReportSink,
  WakeFalseTriggerReport,
  WakeOutcome,
} from '../../../../packages/voice/src/activation';

export type VoiceTelemetryRecord =
  | Readonly<{ kind: 'standby-sample'; at: string; sample: StandbyEnergySample; native: StandbyEnergyReport | null }>
  | Readonly<{ kind: 'standby-report'; at: string; report: StandbyEnergyReport }>
  | Readonly<{ kind: 'wake-report'; at: string; report: WakeFalseTriggerReport }>
  | Readonly<{ kind: 'wake-outcome'; at: string; outcome: WakeOutcome }>;

export type VoiceTelemetrySink = VoiceActivationReportSink & Readonly<{
  records(): ReadonlyArray<VoiceTelemetryRecord>;
  /** Resolves once every record so far has reached the file. */
  flush(): Promise<void>;
}>;

export type VoiceTelemetryOptions = Readonly<{
  /** JSONL target; parent directories are created on first write. */
  path: string;
  now?(): number;
  log?(message: string): void;
}>;

export function createVoiceTelemetrySink(options: VoiceTelemetryOptions): VoiceTelemetrySink {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const records: VoiceTelemetryRecord[] = [];
  let writes: Promise<void> = Promise.resolve();
  let directoryReady = false;

  function append(record: VoiceTelemetryRecord): void {
    records.push(record);
    writes = writes.then(async () => {
      try {
        if (!directoryReady) {
          await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
          directoryReady = true;
        }
        await appendFile(options.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      } catch (error) {
        // Telemetry must never break the lifecycle it observes.
        log(`voice telemetry write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  function stamp(): string {
    return new Date(now()).toISOString();
  }

  return {
    reportStandbySample(sample, native) {
      append({ kind: 'standby-sample', at: stamp(), sample: { ...sample }, native: native ? { ...native } : null });
    },
    reportStandbyEnergy(report) {
      append({ kind: 'standby-report', at: stamp(), report: { ...report, violations: [...report.violations] } });
      log(`voice standby energy: ${report.passed ? 'within budget' : `over budget (${report.violations.join(', ')})`}`
        + ` averageCpu=${report.averageCpuPercent.toFixed(2)}% wakeupsPerMinute=${report.wakeupsPerMinute.toFixed(1)}`
        + ` peakMemoryMb=${report.peakResidentMemoryMb.toFixed(0)} samples=${report.sampleCount}`);
    },
    reportWakeFalseTriggers(report) {
      append({ kind: 'wake-report', at: stamp(), report: structuredClone(report) });
      log('voice wake false triggers: '
        + `tv=${report.byEnvironment.tv.falseTriggers}/${report.byEnvironment.tv.detections}`
        + ` backgroundSpeech=${report.byEnvironment.background_speech.falseTriggers}/${report.byEnvironment.background_speech.detections}`
        + ` exposureMinutes=${(report.total.exposureMs / 60_000).toFixed(1)}`
        + ` corrections=${report.total.corrections}`);
    },
    reportWakeOutcome(outcome) {
      append({ kind: 'wake-outcome', at: stamp(), outcome: { ...outcome } });
    },
    records: () => records.map((record) => structuredClone(record)),
    flush: () => writes,
  };
}
