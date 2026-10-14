import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGazeHost } from './gaze-host';

function harness() {
  let clock = 1_000_000;
  let active = 'p';
  let generation = 1;
  let emitted: (event: unknown) => void = () => {};
  let exited: () => void = () => {};
  let starts = 0;
  let stops = 0;
  const host = createGazeHost({bundleDir: '/fixture', activeProjectId: () => active, now: () => clock,
    displays: () => [{displayId: 'display', originX: 0, originY: 0, width: 1000, height: 800, scale: 1, arrangementGeneration: generation}],
    open(_id, event, exit) {starts++; emitted = event; exited = exit; return {stop() {stops++;}};}});
  return {host, get starts() {return starts;}, get stops() {return stops;}, time(ms: number) {clock += ms;}, project(id: string) {active = id;}, move() {generation++;}, emit(value: unknown) {emitted(value);}, exit() {exited();}, frame(x: number, y: number, index = 0) {
    emitted({type: 'frame', payload: {capturedAt: new Date(clock).toISOString(), cameraId: 'real-worker-contract', displayId: 'display', eyesVisible: true, quality: .95,
      features: {irisX: x + (index % 2 ? .002 : -.002), irisY: y + (index % 3 ? .001 : -.003), ear: .3, faceX: .5, faceY: .5, faceScale: .5, yaw: 0, pitch: 0, roll: 0}}});
  }};
}
test('status does not enable camera; explicit enable, scope changes and stop bound native lifecycle', async () => {
  const h = harness();
  try {
    assert.equal((await h.host.handle({command: 'status', projectId: 'p'})).status?.reason, 'not_started');
    assert.equal(h.starts, 0);
    assert.equal((await h.host.handle({command: 'start', projectId: 'p', displayId: 'display'})).error, 'camera_enable_required');
    assert.equal(h.starts, 0);
    await h.host.handle({command: 'start', projectId: 'p', displayId: 'display', enabled: true});
    assert.equal(h.starts, 1);
    h.emit({type: 'started', payload: {cameraId: 'real-worker-contract'}});
    await Promise.resolve();
    h.project('other');
    assert.equal((await h.host.handle({command: 'status', projectId: 'other'})).status?.reason, 'inactive_project');
    assert.equal(h.stops, 1);
  } finally {h.host.dispose();}
});
test('nine target fit + five held-out native metadata windows produce calibrated runtime, no pixels', async () => {
  const h = harness();
  try {
    await h.host.handle({command: 'start', projectId: 'p', displayId: 'display', enabled: true});
    h.emit({type: 'started', payload: {cameraId: 'real-worker-contract'}});
    await Promise.resolve();
    let result = await h.host.handle({command: 'beginCalibration', projectId: 'p'});
    for (let target = 0; target < 14; target++) {
      const point = result.target!;
      assert.equal(point.index, target);
      assert.equal((await h.host.handle({command: 'nextCalibration', projectId: 'p'})).error, 'target_duration');
      h.time(1_200); // Ignore frames while the eye is moving toward the new target.
      for (let index = 0; index < 8; index++) {h.frame(point.normalizedX, point.normalizedY, index); h.time(160);}
      result = await h.host.handle({command: 'nextCalibration', projectId: 'p'});
    }
    assert.equal(result.calibration?.accepted, true);
    assert.equal(result.calibration?.framesUsed, 72);
    assert.equal(result.calibration?.validationFramesUsed, 40);
    h.frame(.5,.5);
    assert.equal((await h.host.handle({command: 'status', projectId: 'p'})).status?.state, 'active');
    h.time(2_501);
    assert.equal((await h.host.handle({command: 'status', projectId: 'p'})).status?.reason, 'pupil_tracking_lost');
    h.move(); h.frame(.5,.5);
    assert.equal((await h.host.handle({command: 'status', projectId: 'p'})).status?.reason, 'calibration_stale');
  } finally {h.host.dispose();}
});
test('missing pupils cannot advance calibration; camera denial and disconnect are honest unavailable states', async () => {
  const h = harness();
  try {
    await h.host.handle({command: 'start', projectId: 'p', displayId: 'display', enabled: true});
    h.emit({type: 'started', payload: {cameraId: 'real-worker-contract'}}); await Promise.resolve();
    await h.host.handle({command: 'beginCalibration', projectId: 'p'});
    h.time(1_201);
    assert.equal((await h.host.handle({command: 'nextCalibration', projectId: 'p'})).error, 'insufficient_pupil_evidence');
    h.emit({type: 'unavailable', payload: {reason: 'camera_denied'}});
    assert.equal((await h.host.handle({command: 'status', projectId: 'p'})).status?.reason, 'camera_denied');
    await h.host.handle({command: 'start', projectId: 'p', displayId: 'display', enabled: true});
    h.exit();
    assert.equal((await h.host.handle({command: 'status', projectId: 'p'})).status?.reason, 'camera_disconnected');
  } finally {h.host.dispose();}
});
