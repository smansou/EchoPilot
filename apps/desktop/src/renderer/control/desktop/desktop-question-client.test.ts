/**
 * Focused tests for the Mission Control → Desktop grounded-question controller. A fake transport
 * records every call, so the single most important property is provable here: nothing but an
 * explicit `confirm` of a stored preview ever reaches the confirm route (the only route that can
 * reach the provider), and changing the question, project, or snapshot always withdraws the
 * pending confirmation first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDesktopQuestionClient,
  desktopQuestionExpiry,
  desktopQuestionSourceAge,
  DesktopQuestionRouteError,
  parseDesktopAnswerContext,
  parseDesktopQuestionAnswer,
  parseDesktopQuestionPreview,
  type DesktopQuestionSource,
  type DesktopQuestionTransport,
} from './desktop-question-client';
import type { WorkSessionSummary } from '../../widget/desktop-inspect';

const PROJECT_ID = 'project-atlas';
const OTHER_ID = 'project-borealis';
const OBSERVED_AT = 1_759_000_000_000;
const NOW = OBSERVED_AT + 30_000;
const EXPIRES_AT = OBSERVED_AT + 300_000;

function source(): DesktopQuestionSource {
  return {
    rows: [{
      number: 1, evidenceId: 'desk:ax:0', role: 'AXStaticText', label: 'Retry budget', value: '5', truncated: false,
    }],
    omittedRows: 0,
    application: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 501, identityTruncated: false },
    window: { role: 'AXWindow', title: 'Untitled', titleTruncated: false },
    quality: 'full',
    truncated: false,
    truncations: [],
    observedAtMs: OBSERVED_AT,
  };
}

function previewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confirmationId: 'confirmation-1',
    snapshotId: 'snapshot-1',
    question: 'What is the retry budget?',
    prompt: '[1] Retry budget — 5',
    evidence: source(),
    destination: { providerId: 'openai', model: 'gpt-6-luna' },
    expiresAtMs: EXPIRES_AT,
    ...overrides,
  };
}

function answerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answer: 'The retry budget is five [1].',
    answerKind: 'model_generated',
    citationsVerified: false,
    model: 'gpt-6-luna',
    inputTokens: 120,
    outputTokens: 18,
    estimatedUsd: null,
    snapshotId: 'snapshot-1',
    evidence: source(),
    ...overrides,
  };
}

type Call =
  | Readonly<{ kind: 'work-status' }>
  | Readonly<{ kind: 'context'; projectId: string }>
  | Readonly<{ kind: 'preview'; projectId: string; snapshotId: string; question: string }>
  | Readonly<{ kind: 'confirm'; projectId: string; confirmationId: string; confirmed: true }>
  | Readonly<{ kind: 'cancel'; projectId: string; confirmationId: string }>;

class FakeTransport implements DesktopQuestionTransport {
  readonly calls: Call[] = [];
  sessions: readonly WorkSessionSummary[] = [
    { id: 'session-1', projectId: PROJECT_ID, label: 'Atlas', active: true },
  ];
  context: unknown = { snapshot: { snapshotId: 'snapshot-1', observedAtMs: OBSERVED_AT, expiresAtMs: EXPIRES_AT } };
  previewResult: unknown = previewPayload();
  answerResult: unknown = answerPayload();
  previewError: Error | null = null;
  confirmError: Error | null = null;
  cancelError: Error | null = null;
  confirmPending: Promise<unknown> | null = null;

  async loadWorkSessions(): Promise<readonly WorkSessionSummary[]> {
    this.calls.push({ kind: 'work-status' });
    return this.sessions;
  }
  async loadContext(projectId: string): Promise<unknown> {
    this.calls.push({ kind: 'context', projectId });
    return this.context;
  }
  async postPreview(input: Readonly<{ projectId: string; snapshotId: string; question: string }>): Promise<unknown> {
    this.calls.push({ kind: 'preview', ...input });
    if (this.previewError) throw this.previewError;
    return this.previewResult;
  }
  async postConfirm(input: Readonly<{ projectId: string; confirmationId: string; confirmed: true }>): Promise<unknown> {
    this.calls.push({ kind: 'confirm', ...input });
    if (this.confirmPending) return this.confirmPending;
    if (this.confirmError) throw this.confirmError;
    return this.answerResult;
  }
  async postCancel(input: Readonly<{ projectId: string; confirmationId: string }>): Promise<unknown> {
    this.calls.push({ kind: 'cancel', ...input });
    if (this.cancelError) throw this.cancelError;
    return { canceled: true };
  }
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function kinds(transport: FakeTransport): string[] {
  return transport.calls.map((call) => call.kind);
}

function clientFor(transport: FakeTransport, selectedProjectId: string | null = null) {
  return createDesktopQuestionClient({
    transport,
    selectedProjectId: () => selectedProjectId,
    now: () => NOW,
  });
}

test('loadContext resolves the active project through the remembered selection and only reads', async () => {
  const transport = new FakeTransport();
  transport.sessions = [
    { id: 'session-1', projectId: PROJECT_ID, label: 'Atlas', active: true },
    { id: 'session-2', projectId: OTHER_ID, label: 'Borealis', active: true },
  ];
  const client = clientFor(transport, OTHER_ID);

  await client.loadContext();
  const state = client.getSnapshot();
  assert.equal(state.context.kind, 'ready');
  if (state.context.kind === 'ready') {
    assert.equal(state.context.projectId, OTHER_ID);
    assert.equal(state.context.projectLabel, 'Borealis');
    assert.equal(state.context.snapshot?.snapshotId, 'snapshot-1');
  }
  assert.deepEqual(kinds(transport), ['work-status', 'context']);
  assert.deepEqual(transport.calls[1], { kind: 'context', projectId: OTHER_ID });
});

test('loadContext is honest about an empty or ambiguous scope and never guesses one', async () => {
  const transport = new FakeTransport();
  transport.sessions = [];
  const client = clientFor(transport);
  await client.loadContext();
  const empty = client.getSnapshot().context;
  assert.equal(empty.kind, 'blocked');
  if (empty.kind === 'blocked') assert.equal(empty.activeProjects, 0);
  assert.deepEqual(kinds(transport), ['work-status'], 'an empty scope performs no context lookup');

  const ambiguous = new FakeTransport();
  ambiguous.sessions = [
    { id: 'session-1', projectId: PROJECT_ID, label: 'Atlas', active: true },
    { id: 'session-2', projectId: OTHER_ID, label: 'Borealis', active: true },
  ];
  const second = clientFor(ambiguous);
  await second.loadContext();
  const state = second.getSnapshot().context;
  assert.equal(state.kind, 'blocked');
  if (state.kind === 'blocked') {
    assert.equal(state.activeProjects, 2);
    assert.deepEqual(state.options.map((option) => option.projectId), [PROJECT_ID, OTHER_ID]);
  }
  assert.deepEqual(kinds(ambiguous), ['work-status'], 'an ambiguous scope performs no context lookup');
});

test('a no-snapshot context is ready with an honest null snapshot', async () => {
  const transport = new FakeTransport();
  transport.context = { snapshot: null };
  const client = clientFor(transport);
  await client.loadContext();
  const context = client.getSnapshot().context;
  assert.equal(context.kind, 'ready');
  if (context.kind === 'ready') assert.equal(context.snapshot, null);
});

test('a malformed context response surfaces a concrete error instead of a guessed snapshot', async () => {
  const transport = new FakeTransport();
  transport.context = { snapshot: { snapshotId: '', observedAtMs: OBSERVED_AT, expiresAtMs: EXPIRES_AT } };
  const client = clientFor(transport);
  await client.loadContext();
  const context = client.getSnapshot().context;
  assert.equal(context.kind, 'error');
  if (context.kind === 'error') assert.match(context.message, /desktop-answer-context: snapshotId is invalid/);
});

test('previewing posts exactly once and sends nothing until an explicit confirm', async () => {
  const transport = new FakeTransport();
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('  What is the retry budget?  ');
  await client.preview();

  assert.deepEqual(transport.calls.filter((call) => call.kind === 'preview'), [{
    kind: 'preview', projectId: PROJECT_ID, snapshotId: 'snapshot-1', question: 'What is the retry budget?',
  }]);
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'confirm'), [], 'reviewing never confirms');
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'cancel'), [], 'a fresh preview is not canceled');

  const state = client.getSnapshot();
  assert.equal(state.phase, 'idle');
  assert.equal(state.preview?.confirmationId, 'confirmation-1');
  assert.equal(state.preview?.prompt, '[1] Retry budget — 5');
  assert.equal(state.preview?.providerId, 'openai');
  assert.equal(state.preview?.model, 'gpt-6-luna');
  assert.equal(state.answer, null);
});

test('editing the question withdraws the pending confirmation before anything could be sent', async () => {
  const transport = new FakeTransport();
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();
  assert.equal(client.getSnapshot().preview?.confirmationId, 'confirmation-1');

  client.setQuestion('What is the retry budget? And the backoff?');
  const state = client.getSnapshot();
  assert.equal(state.preview, null, 'changed input can never reuse the old confirmation');
  assert.equal(state.phase, 'idle');
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'cancel'), ['cancel']);
  assert.deepEqual(transport.calls.filter((call) => call.kind === 'cancel'), [{
    kind: 'cancel', projectId: PROJECT_ID, confirmationId: 'confirmation-1',
  }]);
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'confirm'), []);
});

test('a context refresh that moves the project or snapshot withdraws the pending confirmation', async () => {
  const transport = new FakeTransport();
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();

  transport.context = { snapshot: { snapshotId: 'snapshot-2', observedAtMs: OBSERVED_AT + 1_000, expiresAtMs: EXPIRES_AT } };
  await client.loadContext();
  const state = client.getSnapshot();
  assert.equal(state.preview, null);
  assert.equal(state.context.kind === 'ready' ? state.context.snapshot?.snapshotId : null, 'snapshot-2');
  assert.deepEqual(transport.calls.filter((call) => call.kind === 'cancel'), [{
    kind: 'cancel', projectId: PROJECT_ID, confirmationId: 'confirmation-1',
  }]);
});

test('a duplicate confirm click issues exactly one confirm request', async () => {
  const transport = new FakeTransport();
  const gate = deferred<unknown>();
  transport.confirmPending = gate.promise;
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();

  const first = client.confirm();
  const second = client.confirm();
  assert.equal(client.getSnapshot().phase, 'confirming');
  gate.resolve(answerPayload());
  await Promise.all([first, second]);

  assert.deepEqual(transport.calls.filter((call) => call.kind === 'confirm'), [{
    kind: 'confirm', projectId: PROJECT_ID, confirmationId: 'confirmation-1', confirmed: true,
  }]);
  const state = client.getSnapshot();
  assert.equal(state.phase, 'answered');
  assert.equal(state.preview, null);
  assert.equal(state.answer?.answer, 'The retry budget is five [1].');
  assert.equal(state.answer?.citationsVerified, false);
  assert.equal(state.answer?.estimatedUsd, null);
  assert.equal(state.answer?.inputTokens, 120);
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'preview'), ['preview'], 'confirming reuses the stored preview');
});

test('a failed confirm consumes the preview and refuses a stale retry without a new preview', async () => {
  const transport = new FakeTransport();
  transport.confirmError = new DesktopQuestionRouteError('Another desktop answer is already running.', 'busy', 409);
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();
  await client.confirm();

  const failed = client.getSnapshot();
  assert.equal(failed.preview, null);
  assert.equal(failed.error?.code, 'busy');
  assert.equal(failed.error?.requiresNewPreview, true);
  assert.match(failed.error?.message ?? '', /Another desktop answer is already running/);

  await client.confirm();
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'confirm'), ['confirm'], 'a consumed confirmation is never replayed');
});

test('preview refusals keep their route code and clear a snapshot that is gone', async () => {
  const transport = new FakeTransport();
  transport.previewError = new DesktopQuestionRouteError('The observation snapshot expired; observe again.', 'snapshot_expired', 410);
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();

  const state = client.getSnapshot();
  assert.equal(state.error?.code, 'snapshot_expired');
  assert.match(state.error?.message ?? '', /expired/);
  assert.equal(state.context.kind === 'ready' ? state.context.snapshot : 'not-ready', null, 'an expired pointer is cleared');
});

test('malformed confirmation responses reject concrete bounded fields', async () => {
  const transport = new FakeTransport();
  transport.previewResult = previewPayload({ prompt: 'x'.repeat(12_001) });
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();
  assert.equal(client.getSnapshot().error?.code, 'malformed');
  assert.match(client.getSnapshot().error?.message ?? '', /prompt is invalid/);

  const answerTransport = new FakeTransport();
  answerTransport.answerResult = answerPayload({ inputTokens: -1 });
  const second = clientFor(answerTransport);
  await second.loadContext();
  second.setQuestion('What is the retry budget?');
  await second.preview();
  await second.confirm();
  const state = second.getSnapshot();
  assert.equal(state.error?.code, 'malformed');
  assert.match(state.error?.message ?? '', /inputTokens is invalid/);
  assert.equal(state.error?.requiresNewPreview, true);
});

test('parsers reject out-of-bounds route fields with concrete messages', () => {
  assert.throws(
    () => parseDesktopAnswerContext({ snapshot: { snapshotId: 's', observedAtMs: 200, expiresAtMs: 100 } }, PROJECT_ID),
    /expiresAtMs precedes observedAtMs/,
  );
  assert.throws(() => parseDesktopAnswerContext({}, PROJECT_ID), /snapshot is missing/);
  assert.throws(
    () => parseDesktopQuestionPreview(previewPayload({ destination: { providerId: 'someone-else', model: 'm' } }), PROJECT_ID),
    /destination is invalid/,
  );
  assert.throws(
    () => parseDesktopQuestionPreview(previewPayload({ question: 'q'.repeat(1_001) }), PROJECT_ID),
    /question is invalid/,
  );
  assert.throws(() => parseDesktopQuestionAnswer(answerPayload({ citationsVerified: true }), 'snapshot-1'), /citationsVerified must stay false/);
  assert.throws(() => parseDesktopQuestionAnswer(answerPayload({ snapshotId: 'other' }), 'snapshot-1'), /snapshotId does not match the preview/);
});

test('canceling a preview withdraws it locally and best-effort posts the exact pair', async () => {
  const transport = new FakeTransport();
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();
  await client.cancelPreview();

  const state = client.getSnapshot();
  assert.equal(state.preview, null);
  assert.equal(state.phase, 'idle');
  assert.deepEqual(transport.calls.filter((call) => call.kind === 'cancel'), [{
    kind: 'cancel', projectId: PROJECT_ID, confirmationId: 'confirmation-1',
  }]);
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'confirm'), []);

  // A refused cancel never blocks the page; the confirmation expires on its own server side.
  const tolerant = new FakeTransport();
  tolerant.cancelError = new Error('route refused');
  const second = clientFor(tolerant);
  await second.loadContext();
  second.setQuestion('What is the retry budget?');
  await second.preview();
  await second.cancelPreview();
  assert.equal(second.getSnapshot().preview, null);
});

test('dispose withdraws an unconsumed preview and stops delivering updates', async () => {
  const transport = new FakeTransport();
  const client = clientFor(transport);
  await client.loadContext();
  client.setQuestion('What is the retry budget?');
  await client.preview();

  let notified = 0;
  client.subscribe(() => { notified += 1; });
  client.dispose();
  assert.deepEqual(transport.calls.filter((call) => call.kind === 'cancel'), [{
    kind: 'cancel', projectId: PROJECT_ID, confirmationId: 'confirmation-1',
  }]);
  client.setQuestion('after dispose');
  assert.equal(notified, 0, 'a disposed page never updates');
  await client.loadContext();
  assert.deepEqual(kinds(transport).filter((kind) => kind === 'context'), ['context'], 'a disposed page never reloads context');
});

test('source age and expiry copy never overstate freshness', () => {
  assert.equal(desktopQuestionSourceAge(OBSERVED_AT, OBSERVED_AT + 1_000), 'just now');
  assert.equal(desktopQuestionSourceAge(OBSERVED_AT, OBSERVED_AT + 30_000), '30 seconds ago');
  assert.equal(desktopQuestionSourceAge(OBSERVED_AT, OBSERVED_AT + 5 * 60_000), '5 minutes ago');
  assert.equal(desktopQuestionSourceAge(OBSERVED_AT + 60_000, OBSERVED_AT), 'just now', 'clock skew never produces a negative age');
  assert.equal(desktopQuestionExpiry(EXPIRES_AT, EXPIRES_AT + 1), 'expired');
  assert.equal(desktopQuestionExpiry(EXPIRES_AT, EXPIRES_AT - 30_000), 'expires within a minute');
  assert.equal(desktopQuestionExpiry(EXPIRES_AT, EXPIRES_AT - 4 * 60_000), 'expires in about 4 minutes');
});
