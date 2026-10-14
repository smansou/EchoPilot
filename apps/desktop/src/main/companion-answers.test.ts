import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../../../../packages/memory/src/store/index';
import { createSecurityKernel } from '../../../../packages/security/src/index';
import { createFileKernelStorage } from '../../../../packages/security/src/storage';
import { createOpenAITextProvider, type TextModel } from '../../../../packages/providers/src/openai-text/index';
import { createMemoryRecordsHost, describeMemoryRecords } from './memory-records-host';
import { createCompanionAnswers, type CompanionAnswer } from './companion-answers';
import { createVoiceRouting } from './voice-routing';
import type { ManagedWork } from './managed-work';

async function fixture(extra: Partial<Parameters<typeof createCompanionAnswers>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-answers-'));
  const store = await createMemoryStore({ directory: join(directory, 'memory'), key: 'a'.repeat(64), profileId: 'local' });
  let active: string | null = 'project'; let epoch = 0; let speech = 0; let muted = false; let instant = 1_800_000_000_000;
  let model: TextModel = 'gpt-6-luna'; let hasKey = true; let providerOpens = 0; let secretReads = 0;
  let response = 'The project uses encrypted SQLite storage [1].'; let fetchGate: Promise<void> = Promise.resolve();
  const prompts: string[] = []; const spoken: { answer: CompanionAnswer; speak: boolean }[] = [];
  const notes = createMemoryRecordsHost({ activeProjectId: () => active, store: async () => store, now: () => instant });
  const note = await notes.preview('project', 'Use encrypted SQLite storage for project state.', null); const saved = await notes.confirm('project', note.id);
  instant += 1_000;
  const correction = await notes.preview('project', 'Use encrypted SQLite storage with WAL for project state.', saved.eventId); const corrected = await notes.confirm('project', correction.id);
  const unrelated = await notes.preview('project', 'Payroll moonstone approval is unrelated.', null); await notes.confirm('project', unrelated.id);
  const secrets = { get: async () => { secretReads++; return hasKey ? 'fake-fixture-key' : null; }, put: async () => {}, delete: async () => {} };
  const provider = createOpenAITextProvider({ secrets, model: () => model, fetcher: async (_url, request) => {
    prompts.push(JSON.parse(String(request.body)).input); await fetchGate;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: response }] }] }), { status: 200 });
  } });
  const kernel = createSecurityKernel({ secrets, provider, storage: createFileKernelStorage(join(directory, 'kernel.json')), capture: { invoke: async () => { throw Error('No capture allowed'); } } });
  const service = createCompanionAnswers({ activeProjectId: () => active, privacyGeneration: () => epoch, model: () => model,
    timeline: async projectId => describeMemoryRecords(await store.timeline({ projectId })), provider: async () => { providerOpens++; return { provider, kernel }; },
    now: () => instant, outputMuted: () => muted, speechGeneration: () => speech, onAnswer: (answer, speak) => { spoken.push({ answer, speak }); }, ...extra });
  return { service, notes, store, kernel, directory, saved, corrected, prompts, spoken,
    counts: () => ({ providerOpens, secretReads }), project: (value: string | null) => { active = value; }, privacy: () => { epoch++; }, stopSpeech: () => { speech++; }, mute: () => { muted = true; },
    expire: () => { instant += 61_000; }, model: () => { model = 'gpt-6-sol'; }, noKey: () => { hasKey = false; }, response: (value: string) => { response = value; }, gate: (value: Promise<void>) => { fetchGate = value; },
    close: async () => { service.clear(); await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('companion preview ranks corrected encrypted memory without provider/key access and explicit confirmation cites only reviewed sources', async () => {
  const f = await fixture();
  try {
    const view = await f.service.preview('What did we decide about SQLite storage?'); const review = view.pending!;
    assert.equal(review.kind, 'companion_answer'); assert.equal(review.model, 'gpt-6-luna'); assert.equal(review.projectId, 'project');
    assert.equal(review.evidence.length, 1); assert.equal(review.evidence[0]?.id, f.corrected.eventId);
    assert.equal(review.evidence[0]?.revisionOf, f.saved.eventId); assert.equal(review.evidence[0]?.trust, 'user_explicit');
    assert.deepEqual(f.counts(), { providerOpens: 0, secretReads: 0 }); assert.equal(f.prompts.length, 0);
    (review.evidence[0] as { summary: string }).summary = 'Renderer tampering';
    const answered = await f.service.confirm(review.id);
    assert.equal(answered.answer?.supported, true); assert.equal(answered.answering, false);
    assert.deepEqual(answered.answer?.citedSourceIds, [f.corrected.eventId]);
    assert.equal(f.spoken[0]?.speak, true); assert.match(f.prompts[0]!, /SQLite storage with WAL/); assert.doesNotMatch(f.prompts[0]!, /moonstone|Renderer tampering/);
    assert.match(f.prompts[0]!, /Trust: user_explicit; correction of/);
    assert.equal((await readFile(join(f.directory, 'kernel.json'), 'utf8')).includes('What did we decide'), false);
    await assert.rejects(f.service.confirm(review.id), /no longer pending/); assert.equal(f.prompts.length, 1);
  } finally { await f.close(); }
});

test('ambiguous, absent-project and insufficient-evidence questions stay local; missing key sends nothing', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.preview('What about that?')).pending, null);
    assert.equal((await f.service.preview('What about lunar botany?')).answer?.supported, false);
    f.project(null); assert.equal((await f.service.preview('What SQLite storage did we choose?')).pending, null);
    assert.deepEqual(f.counts(), { providerOpens: 0, secretReads: 0 });
    f.project('project'); f.noKey(); const review = (await f.service.preview('What SQLite storage did we choose?')).pending!;
    await assert.rejects(f.service.confirm(review.id)); assert.equal(f.prompts.length, 0);
    assert.equal((f.kernel.getRendererState() as { activeGrants: number; pendingRequests: number }).activeGrants, 0);
    assert.equal((f.kernel.getRendererState() as { pendingRequests: number }).pendingRequests, 0);
  } finally { await f.close(); }
});

