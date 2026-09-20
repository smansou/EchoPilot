/**
 * H04 acceptance oracle — several live adapters → selected-session routing → reconnect and
 * delivery reconciliation (IMPLEMENTATION_PLAN.md §5.3/§5.6/§5.12; ticket H04).
 *
 * Path under test: two managed Codex sessions and one managed Claude session are driven at the
 * shared packages/contracts HarnessAdapter seam; a shared session registry keeps their project,
 * turn, and destination identities; one shared conformance runner applies the same lifecycle and
 * capability checks to every adapter; and a Codex recovery session reconnects after a send/ack
 * connection loss, never repeats the send, keeps the unknown outcome visible, and reconciles it
 * from observed session state.
 *
 * Deterministic environment (no real account, network, or desktop session):
 *   - fixtures/harness/recovery/fake-recovery-app-server.mjs — real stdio children speaking the
 *     pinned `codex-cli 0.154.0` app-server protocol with a configurable thread identity, a
 *     session-state file, and a `drop-ack` scenario that accepts `turn/start` and dies before the
 *     acknowledgment comes back.
 *   - fixtures/harness/codex/fake-app-server.mjs (H01) — the pinned `approval` and
 *     `version-mismatch` scenarios: two live Codex conformance children and the observe-only
 *     conformance child.
 *   - a scripted Claude stream-json transport (below) standing in for the process boundary of the
 *     documented programmatic Claude Code interface, exactly as the H02 oracle does.
 * A real Codex account/CLI and a real Claude process still need manual qualification; this oracle
 * reports that as a remaining limitation instead of claiming coverage it cannot provide.
 *
 * Frozen seam this oracle pins (implementation lives in the ticket's owned paths):
 *
 * packages/core/src/session-registry/index.ts
 *   createSessionRegistry() → SessionRegistry
 *     adopt({ sessionId, harness: 'codex'|'claude'|'generic', projectId, label, cwd, adapter })
 *       — registers one live managed adapter; adoption order is the list() order; a duplicate
 *         sessionId is a TypeError; the adapter is stored behind the conformance gate below, so
 *         adapterFor() never exposes an operation the adapter does not advertise.
 *     list() → ManagedSessionRecord[]
 *       ManagedSessionRecord = { sessionId, harness, projectId, label, cwd, active, turnId? }
 *     get(sessionId) → ManagedSessionRecord | undefined
 *     adapterFor(sessionId) → HarnessAdapter | undefined
 *     rename(sessionId, label) → ManagedSessionRecord
 *       — changes only the label; sessionId, projectId, cwd, and the recorded turn survive.
 *     end(sessionId) → ManagedSessionRecord
 *       — marks active: false, keeps the record in list(), and removes it from destinations.
 *     recordTurn(sessionId, turnId) → ManagedSessionRecord
 *       — records that session's own last observed turn identity; an empty turnId is a TypeError.
 *     destinationFor(phrase) → { kind: 'resolved', sessionId, harness, projectId, label }
 *                            | { kind: 'ambiguous', sessionIds }
 *                            | { kind: 'unmatched' }
 *       — trimmed, case-insensitive match against an active session's label or sessionId;
 *         several matches are ambiguous (sessionIds sorted), no match is unmatched.
 *
 *   UnsupportedHarnessOperationError extends Error
 *     code: 'unsupported_operation'; operation: HarnessCapability; harness; sessionId
 *
 *   createConformantHarnessAdapter(adapter, { harness, sessionId }) → HarnessAdapter
 *     — capabilities(), observe(), start(), and close() pass through; send() on an adapter without
 *       the 'send' capability resolves { deliveryId, status: 'unsupported' } without touching the
 *       adapter; interrupt()/respondApproval()/resume() without the matching capability reject
 *       with UnsupportedHarnessOperationError and never reach the adapter.
 *
 *   HARNESS_CONFORMANCE_CHECKS = [
 *     'lifecycle:start', 'capabilities:declared', 'lifecycle:send', 'lifecycle:interrupt',
 *     'lifecycle:approval', 'lifecycle:resume', 'lifecycle:close',
 *   ]
 *
 *   runHarnessConformance(cases) → HarnessConformanceReport[]
 *     case = { harness, sessionId, adapter, lifecycle }
 *       lifecycle = {
 *         start(adapter), send(adapter, instruction, deliveryId) → HarnessDeliveryReceipt,
 *         interrupt?(adapter), approval?(adapter), resume?(adapter), close(adapter),
 *       }
 *     For every case the runner evaluates the checks above, in that order, against the gated
 *     adapter and reports { id, status: 'pass'|'fail', outcome: 'executed' | 'unsupported_typed_error'
 *     | 'unsupported_receipt', detail? }:
 *       — start() and close() run the lifecycle hooks (every adapter must start and close);
 *       — capabilities are read after start() (the Codex handshake decides them);
 *       — a capability the adapter advertises runs the matching hook, and 'pass' requires the hook
 *         to resolve (a send hook must return the acknowledged receipt for its deliveryId);
 *       — a capability the adapter does not advertise is probed by the runner itself against the
 *         gated adapter: send resolves the unsupported receipt, interrupt/approval/resume reject
 *         with UnsupportedHarnessOperationError, and the underlying adapter is never called;
 *       — passed is true only when every check passes.
 *
 * packages/harness-codex/src/recovery/index.ts
 *   createRecoveringCodexSession({ sessionId, projectId, connect, now? }) → RecoveringCodexSession
 *     connect() → a fresh, unstarted HarnessAdapter for the same managed session (one call per
 *     connection); now() → clock used for updatedAt.
 *     sessionId / projectId — the identities this recovery session retains.
 *     start() — connects once and starts the adapter (idempotent).
 *     deliver(instruction, deliveryId) → DeliveryRecord
 *       DeliveryRecord = { deliveryId, sessionId, projectId, instruction, state, attempts,
 *                          observedTurnId?, updatedAt, detail? }
 *       state ∈ 'prepared' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'unknown'.
 *       — deliveryId is the idempotency key: after a first attempt, a later deliver() with the same
 *         deliveryId returns the retained record and never writes to the wire again;
 *       — an attempt whose acknowledgment is lost (the adapter rejects after the request was
 *         written) resolves with state 'unknown' and attempts incremented — never a silent retry;
 *       — an acknowledged receipt resolves 'acknowledged'; an 'unsupported' receipt is 'failed'.
 *     outbox() → DeliveryRecord[] in delivery order; unknown() → the records currently 'unknown'.
 *     reconnect() — closes the current adapter and starts a fresh one from connect(); deliveries
 *       and their states survive.
 *     reconcile(observeSessionState) → DeliveryRecord[] — the unknown records it inspected
 *       observed state = { sessionId, projectId, cwd?, turns: [{ turnId, instruction, status }] };
 *       — a record reconciles only from observed state with the same sessionId and projectId and a
 *         turn whose instruction matches: state 'completed' when that turn completed, otherwise
 *         'acknowledged', with observedTurnId set; anything else stays 'unknown';
 *       — reconciliation never sends.
 *     close() — releases the current adapter.
 */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import type {
  EventEnvelope,
  HarnessAdapter,
  HarnessCapability,
  HarnessDeliveryReceipt,
  Scope,
} from '../../../contracts/src/index.js';
import {
  createClaudeManagedSession,
  type ClaudeManagedSession,
  type ClaudeStreamTransport,
} from '../../../harness-claude/src/index.js';
import {createCodexHarnessAdapter} from '../../../harness-codex/src/index.js';

