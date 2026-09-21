/**
 * Widget-side desktop context runtime (C01).
 *
 * The widget conversation owns the C01 "what is this?" path: a question typed in the widget is
 * answered on the `widget` surface, without Mission Control. The grounded behavior itself lives in
 * `packages/desktop-tools/src/context/index.ts`; this module is the renderer host that connects the
 * desktop shell's scoped runtime (native bridge, project-scoped memory, reasoner) to it, and adds
 * the two pieces a renderer can honestly own:
 *
 *   - attention: a local playback gate that mirrors the companion's mute flag. It issues a lease
 *     only while the companion is audible, so a muted widget can never speak; when the shell
 *     connects its own attention policy, that policy is used instead.
 *   - voice: playback through the platform speech synthesizer, submitted only with a live lease.
 *
 * The shell connects its runtime by installing a host on the window; until it does, the widget
 * stays at limited context and says so. It never invents screen state, and no capture is fabricated
 * from mocks — the interactive hardware qualification is the signed helper's job.
 */
import type {
  Attention,
  Memory,
  Reasoner,
  Scope,
  SpeechLease,
  SpeechPlan,
  VoiceOutputEvent,
} from '../../../../../packages/contracts/src/index.js';
import {
  createDesktopContextService,
  type DesktopAnswer,
  type DesktopBridge,
} from '../../../../../packages/desktop-tools/src/context/index.js';

/** The §5.3 playback seam the desktop service submits SpeechPlans to. */
export type DesktopVoice = Readonly<{
  submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>>;
}>;

/**
 * Everything the widget needs to answer a scoped desktop question. `bridge`, `memory`, `reasoner`
 * and `scope` come from the desktop shell; attention/voice/now fall back to the widget's own
 * implementations when the shell does not supply them.
 */
export type DesktopContextHost = Readonly<{
  bridge: DesktopBridge;
  memory: Memory;
  reasoner: Reasoner;
  /** The explicit project association; memory is never queried without `projectId`. */
  scope: Scope;
  excludedBundleIds?: ReadonlyArray<string>;
  now?: () => Date;
  attention?: Attention;
  voice?: DesktopVoice;
}>;

declare global {
  interface Window {
    /** Installed by the desktop shell when the scoped desktop runtime is connected. */
    __echoPilotDesktopContextHost?: DesktopContextHost;
  }
}

/** The honest sentence shown while no scoped runtime is connected: no screen, no guessing. */
export const UNCONNECTED_CONTEXT_TEMPLATE = "Desktop context isn't connected in this build, "
  + "so I can't read the foreground window. I won't guess about what's on screen.";

const UNCONNECTED_REASON =
  'The desktop shell has not connected a scoped desktop runtime (native bridge, project memory, reasoner).';
const UNCONNECTED_APP_NAME = 'the foreground window';

/**
 * The local attention gate: a lease exists only while the companion is audible, and it stops being
 * live once revoked or past its expiry. `now` is the same clock the service computed the expiry
 * with, so a fake clock in an injected runtime is judged consistently.
 */
export function createWidgetAttention(
  isMuted: () => boolean,
  now: () => Date = () => new Date(),
): Attention {
  const issued = new Set<SpeechLease>();
  let epoch = 0;
  return {
    requestSpeech(eventId: string, expiresAt: string): SpeechLease | null {
      if (isMuted()) return null;
      epoch += 1;
      const lease: SpeechLease = { eventId, epoch, expiresAt };
      issued.add(lease);
      return lease;
    },
    canSpeak(lease: SpeechLease): boolean {
      return issued.has(lease) && Date.parse(lease.expiresAt) > now().getTime();
    },
    revokeSpeech(): void {
      issued.clear();
    },
  };
}

type SpeechSynthesisLike = Readonly<{ speak(utterance: unknown): void; cancel(): void }>;

function defaultSynthesis(): SpeechSynthesisLike | undefined {
  const candidate = (globalThis as { speechSynthesis?: SpeechSynthesisLike }).speechSynthesis;
  return candidate ?? undefined;
}

/**
 * Playback through the platform synthesizer. A plan without a live lease is never spoken, and a
 * renderer without a synthesizer fails loudly so the service reports the answer as visible-only
 * instead of claiming audio that never played.
 */
