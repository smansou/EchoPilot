/**
 * F02 single source of truth for the status the widget panel and the tray menu render.
 *
 * Electron-free by construction: `index.ts` feeds both consumers the same snapshot from this
 * module, so the always-reachable tray mute item can never show the opposite affordance from the
 * widget's Mute button. The coordinator owns the live mute flag; the shell only reports the
 * signed helper's *permission* state.
 */
import type { WidgetStatus } from './shell';

export type CoordinatorStatusInput = Readonly<{
  /** Live mute flag from the real coordinator (the widget's Mute button writes this). */
  muted: boolean;
  /** Session id of the latest coordinator event, or null when there is none. */
  sessionId: string | null;
}>;

/** Widget/tray status plus the coordinator mute flag the tray labels itself from. */
export type WidgetSnapshot = WidgetStatus & Readonly<{ muted: boolean }>;

export function widgetStatusSnapshot(status: WidgetStatus, coordinator: CoordinatorStatusInput): WidgetSnapshot {
  // A denied or not-yet-asked permission stays visible as-is; once permission exists, the
  // coordinator's mute state is what the surfaces report.
  const microphone = status.microphone === 'denied' || status.microphone === 'unknown'
    ? status.microphone
    : coordinator.muted ? 'muted' : 'granted';
  return {
    ...status,
    microphone,
    targetSession: status.targetSession ?? coordinator.sessionId,
    muted: coordinator.muted,
  };
}

/** Tray menu label for the mute item, derived from the coordinator-owned flag on the snapshot. */
export function muteControlLabel(snapshot: Pick<WidgetSnapshot, 'muted'>): string {
  return snapshot.muted ? 'Unmute microphone' : 'Mute microphone';
}
