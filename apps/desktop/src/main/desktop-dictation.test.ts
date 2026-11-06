import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopDictationService, type DesktopActionSession } from './desktop-dictation';

function harness() {
  let state = {appBundleId: 'fixture.echo', windowTitle: 'Fixture', role: 'AXTextArea', label: 'Editor', value: 'Before ', enabled: true, focused: true, fingerprint: 'identity'};
  let clock = 0;
  let active: string | null = 'p';
  const calls: Record<string, unknown>[] = [];
  let selection: {location: number; length: number} | undefined;
  let step: Record<string, unknown> | null = null;
  let writes = 0;
  const openSession = (): DesktopActionSession => ({close() {}, async request(request) {
    calls.push(request);
    if (request.operation === 'focused-target') return {targetRef: 'ax:123:0.1', state: {...state}, ...(selection ? {selection: {...selection}} : {})};
    if (request.operation === 'inspect') return {...state};
    if (request.operation === 'propose') { step = (request.steps as Record<string, unknown>[])[0]!; return {proposalId: 'proposal'}; }
    if (request.operation === 'authorize') return {authorized: true};
    if (request.operation === 'advance') {
      assert.equal(step?.expectedValue, state.value);
      state.value = String(step?.value); writes += 1;
      return {status: 'completed', steps: [{verification: 'value_readback'}]};
    }
    throw Error('unsupported');
  }});
  const service = createDesktopDictationService({bundleDir: '/fixture', activeProjectId: () => active, now: () => clock, openSession});
  return {service, calls, get writes() {return writes;}, get state() {return state;}, patch(patch: Partial<typeof state>) {state = {...state, ...patch};}, select(value: {location: number; length: number}) {selection = value;}, time(value: number) {clock = value;}, project(value: string | null) {active = value;}};
}

test('transcript previews only, explicit confirmation edits once and explicit undo restores', async () => {
  const h = harness();
  const result = await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'});
  assert.equal(h.writes, 0);
  assert.equal(result.preview?.text, 'hello');
  assert.equal((await h.service.handle({command: 'confirm', projectId: 'p', previewId: result.preview?.previewId})).error, 'confirmation_required');
  assert.equal(h.writes, 0);
  assert.equal((await h.service.handle({command: 'confirm', projectId: 'p', previewId: result.preview?.previewId, confirmed: true})).ok, true);
  assert.equal(h.state.value, 'Before hello');
  assert.equal(h.writes, 1);
  const undo = await h.service.handle({command: 'undoPreview', projectId: 'p'});
  assert.equal(h.writes, 1);
  await h.service.handle({command: 'confirm', projectId: 'p', previewId: undo.preview?.previewId, confirmed: true});
  assert.equal(h.state.value, 'Before ');
  assert.equal(h.writes, 2);
});

