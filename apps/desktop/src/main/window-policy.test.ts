/**
 * F02 evidence for the foreground-safe widget acceptance criterion, driven without Electron:
 * "does not steal focus and survives Mission Control closure, workspace switching, and full-screen
 * use". Electron cannot start in the deterministic check environment, so this exercises the exact
 * policy `index.ts` applies to the real BrowserWindow (a recording fake keeps the assertions
 * independent of any native UI).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  WIDGET_WINDOW_BEHAVIOR,
  applyForegroundSafeWindowBehavior,
  revealWidgetWindow,
  shouldQuitWhenAllWindowsClosed,
  widgetWindowAction,
  windowBehavior,
  type ForegroundSafeWindow,
} from './window-policy';

type Recorder = Readonly<{
  calls: string[];
  window: ForegroundSafeWindow;
  setDestroyed(value: boolean): void;
}>;

function recorder(): Recorder {
  const calls: string[] = [];
  let destroyed = false;
  return {
    calls,
    setDestroyed: (value) => { destroyed = value; },
    window: {
      setVisibleOnAllWorkspaces: (visible, options) => {
        calls.push(`setVisibleOnAllWorkspaces(${visible},${JSON.stringify(options)})`);
      },
      setAlwaysOnTop: (flag, level) => { calls.push(`setAlwaysOnTop(${flag},${String(level)})`); },
      showInactive: () => { calls.push('showInactive'); },
      isDestroyed: () => destroyed,
    },
  };
}

test('the widget cannot take activation: it is not focusable and is revealed with showInactive', () => {
  assert.equal(windowBehavior('widget').focusable, false);
  assert.equal(WIDGET_WINDOW_BEHAVIOR.acceptFirstMouse, true);
  assert.equal(windowBehavior('dashboard').focusable, true);

  const widget = recorder();
  revealWidgetWindow(widget.window, 'darwin');
  assert.deepEqual(widget.calls.filter((call) => call === 'showInactive'), ['showInactive']);
  // `show()` and `focus()` are the calls that pull the user's keystrokes away; neither is issued.
  assert.ok(
    !widget.calls.some((call) => call === 'show' || call === 'focus'),
    `focus-stealing call observed: ${widget.calls.join(', ')}`,
  );
});

test('the widget follows every Space, including full-screen Spaces, via Electron controls', () => {
  const widget = recorder();
  assert.equal(applyForegroundSafeWindowBehavior(widget.window, 'darwin'), true);
  assert.deepEqual(widget.calls, [
    'setVisibleOnAllWorkspaces(true,{"visibleOnFullScreen":true,"skipTransformProcessType":true})',
    'setAlwaysOnTop(true,floating)',
  ]);
});

test('a window closed from Mission Control is recreated, and closing it never quits the app', () => {
  const widget = recorder();
  assert.equal(widgetWindowAction(null), 'recreate');
  assert.equal(widgetWindowAction(widget.window), 'reveal');
  widget.setDestroyed(true);
  assert.equal(widgetWindowAction(widget.window), 'recreate');
  // Revealing a destroyed window is a no-op rather than a crash on the Mission Control path.
  revealWidgetWindow(widget.window, 'darwin');
  assert.deepEqual(widget.calls, []);
  assert.equal(shouldQuitWhenAllWindowsClosed(), false);
});

test('non-macOS platforms skip the macOS-only Space and level calls', () => {
  const widget = recorder();
  assert.equal(applyForegroundSafeWindowBehavior(widget.window, 'win32'), false);
  assert.deepEqual(widget.calls, []);
});
