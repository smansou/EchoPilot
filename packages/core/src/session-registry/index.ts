import type {
  EventEnvelope,
  HarnessAdapter,
  HarnessCapability,
  HarnessDeliveryReceipt,
} from '../../../contracts/src/index.js';

export const HARNESS_CONFORMANCE_CHECKS = [
  'lifecycle:start',
  'capabilities:declared',
  'lifecycle:send',
  'lifecycle:interrupt',
  'lifecycle:approval',
  'lifecycle:resume',
  'lifecycle:close',
] as const;

export type HarnessKind = 'codex' | 'claude' | 'generic';

export type ManagedSessionRecord = Readonly<{
  sessionId: string;
  harness: HarnessKind;
  projectId: string;
  label: string;
  cwd: string;
  active: boolean;
  turnId?: string;
}>;

export type SessionRegistration = Readonly<{
  sessionId: string;
  harness: HarnessKind;
  projectId: string;
  label: string;
  cwd: string;
  adapter: HarnessAdapter;
}>;

export type DestinationResolution =
  | Readonly<{kind: 'resolved'; sessionId: string; harness: HarnessKind; projectId: string; label: string}>
  | Readonly<{kind: 'ambiguous'; sessionIds: ReadonlyArray<string>}>
  | Readonly<{kind: 'unmatched'}>;

export class UnsupportedHarnessOperationError extends Error {
  readonly code = 'unsupported_operation' as const;
  readonly operation: HarnessCapability;
  readonly harness: HarnessKind;
  readonly sessionId: string;

  constructor(operation: HarnessCapability, identity: Readonly<{harness: HarnessKind; sessionId: string}>) {
    super(`Harness ${identity.harness} session ${identity.sessionId} does not support ${operation}`);
    this.name = 'UnsupportedHarnessOperationError';
    this.operation = operation;
    this.harness = identity.harness;
    this.sessionId = identity.sessionId;
  }
}

type SessionRecord = {
  sessionId: string;
  harness: HarnessKind;
  projectId: string;
  label: string;
  cwd: string;
  active: boolean;
  turnId?: string;
  adapter: HarnessAdapter;
};

