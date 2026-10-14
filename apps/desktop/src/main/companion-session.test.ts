import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionSession } from './companion-session';
function setup() {
  let clock = 0, revoked = 0, project = 'project'; const callbacks: (() => void)[] = [];
  const authority = createCompanionSession({ projectId: () => project, privateActive: () => false, muted: () => false, revoke: () => { revoked++; }, now: () => clock,
    setTimer: callback => { callbacks.push(callback); return { unref() {} } as ReturnType<typeof setTimeout>; }, clearTimer() {} });
  return { authority, callbacks, revoked: () => revoked, advance: () => { clock += 300_000; }, switchProject: () => { project = 'other'; } };
}
test('explicit consent, scoped attempts and ten-request exhaustion preserve final admitted request until strict expiry', () => {
  const s = setup(); assert.equal(s.authority.status().enabled, false); assert.throws(() => s.authority.enable('project', false), /consent/);
  s.authority.enable('project', true); assert.equal(s.authority.consume('foreign'), false);
  for (let i = 0; i < 10; i++) assert.equal(s.authority.consume('project'), true);
  assert.equal(s.authority.consume('project'), false); assert.equal(s.authority.status().enabled, false); assert.equal(s.revoked(), 0);
  s.advance(); s.callbacks[0]!(); assert.equal(s.revoked(), 1);
});
test('strict expiry invalidates pending result and stale old timer cannot revoke renewed authority', async () => {
  const s = setup(); let resultGeneration = 0; let output = false;
  // Model the companion clear callback generation fence used by the actual service.
  const callbacks: (() => void)[] = []; let clock = 0;
  const authority = createCompanionSession({ projectId: () => 'project', privateActive: () => false, muted: () => false, now: () => clock,
    revoke: () => { resultGeneration++; }, setTimer: callback => { callbacks.push(callback); return {} as ReturnType<typeof setTimeout>; }, clearTimer() {} });
  authority.enable('project', true); authority.consume('project'); const captured = resultGeneration;
  let release: () => void = () => {}; const request = new Promise<void>(resolve => { release = resolve; }).then(() => { if (captured === resultGeneration) output = true; });
  clock = 300_000; callbacks[0]!(); release(); await request; assert.equal(output, false); assert.equal(authority.status().enabled, false);
  s.authority.enable('project', true); s.authority.enable('project', true); s.callbacks[0]!(); assert.equal(s.authority.status().enabled, true);
  s.switchProject(); assert.equal(s.authority.status().enabled, false);
});