const SESSION_REGISTRY_MODULE = './index.js';
const CODEX_RECOVERY_MODULE = '../../../harness-codex/src/recovery/index.js';
const RECOVERY_APP_SERVER = fileURLToPath(
  new URL('../../../../fixtures/harness/recovery/fake-recovery-app-server.mjs', import.meta.url),
);
const H01_APP_SERVER = fileURLToPath(
  new URL('../../../../fixtures/harness/codex/fake-app-server.mjs', import.meta.url),
);
/** Version of `codex app-server` whose generated schemas the managed adapter pins. */
const PINNED_CODEX_VERSION = '0.154.0';
/**
 * The wire `request_id` the scripted Claude stream uses for its approval probe. The decision must
 * travel back under exactly this id even though the normalized event's `sourceEventId` is the
 * adapter's own source identity.
 */
const APPROVAL_REQUEST_ID = 'h04-conformance-approval-1';
const FROZEN_CONFORMANCE_CHECKS = [
  'lifecycle:start',
  'capabilities:declared',
  'lifecycle:send',
  'lifecycle:interrupt',
  'lifecycle:approval',
  'lifecycle:resume',
  'lifecycle:close',
] as const;

type HarnessKind = 'codex' | 'claude' | 'generic';

type SessionRegistration = Readonly<{
  sessionId: string;
  harness: HarnessKind;
  projectId: string;
  label: string;
  cwd: string;
  adapter: HarnessAdapter;
}>;

type ManagedSessionRecord = Readonly<{
  sessionId: string;
  harness: HarnessKind;
  projectId: string;
  label: string;
  cwd: string;
  active: boolean;
  turnId?: string;
}>;

type DestinationResolution =
  | Readonly<{kind: 'resolved'; sessionId: string; harness: HarnessKind; projectId: string; label: string}>
  | Readonly<{kind: 'ambiguous'; sessionIds: ReadonlyArray<string>}>
  | Readonly<{kind: 'unmatched'}>;

type SessionRegistry = Readonly<{
  adopt(registration: SessionRegistration): ManagedSessionRecord;
  list(): ReadonlyArray<ManagedSessionRecord>;
  get(sessionId: string): ManagedSessionRecord | undefined;
  adapterFor(sessionId: string): HarnessAdapter | undefined;
  rename(sessionId: string, label: string): ManagedSessionRecord;
  end(sessionId: string): ManagedSessionRecord;
  recordTurn(sessionId: string, turnId: string): ManagedSessionRecord;
  destinationFor(phrase: string): DestinationResolution;
}>;

type SessionRegistryFactory = () => SessionRegistry;
type ConformanceCheckId = (typeof FROZEN_CONFORMANCE_CHECKS)[number];
type ConformanceOutcome = 'executed' | 'unsupported_typed_error' | 'unsupported_receipt';

type ConformanceCheck = Readonly<{
  id: ConformanceCheckId;
  status: 'pass' | 'fail';
  outcome: ConformanceOutcome;
  detail?: string;
}>;

type ConformanceReport = Readonly<{
  harness: HarnessKind;
  sessionId: string;
  capabilities: ReadonlyArray<HarnessCapability>;
  checks: ReadonlyArray<ConformanceCheck>;
  passed: boolean;
}>;

type ConformanceLifecycle = Readonly<{
  start(adapter: HarnessAdapter): Promise<void>;
  send(adapter: HarnessAdapter, instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
  interrupt?(adapter: HarnessAdapter): Promise<void>;
  approval?(adapter: HarnessAdapter): Promise<void>;
  resume?(adapter: HarnessAdapter): Promise<void>;
  close(adapter: HarnessAdapter): Promise<void>;
}>;

type ConformanceCase = Readonly<{
  harness: HarnessKind;
  sessionId: string;
  adapter: HarnessAdapter;
  lifecycle: ConformanceLifecycle;
}>;

type RunHarnessConformance = (
  cases: ReadonlyArray<ConformanceCase>,
) => Promise<ReadonlyArray<ConformanceReport>>;

type ConformantAdapterFactory = (
  adapter: HarnessAdapter,
  identity: Readonly<{harness: HarnessKind; sessionId: string}>,
) => HarnessAdapter;

type DeliveryState = 'prepared' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'unknown';

type DeliveryRecord = Readonly<{
  deliveryId: string;
  sessionId: string;
  projectId: string;
  instruction: string;
  state: DeliveryState;
  attempts: number;
  observedTurnId?: string;
  updatedAt: string;
  detail?: string;
}>;

type ObservedTurn = Readonly<{
  turnId: string;
  instruction: string;
  status: 'in_progress' | 'completed' | 'interrupted' | 'failed';
}>;

type ObservedSessionState = Readonly<{
  sessionId: string;
  projectId: string;
  cwd?: string;
  turns: ReadonlyArray<ObservedTurn>;
}>;

type RecoveringCodexSession = Readonly<{
  sessionId: string;
  projectId: string;
  start(): Promise<void>;
  deliver(instruction: string, deliveryId: string): Promise<DeliveryRecord>;
  outbox(): ReadonlyArray<DeliveryRecord>;
  unknown(): ReadonlyArray<DeliveryRecord>;
  reconnect(): Promise<void>;
  reconcile(observeSessionState: () => Promise<ObservedSessionState>): Promise<ReadonlyArray<DeliveryRecord>>;
  close(): Promise<void>;
}>;

type RecoveringCodexSessionFactory = (options: Readonly<{
  sessionId: string;
  projectId: string;
  connect: () => Promise<HarnessAdapter>;
  now?: () => Date;
}>) => RecoveringCodexSession;

type JournalEntry = {
  dir: 'in' | 'out' | 'lifecycle';
  message?: Record<string, unknown>;
  event?: string;
  reason?: string;
  [key: string]: unknown;
};

type EventStream = Readonly<{
  observed(): ReadonlyArray<EventEnvelope>;
  waitFor(
    predicate: (event: EventEnvelope) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<EventEnvelope>;
}>;

/** Loads a yet-to-be-implemented module, turning "module missing" into a named behavior failure. */
async function importModule(specifier: string, missingBehavior: string): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    const code = (error as {code?: string}).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(missingBehavior);
    }
    throw error;
  }
}

