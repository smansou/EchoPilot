export type DeliveryState =
  | 'prepared'
  | 'sent'
  | 'acknowledged'
  | 'completed'
  | 'failed'
  | 'unknown';

export type DeliveryRecord = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  actionId: string;
  state: DeliveryState;
  updatedAt: string;
  reason?: string;
}>;

export type DeliveryOutbox = Readonly<{
  prepare(input: { deliveryId: string; idempotencyKey: string; actionId: string }): DeliveryRecord;
  markSent(deliveryId: string): DeliveryRecord;
  markUnknown(deliveryId: string, reason: string): DeliveryRecord;
  resolve(input: {
    deliveryId: string;
    state: 'acknowledged' | 'completed' | 'failed';
    reason?: string;
  }): DeliveryRecord;
  get(deliveryId: string): DeliveryRecord | undefined;
  getByIdempotencyKey(idempotencyKey: string): DeliveryRecord | undefined;
  resendable(): ReadonlyArray<DeliveryRecord>;
  all(): ReadonlyArray<DeliveryRecord>;
}>;

export function createDeliveryOutbox(options: { now?: () => Date } = {}): DeliveryOutbox {
  const now = options.now ?? (() => new Date());
  const records = new Map<string, DeliveryRecord>();
  const byIdempotencyKey = new Map<string, string>();

  const timestamp = (): string => now().toISOString();
  const getRequired = (deliveryId: string): DeliveryRecord => {
    const record = records.get(deliveryId);
    if (!record) throw new Error(`Unknown delivery: ${deliveryId}`);
    return record;
  };
  const withoutReason = (record: DeliveryRecord): Omit<DeliveryRecord, 'reason'> => {
    const { reason: _dropped, ...rest } = record;
    return rest;
  };
  const update = (record: DeliveryRecord, state: DeliveryState, reason?: string): DeliveryRecord => {
    const rest = withoutReason(record);
    const next: DeliveryRecord = reason === undefined
      ? { ...rest, state, updatedAt: timestamp() }
      : { ...rest, state, updatedAt: timestamp(), reason };
    records.set(record.deliveryId, next);
    return next;
  };

  return {
    prepare(input) {
      const existingId = byIdempotencyKey.get(input.idempotencyKey);
      if (existingId) return getRequired(existingId);
      if (records.has(input.deliveryId)) {
        throw new Error(`Delivery id already exists: ${input.deliveryId}`);
      }
      const record: DeliveryRecord = {
        deliveryId: input.deliveryId,
        idempotencyKey: input.idempotencyKey,
        actionId: input.actionId,
        state: 'prepared',
        updatedAt: timestamp(),
      };
      records.set(record.deliveryId, record);
      byIdempotencyKey.set(record.idempotencyKey, record.deliveryId);
      return record;
    },

    markSent(deliveryId) {
      const record = getRequired(deliveryId);
      if (record.state === 'sent') return record;
      if (record.state !== 'prepared') return record;
      return update(record, 'sent');
    },

    markUnknown(deliveryId, reason) {
      const record = getRequired(deliveryId);
      if (record.state === 'unknown') return record;
      if (record.state === 'acknowledged' || record.state === 'completed' || record.state === 'failed') {
        return record;
      }
      return update(record, 'unknown', reason);
    },

    resolve(input) {
      const record = getRequired(input.deliveryId);
      if (record.state === input.state && record.reason === input.reason) return record;
      if (record.state !== 'sent' && record.state !== 'unknown' && record.state !== 'prepared') {
        return record;
      }
      return update(record, input.state, input.reason);
    },

    get(deliveryId) {
      return records.get(deliveryId);
    },

    getByIdempotencyKey(idempotencyKey) {
      const deliveryId = byIdempotencyKey.get(idempotencyKey);
      return deliveryId ? records.get(deliveryId) : undefined;
    },

    resendable() {
      return [...records.values()].filter((record) => record.state === 'prepared');
    },

    all() {
      return [...records.values()];
    },
  };
}
