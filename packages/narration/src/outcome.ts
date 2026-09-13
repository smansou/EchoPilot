/**
 * N01 outcome reduction: the deterministic task status that narration may speak about.
 *
 * The reduction is deliberately receipt-only. Everything the tracer knows about a turn's result
 * comes from tool receipts (`tool_completed` envelopes), so:
 *
 * - a nonzero observed exit code is never upgraded by later agent text, and a zero exit code is
 *   never downgraded by an agent hedge;
 * - the turn status is `failed` as soon as any receipt in the turn exited nonzero — a later green
 *   receipt may not mask an observed failure inside the same turn;
 * - no receipt at all means `null` (not `passed`): narration stays silent rather than guessing.
 */

export type NarrationStatus = 'passed' | 'failed' | 'running' | 'unknown';

export type NarrationOutcome = Readonly<{
  sessionId: string;
  taskId: string;
  status: NarrationStatus;
  exitCode?: number;
  evidenceIds: ReadonlyArray<string>;
}>;

/** One observed tool run: the durable events it was reduced from and the exit code it reported. */
export type TaskReceipt = Readonly<{
  /** The `tool_completed` event id — the durable record of the observed exit code. */
  eventId: string;
  /** The matching `tool_started` event id, when the journal retained one. */
  startEventId: string | null;
  taskId: string | null;
  command: string | null;
  exitCode: number;
  observedAt: string;
  /** Counts parsed from the receipt's own output, or null when the output has no summary line. */
  counts: CheckCounts | null;
}>;

export type CheckCounts = Readonly<{ total: number; passed: number; failed: number }>;

/**
 * Reads the trailing summary line tools like the read-only fixture suite print, e.g.
 * `24 checks, 21 passed, 3 failed`. Only a self-consistent summary is accepted.
 */
export function countChecks(output: string | null): CheckCounts | null {
  if (output === null) return null;
  const pattern = /(\d+)\s+checks?,\s*(\d+)\s+passed,\s*(\d+)\s+failed/gu;
  let match: RegExpExecArray | null = null;
  for (let found = pattern.exec(output); found !== null; found = pattern.exec(output)) match = found;
  if (match === null) return null;
  const total = Number.parseInt(match[1] ?? '', 10);
  const passed = Number.parseInt(match[2] ?? '', 10);
  const failed = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(passed) || !Number.isSafeInteger(failed)) {
    return null;
  }
  if (passed + failed !== total) return null;
  return { total, passed, failed };
}

export type TurnReduction = Readonly<{
  sessionId: string;
  receipts: ReadonlyArray<TaskReceipt>;
  /** Extra durable evidence of the turn (for example `gap` events); cited, never spoken. */
  extraEvidenceIds?: ReadonlyArray<string>;
}>;

function orderedUnique(ids: ReadonlyArray<string | null>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

/**
 * Reduces one turn's receipts into the single outcome N01 may speak. `null` means no receipt is
 * known yet, so nothing may be claimed.
 */
export function reduceTurn(turn: TurnReduction): NarrationOutcome | null {
  if (turn.receipts.length === 0) return null;
  const failing = turn.receipts.filter((receipt) => receipt.exitCode !== 0);
  const newest = turn.receipts[turn.receipts.length - 1];
  if (newest === undefined) return null;
  const decisive = failing[failing.length - 1] ?? newest;
  const evidenceIds = orderedUnique([
    ...turn.receipts.flatMap((receipt) => [receipt.startEventId, receipt.eventId]),
    ...(turn.extraEvidenceIds ?? []),
  ]);
  const taskId = newest.taskId ?? decisive.taskId ?? '';
  return {
    sessionId: turn.sessionId,
    taskId,
    status: failing.length > 0 ? 'failed' : 'passed',
    exitCode: decisive.exitCode,
    evidenceIds,
  };
}
