/** Renderer-only projection of the voice lifecycle. No activation authority lives here. */

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

/** Thin control binding: user commands only; wake candidates never enter this API. */
export class VoiceControlModel {
  readonly #commands: VoiceControlCommands;
  #snapshot: VoiceControlSnapshot;

  constructor(commands: VoiceControlCommands, initial: VoiceControlSnapshot) {
    this.#commands = commands;
    this.#snapshot = initial;
  }

  update(snapshot: VoiceControlSnapshot): void {
    this.#snapshot = snapshot;
  }

  snapshot(): VoiceControlSnapshot {
    return { ...this.#snapshot };
  }

  indicator(): VoiceIndicator {
    return voiceIndicator(this.#snapshot);
  }

  enable(): void | Promise<void> {
    return this.#commands.enableConversation();
  }

  disable(): void | Promise<void> {
    return this.#commands.disableConversation();
  }
}
