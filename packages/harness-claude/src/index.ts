/**
 * H02 — managed Claude Code tracer bullet.
 *
 * Two shapes share one normalized contract (`EventEnvelope`, schema version 1):
 *
 *  - `createClaudeManagedSession` drives a Claude Code session through the documented
 *    programmatic streaming (stream-json) interface over an injectable stdio transport.
 *    Prompts and approval decisions travel as stream-json input frames; lifecycle lines,
 *    assistant messages, tool activity, transcript references, and turn results are normalized.
 *
 *  - `createClaudeHookObserver` observes sessions EchoPilot does not manage, through
 *    enqueue-only hooks. It has no input path: `send()` reports `unsupported` because a hook is
 *    not a general input API.
 *
 * `installClaudeObservationHooks` / `removeClaudeObservationHooks` add and remove exactly the
 * managed observation entries, preserve every unrelated hook and setting, and are idempotent.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  EventEnvelope,
  EventKind,
  HarnessCapability,
  HarnessDeliveryReceipt,
  Scope,
} from '../../contracts/src/index.js';

/** Documented Claude Code lifecycle events the observation hooks subscribe to. */
export const CLAUDE_OBSERVED_HOOK_EVENTS: ReadonlyArray<string> = Object.freeze([
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SessionStart',
  'SessionEnd',
  'Stop',
]);

export type ClaudeStreamTransport = {
  start(): Promise<void>;
  /** One stream-json input frame. */
  writeLine(line: string): Promise<void>;
  /** One stream-json output line per value. */
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
};

export type ClaudeManagedSessionOptions = {
  scope: Scope;
  sessionRoot: string;
  transport: ClaudeStreamTransport;
};

export type ClaudeHookObserverOptions = {
  scope: Scope;
  installationId: string;
  spoolDir: string;
};

export type ClaudeHookInstallOptions = {
  settingsPath: string;
  hookScriptPath: string;
  spoolDir: string;
  installationId: string;
  ingressPath?: string;
};

export type ClaudeManagedSession = {
  capabilities(): Promise<ReadonlySet<HarnessCapability>>;
  start(): Promise<void>;
  observe(): AsyncIterable<EventEnvelope>;
  send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: 'approve' | 'deny'): Promise<void>;
  resume(sessionId: string): Promise<void>;
  close(): Promise<void>;
};

export type ClaudeHookObserver = {
  capabilities(): Promise<ReadonlySet<HarnessCapability>>;
  collect(): Promise<ReadonlyArray<EventEnvelope>>;
  send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
};

const MANAGED_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set<HarnessCapability>([
  'observe',
  'send',
  'interrupt',
  'approval',
  'resume',
]);
const HOOK_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set<HarnessCapability>(['observe']);
/** Marker that distinguishes an EchoPilot-managed observation entry from unrelated entries. */
const MANAGED_HOOK_MARKER = 'ECHOPILOT_HOOK_INSTALLATION_ID';

