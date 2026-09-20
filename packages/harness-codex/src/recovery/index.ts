/**
 * H04 — reconnect and delivery reconciliation for a managed Codex session
 * (IMPLEMENTATION_PLAN.md §5.3/§5.6/§5.12; ticket H04).
 *
 * A managed Codex app-server connection can die between the moment an instruction is written to the
 * wire and the moment its acknowledgment comes back. Retrying blindly in that window is how a
 * companion issues the same instruction twice, so this module keeps one durable delivery record per
 * `deliveryId` (the idempotency key) and treats every unacknowledged attempt as an explicitly
 * `unknown` outcome rather than a silent retry:
 *
 *   - `deliver()` writes an instruction at most once per `deliveryId`. A later `deliver()` with the
 *     same id — including after `reconnect()` — returns the retained record and never touches the
 *     wire again.
 *   - An attempt whose acknowledgment was lost stays visible as `unknown` in `outbox()`/`unknown()`.
 *   - `reconcile()` inspects observed session state and resolves an unknown delivery only when that
 *     state names the same session and project and contains a turn carrying the same instruction;
 *     reconciliation never sends. A completed turn becomes `completed`, an accepted-but-unfinished
 *     turn becomes `acknowledged`, and anything else stays `unknown`.
 *   - `reconnect()` swaps the adapter for a fresh one from `connect()` and leaves deliveries intact.
 *
 * The module is transport-agnostic: `connect()` provides a fresh, unstarted `HarnessAdapter` for the
 * same managed session, so the same logic drives the pinned child fixture and a real app-server.
 */
import type {
  HarnessAdapter,
  HarnessDeliveryReceipt,
} from '../../../contracts/src/index.js';

export type DeliveryState =
  | 'prepared'
  | 'sent'
  | 'acknowledged'
  | 'completed'
  | 'failed'
  | 'unknown';

export type DeliveryRecord = Readonly<{
  deliveryId: string;
  sessionId: string;
  projectId: string;
  instruction: string;
  state: DeliveryState;
  attempts: number;
  observedTurnId?: string;
  updatedAt: string;
  detail?: string;
}>;

export type ObservedTurnStatus = 'in_progress' | 'completed' | 'interrupted' | 'failed';

export type ObservedTurn = Readonly<{
  turnId: string;
  instruction: string;
  status: ObservedTurnStatus;
}>;

export type ObservedSessionState = Readonly<{
  sessionId: string;
  projectId: string;
  cwd?: string;
  turns: ReadonlyArray<ObservedTurn>;
}>;

export type RecoveringCodexSession = Readonly<{
  sessionId: string;
  projectId: string;
  start(): Promise<void>;
  deliver(instruction: string, deliveryId: string): Promise<DeliveryRecord>;
  outbox(): ReadonlyArray<DeliveryRecord>;
  unknown(): ReadonlyArray<DeliveryRecord>;
  reconnect(): Promise<void>;
  reconcile(observeSessionState: () => Promise<ObservedSessionState>): Promise<ReadonlyArray<DeliveryRecord>>;
  close(): Promise<void>;
}>;

export type RecoveringCodexSessionOptions = Readonly<{
  sessionId: string;
  projectId: string;
  connect: () => Promise<HarnessAdapter>;
  now?: () => Date;
}>;

type MutableDelivery = {
  deliveryId: string;
  sessionId: string;
  projectId: string;
  instruction: string;
  state: DeliveryState;
  attempts: number;
  observedTurnId?: string;
  updatedAt: string;
  detail?: string;
};

type MutableOptions = {
  sessionId: string;
  projectId: string;
  connect: () => Promise<HarnessAdapter>;
  now: () => Date;
};

