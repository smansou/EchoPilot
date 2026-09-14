import { createHash } from 'node:crypto';

import type { ActionRequest } from '../../../contracts/src/index.js';
import type { DeliveryOutbox } from '../../../core/src/outbox/index.js';

export const CONFIRMATION_TTL_MS = 30_000;

type Effect = 'read' | 'local_write' | 'external' | 'destructive' | string;

type GrantInput = Readonly<{
  subject: string;
  capability: string;
  resource: Readonly<Record<string, string>>;
  dataCategory: string;
  destination: string;
  effect: Effect;
  lifetime: 'once' | 'session' | 'durable';
}>;

type Grant = GrantInput & Readonly<{ grantId: string; version: number; revoked: boolean }>;

type AuditEntry = Readonly<{
  entryId: string;
  kind: 'proposal' | 'authorization' | 'confirmation' | 'dispatch' | 'receipt' | 'denial' | 'revocation';
  at: string;
  actionId?: string;
  proposalId?: string;
  authorizationId?: string;
  confirmationId?: string;
  dispatchId?: string;
  deliveryId?: string;
  receiptId?: string;
  grantId?: string;
  grantVersion?: number;
  argumentHash?: string;
  status?: 'acknowledged' | 'completed' | 'failed' | 'unknown';
  reason?: string;
}>;

type Proposal = {
  proposalId: string;
  request: ActionRequest;
  argumentHash: string;
  grantId?: string;
  grantVersion: number;
  confirmationId?: string;
  confirmationExpiresAt?: number;
  authorizationId?: string;
};

type Confirmation = {
  confirmationId: string;
  proposalId: string;
  expiresAt: number;
  authorizationId?: string;
};

type DispatchRecord = {
  actionId: string;
  authorizationId: string;
  dispatchId: string;
  deliveryId: string;
  receiptId: string;
  state: 'verified' | 'failed' | 'unknown';
  reason?: string;
};

type Harness = Readonly<{
  send(instruction: string, deliveryId: string): Promise<Readonly<{
    deliveryId: string;
    status: 'acknowledged' | 'unsupported';
  }>>;
}>;

export type ActionBroker = Readonly<{
  grantCapability(input: GrantInput): Promise<{ grantId: string; version: number }>;
  revokeCapability(input: { grantId: string; reason: string }): Promise<{ grantId: string; grantVersion: number }>;
  propose(request: ActionRequest): Promise<Readonly<{
    proposalId: string;
    actionId: string;
    state: 'proposed' | 'authorized';
    argumentHash: string;
    authorizationId?: string;
    confirmationId?: string;
    confirmationExpiresAt?: string;
  }>>;
  confirmByVoice(input: { confirmationId: string; utteranceId: string; text: string }): Promise<Readonly<{
    confirmationId: string;
    authorized: boolean;
    reason?: 'unbound' | 'expired' | 'declined' | 'not_affirmative';
    authorizationId?: string;
  }>>;
  dispatch(request: ActionRequest): Promise<Readonly<{
    actionId: string;
    state: 'verified' | 'failed' | 'unknown' | 'denied';
    reason?: string;
    authorizationId?: string;
    deliveryId?: string;
    receiptId?: string;
  }>>;
  reconcile(input: { deliveryId: string; observed: 'acknowledged' | 'failed' }): Promise<Readonly<{
    actionId: string;
    state: 'verified' | 'failed' | 'unknown' | 'denied';
    reason?: string;
    authorizationId?: string;
    deliveryId?: string;
    receiptId?: string;
  }>>;
  pendingReconciliation(): ReadonlyArray<Readonly<{ actionId: string; deliveryId: string }>>;
  auditEntries(): ReadonlyArray<AuditEntry>;
}>;

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashRequest(request: ActionRequest): string {
  const { confirmationId: _confirmationId, ...boundRequest } = request;
  return `sha256:${createHash('sha256').update(stableValue(boundRequest)).digest('hex')}`;
}

function isAffirmative(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase().replace(/[.!?,;:]+$/u, '').trim();
  return /(^|\s)yes(\s|$)/u.test(normalized);
}

