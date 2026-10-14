import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorizeReadOnlyGit, readOnlyGitArgv, type ReadOnlyGitApproval} from '../src/read-only-git';

test('narrow Git approval binds canonical project, exact argv, explicit confirmation and lifetime', () => {
  const approval: ReadOnlyGitApproval = {projectId: 'p', cwd: '/project', operation: 'status', argv: readOnlyGitArgv('status')!, expiresAt: 30, used: false};
  const input = {approval, projectId: 'p', canonicalCwd: '/project', confirmed: true, now: 29};
  assert.deepEqual(authorizeReadOnlyGit(input), {allowed: true});
  for (const changed of [{confirmed: 'true'}, {projectId: 'other'}, {canonicalCwd: '/project/child'}, {now: 30}, {approval: {...approval, used: true}}, {approval: {...approval, argv: [...approval.argv, '--ignored']}}]) {
    assert.equal(authorizeReadOnlyGit({...input, ...changed}).allowed, false);
  }
  for (const operation of ['shell', '__proto__', {operation: 'status'}, 'status;echo hi', undefined]) assert.equal(readOnlyGitArgv(operation), null);
});