export function createWidgetVoice(attention: Attention, synthesis?: SpeechSynthesisLike): DesktopVoice {
  return {
    async submitSpeech(plan: SpeechPlan, lease: SpeechLease): Promise<ReadonlyArray<VoiceOutputEvent>> {
      if (!attention.canSpeak(lease)) return [];
      const synthesizer = synthesis ?? defaultSynthesis();
      if (synthesizer === undefined) throw new Error('Speech synthesis is unavailable in this renderer.');
      const events: Array<VoiceOutputEvent> = [];
      for (const segment of plan.segments) {
        synthesizer.speak(new SpeechSynthesisUtterance(segment.text));
        events.push({ planId: plan.planId, segmentId: segment.id, positionMs: 0, status: 'started' });
      }
      return events;
    },
  };
}

export type WidgetDesktopRuntime = Readonly<{
  /** True when the shell connected a scoped runtime; false means limited context only. */
  connected: boolean;
  /** Why the widget cannot read the screen yet; null once a runtime is connected. */
  unavailableReason: string | null;
  ask(question: string): Promise<DesktopAnswer>;
}>;

/**
 * Build the widget's answer path. With a connected host every question goes through the frozen
 * `createDesktopContextService` seam (scoped memory, grounded answer, leased speech); without one
 * the widget returns the deterministic limited-context answer and never asks anything to guess.
 */
export function createWidgetDesktopRuntime(
  host: DesktopContextHost | null | undefined,
  options: Readonly<{ muted?: () => boolean }> = {},
): WidgetDesktopRuntime {
  if (host === null || host === undefined) {
    return {
      connected: false,
      unavailableReason: UNCONNECTED_REASON,
      async ask(question: string): Promise<DesktopAnswer> {
        if (question.trim().length === 0) {
          throw new TypeError('C01: the desktop question must be a non-empty string');
        }
        return {
          question,
          surface: 'widget',
          text: UNCONNECTED_CONTEXT_TEMPLATE,
          evidenceIds: [],
          capture: { state: 'limited', app: UNCONNECTED_APP_NAME, reason: 'no_window' },
          spoken: false,
        };
      },
    };
  }

  const attention = host.attention ?? createWidgetAttention(options.muted ?? (() => false), host.now);
  const voice = host.voice ?? createWidgetVoice(attention);
  const service = createDesktopContextService({
    bridge: host.bridge,
    memory: host.memory,
    reasoner: host.reasoner,
    attention,
    voice,
    now: host.now ?? (() => new Date()),
    scope: host.scope,
    excludedBundleIds: host.excludedBundleIds ?? [],
  });
  return {
    connected: true,
    unavailableReason: null,
    ask: (question: string) => service.answer({ question, surface: 'widget' }),
  };
}

function isDesktopContextHost(value: unknown): value is DesktopContextHost {
  if (typeof value !== 'object' || value === null) return false;
  const host = value as Record<string, unknown>;
  const bridge = host.bridge as Record<string, unknown> | undefined;
  const memory = host.memory as Record<string, unknown> | undefined;
  const reasoner = host.reasoner as Record<string, unknown> | undefined;
  const scope = host.scope as Record<string, unknown> | undefined;
  return typeof bridge?.foregroundApp === 'function'
    && typeof bridge?.captureQuestionContext === 'function'
    && typeof memory?.query === 'function'
    && typeof reasoner?.run === 'function'
    && typeof scope?.profileId === 'string'
    && scope.profileId.trim().length > 0;
}

/** Read the shell-installed runtime, if any; a malformed host is treated as not connected. */
export function desktopContextHostFromWindow(
  target: Window | undefined = typeof window === 'undefined' ? undefined : window,
): DesktopContextHost | null {
  if (target === undefined) return null;
  const candidate = (target as unknown as { __echoPilotDesktopContextHost?: unknown }).__echoPilotDesktopContextHost;
  return isDesktopContextHost(candidate) ? candidate : null;
}

/** Install the shell's runtime on the widget window (idempotent, one host per window). */
export function installDesktopContextHost(
  host: DesktopContextHost | null,
  target: Window | undefined = typeof window === 'undefined' ? undefined : window,
): void {
  if (target === undefined) return;
  if (host === null) {
    delete (target as unknown as { __echoPilotDesktopContextHost?: unknown }).__echoPilotDesktopContextHost;
    return;
  }
  (target as unknown as { __echoPilotDesktopContextHost?: DesktopContextHost }).__echoPilotDesktopContextHost = host;
}