async function loadSessionRegistry(): Promise<Record<string, unknown>> {
  const loaded = await importModule(
    SESSION_REGISTRY_MODULE,
    'Missing required behavior: packages/core/src/session-registry/index.ts must export '
    + 'createSessionRegistry(), runHarnessConformance(), createConformantHarnessAdapter(), '
    + 'UnsupportedHarnessOperationError, and HARNESS_CONFORMANCE_CHECKS so several live adapters keep '
    + 'distinct session identities and destinations, pass one shared lifecycle/capability suite, and '
    + 'turn unsupported operations into typed errors (ticket H04).',
  );
  assert.equal(typeof loaded.createSessionRegistry, 'function', 'packages/core/src/session-registry must export createSessionRegistry()');
  assert.equal(typeof loaded.runHarnessConformance, 'function', 'packages/core/src/session-registry must export runHarnessConformance()');
  assert.equal(typeof loaded.createConformantHarnessAdapter, 'function', 'packages/core/src/session-registry must export createConformantHarnessAdapter()');
  assert.equal(typeof loaded.UnsupportedHarnessOperationError, 'function', 'packages/core/src/session-registry must export UnsupportedHarnessOperationError');
  assert.ok(Array.isArray(loaded.HARNESS_CONFORMANCE_CHECKS), 'packages/core/src/session-registry must export HARNESS_CONFORMANCE_CHECKS');
  return loaded;
}

