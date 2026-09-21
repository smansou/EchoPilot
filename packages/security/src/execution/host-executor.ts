/**
 * S04 host executor — the explicit macOS path (`host-execution`).
 *
 * Host execution claims no containment: there is no mount and no network namespace, only the
 * `execution.host_autonomy` grant that authorized it. What it does own is the managed process:
 *
 * - the argv is spawned directly (`detached`, so the command leads its own process group) — never
 *   through a shell, so an argument that looks like a metacharacter stays one argv element;
 * - a timeout or a cancel signals the *group*, which is what reaches a same-group child;
 * - before signalling, the executor records the descendants of the group leader from the process
 *   table (and keeps sampling while the command runs), and afterwards it re-checks every recorded
 *   pid. A child that left the group cannot be reached by a group signal at all, so it is reported
 *   with its pid and the evidence that it is still running, and `stopped` stays false;
 * - a run that cannot be verified at all (no process table in this runtime) is reported
 *   `stop_unverified` with `stopped: false`, never as a clean stop.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { descendantsOf, isRunningEntry, type ProcessEntry, type ProcessTable } from './process-table.js';
import type { CommandOutcome, CommandRequest, UncertainChild } from './types.js';
import { HOST_EXECUTION_LABEL } from './types.js';

/** How long the group leader gets to be reaped after the group signal. */
const LEADER_EXIT_GRACE_MS = 3_000;
/** How long same-group descendants get to disappear after the group signal. */
const GROUP_DRAIN_GRACE_MS = 1_500;
/** How often the running command's descendants are recorded while it runs. */
const SAMPLE_INTERVAL_MS = 500;

export type HostRunOptions = Readonly<{
  request: CommandRequest;
  proposalId: string;
  table: ProcessTable;
  now: () => Date;
  timeoutMs: number;
}>;