for (const change of ['fingerprint', 'value', 'focused', 'project', 'expired'] as const) {
  test(`reject ${change} changed since preview without writing`, async () => {
    const h = harness();
    const preview = (await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'})).preview!;
    if (change === 'fingerprint') h.patch({fingerprint: 'new'});
    if (change === 'value') h.patch({value: 'User typed something'});
    if (change === 'focused') h.patch({focused: false});
    if (change === 'project') h.project('other');
    if (change === 'expired') h.time(30_001);
    const result = await h.service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true});
    assert.equal(result.ok, false);
    assert.equal(h.writes, 0);
  });
}
test('bounds transcripts and excludes secure/unsupported controls', async () => {
  const h = harness();
  assert.equal((await h.service.handle({command: 'preview', projectId: 'p', text: 'x'.repeat(16_385)})).error, 'invalid_transcript');
  assert.equal(h.calls.length, 0);
  h.patch({role: 'AXSecureTextField'});
  assert.equal((await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'})).error, 'unsupported_target');
  assert.equal(h.writes, 0);
});
test('preview replaces the focused selection instead of always appending at the end', async () => {
  const h = harness();
  h.select({location: 2, length: 3});
  const preview = (await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'})).preview!;
  assert.equal(preview.text, 'hello');
  await h.service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true});
  assert.equal(h.state.value, 'Behelloe ');
});
test('preview refuses to replace text if the cursor or selection moves before confirmation', async () => {
  const h = harness();
  h.select({location: 2, length: 3});
  const preview = (await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'})).preview!;
  h.select({location: 7, length: 0});
  const result = await h.service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true});
  assert.equal(result.error, 'stale_target');
  assert.equal(h.writes, 0);
});
test('undo refuses to overwrite later user edits and wrong-scope confirmations', async () => {
  const h = harness();
  const preview = (await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'})).preview!;
  await h.service.handle({command: 'confirm', projectId: 'wrong', previewId: preview.previewId, confirmed: true});
  assert.equal(h.writes, 0);
  const retry = (await h.service.handle({command: 'preview', projectId: 'p', text: 'hello'})).preview!;
  await h.service.handle({command: 'confirm', projectId: 'p', previewId: retry.previewId, confirmed: true});
  h.patch({value: 'My subsequent edit'});
  assert.equal((await h.service.handle({command: 'undoPreview', projectId: 'p'})).error, 'stale_target');
  assert.equal(h.writes, 1);
});
test('preparing a bounded draft never calls native until widget preview, expires, and stays scoped', async () => {
  const long = 'x'.repeat(10_000); // beyond the 8,192-character coordinator display excerpt
  const large = harness();
  const prepared = await large.service.handle({command: 'prepare-draft', projectId: 'p', text: long});
  assert.equal(prepared.ok, true);
  assert.equal(prepared.draftText, long);
  assert.equal(prepared.draftText!.length, 10_000);
  assert.equal(large.calls.length, 0);
  const h = harness();
  assert.equal((await h.service.handle({command: 'prepare-draft', projectId: 'p', text: 'hello'})).prepared, true);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.service.handle({command: 'status', projectId: 'p'})).prepared, true);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.service.handle({command: 'previewPrepared', projectId: 'wrong'})).ok, false);
  assert.equal(h.calls.length, 0);
  const preview = await h.service.handle({command: 'previewPrepared', projectId: 'p'});
  assert.equal(preview.preview?.text, 'hello');
  assert.equal(h.writes, 0);
  h.time(120_001);
  assert.equal((await h.service.handle({command: 'status', projectId: 'p'})).prepared, false);
  const count = h.calls.length;
  assert.equal((await h.service.handle({command: 'previewPrepared', projectId: 'p'})).error, 'invalid_transcript');
  assert.equal(h.calls.length, count);
});
test('durable glossary corrects prepared drafts after restart without cross-project leakage or silent promotion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-dictation-glossary-'));
  let projectId = 'p';
  const options = {bundleDir: '/fixture', activeProjectId: () => projectId, glossaryDirectory: directory, openSession(): DesktopActionSession {throw Error('native must not be called');}};
  let service = createDesktopDictationService(options);
  try {
    const correction = {command: 'learnCorrection', projectId: 'p', raw: 'echo pilot', corrected: 'EchoPilot'};
    assert.equal((await service.handle(correction)).error, 'confirmation_required');
    assert.equal((await service.handle({...correction, confirmed: true})).ok, true);
    service.dispose();
    service = createDesktopDictationService(options);
    assert.equal((await service.handle({command: 'prepare-draft', projectId: 'p', text: 'open echo pilot'})).draftText, 'open EchoPilot');
    projectId = 'other';
    assert.equal((await service.handle({command: 'prepare-draft', projectId, text: 'open echo pilot'})).draftText, 'open echo pilot');
    assert.equal((await service.handle({command: 'promoteTerm', projectId, term: 'EchoPilot', confirmed: true})).ok, false);
    projectId = 'p';
    assert.equal((await service.handle({command: 'promoteTerm', projectId, term: 'EchoPilot'})).error, 'confirmation_required');
    assert.equal((await service.handle({command: 'promoteTerm', projectId, term: 'EchoPilot', confirmed: true})).ok, true);
    projectId = 'other';
    assert.equal((await service.handle({command: 'prepare-draft', projectId, text: 'open echo pilot'})).draftText, 'open EchoPilot');
  } finally {service.dispose(); await rm(directory, {recursive: true, force: true});}
});
