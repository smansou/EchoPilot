/**
 * Focused behavior tests for the addressee router (plan §5.6/§5.7). The frozen R01 acceptance
 * oracle pins the held-out corpus; this file documents the decisions around it: which phrase
 * resolves to which session, what stays local, and which utterances can never act.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_DISPATCH_MIN_CONFIDENCE,
  createAddresseeRouter,
  type AddresseeRouter,
  type ManagedSession,
  type RoutingDecision,
} from '../src/index.js';

const SESSIONS: ReadonlyArray<ManagedSession> = [
  { sessionId: 'codex-parser', harness: 'codex', label: 'Codex: parser', projectId: 'atlas', active: true },
  { sessionId: 'codex-tests', harness: 'codex', label: 'Codex: tests', projectId: 'atlas', active: true },
  { sessionId: 'claude-docs', harness: 'claude', label: 'Claude: docs', projectId: 'atlas', active: true },
  { sessionId: 'claude-review', harness: 'claude', label: 'Claude: review', projectId: 'atlas', active: true },
];

function router(sessions: ReadonlyArray<ManagedSession> = SESSIONS): AddresseeRouter {
  return createAddresseeRouter({ sessions });
}

function route(
  subject: AddresseeRouter,
  text: string,
  options: Readonly<{ asrConfidence?: number; partial?: boolean }> = {},
): RoutingDecision {
  return subject.route({
    utteranceId: `test:${text}`,
    text,
    ...(options.asrConfidence === undefined ? {} : { asrConfidence: options.asrConfidence }),
    ...(options.partial === undefined ? {} : { partial: options.partial }),
  });
}

function assertDispatchesTo(decision: RoutingDecision, sessionId: string): void {
  assert.equal(decision.destination, 'harness');
  assert.equal(decision.targetSessionId, sessionId);
  assert.equal(decision.requiresClarification, false);
  assert.equal(decision.basis, 'explicit_prefix');
  assert.ok(
    decision.confidence >= AUTO_DISPATCH_MIN_CONFIDENCE,
    `auto-dispatch must clear ${AUTO_DISPATCH_MIN_CONFIDENCE}, got ${decision.confidence}`,
  );
}

function assertClarifies(decision: RoutingDecision, candidates: ReadonlyArray<string>): void {
  assert.equal(decision.requiresClarification, true);
  assert.equal(decision.targetSessionId, undefined);
  assert.ok(decision.confidence < AUTO_DISPATCH_MIN_CONFIDENCE);
  assert.deepEqual([...(decision.candidates ?? [])].sort(), [...candidates].sort());
}

test('resolves a session by label, id, and the "the … session" form', () => {
  const subject = router();
  assertDispatchesTo(route(subject, 'tell codex parser to add a regression test'), 'codex-parser');
  assertDispatchesTo(route(subject, 'ask the claude review session to update the changelog'), 'claude-review');
  assertDispatchesTo(route(subject, 'tell codex-tests to bump the lockfile'), 'codex-tests');
  assertDispatchesTo(route(subject, 'please ask claude docs to summarize the failing build'), 'claude-docs');
});

test('resolves a bare harness name only when exactly one session of it is active', () => {
  const subject = router();
  assertClarifies(route(subject, 'tell codex to rerun the failing parser test'), ['codex-parser', 'codex-tests']);

  subject.setActiveSessions(SESSIONS.map((session) => session.sessionId === 'codex-tests' ? { ...session, active: false } : session));
  assertDispatchesTo(route(subject, 'tell codex to rerun the failing parser test', { asrConfidence: 0.97 }), 'codex-parser');
});

test('never reads the task clause for a destination', () => {
  assertDispatchesTo(route(router(), 'tell codex tests to rerun the failing parser test'), 'codex-tests');
  assertDispatchesTo(route(router(), 'ask claude review to document the codex migration'), 'claude-review');
});

test('clarifies when the destination is not unique or not a session', () => {
  const subject = router();
  assertClarifies(route(subject, 'tell codex parser and codex tests to run the full test suite'), ['codex-parser', 'codex-tests']);
  assertClarifies(route(subject, 'tell both claude sessions to review the migration diff'), ['claude-docs', 'claude-review']);
  assertClarifies(route(subject, 'tell the other codex to run the full test suite'), ['codex-parser', 'codex-tests']);
  assertClarifies(route(subject, 'tell the session to add a regression test'), ['codex-parser', 'codex-tests', 'claude-docs', 'claude-review']);
  assertClarifies(route(subject, 'tell it to add a regression test'), ['codex-parser', 'codex-tests', 'claude-docs', 'claude-review']);
  assertClarifies(route(subject, 'message the coding agent to add a regression test'), ['codex-parser', 'codex-tests', 'claude-docs', 'claude-review']);
  assertClarifies(route(subject, 'send that to codex'), ['codex-parser', 'codex-tests']);
  assertClarifies(route(subject, 'tell codex parser to'), ['codex-parser']);
});

test('partial ASR and ambient acknowledgments are held, never dispatched', () => {
  const subject = router();
  for (const text of ['tell codex parser to add a regression test', 'tell codex parser to add a regress']) {
    const decision = route(subject, text, { partial: true, asrConfidence: 0.93 });
    assert.equal(decision.hold, 'partial_asr');
    assert.equal(decision.destination, 'companion');
    assert.equal(decision.requiresClarification, false);
    assert.equal(decision.targetSessionId, undefined);
    assert.ok(decision.confidence < AUTO_DISPATCH_MIN_CONFIDENCE);
  }
  for (const text of ['yes', 'yeah', 'okay', 'mm-hm', 'go ahead', 'do it']) {
    const decision = route(subject, text, { asrConfidence: 0.95 });
    assert.equal(decision.hold, 'ambient_acknowledgment', `"${text}" must be held`);
    assert.equal(decision.destination, 'companion');
    assert.equal(decision.requiresClarification, false);
    assert.ok(decision.confidence < AUTO_DISPATCH_MIN_CONFIDENCE);
  }
});

test('an unambiguous instruction below the calibrated floor confirms instead of dispatching', () => {
  const decision = route(router(), 'tell codex parser to add a regression test', { asrConfidence: 0.9 });
  assertClarifies(decision, ['codex-parser']);
  assert.ok(decision.confidence <= 0.9);
});

test('questions stay with the companion even when they mention a session', () => {
  const subject = router();
  for (const text of ['what happened in the last session?', 'what did codex do?', 'did the tests pass?', 'echo, what changed in the parser?']) {
    const decision = route(subject, text);
    assert.equal(decision.destination, 'companion', `"${text}" must stay local`);
    assert.equal(decision.requiresClarification, false);
    assert.equal(decision.hold, undefined);
  }
});

test('explicit prefixes route without a spoken addressee', () => {
  const subject = router();
  assert.equal(route(subject, 'dictate: ship the migration note').destination, 'dictation');
  assert.equal(route(subject, 'companion: what changed?').destination, 'companion');
  assert.equal(route(subject, 'desktop: open the build log').destination, 'desktop');
  assert.equal(route(subject, 'control: stop listening').destination, 'control');
  assertDispatchesTo(route(subject, 'harness: codex parser add a regression test'), 'codex-parser');
  assert.equal(route(subject, 'harness: codex tell them to ship it').requiresClarification, true);
});

test('local dictation, desktop, and control intents never reach a session', () => {
  const subject = router();
  assert.equal(route(subject, 'type this into the migration note').destination, 'dictation');
  assert.equal(route(subject, 'insert the retry policy').destination, 'dictation');
  assert.equal(route(subject, 'open the parser diff').destination, 'desktop');
  assert.equal(route(subject, 'stop listening').destination, 'control');
  assert.equal(route(subject, 'never mind').destination, 'control');
});

test('every dispatch decision is explicit-prefix based and above the floor', () => {
  const subject = router();
  const decision = route(subject, 'tell claude docs to document the retry policy', { asrConfidence: 0.97 });
  assertDispatchesTo(decision, 'claude-docs');
  assert.equal(decision.confidence, 0.97);
});
