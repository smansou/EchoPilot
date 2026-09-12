import { asPayloadRecord, asText } from './capsules.js';
import type { NormalizedEvent, TaskObservation, TaskPhase, TaskRecord, TaskStatus } from './model.js';

/**
 * Deterministic observation reducer. Only tool events produce task evidence: an agent narration
 * (for example "all tests passed") can never upgrade or downgrade the derived task status.
 */
export function reduceTaskObservation(event: NormalizedEvent, payload: unknown): TaskObservation | null {
  if (event.kind !== 'tool_started' && event.kind !== 'tool_completed') return null;
  const record = asPayloadRecord(payload);
  const taskId = asText(record.taskId) ?? asText(record.task_id);
  if (taskId === undefined) return null;
  const phase: TaskPhase = event.kind === 'tool_started' ? 'started' : 'completed';
  const tool = asText(record.tool);
  const command = asText(record.command);
  const title = asText(record.title);
  const receiptId = asText(record.receiptId);
  const exitCode = typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? record.exitCode : undefined;
  return {
    observationId: `${event.eventId}:${phase}`,
    taskId,
    eventId: event.eventId,
    phase,
    occurredAt: event.occurredAt,
    ingestSequence: event.ingestSequence,
    ...(tool === undefined ? {} : { tool }),
    ...(command === undefined ? {} : { command }),
    ...(title === undefined ? {} : { title }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(receiptId === undefined ? {} : { receiptId }),
  };
}

export function compareTaskObservations(a: TaskObservation, b: TaskObservation): number {
  const elapsed = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (Number.isFinite(elapsed) && elapsed !== 0) return elapsed;
  if (a.ingestSequence !== b.ingestSequence) return a.ingestSequence - b.ingestSequence;
  return a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0;
}

/** Latest tool receipt wins; failed receipts are sticky against later non-tool narration. */
export function reduceTaskRecord(observations: readonly TaskObservation[]): TaskRecord {
  const sorted = [...observations].sort(compareTaskObservations);
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) throw new Error('cannot reduce an empty task observation set');
  const completions = sorted.filter((observation) => observation.phase === 'completed');
  const latestReceipt = completions[completions.length - 1];
  const starts = sorted.filter((observation) => observation.phase === 'started');
  const status: TaskStatus = latestReceipt === undefined
    ? (starts.length > 0 ? 'running' : 'unknown')
    : (latestReceipt.exitCode === undefined || latestReceipt.exitCode === 0 ? 'passed' : 'failed');
  const sourceEventIds = [...new Set(sorted.map((observation) => observation.eventId))];
  const receiptLabel = latestReceipt === undefined
    ? 'no completion receipt'
    : `${latestReceipt.tool ?? 'tool'} receipt${latestReceipt.command === undefined ? '' : ` for ${latestReceipt.command}`}`
      + (latestReceipt.exitCode === undefined ? '' : ` (exit ${latestReceipt.exitCode})`);
  const verdict = status === 'failed' ? 'failed' : status === 'passed' ? 'passed' : 'is running';
  const summary = latestReceipt === undefined
    ? `Task ${latest.taskId} ${verdict} — ${starts.length} tool start(s), no completion receipt`
    : `Task ${latest.taskId} ${verdict} on the latest ${receiptLabel}`;
  const searchText = [
    summary,
    latest.taskId,
    ...sorted.flatMap((observation) => [observation.tool, observation.command, observation.title, observation.receiptId])
      .filter((value): value is string => value !== undefined),
  ].join('\n').toLowerCase();
  return {
    id: latest.taskId,
    kind: 'task',
    status,
    summary,
    occurredAt: latest.occurredAt,
    sourceEventIds,
    searchText,
    ...(latestReceipt?.receiptId === undefined ? {} : { latestReceiptId: latestReceipt.receiptId }),
  };
}
