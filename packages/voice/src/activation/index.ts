/**
 * Hands-free conversation activation and standby lifecycle.
 *
 * Wake detection is deliberately kept on the attention side of the trust
 * boundary.  It may reopen a conversation, but its result can never be used as
 * an action grant (see `WakeOutcome.actionAuthorized`).
 */

export type ActivationState = "disabled" | "active" | "standby" | "idle" | "failed";
export type AcousticEnvironment = "quiet" | "background_speech" | "tv" | "other";

export interface ActivationClock {
  now(): number;
}

export interface ActivationHost {
  openMicrophone(mode: "conversation" | "standby"): void | Promise<void>;
  closeMicrophone(): void | Promise<void>;
  loadConversationModels(): void | Promise<void>;
  unloadConversationModels(): void | Promise<void>;
  loadWakeModel(): void | Promise<void>;
  unloadWakeModel(): void | Promise<void>;
}

export interface StandbyEnergySample {
  durationMs: number;
  cpuPercent: number;
  wakeups: number;
  residentMemoryMb?: number;
}

export interface StandbyEnergyBudget {
  maxAverageCpuPercent: number;
  maxWakeupsPerMinute: number;
  maxResidentMemoryMb: number;
}

export interface StandbyEnergyReport {
  durationMs: number;
  averageCpuPercent: number;
  wakeupsPerMinute: number;
  peakResidentMemoryMb: number;
  sampleCount: number;
  passed: boolean;
  violations: string[];
}

export const DEFAULT_STANDBY_ENERGY_BUDGET: Readonly<StandbyEnergyBudget> = Object.freeze({
  maxAverageCpuPercent: 2,
  maxWakeupsPerMinute: 30,
  maxResidentMemoryMb: 96,
});

/** A duration-weighted, deterministic energy gate for the optional standby path. */
export class StandbyEnergyMeter {
  readonly #budget: StandbyEnergyBudget;
  #durationMs = 0;
  #weightedCpu = 0;
  #wakeups = 0;
  #peakMemory = 0;
  #sampleCount = 0;

  constructor(budget: StandbyEnergyBudget = DEFAULT_STANDBY_ENERGY_BUDGET) {
    this.#budget = { ...budget };
  }