const nowIso = (): string => new Date().toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function messageBlocks(frame: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const message = frame.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

type EventQueue = {
  push(event: EventEnvelope): void;
  end(): void;
  drain(): AsyncIterable<EventEnvelope>;
};

function createEventQueue(): EventQueue {
  const pending: EventEnvelope[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  return {
    push(event) {
      if (ended) return;
      pending.push(event);
      waiters.shift()?.();
    },
    end() {
      ended = true;
      while (waiters.length > 0) waiters.shift()?.();
    },
    async *drain() {
      for (;;) {
        const next = pending.shift();
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
}

export function createClaudeManagedSession(options: ClaudeManagedSessionOptions): ClaudeManagedSession {
  const { scope, sessionRoot, transport } = options;
  const queue = createEventQueue();
  const toolTurns = new Map<string, string>();
  let sessionId: string | null = null;
  let transcriptRef: string | null = null;
  let currentTurnId: string | null = null;
  let sourceSequence = 0;
  let started = false;
  let closed = false;

  const emit = (input: {
    kind: EventKind;
    sid: string;
    label: string;
    trust: EventEnvelope['trust'];
    raw: string;
    uuid?: string | undefined;
    turnId?: string | undefined;
  }): void => {
    sourceSequence += 1;
    const sequence = sourceSequence;
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: `claude-${input.label}-${sha256(`${input.uuid ?? input.raw}:${sequence}`).slice(0, 24)}`,
      sourceId: `claude:${input.sid}`,
      sourceEventId: `${input.label}:${input.uuid ?? 'stream'}:${sequence}`,
      sourceSequence: sequence,
      ingestSequence: sequence,
      occurredAt: nowIso(),
      observedAt: nowIso(),
      scope: { ...scope, sessionId: input.sid },
      kind: input.kind,
      payloadRef: `${transcriptRef ?? `${sessionRoot}/stream`}#session=${input.sid}#seq=${sequence}`,
      contentHash: sha256(input.raw),
      trust: input.trust,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    };
    queue.push(event);
  };

  const handleLine = (line: string): void => {
    const raw = line.trim();
    if (raw.length === 0) return;
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return;
      frame = parsed;
    } catch {
      return;
    }

    const announced = textField(frame, 'session_id');
    if (announced !== undefined) sessionId = announced;
    const transcriptPath = textField(frame, 'transcript_path');
    if (transcriptPath !== undefined) transcriptRef = `file:${transcriptPath}`;
    const sid = sessionId ?? `claude-${sha256(sessionRoot).slice(0, 12)}`;
    const turnId = currentTurnId ?? undefined;
    const type = textField(frame, 'type') ?? '';

    if (type === 'system') {
      emit({ kind: 'session_state', sid, label: 'system', trust: 'tool_observed', raw, turnId, uuid: textField(frame, 'uuid') });
      return;
    }

    if (type === 'assistant') {
      for (const block of messageBlocks(frame)) {
        const blockType = textField(block, 'type');
        if (blockType === 'text') {
          emit({ kind: 'agent_message', sid, label: 'assistant-text', trust: 'agent_reported', raw, turnId, uuid: textField(frame, 'uuid') });
        } else if (blockType === 'tool_use') {
          const toolUseId = textField(block, 'id');
          if (toolUseId !== undefined && currentTurnId !== null) toolTurns.set(toolUseId, currentTurnId);
          emit({
            kind: 'tool_started',
            sid,
            label: 'tool-start',
            trust: 'agent_reported',
            raw,
            turnId,
            uuid: toolUseId ?? textField(frame, 'uuid'),
          });
        }
      }
      return;
    }

    if (type === 'user') {
      for (const block of messageBlocks(frame)) {
        const blockType = textField(block, 'type');
        if (blockType === 'tool_result') {
          const toolUseId = textField(block, 'tool_use_id');
          const resultTurn = (toolUseId === undefined ? undefined : toolTurns.get(toolUseId)) ?? currentTurnId ?? undefined;
          emit({
            kind: 'tool_completed',
            sid,
            label: 'tool-result',
            trust: 'tool_observed',
            raw,
            turnId: resultTurn,
            uuid: toolUseId ?? textField(frame, 'uuid'),
          });
        } else if (blockType === 'text') {
          emit({ kind: 'user_utterance', sid, label: 'user-text', trust: 'user_explicit', raw, turnId, uuid: textField(frame, 'uuid') });
        }
      }
      return;
    }

    if (type === 'control_request') {
      const request = isRecord(frame.request) ? frame.request : {};
      const requestId = textField(frame, 'request_id');
      if (requestId !== undefined && request.subtype === 'can_use_tool') {
        emit({ kind: 'approval_requested', sid, label: 'approval-request', trust: 'tool_observed', raw, turnId, uuid: requestId });
      } else {
        emit({ kind: 'session_state', sid, label: 'control-request', trust: 'tool_observed', raw, turnId, uuid: requestId });
      }
      return;
    }

    if (type === 'result') {
      emit({ kind: 'session_state', sid, label: 'turn-result', trust: 'tool_observed', raw, turnId, uuid: textField(frame, 'uuid') });
      currentTurnId = null;
      return;
    }

    // Partial stream deltas and unknown frame types carry no shared kind and stay unnormalized.
  };

  return {
    async capabilities() {
      return MANAGED_CAPABILITIES;
    },
    async start() {
      if (started) return;
      started = true;
      await transport.start();
      void (async () => {
        try {
          for await (const line of transport.lines()) {
            try {
              handleLine(line);
            } catch {
              // A malformed frame must not tear down observation of the rest of the stream.
            }
          }
        } catch {
          // The stream ended or failed; observation completes below.
        } finally {
          queue.end();
        }
      })();
    },
    observe() {
      return queue.drain();
    },
    async send(instruction, deliveryId) {
      if (!started || closed) throw new Error('Claude session is not open');
      currentTurnId = `turn-${deliveryId}`;
      await transport.writeLine(JSON.stringify({
        type: 'user',
        ...(sessionId === null ? {} : { session_id: sessionId }),
        message: { role: 'user', content: [{ type: 'text', text: instruction }] },
        parent_tool_use_id: null,
      }));
      return { deliveryId, status: 'acknowledged' };
    },
    async interrupt(turnId) {
      await transport.writeLine(JSON.stringify({
        type: 'control_request',
        request_id: `interrupt-${sha256(turnId).slice(0, 12)}`,
        request: { subtype: 'interrupt' },
      }));
    },
    async respondApproval(requestId, decision) {
      await transport.writeLine(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { behavior: decision === 'approve' ? 'allow' : 'deny' },
        },
      }));
      const sid = sessionId ?? `claude-${sha256(sessionRoot).slice(0, 12)}`;
      emit({
        kind: 'decision',
        sid,
        label: 'approval-decision',
        trust: 'user_explicit',
        raw: JSON.stringify({ requestId, decision }),
        turnId: currentTurnId ?? undefined,
        uuid: requestId,
      });
    },
    async resume(id) {
      sessionId = id;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch {
        // Closing an already-gone process is not an error for observation purposes.
      }
      queue.end();
    },
  };
}