export type HostRun = Readonly<{
  requestId: string;
  /** Resolves with the observed outcome once the managed group is gone — or proven not gone. */
  outcome: Promise<CommandOutcome>;
  /** Stops the managed group and reports the same outcome the in-flight dispatch resolves with. */
  cancel(): Promise<CommandOutcome>;
}>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Liveness without a process table: a dead pid raises ESRCH, a foreign pid raises EPERM. */
function aliveBySignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function startHostRun(options: HostRunOptions): HostRun {
  const { request, proposalId, table, now, timeoutMs } = options;
  const program = request.argv[0] ?? '';
  const args = request.argv.slice(1);

  let stdout = '';
  let stderr = '';
  const recorded = new Map<number, ProcessEntry>();
  let enumerated = false;
  let sampleInFlight = false;
  let settled: CommandOutcome | null = null;
  let stopping: Promise<CommandOutcome> | null = null;
  let settlingNatural = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveOutcome: (outcome: CommandOutcome) => void = () => {};
  const outcomePromise = new Promise<CommandOutcome>((resolve) => { resolveOutcome = resolve; });

  const child: ChildProcess = spawn(program, args, {
    cwd: request.workdir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const leaderPid = child.pid ?? -1;

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

  const snapshotNow = async (): Promise<ReadonlyMap<number, ProcessEntry> | null> => {
    try {
      return await table.snapshot();
    } catch {
      return null;
    }
  };

  const record = async (): Promise<ReadonlyMap<number, ProcessEntry> | null> => {
    const snapshot = await snapshotNow();
    if (snapshot === null) return null;
    enumerated = true;
    for (const entry of descendantsOf(snapshot, leaderPid)) {
      if (!recorded.has(entry.pid)) recorded.set(entry.pid, entry);
    }
    return snapshot;
  };

  const sampleTimer = setInterval(() => {
    if (sampleInFlight || settled !== null || stopping !== null) return;
    sampleInFlight = true;
    void record().finally(() => { sampleInFlight = false; });
  }, SAMPLE_INTERVAL_MS);

  const buildOutcome = (input: Readonly<{
    state: CommandOutcome['state'];
    exitCode: number | null;
    reason?: string;
    stopped: boolean;
    uncertainChildren: readonly UncertainChild[];
    processGroupId: number | null;
  }>): CommandOutcome => ({
    requestId: request.requestId,
    proposalId,
    executor: 'host',
    executionLabel: HOST_EXECUTION_LABEL,
    state: input.state,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    exitCode: input.exitCode,
    stdout,
    stderr,
    processGroupId: input.processGroupId,
    stopped: input.stopped,
    uncertainChildren: input.uncertainChildren,
    observedAt: now().toISOString(),
  });

  const settle = (outcome: CommandOutcome): CommandOutcome => {
    const current = settled;
    if (current !== null) return current;
    settled = outcome;
    clearInterval(sampleTimer);
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    resolveOutcome(outcome);
    return outcome;
  };

  const waitForLeaderExit = async (graceMs: number): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); }),
      delay(graceMs),
    ]);
  };

  const survivorsAfterStop = async (groupId: number): Promise<Readonly<{
    verified: boolean;
    survivors: readonly UncertainChild[];
  }>> => {
    const inGroup = [...recorded.values()].filter((entry) => entry.pgid === groupId);
    const deadline = Date.now() + GROUP_DRAIN_GRACE_MS;
    let snapshot = await snapshotNow();
    while (snapshot !== null && Date.now() < deadline) {
      const pending = inGroup.some((entry) => isRunningEntry(snapshot?.get(entry.pid)));
      if (!pending) break;
      await delay(50);
      snapshot = await snapshotNow();
    }
    if (snapshot !== null) {
      const survivors: UncertainChild[] = [];
      for (const entry of recorded.values()) {
        if (!isRunningEntry(snapshot.get(entry.pid))) continue;
        survivors.push({
          pid: entry.pid,
          evidence: entry.pgid === groupId
            ? `pid ${entry.pid} (parent ${entry.ppid}) is still running ${GROUP_DRAIN_GRACE_MS} ms after managed process group ${groupId} was killed`
            : `pid ${entry.pid} runs in process group ${entry.pgid}, outside managed group ${groupId}; a group stop cannot reach it and it is still running`,
        });
      }
      return { verified: true, survivors };
    }
    if (!enumerated) return { verified: false, survivors: [] };
    const survivors: UncertainChild[] = [];
    for (const entry of recorded.values()) {
      if (!aliveBySignal(entry.pid)) continue;
      survivors.push({
        pid: entry.pid,
        evidence: `pid ${entry.pid} still answers kill(${entry.pid}, 0) after managed process group ${groupId} was killed, and the process table could not be re-read`,
      });
    }
    return { verified: true, survivors };
  };

  const performStop = async (state: 'cancelled' | 'timed_out'): Promise<CommandOutcome> => {
    const current = settled;
    if (current !== null) return current;
    await record();
    const groupId = leaderPid;
    try {
      process.kill(-groupId, 'SIGKILL');
    } catch {
      // The group is already gone; the leader kill below is the belt to this brace.
    }
    try {
      process.kill(groupId, 'SIGKILL');
    } catch {
      // The leader is already gone.
    }
    await waitForLeaderExit(LEADER_EXIT_GRACE_MS);
    const report = await survivorsAfterStop(groupId);
    return settle(buildOutcome({
      state,
      exitCode: child.exitCode,
      ...(report.verified ? {} : { reason: 'stop_unverified' }),
      stopped: report.verified && report.survivors.length === 0,
      uncertainChildren: report.survivors,
      processGroupId: leaderPid,
    }));
  };

  const stop = (state: 'cancelled' | 'timed_out'): Promise<CommandOutcome> => {
    stopping ??= performStop(state);
    return stopping;
  };

  const settleNatural = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
    if (settled !== null || stopping !== null || settlingNatural) return;
    settlingNatural = true;
    const snapshot = await snapshotNow();
    const survivors: UncertainChild[] = [];
    for (const entry of recorded.values()) {
      const running = snapshot !== null
        ? isRunningEntry(snapshot.get(entry.pid))
        : aliveBySignal(entry.pid);
      if (!running) continue;
      survivors.push({
        pid: entry.pid,
        evidence: `pid ${entry.pid} outlived the command (exit ${code === null ? `signal ${signal ?? 'unknown'}` : code}) in process group ${entry.pgid} and is still running`,
      });
    }
    settle(buildOutcome({
      state: code === 0 ? 'completed' : 'failed',
      exitCode: code,
      ...(code === null ? { reason: `terminated_by_signal:${signal ?? 'unknown'}` } : {}),
      stopped: survivors.length === 0,
      uncertainChildren: survivors,
      processGroupId: leaderPid,
    }));
  };

  timeoutTimer = setTimeout(() => {
    void stop('timed_out').catch(() => {
      settle(buildOutcome({
        state: 'timed_out',
        exitCode: null,
        reason: 'stop_unverified',
        stopped: false,
        uncertainChildren: [],
        processGroupId: leaderPid,
      }));
    });
  }, timeoutMs);

  child.on('error', (error: Error) => {
    stderr += `${error.message}\n`;
    settle(buildOutcome({
      state: 'failed',
      exitCode: null,
      reason: 'spawn_failed',
      stopped: true,
      uncertainChildren: [],
      processGroupId: null,
    }));
  });

  child.on('exit', (code, signal) => {
    if (stopping !== null || settled !== null) return;
    // `close` guarantees the stdio pipes are drained; the timer keeps a stuck pipe from hanging
    // the dispatch, and the exit event itself is the authority on how the command ended.
    void settleNatural(code, signal).catch(() => {});
  });
  child.on('close', (code, signal) => {
    if (stopping !== null || settled !== null) return;
    void settleNatural(code, signal).catch(() => {});
  });

  return {
    requestId: request.requestId,
    outcome: outcomePromise,
    cancel: () => stop('cancelled'),
  };
}
