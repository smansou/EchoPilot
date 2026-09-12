/**
 * H01 — managed Codex app-server harness adapter (IMPLEMENTATION_PLAN.md §5.3).
 *
 * Speaks the pinned Codex app-server protocol (codex-cli 0.154.0, whose generated JSON schemas
 * this package ships under `schema/`) over newline-delimited JSON-RPC on stdio:
 *
 *   initialize → initialized → thread/start → turn/start → notifications → turn/interrupt,
 *   with `thread/resume` continuing a recorded thread and server → client approval requests held
 *   pending until `respondApproval()` supplies an authorized decision.
 *
 * Guarantees this adapter makes, and the judgment behind them:
 *
 *   - Only sessions this adapter spawned are ever written to. No ambient Codex desktop session is
 *     attached to or mutated; `command`/`args` are an argv vector spawned directly (never a shell).
 *   - The generated schema version pins compatibility. When the attached app-server reports another
 *     `codex-cli/<version>`, the adapter degrades to observe-only: no mutation reaches the wire,
 *     unknown notifications are still preserved as `unsupported` diagnostic events, and requests
 *     the adapter cannot understand are never answered (answering would guess a payload shape).
 *   - Approvals stay pending until `respondApproval(requestId, decision)` is called with the id of
 *     the observed request. Closing the session, a child failure, or a crashed companion never
 *     answers a pending request, so nothing guarded can run without an authorized decision.
 *   - Hidden model reasoning is never user-visible content: reasoning and streamed content
 *     fragments are dropped rather than normalized (the completed item carries final content), and
 *     only explicit text the app-server reports as an agent message becomes `agent_message`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {
  EventEnvelope,
  EventKind,
  HarnessAdapter,
  HarnessCapability,
  HarnessDeliveryReceipt,
  Scope,
} from '../../contracts/src/index.js';
import {
  AGENT_MESSAGE_ITEM_TYPE,
  APPROVE_DECISION,
  DENY_DECISION,
  HIDDEN_REASONING_ITEM_TYPE,
  METHODS,
  SUPPORTED_SERVER_VERSION,
  isApprovalRequestMethod,
  isHiddenReasoningNotification,
  isKnownServerNotification,
  isStreamedContentNotification,
  isToolItemType,
} from './protocol.js';

export type CodexHarnessOptions = Readonly<{
  /** Executable to spawn; always invoked as an argv vector, never through a shell. */
  command: string;
  args?: ReadonlyArray<string>;
  /** Scoped working directory for the managed child. */
  cwd: string;
  /** Explicit extra environment entries on top of a scrubbed environment. */
  env?: Readonly<Record<string, string>>;
  /** Base scope for normalized events; `sessionId` becomes the app-server thread id. */
  scope: Scope;
}>;

export type CodexHarnessInfo = Readonly<{
  adapter: 'codex-app-server';
  /** Version of the generated schemas this adapter ships. */
  supportedVersion: string;
  /** Version the attached app-server reported during the initialize handshake. */
  serverVersion: string;
  compatible: boolean;
  capabilities: ReadonlyArray<HarnessCapability>;
}>;

export type CodexHarnessAdapter = HarnessAdapter & {
  info(): Promise<CodexHarnessInfo>;
};

type JsonRpcId = number | string;

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type PendingApproval = Readonly<{ id: JsonRpcId; method: string }>;

type EmittableEvent = Readonly<{
  kind: EventKind;
  unsupportedKind?: string | undefined;
  trust: EventEnvelope['trust'];
  threadId?: string | undefined;
  turnId?: string | undefined;
  sourceEventId: string;
  refSuffix: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAtMs?: number | undefined;
}>;

