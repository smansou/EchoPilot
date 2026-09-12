#!/usr/bin/env node
/**
 * H01 fixture — a real stdio child that speaks the pinned Codex app-server protocol.
 *
 * Provenance: every message below was written against the JSON Schema bundle generated from the
 * installed tested CLI (`codex-cli 0.154.0`, `codex app-server generate-json-schema`): client
 * requests `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`; client
 * notification `initialized`; server notifications `thread/started`, `turn/started`, `item/started`,
 * `item/completed`, `turn/completed`, `item/reasoning/summaryTextDelta`; and the server→client request
 * `item/commandExecution/requestApproval`. It executes no commands: the approval ping-pong decides
 * whether the scripted "guarded" tool item completes.
 *
 * Transport: newline-delimited JSON-RPC over stdio, exactly like the real app-server. No network,
 * account, or real Codex session is involved.
 *
 * Environment:
 *   H01_SCENARIO        readonly-task | approval | version-mismatch   (default readonly-task)
 *   H01_SERVER_VERSION  version reported as `codex-cli/<version>`    (default 0.154.0)
 *   H01_JOURNAL         append-only JSONL path recording every inbound/outbound message and
 *                       lifecycle event; the acceptance test reads it as wire-level evidence.
 */
import { appendFileSync } from 'node:fs';

const scenario = process.env.H01_SCENARIO ?? 'readonly-task';
const serverVersion = process.env.H01_SERVER_VERSION ?? '0.154.0';
const journalPath = process.env.H01_JOURNAL;

const THREAD_ID = 'thread-1';
const APPROVAL_REQUEST_ID = 7;
const REASONING_SENTINEL = 'H01-HIDDEN-REASONING-SENTINEL';

