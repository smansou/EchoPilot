/**
 * Renderer-only projection of the voice lifecycle. No activation authority lives here.
 *
 * The renderer cannot reach the main process directly: it reads the same-origin `voice-status`
 * route and posts Enable/Disable to `voice-action` (the preload bridge stays frozen). Everything in
 * this module is a projection of what the main process reported, so a renderer compromise cannot
 * open a microphone, and a wake observation is never part of this API.
 */

export type VoiceControlState = "disabled" | "active" | "standby" | "idle" | "failed";

export interface VoiceControlSnapshot {
  state: VoiceControlState;
  enabled: boolean;
  microphoneOpen: boolean;
  conversationModelsLoaded: boolean;
  wakeModelLoaded: boolean;
  standbyEnabled: boolean;
  failure?: string;
}

export interface VoiceIndicator {
  kind: "off" | "listening" | "standby" | "error";
  label: string;
  ariaLabel: string;
  persistent: boolean;
  animated: boolean;
  tone: "neutral" | "active" | "standby" | "danger";
}

/** The measured gates behind the optional standby path, as the main process reported them. */
export interface VoiceGates {
  standbyEnergy: {
    durationMs: number;
    averageCpuPercent: number;
    wakeupsPerMinute: number;
    peakResidentMemoryMb: number;
    sampleCount: number;
    passed: boolean;
    violations: ReadonlyArray<string>;
  } | null;
  wake: {
    falseTriggers: number;
    detections: number;
    expectedDetections: number;
    corrections: number;
    exposureMs: number;
    falseTriggersPerHour: number;
    tvFalseTriggersPerHour: number;
    backgroundSpeechFalseTriggersPerHour: number;
  } | null;
  worker: string;
}

export interface VoiceControlStatus {
  snapshot: VoiceControlSnapshot;
  gates: VoiceGates;
}

/**
 * Standby is intentionally neither painted nor announced as active listening.
 * It remains persistent so the low-power microphone state is never ambient or
 * invisible to the user.
 */
export function voiceIndicator(snapshot: VoiceControlSnapshot): VoiceIndicator {
  switch (snapshot.state) {
    case "active":
      return {
        kind: "listening",
        label: "Conversation active",
        ariaLabel: "Conversation active; microphone listening",
        persistent: true,
        animated: true,
        tone: "active",
      };
    case "standby":
      return {
        kind: "standby",
        label: "Voice standby",
        ariaLabel: "Voice standby; low-power wake listening is on",
        persistent: true,
        animated: false,
        tone: "standby",
      };
    case "failed":
      return {
        kind: "error",
        label: "Voice unavailable",
        ariaLabel: `Voice unavailable${snapshot.failure ? `: ${snapshot.failure}` : ""}`,
        persistent: true,
        animated: false,
        tone: "danger",
      };
    case "idle":
    case "disabled":
      return {
        kind: "off",
        label: "Voice off",
        ariaLabel: "Voice off; microphone closed and models unloaded",
        persistent: false,
        animated: false,
        tone: "neutral",
      };
  }
}

export interface VoiceControlCommands {
  enableConversation(): void | Promise<void>;
  disableConversation(): void | Promise<void>;
}

const STATES: ReadonlyArray<VoiceControlState> = ["disabled", "active", "standby", "idle", "failed"];

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Invalid ${field} in voice status`);
  return value;
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid ${field} in voice status`);
  }
  return value;
}

function parseSnapshot(value: unknown): VoiceControlSnapshot {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid voice snapshot");
  const input = value as Record<string, unknown>;
  const state = input.state;
  if (typeof state !== "string" || !STATES.includes(state as VoiceControlState)) {
    throw new TypeError("Invalid voice state");
  }
  return {
    state: state as VoiceControlState,
    enabled: booleanField(input.enabled, "enabled"),
    microphoneOpen: booleanField(input.microphoneOpen, "microphoneOpen"),
    conversationModelsLoaded: booleanField(input.conversationModelsLoaded, "conversationModelsLoaded"),
    wakeModelLoaded: booleanField(input.wakeModelLoaded, "wakeModelLoaded"),
    standbyEnabled: booleanField(input.standbyEnabled, "standbyEnabled"),
    ...(typeof input.failure === "string" ? { failure: input.failure.slice(0, 200) } : {}),
  };
}

