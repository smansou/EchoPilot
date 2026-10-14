import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { authorizeReadOnlyGit, readOnlyGitArgv, type ReadOnlyGitApproval, type ReadOnlyGitOperation } from '../../../../packages/security/src/read-only-git';

export type ScopedCommandPreview = {previewId: string; projectId: string; cwd: string; operation: ReadOnlyGitOperation; argv: readonly string[]; expiresAt: number; authority: 'one_read_only_git_command'};
export type ScopedCommandReceipt = {source: 'project_git_command'; projectId: string; cwd: string; argv: readonly string[]; operation: ReadOnlyGitOperation; state: 'completed' | 'failed' | 'timed_out' | 'output_limit' | 'cancelled'; exitCode: number | null; stdout: string; stderr: string; outputTruncated: boolean; observedAt: string; processGroupStopped: boolean};
export type ScopedCommandResult = {ok: boolean; error?: string; preview?: ScopedCommandPreview; receipt?: ScopedCommandReceipt};
export type ScopedGitRun = {outcome: Promise<Omit<ScopedCommandReceipt, 'source'|'projectId'|'cwd'|'argv'|'operation'|'observedAt'>>; cancel(): void};
type Options = {activeProject(): {projectId: string; cwd: string} | null; now?(): number; canonical?(path: string): Promise<string>; run?(argv: readonly string[], cwd: string): ScopedGitRun};

/** Fixed argv, scrubbed Git config environment, bounded output and wall clock; never a shell. */
export function runScopedGit(argv: readonly string[], cwd: string): ScopedGitRun {
  if (!(['status', 'diff-stat', 'current-branch'] as const).some(operation => JSON.stringify(readOnlyGitArgv(operation)) === JSON.stringify(argv))) throw Error('unsupported_command');
  const deadline = Date.now() + 6000;
  let active: ScopedGitRun | null = null; let cancelled = false;
  const outcome = (async () => {
    active = runBoundedGit(['/usr/bin/git', '--no-pager', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], cwd, deadline);
    const discovery = await active.outcome;
    if (cancelled) return {...discovery, state: 'cancelled' as const, stdout: '', stderr: ''};
    if (discovery.state !== 'completed') return discovery;
    const [top, selected] = await Promise.all([realpath(discovery.stdout.trim()), realpath(cwd)]);
    if (cancelled) return {...discovery, state: 'cancelled' as const, stdout: '', stderr: ''};
    if (top !== selected) return {...discovery, state: 'failed' as const, exitCode: null, stdout: '', stderr: 'scope_changed'};
    active = runBoundedGit(argv, cwd, deadline);
    return active.outcome;
  })();
  return {outcome, cancel() {cancelled = true; active?.cancel();}};
}

function runBoundedGit(argv: readonly string[], cwd: string, deadline: number): ScopedGitRun {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_ATTR_NOSYSTEM: '1',
  };
  const child = spawn(argv[0]!, [...argv.slice(1)], {cwd, detached: true, stdio: ['ignore','pipe','pipe'], env});
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let truncated = false;
  let stopped: ScopedCommandReceipt['state'] | null = null;
  let settled = false;
  let killTimer: NodeJS.Timeout | null = null;
  function killGroup() {if (!child.pid) return; try {process.kill(-child.pid, 'SIGKILL');} catch {}}
  function stop(reason: ScopedCommandReceipt['state']) {
    if (stopped) return; stopped = reason;
    if (reason === 'cancelled') {stdout.length = 0; stderr.length = 0;}
    if (child.pid) {try {process.kill(-child.pid, 'SIGTERM');} catch {}}
    killTimer = setTimeout(killGroup, 250); killTimer.unref();
  }
  function output(chunk: Buffer, destination: 'stdout' | 'stderr') {
    if (stopped === 'cancelled') return;
    const available = Math.max(0, 65_536 - bytes);
    const accepted = chunk.subarray(0, available);
    if (destination === 'stdout') stdout.push(accepted); else stderr.push(accepted);
    bytes += Math.min(available, chunk.byteLength);
    if (chunk.byteLength > available) {truncated = true; stop('output_limit');}
  }
  child.stdout.on('data', (chunk: Buffer) => output(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => output(chunk, 'stderr'));
  const timeout = setTimeout(() => stop('timed_out'), Math.max(1, deadline - Date.now())); timeout.unref();
  let resolveOutcome: (value: Awaited<ScopedGitRun['outcome']>) => void = () => {};
  const outcome = new Promise<Awaited<ScopedGitRun['outcome']>>((resolve) => {resolveOutcome = resolve;});
  function finish(exitCode: number | null) {
    if (settled) return; settled = true; clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    // Even a normal git exit cannot leave an inherited group behind.
    killGroup();
    let groupStopped = true;
    if (child.pid) {try {process.kill(-child.pid, 0); groupStopped = false;} catch (error) {groupStopped = (error as NodeJS.ErrnoException).code === 'ESRCH';}}
    const value = {state: stopped ?? (exitCode === 0 ? 'completed' as const : 'failed' as const), exitCode, stdout: stopped === 'cancelled' ? '' : Buffer.concat(stdout).toString('utf8'), stderr: stopped === 'cancelled' ? '' : Buffer.concat(stderr).toString('utf8'), outputTruncated: truncated, processGroupStopped: groupStopped};
    stdout.length = 0; stderr.length = 0;
    resolveOutcome(value);
  }
  child.on('close', finish);
  child.on('error', () => finish(null));
  return {outcome, cancel: () => stop('cancelled')};
}

