/**
 * Regression for the F02 repair where mute had two independent sources: the tray labelled itself
 * from the shell's permission copy while the widget's Mute button wrote only the coordinator, so
 * the always-reachable tray item inverted. Both surfaces now render one snapshot from
 * `widget-status.ts`; this test drives the real coordinator (the path `index.ts` IPC uses) and
 * asserts the label the tray would show. No Electron required.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createCoordinator } from '../../../../packages/core/src/index';
import type { WidgetStatus } from './shell';
import { muteControlLabel, widgetStatusSnapshot } from './widget-status';

const HELPER_STATUS: WidgetStatus = Object.freeze({
  microphone: 'granted',
  capture: 'denied',
  output: 'ready',
  targetSession: null,
  provider: 'local',
  helper: 'connected',
});

function snapshotFor(coordinator: ReturnType<typeof createCoordinator>, status: WidgetStatus = HELPER_STATUS) {
  const state = coordinator.getState();
  return widgetStatusSnapshot(status, { muted: state.muted, sessionId: state.event?.sessionId ?? null });
}

test('the tray label follows the coordinator flag the widget Mute button writes', () => {
  const coordinator = createCoordinator();
  assert.equal(muteControlLabel(snapshotFor(coordinator)), 'Mute microphone');
  // `set-muted` from renderer/main.tsx reaches the coordinator only; the tray snapshot has to see it.
  coordinator.setMuted(true);
  const muted = snapshotFor(coordinator);
  assert.equal(muted.muted, true);
  assert.equal(muted.microphone, 'muted');
  assert.equal(muteControlLabel(muted), 'Unmute microphone');
  coordinator.setMuted(false);
  assert.equal(muteControlLabel(snapshotFor(coordinator)), 'Mute microphone');
});

test('a denied permission stays visible but cannot invert the mute affordance', () => {
  const coordinator = createCoordinator();
  coordinator.setMuted(true);
  // The helper last reported "denied"; the user nonetheless muted from the widget button.
  const snapshot = snapshotFor(coordinator, { ...HELPER_STATUS, microphone: 'denied' });
  assert.equal(snapshot.microphone, 'denied');
  assert.equal(muteControlLabel(snapshot), 'Unmute microphone');
  coordinator.setMuted(false);
  assert.equal(muteControlLabel(snapshotFor(coordinator, { ...HELPER_STATUS, microphone: 'denied' })), 'Mute microphone');
});

test('the shared snapshot falls back to the latest coordinator event session', () => {
  const coordinator = createCoordinator();
  const snapshot = widgetStatusSnapshot(HELPER_STATUS, { muted: false, sessionId: 'session-from-event' });
  assert.equal(snapshot.targetSession, 'session-from-event');
  const reported = widgetStatusSnapshot(
    { ...HELPER_STATUS, targetSession: 'helper-session' },
    { muted: false, sessionId: 'session-from-event' },
  );
  assert.equal(reported.targetSession, 'helper-session');
});