/** Replayable event buffer: iterators created before or after start() see every event, in order. */
class EventBus {
  private readonly events: EventEnvelope[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;

  push(event: EventEnvelope): void {
    this.events.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  iterable(): AsyncIterable<EventEnvelope> {
    return { [Symbol.asyncIterator]: (): AsyncIterator<EventEnvelope> => this.iterator() };
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter();
    }
  }

  private iterator(): AsyncIterator<EventEnvelope> {
    let cursor = 0;
    return {
      next: async (): Promise<IteratorResult<EventEnvelope>> => {
        for (;;) {
          const event = this.events[cursor];
          if (event !== undefined) {
            cursor += 1;
            return { value: event, done: false };
          }
          if (this.closed) return { value: undefined, done: true };
          await new Promise<void>((resolve) => {
            const waiter = (): void => {
              this.waiters.delete(waiter);
              resolve();
            };
            this.waiters.add(waiter);
          });
        }
      },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The app-server reports its own version inside the initialize response's `userAgent`: the
 * documented form is `codex-cli/0.154.0 (…)`, and when the managing client identifies itself with
 * another name the first `name/version` token carries the same server version
 * (`<client>/0.154.0 (…) …`). Only that version — never the client's own — decides compatibility.
 */
function parseServerVersion(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined) return undefined;
  const documented = /(?:^|[\s(])codex-cli\/([^\s()]+)/.exec(userAgent);
  if (documented !== null) return documented[1];
  return /^[^\s/]+\/([^\s()]+)/.exec(userAgent.trim())?.[1];
}

/**
 * The managed child inherits only what an app-server needs to boot. Nothing that could silently
 * attach it to the user's ambient Codex home, desktop session, or in-process Node configuration.
 */
function scrubbedEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC']) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  if (inherited.PATH === undefined && inherited.TMPDIR === undefined) inherited.TMPDIR = tmpdir();
  return { ...inherited, ...extra };
}

export class CodexAppServerHarnessAdapter implements CodexHarnessAdapter {
  private readonly scope: Scope;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sourceId = `codex-app-server:${randomUUID()}`;
  private readonly shortId = this.sourceId.slice(-8);
  private readonly eventBus = new EventBus();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly diagnosticLog: string[] = [];

  private child?: ChildProcess;
  private stdoutBuffer = '';
  private receivedMessages = 0;
  private emittedEvents = 0;
  private nextRequestId = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private serverVersion = 'unknown';
  private compatible = false;
  private started = false;
  private closed = false;
  private closing?: Promise<void>;
  private exitPromise?: Promise<void> | undefined;
  private resolveExit?: (() => void) | undefined;
  private threadId?: string;

  constructor(private readonly options: CodexHarnessOptions) {
    this.scope = options.scope;
    this.env = scrubbedEnvironment(options.env);
  }

  async info(): Promise<CodexHarnessInfo> {
    return {
      adapter: 'codex-app-server',
      supportedVersion: SUPPORTED_SERVER_VERSION,
      serverVersion: this.serverVersion,
      compatible: this.compatible,
      capabilities: [...(await this.capabilities())],
    };
  }

  async capabilities(): Promise<ReadonlySet<HarnessCapability>> {
    const capabilities = new Set<HarnessCapability>(['observe']);
    if (this.compatible) {
      capabilities.add('send');
      capabilities.add('interrupt');
      capabilities.add('approval');
      capabilities.add('resume');
    }
    return capabilities;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Codex app-server adapter is closed');
    if (this.started) return;

    const args = [...(this.options.args ?? [])];
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill('SIGKILL');
      throw new Error('Codex app-server must be spawned with piped stdio');
    }
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    child.on('error', (error: Error) => this.onFailure(error));
    child.on('exit', (code, signal) => this.onExit(code, signal));

    try {
      const response = asRecord(await this.request(METHODS.initialize, {
        clientInfo: { name: 'echopilot-companion', title: 'EchoPilot managed Codex harness', version: '0.1.0' },
      }));
      const userAgent = readString(response, 'userAgent');
      const reported = parseServerVersion(userAgent);
      this.serverVersion = reported ?? userAgent ?? 'unknown';
      // Only the exact generated-schema version is safe to mutate; anything else is observe-only.
      this.compatible = this.serverVersion === SUPPORTED_SERVER_VERSION;
      this.write({ method: METHODS.initialized });
      this.started = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  observe(): AsyncIterable<EventEnvelope> {
    return this.eventBus.iterable();
  }

  async send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
    if (typeof instruction !== 'string' || instruction.trim().length === 0) {
      throw new TypeError('send() requires a non-empty instruction');
    }
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new TypeError('send() requires a delivery id');
    }
    this.assertMutable('send');
    return this.serialize(async () => {
      const threadId = await this.ensureThread();
      const response = asRecord(await this.request(METHODS.turnStart, {
        threadId,
        input: [{ type: 'text', text: instruction }],
      }));
      // `Turn.id` is required by the generated schema; an acknowledgement without one would be a lie.
      if (readString(asRecord(response.turn), 'id') === undefined) {
        throw new Error('The app-server did not return a turn id for turn/start');
      }
      return { deliveryId, status: 'acknowledged' } satisfies HarnessDeliveryReceipt;
    });
  }

  async interrupt(turnId: string): Promise<void> {
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new TypeError('interrupt() requires a turn id');
    }
    this.assertMutable('interrupt');
    const threadId = this.threadId;
    if (threadId === undefined) {
      throw new Error('interrupt() requires a started thread; call send() or resume() first');
    }
    await this.serialize(async () => {
      await this.request(METHODS.turnInterrupt, { threadId, turnId });
    });
  }

  async respondApproval(requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    this.assertMutable('approval');
    if (decision !== 'approve' && decision !== 'deny') {
      throw new TypeError('respondApproval() accepts only "approve" or "deny"');
    }
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) {
      throw new Error(
        `No approval request "${requestId}" is pending; an approval is answered only after it is observed`,
      );
    }
    this.pendingApprovals.delete(requestId);
    this.write({
      id: pending.id,
      result: { decision: decision === 'approve' ? APPROVE_DECISION : DENY_DECISION },
    });
  }

