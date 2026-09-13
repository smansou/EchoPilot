/**
 * S02 acceptance oracle — spoken action proposal → scoped authorization → receipt → audit UI
 * (IMPLEMENTATION_PLAN.md §5.9 "Action lifecycle"; BACKLOG S02).
 *
 * One deterministic leg per acceptance criterion:
 *   1. a valid scoped harness action executes exactly once; a stale grant version, changed
 *      arguments, or an expired confirmation never reaches the managed harness;
 *   2. a disconnect after send becomes `unknown` until it is reconciled, and no automatic resend
 *      produces a duplicate action;
 *   3. a spoken "yes" outside the bound confirmation state grants nothing, and the audit trail
 *      links proposal → authorization → dispatch → receipt.
 *
 * The managed harness is a recording double because no real Codex/Claude session may be started
 * in automated qualification; the adapter leg itself is covered by the H01/H02 oracles. The clock
 * is injected so the 30-second confirmation window is exercised without waiting.
 *
 * Frozen seam (this file pins these names; the renderer view over the same audit records is pinned
 * in apps/desktop/src/renderer/control/permissions/s02.permission-history.test.ts):
 *
 * packages/security/src/broker/index.ts
 *   export const CONFIRMATION_TTL_MS = 30_000
 *     §5.9: authorization binds `… a 30-second confirmation expiry when confirmation is needed`.
 *
 *   export function createActionBroker({ harness, outbox, now }) → ActionBroker
 *     harness  the managed harness execution target (contracts HarnessAdapter.send):
 *              send(instruction, deliveryId) → { deliveryId, status: 'acknowledged'|'unsupported' }
 *     outbox   packages/core/src/outbox DeliveryOutbox: a delivery is prepared/recorded there
 *              before any send, so a lost receipt is durable evidence rather than a lost fact.
 *     now      () => Date, default () => new Date()
 *
 *     grantCapability(grant) → { grantId, version }
 *       grant = { subject, capability, resource, dataCategory, destination, effect, lifetime }
 *       — §5.9 permission tuple; lifetime ∈ 'once' | 'session' | 'durable'.
 *     revokeCapability({ grantId, reason }) → { grantId, grantVersion }
 *       — versioned revocation; grantVersion is greater than the granted version.
 *     propose(request: contracts.ActionRequest) → ProposalResult
 *       { proposalId, actionId, state: 'proposed'|'authorized', argumentHash,
 *         authorizationId?, confirmationId?, confirmationExpiresAt? }
 *       A 'read'/'local_write' action with a matching grant authorizes immediately; an
 *       'external'/'destructive' action stays 'proposed' behind a fresh confirmationId that
 *       expires CONFIRMATION_TTL_MS after this instant.
 *     confirmByVoice({ confirmationId, utteranceId, text }) → ConfirmationOutcome
 *       { confirmationId, authorized, reason?: 'unbound'|'expired'|'declined'|'not_affirmative',
 *         authorizationId? }
 *       Only an affirmative transcript (at least 'yes', case-insensitive, trailing punctuation
 *       ignored) bound to a pending, unexpired confirmation id mints an authorization. Every other
 *       case returns authorized: false and mints nothing; nothing throws for an unbound id.
 *     dispatch(request: contracts.ActionRequest) → DispatchOutcome
 *       { actionId, state: 'verified'|'failed'|'unknown'|'denied', reason?,
 *         authorizationId?, deliveryId?, receiptId? }
 *       Immediately before execution it re-checks the argument hash bound at authorization, the
 *       current grant version/status, and the confirmation window; then it hands the instruction
 *       to harness.send exactly once per idempotencyKey. A harness rejection after the instruction
 *       was accepted yields 'unknown' — never 'verified', and never an automatic resend.
 *     reconcile({ deliveryId, observed: 'acknowledged'|'failed' }) → DispatchOutcome
 *       Resolves an 'unknown' delivery from observed harness evidence without a new send.
 *     pendingReconciliation() → ReadonlyArray<{ actionId, deliveryId }>
 *     auditEntries() → ReadonlyArray<AuditEntry>
 *       AuditEntry = { entryId, kind, actionId?, proposalId?, authorizationId?, dispatchId?,
 *                      deliveryId?, receiptId?, grantId?, grantVersion?, argumentHash?, status?,
 *                      reason?, at }
 *       kind ∈ 'proposal'|'authorization'|'dispatch'|'receipt'|'denial'|'revocation'; one executed
 *       action records exactly one proposal (with the argument hash), one authorization (linking
 *       proposalId, grantId and grantVersion), one dispatch (linking authorizationId and
 *       deliveryId) and one receipt (linking dispatchId, deliveryId and its harness status).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActionRequest, Scope } from '../../../contracts/src/index.js';

/** Deterministic clock so the confirmation window needs no real waiting. */
function fakeClock(start: string): { now: () => Date; advance: (milliseconds: number) => void } {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

type HarnessDeliveryReceipt = Readonly<{ deliveryId: string; status: 'acknowledged' | 'unsupported' }>;

type RecordingHarness = Readonly<{
  calls: ReadonlyArray<Readonly<{ instruction: string; deliveryId: string }>>;
  send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
}>;

/** Records every send before deciding whether the receipt survives the transport. */
function recordingHarness(options: { disconnectAfterSend?: boolean } = {}): RecordingHarness {
  const calls: Array<{ instruction: string; deliveryId: string }> = [];
  return {
    calls,
    async send(instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> {
      calls.push({ instruction, deliveryId });
      if (options.disconnectAfterSend === true) {
        throw Object.assign(new Error('harness transport closed after the instruction was accepted'), {
          code: 'HARNESS_DISCONNECT',
        });
      }
      return { deliveryId, status: 'acknowledged' };
    },
  };
}

type DeliveryRecord = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  actionId: string;
  state: 'prepared' | 'sent' | 'acknowledged' | 'completed' | 'failed' | 'unknown';
  updatedAt: string;
  reason?: string;
}>;

type DeliveryOutbox = {
  prepare(input: { deliveryId: string; idempotencyKey: string; actionId: string }): DeliveryRecord;
  markSent(deliveryId: string): DeliveryRecord;
  markUnknown(deliveryId: string, reason: string): DeliveryRecord;
  resolve(input: { deliveryId: string; state: 'acknowledged' | 'completed' | 'failed'; reason?: string }): DeliveryRecord;
  get(deliveryId: string): DeliveryRecord | undefined;
  getByIdempotencyKey(idempotencyKey: string): DeliveryRecord | undefined;
  resendable(): ReadonlyArray<DeliveryRecord>;
  all(): ReadonlyArray<DeliveryRecord>;
};

type GrantInput = Readonly<{
  subject: string;
  capability: string;
  resource: Readonly<Record<string, string>>;
  dataCategory: string;
  destination: string;
  effect: ActionRequest['effect'];
  lifetime: 'once' | 'session' | 'durable';
}>;

type ProposalResult = Readonly<{
  proposalId: string;
  actionId: string;
  state: 'proposed' | 'authorized';
  argumentHash: string;
  authorizationId?: string;
  confirmationId?: string;
  confirmationExpiresAt?: string;
}>;

type ConfirmationOutcome = Readonly<{
  confirmationId: string;
  authorized: boolean;
  reason?: 'unbound' | 'expired' | 'declined' | 'not_affirmative';
  authorizationId?: string;
}>;

type DispatchOutcome = Readonly<{
  actionId: string;
  state: 'verified' | 'failed' | 'unknown' | 'denied';
  reason?: string;
  authorizationId?: string;
  deliveryId?: string;
  receiptId?: string;
}>;

type AuditEntry = Readonly<{
  entryId: string;
  kind: 'proposal' | 'authorization' | 'confirmation' | 'dispatch' | 'receipt' | 'denial' | 'revocation';
  at: string;
  actionId?: string;
  proposalId?: string;
  authorizationId?: string;
  dispatchId?: string;
  deliveryId?: string;
  receiptId?: string;
  grantId?: string;
  grantVersion?: number;
  argumentHash?: string;
  status?: 'acknowledged' | 'completed' | 'failed' | 'unknown';
  reason?: string;
}>;

type PendingReconciliation = Readonly<{ actionId: string; deliveryId: string }>;

type ActionBroker = {
  grantCapability(input: GrantInput): Promise<{ grantId: string; version: number }>;
  revokeCapability(input: { grantId: string; reason: string }): Promise<{ grantId: string; grantVersion: number }>;
  propose(request: ActionRequest): Promise<ProposalResult>;
  confirmByVoice(input: { confirmationId: string; utteranceId: string; text: string }): Promise<ConfirmationOutcome>;
  dispatch(request: ActionRequest): Promise<DispatchOutcome>;
  reconcile(input: { deliveryId: string; observed: 'acknowledged' | 'failed' }): Promise<DispatchOutcome>;
  pendingReconciliation(): ReadonlyArray<PendingReconciliation>;
  auditEntries(): ReadonlyArray<AuditEntry>;
};

type CreateActionBroker = (options: Readonly<{
  harness: Pick<RecordingHarness, 'send'>;
  outbox: DeliveryOutbox;
  now?: () => Date;
}>) => ActionBroker;

type BrokerModule = Readonly<{ createActionBroker: CreateActionBroker; CONFIRMATION_TTL_MS: number }>;

/** Loads the yet-to-be-implemented broker, turning "module missing" into a named red failure. */
async function loadBroker(): Promise<BrokerModule> {
  try {
    return (await import('./index.js')) as unknown as BrokerModule;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/security/src/broker/index.ts must export '
        + 'createActionBroker() and CONFIRMATION_TTL_MS so a spoken action proposal can be proposed, '
        + 'confirmed, authorized, dispatched once to the managed harness, receipted, and audited. '
        + `Underlying error: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

/** Loads the yet-to-be-implemented delivery outbox, turning "module missing" into a red failure. */
async function loadOutbox(): Promise<Readonly<{ createDeliveryOutbox: (options?: { now?: () => Date }) => DeliveryOutbox }>> {
  try {
    return (await import('../../../core/src/outbox/index.js')) as unknown as Readonly<{
      createDeliveryOutbox: (options?: { now?: () => Date }) => DeliveryOutbox;
    }>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/core/src/outbox/index.ts must export '
        + 'createDeliveryOutbox() so dispatch can durably record a delivery before send, keep a lost '
        + 'receipt unknown until it is reconciled, and never resend it automatically. '
        + `Underlying error: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

const SCOPE: Scope = {
  profileId: 's02-profile',
  projectId: 'echopilot',
  worktreeId: 'S02',
  sessionId: 'codex-parser',
  sensitivity: 'normal',
};

function sessionGrant(lifetime: 'once' | 'session' | 'durable' = 'session'): GrantInput {
  return {
    subject: 'user',
    capability: 'harness.send',
    resource: { sessionId: 'codex-parser', worktreeId: 'S02' },
    dataCategory: 'normal',
    destination: 'managed-harness',
    effect: 'external',
    lifetime,
  };
}

function harnessRequest(input: {
  grantId: string;
  actionId?: string;
  idempotencyKey?: string;
  instruction?: string;
}): ActionRequest {
  const actionId = input.actionId ?? 'action-run-parser-tests';
  return {
    actionId,
    idempotencyKey: input.idempotencyKey ?? `idem-${actionId}`,
    scope: { ...SCOPE },
    tool: 'harness.send',
    arguments: { sessionId: 'codex-parser', instruction: input.instruction ?? 'Run the parser test suite' },
    evidenceIds: [`utt-${actionId}`],
    effect: 'external',
    targetFromGaze: false,
    grantId: input.grantId,
  };
}

async function brokerFixture(options: { disconnectAfterSend?: boolean } = {}): Promise<Readonly<{
  CONFIRMATION_TTL_MS: number;
  clock: ReturnType<typeof fakeClock>;
  harness: RecordingHarness;
  outbox: DeliveryOutbox;
  broker: ActionBroker;
}>> {
  const { createActionBroker, CONFIRMATION_TTL_MS } = await loadBroker();
  const { createDeliveryOutbox } = await loadOutbox();
  const clock = fakeClock('2026-09-13T09:00:00.000Z');
  const harness = recordingHarness(options.disconnectAfterSend === true ? { disconnectAfterSend: true } : {});
  const outbox = createDeliveryOutbox({ now: clock.now });
  const broker = createActionBroker({ harness, outbox, now: clock.now });
  return { CONFIRMATION_TTL_MS, clock, harness, outbox, broker };
}

test('a valid scoped harness action executes exactly once and the audit links proposal, authorization, dispatch, and receipt', async () => {
  const { CONFIRMATION_TTL_MS, clock, harness, outbox, broker } = await brokerFixture();
  assert.equal(CONFIRMATION_TTL_MS, 30_000, 'IMPLEMENTATION_PLAN.md §5.9 pins a 30-second confirmation expiry');

  const grant = await broker.grantCapability(sessionGrant());
  assert.ok(grant.grantId.length > 0, 'grantCapability mints a grant id');
  assert.ok(grant.version >= 1, 'a grant carries a version');

  const request = harnessRequest({ grantId: grant.grantId });
  const proposal = await broker.propose(request);
  assert.equal(proposal.state, 'proposed', 'an external effect is not authorized before a fresh confirmation');
  const confirmationId = proposal.confirmationId;
  assert.ok(confirmationId, 'proposing an external effect opens a bound confirmation');
  assert.equal(
    proposal.confirmationExpiresAt,
    new Date(clock.now().getTime() + CONFIRMATION_TTL_MS).toISOString(),
    'the confirmation expires CONFIRMATION_TTL_MS after the proposal',
  );

  const voice = await broker.confirmByVoice({ confirmationId, utteranceId: 'utt-s02-yes', text: 'Yes.' });
  assert.equal(voice.authorized, true, 'an affirmative bound to the pending confirmation authorizes it');

  const authorized: ActionRequest = { ...request, confirmationId };
  const first = await broker.dispatch(authorized);
  assert.equal(first.state, 'verified');
  assert.equal(harness.calls.length, 1, 'the valid scoped action executes exactly once');
  assert.equal(harness.calls[0]?.instruction, 'Run the parser test suite');
  const deliveryId = first.deliveryId;
  assert.ok(deliveryId, 'the dispatch returns the delivery it recorded');
  assert.equal(harness.calls[0]?.deliveryId, deliveryId);

  const repeat = await broker.dispatch(authorized);
  assert.equal(harness.calls.length, 1, 'dispatching the same idempotency key again must not execute twice');
  assert.equal(repeat.state, 'verified');
  assert.equal(repeat.deliveryId, deliveryId);

  const forAction = broker.auditEntries().filter((entry) => entry.actionId === request.actionId);
  const proposals = forAction.filter((entry) => entry.kind === 'proposal');
  const authorizations = forAction.filter((entry) => entry.kind === 'authorization');
  const dispatches = forAction.filter((entry) => entry.kind === 'dispatch');
  const receipts = forAction.filter((entry) => entry.kind === 'receipt');
  assert.equal(proposals.length, 1, 'one proposal is audited');
  assert.equal(authorizations.length, 1, 'one authorization is audited');
  assert.equal(dispatches.length, 1, 'the idempotent replay is not a second dispatch');
  assert.equal(receipts.length, 1, 'one receipt is audited');

  const proposalEntry = proposals[0];
  const authorizationEntry = authorizations[0];
  const dispatchEntry = dispatches[0];
  const receiptEntry = receipts[0];
  assert.ok(proposalEntry && authorizationEntry && dispatchEntry && receiptEntry);

  assert.equal(proposalEntry.proposalId, proposal.proposalId);
  assert.ok(proposalEntry.argumentHash && proposalEntry.argumentHash.length > 0, 'the proposal binds an argument hash');
  assert.equal(authorizationEntry.proposalId, proposal.proposalId, 'authorization links the proposal');
  assert.equal(authorizationEntry.grantId, grant.grantId);
  assert.equal(authorizationEntry.grantVersion, grant.version, 'authorization binds the grant version');
  assert.equal(authorizationEntry.authorizationId, voice.authorizationId);
  assert.equal(first.authorizationId, authorizationEntry.authorizationId);
  assert.equal(dispatchEntry.authorizationId, authorizationEntry.authorizationId, 'dispatch links the authorization');
  assert.equal(dispatchEntry.deliveryId, deliveryId);
  assert.equal(receiptEntry.dispatchId, dispatchEntry.dispatchId, 'receipt links the dispatch');
  assert.equal(receiptEntry.deliveryId, deliveryId, 'receipt links the delivery');
  assert.equal(receiptEntry.status, 'acknowledged');
  assert.equal(outbox.get(deliveryId)?.state, 'acknowledged');
});

test('a stale grant version does not execute', async () => {
  const { harness, broker } = await brokerFixture();
  const grant = await broker.grantCapability(sessionGrant());
  const request = harnessRequest({ grantId: grant.grantId });
  const proposal = await broker.propose(request);
  const confirmationId = proposal.confirmationId;
  assert.ok(confirmationId);
  const voice = await broker.confirmByVoice({ confirmationId, utteranceId: 'utt-s02-stale', text: 'yes' });
  assert.equal(voice.authorized, true);

  const revoked = await broker.revokeCapability({ grantId: grant.grantId, reason: 'the user revoked the session grant' });
  assert.ok(revoked.grantVersion > grant.version, 'revocation publishes a new grant version');

  const outcome = await broker.dispatch({ ...request, confirmationId });
  assert.equal(outcome.state, 'denied');
  assert.equal(harness.calls.length, 0, 'a stale grant version never reaches the managed harness');
  assert.ok((outcome.reason ?? '').length > 0, 'the denial explains why nothing executed');
});

test('changed arguments after authorization do not execute', async () => {
  const { harness, broker } = await brokerFixture();
  const grant = await broker.grantCapability(sessionGrant());
  const request = harnessRequest({ grantId: grant.grantId });
  const proposal = await broker.propose(request);
  const confirmationId = proposal.confirmationId;
  assert.ok(confirmationId);
  const voice = await broker.confirmByVoice({ confirmationId, utteranceId: 'utt-s02-changed', text: 'yes' });
  assert.equal(voice.authorized, true);

  const tampered: ActionRequest = {
    ...request,
    confirmationId,
    arguments: { sessionId: 'codex-parser', instruction: 'Delete the production workspace' },
  };
  const outcome = await broker.dispatch(tampered);
  assert.equal(outcome.state, 'denied');
  assert.equal(harness.calls.length, 0, 'arguments that do not match the authorized hash never execute');
  assert.equal(
    broker.auditEntries().filter((entry) => entry.kind === 'dispatch' && entry.actionId === request.actionId).length,
    0,
    'a mismatch never becomes a dispatch',
  );
});

test('an expired confirmation does not execute', async () => {
  const { CONFIRMATION_TTL_MS, clock, harness, broker } = await brokerFixture();
  const grant = await broker.grantCapability(sessionGrant());
  const request = harnessRequest({ grantId: grant.grantId });
  const proposal = await broker.propose(request);
  const confirmationId = proposal.confirmationId;
  assert.ok(confirmationId);

  clock.advance(CONFIRMATION_TTL_MS + 1);
  const outcome = await broker.dispatch({ ...request, confirmationId });
  assert.equal(outcome.state, 'denied');
  assert.equal(harness.calls.length, 0, 'a confirmation past its expiry never reaches the managed harness');
});

test('a disconnect after send becomes unknown until reconciled, and no automatic resend duplicates the action', async () => {
  const { harness, outbox, broker } = await brokerFixture({ disconnectAfterSend: true });
  const grant = await broker.grantCapability(sessionGrant());
  const request = harnessRequest({ grantId: grant.grantId });
  const proposal = await broker.propose(request);
  const confirmationId = proposal.confirmationId;
  assert.ok(confirmationId);
  const voice = await broker.confirmByVoice({ confirmationId, utteranceId: 'utt-s02-disconnect', text: 'yes' });
  assert.equal(voice.authorized, true);
  const authorized: ActionRequest = { ...request, confirmationId };

  const dispatched = await broker.dispatch(authorized);
  assert.equal(dispatched.state, 'unknown', 'a lost receipt is unknown, never verified');
  assert.equal(harness.calls.length, 1);
  const deliveryId = dispatched.deliveryId;
  assert.ok(deliveryId, 'the unknown delivery is still recorded');
  assert.equal(outbox.get(deliveryId)?.state, 'unknown');
  assert.deepEqual(outbox.resendable(), [], 'an automatic sender must not pick up the unknown delivery');

  const retried = await broker.dispatch(authorized);
  assert.equal(harness.calls.length, 1, 're-dispatching an unknown delivery must not resend it');
  assert.equal(retried.state, 'unknown');

  const pending = broker.pendingReconciliation();
  assert.deepEqual(pending.map((entry) => entry.deliveryId), [deliveryId], 'the unknown delivery awaits reconciliation');

  const reconciled = await broker.reconcile({ deliveryId, observed: 'acknowledged' });
  assert.equal(reconciled.state, 'verified');
  assert.equal(harness.calls.length, 1, 'reconciliation uses observation, not a resend');
  assert.equal(outbox.get(deliveryId)?.state, 'acknowledged');
  assert.deepEqual(broker.pendingReconciliation(), []);
});

test("voice 'yes' outside the bound confirmation state cannot grant permission", async () => {
  const { CONFIRMATION_TTL_MS, clock, harness, broker } = await brokerFixture();
  const grant = await broker.grantCapability(sessionGrant());
  const requestA = harnessRequest({
    grantId: grant.grantId,
    actionId: 'action-a',
    idempotencyKey: 'idem-a',
    instruction: 'Run suite A',
  });
  const requestB = harnessRequest({
    grantId: grant.grantId,
    actionId: 'action-b',
    idempotencyKey: 'idem-b',
    instruction: 'Run suite B',
  });
  const proposalA = await broker.propose(requestA);
  const confirmationA = proposalA.confirmationId;
  assert.ok(confirmationA);
  const proposalB = await broker.propose(requestB);
  const confirmationB = proposalB.confirmationId;
  assert.ok(confirmationB);

  const unbound = await broker.confirmByVoice({
    confirmationId: 'confirmation-never-issued',
    utteranceId: 'utt-unbound',
    text: 'yes',
  });
  assert.equal(unbound.authorized, false, "a 'yes' with no bound confirmation grants nothing");
  assert.equal(unbound.reason, 'unbound');

  const boundToB = await broker.confirmByVoice({ confirmationId: confirmationB, utteranceId: 'utt-b', text: 'yes' });
  assert.equal(boundToB.authorized, true, 'the bound confirmation for B accepts its own yes');

  const deniedA = await broker.dispatch({ ...requestA, confirmationId: confirmationA });
  assert.equal(deniedA.state, 'denied', "a yes bound to B's confirmation cannot authorize A");
  assert.equal(harness.calls.length, 0);

  const executedB = await broker.dispatch({ ...requestB, confirmationId: confirmationB });
  assert.equal(executedB.state, 'verified');
  assert.equal(harness.calls.length, 1);

  const requestC = harnessRequest({
    grantId: grant.grantId,
    actionId: 'action-c',
    idempotencyKey: 'idem-c',
    instruction: 'Run suite C',
  });
  const proposalC = await broker.propose(requestC);
  const confirmationC = proposalC.confirmationId;
  assert.ok(confirmationC);
  clock.advance(CONFIRMATION_TTL_MS + 1);
  const expired = await broker.confirmByVoice({ confirmationId: confirmationC, utteranceId: 'utt-c', text: 'yes' });
  assert.equal(expired.authorized, false, 'an expired confirmation window cannot be reopened by voice');
  assert.equal(expired.reason, 'expired');

  const deniedC = await broker.dispatch({ ...requestC, confirmationId: confirmationC });
  assert.equal(deniedC.state, 'denied');
  assert.equal(harness.calls.length, 1, 'nothing executes outside the bound, unexpired confirmation');

  const unauthorized = broker
    .auditEntries()
    .filter((entry) => entry.kind === 'authorization' && (entry.actionId === requestA.actionId || entry.actionId === requestC.actionId));
  assert.deepEqual(unauthorized, [], 'no authorization is minted outside the bound, unexpired confirmation');
});