test('project, privacy, model, expiration and forgotten evidence invalidate one-shot answer reviews before egress', async () => {
  for (const change of ['project', 'privacy', 'model', 'expire', 'forget', 'clear'] as const) {
    const f = await fixture();
    try {
      const review = (await f.service.preview('What SQLite storage did we choose?')).pending!;
      if (change === 'project') f.project('other'); else if (change === 'privacy') f.privacy(); else if (change === 'model') f.model(); else if (change === 'expire') f.expire();
      else if (change === 'forget') await f.store.privacy.forget({ eventIds: [f.corrected.eventId] }); else f.service.clear();
      await assert.rejects(f.service.confirm(review.id)); assert.equal(f.prompts.length, 0); assert.equal(f.counts().providerOpens, 0);
    } finally { await f.close(); }
  }
});

test('privacy clear suppresses a delayed result; output mute and stop suppress speech without losing a requested visual answer', async () => {
  for (const mode of ['privacy', 'mute', 'stop'] as const) {
    const f = await fixture(); let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
    try {
      const review = (await f.service.preview('What SQLite storage did we choose?')).pending!;
      const confirming = f.service.confirm(review.id);
      while (!f.prompts.length) await new Promise(resolve => setTimeout(resolve, 1));
      if (mode === 'privacy') { f.privacy(); f.service.clear(); } else if (mode === 'mute') f.mute(); else f.stopSpeech();
      release();
      if (mode === 'privacy') { await assert.rejects(confirming); assert.equal(f.service.snapshot().answer, null); assert.equal(f.spoken.length, 0); }
      else { assert.equal((await confirming).answer?.supported, true); assert.equal(f.spoken[0]?.speak, false); }
    } finally { release?.(); await f.close(); }
  }
});