export function createScopedCommands(options: Options) {
  const now = options.now ?? Date.now;
  const canonical = options.canonical ?? (async (path) => {const cwd = await realpath(path); if (!(await stat(cwd)).isDirectory()) throw Error('project_unavailable'); return cwd;});
  const run = options.run ?? runScopedGit;
  let pending: {view: ScopedCommandPreview; approval: ReadOnlyGitApproval} | null = null;
  let active: ScopedGitRun | null = null;
  let busy = false;
  let disposed = false;
  let revision = 0;
  function project(value: unknown) {const selected = options.activeProject(); if (disposed || !selected || selected.projectId !== value) throw Error('inactive_project'); return selected;}
  return {
    clear() {revision++; pending = null; active?.cancel();},
    dispose() {disposed = true; revision++; pending = null; active?.cancel();},
    async handle(payload: unknown): Promise<ScopedCommandResult> {
      let claimed = false;
      try {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid_request');
        const request = payload as Record<string, unknown>;
        if (Object.keys(request).some((key) => !['command','projectId','operation','previewId','confirmed'].includes(key))) throw Error('unsupported_command');
        const selected = project(request.projectId);
        if (request.command === 'cancel') {revision++; pending = null; active?.cancel(); return {ok: true};}
        if (busy) throw Error('busy'); busy = true; claimed = true;
        const startedRevision = revision;
        const cwd = await canonical(selected.cwd);
        if (revision !== startedRevision || project(request.projectId).cwd !== selected.cwd) throw Error('scope_changed');
        if (request.command === 'preview') {
          const argv = readOnlyGitArgv(request.operation);
          if (!argv) throw Error('unsupported_command');
          const view: ScopedCommandPreview = {previewId: randomUUID(), projectId: selected.projectId, cwd, operation: request.operation as ReadOnlyGitOperation, argv, expiresAt: now() + 30_000, authority: 'one_read_only_git_command'};
          pending = {view, approval: {...view, used: false}};
          return {ok: true, preview: view};
        }
        if (request.command !== 'confirm') throw Error('invalid_request');
        const item = pending;
        if (!item || item.view.previewId !== request.previewId) throw Error('preview_missing');
        const verdict = authorizeReadOnlyGit({approval: item.approval, projectId: selected.projectId, canonicalCwd: cwd, confirmed: request.confirmed, now: now()});
        if (!verdict.allowed) throw Error(verdict.reason);
        pending = null; item.approval.used = true;
        if (await canonical(project(request.projectId).cwd) !== cwd) throw Error('scope_changed');
        if (revision !== startedRevision || project(request.projectId).cwd !== selected.cwd) throw Error('scope_changed');
        active = run(item.view.argv, cwd);
        const monitor = setInterval(() => {const current = options.activeProject(); if (!current || current.projectId !== selected.projectId || current.cwd !== selected.cwd) active?.cancel();}, 100);
        monitor.unref();
        let observed: Awaited<ScopedGitRun['outcome']>;
        try {observed = await active.outcome;} finally {clearInterval(monitor); active = null;}
        if (revision !== startedRevision || disposed) throw Error('scope_changed');
        const receipt: ScopedCommandReceipt = {...observed, source: 'project_git_command', projectId: selected.projectId, cwd, operation: item.view.operation, argv: item.view.argv, observedAt: new Date(now()).toISOString()};
        return {ok: observed.state === 'completed' && observed.exitCode === 0, receipt};
      } catch (error) {
        const allowed = new Set(['inactive_project','scope_changed','confirmation_required','approval_expired','unsupported_command','invalid_request','preview_missing','busy','project_unavailable']);
        const message = error instanceof Error ? error.message : '';
        return {ok: false, error: allowed.has(message) ? message : 'project_unavailable'};
      } finally {if (claimed) busy = false;}
    },
  };
}
