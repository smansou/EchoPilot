/**
 * S04 process table — how the host executor learns which processes belong to the run it manages.
 *
 * A managed command is started as its own process group (`detached`), so the group is reachable
 * with one signal and a same-group child is stopped with it. A child that left the group (a real
 * daemonizing double-fork, or a script that spawned `detached: true`) cannot be reached by that
 * signal at all, and no stdio trick can stand in for a process table: Node's `close` event fires
 * when the *direct* child's pipes are done, not when the grandchild dies. So the executor records
 * the descendants of the group leader *before* it signals the group, and re-checks every recorded
 * pid afterwards — reporting the survivors instead of claiming the stop was complete.
 *
 * Sources, in order (the first that answers wins, and every one of them is a real process table):
 *   1. an explicit observer binary (`ECHOPILOT_EXEC_OBSERVATION`), for packaging/tests;
 *   2. the built `native/macos/Sources/Execution` helper (`echopilot-exec-observation`);
 *   3. `ps` — the ordinary case outside a restricted runtime;
 *   4. the Darwin `libproc` bootstrap compiled from `native/exec-observation.c` — a managed
 *      runtime denies `ps` (spawn EPERM) and `pgrep` (no process list), so the executor carries
 *      its own enumeration instead of degrading to "assume nothing is left";
 *   5. nothing: a caller that cannot enumerate is told so (`snapshot()` throws) and the executor
 *      reports `stop_unverified` rather than claiming a stop it cannot prove.
 *
 * Only the enumeration is native. What counts as "still running", which pid belongs to the managed
 * group, and what evidence is attached are TypeScript decisions (`host-executor.ts`), so the same
 * rules are unit-testable against an injected table.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProcessEntry = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  /** `zombie` is a reaped-but-not-yet-collected process: it is not running any more. */
  state: 'idle' | 'running' | 'sleeping' | 'stopped' | 'zombie' | 'unknown';
}>;

export type ProcessTable = Readonly<{ snapshot(): Promise<ReadonlyMap<number, ProcessEntry>> }>;

/** Darwin `pbi_status`: 1 SIDL, 2 SRUN, 3 SSLEEP, 4 SSTOP, 5 SZOMB. */
export function processStateFromStatus(status: number): ProcessEntry['state'] {
  switch (status) {
    case 1: return 'idle';
    case 2: return 'running';
    case 3: return 'sleeping';
    case 4: return 'stopped';
    case 5: return 'zombie';
    default: return 'unknown';
  }
}

/** `ps` state letters, e.g. `S`, `R+`, `Ss`, `Z`. */
export function processStateFromLetter(state: string): ProcessEntry['state'] {
  const first = state.trim().charAt(0).toUpperCase();
  switch (first) {
    case 'I': return 'idle';
    case 'R': return 'running';
    case 'S': return 'sleeping';
    case 'T': return 'stopped';
    case 'Z': return 'zombie';
    default: return 'unknown';
  }
}

export function isRunningEntry(entry: ProcessEntry | undefined): boolean {
  return entry !== undefined && entry.state !== 'zombie';
}

/** Every descendant of `root`, breadth-first over the parent links of one snapshot. */
export function descendantsOf(
  snapshot: ReadonlyMap<number, ProcessEntry>,
  root: number,
): readonly ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of snapshot.values()) {
    const list = children.get(entry.ppid);
    if (list === undefined) children.set(entry.ppid, [entry]);
    else list.push(entry);
  }
  const seen = new Set<number>();
  const found: ProcessEntry[] = [];
  const queue: number[] = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

export const EXEC_OBSERVATION_ENV = 'ECHOPILOT_EXEC_OBSERVATION';

export function parseObservation(text: string): ReadonlyMap<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const status = Number(fields[3]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      pgid: Number.isInteger(pgid) ? pgid : 0,
      state: processStateFromStatus(status),
    });
  }
  return table;
}

export function parsePsOutput(text: string): ReadonlyMap<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      pgid: Number.isInteger(pgid) ? pgid : 0,
      state: processStateFromLetter(fields[3] ?? ''),
    });
  }
  return table;
}

function runCapture(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error !== undefined && result.error !== null) return null;
  if (result.status !== 0) return null;
  return typeof result.stdout === 'string' ? result.stdout : null;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SOURCE = join(MODULE_DIR, 'native', 'exec-observation.c');
const REPO_HELPER_CANDIDATES = [
  resolve(MODULE_DIR, '../../../../native/macos/Sources/Execution/.build/release/echopilot-exec-observation'),
  resolve(MODULE_DIR, '../../../../native/macos/Sources/Execution/.build/debug/echopilot-exec-observation'),
];

function prebuiltHelper(): string | null {
  const explicit = process.env[EXEC_OBSERVATION_ENV];
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) return explicit;
  return REPO_HELPER_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** Compiles the bundled libproc bootstrap once per source revision, into the runtime temp dir. */
function ensureBootstrapBinary(): string | null {
  if (!existsSync(BOOTSTRAP_SOURCE)) return null;
  let source: string;
  try {
    source = readFileSync(BOOTSTRAP_SOURCE, 'utf8');
  } catch {
    return null;
  }
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const directory = join(tmpdir(), 'echopilot-s04-exec-observation');
  const binary = join(directory, `exec-observation-${digest}-${process.arch}`);
  if (isUsableBinary(binary)) return binary;
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    return null;
  }
  const partial = `${binary}.${process.pid}.partial`;
  for (const compiler of ['clang', 'cc']) {
    const compiled = runCapture(compiler, ['-O1', '-o', partial, BOOTSTRAP_SOURCE]);
    if (compiled === null) continue;
    try {
      renameSync(partial, binary);
    } catch {
      rmSync(partial, { force: true });
    }
    if (isUsableBinary(binary)) return binary;
  }
  rmSync(partial, { force: true });
  return null;
}

function isUsableBinary(binary: string): boolean {
  if (!existsSync(binary)) return false;
  return runCapture(binary, ['ps']) !== null;
}

/**
 * The real process table. `snapshot()` throws when no source can answer, so an executor that
 * cannot enumerate reports "unverified" instead of silently claiming nothing is left running.
 */
export function createProcessTable(): ProcessTable {
  let observation: string | null | undefined;
  const resolveObservation = (): string | null => {
    if (observation === undefined) observation = prebuiltHelper() ?? ensureBootstrapBinary();
    return observation;
  };
  return {
    async snapshot() {
      const helper = resolveObservation();
      if (helper !== null) {
        const text = runCapture(helper, ['ps']);
        if (text !== null) return parseObservation(text);
        observation = undefined;
      }
      const ps = runCapture('ps', ['-axo', 'pid=,ppid=,pgid=,state=']);
      if (ps !== null) return parsePsOutput(ps);
      throw new Error(
        'S04: no process table is available (no exec-observation helper, and ps refused); '
        + 'a managed stop cannot be verified in this runtime',
      );
    },
  };
}
