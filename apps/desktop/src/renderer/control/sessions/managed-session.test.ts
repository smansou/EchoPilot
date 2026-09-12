import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope, Scope } from '../../../../../../packages/contracts/src/index.js';
import {
  applyApprovalDecision,
  applySessionEvent,
  initialSessionView,
  markSessionClosed,
} from './managed-session.js';

const SCOPE: Scope = { profileId: 'h01-profile', worktreeId: 'h01', sensitivity: 'normal' };

function envelope(overrides: Partial<EventEnvelope> & Pick<EventEnvelope, 'kind'>): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    sourceId: 'codex-app-server:fixture',
    sourceEventId: 'source-1',
    sourceSequence: 1,
    ingestSequence: 1,
    occurredAt: '2026-09-12T10:00:00.000Z',
    observedAt: '2026-09-12T10:00:00.001Z',
    scope: { ...SCOPE, sessionId: 'thread-1' },
    payloadRef: 'codex-app-server://fixture/thread/thread-1/item/item-cmd-1/started',
    contentHash: 'abc',
    trust: 'tool_observed',
    ...overrides,
  } as EventEnvelope;
}

test('tool start/completion pair into one UI row and message content stays a reference', () => {
  let view = initialSessionView(SCOPE);
  view = applySessionEvent(view, envelope({ kind: 'tool_started', turnId: 'turn-1' }));
  view = applySessionEvent(view, envelope({
    kind: 'tool_completed',
    eventId: 'event-2',
    sourceSequence: 2,
    payloadRef: 'codex-app-server://fixture/thread/thread-1/item/item-cmd-1/completed',
  }));
  view = applySessionEvent(view, envelope({
    kind: 'agent_message',
    eventId: 'event-3',
    sourceSequence: 3,
    trust: 'agent_reported',
    payloadRef: 'codex-app-server://fixture/thread/thread-1/item/item-msg-1/message',
  }));

  assert.equal(view.tools.length, 1);
  assert.equal(view.tools[0]?.phase, 'completed');
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0]?.payloadRef.includes('item-msg-1'), true);
  assert.equal(JSON.stringify(view).includes('hidden reasoning'), false);
});

test('an approval stays pending across stream activity and companion failure until an authorized decision', () => {
  let view = initialSessionView(SCOPE);
  view = applySessionEvent(view, envelope({
    kind: 'approval_requested',
    sourceEventId: '7',
    turnId: 'turn-1',
    payloadRef: 'codex-app-server://fixture/thread/thread-1/approval/7',
  }));
  view = applySessionEvent(view, envelope({ kind: 'unsupported', eventId: 'event-2', sourceSequence: 2, unsupportedKind: 'future/telemetry' }));
  view = markSessionClosed(view);
  assert.equal(view.approval?.status, 'pending');
  assert.equal(view.unsupportedCount, 1);

  assert.throws(() => applyApprovalDecision(view, { requestId: '7', decision: 'approve', authorizedBy: ' ' }));
  assert.equal(applyApprovalDecision(view, { requestId: '8', decision: 'approve', authorizedBy: 'user' }), view);
  view = applyApprovalDecision(view, { requestId: '7', decision: 'deny', authorizedBy: 'user' });
  assert.equal(view.approval, null);
});

test('non-contract events are rejected instead of painted into the session view', () => {
  const view = initialSessionView(SCOPE);
  assert.throws(() => applySessionEvent(view, { kind: 'tool_started', schemaVersion: 2 }));
});
