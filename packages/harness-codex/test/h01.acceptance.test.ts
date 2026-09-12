/**
 * H01 acceptance test — managed Codex tracer bullet (IMPLEMENTATION_PLAN.md §5.3, ticket H01).
 *
 * Path under test: start managed Codex → prompt → tool/result events → UI → interrupt/resume.
 *
 * The adapter is driven against `fixtures/harness/codex/fake-app-server.mjs`: a real child process
 * that speaks the pinned Codex app-server protocol (`codex-cli 0.154.0`, the installed tested version
 * whose generated JSON schemas this ticket consumes) over newline-delimited JSON-RPC on stdio, and
 * journals every message it sends or receives. No real Codex session, account, or network is used.
 *
 * Frozen contract for `packages/harness-codex/src/index.ts`:
 *
 *   createCodexHarnessAdapter(options) → CodexHarnessAdapter
 *     options = { command, args?, cwd, env?, scope }
 *       command/args — argv array for the app-server child (never a shell string)
 *       cwd          — scoped working directory for the child
 *       env          — explicit extra environment entries on top of a scrubbed environment
 *       scope        — base Scope for normalized events; sessionId becomes the app-server thread id
 *     Implements the packages/contracts HarnessAdapter interface plus:
 *       info() → { adapter: 'codex-app-server', supportedVersion, serverVersion, compatible,
 *                  capabilities }
 *
 *   Behavior fixed here:
 *     - start() spawns the child and performs the initialize request → initialized notification
 *       handshake before any thread or turn call.
 *     - observe() may be consumed before or after start(); events are buffered so none are lost,
 *       and every envelope satisfies the shared v1 EventEnvelope contract (parseEventEnvelope).
 *     - send() starts a thread (thread/start) and a turn (turn/start) whose `input` carries the
 *       instruction as a text item, then resolves with the acknowledged delivery receipt.
 *     - Notifications normalize as: item/started commandExecution → tool_started,
 *       item/completed commandExecution → tool_completed (trust tool_observed), item/completed
 *       agentMessage → agent_message (trust agent_reported), thread/turn lifecycle →
 *       session_state. Turn-scoped events carry `turnId`; scope.sessionId is the thread id.
 *     - Streamed reasoning is never user-visible content: it must not appear in normalized events,
 *       and it must not be counted as an agent message.
 *     - interrupt(turnId) sends turn/interrupt and the interrupted turn completion is observed.
 *     - resume(threadId) sends thread/resume; a later send() reuses that thread for a new turn.
 *     - An approval request is normalized to an `approval_requested` event whose sourceEventId is
 *       the app-server JSON-RPC request id, and stays unanswered until respondApproval() is called
 *       with that id (approve → `accept`, deny → `decline`). Nothing about a companion failure may
 *       answer a pending request.
 *     - info().compatible is true only when the initialize response reports `codex-cli/<version>`
 *       equal to the generated-schema version this adapter ships (0.154.0). Any other version is
 *       observe-only: capabilities() is exactly {observe}, every mutation call rejects, no mutation
 *       method reaches the wire, and unknown notification methods are preserved as `unsupported`
 *       envelopes whose `unsupportedKind` is the raw app-server method.
 *     - close() terminates the child; the fixture records a shutdown lifecycle entry.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseEventEnvelope,
  type EventEnvelope,
  type HarnessCapability,
  type HarnessDeliveryReceipt,
  type Scope,
} from '../../contracts/src/index.js';

/** Version of `codex app-server` whose generated schemas and fixture messages this suite pins. */
const PINNED_VERSION = '0.154.0';
const HIDDEN_REASONING_SENTINEL = 'H01-HIDDEN-REASONING-SENTINEL';
const FIXTURE_ROOT = new URL('../../../fixtures/harness/codex/', import.meta.url);

type CodexHarnessInfo = Readonly<{
  adapter: 'codex-app-server';
  supportedVersion: string;
  serverVersion: string;
  compatible: boolean;
  capabilities: ReadonlyArray<HarnessCapability>;
}>;