  record(sample: StandbyEnergySample): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs <= 0) return;
    const cpu = finiteNonNegative(sample.cpuPercent);
    const wakeups = finiteNonNegative(sample.wakeups);
    const memory = finiteNonNegative(sample.residentMemoryMb ?? 0);
    this.#durationMs += sample.durationMs;
    this.#weightedCpu += cpu * sample.durationMs;
    this.#wakeups += wakeups;
    this.#peakMemory = Math.max(this.#peakMemory, memory);
    this.#sampleCount += 1;
  }

  report(): StandbyEnergyReport {
    const averageCpuPercent = this.#durationMs === 0 ? 0 : this.#weightedCpu / this.#durationMs;
    const wakeupsPerMinute = this.#durationMs === 0 ? 0 : this.#wakeups * 60_000 / this.#durationMs;
    const violations: string[] = [];
    if (averageCpuPercent > this.#budget.maxAverageCpuPercent) violations.push("average_cpu");
    if (wakeupsPerMinute > this.#budget.maxWakeupsPerMinute) violations.push("wakeups_per_minute");
    if (this.#peakMemory > this.#budget.maxResidentMemoryMb) violations.push("resident_memory");
    return {
      durationMs: this.#durationMs,
      averageCpuPercent,
      wakeupsPerMinute,
      peakResidentMemoryMb: this.#peakMemory,
      sampleCount: this.#sampleCount,
      passed: violations.length === 0,
      violations,
    };
  }
}

export interface WakeObservation {
  environment: AcousticEnvironment;
  /** Time represented by this observation; used to report false triggers/hour. */
  durationMs: number;
  detected: boolean;
  /** True only for a labeled, intentional wake phrase in a test or user correction. */
  expectedWake: boolean;
}

export interface WakeEnvironmentReport {
  exposureMs: number;
  detections: number;
  expectedDetections: number;
  falseTriggers: number;
  falseTriggersPerHour: number;
}

export interface WakeFalseTriggerReport {
  total: WakeEnvironmentReport;
  byEnvironment: Record<AcousticEnvironment, WakeEnvironmentReport>;
}

type MutableWakeCounts = { exposureMs: number; detections: number; expectedDetections: number; falseTriggers: number };

/** Reports labeled false wakes, including separate TV and background-speech rates. */
export class WakeFalseTriggerMeter {
  readonly #counts: Record<AcousticEnvironment, MutableWakeCounts> = {
    quiet: emptyWakeCounts(),
    background_speech: emptyWakeCounts(),
    tv: emptyWakeCounts(),
    other: emptyWakeCounts(),
  };

  record(observation: WakeObservation): void {
    const counts = this.#counts[observation.environment];
    counts.exposureMs += finiteNonNegative(observation.durationMs);
    if (!observation.detected) return;
    counts.detections += 1;
    if (observation.expectedWake) counts.expectedDetections += 1;
    else counts.falseTriggers += 1;
  }

  report(): WakeFalseTriggerReport {
    const total = emptyWakeCounts();
    const byEnvironment = {} as Record<AcousticEnvironment, WakeEnvironmentReport>;
    for (const environment of ["quiet", "background_speech", "tv", "other"] as const) {
      const counts = this.#counts[environment];
      total.exposureMs += counts.exposureMs;
      total.detections += counts.detections;
      total.expectedDetections += counts.expectedDetections;
      total.falseTriggers += counts.falseTriggers;
      byEnvironment[environment] = wakeReport(counts);
    }
    return { total: wakeReport(total), byEnvironment };
  }
}

export interface WakeCandidate {
  confidence: number;
  threshold?: number;
  environment: AcousticEnvironment;
  observationMs?: number;
  expectedWake?: boolean;
}

export interface WakeOutcome {
  detected: boolean;
  conversationActivated: boolean;
  /** A frozen false literal: attention and authorization are separate boundaries. */
  actionAuthorized: false;
  requiresExplicitActionConfirmation: true;
}

export interface ActivationSnapshot {
  state: ActivationState;
  enabled: boolean;
  microphoneOpen: boolean;
  conversationModelsLoaded: boolean;
  wakeModelLoaded: boolean;
  standbyEnabled: boolean;
  lastActivityAt: number | null;
  failure?: string;
}

export interface ConversationActivationOptions {
  host: ActivationHost;
  clock?: ActivationClock;
  idleTimeoutMs?: number;
  standby?: boolean;
  wakeThreshold?: number;
  falseTriggerMeter?: WakeFalseTriggerMeter;
  energyMeter?: StandbyEnergyMeter;
}

const systemClock: ActivationClock = { now: () => Date.now() };

/**
 * Owns the microphone/model lifecycle after one explicit enable operation.
 * Meaningful speech/activity renews the session; UI interaction is never
 * required, so a 20-minute exchange is not capped by a wall-clock lease.
 */
export class ConversationActivationController {
  readonly #host: ActivationHost;
  readonly #clock: ActivationClock;
  readonly #idleTimeoutMs: number;
  readonly #standbyEnabled: boolean;
  readonly #wakeThreshold: number;
  readonly falseTriggers: WakeFalseTriggerMeter;
  readonly standbyEnergy: StandbyEnergyMeter;
  readonly #listeners = new Set<(snapshot: ActivationSnapshot) => void>();
  #state: ActivationState = "disabled";
  #enabled = false;
  #microphoneOpen = false;
  #conversationModelsLoaded = false;
  #wakeModelLoaded = false;
  #lastActivityAt: number | null = null;
  #failure: string | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: ConversationActivationOptions) {
    this.#host = options.host;
    this.#clock = options.clock ?? systemClock;
    this.#idleTimeoutMs = positive(options.idleTimeoutMs, 60_000);
    this.#standbyEnabled = options.standby ?? false;
    this.#wakeThreshold = clamp(options.wakeThreshold ?? 0.8, 0, 1);
    this.falseTriggers = options.falseTriggerMeter ?? new WakeFalseTriggerMeter();
    this.standbyEnergy = options.energyMeter ?? new StandbyEnergyMeter();
  }

  snapshot(): ActivationSnapshot {
    return {
      state: this.#state,
      enabled: this.#enabled,
      microphoneOpen: this.#microphoneOpen,
      conversationModelsLoaded: this.#conversationModelsLoaded,
      wakeModelLoaded: this.#wakeModelLoaded,
      standbyEnabled: this.#standbyEnabled,
      lastActivityAt: this.#lastActivityAt,
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    };
  }

  subscribe(listener: (snapshot: ActivationSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  enable(): Promise<void> {
    return this.#serialize(async () => {
      this.#enabled = true;
      if (this.#state === "active") return;
      await this.#enterActive();
    });
  }

  /** Records speech, playback or an in-conversation event; no UI keepalive is involved. */
  noteActivity(at = this.#clock.now()): void {
    if (this.#state !== "active") return;
    this.#lastActivityAt = at;
    this.#publish();
  }

  /** Called from a cheap scheduler; performs idle teardown at most once. */
  tick(at = this.#clock.now()): Promise<void> {
    return this.#serialize(async () => {
      if (this.#state !== "active" || this.#lastActivityAt === null) return;
      if (at - this.#lastActivityAt < this.#idleTimeoutMs) return;
      if (this.#standbyEnabled) await this.#enterStandby();
      else await this.#enterIdle();
    });
  }

  observeStandbyEnergy(sample: StandbyEnergySample): void {
    if (this.#state === "standby") this.standbyEnergy.record(sample);
  }

  detectWake(candidate: WakeCandidate): Promise<WakeOutcome> {
    const threshold = clamp(candidate.threshold ?? this.#wakeThreshold, 0, 1);
    // A malformed score must never be promoted into a wake. The detector is an
    // attention signal only, but accepting an out-of-range value could still
    // unexpectedly reopen the microphone and conversation models.
    const confidenceIsValid = Number.isFinite(candidate.confidence)
      && candidate.confidence >= 0
      && candidate.confidence <= 1;
    const detected = this.#enabled
      && this.#state === "standby"
      && confidenceIsValid
      && candidate.confidence >= threshold;
    this.falseTriggers.record({
      environment: candidate.environment,
      durationMs: candidate.observationMs ?? 0,
      detected,
      expectedWake: candidate.expectedWake ?? false,
    });
    let activated = false;
    return this.#serialize(async () => {
      // State can change between recognition and this queued operation (for
      // example, the user can disable voice). Recheck the trust boundary at
      // execution time so a stale wake cannot turn capture back on.
      if (detected && this.#enabled && this.#state === "standby") {
        await this.#enterActive();
        activated = true;
      }
    }).then(() => ({
      detected,
      conversationActivated: activated,
      actionAuthorized: false as const,
      requiresExplicitActionConfirmation: true as const,
    }));
  }

  disable(): Promise<void> {
    return this.#serialize(async () => {
      this.#enabled = false;
      await this.#closeMicrophone();
      await this.#unloadConversationModels();
      await this.#unloadWakeModel();
      this.#lastActivityAt = null;
      this.#state = "disabled";
      this.#failure = undefined;
      this.#publish();
    });
  }

  async #enterActive(): Promise<void> {
    try {
      await this.#closeMicrophone();
      await this.#unloadWakeModel();
      if (!this.#conversationModelsLoaded) {
        await this.#host.loadConversationModels();
        this.#conversationModelsLoaded = true;
      }
      await this.#host.openMicrophone("conversation");
      this.#microphoneOpen = true;
      this.#state = "active";
      this.#lastActivityAt = this.#clock.now();
      this.#failure = undefined;
      this.#publish();
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async #enterIdle(): Promise<void> {
    try {
      await this.#closeMicrophone();
      await this.#unloadConversationModels();
      await this.#unloadWakeModel();
      this.#state = "idle";
      this.#lastActivityAt = null;
      this.#publish();
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async #enterStandby(): Promise<void> {
    try {
      await this.#closeMicrophone();
      await this.#unloadConversationModels();
      if (!this.#wakeModelLoaded) {
        await this.#host.loadWakeModel();
        this.#wakeModelLoaded = true;
      }
      await this.#host.openMicrophone("standby");
      this.#microphoneOpen = true;
      this.#state = "standby";
      this.#lastActivityAt = null;
      this.#publish();
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async #closeMicrophone(): Promise<void> {
    if (!this.#microphoneOpen) return;
    await this.#host.closeMicrophone();
    this.#microphoneOpen = false;
  }

  async #unloadConversationModels(): Promise<void> {
    if (!this.#conversationModelsLoaded) return;
    await this.#host.unloadConversationModels();
    this.#conversationModelsLoaded = false;
  }

  async #unloadWakeModel(): Promise<void> {
    if (!this.#wakeModelLoaded) return;
    await this.#host.unloadWakeModel();
    this.#wakeModelLoaded = false;
  }

  async #fail(error: unknown): Promise<void> {
    // Best-effort teardown keeps a partial activation from retaining capture/models.
    try { await this.#closeMicrophone(); } catch {}
    try { await this.#unloadConversationModels(); } catch {}
    try { await this.#unloadWakeModel(); } catch {}
    this.#state = "failed";
    this.#failure = error instanceof Error ? error.message : String(error);
    this.#publish();
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.#pending.then(operation, operation);
    this.#pending = next.catch(() => {});
    return next;
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function emptyWakeCounts(): MutableWakeCounts {
  return { exposureMs: 0, detections: 0, expectedDetections: 0, falseTriggers: 0 };
}

function wakeReport(counts: MutableWakeCounts): WakeEnvironmentReport {
  return {
    ...counts,
    falseTriggersPerHour: counts.exposureMs === 0 ? 0 : counts.falseTriggers * 3_600_000 / counts.exposureMs,
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