/** Strict parse: a stale or compromised route can never inject fields into the control panel. */
export function parseVoiceStatus(value: unknown): VoiceControlStatus {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid voice status");
  const input = value as Record<string, unknown>;
  const snapshot = parseSnapshot(input.voice);
  const energy = input.standbyEnergy;
  const wake = input.wake;
  const wakeTotal = typeof wake === "object" && wake !== null && !Array.isArray(wake)
    ? (wake as Record<string, unknown>).total
    : null;
  const wakeByEnvironment = typeof wake === "object" && wake !== null && !Array.isArray(wake)
    ? (wake as Record<string, unknown>).byEnvironment
    : null;
  const tv = typeof wakeByEnvironment === "object" && wakeByEnvironment !== null
    ? (wakeByEnvironment as Record<string, unknown>).tv
    : null;
  const background = typeof wakeByEnvironment === "object" && wakeByEnvironment !== null
    ? (wakeByEnvironment as Record<string, unknown>).background_speech
    : null;
  return {
    snapshot,
    gates: {
      standbyEnergy: typeof energy === "object" && energy !== null
        ? {
          durationMs: numberField((energy as Record<string, unknown>).durationMs, "durationMs"),
          averageCpuPercent: numberField((energy as Record<string, unknown>).averageCpuPercent, "averageCpuPercent"),
          wakeupsPerMinute: numberField((energy as Record<string, unknown>).wakeupsPerMinute, "wakeupsPerMinute"),
          peakResidentMemoryMb: numberField((energy as Record<string, unknown>).peakResidentMemoryMb, "peakResidentMemoryMb"),
          sampleCount: numberField((energy as Record<string, unknown>).sampleCount, "sampleCount"),
          passed: booleanField((energy as Record<string, unknown>).passed, "passed"),
          violations: Array.isArray((energy as Record<string, unknown>).violations)
            ? ((energy as Record<string, unknown>).violations as unknown[])
              .filter((entry): entry is string => typeof entry === "string")
            : [],
        }
        : null,
      wake: typeof wakeTotal === "object" && wakeTotal !== null
        ? {
          falseTriggers: numberField((wakeTotal as Record<string, unknown>).falseTriggers, "falseTriggers"),
          detections: numberField((wakeTotal as Record<string, unknown>).detections, "detections"),
          expectedDetections: numberField((wakeTotal as Record<string, unknown>).expectedDetections, "expectedDetections"),
          corrections: numberField((wakeTotal as Record<string, unknown>).corrections, "corrections"),
          exposureMs: numberField((wakeTotal as Record<string, unknown>).exposureMs, "exposureMs"),
          falseTriggersPerHour: numberField((wakeTotal as Record<string, unknown>).falseTriggersPerHour, "falseTriggersPerHour"),
          tvFalseTriggersPerHour: typeof tv === "object" && tv !== null
            ? numberField((tv as Record<string, unknown>).falseTriggersPerHour, "tvFalseTriggersPerHour")
            : 0,
          backgroundSpeechFalseTriggersPerHour: typeof background === "object" && background !== null
            ? numberField((background as Record<string, unknown>).falseTriggersPerHour, "backgroundSpeechFalseTriggersPerHour")
            : 0,
        }
        : null,
      worker: typeof input.worker === "string" ? input.worker.slice(0, 200) : "unknown",
    },
  };
}

/** Thin control binding: user commands only; wake candidates never enter this API. */
export class VoiceControlModel {
  readonly #commands: VoiceControlCommands;
  readonly #listeners = new Set<(status: VoiceControlStatus, indicator: VoiceIndicator) => void>();
  #status: VoiceControlStatus;

