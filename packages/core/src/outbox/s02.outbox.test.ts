/**
 * S02 outbox oracle — the delivery states behind acceptance criterion 2: "A disconnect after send
 * becomes unknown until reconciled; no automatic resend causes a duplicate action."
 *
 * Frozen seam — packages/core/src/outbox/index.ts
 *   export function createDeliveryOutbox({ now }) → DeliveryOutbox
 *     prepare({ deliveryId, idempotencyKey, actionId }) → state 'prepared'; the same idempotencyKey
 *       never creates a second delivery.
 *     markSent(deliveryId) → 'sent' (the instruction may already have reached the harness).
 *     markUnknown(deliveryId, reason) → 'unknown'.
 *     resolve({ deliveryId, state: 'acknowledged'|'completed'|'failed', reason? }) → the reconciled
 *       delivery; the only path out of 'unknown'.
 *     resendable() → the deliveries an automatic sender may pick up: only 'prepared' records.
 *       'sent', 'unknown', 'acknowledged', 'completed' and 'failed' are never resent automatically.
 *     get(deliveryId), getByIdempotencyKey(idempotencyKey), all().
 *
 * The outbox holds the durable delivery record; the managed harness is exercised in
 * packages/security/src/broker/s02.acceptance.test.ts, which drives this module through dispatch
 * and reconciliation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

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

/** Loads the yet-to-be-implemented outbox, turning "module missing" into a named red failure. */
async function loadOutbox(): Promise<Readonly<{ createDeliveryOutbox: (options?: { now?: () => Date }) => DeliveryOutbox }>> {
  try {
    return (await import('./index.js')) as unknown as Readonly<{
      createDeliveryOutbox: (options?: { now?: () => Date }) => DeliveryOutbox;
    }>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((error as Error).message))) {
      assert.fail(
        'Missing required behavior: packages/core/src/outbox/index.ts must export '
        + 'createDeliveryOutbox() so a delivery is durable before send, a lost receipt stays unknown '
        + 'until reconciliation, and no automatic resend can duplicate an action. '
        + `Underlying error: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

function freshOutbox(outbox: Readonly<{ createDeliveryOutbox: (options?: { now?: () => Date }) => DeliveryOutbox }>): DeliveryOutbox {
  return outbox.createDeliveryOutbox({ now: () => new Date('2026-09-13T09:00:00.000Z') });
}

test('a prepared delivery is the only automatic resend candidate and a duplicate idempotency key never creates a second delivery', async () => {
  const outbox = freshOutbox(await loadOutbox());
  const prepared = outbox.prepare({ deliveryId: 'delivery-1', idempotencyKey: 'idem-1', actionId: 'action-1' });
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.deliveryId, 'delivery-1');
  assert.equal(prepared.idempotencyKey, 'idem-1');
  assert.equal(prepared.actionId, 'action-1');
  assert.equal(prepared.updatedAt, '2026-09-13T09:00:00.000Z');
  assert.deepEqual(
    outbox.resendable().map((record) => record.deliveryId),
    ['delivery-1'],
    'a never-sent delivery is safe to send',
  );

  const duplicate = outbox.prepare({ deliveryId: 'delivery-2', idempotencyKey: 'idem-1', actionId: 'action-1' });
  assert.equal(duplicate.deliveryId, 'delivery-1', 'the same idempotency key returns the existing delivery');
  assert.equal(outbox.all().length, 1, 'a duplicate idempotency key never creates a second delivery');
  assert.equal(outbox.getByIdempotencyKey('idem-1')?.deliveryId, 'delivery-1');
});

test('a sent or unknown delivery is never resent automatically and reconciliation resolves it once', async () => {
  const outbox = freshOutbox(await loadOutbox());
  outbox.prepare({ deliveryId: 'delivery-1', idempotencyKey: 'idem-1', actionId: 'action-1' });

  const sent = outbox.markSent('delivery-1');
  assert.equal(sent.state, 'sent');
  assert.deepEqual(outbox.resendable(), [], 'a sent delivery may already have executed: never resend automatically');

  const unknown = outbox.markUnknown('delivery-1', 'transport closed after the instruction was accepted');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'transport closed after the instruction was accepted');
  assert.deepEqual(outbox.resendable(), [], 'an unknown delivery waits for reconciliation, not for a resend');

  const resolved = outbox.resolve({ deliveryId: 'delivery-1', state: 'acknowledged', reason: 'observed after reconnect' });
  assert.equal(resolved.state, 'acknowledged');
  assert.deepEqual(outbox.resendable(), [], 'a reconciled delivery is never resent');
  assert.equal(outbox.get('delivery-1')?.state, 'acknowledged');
});