type HookArchive = {
  installationId?: unknown;
  key?: unknown;
  receivedAt?: unknown;
  hook?: unknown;
};

function hookEventMapping(hookEventName: string): { kind: EventKind; trust: EventEnvelope['trust'] } {
  switch (hookEventName) {
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { kind: 'tool_completed', trust: 'tool_observed' };
    case 'PreToolUse':
      return { kind: 'tool_started', trust: 'tool_observed' };
    case 'Notification':
      return { kind: 'agent_message', trust: 'agent_reported' };
    default:
      return { kind: 'session_state', trust: 'tool_observed' };
  }
}

function normalizeHookArchive(
  scope: Scope,
  key: string,
  archive: HookArchive,
  sequence: number,
): EventEnvelope | null {
  const hook = archive.hook;
  if (!isRecord(hook)) return null;
  const sessionId = textField(hook, 'session_id');
  if (sessionId === undefined) return null;
  const eventName = textField(hook, 'hook_event_name') ?? 'unknown';
  const mapping = hookEventMapping(eventName);
  const transcriptPath = textField(hook, 'transcript_path');
  const receivedAt = typeof archive.receivedAt === 'string' && Number.isFinite(Date.parse(archive.receivedAt))
    ? archive.receivedAt
    : nowIso();
  const serialized = JSON.stringify(hook);
  return {
    schemaVersion: 1,
    eventId: `claude-hook-${key}`,
    sourceId: `claude:${sessionId}`,
    sourceEventId: `hook:${key}`,
    sourceSequence: sequence,
    ingestSequence: sequence,
    occurredAt: receivedAt,
    observedAt: nowIso(),
    scope: { ...scope, sessionId },
    kind: mapping.kind,
    payloadRef: `${transcriptPath === undefined ? 'hook-spool' : `file:${transcriptPath}`}#session=${sessionId}#${key}`,
    contentHash: sha256(serialized),
    trust: mapping.trust,
  };
}

