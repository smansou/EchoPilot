/**
 * V05 production wiring for the hands-free lifecycle.
 *
 * This is the module that makes the activation package reachable from the product:
 *
 *   widget / hotkey  →  Shell.sendVoiceCommand / runtime.enable()
 *   runtime          →  ActivationHost calls on the local voice worker and the signed helper
 *   helper frames    →  VoiceActivationHost observations (energy samples, acoustic windows)
 *   measurements     →  VoiceActivationReportSink (JSONL telemetry + the widget's status route)
 *
 * The lifecycle itself stays in `packages/voice/src/activation`; this file only supplies the real
 * host and the real reporting consumer. Nothing in the wake path can authorize an action: a wake
 * observation reaches `ConversationActivationController.detectWake`, whose outcome carries the
 * frozen `actionAuthorized: false`.
 */
import {
  createConversationActivationRuntime,
  DEFAULT_STANDBY_ENERGY_BUDGET,
  StandbyEnergyMeter,
  type ConversationActivationRuntime,
  type StandbyEnergyReport,
  type StandbyEnergySample,
  type VoiceActivationHost,
  type WakeCandidate,
  type WakeFalseTriggerReport,
} from '../../../../packages/voice/src/activation';
import {
  voiceSnapshotFrom,
  type NativeResult,
  type Shell,
  type VoiceSnapshot,
  type VoiceWireObservation,
} from './shell';
import { createVoiceTelemetrySink, type VoiceTelemetrySink } from './voice-telemetry';
import { createVoiceWorkerHost, resolveVoiceWorkerCommand, type VoiceWorkerHost } from './voice-worker';

export type VoiceActivationServiceOptions = Readonly<{
  /** Helper command plane; `createShell` owns the authenticated ack correlation. */
  shell: Shell;
  /** JSONL target for the standby/wake measurements (the durable report). */
  telemetryPath: string;
  env?: NodeJS.ProcessEnv;
  tickIntervalMs?: number;
  /** Test seam: the deterministic 20-minute timeline does not sleep for 20 real minutes. */
  clock?: { now(): number };
  log?(message: string): void;
}>;

export type VoiceStatus = Readonly<{
  voice: VoiceSnapshot;
  /** Duration-weighted standby energy gate over every real sampler reading. */
  standbyEnergy: StandbyEnergyReport;
  /** Measured TV / background-speech false triggers with their exposure denominator. */
  wake: WakeFalseTriggerReport;
  worker: string;
}>;

export type VoiceActivationService = Readonly<{
  runtime: ConversationActivationRuntime;
  worker: VoiceWorkerHost;
  telemetry: VoiceTelemetrySink;
  /** Routes one authenticated helper observation into the live lifecycle. */
  handleObservation(observation: VoiceWireObservation): void;
  /**
   * Subscribes the lifecycle to the shell's authenticated helper frames; `index.ts` calls this once
   * so the production path and the deterministic test share the same wiring.
   */
  attachNativeHost(nativeHost: {
    onFrame(listener: (frame: { result: NativeResult }) => void): () => void;
  }): () => void;
  enable(): Promise<void>;
  disable(): Promise<void>;
  status(): VoiceStatus;
  dispose(): Promise<void>;
}>;

function booleanFromEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function positiveNumberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The standby energy gate is measured, not configured away: the CPU and wakeup entries keep the
 * product budgets no matter what, so a standby loop that really burns CPU or wakes too often still
 * fails. Only the resident-memory entry can be restated (`ECHOPILOT_STANDBY_MEMORY_BUDGET_MB`),
 * because that entry describes the process running the loop — the signed helper is a small native
 * process, while a dev stand-in on Node starts near 90 MB. The same knob is read by the helper
 * (`native/macos/Sources/PlatformHost`) and by the stand-in, so every gate in the chain judges the
 * one measured trace against the same budget.
 */
function standbyEnergyMeterFromEnv(env: NodeJS.ProcessEnv): StandbyEnergyMeter {
  return new StandbyEnergyMeter({
    ...DEFAULT_STANDBY_ENERGY_BUDGET,
    maxResidentMemoryMb: positiveNumberFromEnv(
      env.ECHOPILOT_STANDBY_MEMORY_BUDGET_MB,
      DEFAULT_STANDBY_ENERGY_BUDGET.maxResidentMemoryMb,
    ),
  });
}