type CodexHarnessAdapter = {
  info(): Promise<CodexHarnessInfo>;
  capabilities(): Promise<ReadonlySet<HarnessCapability>>;
  start(): Promise<void>;
  observe(): AsyncIterable<EventEnvelope>;
  send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  resume(sessionId: string): Promise<void>;
  close(): Promise<void>;
};

type CodexHarnessOptions = Readonly<{
  command: string;
  args?: ReadonlyArray<string>;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  scope: Scope;
}>;

type CreateCodexHarnessAdapter = (options: CodexHarnessOptions) => CodexHarnessAdapter;

type JournalEntry = {
  dir: 'in' | 'out' | 'lifecycle';
  message?: Record<string, unknown>;
  event?: string;
  reason?: string;
};

type EventStream = {
  events: EventEnvelope[];
  iterator: AsyncIterator<EventEnvelope>;
  waitFor(
    predicate: (event: EventEnvelope, index: number) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<EventEnvelope>;
};

/** Loads the yet-to-be-implemented adapter, turning "module missing" into a named failure. */
async function loadAdapter(): Promise<CreateCodexHarnessAdapter> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('../src/index.js')) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/harness-codex/src/index.ts must export '
        + 'createCodexHarnessAdapter() so a managed Codex app-server session can be started, prompted, '
        + 'observed, interrupted, resumed, approval-gated, and closed over stdio.',
      );
    }
    throw error;
  }
  assert.equal(
    typeof loaded.createCodexHarnessAdapter,
    'function',
    'packages/harness-codex must export createCodexHarnessAdapter()',
  );
  return loaded.createCodexHarnessAdapter as CreateCodexHarnessAdapter;
}

function fixtureAdapter(
  create: CreateCodexHarnessAdapter,
  scenario: 'readonly-task' | 'approval' | 'version-mismatch',
  journalPath: string,
  serverVersion: string = PINNED_VERSION,
): CodexHarnessAdapter {
  return create({
    command: process.execPath,
    args: [fileURLToPath(new URL('fake-app-server.mjs', FIXTURE_ROOT))],
    cwd: fileURLToPath(FIXTURE_ROOT),
    env: { H01_SCENARIO: scenario, H01_JOURNAL: journalPath, H01_SERVER_VERSION: serverVersion },
    scope: { profileId: 'h01-profile', projectId: 'echopilot', worktreeId: 'h01', sensitivity: 'normal' },
  });
}

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function readJournal(path: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

async function waitForJournal(
  path: string,
  predicate: (entry: JournalEntry) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<JournalEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = (await readJournal(path)).find(predicate);
    if (match) return match;
    if (Date.now() >= deadline) {
      assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description} in the app-server journal`);
    }
    await settle(20);
  }
}

function inboundMethods(entries: readonly JournalEntry[]): string[] {
  return entries
    .filter((entry) => entry.dir === 'in' && typeof entry.message?.method === 'string')
    .map((entry) => String(entry.message?.method));
}

function inboundCalls(entries: readonly JournalEntry[], method: string): JournalEntry[] {
  return entries.filter((entry) => entry.dir === 'in' && entry.message?.method === method);
}

/** Waits until the child has actually read the given request (the journal write is async). */
async function waitForInboundCall(
  path: string,
  method: string,
  description: string,
  occurrence = 0,
  timeoutMs = 5_000,
): Promise<JournalEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = inboundCalls(await readJournal(path), method)[occurrence];
    if (match !== undefined) return match;
    if (Date.now() >= deadline) {
      assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description} in the app-server journal`);
    }
    await settle(20);
  }
}

function paramsOf(entry: JournalEntry): Record<string, unknown> {
  const params = entry.message?.params;
  assert.ok(params !== null && typeof params === 'object', 'an app-server request must carry params');
  return params as Record<string, unknown>;
}

/** A JSON-RPC response from the adapter to a server-initiated request. */
function isResponseTo(entry: JournalEntry, requestId: string): boolean {
  const message = entry.message;
  return entry.dir === 'in'
    && message !== undefined
    && !('method' in message)
    && 'id' in message
    && String(message.id) === requestId;
}

