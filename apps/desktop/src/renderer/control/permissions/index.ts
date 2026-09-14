export type PermissionAuditEntry = Readonly<{
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
  status?: 'acknowledged' | 'completed' | 'failed' | 'unknown';
  reason?: string;
}>;

export type PermissionHistoryRow = Readonly<{
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

type MutableRow = {
  actionId: string;
  proposalId?: string;
  authorizationId?: string;
  deliveryId?: string;
  receiptId?: string;
  state: PermissionHistoryRow['state'];
  dispatched: boolean;
  grantRevoked: boolean;
  entryIds: string[];
  grantId?: string;
};

export function buildPermissionHistory(entries: ReadonlyArray<PermissionAuditEntry>): ReadonlyArray<PermissionHistoryRow> {
  const rows = new Map<string, MutableRow>();
  const grantRows = new Map<string, MutableRow>();
  const getRow = (actionId: string): MutableRow => {
    const existing = rows.get(actionId);
    if (existing) return existing;
    const row: MutableRow = {
      actionId,
      state: 'proposed',
      dispatched: false,
      grantRevoked: false,
      entryIds: [],
    };
    rows.set(actionId, row);
    return row;
  };
  const applyState = (row: MutableRow, state: PermissionHistoryRow['state']) => {
    row.state = state;
  };

  for (const entry of entries) {
    if (entry.kind === 'revocation') {
      if (entry.grantId) {
        const row = grantRows.get(entry.grantId);
        if (row) row.grantRevoked = true;
      }
      continue;
    }
    if (!entry.actionId) continue;
    const row = getRow(entry.actionId);
    row.entryIds.push(entry.entryId);
    if (entry.kind === 'proposal') {
      if (entry.proposalId !== undefined) row.proposalId ??= entry.proposalId;
      if (entry.grantId) {
        row.grantId = entry.grantId;
        grantRows.set(entry.grantId, row);
      }
      if (!row.dispatched) applyState(row, 'proposed');
    } else if (entry.kind === 'confirmation') {
      if (!row.authorizationId && !row.dispatched) applyState(row, 'awaiting_confirmation');
    } else if (entry.kind === 'authorization') {
      if (entry.proposalId !== undefined) row.proposalId ??= entry.proposalId;
      if (entry.authorizationId !== undefined) row.authorizationId = entry.authorizationId;
      if (entry.grantId) {
        row.grantId = entry.grantId;
        grantRows.set(entry.grantId, row);
      }
      if (!row.dispatched) applyState(row, 'authorized');
    } else if (entry.kind === 'dispatch') {
      if (entry.authorizationId !== undefined) row.authorizationId ??= entry.authorizationId;
      if (entry.deliveryId !== undefined) row.deliveryId ??= entry.deliveryId;
      row.dispatched = true;
      applyState(row, 'dispatched');
    } else if (entry.kind === 'receipt') {
      if (entry.deliveryId !== undefined) row.deliveryId ??= entry.deliveryId;
      if (entry.receiptId !== undefined) row.receiptId = entry.receiptId;
      row.dispatched = true;
      if (entry.status === 'acknowledged' || entry.status === 'completed') applyState(row, 'verified');
      else if (entry.status === 'unknown') applyState(row, 'unknown');
      else if (entry.status === 'failed') applyState(row, 'failed');
      else applyState(row, 'dispatched');
    } else if (entry.kind === 'denial') {
      if (!row.dispatched) applyState(row, 'denied');
    }
  }

  return [...rows.values()].map(({ grantId: _grantId, ...row }) => ({ ...row, entryIds: [...row.entryIds] }));
}