export function createActionBroker(options: Readonly<{
  harness: Harness;
  outbox: DeliveryOutbox;
  now?: () => Date;
}>): ActionBroker {
  const now = options.now ?? (() => new Date());
  const grants = new Map<string, Grant>();
  const proposals = new Map<string, Proposal>();
  const proposalsByAction = new Map<string, Proposal>();
  const confirmations = new Map<string, Confirmation>();
  const dispatchesByIdempotency = new Map<string, DispatchRecord>();
  const dispatchesByDelivery = new Map<string, DispatchRecord>();
  const audit: AuditEntry[] = [];
  let sequence = 0;

  const nextId = (prefix: string): string => `${prefix}-${++sequence}`;
  const at = (): string => now().toISOString();
  const addAudit = (entry: Omit<AuditEntry, 'entryId' | 'at'>): AuditEntry => {
    const complete = { ...entry, entryId: nextId('audit'), at: at() };
    audit.push(complete);
    return complete;
  };
  const denial = (request: ActionRequest, reason: string, proposal?: Proposal) => {
    addAudit({
      kind: 'denial',
      actionId: request.actionId,
      reason,
      ...(proposal === undefined ? {} : { proposalId: proposal.proposalId }),
      ...(request.grantId === undefined ? {} : { grantId: request.grantId }),
    });
    return {
      actionId: request.actionId,
      state: 'denied' as const,
      reason,
      ...(proposal?.authorizationId === undefined ? {} : { authorizationId: proposal.authorizationId }),
    };
  };
  const grantMatches = (grant: Grant, request: ActionRequest): boolean => {
    if (grant.capability !== request.tool || grant.effect !== request.effect || grant.destination !== 'managed-harness') return false;
    if (grant.dataCategory !== request.scope.sensitivity) return false;
    const facts: Record<string, unknown> = { ...request.scope };
    for (const [key, value] of Object.entries(request.arguments)) {
      if (value !== undefined && value !== null) facts[key] = value;
    }
    for (const [key, expected] of Object.entries(grant.resource)) {
      if (facts[key] !== expected) return false;
    }
    return true;
  };
  const authorize = (proposal: Proposal): string => {
    if (proposal.authorizationId) return proposal.authorizationId;
    const authorizationId = nextId('authorization');
    proposal.authorizationId = authorizationId;
    addAudit({
      kind: 'authorization',
      actionId: proposal.request.actionId,
      proposalId: proposal.proposalId,
      authorizationId,
      grantVersion: proposal.grantVersion,
      argumentHash: proposal.argumentHash,
      ...(proposal.grantId === undefined ? {} : { grantId: proposal.grantId }),
    });
    const confirmation = proposal.confirmationId ? confirmations.get(proposal.confirmationId) : undefined;
    if (confirmation) confirmation.authorizationId = authorizationId;
    return authorizationId;
  };
  const dispatchResult = (record: DispatchRecord) => ({
    actionId: record.actionId,
    state: record.state,
    authorizationId: record.authorizationId,
    deliveryId: record.deliveryId,
    receiptId: record.receiptId,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  });

  return {
    async grantCapability(input) {
      const grantId = nextId('grant');
      const grant: Grant = { ...input, grantId, version: 1, revoked: false };
      grants.set(grantId, grant);
      return { grantId, version: grant.version };
    },

    async revokeCapability(input) {
      const grant = grants.get(input.grantId);
      if (!grant) throw new Error(`Unknown grant: ${input.grantId}`);
      const revoked: Grant = { ...grant, version: grant.version + 1, revoked: true };
      grants.set(grant.grantId, revoked);
      addAudit({ kind: 'revocation', grantId: grant.grantId, grantVersion: revoked.version, reason: input.reason });
      return { grantId: grant.grantId, grantVersion: revoked.version };
    },

    async propose(request) {
      const grant = request.grantId === undefined ? undefined : grants.get(request.grantId);
      const proposalId = nextId('proposal');
      const argumentHash = hashRequest(request);
      const proposal: Proposal = {
        proposalId,
        request,
        argumentHash,
        grantVersion: grant?.version ?? 0,
        ...(request.grantId === undefined ? {} : { grantId: request.grantId }),
      };
      proposals.set(proposalId, proposal);
      proposalsByAction.set(request.actionId, proposal);
      addAudit({
        kind: 'proposal',
        actionId: request.actionId,
        proposalId,
        argumentHash,
        ...(request.grantId === undefined ? {} : { grantId: request.grantId }),
      });

      if (grant === undefined || grant.revoked || !grantMatches(grant, request)) {
        return { proposalId, actionId: request.actionId, state: 'proposed' as const, argumentHash };
      }
      if (request.effect === 'external' || request.effect === 'destructive') {
        const confirmationId = nextId('confirmation');
        const expiresAt = now().getTime() + CONFIRMATION_TTL_MS;
        proposal.confirmationId = confirmationId;
        proposal.confirmationExpiresAt = expiresAt;
        confirmations.set(confirmationId, { confirmationId, proposalId, expiresAt });
        addAudit({ kind: 'confirmation', actionId: request.actionId, proposalId, confirmationId });
        return {
          proposalId,
          actionId: request.actionId,
          state: 'proposed' as const,
          argumentHash,
          confirmationId,
          confirmationExpiresAt: new Date(expiresAt).toISOString(),
        };
      }
      const authorizationId = authorize(proposal);
      return { proposalId, actionId: request.actionId, state: 'authorized' as const, argumentHash, authorizationId };
    },

    async confirmByVoice(input) {
      const confirmation = confirmations.get(input.confirmationId);
      if (!confirmation) return { confirmationId: input.confirmationId, authorized: false as const, reason: 'unbound' as const };
      if (now().getTime() > confirmation.expiresAt) {
        return { confirmationId: input.confirmationId, authorized: false as const, reason: 'expired' as const };
      }
      if (confirmation.authorizationId) {
        return { confirmationId: input.confirmationId, authorized: true as const, authorizationId: confirmation.authorizationId };
      }
      if (!isAffirmative(input.text)) {
        return {
          confirmationId: input.confirmationId,
          authorized: false as const,
          reason: /^\s*(no|decline|cancel)\b/iu.test(input.text) ? 'declined' as const : 'not_affirmative' as const,
        };
      }
      const proposal = proposals.get(confirmation.proposalId);
      if (!proposal) return { confirmationId: input.confirmationId, authorized: false as const, reason: 'unbound' as const };
      const authorizationId = authorize(proposal);
      return { confirmationId: input.confirmationId, authorized: true as const, authorizationId };
    },

    async dispatch(request) {
      const proposal = proposalsByAction.get(request.actionId);
      if (!proposal) return denial(request, 'no proposal is bound to this action');
      if (hashRequest(request) !== proposal.argumentHash) return denial(request, 'action arguments do not match the authorized proposal', proposal);
      const grant = proposal.grantId === undefined ? undefined : grants.get(proposal.grantId);
      if (!grant || grant.revoked || grant.version !== proposal.grantVersion || !grantMatches(grant, request)) {
        return denial(request, 'the authorized grant is stale or revoked', proposal);
      }
      if (proposal.confirmationId !== undefined) {
        if (request.confirmationId !== proposal.confirmationId) return denial(request, 'confirmation is not bound to this proposal', proposal);
        if (proposal.confirmationExpiresAt === undefined || now().getTime() > proposal.confirmationExpiresAt) {
          return denial(request, 'confirmation has expired', proposal);
        }
      } else if (request.confirmationId !== undefined) {
        return denial(request, 'unexpected confirmation for an immediately authorized action', proposal);
      }
      if (!proposal.authorizationId) return denial(request, 'action has not been authorized', proposal);

      const prior = dispatchesByIdempotency.get(request.idempotencyKey);
      if (prior) {
        if (prior.actionId !== request.actionId) {
          return denial(request, 'idempotency key is already bound to another action', proposal);
        }
        return dispatchResult(prior);
      }
      const existingDelivery = options.outbox.getByIdempotencyKey(request.idempotencyKey);
      if (existingDelivery && existingDelivery.actionId !== request.actionId) {
        return denial(request, 'idempotency key is already bound to another action', proposal);
      }
      if (existingDelivery && existingDelivery.state !== 'prepared') {
        return denial(request, 'delivery already exists without a broker receipt', proposal);
      }

      const deliveryId = existingDelivery?.deliveryId ?? nextId('delivery');
      const prepared = options.outbox.prepare({ deliveryId, idempotencyKey: request.idempotencyKey, actionId: request.actionId });
      const dispatchId = nextId('dispatch');
      const receiptId = nextId('receipt');
      const dispatch: DispatchRecord = {
        actionId: request.actionId,
        authorizationId: proposal.authorizationId,
        dispatchId,
        deliveryId: prepared.deliveryId,
        receiptId,
        state: 'unknown',
      };
      options.outbox.markSent(prepared.deliveryId);
      addAudit({
        kind: 'dispatch',
        actionId: request.actionId,
        proposalId: proposal.proposalId,
        authorizationId: proposal.authorizationId,
        dispatchId,
        deliveryId: prepared.deliveryId,
      });
      try {
        const receipt = await options.harness.send(String(request.arguments.instruction ?? stableValue(request.arguments)), prepared.deliveryId);
        if (receipt.status === 'acknowledged') {
          options.outbox.resolve({ deliveryId: prepared.deliveryId, state: 'acknowledged' });
          dispatch.state = 'verified';
          addAudit({
            kind: 'receipt',
            actionId: request.actionId,
            dispatchId,
            deliveryId: prepared.deliveryId,
            receiptId,
            status: 'acknowledged',
          });
        } else {
          const reason = 'managed harness does not support this action';
          options.outbox.resolve({ deliveryId: prepared.deliveryId, state: 'failed', reason });
          dispatch.state = 'failed';
          dispatch.reason = reason;
          addAudit({ kind: 'receipt', actionId: request.actionId, dispatchId, deliveryId: prepared.deliveryId, receiptId, status: 'failed', reason });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.outbox.markUnknown(prepared.deliveryId, reason);
        dispatch.state = 'unknown';
        dispatch.reason = reason;
        addAudit({ kind: 'receipt', actionId: request.actionId, dispatchId, deliveryId: prepared.deliveryId, receiptId, status: 'unknown', reason });
      }
      dispatchesByIdempotency.set(request.idempotencyKey, dispatch);
      dispatchesByDelivery.set(prepared.deliveryId, dispatch);
      return dispatchResult(dispatch);
    },

    async reconcile(input) {
      const dispatch = dispatchesByDelivery.get(input.deliveryId);
      const delivery = options.outbox.get(input.deliveryId);
      if (!dispatch || !delivery) return { actionId: '', state: 'denied' as const, reason: 'unknown delivery', deliveryId: input.deliveryId };
      if (dispatch.state !== 'unknown') return dispatchResult(dispatch);
      const reason = input.observed === 'acknowledged' ? 'observed after reconnect' : 'observed failure after reconnect';
      options.outbox.resolve({ deliveryId: input.deliveryId, state: input.observed, reason });
      dispatch.state = input.observed === 'acknowledged' ? 'verified' : 'failed';
      dispatch.reason = reason;
      const receiptIndex = audit.findIndex((entry) => entry.receiptId === dispatch.receiptId);
      if (receiptIndex >= 0) {
        const existing = audit[receiptIndex];
        if (existing !== undefined) {
          const { reason: _replaced, ...rest } = existing;
          audit[receiptIndex] = { ...rest, status: input.observed, reason };
        }
      }
      return dispatchResult(dispatch);
    },

    pendingReconciliation() {
      return options.outbox.all()
        .filter((record) => record.state === 'unknown')
        .map((record) => ({ actionId: record.actionId, deliveryId: record.deliveryId }));
    },

    auditEntries() {
      return [...audit];
    },
  };
}
