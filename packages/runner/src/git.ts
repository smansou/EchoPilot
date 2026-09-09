import { lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { runProcess } from './process.js';

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({ command: 'git', args, cwd, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_EDITOR: 'true' } });
  if (result.code !== 0 || result.timedOut) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-2000)}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}
export async function assertCleanRepository(cwd: string, expectedBranch?: string): Promise<string> {
  const branch = await git(cwd, ['branch', '--show-current']);
  if (!branch || (expectedBranch && branch !== expectedBranch)) throw new Error('Repository branch differs from the configured integration branch');
  if ((await git(cwd, ['status', '--porcelain'])).length) throw new Error('Repository has uncommitted changes; integration paused');
  return branch;
}
export async function createTicketWorktree(options: { repository: string; ticketId: string; attempt: number; baseRef: string }): Promise<{ path: string; branch: string; baseCommit: string }> {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(options.ticketId) || !Number.isSafeInteger(options.attempt) || options.attempt < 1) throw new Error('Invalid ticket or attempt');
  const baseCommit = await git(options.repository, ['rev-parse', '--verify', `${options.baseRef}^{commit}`]);
  const branch = `codex/runner/${options.ticketId}/${options.attempt}`;
  const path = resolve(options.repository, '.runner', 'worktrees', `${options.ticketId}-${options.attempt}`);
  await mkdir(dirname(path), { recursive: true });
  await git(options.repository, ['worktree', 'add', '-b', branch, path, baseCommit]);
  return { path, branch, baseCommit };
}
const forbidden = ['.git', '.github', '.runner', '.agents', '.codex', 'packages/runner', 'apps/progress', 'scripts/runner', 'scripts/build-progress.mjs', 'runner.config', 'backlog.json'];
function inside(path: string, root: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)); }
export function isAllowedPath(file: string, allowedPaths: string[]): boolean {
  if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').includes('..')) return false;
  const normalized = file.toLowerCase();
  if (normalized.split('/').some(part => ['agents.md', '.gitmodules', '.gitattributes'].includes(part))) return false;
  if (forbidden.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/') || (prefix.includes('runner') && normalized.startsWith(prefix)))) return false;
  return allowedPaths.some(pattern => {
    // Only exact paths, directory prefixes, and terminal /** are supported: no ambiguous broad globs.
    const base = pattern.replace(/\/\*\*$/, '').replace(/\/$/, '');
    return base !== '' && base !== '.' && !base.includes('*') && (file === base || file.startsWith(base + '/'));
  });
}
export async function validateChangedPaths(worktree: string, allowedPaths: string[], baseRef = 'HEAD'): Promise<string[]> {
  const tracked = await git(worktree, ['diff', '--name-only', '-z', baseRef, '--']);
  const untracked = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set((tracked + '\0' + untracked).split('\0').filter(Boolean))];
  const root = await realpath(worktree);
  for (const file of files) {
    if (!isAllowedPath(file, allowedPaths)) throw new Error(`Changed path is outside ticket ownership: ${file}`);
    const absolute = resolve(root, file);
    if (!inside(absolute, root)) throw new Error(`Path escapes worktree: ${file}`);
    // Check all extant path components, including deleted files' parents.
    let component = absolute;
    while (component !== root) {
      try {
        const info = await lstat(component);
        if (info.isSymbolicLink() && !inside(await realpath(component), root)) throw new Error(`Symlink escapes worktree: ${file}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      component = dirname(component);
    }
  }
  return files;
}
export async function commitWorktree(options: { worktree: string; allowedPaths: string[]; message: string; baseRef?: string }): Promise<{ commit: string; files: string[] }> {
  const files = await validateChangedPaths(options.worktree, options.allowedPaths, options.baseRef ?? 'HEAD');
  if (!files.length) throw new Error('Worker produced no changed files');
  // Refuse worker-created commits: the coordinator owns the commit boundary.
  if (options.baseRef && await git(options.worktree, ['rev-parse', 'HEAD']) !== options.baseRef) throw new Error('Worker changed HEAD; automatic commit refused');
  await git(options.worktree, ['add', '--', ...files]);
  await git(options.worktree, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', options.message]);
  return { commit: await git(options.worktree, ['rev-parse', 'HEAD']), files };
}
export async function integrateCommit(options: { repository: string; expectedBranch: string; commit: string }): Promise<{ integrated: boolean; commit?: string; error?: string }> {
  await assertCleanRepository(options.repository, options.expectedBranch);
  try {
    await git(options.repository, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'cherry-pick', options.commit]);
    return { integrated: true, commit: await git(options.repository, ['rev-parse', 'HEAD']) };
  } catch (error) {
    // Abort only the cherry-pick we just started; never reset or clean the user's checkout.
    try { await git(options.repository, ['cherry-pick', '--abort']); } catch { /* no cherry-pick active */ }
    return { integrated: false, error: error instanceof Error ? error.message : 'Integration failed' };
  }
}
export async function pushBranch(options: { repository: string; expectedBranch: string; expectedRemote?: string }): Promise<void> {
  if (['main', 'master'].includes(options.expectedBranch)) throw new Error('Automatic publishing to main/master is disabled');
  await assertCleanRepository(options.repository, options.expectedBranch);
  const url = await git(options.repository, ['remote', 'get-url', '--push', 'origin']);
  const normalize = (value: string) => value.replace(/^git@github.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
  const expected = options.expectedRemote ?? 'https://github.com/smansou/EchoPilot';
  if (normalize(url) !== normalize(expected) || normalize(expected) !== 'https://github.com/smansou/echopilot') throw new Error('Origin does not match the authorized EchoPilot GitHub repository');
  await git(options.repository, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `HEAD:refs/heads/${options.expectedBranch}`]);
}