  constructor(commands: VoiceControlCommands, initial: VoiceControlStatus) {
    this.#commands = commands;
    this.#status = initial;
  }

  update(status: VoiceControlStatus): void {
    this.#status = status;
    const current = this.status();
    const indicator = this.indicator();
    for (const listener of this.#listeners) listener(current, indicator);
  }

  subscribe(listener: (status: VoiceControlStatus, indicator: VoiceIndicator) => void): () => void {
    this.#listeners.add(listener);
    listener(this.status(), this.indicator());
    return () => this.#listeners.delete(listener);
  }

  status(): VoiceControlStatus {
    return { snapshot: { ...this.#status.snapshot }, gates: { ...this.#status.gates } };
  }

  snapshot(): VoiceControlSnapshot {
    return { ...this.#status.snapshot };
  }

  indicator(): VoiceIndicator {
    return voiceIndicator(this.#status.snapshot);
  }

  enable(): void | Promise<void> {
    return this.#commands.enableConversation();
  }

  disable(): void | Promise<void> {
    return this.#commands.disableConversation();
  }
}

export interface VoiceControlPort {
  fetchStatus(): Promise<VoiceControlStatus>;
  enable(): Promise<VoiceControlStatus>;
  disable(): Promise<VoiceControlStatus>;
}

export const VOICE_DISABLED_STATUS: VoiceControlStatus = Object.freeze({
  snapshot: Object.freeze({
    state: "disabled",
    enabled: false,
    microphoneOpen: false,
    conversationModelsLoaded: false,
    wakeModelLoaded: false,
    standbyEnabled: false,
  }) as VoiceControlSnapshot,
  gates: Object.freeze({ standbyEnergy: null, wake: null, worker: "unknown" }) as VoiceGates,
});

/**
 * Same-origin port used by the widget. The response is parsed, never trusted: the route and the
 * renderer are separate trust domains.
 */
export function createHttpVoicePort(href: string = globalThis.location?.href ?? "echo://app/index.html"): VoiceControlPort {
  async function request(name: string, init?: RequestInit): Promise<VoiceControlStatus> {
    const response = await fetch(new URL(name, href), { cache: "no-store", ...init });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const reason = typeof payload === 'object' && payload !== null
        ? (payload as { error?: unknown }).error : undefined;
      throw new Error(typeof reason === 'string' ? reason : `Voice route ${name} returned ${response.status}`);
    }
    return parseVoiceStatus(payload);
  }
  return {
    fetchStatus: () => request("voice-status"),
    enable: () => request("voice-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable" }),
    }),
    disable: () => request("voice-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable" }),
    }),
  };
}

export interface ConnectedVoiceControl {
  model: VoiceControlModel;
  /** Polls the route so the indicator tracks idle teardown and standby without a UI keepalive. */
  startPolling(intervalMs?: number): () => void;
  dispose(): Promise<void>;
}

/**
 * The renderer's production entry point: the visible control drives the same lifecycle that owns
 * native capture/model state, and renders the measured gates the main process reported.
 */
export function connectVoiceControl(port: VoiceControlPort = createHttpVoicePort()): ConnectedVoiceControl {
  const model = new VoiceControlModel({
    enableConversation: async () => { model.update(await port.enable()); },
    disableConversation: async () => { model.update(await port.disable()); },
  }, VOICE_DISABLED_STATUS);
  const refresh = async (): Promise<void> => { model.update(await port.fetchStatus()); };
  void refresh().catch(() => {});
  return {
    model,
    startPolling(intervalMs = 1_500) {
      const timer = setInterval(() => { void refresh().catch(() => {}); }, intervalMs);
      return () => { clearInterval(timer); };
    },
    async dispose() {
      model.update(VOICE_DISABLED_STATUS);
    },
  };
}
