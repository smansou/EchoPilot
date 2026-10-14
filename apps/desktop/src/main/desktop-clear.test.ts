import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopActions} from './desktop-actions';
import {createDesktopDictationService} from './desktop-dictation';

for (const kind of ['action', 'dictation'] as const) test(`${kind} clear during awaited authorization closes helper and prevents native advance`, async () => {
  let release: ((value: unknown) => void) | undefined;
  let waiting: (() => void) | undefined;
  const paused = new Promise<void>(resolve => {waiting = resolve;});
  let writes = 0; let closed = 0;
  const state = {appBundleId: 'fixture.app', windowTitle: 'Fixture', role: kind === 'action' ? 'AXButton' : 'AXTextArea', label: 'Fixture', value: '', fingerprint: 'fp', enabled: true, focused: true};
  const options = {bundleDir: '/fixture', activeProjectId: () => 'p', openSession: () => ({close() {closed++;}, async request(request: Record<string, unknown>): Promise<unknown> {
    if (request.operation === 'focused-control' || request.operation === 'focused-target') return {targetRef: 'ax:123:0.1', state};
    if (request.operation === 'inspect') return state;
    if (request.operation === 'propose') return {proposalId: 'proposal'};
    if (request.operation === 'authorize') {waiting!(); return new Promise(resolve => {release = resolve;});}
    if (request.operation === 'advance') {writes++; return {status: 'completed'};}
    throw Error('unexpected');
  }})};
  const service = kind === 'action' ? createDesktopActions(options) : createDesktopDictationService(options);
  if (kind === 'action') await service.handle({command: 'prepareAction', projectId: 'p', operation: 'click'});
  const preview = (await service.handle(kind === 'action' ? {command: 'previewPrepared', projectId: 'p'} : {command: 'preview', projectId: 'p', text: 'private draft'})).preview!;
  const confirm = service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true});
  await paused; service.clear(); release!({authorized: true});
  assert.equal((await confirm).error, 'cleared'); assert.equal(writes, 0); assert.ok(closed > 0);
  const status = await service.handle({command: 'status', projectId: 'p'});
  assert.equal(status.preview, undefined); assert.equal(status.prepared, false);
});
test('private dictation refuses glossary mutations before obtaining persistent storage', async () => {
  const service = createDesktopDictationService({bundleDir: '/fixture', activeProjectId: () => 'p', isPrivate: () => true, glossaryDirectory: '/unavailable'});
  for (const command of ['learnCorrection', 'promoteTerm']) assert.equal((await service.handle({command, projectId: 'p', confirmed: true, raw: 'secret', corrected: 'secret', term: 'secret'})).error, 'private_mode');
  service.dispose();
});
