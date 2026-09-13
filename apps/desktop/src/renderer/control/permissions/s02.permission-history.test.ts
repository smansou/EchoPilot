/**
 * S02 audit-UI oracle — the permission history the renderer shows for the spoken-action path
 * (BACKLOG S02 acceptance criterion 3: "audit links proposal, authorization, dispatch, and
 * receipt").
 *
 * The renderer leg is a pure projection of the broker's audit entries, so the linkage the user
 * sees is verifiable without a DOM. Actual React rendering, keyboard order and VoiceOver remain
 * manual qualification; what this oracle freezes is the data the UI renders.
 *
 * Frozen seam — apps/desktop/src/renderer/control/permissions/index.ts
 *   export function buildPermissionHistory(entries) → ReadonlyArray<PermissionHistoryRow>
 *     entries — the security broker's audit entries: { entryId, kind, at, actionId?, proposalId?,
 *     authorizationId?, dispatchId?, deliveryId?, receiptId?, grantId?, status?, reason? };
 *     kind ∈ 'proposal'|'authorization'|'confirmation'|'dispatch'|'receipt'|'denial'|'revocation'.
 *     Rows are grouped by actionId in first-seen order:
 *       { actionId, proposalId?, authorizationId?, deliveryId?, receiptId?, state, dispatched,
 *         grantRevoked, entryIds }
 *       state ∈ 'proposed'|'awaiting_confirmation'|'authorized'|'dispatched'|'unknown'|'verified'
 *                |'failed'|'denied'
 *       dispatched — true once a dispatch entry exists: the external side effect can no longer be
 *         undone, so a later revocation must not erase it (S02 required judgment).
 *       grantRevoked — true when a revocation entry names the grantId of the row's authorization,
 *         even though that revocation entry carries no actionId of its own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type PermissionAuditEntry = Readonly<{
  entryId: string;
  kind: 'proposal' | 'authorization' | 'confirmation' | 'dispatch' | 'receipt' | 'denial' | 'revocation';
  at: string;
  actionId?: string;
  proposalId?: string;
  authorizationId?: string;
  dispatchId?: string;
  deliveryId?: string;
  receiptId?: string;
  confirmationId?: string;
  grantId?: string;
  grantVersion?: number;
  argumentHash?: string;
  status?: 'acknowledged' | 'completed' | 'failed' | 'unknown';
  reason?: string;
}>;

type PermissionHistoryRow = Readonly<{
  actionId: string;
  proposalId?: string;
  authorizationId?: string;
  deliveryId?: string;
  receiptId?: string;
  state:
    | 'proposed'
    | 'awaiting_confirmation'
    | 'authorized'
    | 'dispatched'
    | 'unknown'
    | 'verified'
    | 'failed'
    | 'denied';
  dispatched: boolean;
  grantRevoked: boolean;
  entryIds: ReadonlyArray<string>;
}>;

type PermissionsViewModule = Readonly<{
  buildPermissionHistory(entries: ReadonlyArray<PermissionAuditEntry>): ReadonlyArray<PermissionHistoryRow>;
}>;

/** Loads the yet-to-be-implemented view, turning "module missing" into a named red failure. */
async function loadPermissionsView(): Promise<PermissionsViewModule> {
  try {
    return (await import('./index.js')) as unknown as PermissionsViewModule;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: apps/desktop/src/renderer/control/permissions/index.ts must export '
        + 'buildPermissionHistory() so permission history links proposal → authorization → dispatch → '
        + 'receipt, shows an unresolved delivery as unknown, and keeps an executed external effect '
        + 'visible after a later revocation. '
        + `Underlying error: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

const AT = '2026-09-13T09:00:01.000Z';

function executedActionEntries(): PermissionAuditEntry[] {
  return [
    {
      entryId: 'audit-proposal-1',
      kind: 'proposal',
      at: AT,
      actionId: 'action-run-tests',
      proposalId: 'proposal-1',
      argumentHash: 'sha256:0001',
    },
    {
      entryId: 'audit-authorization-1',
      kind: 'authorization',
      at: AT,
      actionId: 'action-run-tests',
      proposalId: 'proposal-1',
      authorizationId: 'authorization-1',
      grantId: 'grant-1',
      grantVersion: 1,
    },
    {
      entryId: 'audit-dispatch-1',
      kind: 'dispatch',
      at: AT,
      actionId: 'action-run-tests',
      authorizationId: 'authorization-1',
      dispatchId: 'dispatch-1',
      deliveryId: 'delivery-1',
    },
    {
      entryId: 'audit-receipt-1',
      kind: 'receipt',
      at: AT,
      actionId: 'action-run-tests',
      dispatchId: 'dispatch-1',
      deliveryId: 'delivery-1',
      receiptId: 'receipt-1',
      status: 'acknowledged',
    },
  ];
}

test('an executed action renders one row linking proposal, authorization, dispatch, and receipt', async () => {
  const { buildPermissionHistory } = await loadPermissionsView();
  const rows = buildPermissionHistory(executedActionEntries());
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.actionId, 'action-run-tests');
  assert.equal(row.proposalId, 'proposal-1');
  assert.equal(row.authorizationId, 'authorization-1');
  assert.equal(row.deliveryId, 'delivery-1');
  assert.equal(row.receiptId, 'receipt-1');
  assert.equal(row.state, 'verified');
  assert.equal(row.dispatched, true);
  assert.equal(row.grantRevoked, false);
  assert.deepEqual([...row.entryIds], ['audit-proposal-1', 'audit-authorization-1', 'audit-dispatch-1', 'audit-receipt-1']);
});

test('an unresolved delivery stays unknown until a receipt is observed', async () => {
  const { buildPermissionHistory } = await loadPermissionsView();
  const entries = executedActionEntries().map((entry) => (
    entry.kind === 'receipt'
      ? { ...entry, receiptId: 'receipt-unknown', status: 'unknown' as const, reason: 'transport closed after send' }
      : entry
  ));
  const rows = buildPermissionHistory(entries);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.state, 'unknown', 'a lost receipt is shown as unknown, never as sent or verified');
  assert.equal(row.dispatched, true);
  assert.equal(row.receiptId, 'receipt-unknown');
});

test('a pending confirmation renders as awaiting confirmation and authorizes nothing yet', async () => {
  const { buildPermissionHistory } = await loadPermissionsView();
  const entries = executedActionEntries().filter((entry) => entry.kind === 'proposal');
  entries.push({
    entryId: 'audit-confirmation-1',
    kind: 'confirmation',
    at: AT,
    actionId: 'action-run-tests',
    proposalId: 'proposal-1',
    confirmationId: 'confirmation-1',
  });
  const rows = buildPermissionHistory(entries);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.state, 'awaiting_confirmation');
  assert.equal(row.dispatched, false);
  assert.equal(row.authorizationId, undefined);
  assert.equal(row.receiptId, undefined);
});

test('revocation after an external effect keeps the executed receipt visible and flags the revoked grant', async () => {
  const { buildPermissionHistory } = await loadPermissionsView();
  const entries = executedActionEntries();
  entries.push({
    entryId: 'audit-revocation-1',
    kind: 'revocation',
    at: '2026-09-13T09:05:00.000Z',
    grantId: 'grant-1',
    reason: 'the user revoked the session grant',
  });
  const rows = buildPermissionHistory(entries);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.state, 'verified', 'revocation cannot undo a side effect that already happened');
  assert.equal(row.dispatched, true);
  assert.equal(row.receiptId, 'receipt-1');
  assert.equal(row.grantRevoked, true, 'the history flags the revoked grant without rewriting the receipt');
  for (const entryId of ['audit-proposal-1', 'audit-authorization-1', 'audit-dispatch-1', 'audit-receipt-1']) {
    assert.ok(row.entryIds.includes(entryId), `${entryId} stays linked after the revocation`);
  }
});
