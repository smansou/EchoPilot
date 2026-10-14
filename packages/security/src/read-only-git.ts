/** Narrow user-confirmed capability: three fixed local Git reads, never generic host autonomy. */
export type ReadOnlyGitOperation = 'status' | 'diff-stat' | 'current-branch';
const PREFIX = ['/usr/bin/git','--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','diff.external=','-c','submodule.recurse=false'] as const;
const COMMANDS: Record<ReadOnlyGitOperation, readonly string[]> = {
  status: ['diff-index','--cached','--name-status','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=all','HEAD','--'],
  // Index-only diff avoids worktree clean/process filters, which can execute local commands.
  'diff-stat': ['diff','--cached','--stat','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=all','--'],
  'current-branch': ['symbolic-ref','--quiet','--short','HEAD'],
};
export function readOnlyGitArgv(operation: unknown): readonly string[] | null {
  if (operation !== 'status' && operation !== 'diff-stat' && operation !== 'current-branch') return null;
  return [...PREFIX, ...COMMANDS[operation]];
}
export type ReadOnlyGitApproval = {projectId: string; cwd: string; operation: ReadOnlyGitOperation; argv: readonly string[]; expiresAt: number; used: boolean};
export function authorizeReadOnlyGit(input: {approval: ReadOnlyGitApproval; projectId: string; canonicalCwd: string; confirmed: unknown; now: number}): {allowed: true} | {allowed: false; reason: string} {
  if (input.confirmed !== true) return {allowed: false, reason: 'confirmation_required'};
  if (input.approval.used || input.now >= input.approval.expiresAt) return {allowed: false, reason: 'approval_expired'};
  if (input.projectId !== input.approval.projectId || input.canonicalCwd !== input.approval.cwd) return {allowed: false, reason: 'scope_changed'};
  const expected = readOnlyGitArgv(input.approval.operation);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(input.approval.argv)) return {allowed: false, reason: 'unsupported_command'};
  return {allowed: true};
}