function journal(dir, payload) {
  if (!journalPath) return;
  appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), dir, ...payload })}\n`);
}

function send(message) {
  journal('out', { message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, method) {
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function threadSnapshot(turns = []) {
  return {
    id: THREAD_ID,
    sessionId: THREAD_ID,
    cliVersion: serverVersion,
    createdAt: 1_757_661_600,
    updatedAt: 1_757_661_600,
    cwd: process.cwd(),
    ephemeral: false,
    modelProvider: 'openai',
    preview: 'H01 fixture thread',
    projectId: null,
    source: 'appServer',
    status: { type: 'idle' },
    turns,
  };
}

function turnSnapshot(turnId, status, items = []) {
  return { id: turnId, items, status };
}

function commandItem(overrides) {
  return {
    type: 'commandExecution',
    id: 'item-cmd-1',
    command: 'cat fixtures/harness/codex/readonly-task.txt',
    commandActions: [],
    cwd: process.cwd(),
    status: 'inProgress',
    ...overrides,
  };
}

function agentMessageItem(id, text) {
  return { type: 'agentMessage', id, text };
}

function itemStarted(threadId, turnId, item) {
  send({
    method: 'item/started',
    params: { threadId, turnId, startedAtMs: 1_757_661_600_000, item },
  });
}

function itemCompleted(threadId, turnId, item) {
  send({
    method: 'item/completed',
    params: { threadId, turnId, completedAtMs: 1_757_661_600_500, item },
  });
}

function turnCompleted(threadId, turnId, status) {
  send({
    method: 'turn/completed',
    params: { threadId, turn: turnSnapshot(turnId, status) },
  });
}

let turnCount = 0;
let approvalOutstanding = false;

function startTurn(id, params) {
  turnCount += 1;
  const turnId = `turn-${turnCount}`;
  const threadId = typeof params?.threadId === 'string' ? params.threadId : THREAD_ID;
  respond(id, { turn: turnSnapshot(turnId, 'inProgress') });
  send({
    method: 'turn/started',
    params: { threadId, turn: turnSnapshot(turnId, 'inProgress') },
  });

  if (turnCount === 1 && scenario === 'readonly-task') {
    itemStarted(threadId, turnId, commandItem({}));
    itemCompleted(threadId, turnId, commandItem({
      status: 'completed',
      exitCode: 0,
      durationMs: 12,
      aggregatedOutput: 'H01-READONLY-FIXTURE-OUTPUT\n',
    }));
    // Hidden reasoning is streamed but must never become user-visible content.
    send({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId, turnId, itemId: 'item-reasoning-1', summaryIndex: 0, delta: REASONING_SENTINEL },
    });
    itemCompleted(threadId, turnId, agentMessageItem(
      'item-msg-1',
      'H01 fixture: the read-only fixture file contains one line.',
    ));
    return;
  }

  if (turnCount === 1 && scenario === 'approval') {
    itemStarted(threadId, turnId, commandItem({ id: 'item-cmd-approval' }));
    approvalOutstanding = true;
    send({
      id: APPROVAL_REQUEST_ID,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: 'item-cmd-approval',
        startedAtMs: 1_757_661_600_000,
        approvalId: null,
        kind: 'command',
        command: 'echo H01-APPROVAL > fixtures/harness/codex/approval-artifact.txt',
        cwd: process.cwd(),
        reason: 'H01 fixture approval gate',
      },
    });
    return;
  }

  if (turnCount >= 2) {
    itemCompleted(threadId, turnId, agentMessageItem(
      `item-msg-${turnCount}`,
      `H01 fixture: resumed turn ${turnCount} produced a result.`,
    ));
    turnCompleted(threadId, turnId, 'completed');
  }
}

function resolveApproval(message) {
  if (!approvalOutstanding) return;
  const decision = message.result?.decision;
  approvalOutstanding = false;
  const threadId = THREAD_ID;
  const turnId = 'turn-1';
  if (decision === 'accept' || decision === 'acceptForSession') {
    itemCompleted(threadId, turnId, commandItem({
      id: 'item-cmd-approval',
      status: 'completed',
      exitCode: 0,
      durationMs: 9,
      aggregatedOutput: 'H01-APPROVAL-EXECUTED\n',
    }));
    itemCompleted(threadId, turnId, agentMessageItem(
      'item-msg-approval',
      'H01 fixture: approved command completed.',
    ));
    turnCompleted(threadId, turnId, 'completed');
    return;
  }
  if (decision === 'decline' || decision === 'cancel') {
    itemCompleted(threadId, turnId, commandItem({ id: 'item-cmd-approval', status: 'declined' }));
    itemCompleted(threadId, turnId, agentMessageItem(
      'item-msg-approval',
      'H01 fixture: approval was not granted, so nothing ran.',
    ));
    turnCompleted(threadId, turnId, 'completed');
    return;
  }
  journal('lifecycle', { event: 'unexpected-approval-decision', decision: decision ?? null });
}

function handle(message) {
  if (typeof message?.method === 'string') {
    const { id, method, params } = message;
    if (id === undefined) {
      // Notification.
      if (method === 'initialized') {
        if (scenario === 'version-mismatch') {
          // A newer app-server can already be busy with threads this client did not create.
          send({ method: 'thread/started', params: { thread: threadSnapshot() } });
          send({ method: 'future/telemetry', params: { threadId: THREAD_ID, sequence: 1 } });
          send({ method: 'future/checkpoint', params: { threadId: THREAD_ID, sequence: 2 } });
          let heartbeats = 0;
          const heartbeat = setInterval(() => {
            heartbeats += 1;
            send({ method: 'future/heartbeat', params: { threadId: THREAD_ID, sequence: heartbeats } });
          }, 200);
          heartbeat.unref();
        }
      }
      return;
    }
    switch (method) {
      case 'initialize':
        respond(id, {
          userAgent: `codex-cli/${serverVersion}`,
          codexHome: '/tmp/h01-fixture-codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        });
        return;
      case 'thread/start':
        respond(id, {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          cwd: process.cwd(),
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          sandbox: { type: 'readOnly' },
          thread: threadSnapshot(),
        });
        send({ method: 'thread/started', params: { thread: threadSnapshot() } });
        return;
      case 'thread/resume':
        respond(id, {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          cwd: process.cwd(),
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          sandbox: { type: 'readOnly' },
          thread: threadSnapshot(),
        });
        return;
      case 'turn/start':
        startTurn(id, params);
        return;
      case 'turn/interrupt': {
        respond(id, {});
        const threadId = typeof params?.threadId === 'string' ? params.threadId : THREAD_ID;
        const turnId = typeof params?.turnId === 'string' ? params.turnId : 'turn-1';
        turnCompleted(threadId, turnId, 'interrupted');
        return;
      }
      default:
        return respondError(id, method);
    }
  }
  if (message && typeof message === 'object' && 'id' in message && ('result' in message || 'error' in message)) {
    resolveApproval(message);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      journal('lifecycle', { event: 'unparsable-line', line: line.slice(0, 200) });
      continue;
    }
    journal('in', { message });
    try {
      handle(message);
    } catch (error) {
      journal('lifecycle', { event: 'handler-error', message: String(error) });
    }
  }
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  journal('lifecycle', { event: 'shutdown', reason });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.stdin.on('end', () => shutdown('stdin-end'));
process.stdin.on('close', () => shutdown('stdin-close'));
