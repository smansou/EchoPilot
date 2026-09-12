/**
 * F02 foreground-safe widget window policy (Electron controls only).
 *
 * The ticket's judgment rule is "use Electron window controls first; add only the AppKit behavior
 * the signed-app test proves missing". Nothing here is native — this module is the exact set of
 * `BrowserWindow` calls that keep the widget reachable without stealing focus:
 *
 *   • `focusable: false` plus `showInactive()` — opening or clicking the widget never pulls the
 *     user's keystrokes out of the app they are working in, and `acceptFirstMouse` still lets the
 *     first click land on Mute/Stop.
 *   • `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true, skipTransformProcessType: true })`
 *     — the widget follows every Space, including full-screen Spaces, while the app keeps its normal
 *     activation policy so its Mission Control window stays reachable.
 *   • the app never quits on `window-all-closed`, and a closed/destroyed widget is recreated on
 *     demand, so losing the window (Mission Control, Cmd-W, a Space change) loses neither the
 *     session nor the always-reachable tray controls.
 *
 * Electron-free by construction so `window-policy.test.ts` can drive it under plain Node.
 */

export type AlwaysOnTopLevel =
  | 'normal'
  | 'floating'
  | 'torn-off-menu'
  | 'modal-panel'
  | 'main-menu'
  | 'status'
  | 'pop-up-menu'
  | 'screen-saver';

/** The slice of `BrowserWindow` this policy needs; a real BrowserWindow satisfies it structurally. */
export type ForegroundSafeWindow = Readonly<{
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: Readonly<{ visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }>,
  ): void;
  setAlwaysOnTop(flag: boolean, level?: AlwaysOnTopLevel, relativeLevel?: number): void;
  showInactive(): void;
  isDestroyed(): boolean;
}>;

export type WidgetWindowBehavior = Readonly<{
  alwaysOnTop: boolean;
  focusable: boolean;
  acceptFirstMouse: boolean;
  skipTaskbar: boolean;
  autoHideMenuBar: boolean;
}>;

/** The widget is never the key window; the dashboard is a normal, focusable app window. */
export const WIDGET_WINDOW_BEHAVIOR: WidgetWindowBehavior = Object.freeze({
  alwaysOnTop: true,
  focusable: false,
  acceptFirstMouse: true,
  skipTaskbar: true,
  autoHideMenuBar: true,
});

export const DASHBOARD_WINDOW_BEHAVIOR: WidgetWindowBehavior = Object.freeze({
  alwaysOnTop: false,
  focusable: true,
  acceptFirstMouse: false,
  skipTaskbar: false,
  autoHideMenuBar: true,
});

export function windowBehavior(view: 'widget' | 'dashboard'): WidgetWindowBehavior {
  return view === 'widget' ? WIDGET_WINDOW_BEHAVIOR : DASHBOARD_WINDOW_BEHAVIOR;
}

/** `skipTransformProcessType` is the part that keeps Mission Control working: no accessory mode. */
export const WIDGET_WORKSPACE_OPTIONS = Object.freeze({
  visibleOnFullScreen: true,
  skipTransformProcessType: true,
});

/**
 * Apply the Electron-only Space/level behavior. The two calls are macOS-only in Electron, so other
 * platforms report `false` and keep the default window behavior.
 */
export function applyForegroundSafeWindowBehavior(
  window: ForegroundSafeWindow,
  platform: string = process.platform,
): boolean {
  if (platform !== 'darwin') return false;
  window.setVisibleOnAllWorkspaces(true, WIDGET_WORKSPACE_OPTIONS);
  window.setAlwaysOnTop(true, 'floating');
  return true;
}

/**
 * Reveal the widget without activating it. `showInactive()` is the whole activation story: the
 * policy never calls `show()` or `focus()`, which are the calls that would steal focus.
 */
export function revealWidgetWindow(window: ForegroundSafeWindow, platform: string = process.platform): void {
  if (window.isDestroyed()) return;
  applyForegroundSafeWindowBehavior(window, platform);
  window.showInactive();
}

/** A closed or destroyed widget (Mission Control, Cmd-W, a Space change) is recreated on demand. */
export function widgetWindowAction(window: ForegroundSafeWindow | null): 'reveal' | 'recreate' {
  return window && !window.isDestroyed() ? 'reveal' : 'recreate';
}

/** Closing the widget must never end the app: the tray keeps mute/stop reachable afterwards. */
export function shouldQuitWhenAllWindowsClosed(): boolean {
  return false;
}