async function loadCodexRecovery(): Promise<Record<string, unknown>> {
  const loaded = await importModule(
    CODEX_RECOVERY_MODULE,
    'Missing required behavior: packages/harness-codex/src/recovery/index.ts must export '
    + 'createRecoveringCodexSession() so a reconnected managed Codex session never repeats a send, '
    + 'keeps a lost acknowledgment visible as unknown, and reconciles it from observed session state '
    + 'without a silent resend (ticket H04).',
  );
  assert.equal(
    typeof loaded.createRecoveringCodexSession,
    'function',
    'packages/harness-codex/src/recovery must export createRecoveringCodexSession()',
  );
  return loaded;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function waitFor<T>(
  description: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) assert.fail(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    await delay(10);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopeFor(projectId: string, sessionId: string): Scope {
  return {profileId: 'h04-profile', projectId, sessionId, worktreeId: `${projectId}-worktree`, sensitivity: 'normal'};
}

function observeEvents(adapter: HarnessAdapter): EventStream {
  const events: EventEnvelope[] = [];
  void (async () => {
    try {
      for await (const event of adapter.observe()) events.push(event);
    } catch {
      // Observation ends with the adapter; the recorded events remain available as evidence.
    }
  })();
  return {
    observed: () => [...events],
    waitFor: (predicate, description, timeoutMs) => waitFor(
      description,
      () => events.find(predicate),
      timeoutMs,
    ),
  };
}

async function readJournal(path: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as {code?: string}).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

function inboundCalls(entries: ReadonlyArray<JournalEntry>, method: string): JournalEntry[] {
  return entries.filter((entry) => entry.dir === 'in' && isRecord(entry.message) && entry.message.method === method);
}

function instructionOfTurnStart(entry: JournalEntry): string {
  const message = entry.message;
  const params = isRecord(message) && isRecord(message.params) ? message.params : {};
  const input = Array.isArray(params.input) ? params.input : [];
  const first = input.find(isRecord);
  return isRecord(first) && typeof first.text === 'string' ? first.text : '';
}

async function waitForJournal(
  path: string,
  predicate: (entry: JournalEntry) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<JournalEntry> {
  return waitFor(description, async () => (await readJournal(path)).find(predicate), timeoutMs);
}

async function readObservedSessionState(path: string): Promise<ObservedSessionState> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ObservedSessionState>;
  assert.ok(typeof parsed.sessionId === 'string', 'observed session state must name its session');
  assert.ok(typeof parsed.projectId === 'string', 'observed session state must name its project');
  assert.ok(Array.isArray(parsed.turns), 'observed session state must list its turns');
  return {
    sessionId: parsed.sessionId,
    projectId: parsed.projectId,
    ...(parsed.cwd === undefined ? {} : {cwd: parsed.cwd}),
    turns: parsed.turns.map((turn) => ({
      turnId: String(turn.turnId),
      instruction: String(turn.instruction),
      status: turn.status,
    })),
  };
}

type ScriptedClaudeTransport = Readonly<{
  transport: ClaudeStreamTransport;
  written: ReadonlyArray<Record<string, unknown>>;
  push(line: string): void;
  waitForWritten(predicate: (frame: Record<string, unknown>) => boolean, description: string): Promise<Record<string, unknown>>;
}>;

/** Scripted stream-json peer for the managed Claude session (the H02 injectable transport seam). */
function createScriptedClaudeTransport(sessionId: string): ScriptedClaudeTransport {
  const written: Record<string, unknown>[] = [];
  const outbound: string[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const push = (line: string): void => {
    outbound.push(line);
    wake();
  };
  const respondTo = (frame: Record<string, unknown>): void => {
    if (frame.type !== 'user') return;
    push(JSON.stringify({type: 'system', subtype: 'init', session_id: sessionId, transcript_path: `/tmp/${sessionId}/transcript.jsonl`, uuid: 'system-1'}));
    push(JSON.stringify({type: 'assistant', session_id: sessionId, message: {role: 'assistant', content: [{type: 'text', text: 'H04 fixture result'}]}, uuid: 'assistant-1'}));
    push(JSON.stringify({type: 'result', subtype: 'success', session_id: sessionId, is_error: false, uuid: 'result-1'}));
  };
  const transport: ClaudeStreamTransport = {
    async start(): Promise<void> {},
    async writeLine(line: string): Promise<void> {
      const frame = JSON.parse(line) as Record<string, unknown>;
      written.push(frame);
      respondTo(frame);
    },
    async close(): Promise<void> {
      ended = true;
      wake();
    },
    lines: async function* lines(): AsyncGenerator<string> {
      for (;;) {
        const next = outbound.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
  };
  return {
    transport,
    written,
    push,
    waitForWritten: (predicate, description) => waitFor(description, () => written.find(predicate)),
  };
}

async function closeQuietly(adapter: HarnessAdapter | undefined): Promise<void> {
  try {
    await adapter?.close();
  } catch {
    // Releasing an already-dead child is not an oracle failure.
  }
}

type CodexFixtureOptions = Readonly<{
  cwd: string;
  threadId: string;
  sessionId: string;
  projectId: string;
  journal: string;
  scenario?: 'session' | 'approval' | 'drop-ack';
  sessionState?: string;
}>;

function recoveryFixtureAdapter(options: CodexFixtureOptions): HarnessAdapter {
  return createCodexHarnessAdapter({
    command: process.execPath,
    args: [RECOVERY_APP_SERVER],
    cwd: options.cwd,
    env: {
      H04_SCENARIO: options.scenario ?? 'session',
      H04_THREAD_ID: options.threadId,
      H04_SESSION_ID: options.sessionId,
      H04_PROJECT_ID: options.projectId,
      H04_JOURNAL: options.journal,
      ...(options.sessionState === undefined ? {} : {H04_SESSION_STATE: options.sessionState}),
    },
    scope: scopeFor(options.projectId, options.sessionId),
  });
}

function h01FixtureAdapter(options: Readonly<{
  cwd: string;
  journal: string;
  scenario: 'approval' | 'version-mismatch';
  serverVersion?: string;
}>): HarnessAdapter {
  return createCodexHarnessAdapter({
    command: process.execPath,
    args: [H01_APP_SERVER],
    cwd: options.cwd,
    env: {
      H01_SCENARIO: options.scenario,
      H01_JOURNAL: options.journal,
      H01_SERVER_VERSION: options.serverVersion ?? PINNED_CODEX_VERSION,
    },
    scope: scopeFor('h04-conformance', `conformance-${options.scenario}`),
  });
}

/** The uniform lifecycle choreography for a capable Codex app-server child (approval scenario). */
function codexLifecycle(events: EventStream, journalPath: string): ConformanceLifecycle {
  let approvalRequestId: string | undefined;
  let turnId: string | undefined;
  return {
    async start(adapter): Promise<void> {
      await adapter.start();
    },
    async send(adapter, instruction, deliveryId): Promise<HarnessDeliveryReceipt> {
      const receipt = await adapter.send(instruction, deliveryId);
      const approval = await events.waitFor((event) => event.kind === 'approval_requested', 'the observed approval request');
      approvalRequestId = approval.sourceEventId;
      const started = await events.waitFor(
        (event) => event.kind === 'session_state' && typeof event.turnId === 'string' && event.turnId.length > 0,
        'the observed started turn',
      );
      turnId = started.turnId;
      return receipt;
    },
    async approval(adapter): Promise<void> {
      assert.ok(approvalRequestId !== undefined, 'send() must observe the approval request before it can be answered');
      await adapter.respondApproval(approvalRequestId, 'approve');
      await waitForJournal(
        journalPath,
        (entry) => entry.dir === 'in'
          && isRecord(entry.message)
          && isRecord(entry.message.result)
          && entry.message.result.decision === 'accept',
        'the approval decision on the wire',
      );
      await events.waitFor((event) => event.kind === 'tool_completed', 'the approved tool completion');
    },
    async interrupt(adapter): Promise<void> {
      assert.ok(turnId !== undefined, 'send() must observe a turn identity before interrupt() can be exercised');
      await adapter.interrupt(turnId);
      await waitForJournal(
        journalPath,
        (entry) => entry.dir === 'in' && isRecord(entry.message) && entry.message.method === 'turn/interrupt',
        'turn/interrupt on the wire',
      );
    },
    async resume(adapter): Promise<void> {
      // The pinned fixture thread the managed adapter created for this case.
      await adapter.resume('thread-1');
    },
    async close(adapter): Promise<void> {
      await adapter.close();
    },
  };
}

/** The uniform lifecycle choreography for the managed Claude session over the scripted transport. */
function claudeLifecycle(
  events: EventStream,
  transport: ScriptedClaudeTransport,
): ConformanceLifecycle {
  let turnId: string | undefined;
  return {
    async start(adapter): Promise<void> {
      await adapter.start();
    },
    async send(adapter, instruction, deliveryId): Promise<HarnessDeliveryReceipt> {
      const receipt = await adapter.send(instruction, deliveryId);
      const observed = await events.waitFor(
        (event) => event.kind === 'agent_message' && typeof event.turnId === 'string' && event.turnId.length > 0,
        'the normalized Claude turn result',
      );
      turnId = observed.turnId;
      return receipt;
    },
    async interrupt(adapter): Promise<void> {
      assert.ok(turnId !== undefined, 'send() must observe a turn identity before interrupt() can be exercised');
      await adapter.interrupt(turnId);
      await transport.waitForWritten(
        (frame) => frame.type === 'control_request' && isRecord(frame.request) && frame.request.subtype === 'interrupt',
        'the interrupt control request frame',
      );
    },
    async approval(adapter): Promise<void> {
      transport.push(JSON.stringify({
        type: 'control_request',
        request_id: APPROVAL_REQUEST_ID,
        request: {subtype: 'can_use_tool', tool_name: 'Bash'},
        message: {role: 'assistant', content: [{type: 'text', text: 'guarded tool'}]},
      }));
      const request = await events.waitFor((event) => event.kind === 'approval_requested', 'the normalized approval request');
      // `sourceEventId` is the adapter's own identity for the source event, not a promise that it
      // equals the raw stream request id (the pinned H02 adapter composes label:uuid:sequence).
      // What must hold is that the observed request traces back to the wire request id and that the
      // explicit decision travels back carrying that exact id.
      assert.ok(
        request.sourceEventId.includes(APPROVAL_REQUEST_ID),
        `the observed approval request must identify the wire request id, observed ${request.sourceEventId}`,
      );
      await adapter.respondApproval(APPROVAL_REQUEST_ID, 'approve');
      const response = await transport.waitForWritten(
        (frame) => frame.type === 'control_response',
        'the approval response frame',
      );
      assert.deepEqual(
        response.response,
        {
          subtype: 'success',
          request_id: APPROVAL_REQUEST_ID,
          response: {behavior: 'allow'},
        },
        'the approval decision must answer the exact observed request id',
      );
    },
    async resume(adapter): Promise<void> {
      await adapter.resume('h04-claude-live');
    },
    async close(adapter): Promise<void> {
      await adapter.close();
    },
  };
}

function createObserveOnlySpy(): Readonly<{adapter: HarnessAdapter; calls: string[]}> {
  const calls: string[] = [];
  const refuse = (operation: string): never => {
    calls.push(operation);
    throw new Error(`the conformance gate must not reach the adapter for ${operation}`);
  };
  const adapter: HarnessAdapter = {
    async capabilities(): Promise<ReadonlySet<HarnessCapability>> {
      return new Set<HarnessCapability>(['observe']);
    },
    async start(): Promise<void> {
      refuse('start');
    },
    observe(): AsyncIterable<EventEnvelope> {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<EventEnvelope> {
          // An observation-only adapter with nothing to report.
        },
      };
    },
    async send(): Promise<HarnessDeliveryReceipt> {
      return refuse('send');
    },
    async interrupt(): Promise<void> {
      refuse('interrupt');
    },
    async respondApproval(): Promise<void> {
      refuse('respondApproval');
    },
    async resume(): Promise<void> {
      refuse('resume');
    },
    async close(): Promise<void> {
      refuse('close');
    },
  };
  return {adapter, calls};
}

test('H04-1: two Codex sessions and one Claude session keep distinct project, turn, and destination identities', async () => {
  const registryModule = await loadSessionRegistry();
  const createSessionRegistry = registryModule.createSessionRegistry as SessionRegistryFactory;
  const registry = createSessionRegistry();

  const root = await mkdtemp(join(tmpdir(), 'h04-identities-'));
  const cwdParser = join(root, 'worktree-parser');
  const cwdTests = join(root, 'worktree-tests');
  const cwdReviewer = join(root, 'worktree-review');
  await Promise.all([
    mkdir(cwdParser, {recursive: true}),
    mkdir(cwdTests, {recursive: true}),
    mkdir(cwdReviewer, {recursive: true}),
  ]);
  const journalParser = join(root, 'codex-parser.jsonl');
  const journalTests = join(root, 'codex-tests.jsonl');

  const codexParser = recoveryFixtureAdapter({
    cwd: cwdParser, threadId: 'h04-codex-parser-thread', sessionId: 'codex-parser',
    projectId: 'project-parser', journal: journalParser,
  });
  const codexTests = recoveryFixtureAdapter({
    cwd: cwdTests, threadId: 'h04-codex-tests-thread', sessionId: 'codex-tests',
    projectId: 'project-tests', journal: journalTests,
  });
  const claudeTransport = createScriptedClaudeTransport('h04-claude-reviewer-thread');
  const claude = createClaudeManagedSession({
    scope: scopeFor('project-review', 'claude-reviewer'),
    sessionRoot: cwdReviewer,
    transport: claudeTransport.transport,
  });

  try {
    registry.adopt({sessionId: 'codex-parser', harness: 'codex', projectId: 'project-parser', label: 'Codex parser', cwd: cwdParser, adapter: codexParser});
    registry.adopt({sessionId: 'codex-tests', harness: 'codex', projectId: 'project-tests', label: 'Codex tests', cwd: cwdTests, adapter: codexTests});
    registry.adopt({sessionId: 'claude-reviewer', harness: 'claude', projectId: 'project-review', label: 'Claude reviewer', cwd: cwdReviewer, adapter: claude});

    const parserAdapter = registry.adapterFor('codex-parser');
    const testsAdapter = registry.adapterFor('codex-tests');
    const reviewerAdapter = registry.adapterFor('claude-reviewer');
    assert.ok(parserAdapter, 'adapterFor() must expose the adopted Codex parser session');
    assert.ok(testsAdapter, 'adapterFor() must expose the adopted Codex tests session');
    assert.ok(reviewerAdapter, 'adapterFor() must expose the adopted Claude reviewer session');

    const parserEvents = observeEvents(parserAdapter);
    const testsEvents = observeEvents(testsAdapter);
    const reviewerEvents = observeEvents(reviewerAdapter);
    await parserAdapter.start();
    await testsAdapter.start();
    await reviewerAdapter.start();

    const parserReceipt = await parserAdapter.send('add a parser regression test', 'delivery-parser-1');
    const testsReceipt = await testsAdapter.send('add a tests fixture', 'delivery-tests-1');
    const reviewerReceipt = await reviewerAdapter.send('review the parser diff', 'delivery-reviewer-1');
    assert.equal(parserReceipt.status, 'acknowledged');
    assert.equal(testsReceipt.status, 'acknowledged');
    assert.equal(reviewerReceipt.status, 'acknowledged');

    const parserTurn = (await parserEvents.waitFor(
      (event) => typeof event.turnId === 'string' && event.turnId.length > 0,
      'the observed parser turn identity',
    )).turnId;
    const testsTurn = (await testsEvents.waitFor(
      (event) => typeof event.turnId === 'string' && event.turnId.length > 0,
      'the observed tests turn identity',
    )).turnId;
    const reviewerTurn = (await reviewerEvents.waitFor(
      (event) => typeof event.turnId === 'string' && event.turnId.length > 0,
      'the observed Claude turn identity',
    )).turnId;
    assert.ok(typeof parserTurn === 'string', 'the parser session must report a turn identity');
    assert.ok(typeof testsTurn === 'string', 'the tests session must report a turn identity');
    assert.ok(typeof reviewerTurn === 'string', 'the Claude session must report a turn identity');
    assert.equal(parserTurn, 'h04-codex-parser-thread-turn-1', 'the parser turn must come from the parser child');
    assert.equal(testsTurn, 'h04-codex-tests-thread-turn-1', 'the tests turn must come from the tests child');
    assert.equal(reviewerTurn, 'turn-delivery-reviewer-1', 'the Claude turn identity must come from the Claude session');

    registry.recordTurn('codex-parser', parserTurn);
    registry.recordTurn('codex-tests', testsTurn);
    registry.recordTurn('claude-reviewer', reviewerTurn);

    const records = registry.list();
    assert.deepEqual(
      records.map((record) => record.sessionId),
      ['codex-parser', 'codex-tests', 'claude-reviewer'],
      'the registry must retain every adopted live session in adoption order',
    );
    const byId = new Map(records.map((record) => [record.sessionId, record] as const));
    const parserRecord = byId.get('codex-parser');
    const testsRecord = byId.get('codex-tests');
    const reviewerRecord = byId.get('claude-reviewer');
    assert.ok(parserRecord !== undefined && testsRecord !== undefined && reviewerRecord !== undefined);
    assert.equal(parserRecord.harness, 'codex');
    assert.equal(parserRecord.projectId, 'project-parser');
    assert.equal(parserRecord.cwd, cwdParser);
    assert.equal(parserRecord.active, true);
    assert.equal(parserRecord.turnId, parserTurn);
    assert.equal(testsRecord.harness, 'codex');
    assert.equal(testsRecord.projectId, 'project-tests');
    assert.equal(testsRecord.cwd, cwdTests);
    assert.equal(testsRecord.turnId, testsTurn);
    assert.equal(reviewerRecord.harness, 'claude');
    assert.equal(reviewerRecord.projectId, 'project-review');
    assert.equal(reviewerRecord.cwd, cwdReviewer);
    assert.equal(reviewerRecord.turnId, reviewerTurn);
    assert.equal(new Set(records.map((record) => record.turnId)).size, 3, 'each live session must keep its own turn identity');
    assert.equal(new Set(records.map((record) => record.projectId)).size, 3, 'each live session must keep its own project identity');

    // Destinations: the spoken label resolves to the right session, project, and adapter.
    const parserDestination = registry.destinationFor('Codex parser');
    assert.equal(parserDestination.kind, 'resolved');
    if (parserDestination.kind === 'resolved') {
      assert.equal(parserDestination.sessionId, 'codex-parser');
      assert.equal(parserDestination.harness, 'codex');
      assert.equal(parserDestination.projectId, 'project-parser');
    }
    const testsDestination = registry.destinationFor('  codex TESTS ');
    assert.equal(testsDestination.kind, 'resolved');
    if (testsDestination.kind === 'resolved') assert.equal(testsDestination.sessionId, 'codex-tests');
    const reviewerDestination = registry.destinationFor('Claude reviewer');
    assert.equal(reviewerDestination.kind, 'resolved');
    if (reviewerDestination.kind === 'resolved') assert.equal(reviewerDestination.sessionId, 'claude-reviewer');
    assert.equal(registry.destinationFor('the other session').kind, 'unmatched');

    // Wire evidence: each destination reached exactly its own child and nobody else's.
    const parserInstructions = inboundCalls(await readJournal(journalParser), 'turn/start').map(instructionOfTurnStart);
    const testsInstructions = inboundCalls(await readJournal(journalTests), 'turn/start').map(instructionOfTurnStart);
    assert.deepEqual(parserInstructions, ['add a parser regression test']);
    assert.deepEqual(testsInstructions, ['add a tests fixture']);
    assert.deepEqual(
      claudeTransport.written.filter((frame) => frame.type === 'user').length,
      1,
      'the Claude session must receive exactly its own instruction',
    );

    // Rename keeps identity and moves only the destination label.
    const renamed = registry.rename('codex-parser', 'parser worktree');
    assert.equal(renamed.label, 'parser worktree');
    assert.equal(renamed.sessionId, 'codex-parser');
    assert.equal(renamed.projectId, 'project-parser');
    assert.equal(renamed.cwd, cwdParser);
    assert.equal(renamed.turnId, parserTurn);
    assert.equal(registry.destinationFor('Codex parser').kind, 'unmatched');
    const renamedDestination = registry.destinationFor('parser worktree');
    assert.equal(renamedDestination.kind, 'resolved');
    if (renamedDestination.kind === 'resolved') assert.equal(renamedDestination.sessionId, 'codex-parser');

    // Ending a session keeps its record but removes it from destinations.
    const ended = registry.end('codex-tests');
    assert.equal(ended.active, false);
    assert.equal(ended.sessionId, 'codex-tests');
    assert.equal(registry.get('codex-tests')?.active, false);
    assert.equal(registry.destinationFor('Codex tests').kind, 'unmatched');
    assert.equal(registry.destinationFor('parser worktree').kind, 'resolved');
    assert.equal(registry.destinationFor('Claude reviewer').kind, 'resolved');

    // An ambiguous label never silently picks one session.
    const scratch = createSessionRegistry();
    scratch.adopt({sessionId: 'dup-parser-a', harness: 'codex', projectId: 'project-parser', label: 'Codex parser', cwd: cwdParser, adapter: codexParser});
    scratch.adopt({sessionId: 'dup-parser-b', harness: 'claude', projectId: 'project-review', label: 'Codex parser', cwd: cwdReviewer, adapter: claude});
    const ambiguous = scratch.destinationFor('Codex parser');
    assert.equal(ambiguous.kind, 'ambiguous');
    if (ambiguous.kind === 'ambiguous') {
      assert.deepEqual([...ambiguous.sessionIds].sort(), ['dup-parser-a', 'dup-parser-b']);
    }
  } finally {
    await closeQuietly(codexParser);
    await closeQuietly(codexTests);
    await closeQuietly(claude);
    await rm(root, {recursive: true, force: true});
  }
});

test('H04-2: every adapter passes the same lifecycle and capability checks, and unsupported operations are typed errors', async () => {
  const registryModule = await loadSessionRegistry();
  const runHarnessConformance = registryModule.runHarnessConformance as RunHarnessConformance;
  const createConformantHarnessAdapter = registryModule.createConformantHarnessAdapter as ConformantAdapterFactory;
  const UnsupportedHarnessOperationError = registryModule.UnsupportedHarnessOperationError as new (...args: unknown[]) => Error;
  const frozenChecks = registryModule.HARNESS_CONFORMANCE_CHECKS as ReadonlyArray<string>;
  assert.deepEqual([...frozenChecks], [...FROZEN_CONFORMANCE_CHECKS], 'the shared conformance suite must stay frozen at the same checks');

  const root = await mkdtemp(join(tmpdir(), 'h04-conformance-'));
  const cwdOne = join(root, 'codex-one');
  const cwdTwo = join(root, 'codex-two');
  const cwdObserveOnly = join(root, 'codex-observe-only');
  await Promise.all([
    mkdir(cwdOne, {recursive: true}),
    mkdir(cwdTwo, {recursive: true}),
    mkdir(cwdObserveOnly, {recursive: true}),
  ]);
  const journalOne = join(root, 'codex-one.jsonl');
  const journalTwo = join(root, 'codex-two.jsonl');
  const journalObserveOnly = join(root, 'codex-observe-only.jsonl');

  const codexOne = h01FixtureAdapter({cwd: cwdOne, journal: journalOne, scenario: 'approval'});
  const codexTwo = h01FixtureAdapter({cwd: cwdTwo, journal: journalTwo, scenario: 'approval'});
  const codexObserveOnly = h01FixtureAdapter({
    cwd: cwdObserveOnly,
    journal: journalObserveOnly,
    scenario: 'version-mismatch',
    serverVersion: '99.0.0',
  });
  const claudeTransport = createScriptedClaudeTransport('h04-claude-live');
  const claudeSession: ClaudeManagedSession = createClaudeManagedSession({
    scope: scopeFor('h04-conformance', 'claude-live'),
    sessionRoot: join(root, 'claude-live'),
    transport: claudeTransport.transport,
  });

  try {
    const reports = await runHarnessConformance([
      {harness: 'codex', sessionId: 'codex-live-1', adapter: codexOne, lifecycle: codexLifecycle(observeEvents(codexOne), journalOne)},
      {harness: 'codex', sessionId: 'codex-live-2', adapter: codexTwo, lifecycle: codexLifecycle(observeEvents(codexTwo), journalTwo)},
      {harness: 'claude', sessionId: 'claude-live', adapter: claudeSession, lifecycle: claudeLifecycle(observeEvents(claudeSession), claudeTransport)},
      {
        harness: 'codex',
        sessionId: 'codex-observe-only',
        adapter: codexObserveOnly,
        lifecycle: {
          async start(adapter: HarnessAdapter): Promise<void> {
            await adapter.start();
          },
          async send(): Promise<HarnessDeliveryReceipt> {
            assert.fail('an observe-only adapter must never be asked to send through a lifecycle hook');
          },
          async close(adapter: HarnessAdapter): Promise<void> {
            await adapter.close();
          },
        },
      },
    ]);

    assert.equal(reports.length, 4, 'every registered adapter must be reported');
    for (const report of reports) {
      assert.deepEqual(
        report.checks.map((check) => check.id),
        [...FROZEN_CONFORMANCE_CHECKS],
        `${report.sessionId}: every adapter must run the same frozen checks in order`,
      );
      for (const check of report.checks) {
        assert.equal(check.status, 'pass', `${report.sessionId} ${check.id}: ${check.detail ?? 'no detail'}`);
      }
      assert.equal(report.passed, true, `${report.sessionId} must pass the shared conformance suite`);
    }
    const reportsById = new Map(reports.map((report) => [report.sessionId, report] as const));
    const checkOf = (sessionId: string, id: ConformanceCheckId): ConformanceCheck => {
      const report = reportsById.get(sessionId);
      assert.ok(report !== undefined, `missing conformance report for ${sessionId}`);
      const check = report.checks.find((candidate) => candidate.id === id);
      assert.ok(check !== undefined, `${sessionId} must report ${id}`);
      return check;
    };

    // Capable adapters execute the lifecycle; the observe-only adapter returns typed unsupported results.
    for (const sessionId of ['codex-live-1', 'codex-live-2', 'claude-live']) {
      for (const id of FROZEN_CONFORMANCE_CHECKS) {
        assert.equal(checkOf(sessionId, id).outcome, 'executed', `${sessionId} must execute ${id}`);
      }
    }
    const observeOnlyReport = reportsById.get('codex-observe-only');
    assert.ok(observeOnlyReport !== undefined);
    assert.deepEqual([...observeOnlyReport.capabilities].sort(), ['observe']);
    assert.equal(checkOf('codex-observe-only', 'lifecycle:send').outcome, 'unsupported_receipt');
    for (const id of ['lifecycle:interrupt', 'lifecycle:approval', 'lifecycle:resume'] as const) {
      assert.equal(
        checkOf('codex-observe-only', id).outcome,
        'unsupported_typed_error',
        `${id} must stay an unsupported operation on an observe-only adapter`,
      );
    }
    assert.deepEqual(
      [...(reportsById.get('codex-live-1')?.capabilities ?? [])].sort(),
      ['approval', 'interrupt', 'observe', 'resume', 'send'],
      'the live Codex adapter advertises the full lifecycle after its handshake',
    );

    // The gate itself refuses unsupported operations without touching the adapter.
    const spy = createObserveOnlySpy();
    const gate = createConformantHarnessAdapter(spy.adapter, {harness: 'claude', sessionId: 'spy-session'});
    assert.deepEqual([...(await gate.capabilities())].sort(), ['observe']);
    const unsupportedSend = await gate.send('conformance probe', 'delivery-spy');
    assert.equal(unsupportedSend.deliveryId, 'delivery-spy');
    assert.equal(unsupportedSend.status, 'unsupported');
    const unsupportedCalls: ReadonlyArray<readonly [HarnessCapability, () => Promise<unknown>]> = [
      ['interrupt', () => gate.interrupt('turn-spy')],
      ['approval', () => gate.respondApproval('request-spy', 'approve')],
      ['resume', () => gate.resume('spy-session')],
    ];
    for (const [operation, invoke] of unsupportedCalls) {
      await assert.rejects(invoke, (error: unknown) => {
        assert.ok(
          error instanceof UnsupportedHarnessOperationError,
          `${operation} must reject with UnsupportedHarnessOperationError, observed ${String(error)}`,
        );
        const typed = error as {code?: string; operation?: string; harness?: string; sessionId?: string; message?: string};
        assert.equal(typed.code, 'unsupported_operation');
        assert.equal(typed.operation, operation);
        assert.equal(typed.harness, 'claude');
        assert.equal(typed.sessionId, 'spy-session');
        assert.ok((typed.message ?? '').length > 0, 'the typed error must explain itself');
        return true;
      });
    }
    assert.equal(spy.calls.length, 0, 'the gate must not forward unsupported operations to the adapter');
  } finally {
    await closeQuietly(codexOne);
    await closeQuietly(codexTwo);
    await closeQuietly(codexObserveOnly);
    await closeQuietly(claudeSession);
    await rm(root, {recursive: true, force: true});
  }
});

test('H04-3: reconnect never repeats a send, and a lost acknowledgment stays visible until reconciled', async () => {
  const recoveryModule = await loadCodexRecovery();
  const createRecoveringCodexSession = recoveryModule.createRecoveringCodexSession as RecoveringCodexSessionFactory;

  const root = await mkdtemp(join(tmpdir(), 'h04-recovery-'));
  const cwd = join(root, 'worktree');
  await mkdir(cwd, {recursive: true});
  const firstJournal = join(root, 'codex-first.jsonl');
  const secondJournal = join(root, 'codex-second.jsonl');
  const observedStatePath = join(root, 'session-state.json');
  const sessionId = 'codex-recovery';
  const projectId = 'project-recovery';
  const instruction = 'add a regression test for duplicate delivery';
  const turnIdPrefix = 'h04-recovery-thread';
  let connections = 0;

  const recovery = createRecoveringCodexSession({
    sessionId,
    projectId,
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    connect: async (): Promise<HarnessAdapter> => {
      connections += 1;
      const first = connections === 1;
      return recoveryFixtureAdapter({
        cwd,
        threadId: turnIdPrefix,
        sessionId,
        projectId,
        journal: first ? firstJournal : secondJournal,
        scenario: first ? 'drop-ack' : 'session',
        ...(first ? {sessionState: observedStatePath} : {}),
      });
    },
  });

  try {
    assert.equal(recovery.sessionId, sessionId);
    assert.equal(recovery.projectId, projectId);
    await recovery.start();

    // 1. The instruction reaches the harness; the acknowledgment is lost.
    const first = await recovery.deliver(instruction, 'delivery-recovery-1');
    assert.equal(first.deliveryId, 'delivery-recovery-1');
    assert.equal(first.sessionId, sessionId);
    assert.equal(first.projectId, projectId);
    assert.equal(first.instruction, instruction);
    assert.equal(
      first.state,
      'unknown',
      `a delivery whose acknowledgment was lost must stay visible as unknown, observed ${JSON.stringify(first)}`,
    );
    assert.equal(first.attempts, 1);
    assert.equal(recovery.unknown().length, 1, 'unknown() must expose the unresolved delivery');
    assert.deepEqual(recovery.outbox().map((record) => record.deliveryId), ['delivery-recovery-1']);
    await waitForJournal(
      firstJournal,
      (entry) => entry.dir === 'in' && isRecord(entry.message) && entry.message.method === 'turn/start',
      'the first instruction on the wire',
    );
    assert.equal(inboundCalls(await readJournal(firstJournal), 'turn/start').length, 1);

    // 2. After reconnect the same delivery id is never written to the wire again.
    await recovery.reconnect();
    assert.equal(connections, 2, 'reconnect() must open a fresh connection');
    const retried = await recovery.deliver(instruction, 'delivery-recovery-1');
    assert.equal(retried.state, 'unknown');
    assert.equal(retried.attempts, 1, 'a retried delivery id must not be sent again');
    assert.equal(
      inboundCalls(await readJournal(secondJournal), 'turn/start').length,
      0,
      'no duplicate send may follow a reconnect',
    );
    assert.equal(recovery.unknown().length, 1, 'the unknown outcome must stay visible across the reconnect');

    // 3. Observed state that does not describe this session or delivery cannot reconcile it.
    const silentTurns = await recovery.reconcile(async () => ({sessionId, projectId, cwd, turns: []}));
    assert.equal(silentTurns.length, 1);
    assert.equal(silentTurns[0]?.state, 'unknown', 'an unobserved delivery must not be confirmed');
    const foreignState = await recovery.reconcile(async () => ({
      sessionId: 'some-other-session',
      projectId,
      cwd,
      turns: [{turnId: 'foreign-turn', instruction, status: 'completed'}],
    }));
    assert.equal(foreignState[0]?.state, 'unknown', 'observed state from another session must not reconcile this delivery');
    assert.equal(
      inboundCalls(await readJournal(secondJournal), 'turn/start').length,
      0,
      'reconciliation must never send',
    );

    // 4. The fixture recorded the executed turn; that observed state resolves the delivery.
    const observed = await readObservedSessionState(observedStatePath);
    assert.equal(observed.sessionId, sessionId);
    assert.equal(observed.projectId, projectId);
    const reconciled = await recovery.reconcile(async () => observed);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.deliveryId, 'delivery-recovery-1');
    assert.equal(reconciled[0]?.state, 'acknowledged', 'an observed executed turn resolves the unknown delivery');
    assert.equal(reconciled[0]?.observedTurnId, `${turnIdPrefix}-turn-1`);
    assert.equal(recovery.unknown().length, 0);
    assert.equal(recovery.outbox().length, 1);
    assert.equal(inboundCalls(await readJournal(secondJournal), 'turn/start').length, 0);

    // 5. A new delivery after reconnect goes to the reconnected session exactly once.
    const next = await recovery.deliver('run the focused suite', 'delivery-recovery-2');
    assert.equal(next.state, 'acknowledged');
    const secondTurnStarts = inboundCalls(await readJournal(secondJournal), 'turn/start');
    assert.equal(secondTurnStarts.length, 1);
    assert.deepEqual(secondTurnStarts.map(instructionOfTurnStart), ['run the focused suite']);
    assert.deepEqual(
      inboundCalls(await readJournal(firstJournal), 'turn/start').map(instructionOfTurnStart),
      [instruction],
      'the first child must keep exactly its own instruction',
    );
    assert.deepEqual(
      recovery.outbox().map((record) => record.deliveryId),
      ['delivery-recovery-1', 'delivery-recovery-2'],
    );
  } finally {
    await recovery.close().catch(() => undefined);
    await rm(root, {recursive: true, force: true});
  }
});
