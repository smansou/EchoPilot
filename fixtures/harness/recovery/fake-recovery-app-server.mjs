#!/usr/bin/env node
/**
 * H04 fixture — a real stdio child that speaks the pinned Codex app-server protocol with a
 * configurable session identity and an explicit send/ack connection-loss scenario.
 *
 * Protocol provenance (same pinned CLI as the H01 fixture): the installed tested
 * `codex-cli 0.154.0` generated JSON schemas define the client requests `initialize`,
 * `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`; the client notification
 * `initialized`; the server notifications `thread/started`, `turn/started`, `item/started`,
 * `item/completed`, `turn/completed`; and the server→client request
 * `item/commandExecution/requestApproval`. Transport is newline-delimited JSON-RPC on stdio.
 * The child executes no commands: the approval ping-pong only decides whether the scripted
 * guarded item completes.
 *
 * Environment:
 *   H04_SCENARIO       session | approval | drop-ack        (default session)
 *   H04_THREAD_ID      app-server thread identity           (default h04-thread)
 *   H04_SESSION_ID     session id recorded in the session-state file (default: the thread id)
 *   H04_PROJECT_ID     project id recorded in the session-state file (default h04-project)
 *   H04_JOURNAL        append-only JSONL journal of every inbound/outbound message and lifecycle
 *                      event; the acceptance test reads it as wire-level evidence
 *   H04_SESSION_STATE  JSON file the fixture rewrites with the turns it accepted
 *                      ({sessionId, projectId, cwd, turns:[{turnId, instruction, status}]}) —
 *                      the observable session state a resumed session would report
 *
 * Scenarios:
 *   session  — `turn/start` is acknowledged, a command item completes, and the turn completes.
 *   approval — `turn/start` opens a guarded command item and blocks on the approval request
 *              (JSON-RPC id 7) until the client answers accept/decline.
 *   drop-ack — `turn/start` is accepted and recorded in the session state, then the child exits
 *              without answering the request: the instruction reached the harness, the
 *              acknowledgment did not come back.
 */
import {appendFileSync, writeFileSync} from 'node:fs';

const scenario = process.env.H04_SCENARIO ?? 'session';
const threadId = process.env.H04_THREAD_ID ?? 'h04-thread';
const sessionId = process.env.H04_SESSION_ID ?? threadId;
const projectId = process.env.H04_PROJECT_ID ?? 'h04-project';
const journalPath = process.env.H04_JOURNAL;
const statePath = process.env.H04_SESSION_STATE;

const CLI_VERSION = '0.154.0';
const APPROVAL_REQUEST_ID = 7;
const cwd = process.cwd();

/** The turns this child accepted; rewritten to H04_SESSION_STATE on every change. */
const turns = [];
let turnCount = 0;
let pendingApproval = null;

function journal(dir, payload) {
  if (!journalPath) return;
  appendFileSync(journalPath, `${JSON.stringify({at: new Date().toISOString(), dir, ...payload})}\n`);
}

function writeSessionState() {
  if (!statePath) return;
  writeFileSync(statePath, JSON.stringify({sessionId, projectId, cwd, turns}, null, 2));
}

function setTurnStatus(turnId, status) {
  const turn = turns.find((candidate) => candidate.turnId === turnId);
  if (turn !== undefined) turn.status = status;
  writeSessionState();
}

function send(message) {
  journal('out', {message});
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({id, result});
}

function respondError(id, method) {
  send({id, error: {code: -32601, message: `Method not found: ${method}`}});
}

function threadSnapshot() {
  return {
    id: threadId,
    sessionId: threadId,
    cliVersion: CLI_VERSION,
    createdAt: 1_757_661_600,
    updatedAt: 1_757_661_600,
    cwd,
    ephemeral: false,
    modelProvider: 'openai',
    preview: 'H04 fixture thread',
    projectId,
    source: 'appServer',
    status: {type: 'idle'},
    turns: turns.map((turn) => turnSnapshot(turn.turnId, turn.status)),
  };
}

function turnSnapshot(turnId, status) {
  return {id: turnId, items: [], status};
}

function commandItem(turnId) {
  return {
    type: 'commandExecution',
    id: `item-${turnId}-command`,
    command: 'cat fixtures/harness/recovery/readonly-task.txt',
    commandActions: [],
    cwd,
    status: 'inProgress',
  };
}

function agentMessageItem(turnId, text) {
  return {type: 'agentMessage', id: `item-${turnId}-message`, text};
}

function turnStarted(turnId) {
  send({method: 'turn/started', params: {threadId, turn: turnSnapshot(turnId, 'inProgress')}});
}

function itemStarted(turnId, item) {
  send({method: 'item/started', params: {threadId, turnId, startedAtMs: 1_757_661_600_000, item}});
}

function itemCompleted(turnId, item) {
  send({method: 'item/completed', params: {threadId, turnId, completedAtMs: 1_757_661_600_500, item}});
}