export function createVoiceActivationService(options: VoiceActivationServiceOptions): VoiceActivationService {
  const { shell } = options;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const telemetry = createVoiceTelemetrySink({ path: options.telemetryPath, log });
  const worker = createVoiceWorkerHost({
    command: resolveVoiceWorkerCommand(env),
    // The worker inherits the service's environment: the app passes its own `process.env`, and the
    // deterministic test injects the stand-in worker's knobs the same way the helper receives them.
    env,
    ...(env.ECHOPILOT_ASR_MODEL_DIR === undefined ? {} : { modelDir: env.ECHOPILOT_ASR_MODEL_DIR }),
    ...(env.ECHOPILOT_SILERO_MODEL_DIR === undefined ? {} : { sileroModelDir: env.ECHOPILOT_SILERO_MODEL_DIR }),
    log,
  });

  const activityListeners = new Set<(at?: number) => void>();
  const energyListeners = new Set<(sample: StandbyEnergySample, native?: StandbyEnergyReport) => void>();
  const wakeListeners = new Set<(candidate: WakeCandidate) => void>();

  function emitActivity(): void {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* activity consumers are best-effort */ }
    }
  }

  function emitStandbyEnergy(sample: StandbyEnergySample, native?: StandbyEnergyReport): void {
    for (const listener of energyListeners) {
      try { listener(sample, native); } catch { /* sampling consumers are best-effort */ }
    }
  }

  function emitWakeCandidate(candidate: WakeCandidate): void {
    for (const listener of wakeListeners) {
      try { listener(candidate); } catch { /* the wake path is attention-only and never fatal */ }
    }
  }

  /** A lifecycle step must not silently succeed when the helper refused the command. */
  async function command(name: Parameters<Shell['sendVoiceCommand']>[0], params?: { mode?: 'conversation' | 'standby' }): Promise<void> {
    const outcome = await shell.sendVoiceCommand(name, params);
    if (!outcome.ok) throw new Error(outcome.reason ?? `The signed voice helper rejected '${name}'.`);
  }

  const host: VoiceActivationHost = {
    async openMicrophone(mode) {
      if (mode === 'conversation') {
        // Conversation capture is the local voice worker: it owns the ASR pack and the graph.
        await worker.load();
        await worker.openMicrophone();
        return;
      }
      // Standby capture belongs to the signed helper, so the always-on wake listener does not hold
      // the conversation pack (or the conversation process) resident.
      await worker.unload();
      await command('load-wake-model');
      await command('open-microphone', { mode: 'standby' });
    },
    async closeMicrophone() {
      await worker.unload();
      await command('close-microphone');
    },
    async loadConversationModels() {
      await worker.load();
    },
    async unloadConversationModels() {
      await worker.unload();
    },
    async loadWakeModel() {
      await command('load-wake-model');
    },
    async unloadWakeModel() {
      await command('unload-wake-model');
    },
    onActivity(listener) {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
    onStandbyEnergy(listener) {
      energyListeners.add(listener);
      return () => { energyListeners.delete(listener); };
    },
    onWakeCandidate(listener) {
      wakeListeners.add(listener);
      return () => { wakeListeners.delete(listener); };
    },
  };

  // Transcript frames are the conversation's own activity: talking keeps a 20-minute exchange
  // alive without a single UI interaction.
  const stopActivity = worker.onActivity(emitActivity);
  const stopFailure = worker.onFailure((message) => log(`voice worker failure: ${message}`));

  const runtime = createConversationActivationRuntime({
    host,
    reports: telemetry,
    energyMeter: standbyEnergyMeterFromEnv(env),
    ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(env.ECHOPILOT_VOICE_IDLE_MS === undefined ? {} : { idleTimeoutMs: Number(env.ECHOPILOT_VOICE_IDLE_MS) }),
    standby: booleanFromEnv(env.ECHOPILOT_VOICE_STANDBY),
  });

  const stopMirror = runtime.subscribe((snapshot) => { shell.publishVoice(voiceSnapshotFrom(snapshot)); });

  function handleObservation(observation: VoiceWireObservation): void {
    if (observation.kind === 'standby-energy') {
      const sample: StandbyEnergySample = {
        durationMs: observation.sample.durationMs,
        cpuPercent: observation.sample.cpuPercent,
        wakeups: observation.sample.wakeups,
        ...(observation.sample.residentMemoryMb === null ? {} : { residentMemoryMb: observation.sample.residentMemoryMb }),
      };
      const native: StandbyEnergyReport = {
        durationMs: observation.report.durationMs,
        averageCpuPercent: observation.report.averageCpuPercent,
        wakeupsPerMinute: observation.report.wakeupsPerMinute,
        peakResidentMemoryMb: observation.report.peakResidentMemoryMb,
        sampleCount: observation.report.sampleCount,
        passed: observation.report.passed,
        violations: [...observation.report.violations],
      };
      emitStandbyEnergy(sample, native);
      return;
    }
    // Every acoustic window is reported, including the ones the detector ignored: that window is
    // the exposure denominator, so "false triggers per hour" is measured rather than assumed.
    emitWakeCandidate({
      confidence: observation.confidence,
      threshold: observation.threshold,
      environment: observation.environment,
      observationMs: observation.durationMs,
      detected: observation.detected,
      expectedWake: false,
    });
  }

  let disposed = false;
  return {
    runtime,
    worker,
    telemetry,
    handleObservation,
    attachNativeHost(nativeHost) {
      return nativeHost.onFrame(({ result }) => {
        if (result.ok && 'observation' in result) handleObservation(result.observation);
      });
    },
    enable: () => runtime.enable(),
    disable: () => runtime.disable(),
    status: () => ({
      voice: shell.voiceSnapshot(),
      standbyEnergy: runtime.controller.standbyEnergy.report(),
      wake: runtime.controller.falseTriggers.report(),
      worker: worker.describe(),
    }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopActivity();
      stopFailure();
      stopMirror();
      await runtime.dispose();
      worker.dispose();
      await telemetry.flush();
    },
  };
}