test('spoken memory question and preview-bound answer phrase work without an agent and never dispatch agent instructions', async () => {
  const f = await fixture(); const sent: string[] = [];
  const work = { list: () => [], refreshAuth: async () => [], send: async (id: string) => { sent.push(id); } } as unknown as ManagedWork;
  const routing = createVoiceRouting({ work, companion: f.service, stopSpeech: f.stopSpeech, stopListening: async () => {} });
  const say = (text: string, utteranceId = text) => routing.transcript({ phase: 'final', text, utteranceId });
  try {
    await say('What SQLite storage did we choose?'); assert.equal(routing.snapshot().pending, null);
    assert.equal(routing.snapshot().companion?.pending?.kind, 'companion_answer');
    await say('yes'); await say('confirm send request'); assert.equal(f.prompts.length, 0);
    await say('confirm answer request'); assert.equal(f.prompts.length, 1); assert.deepEqual(sent, []);
    await say('confirm answer request', 'replay-confirm'); assert.equal(f.prompts.length, 1);
    await routing.transcript({ phase: 'partial', text: 'What SQLite storage did we choose?', utteranceId: 'partial' }); assert.equal(f.service.snapshot().pending, null);
  } finally { await f.close(); }
});

test('private question never reaches durable prompt storage, double-confirmation never replays, invalid citations produce an unknown', async () => {
  const f = await fixture();
  try {
    f.store.privacy.privateSessions.begin({ sessionId: 'private-process-test' });
    const review = (await f.service.preview('What SQLite storage did we choose for private-canary-question?')).pending!;
    f.response('The unrelated answer is definitely correct [99].');
    const first = f.service.confirm(review.id);
    await assert.rejects(f.service.confirm(review.id), /no longer pending/);
    const result = await first; assert.equal(result.answer?.supported, false); assert.equal(result.answer?.citedSourceIds.length, 0);
    assert.doesNotMatch(result.answer!.text, /definitely correct/);
    assert.equal((await readFile(join(f.directory, 'kernel.json'), 'utf8')).includes('private-canary-question'), false);
    f.privacy(); assert.equal(f.service.snapshot().answer, null);
  } finally { await f.close(); }
});

function screen(projectId = 'project'): import('./desktop-observe').ForegroundEvidence {
  return {kind: 'desktop_observe', projectId, observedAtMs: 1_800_000_001_000, quality: 'full', truncated: false, truncations: [],
    application: {pid: 10, bundleId: 'example.editor', name: 'Editor', bundleIdTruncated: false, nameTruncated: false},
    window: {role: 'AXWindow', title: 'Project', roleTruncated: false, titleTruncated: false},
    stats: {visitedNodes: 7, emittedNodes: 7, maxDepthReached: 1, estimatedBytes: 300},
    nodes: ['SQLite visible identifier', 'private-password', 'redacted-canary', 'second row', 'third row', 'fourth row', 'fifth row'].map((value, index) => ({depth: 1, role: 'AXTextField', subrole: index === 1 ? 'AXSecureTextField' : null,
      label: null, value, labelTruncated: false, valueTruncated: false, redacted: index === 2, roleTruncated: false, subroleTruncated: false}))};
}

test('screen observation is explicit, redacted, bounded and reviewed under desktop egress; immutable review ignores later changes', async () => {
  let observed = 0; const captured = screen();
  const f = await fixture({observeContext: async () => { observed++; return captured; }});
  try {
    await f.service.preview('What SQLite storage did we choose?'); assert.equal(observed, 0);
    const review = (await f.service.preview('What is on my screen?', {includeScreen: true})).pending!;
    assert.equal(observed, 1); assert.equal(review.evidence.filter(item => item.provenance === 'screen').length, 4);
    assert.ok(review.evidence.every(item => item.provenance !== 'screen' || item.summary.length <= 200));
    assert.doesNotMatch(JSON.stringify(review), /private-password|redacted-canary|fifth row/);
    (captured.nodes[0] as {value: string}).value = 'changed-after-review';
    await f.service.confirm(review.id);
    assert.match(f.prompts[0]!, /SQLite visible identifier/); assert.doesNotMatch(f.prompts[0]!, /changed-after-review|private-password|redacted-canary/);
    for (const item of review.evidence) assert.ok(f.prompts[0]!.includes(item.promptSummary!));
    const ledger = JSON.parse(await readFile(join(f.directory, 'kernel.json'), 'utf8'));
    assert.match(JSON.stringify(ledger), /desktop_ax_evidence/);
    assert.doesNotMatch(JSON.stringify(ledger), /SQLite visible identifier/);
  } finally { await f.close(); }
});