export function createClaudeHookObserver(options: ClaudeHookObserverOptions): ClaudeHookObserver {
  const { scope, installationId, spoolDir } = options;
  const incomingDir = join(spoolDir, 'incoming');
  const processedDir = join(spoolDir, 'processed');

  return {
    async capabilities() {
      return HOOK_CAPABILITIES;
    },
    async collect() {
      await mkdir(incomingDir, { recursive: true });
      await mkdir(processedDir, { recursive: true });
      const names = (await readdir(incomingDir)).filter((name) => name.endsWith('.json')).sort();
      const processed = new Set((await readdir(processedDir)).filter((name) => name.endsWith('.json')));
      const base = processed.size;
      const deliveries: Array<{ name: string; archive: HookArchive }> = [];
      for (const name of names) {
        const filePath = join(incomingDir, name);
        let archive: HookArchive;
        try {
          archive = JSON.parse(await readFile(filePath, 'utf8')) as HookArchive;
        } catch {
          continue;
        }
        if (archive.installationId !== installationId) continue;
        deliveries.push({ name, archive });
      }
      // Oldest first, so sequence numbers follow the order Claude produced the events.
      deliveries.sort((left, right) => {
        const leftAt = typeof left.archive.receivedAt === 'string' ? left.archive.receivedAt : '';
        const rightAt = typeof right.archive.receivedAt === 'string' ? right.archive.receivedAt : '';
        return leftAt === rightAt ? left.name.localeCompare(right.name) : leftAt.localeCompare(rightAt);
      });
      const events: EventEnvelope[] = [];
      let index = 0;
      for (const { name, archive } of deliveries) {
        const filePath = join(incomingDir, name);
        const key = typeof archive.key === 'string' && archive.key.length > 0
          ? archive.key
          : name.replace(/\.json$/, '');
        if (processed.has(`${key}.json`)) {
          await rm(filePath, { force: true });
          continue;
        }
        index += 1;
        const event = normalizeHookArchive(scope, key, archive, base + index);
        if (event === null) {
          index -= 1;
          continue;
        }
        events.push(event);
        processed.add(`${key}.json`);
        await rename(filePath, join(processedDir, `${key}.json`));
      }
      return events;
    },
    async send(_instruction, deliveryId) {
      return { deliveryId, status: 'unsupported' };
    },
  };
}

type SettingsDocument = Record<string, unknown>;

async function readSettingsDocument(settingsPath: string): Promise<SettingsDocument> {
  let text: string;
  try {
    text = await readFile(settingsPath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new TypeError('Claude settings must be a JSON object');
  return parsed;
}

async function writeSettingsDocument(settingsPath: string, document: SettingsDocument): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.${process.pid}.echopilot.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temporary, settingsPath);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildHookCommand(options: ClaudeHookInstallOptions): string {
  const assignments = [
    `ECHOPILOT_HOOK_INSTALLATION_ID=${shellQuote(options.installationId)}`,
    `ECHOPILOT_HOOK_SPOOL_DIR=${shellQuote(options.spoolDir)}`,
  ];
  if (options.ingressPath !== undefined) {
    assignments.push(`ECHOPILOT_HOOK_INGRESS=${shellQuote(options.ingressPath)}`);
  }
  return `${assignments.join(' ')} ${shellQuote(process.execPath)} ${shellQuote(options.hookScriptPath)}`;
}

function createManagedHookEntry(options: ClaudeHookInstallOptions): { matcher: string; hooks: Array<{ type: string; command: string }> } {
  return { matcher: '*', hooks: [{ type: 'command', command: buildHookCommand(options) }] };
}

function isManagedHookEntry(entry: unknown, installationId: string): boolean {
  if (!isRecord(entry)) return false;
  const serialized = JSON.stringify(entry);
  return serialized.includes(installationId) && serialized.includes(MANAGED_HOOK_MARKER);
}

function hooksOf(document: SettingsDocument): Record<string, unknown> {
  return isRecord(document.hooks) ? { ...document.hooks } : {};
}

export async function installClaudeObservationHooks(
  options: ClaudeHookInstallOptions,
): Promise<{ installationId: string; events: ReadonlyArray<string> }> {
  const document = await readSettingsDocument(options.settingsPath);
  const hooks = hooksOf(document);
  for (const event of CLAUDE_OBSERVED_HOOK_EVENTS) {
    const current = hooks[event];
    const kept = Array.isArray(current)
      ? current.filter((candidate) => !isManagedHookEntry(candidate, options.installationId))
      : [];
    hooks[event] = [...kept, createManagedHookEntry(options)];
  }
  await writeSettingsDocument(options.settingsPath, { ...document, hooks });
  return { installationId: options.installationId, events: [...CLAUDE_OBSERVED_HOOK_EVENTS] };
}

export async function removeClaudeObservationHooks(
  options: { settingsPath: string; installationId: string },
): Promise<{ removed: boolean }> {
  const document = await readSettingsDocument(options.settingsPath);
  const hooks = hooksOf(document);
  let removed = false;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const kept = value.filter((candidate) => !isManagedHookEntry(candidate, options.installationId));
    if (kept.length === value.length) continue;
    removed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed) {
    const next: SettingsDocument = { ...document };
    if (Object.keys(hooks).length > 0 || 'hooks' in document) next.hooks = hooks;
    else delete next.hooks;
    await writeSettingsDocument(options.settingsPath, next);
  }
  return { removed };
}