function copyDelivery(record: MutableDelivery): DeliveryRecord {
  return {
    deliveryId: record.deliveryId,
    sessionId: record.sessionId,
    projectId: record.projectId,
    instruction: record.instruction,
    state: record.state,
    attempts: record.attempts,
    ...(record.observedTurnId === undefined ? {} : {observedTurnId: record.observedTurnId}),
    updatedAt: record.updatedAt,
    ...(record.detail === undefined ? {} : {detail: record.detail}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when a send() rejection can mean "the request may already be on the wire".
 *
 * The pinned adapter rejects an in-flight `turn/start` when the child dies with a transport-level
 * message (exit code, EPIPE, "not running", closed session). Those are exactly the cases where the
 * instruction may have reached the harness and the acknowledgment was lost, so they become
 * `unknown` rather than `failed`. A rejection raised before any write — an unsupported capability,
 * a closed-by-the-caller session, a missing thread — is a definite failure and is reported as such.
 */
function isIndeterminateSendFailure(error: unknown): boolean {
  const message = errorText(error);
  return /exited|EPIPE|ECONNRESET|broken pipe|not running|disconnected|socket hang up|closed before|acknowledg/i
    .test(message);
}

function validateObservedState(value: ObservedSessionState): ObservedSessionState {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('reconcile() requires observed session state');
  }
  if (typeof value.sessionId !== 'string' || typeof value.projectId !== 'string' || !Array.isArray(value.turns)) {
    throw new TypeError('observed session state must name sessionId, projectId, and turns');
  }
  return value;
}

export function createRecoveringCodexSession(options: RecoveringCodexSessionOptions): RecoveringCodexSession {
  const { sessionId, projectId, connect } = options;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('createRecoveringCodexSession() requires a non-empty sessionId');
  }
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new TypeError('createRecoveringCodexSession() requires a non-empty projectId');
  }
  if (typeof connect !== 'function') {
    throw new TypeError('createRecoveringCodexSession() requires a connect() factory');
  }

  const mutableOptions: MutableOptions = {
    sessionId,
    projectId,
    connect,
    now: options.now ?? (() => new Date()),
  };

  const deliveries = new Map<string, MutableDelivery>();
  const inFlight = new Map<string, Promise<DeliveryRecord>>();
  let adapter: HarnessAdapter | undefined;
  let started = false;
  let closed = false;
  let connecting: Promise<void> | undefined;

  const touch = (record: MutableDelivery): void => {
    record.updatedAt = mutableOptions.now().toISOString();
  };

  const currentAdapter = (): HarnessAdapter => {
    if (closed) throw new Error('The recovering Codex session is closed');
    if (adapter !== undefined) return adapter;
    throw new Error('The recovering Codex session has no connection; call start() or reconnect() first');
  };

  const connectFresh = async (): Promise<void> => {
    if (closed) throw new Error('The recovering Codex session is closed');
    const next = await connect();
    if (closed) {
      await next.close().catch(() => undefined);
      throw new Error('The recovering Codex session was closed while connecting');
    }
    adapter = next;
    await next.start();
  };

  return {
    sessionId,
    projectId,

    async start(): Promise<void> {
      if (closed) throw new Error('The recovering Codex session is closed');
      if (started) return;
      if (connecting === undefined) connecting = connectFresh();
      try {
        await connecting;
        started = true;
      } finally {
        connecting = undefined;
      }
    },

    async deliver(instruction: string, deliveryId: string): Promise<DeliveryRecord> {
      if (closed) throw new Error('The recovering Codex session is closed');
      if (typeof deliveryId !== 'string' || deliveryId.trim().length === 0) {
        throw new TypeError('deliver() requires a non-empty deliveryId');
      }
      if (typeof instruction !== 'string' || instruction.trim().length === 0) {
        throw new TypeError('deliver() requires a non-empty instruction');
      }

      // A concurrent retry of the same id joins the in-flight attempt instead of opening a second
      // one: one deliveryId can never produce two writes, even when both callers race, and a racing
      // caller never observes the transient 'prepared' state of a send that is still on its way.
      const running = inFlight.get(deliveryId);
      if (running !== undefined) return running;

      const settled = deliveries.get(deliveryId);
      if (settled !== undefined) {
        // The idempotency key already has an outcome: return it and never write again. This holds
        // for acknowledged, failed, and unknown records alike, including across reconnect().
        return copyDelivery(settled);
      }

      const attempt = (async (): Promise<DeliveryRecord> => {
        // Resolve the connection before recording an attempt: a session that was never started (or a
        // closed one) has no wire attempt to report, so it fails loudly instead of fabricating an
        // 'unknown' outcome that reconciliation could never resolve.
        const connection = currentAdapter();

        const record: MutableDelivery = {
          deliveryId,
          sessionId,
          projectId,
          instruction,
          state: 'prepared',
          attempts: 0,
          updatedAt: mutableOptions.now().toISOString(),
        };
        deliveries.set(deliveryId, record);

        let receipt: HarnessDeliveryReceipt;
        try {
          receipt = await connection.send(instruction, deliveryId);
        } catch (error) {
          record.attempts += 1;
          if (isIndeterminateSendFailure(error)) {
            // The request may have reached the harness; the outcome is genuinely unknown until an
            // observed session state describes it.
            record.state = 'unknown';
            record.detail = errorText(error);
          } else {
            record.state = 'failed';
            record.detail = errorText(error);
          }
          touch(record);
          return copyDelivery(record);
        }

        record.attempts += 1;
        if (receipt.status === 'unsupported') {
          record.state = 'failed';
          record.detail = 'the harness does not support send';
        } else {
          record.state = 'acknowledged';
        }
        touch(record);
        return copyDelivery(record);
      })();

      inFlight.set(deliveryId, attempt);
      try {
        return await attempt;
      } finally {
        inFlight.delete(deliveryId);
      }
    },

    outbox(): ReadonlyArray<DeliveryRecord> {
      return [...deliveries.values()].map(copyDelivery);
    },

    unknown(): ReadonlyArray<DeliveryRecord> {
      return [...deliveries.values()].filter((record) => record.state === 'unknown').map(copyDelivery);
    },

    async reconnect(): Promise<void> {
      if (closed) throw new Error('The recovering Codex session is closed');
      const previous = adapter;
      adapter = undefined;
      if (previous !== undefined) {
        await previous.close().catch(() => undefined);
      }
      await connectFresh();
      started = true;
    },

    async reconcile(observeSessionState): Promise<ReadonlyArray<DeliveryRecord>> {
      if (closed) throw new Error('The recovering Codex session is closed');
      if (typeof observeSessionState !== 'function') {
        throw new TypeError('reconcile() requires an observeSessionState() function');
      }
      const observed = validateObservedState(await observeSessionState());
      const unknownRecords = [...deliveries.values()].filter((record) => record.state === 'unknown');
      if (unknownRecords.length === 0) return [];

      const sameSession = observed.sessionId === sessionId && observed.projectId === projectId;
      const reconciled: DeliveryRecord[] = [];
      for (const record of unknownRecords) {
        const turn = sameSession
          ? observed.turns.find(
              (candidate) => candidate.instruction === record.instruction && typeof candidate.turnId === 'string',
            )
          : undefined;
        if (turn === undefined) {
          reconciled.push(copyDelivery(record));
          continue;
        }
        // An observed turn carrying this instruction proves the send reached the harness; only a
        // completed turn proves it finished, so every other observed status stays 'acknowledged'.
        record.state = turn.status === 'completed' ? 'completed' : 'acknowledged';
        record.observedTurnId = turn.turnId;
        delete record.detail;
        touch(record);
        reconciled.push(copyDelivery(record));
      }
      return reconciled;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const previous = adapter;
      adapter = undefined;
      if (previous !== undefined) {
        await previous.close().catch(() => undefined);
      }
    },
  };
}
