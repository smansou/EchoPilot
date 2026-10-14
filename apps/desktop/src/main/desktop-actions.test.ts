import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopActions, type DesktopActionHistory } from './desktop-actions';

function harness() {
  let clock = 0;
  let current = {appBundleId: 'fixture.app', role: 'AXButton', label: 'Apply fixture only', fingerprint: 'fingerprint', value: '', enabled: true, focused: true};
  let writes = 0;
  let requests = 0;
  const history: DesktopActionHistory[] = [];
  const service = createDesktopActions({bundleDir: '/fixture', activeProjectId: () => 'p', now: () => clock, onReceipt: (receipt) => {history.push(receipt);}, openSession: () => ({close() {}, async request(payload) {
    requests++;
    if (payload.operation === 'focused-control') return {targetRef: 'ax:123:0.1', state: {...current}};
    if (payload.operation === 'inspect') return {...current};
    if (payload.operation === 'propose') return {proposalId: 'proposal'};
    if (payload.operation === 'authorize') return {authorized: true};
    if (payload.operation === 'advance') {writes++; return {status: 'completed', steps: [{verification: 'presence_only'}], evidenceIds: ['native:before','native:after']};}
    throw Error('unsupported');
  }})});
  return {service, history, get writes() {return writes;}, get requests() {return requests;}, patch(value: Partial<typeof current>) {current = {...current, ...value};}, time(value: number) {clock = value;}};
}
test('prepare and preview do not act; exact explicit confirmation executes native action and sanitizes history', async () => {
  const h = harness();
  await h.service.handle({command: 'prepareAction', projectId: 'p', operation: 'click'});
  assert.equal(h.requests, 0);
  const preview = (await h.service.handle({command: 'previewPrepared', projectId: 'p'})).preview!;
  assert.equal(h.writes, 0);
  assert.equal((await h.service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId})).error, 'confirmation_required');
  assert.equal(h.writes, 0);
  assert.equal((await h.service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true})).ok, true);
  assert.equal(h.writes, 1);
  assert.equal(h.history[0]?.source, 'native_ax_receipt');
  assert.equal(h.history[0]?.verification, 'presence_only');
  assert.equal(JSON.stringify(h.history).includes('Apply fixture only'), false);
  assert.equal((await h.service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true})).error, 'preview_missing');
  assert.equal(h.writes, 1);
});
for (const condition of ['focus','fingerprint','value','expired','scope','cancel'] as const) test(`${condition} change refuses action`, async () => {
  const h = harness();
  await h.service.handle({command: 'prepareAction', projectId: 'p', operation: 'click'});
  const preview = (await h.service.handle({command: 'previewPrepared', projectId: 'p'})).preview!;
  if (condition === 'focus') h.patch({focused: false});
  if (condition === 'fingerprint') h.patch({fingerprint: 'changed'});
  if (condition === 'value') h.patch({value: 'changed'});
  if (condition === 'expired') h.time(30_001);
  if (condition === 'cancel') await h.service.handle({command: 'cancel', projectId: 'p'});
  assert.equal((await h.service.handle({command: 'confirm', projectId: condition === 'scope' ? 'wrong' : 'p', previewId: preview.previewId, confirmed: true})).ok, false);
  assert.equal(h.writes, 0);
});
test('arbitrary targets, commands and coordinates cannot request native execution', async () => {
  const h = harness();
  assert.equal((await h.service.handle({command: 'prepareAction', projectId: 'p', operation: 'shell', commandText: 'echo unsafe'})).error, 'unsupported_action');
  assert.equal((await h.service.handle({command: 'prepareAction', projectId: 'p', operation: 'scroll', direction: 'arbitrary'})).error, 'unsupported_action');
  assert.equal(h.requests, 0);
});