  async resume(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('resume() requires a thread id');
    }
    this.assertMutable('resume');
    await this.serialize(async () => {
      const response = asRecord(await this.request(METHODS.threadResume, { threadId: sessionId }));
      this.threadId = readString(asRecord(response.thread), 'id') ?? sessionId;
    });
  }

  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = (async (): Promise<void> => {
      this.closed = true;
      this.rejectPending(new Error('The managed Codex app-server session was closed'));
      // Pending approvals are dropped, never answered: no decision exists after a companion failure.
      this.pendingApprovals.clear();
      const child = this.child;
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = this.exitPromise ?? Promise.resolve();
        child.stdin?.end();
        child.kill('SIGTERM');
        const timedOut = await Promise.race([
          exited.then(() => false),
          delay(1_500).then(() => true),
        ]);
        if (timedOut) {
          child.kill('SIGKILL');
          await Promise.race([exited, delay(500)]);
        }
      }
      this.eventBus.close();
    })();
    return this.closing;
  }

  /** Diagnostics observed but not normalized (unparsable lines, stderr); never user-visible content. */
  diagnostics(): ReadonlyArray<string> {
    return [...this.diagnosticLog];
  }

  private assertMutable(capability: HarnessCapability): void {
    if (this.closed) throw new Error('The managed Codex app-server session is closed');
    if (!this.compatible) {
      throw new Error(
        `Codex app-server ${this.serverVersion} does not match the generated-schema version `
        + `${SUPPORTED_SERVER_VERSION}; the adapter is observe-only and refuses ${capability} calls.`,
      );
    }
    if (!this.started) throw new Error(`start() must complete before ${capability} calls`);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureThread(): Promise<string> {
    if (this.threadId !== undefined) return this.threadId;
    const response = asRecord(await this.request(METHODS.threadStart, { cwd: this.options.cwd }));
    const threadId = readString(asRecord(response.thread), 'id');
    if (threadId === undefined) {
      throw new Error('The app-server did not return a thread id for thread/start');
    }
    this.threadId = threadId;
    return threadId;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (child === undefined || this.closed) {
      return Promise.reject(new Error(`Cannot call ${method}: the managed app-server is not running`));
    }
    const id = ++this.nextRequestId;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { method, resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Readonly<Record<string, unknown>>): void {
    const child = this.child;
    if (child?.stdin == null || this.closed) {
      throw new Error('The managed app-server is not accepting writes');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onStderr(chunk: string): void {
    const text = chunk.trim();
    if (text.length > 0) this.diagnosticLog.push(text);
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.diagnosticLog.push(`unparsable app-server line: ${line.slice(0, 200)}`);
      return;
    }
    this.receivedMessages += 1;
    const record = asRecord(message);
    const method = readString(record, 'method');
    if (method !== undefined) {
      if (record.id === undefined) this.onNotification(method, asRecord(record.params));
      else this.onServerRequest(method, record.id as JsonRpcId, asRecord(record.params));
      return;
    }
    if (record.id !== undefined) this.onResponse(record);
  }

  private onResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) return;
    this.pendingRequests.delete(id);
    if (message.error !== undefined) {
      const error = asRecord(message.error);
      pending.reject(new Error(`${pending.method} failed: ${readString(error, 'message') ?? JSON.stringify(message.error)}`));
      return;
    }
    pending.resolve(message.result);
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = readString(params, 'threadId');
    const item = asRecord(params.item);
    const turn = asRecord(params.turn);
    const turnId = readString(params, 'turnId') ?? readString(turn, 'id');

    if (isHiddenReasoningNotification(method) || isStreamedContentNotification(method)) return;

    switch (method) {
      case 'thread/started':
        this.emit({
          kind: 'session_state',
          trust: 'tool_observed',
          threadId: readString(asRecord(params.thread), 'id'),
          sourceEventId: `${method}#${this.receivedMessages}`,
          refSuffix: `thread/${readString(asRecord(params.thread), 'id') ?? 'unknown'}/started`,
          payload: { method },
        });
        return;
      case 'turn/started':
      case 'turn/completed':
        this.emit({
          kind: 'session_state',
          trust: 'tool_observed',
          threadId,
          turnId,
          sourceEventId: `${method}#${this.receivedMessages}`,
          refSuffix: `thread/${threadId ?? 'unknown'}/turn/${turnId ?? 'unknown'}/${method.split('/')[1] ?? 'state'}`,
          payload: { method, status: readString(asRecord(turn.status), 'type') ?? turn.status },
        });
        return;
      case 'item/started':
        if (isToolItemType(item.type)) {
          this.emit({
            kind: 'tool_started',
            trust: 'tool_observed',
            threadId,
            turnId: turnId ?? readString(item, 'turnId'),
            sourceEventId: `${method}#${readString(item, 'id') ?? this.receivedMessages}`,
            refSuffix: `thread/${threadId ?? 'unknown'}/item/${readString(item, 'id') ?? 'unknown'}/started`,
            payload: { method, itemType: item.type, itemId: readString(item, 'id') },
            occurredAtMs: readNumber(params, 'startedAtMs'),
          });
          return;
        }
        if (
          item.type === AGENT_MESSAGE_ITEM_TYPE
          || item.type === 'userMessage'
          || item.type === HIDDEN_REASONING_ITEM_TYPE
        ) return;
        this.emitUnsupported(method, params, { threadId, turnId });
        return;
      case 'item/completed':
        if (item.type === AGENT_MESSAGE_ITEM_TYPE) {
          this.emit({
            kind: 'agent_message',
            trust: 'agent_reported',
            threadId,
            turnId,
            sourceEventId: `${method}#${readString(item, 'id') ?? this.receivedMessages}`,
            refSuffix: `thread/${threadId ?? 'unknown'}/item/${readString(item, 'id') ?? 'unknown'}/message`,
            payload: { method, itemType: item.type, itemId: readString(item, 'id'), text: readString(item, 'text') },
            occurredAtMs: readNumber(params, 'completedAtMs'),
          });
          return;
        }
        if (isToolItemType(item.type)) {
          this.emit({
            kind: 'tool_completed',
            trust: 'tool_observed',
            threadId,
            turnId,
            sourceEventId: `${method}#${readString(item, 'id') ?? this.receivedMessages}`,
            refSuffix: `thread/${threadId ?? 'unknown'}/item/${readString(item, 'id') ?? 'unknown'}/completed`,
            payload: {
              method,
              itemType: item.type,
              itemId: readString(item, 'id'),
              status: item.status,
              exitCode: item.exitCode,
            },
            occurredAtMs: readNumber(params, 'completedAtMs'),
          });
          return;
        }
        // Hidden reasoning and echoes of the user's own prompt never become user-visible content.
        if (item.type === HIDDEN_REASONING_ITEM_TYPE || item.type === 'userMessage') return;
        this.emitUnsupported(method, params, { threadId, turnId });
        return;
      default:
        this.emitUnsupported(method, params, { threadId, turnId });
    }
  }

  private onServerRequest(method: string, id: JsonRpcId, params: Record<string, unknown>): void {
    const requestId = String(id);
    if (isApprovalRequestMethod(method)) {
      // Held pending: no response is written until respondApproval() is called with this id.
      this.pendingApprovals.set(requestId, { id, method });
      this.emit({
        kind: 'approval_requested',
        trust: 'tool_observed',
        threadId: readString(params, 'threadId'),
        turnId: readString(params, 'turnId'),
        sourceEventId: requestId,
        refSuffix: `thread/${readString(params, 'threadId') ?? 'unknown'}/approval/${requestId}`,
        payload: { method },
      });
      return;
    }
    // Unknown or unimplemented requests are observed for diagnostics and deliberately never answered:
    // answering would guess a payload shape the pinned schema does not define here.
    this.emitUnsupported(method, params, {
      threadId: readString(params, 'threadId'),
      turnId: readString(params, 'turnId'),
      sourceEventId: requestId,
      refSuffix: `request/${encodeURIComponent(method)}/${requestId}`,
      trust: 'tool_observed',
    });
  }

  private emitUnsupported(
    method: string,
    params: Record<string, unknown>,
    overrides: Partial<EmittableEvent> = {},
  ): void {
    // Known methods that have no normalized shape are preserved too: diagnostics survive, content does not.
    const known = isKnownServerNotification(method) ? 'known-but-unmapped' : 'unknown-to-schema';
    this.emit({
      kind: 'unsupported',
      unsupportedKind: method,
      trust: 'tool_observed',
      threadId: readString(params, 'threadId'),
      turnId: readString(params, 'turnId'),
      sourceEventId: `${method}#${this.receivedMessages}`,
      refSuffix: `unsupported/${encodeURIComponent(method)}`,
      payload: { method, known },
      ...overrides,
    });
  }

  private emit(event: EmittableEvent): void {
    const observedAt = new Date().toISOString();
    const occurredAt = event.occurredAtMs === undefined
      ? observedAt
      : new Date(event.occurredAtMs).toISOString();
    const ingestSequence = ++this.emittedEvents;
    const scope: Scope = event.threadId === undefined
      ? { ...this.scope }
      : { ...this.scope, sessionId: event.threadId };
    const envelope: EventEnvelope = {
      schemaVersion: 1,
      eventId: `${this.sourceId}:${ingestSequence}`,
      sourceId: this.sourceId,
      sourceEventId: event.sourceEventId.slice(0, 128),
      sourceSequence: this.receivedMessages,
      ingestSequence,
      occurredAt,
      observedAt,
      scope,
      kind: event.kind,
      payloadRef: `codex-app-server://${this.shortId}/${event.refSuffix}`,
      contentHash: createHash('sha256').update(JSON.stringify(event.payload)).digest('hex'),
      trust: event.trust,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.kind === 'unsupported' ? { unsupportedKind: event.unsupportedKind ?? event.kind } : {}),
    };
    this.eventBus.push(envelope);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private onFailure(error: Error): void {
    this.diagnosticLog.push(`app-server process error: ${error.message}`);
    this.rejectPending(new Error(`Managed Codex app-server failed: ${error.message}`));
    this.resolveExit?.();
    this.resolveExit = undefined;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const tail = this.diagnosticLog.slice(-3).join(' | ');
    this.rejectPending(new Error(
      `Managed Codex app-server exited (code ${String(code)}, signal ${String(signal)})`
      + (tail.length > 0 ? `: ${tail}` : ''),
    ));
    // A dead app-server has no pending requests left; dropping them keeps "no decision" honest.
    this.pendingApprovals.clear();
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.eventBus.close();
  }

}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createCodexHarnessAdapter(options: CodexHarnessOptions): CodexHarnessAdapter {
  return new CodexAppServerHarnessAdapter(options);
}

export { SUPPORTED_SERVER_VERSION };