test('today and yesterday use local calendar boundaries, select activity without lexical overlap, and never borrow other dates', async () => {
  const instant = new Date(2026, 9, 1, 12).getTime();
  const rows = [0, -1, -2].map(offset => ({id: `day${offset}`, kind: 'summary', summary: `Unique artifact ${offset}`, sourceEventIds: [`event${offset}`], occurredAt: new Date(2026, 9, 1 + offset, 10).toISOString(), trust: 'tool_observed'}));
  const f = await fixture({now: () => instant, timeline: async () => rows});
  try {
    assert.deepEqual((await f.service.preview('What did we do today?')).pending?.evidence.map(item => item.id), ['day0']);
    assert.deepEqual((await f.service.preview('What did we do yesterday?')).pending?.evidence.map(item => item.id), ['day-1']);
    assert.equal((await f.service.preview('What lunar botany did we do yesterday?')).pending, null);
    rows.splice(1, 1);
    assert.equal((await f.service.preview('What did we do yesterday?')).pending, null);
  } finally { await f.close(); }
});

test('restored same-project dialogue enables reviewed follow-ups, persists only supported answers, and respects forgetting', async () => {
  let turns: import('./companion-answers').CompanionDialogueTurn[] = [{id: 'restored', projectId: 'project', question: 'What database?', answer: 'We discussed SQLite.', occurredAt: new Date(1_800_000_000_000).toISOString(), sourceEventIds: ['restored-event']}];
  const saved: string[] = [];
  const f = await fixture({recentDialogue: async () => turns, persistDialogue: async (project, question, answer) => {saved.push(`${project}:${question}:${answer}`);}});
  try {
    const review = (await f.service.preview('What about that?')).pending!;
    assert.equal(review.evidence[0]?.provenance, 'dialogue'); assert.match(review.evidence[0]!.summary, /discussed SQLite/);
    await f.service.confirm(review.id); assert.equal(saved.length, 1);
    const forgotten = (await f.service.preview('What about that?')).pending!; turns = [];
    await assert.rejects(f.service.confirm(forgotten.id), /conversation/); assert.equal(f.prompts.length, 1);
    turns = [{id: 'other', projectId: 'other', question: 'private project question', answer: 'private project answer', occurredAt: new Date().toISOString(), sourceEventIds: []}];
    assert.equal((await f.service.preview('What about that?')).pending, null);
    turns = [{id: 'again', projectId: 'project', question: 'Database?', answer: 'SQLite', occurredAt: new Date().toISOString(), sourceEventIds: []}];
    f.response('Unsupported answer [99].'); const invalid = (await f.service.preview('What about that?')).pending!;
    await f.service.confirm(invalid.id); assert.equal(saved.length, 1);
  } finally {await f.close();}
});

test('dialogue persistence failure keeps the answer and cannot repeat provider delivery', async () => {
  const f = await fixture({persistDialogue: async () => {throw Error('Disk unavailable');}});
  try {
    const review = (await f.service.preview('What SQLite storage did we choose?')).pending!;
    const result = await f.service.confirm(review.id); assert.equal(result.answer?.supported, true); assert.match(result.message, /Answer available; memory not saved/);
    await assert.rejects(f.service.confirm(review.id)); assert.equal(f.prompts.length, 1);
  } finally {await f.close();}
});