function turnCompleted(turnId, status) {
  send({method: 'turn/completed', params: {threadId, turn: turnSnapshot(turnId, status)}});
}

function instructionOf(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  const first = input.find((entry) => entry !== null && typeof entry === 'object');
  return typeof first?.text === 'string' ? first.text : '';
}

function startTurn(id, params) {
  turnCount += 1;
  const turnId = `${threadId}-turn-${turnCount}`;
  const instruction = instructionOf(params);
  journal('lifecycle', {event: 'turn-received', turnId, instruction});
  turns.push({turnId, instruction, status: 'in_progress'});
  writeSessionState();

  if (scenario === 'drop-ack') {
    journal('lifecycle', {event: 'ack-dropped', turnId});
    // The request reached the harness; the connection is lost before the acknowledgment.
    process.exit(0);
  }

  respond(id, {turn: turnSnapshot(turnId, 'inProgress')});
  turnStarted(turnId);

  if (scenario === 'approval') {
    itemStarted(turnId, commandItem(turnId));
    pendingApproval = {turnId};
    send({
      id: APPROVAL_REQUEST_ID,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId,
        turnId,
        itemId: `item-${turnId}-command`,
        startedAtMs: 1_757_661_600_000,
        approvalId: null,
        kind: 'command',
        command: 'echo H04-APPROVAL > fixtures/harness/recovery/approval-artifact.txt',
        cwd,
        reason: 'H04 fixture approval gate',
      },
    });
    return;
  }

  itemStarted(turnId, commandItem(turnId));
  itemCompleted(turnId, {...commandItem(turnId), status: 'completed', exitCode: 0, durationMs: 11, aggregatedOutput: 'H04-READONLY-FIXTURE-OUTPUT\n'});
  itemCompleted(turnId, agentMessageItem(turnId, `H04 fixture: the session executed "${instruction}".`));
  setTurnStatus(turnId, 'completed');
  turnCompleted(turnId, 'completed');
}

function resolveApproval(message) {
  if (pendingApproval === null) return;
  const decision = message.result?.decision;
  const {turnId} = pendingApproval;
  pendingApproval = null;
  if (decision === 'accept' || decision === 'acceptForSession') {
    itemCompleted(turnId, {...commandItem(turnId), status: 'completed', exitCode: 0, durationMs: 9, aggregatedOutput: 'H04-APPROVAL-EXECUTED\n'});
    itemCompleted(turnId, agentMessageItem(turnId, 'H04 fixture: approved command completed.'));
    setTurnStatus(turnId, 'completed');
    turnCompleted(turnId, 'completed');
    return;
  }
  if (decision === 'decline' || decision === 'cancel') {
    itemCompleted(turnId, {...commandItem(turnId), status: 'declined'});
    itemCompleted(turnId, agentMessageItem(turnId, 'H04 fixture: approval was not granted, so nothing ran.'));
    setTurnStatus(turnId, 'failed');
    turnCompleted(turnId, 'completed');
    return;
  }
  journal('lifecycle', {event: 'unexpected-approval-decision', decision: decision ?? null});
}

function handle(message) {
  if (typeof message?.method === 'string') {
    const {id, method, params} = message;
    if (id === undefined) return; // Client notification (`initialized`).
    switch (method) {
      case 'initialize':
        respond(id, {
          userAgent: `codex-cli/${CLI_VERSION}`,
          codexHome: statePath ?? '/tmp/h04-fixture-codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        });
        return;
      case 'thread/start':
        respond(id, {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          cwd,
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          sandbox: {type: 'readOnly'},
          thread: threadSnapshot(),
        });
        send({method: 'thread/started', params: {thread: threadSnapshot()}});
        return;
      case 'thread/resume':
        respond(id, {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          cwd,
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          sandbox: {type: 'readOnly'},
          thread: threadSnapshot(),
        });
        return;
      case 'turn/start':
        startTurn(id, params);
        return;
      case 'turn/interrupt': {
        respond(id, {});
        const turnId = typeof params?.turnId === 'string' ? params.turnId : `${threadId}-turn-1`;
        setTurnStatus(turnId, 'interrupted');
        turnCompleted(turnId, 'interrupted');
        return;
      }
      default:
        respondError(id, method);
    }
    return;
  }
  if (message !== null && typeof message === 'object' && 'id' in message && ('result' in message || 'error' in message)) {
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
      journal('lifecycle', {event: 'unparsable-line', line: line.slice(0, 200)});
      continue;
    }
    journal('in', {message});
    try {
      handle(message);
    } catch (error) {
      journal('lifecycle', {event: 'handler-error', message: String(error)});
    }
  }
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  journal('lifecycle', {event: 'shutdown', reason});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.stdin.on('end', () => shutdown('stdin-end'));
process.stdin.on('close', () => shutdown('stdin-close'));