function assertContractEnvelope(event: EventEnvelope, label: string): void {
  const parsed = parseEventEnvelope(event);
  assert.equal(parsed.eventId, event.eventId, `${label}: event identity must survive contract validation`);
  assert.ok(parsed.payloadRef.length > 0 && parsed.contentHash.length > 0, `${label}: payload reference and content hash are required`);
  if (event.kind === 'unsupported') {
    assert.ok(
      typeof event.unsupportedKind === 'string' && event.unsupportedKind.length > 0,
      `${label}: unsupported events must preserve the raw app-server method`,
    );
    return;
  }
  assert.equal(parsed.kind, event.kind, `${label}: kind must be a known contract kind, not a passthrough of ${event.kind}`);
}

async function nextEvent(stream: EventStream, description: string, timeoutMs: number): Promise<EventEnvelope> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const observed = stream.events.map((event) => event.kind).join(', ') || 'none';
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}. Observed kinds: ${observed}`));
    }, timeoutMs);
  });
  const next = (async (): Promise<EventEnvelope> => {
    const result = await stream.iterator.next();
    if (result.done === true) {
      throw new Error(`The observation stream ended before ${description} was observed`);
    }
    stream.events.push(result.value);
    return result.value;
  })();
  try {
    return await Promise.race([next, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function consume(adapter: CodexHarnessAdapter): EventStream {
  const stream: EventStream = {
    iterator: adapter.observe()[Symbol.asyncIterator](),
    events: [],
    async waitFor(predicate, description, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = stream.events.length;
        const event = await nextEvent(stream, description, Math.max(25, deadline - Date.now()));
        if (predicate(event, index)) return event;
      }
    },
  };
  return stream;
}

async function closeQuietly(adapter: CodexHarnessAdapter | undefined): Promise<void> {
  if (!adapter) return;
  await Promise.race([adapter.close().catch(() => undefined), settle(2_000)]);
}

test('a managed session streams a read-only fixture task, reports version/capabilities, and survives interrupt and resume', async () => {
  const createCodexHarnessAdapter = await loadAdapter();
  const directory = await mkdtemp(join(tmpdir(), 'h01-codex-readonly-'));
  const journalPath = join(directory, 'journal.jsonl');
  const adapter = fixtureAdapter(createCodexHarnessAdapter, 'readonly-task', journalPath);
  const stream = consume(adapter);
  try {
    await adapter.start();

    const info = await adapter.info();
    assert.deepEqual(
      {
        adapter: info.adapter,
        supportedVersion: info.supportedVersion,
        serverVersion: info.serverVersion,
        compatible: info.compatible,
      },
      {
        adapter: 'codex-app-server',
        supportedVersion: PINNED_VERSION,
        serverVersion: PINNED_VERSION,
        compatible: true,
      },
      'the adapter must report the generated-schema version and the attached app-server version',
    );
    const capabilities = [...(await adapter.capabilities())].sort();
    assert.deepEqual(capabilities, ['approval', 'interrupt', 'observe', 'resume', 'send']);
    assert.deepEqual([...info.capabilities].sort(), capabilities, 'info() and capabilities() must agree');

    const initialize = inboundCalls(await readJournal(journalPath), 'initialize')[0];
    assert.ok(initialize, 'start() must send the initialize request');
    const clientInfo = paramsOf(initialize).clientInfo as { name?: unknown } | undefined;
    assert.ok(
      clientInfo !== null && typeof clientInfo === 'object' && typeof clientInfo.name === 'string' && clientInfo.name.length > 0,
      'initialize must identify the managing client',
    );
    await waitForJournal(
      journalPath,
      (entry) => inboundMethods([entry]).includes('initialized'),
      'initialized notification',
    );
    assert.equal(inboundMethods(await readJournal(journalPath)).slice(0, 2).join(','), 'initialize,initialized');

    const receipt = await adapter.send(
      'Read fixtures/harness/codex/readonly-task.txt and report its contents.',
      'delivery-1',
    );
    assert.deepEqual(receipt, { deliveryId: 'delivery-1', status: 'acknowledged' });

    const toolStarted = await stream.waitFor((event) => event.kind === 'tool_started', 'tool_started event');
    const toolCompleted = await stream.waitFor((event) => event.kind === 'tool_completed', 'tool_completed event');
    const message = await stream.waitFor((event) => event.kind === 'agent_message', 'agent_message event');
    assert.equal(toolStarted.turnId, 'turn-1');
    assert.equal(toolCompleted.turnId, 'turn-1');
    assert.equal(message.turnId, 'turn-1');
    for (const [label, event] of [
      ['tool_started', toolStarted],
      ['tool_completed', toolCompleted],
      ['agent_message', message],
    ] as const) {
      assert.equal(event.scope.sessionId, 'thread-1', `${label} must be scoped to the app-server thread`);
      assertContractEnvelope(event, label);
    }
    assert.equal(toolStarted.trust, 'tool_observed', 'tool lifecycle is observed, not agent-reported');
    assert.equal(toolCompleted.trust, 'tool_observed');
    assert.equal(message.trust, 'agent_reported');
    assert.ok(
      toolStarted.sourceSequence < toolCompleted.sourceSequence
        && toolCompleted.sourceSequence < message.sourceSequence,
      'streamed results must keep app-server order',
    );

    const turnStart = await waitForInboundCall(journalPath, 'turn/start', 'turn/start call');
    const methods = inboundMethods(await readJournal(journalPath));
    const threadStartIndex = methods.indexOf('thread/start');
    assert.ok(
      threadStartIndex >= 0 && threadStartIndex < methods.indexOf('turn/start'),
      'a thread must be started before the first turn',
    );
    assert.equal(paramsOf(turnStart).threadId, 'thread-1', 'the turn must run on the server-issued thread id');
    const input = paramsOf(turnStart).input as ReadonlyArray<{ type?: unknown; text?: unknown }>;
    assert.ok(
      Array.isArray(input)
        && input.some((item) => item.type === 'text' && typeof item.text === 'string' && item.text.includes('readonly-task.txt')),
      'the instruction must reach the app-server as text input',
    );

    const interruptedFrom = stream.events.length;
    await adapter.interrupt(toolCompleted.turnId ?? 'turn-1');
    const interruptCall = await waitForInboundCall(journalPath, 'turn/interrupt', 'turn/interrupt call');
    assert.equal(paramsOf(interruptCall).threadId, 'thread-1');
    assert.equal(paramsOf(interruptCall).turnId, 'turn-1');
    await stream.waitFor(
      (event, index) => index >= interruptedFrom && event.kind === 'session_state' && event.turnId === 'turn-1',
      'interrupted turn completion',
    );

    const turnOne = stream.events.filter((event) => event.turnId === 'turn-1');
    const kindsInTurnOne = turnOne.map((event) => event.kind);
    assert.equal(kindsInTurnOne.filter((kind) => kind === 'tool_started').length, 1, 'one tool start per observed tool call');
    assert.equal(kindsInTurnOne.filter((kind) => kind === 'tool_completed').length, 1, 'one tool completion per observed tool call');
    assert.equal(
      kindsInTurnOne.filter((kind) => kind === 'agent_message').length,
      1,
      'one agent message per assistant message: streamed reasoning must never become user-visible content',
    );
    assert.equal(
      JSON.stringify(stream.events).includes(HIDDEN_REASONING_SENTINEL),
      false,
      'hidden reasoning must not leak into normalized events',
    );

    await adapter.resume('thread-1');
    const resumeCall = await waitForInboundCall(journalPath, 'thread/resume', 'thread/resume call');
    assert.equal(paramsOf(resumeCall).threadId, 'thread-1');
    const secondReceipt = await adapter.send('Report how many lines the fixture file has.', 'delivery-2');
    assert.deepEqual(secondReceipt, { deliveryId: 'delivery-2', status: 'acknowledged' });
    const resumedMessage = await stream.waitFor(
      (event) => event.kind === 'agent_message' && event.turnId === 'turn-2',
      'resumed turn result',
    );
    assert.equal(resumedMessage.scope.sessionId, 'thread-1');
    const secondTurnStart = await waitForInboundCall(journalPath, 'turn/start', 'second turn/start call', 1);
    assert.equal(paramsOf(secondTurnStart).threadId, 'thread-1', 'resume must continue the recorded thread');

    const eventIds = stream.events.map((event) => event.eventId);
    assert.equal(new Set(eventIds).size, eventIds.length, 'normalized event ids must be unique');
    const sourceIds = new Set(stream.events.map((event) => event.sourceId));
    assert.equal(sourceIds.size, 1, 'one managed app-server is one event source');
    for (let index = 1; index < stream.events.length; index += 1) {
      const previous = stream.events[index - 1] as EventEnvelope;
      const current = stream.events[index] as EventEnvelope;
      assert.ok(current.sourceSequence > previous.sourceSequence, `sourceSequence must increase at index ${index}`);
      assert.ok(current.ingestSequence > previous.ingestSequence, `ingestSequence must increase at index ${index}`);
    }
    for (const event of stream.events) assertContractEnvelope(event, 'streamed event');

    await adapter.close();
    await waitForJournal(journalPath, (entry) => entry.dir === 'lifecycle' && entry.event === 'shutdown', 'fixture shutdown after close()');
  } finally {
    await closeQuietly(adapter);
    await rm(directory, { recursive: true, force: true });
  }
});

test('approval requests stay pending until an authorized response and are never auto-approved', async () => {
  const createCodexHarnessAdapter = await loadAdapter();

  const directory = await mkdtemp(join(tmpdir(), 'h01-codex-approval-'));
  const journalPath = join(directory, 'journal.jsonl');
  const adapter = fixtureAdapter(createCodexHarnessAdapter, 'approval', journalPath);
  const stream = consume(adapter);
  try {
    await adapter.start();
    const receipt = await adapter.send('Run the fixture command that requires approval.', 'delivery-1');
    assert.equal(receipt.status, 'acknowledged');

    const approval = await stream.waitFor((event) => event.kind === 'approval_requested', 'approval_requested event');
    assert.equal(approval.turnId, 'turn-1');
    assert.equal(approval.scope.sessionId, 'thread-1');
    assertContractEnvelope(approval, 'approval_requested');
    const requestId = approval.sourceEventId;
    assert.ok(requestId.length > 0, 'the approval event must expose the app-server request id');

    await settle(300);
    const journal = await readJournal(journalPath);
    assert.equal(
      journal.some((entry) => isResponseTo(entry, requestId)),
      false,
      'an approval must stay pending until respondApproval() supplies an authorized decision',
    );
    assert.equal(
      stream.events.some((event) => event.kind === 'tool_completed'),
      false,
      'the guarded tool must not complete while the approval is pending',
    );

    await adapter.respondApproval(requestId, 'approve');
    const response = await waitForJournal(
      journalPath,
      (entry) => isResponseTo(entry, requestId),
      'response to the pending approval request',
    );
    assert.deepEqual(response.message?.result, { decision: 'accept' }, 'approve must map to the documented accept decision');

    await stream.waitFor((event) => event.kind === 'tool_completed', 'approved tool completion');
    await stream.waitFor((event) => event.kind === 'agent_message', 'approved turn result');
    await adapter.close();
    await waitForJournal(journalPath, (entry) => entry.dir === 'lifecycle' && entry.event === 'shutdown', 'fixture shutdown after close()');
  } finally {
    await closeQuietly(adapter);
    await rm(directory, { recursive: true, force: true });
  }

  // Companion failure while a request is pending: the request must never be answered for the user.
  const failureDirectory = await mkdtemp(join(tmpdir(), 'h01-codex-approval-failure-'));
  const failureJournalPath = join(failureDirectory, 'journal.jsonl');
  const failed = fixtureAdapter(createCodexHarnessAdapter, 'approval', failureJournalPath);
  const failedStream = consume(failed);
  try {
    await failed.start();
    await failed.send('Run the fixture command that requires approval.', 'delivery-failure');
    const pending = await failedStream.waitFor(
      (event) => event.kind === 'approval_requested',
      'approval_requested event before the companion failure',
    );
    await failed.close();
    await waitForJournal(failureJournalPath, (entry) => entry.dir === 'lifecycle' && entry.event === 'shutdown', 'fixture shutdown after the companion failure');

    const journal = await readJournal(failureJournalPath);
    assert.equal(
      journal.some((entry) => isResponseTo(entry, pending.sourceEventId)),
      false,
      'a companion failure must never auto-approve (or auto-deny) a pending request',
    );
    assert.equal(
      journal
        .filter((entry) => entry.dir === 'out')
        .some((entry) => entry.message?.method === 'item/completed'),
      false,
      'the guarded tool must not run after a companion failure',
    );
  } finally {
    await closeQuietly(failed);
    await rm(failureDirectory, { recursive: true, force: true });
  }
});

test('an incompatible app-server version stays observe-only: mutation calls reject and diagnostics survive', async () => {
  const createCodexHarnessAdapter = await loadAdapter();
  const directory = await mkdtemp(join(tmpdir(), 'h01-codex-version-'));
  const journalPath = join(directory, 'journal.jsonl');
  const adapter = fixtureAdapter(createCodexHarnessAdapter, 'version-mismatch', journalPath, '99.0.0');
  const stream = consume(adapter);
  try {
    await adapter.start();
    const info = await adapter.info();
    assert.equal(info.adapter, 'codex-app-server');
    assert.equal(info.supportedVersion, PINNED_VERSION, 'the adapter reports the generated-schema version it ships');
    assert.equal(info.serverVersion, '99.0.0');
    assert.equal(info.compatible, false, 'a server from another schema version is not compatible');
    assert.deepEqual([...info.capabilities], ['observe']);
    assert.deepEqual(
      [...(await adapter.capabilities())],
      ['observe'],
      'capabilities() must be observe-only for an incompatible server',
    );

    const telemetry = await stream.waitFor(
      (event) => event.kind === 'unsupported' && event.unsupportedKind === 'future/telemetry',
      'diagnostic event for an unknown app-server method',
    );
    assertContractEnvelope(telemetry, 'future/telemetry');
    await stream.waitFor(
      (event) => event.kind === 'unsupported' && event.unsupportedKind === 'future/checkpoint',
      'second diagnostic event for an unknown app-server method',
    );

    const observedBeforeRejections = stream.events.length;
    await assert.rejects(adapter.send('attempt a managed mutation', 'delivery-mutation'), 'send() must reject for an incompatible server');
    await assert.rejects(adapter.interrupt('turn-1'), 'interrupt() must reject for an incompatible server');
    await assert.rejects(adapter.respondApproval('7', 'approve'), 'respondApproval() must reject for an incompatible server');
    await assert.rejects(adapter.resume('thread-1'), 'resume() must reject for an incompatible server');

    await stream.waitFor(
      (event, index) => index >= observedBeforeRejections && event.kind === 'unsupported' && event.unsupportedKind === 'future/heartbeat',
      'diagnostic observation continuing after rejected mutations',
    );

    await adapter.close();
    await waitForJournal(journalPath, (entry) => entry.dir === 'lifecycle' && entry.event === 'shutdown', 'fixture shutdown after close()');

    const journal = await readJournal(journalPath);
    const sentMethods = inboundMethods(journal);
    for (const forbidden of ['turn/start', 'turn/interrupt', 'thread/resume']) {
      assert.equal(sentMethods.includes(forbidden), false, `observe-only mode must not send ${forbidden} to an incompatible server`);
    }
    assert.equal(
      journal.some((entry) => entry.dir === 'in' && entry.message !== undefined && !('method' in entry.message)),
      false,
      'observe-only mode must not answer server requests it cannot understand',
    );
  } finally {
    await closeQuietly(adapter);
    await rm(directory, { recursive: true, force: true });
  }
});
