import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictationCapture, createDictationScreenContext } from './dictation-capture';
import type { DesktopObserveResult } from './desktop-observe';
function setup(enabled = false) {
  let project: string | null = 'project', privacy = 0, privateActive = false;
  let starts = 0, stops = 0; const drafts: string[] = [];
  const capture = createDictationCapture({ projectId: () => project, privateActive: () => privateActive, muted: () => false, privacyGeneration: () => privacy,
    conversationEnabled: () => enabled, enable: async () => { starts++; enabled = true; }, disable: async () => { stops++; enabled = false; }, prepare: async (id, text) => { assert.equal(id, 'project'); drafts.push(text); }, changed() {} });
  return { capture, drafts, counts: () => ({ starts, stops }), project: (value: string) => { project = value; }, invalidate: () => { privateActive = true; privacy++; } };
}
test('two-press dictation captures final once after partial and preserves an already running conversation', async () => {
  const s = setup(true); await s.capture.toggle();
  assert.equal(s.capture.transcript({ phase: 'partial', utteranceId: 'a', text: 'first' }), true);
  s.capture.transcript({ phase: 'final', utteranceId: 'a', text: 'first final' });
  s.capture.transcript({ phase: 'final', utteranceId: 'a', text: 'duplicate' });
  await s.capture.toggle(); assert.deepEqual(s.drafts, ['first final']); assert.deepEqual(s.counts(), { starts: 0, stops: 0 });
  assert.equal(s.capture.transcript({ phase: 'final', utteranceId: 'a', text: 'late' }), true);
});
test('wrong project, privacy invalidation, cancel and UTF8 overflow cannot prepare a draft', async () => {
  for (const mode of ['project', 'privacy', 'cancel', 'overflow']) {
    const s = setup(); await s.capture.toggle();
    if (mode === 'project') s.project('other');
    if (mode === 'privacy') s.invalidate();
    if (mode === 'cancel') await s.capture.cancel();
    s.capture.transcript({ phase: 'final', utteranceId: 'a', text: mode === 'overflow' ? '💬'.repeat(4097) : 'draft' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(s.drafts, []); assert.equal(s.counts().stops, 1); assert.equal(s.capture.status().phase, 'idle');
  }
});
test('start failure cleans up microphone and cancel during start cannot resurrect capture', async () => {
  let stops = 0; let release: () => void = () => {};
  const make = (enable: () => Promise<void>) => createDictationCapture({ projectId: () => 'project', privateActive: () => false, muted: () => false, privacyGeneration: () => 0, conversationEnabled: () => false, enable, disable: async () => { stops++; }, prepare: async () => assert.fail('no draft'), changed() {} });
  const failed = make(async () => { throw Error('denied'); }); await failed.toggle(); assert.equal(failed.status().phase, 'idle'); assert.equal(stops, 1);
  const pending = make(() => new Promise<void>(resolve => { release = resolve; })); const starting = pending.toggle(); await pending.cancel(); release(); await starting; assert.equal(pending.status().phase, 'idle'); assert.equal(stops, 2);
});

test('hotkey target AX snapshot stays local, drops secure nodes, expires and cannot survive cancel or scope changes', async () => {
  let project = 'project', privacy = 0, clock = 100_000;
  let release: (value: DesktopObserveResult) => void = () => {};
  const snapshot = createDictationScreenContext({ projectId: () => project, privacyGeneration: () => privacy, privateActive: () => false, now: () => clock,
    observe: () => new Promise(resolve => { release = resolve; }) });
  const evidence = () => ({ outcome: 'observed' as const, evidence: { kind: 'desktop_observe' as const, projectId: 'project', observedAtMs: clock,
    application: { pid: 1, bundleId: 'target', name: 'Original target', bundleIdTruncated: false, nameTruncated: false },
    window: { role: 'AXWindow', title: 'Editor', roleTruncated: false, titleTruncated: false },
    nodes: ['AXTextArea', 'AXSecureTextField', 'AXTextField'].map((role, i) => ({ depth: 0, role, subrole: null, label: 'target', value: 'SQLite', redacted: i === 2, labelTruncated: false, valueTruncated: false, roleTruncated: false, subroleTruncated: false })),
    quality: 'full' as const, truncated: false, truncations: [], stats: { visitedNodes: 3, emittedNodes: 3, maxDepthReached: 0, estimatedBytes: 100 } } });
  let task = snapshot.capture('project'); release(evidence()); await task;
  assert.equal(snapshot.get('project')?.application.name, 'Original target'); assert.equal(snapshot.get('project')?.nodes.length, 1);
  // Main invalidates before every association mutation and after it completes, even without a B read.
  snapshot.clear(); project = 'other'; snapshot.clear(); project = 'project'; assert.equal(snapshot.get('project'), null);
  assert.equal(snapshot.get('foreign'), null);
  task = snapshot.capture('project'); release(evidence()); await task; clock += 60_000; assert.equal(snapshot.get('project'), null);
  task = snapshot.capture('project'); snapshot.clear(); release(evidence()); await task; assert.equal(snapshot.get('project'), null);
  task = snapshot.capture('project'); privacy++; release(evidence()); await task; assert.equal(snapshot.get('project'), null);
  task = snapshot.capture('project'); project = 'other'; release(evidence()); await task; assert.equal(snapshot.get('project'), null);
});
test('hotkey capture does not await target observation before enabling microphone and cancel retires late evidence', async () => {
  let release: (value: DesktopObserveResult) => void = () => {}; let enabled = 0;
  const screen = createDictationScreenContext({ projectId: () => 'project', privacyGeneration: () => 0, privateActive: () => false,
    observe: () => new Promise(resolve => { release = resolve; }) });
  const capture = createDictationCapture({ projectId: () => 'project', privateActive: () => false, muted: () => false, privacyGeneration: () => 0, conversationEnabled: () => false,
    enable: async () => { enabled++; }, disable: async () => {}, prepare: async () => {}, discardDraft: screen.clear, captureContext: id => { void screen.capture(id); }, changed() {} });
  await capture.toggle(); assert.equal(enabled, 1); assert.equal(capture.status().phase, 'capturing');
  await capture.cancel(); release({ outcome: 'denied', code: 'excluded_application', detail: null });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(screen.get('project'), null);
});