function copyRecord(record: SessionRecord): ManagedSessionRecord {
  return {
    sessionId: record.sessionId,
    harness: record.harness,
    projectId: record.projectId,
    label: record.label,
    cwd: record.cwd,
    active: record.active,
    ...(record.turnId === undefined ? {} : {turnId: record.turnId}),
  };
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function capabilitySet(value: ReadonlySet<HarnessCapability> | ReadonlyArray<HarnessCapability>): ReadonlySet<HarnessCapability> {
  return value instanceof Set ? value : new Set(value);
}

export function createConformantHarnessAdapter(
  adapter: HarnessAdapter,
  identity: Readonly<{harness: HarnessKind; sessionId: string}>,
): HarnessAdapter {
  const supports = async (operation: HarnessCapability): Promise<boolean> =>
    capabilitySet(await adapter.capabilities()).has(operation);
  const unsupported = (operation: HarnessCapability): UnsupportedHarnessOperationError =>
    new UnsupportedHarnessOperationError(operation, identity);

  return {
    capabilities: async () => capabilitySet(await adapter.capabilities()),
    start: () => adapter.start(),
    observe: (): AsyncIterable<EventEnvelope> => adapter.observe(),
    send: async (instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt> => {
      if (!(await supports('send'))) return {deliveryId, status: 'unsupported'};
      return adapter.send(instruction, deliveryId);
    },
    interrupt: async (turnId: string): Promise<void> => {
      if (!(await supports('interrupt'))) throw unsupported('interrupt');
      await adapter.interrupt(turnId);
    },
    respondApproval: async (requestId: string, decision: 'approve' | 'deny'): Promise<void> => {
      if (!(await supports('approval'))) throw unsupported('approval');
      await adapter.respondApproval(requestId, decision);
    },
    resume: async (sessionId: string): Promise<void> => {
      if (!(await supports('resume'))) throw unsupported('resume');
      await adapter.resume(sessionId);
    },
    close: () => adapter.close(),
  } as HarnessAdapter;
}

export type SessionRegistry = Readonly<{
  adopt(registration: SessionRegistration): ManagedSessionRecord;
  list(): ReadonlyArray<ManagedSessionRecord>;
  get(sessionId: string): ManagedSessionRecord | undefined;
  adapterFor(sessionId: string): HarnessAdapter | undefined;
  rename(sessionId: string, label: string): ManagedSessionRecord;
  end(sessionId: string): ManagedSessionRecord;
  recordTurn(sessionId: string, turnId: string): ManagedSessionRecord;
  destinationFor(phrase: string): DestinationResolution;
}>;

export function createSessionRegistry(): SessionRegistry {
  const records = new Map<string, SessionRecord>();

  const requireRecord = (sessionId: string): SessionRecord => {
    const record = records.get(sessionId);
    if (record === undefined) throw new TypeError(`Unknown session: ${sessionId}`);
    return record;
  };

  return {
    adopt(registration): ManagedSessionRecord {
      if (records.has(registration.sessionId)) throw new TypeError(`Duplicate session: ${registration.sessionId}`);
      if (registration.sessionId.trim() === '' || registration.projectId.trim() === '') {
        throw new TypeError('sessionId and projectId must not be empty');
      }
      const record: SessionRecord = {
        sessionId: registration.sessionId,
        harness: registration.harness,
        projectId: registration.projectId,
        label: registration.label,
        cwd: registration.cwd,
        active: true,
        adapter: createConformantHarnessAdapter(registration.adapter, {
          harness: registration.harness,
          sessionId: registration.sessionId,
        }),
      };
      records.set(record.sessionId, record);
      return copyRecord(record);
    },
    list: (): ReadonlyArray<ManagedSessionRecord> => [...records.values()].map(copyRecord),
    get: (sessionId): ManagedSessionRecord | undefined => {
      const record = records.get(sessionId);
      return record === undefined ? undefined : copyRecord(record);
    },
    adapterFor: (sessionId): HarnessAdapter | undefined => records.get(sessionId)?.adapter,
    rename: (sessionId, label): ManagedSessionRecord => {
      const record = requireRecord(sessionId);
      record.label = label;
      return copyRecord(record);
    },
    end: (sessionId): ManagedSessionRecord => {
      const record = requireRecord(sessionId);
      record.active = false;
      return copyRecord(record);
    },
    recordTurn: (sessionId, turnId): ManagedSessionRecord => {
      if (turnId.trim() === '') throw new TypeError('turnId must not be empty');
      const record = requireRecord(sessionId);
      record.turnId = turnId;
      return copyRecord(record);
    },
    destinationFor: (phrase): DestinationResolution => {
      const query = normalized(phrase);
      const matches = [...records.values()].filter((record) =>
        record.active && (normalized(record.label) === query || normalized(record.sessionId) === query),
      );
      if (matches.length === 0) return {kind: 'unmatched'};
      if (matches.length > 1) return {kind: 'ambiguous', sessionIds: matches.map((record) => record.sessionId).sort()};
      const record = matches[0];
      if (record === undefined) return {kind: 'unmatched'};
      return {
        kind: 'resolved',
        sessionId: record.sessionId,
        harness: record.harness,
        projectId: record.projectId,
        label: record.label,
      };
    },
  };
}

export type ConformanceCheckId = (typeof HARNESS_CONFORMANCE_CHECKS)[number];
export type ConformanceOutcome = 'executed' | 'unsupported_typed_error' | 'unsupported_receipt';

export type ConformanceCheck = Readonly<{
  id: ConformanceCheckId;
  status: 'pass' | 'fail';
  outcome: ConformanceOutcome;
  detail?: string;
}>;

export type ConformanceReport = Readonly<{
  harness: HarnessKind;
  sessionId: string;
  capabilities: ReadonlyArray<HarnessCapability>;
  checks: ReadonlyArray<ConformanceCheck>;
  passed: boolean;
}>;

export type ConformanceLifecycle = Readonly<{
  start(adapter: HarnessAdapter): Promise<void>;
  send(adapter: HarnessAdapter, instruction: string, deliveryId: string): Promise<HarnessDeliveryReceipt>;
  interrupt?(adapter: HarnessAdapter): Promise<void>;
  approval?(adapter: HarnessAdapter): Promise<void>;
  resume?(adapter: HarnessAdapter): Promise<void>;
  close(adapter: HarnessAdapter): Promise<void>;
}>;

export type ConformanceCase = Readonly<{
  harness: HarnessKind;
  sessionId: string;
  adapter: HarnessAdapter;
  lifecycle: ConformanceLifecycle;
}>;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHarnessConformance(
  cases: ReadonlyArray<ConformanceCase>,
): Promise<ReadonlyArray<ConformanceReport>> {
  const reports: ConformanceReport[] = [];
  for (const candidate of cases) {
    const adapter = createConformantHarnessAdapter(candidate.adapter, {
      harness: candidate.harness,
      sessionId: candidate.sessionId,
    });
    const checks: ConformanceCheck[] = [];
    let capabilities: ReadonlyArray<HarnessCapability> = [];
    const add = (id: ConformanceCheckId, outcome: ConformanceOutcome, action: () => Promise<void>): Promise<void> =>
      action().then(
        () => { checks.push({id, status: 'pass', outcome}); },
        (error: unknown) => { checks.push({id, status: 'fail', outcome, detail: errorDetail(error)}); },
      );

    await add('lifecycle:start', 'executed', () => candidate.lifecycle.start(adapter));
    await add('capabilities:declared', 'executed', async () => {
      capabilities = [...capabilitySet(await adapter.capabilities())];
    });
    await add('lifecycle:send', capabilities.includes('send') ? 'executed' : 'unsupported_receipt', async () => {
      if (!capabilities.includes('send')) {
        const receipt = await adapter.send('h04 conformance probe', `h04-${candidate.sessionId}-send`);
        if (receipt.status !== 'unsupported') throw new Error(`expected unsupported receipt, got ${receipt.status}`);
        return;
      }
      const receipt = await candidate.lifecycle.send(adapter, 'h04 conformance probe', `h04-${candidate.sessionId}-send`);
      if (receipt.status !== 'acknowledged' || receipt.deliveryId !== `h04-${candidate.sessionId}-send`) {
        throw new Error(`send did not acknowledge its delivery id: ${JSON.stringify(receipt)}`);
      }
    });
    await add('lifecycle:interrupt', capabilities.includes('interrupt') ? 'executed' : 'unsupported_typed_error', async () => {
      if (capabilities.includes('interrupt')) {
        if (candidate.lifecycle.interrupt === undefined) throw new Error('lifecycle does not provide interrupt');
        await candidate.lifecycle.interrupt(adapter);
        return;
      }
      try {
        await adapter.interrupt('h04-conformance-turn');
        throw new Error('unsupported interrupt resolved');
      } catch (error) {
        if (!(error instanceof UnsupportedHarnessOperationError)) throw error;
      }
    });
    await add('lifecycle:approval', capabilities.includes('approval') ? 'executed' : 'unsupported_typed_error', async () => {
      if (capabilities.includes('approval')) {
        if (candidate.lifecycle.approval === undefined) throw new Error('lifecycle does not provide approval');
        await candidate.lifecycle.approval(adapter);
        return;
      }
      try {
        await adapter.respondApproval('h04-conformance-approval', 'approve');
        throw new Error('unsupported approval resolved');
      } catch (error) {
        if (!(error instanceof UnsupportedHarnessOperationError)) throw error;
      }
    });
    await add('lifecycle:resume', capabilities.includes('resume') ? 'executed' : 'unsupported_typed_error', async () => {
      if (capabilities.includes('resume')) {
        if (candidate.lifecycle.resume === undefined) throw new Error('lifecycle does not provide resume');
        await candidate.lifecycle.resume(adapter);
        return;
      }
      try {
        await adapter.resume(candidate.sessionId);
        throw new Error('unsupported resume resolved');
      } catch (error) {
        if (!(error instanceof UnsupportedHarnessOperationError)) throw error;
      }
    });
    await add('lifecycle:close', 'executed', () => candidate.lifecycle.close(adapter));

    reports.push({
      harness: candidate.harness,
      sessionId: candidate.sessionId,
      capabilities: [...capabilities],
      checks,
      passed: checks.length === HARNESS_CONFORMANCE_CHECKS.length && checks.every((check) => check.status === 'pass'),
    });
  }
  return reports;
}