test('spoken explicit screen request observes once; generic memory questions do not observe; privacy invalidates screen review', async () => {
  let captures = 0;
  const f = await fixture({observeContext: async () => {captures++; return screen();}});
  const work = {list: () => []} as unknown as ManagedWork;
  const routing = createVoiceRouting({work, companion: f.service, stopSpeech: () => {}, stopListening: async () => {}});
  try {
    await routing.transcript({phase: 'final', text: 'What SQLite storage did we choose?', utteranceId: 'normal'}); assert.equal(captures, 0);
    await routing.transcript({phase: 'final', text: 'What am I looking at?', utteranceId: 'screen'}); assert.equal(captures, 1);
    const review = f.service.snapshot().pending!; f.privacy();
    await assert.rejects(f.service.confirm(review.id)); assert.equal(f.prompts.length, 0);
  } finally {await f.close();}
});

test('explicit companion session automatically answers once while default and exhausted authority remain reviewed, without Work sends', async () => {
  const f = await fixture(); const sent: string[] = [];
  const work = {list: () => [], send: async () => {sent.push('unexpected');}} as unknown as ManagedWork;
  let allowed = false; let budget = 1; let consumed = 0;
  const routing = createVoiceRouting({work, companion: f.service, stopSpeech: () => {}, stopListening: async () => {},
    autoAnswerAllowed: project => allowed && project === 'project', consumeAutoAnswer: project => {assert.equal(project, 'project'); consumed++; return budget-- > 0;}});
  try {
    await routing.transcript({phase: 'final', text: 'What SQLite storage did we choose?', utteranceId: 'default'});
    assert.equal(f.prompts.length, 0); assert.equal(consumed, 0); assert.ok(f.service.snapshot().pending);
    allowed = true;
    await routing.transcript({phase: 'final', text: 'What SQLite storage did we choose?', utteranceId: 'enabled'});
    assert.equal(f.prompts.length, 1); assert.equal(consumed, 1); assert.equal(f.service.snapshot().pending, null);
    await routing.transcript({phase: 'final', text: 'What SQLite storage did we choose?', utteranceId: 'enabled'}); assert.equal(f.prompts.length, 1);
    await routing.transcript({phase: 'final', text: 'What SQLite storage did we choose?', utteranceId: 'exhausted'});
    assert.equal(f.prompts.length, 1); assert.ok(f.service.snapshot().pending);
    await routing.transcript({phase: 'final', text: 'tell codex to delete files', utteranceId: 'instruction'});
    assert.equal(f.prompts.length, 1); assert.deepEqual(sent, []);
  } finally {await f.close();}
});

test('mixed evidence allocation retains project and history when explicit screen rows fill their quota', async () => {
  const turns = Array.from({length: 4}, (_, index) => ({id: `turn-${index}`, projectId: 'project', question: `Question ${index}`, answer: `Answer ${index}`, occurredAt: new Date(1_800_000_000_000 + index).toISOString(), sourceEventIds: [`turn-event-${index}`]}));
  const f = await fixture({observeContext: async () => screen(), recentDialogue: async () => turns});
  try {
    const view = (await f.service.preview('What SQLite storage is on my screen?', {includeScreen: true})).pending!;
    assert.equal(view.evidence.filter(item => item.provenance === 'screen').length, 4);
    assert.equal(view.evidence.filter(item => item.provenance === 'memory').length, 1);
    assert.equal(view.evidence.filter(item => item.provenance === 'dialogue').length, 3);
    assert.equal(view.evidence.length, 8);
    const restored = createCompanionAnswers({activeProjectId: () => 'project', privacyGeneration: () => 0, model: () => 'gpt-6-luna', timeline: async () => [], recentDialogue: async () => turns,
      provider: async () => {throw Error('Preview must not use provider');}});
    const restarted = (await restored.preview('What about that?')).pending!;
    assert.equal(restarted.evidence.length, 4); assert.ok(restarted.evidence.every(item => item.provenance === 'dialogue'));
    restored.clear();
  } finally {await f.close();}
});
