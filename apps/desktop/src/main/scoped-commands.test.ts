import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, appendFile, writeFile, readFile, rm, realpath, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScopedCommands, runScopedGit} from './scoped-commands';
import {readOnlyGitArgv} from '../../../../packages/security/src/read-only-git';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const cwd = await mkdtemp(join(tmpdir(), 'echopilot-scoped-git-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', ...args], {cwd, env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}}).toString();
  git('init', '-q', '-b', 'fixture'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(cwd, 'tracked.txt'), 'initial\n'); git('add', 'tracked.txt'); git('commit', '-qm', 'fixture');
  return {cwd, git};
}
test('real Git reads require preview and one-shot confirmation, canonicalize cwd and refuse injected scope', async t => {
  const {cwd, git} = await fixture(t);
  const alias = join(cwd, 'alias'); await symlink(cwd, alias);
  let selected = {projectId: 'p', cwd: alias};
  const service = createScopedCommands({activeProject: () => selected}); t.after(async () => service.dispose());
  await writeFile(join(cwd, 'tracked.txt'), 'changed\n'); git('add', 'tracked.txt');
  for (const operation of ['status', 'diff-stat', 'current-branch'] as const) {
    const preview = (await service.handle({command: 'preview', projectId: 'p', operation})).preview!;
    assert.equal(preview.cwd, await realpath(cwd));
    assert.equal((await service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId})).error, 'confirmation_required');
    const result = await service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true});
    assert.equal(result.ok, true); assert.equal(result.receipt?.state, 'completed');
    assert.match(result.receipt!.stdout, operation === 'current-branch' ? /fixture/ : /tracked.txt/);
    assert.equal(result.receipt?.processGroupStopped, true);
    assert.equal((await service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true})).error, 'preview_missing');
  }
  for (const payload of [{command: 'preview', projectId: 'p', operation: 'status', cwd: '/'}, {command: 'preview', projectId: 'p', operation: 'status', argv: ['/bin/sh']}, {command: 'preview', projectId: 'p', operation: 'status;touch nope'}]) assert.equal((await service.handle(payload)).error, 'unsupported_command');
  const preview = (await service.handle({command: 'preview', projectId: 'p', operation: 'status'})).preview!;
  selected = {projectId: 'p', cwd: tmpdir()};
  assert.equal((await service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true})).error, 'scope_changed');
});
test('real configured hooks, fsmonitor, external diff, textconv and clean filters never execute', async t => {
  const {cwd, git} = await fixture(t);
  const sentinel = join(cwd, 'executed'); const trap = `/usr/bin/touch '${sentinel}'`;
  await writeFile(join(cwd, '.gitattributes'), '*.txt filter=trap diff=trap\n');
  git('config', 'core.fsmonitor', trap); git('config', 'core.hooksPath', cwd); git('config', 'diff.external', trap); git('config', 'diff.trap.textconv', trap); git('config', 'filter.trap.clean', trap); git('config', 'filter.trap.process', trap);
  await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  for (const operation of ['status', 'diff-stat', 'current-branch'] as const) {const result = await runScopedGit(readOnlyGitArgv(operation)!, cwd).outcome; assert.equal(result.state, 'completed', `${operation}: ${result.stderr}`);}
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
  assert.throws(() => runScopedGit(['/bin/sh', '-c', trap], cwd), /unsupported_command/);
});
test('new filter config during execution cannot execute; staged reads yield the main event loop', async t => {
  const {cwd, git} = await fixture(t);
  await writeFile(join(cwd, 'tracked.txt'), 'staged\n'); git('add', 'tracked.txt');
  const sentinel = join(cwd, 'executed');
  for (const operation of ['status', 'diff-stat', 'current-branch'] as const) {
    let yielded = false;
    const execution = runScopedGit(readOnlyGitArgv(operation)!, cwd);
    const tick = new Promise<void>(resolve => setImmediate(() => {yielded = true; resolve();}));
    await appendFile(join(cwd, '.git', 'config'), `\n[filter "fresh-${operation}"]\n\tprocess = /usr/bin/touch '${sentinel}'\n\tclean = /usr/bin/touch '${sentinel}'\n\trequired = true\n`);
    await writeFile(join(cwd, '.gitattributes'), `*.txt filter=fresh-${operation}\n`);
    await writeFile(join(cwd, 'tracked.txt'), 'unstaged content must not be normalized\n');
    const result = await execution.outcome;
    assert.equal(result.state, 'completed', result.stderr); assert.equal(yielded, true); await tick;
    if (operation !== 'current-branch') assert.match(result.stdout, /tracked.txt/);
  }
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
});
test('real output bound stops a large tracked status', async t => {
  const {cwd, git} = await fixture(t);
  const names = Array.from({length: 500}, (_, i) => `file-${i}-${'x'.repeat(180)}.txt`);
  await Promise.all(names.map(name => writeFile(join(cwd, name), 'x'))); git('add', '--', ...names);
  const result = await runScopedGit(readOnlyGitArgv('status')!, cwd).outcome;
  assert.equal(result.state, 'output_limit'); assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 65536);
});
test('a nested project folder cannot read an ancestor repository', async t => {
  const {cwd} = await fixture(t); const nested = join(cwd, 'nested'); await mkdir(nested);
  const result = await runScopedGit(readOnlyGitArgv('status')!, nested).outcome;
  assert.equal(result.state, 'failed'); assert.equal(result.stderr, 'scope_changed');
});
test('expiration, canceled previews and cancellation during asynchronous scope resolution refuse execution', async () => {
  let now = 0; let runs = 0; let release: (() => void) | undefined;
  const service = createScopedCommands({activeProject: () => ({projectId: 'p', cwd: '/fixture'}), now: () => now, canonical: async path => {if (release === undefined && now === -1) await new Promise<void>(resolve => {release = resolve;}); return path;}, run: () => {runs++; throw Error('unexpected_run');}});
  const preview = (await service.handle({command: 'preview', projectId: 'p', operation: 'status'})).preview!;
  now = 30000;
  assert.equal((await service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true})).error, 'approval_expired');
  now = -1;
  const pending = service.handle({command: 'preview', projectId: 'p', operation: 'status'});
  await service.handle({command: 'cancel', projectId: 'p'}); release!();
  assert.equal((await pending).error, 'scope_changed'); assert.equal(runs, 0);
});
test('clear cancels active execution and suppresses its late receipt', async () => {
  let release: ((result: Awaited<ReturnType<typeof runScopedGit>['outcome']>) => void) | undefined;
  let started: (() => void) | undefined; let canceled = 0;
  const running = new Promise<void>(resolve => {started = resolve;});
  const service = createScopedCommands({activeProject: () => ({projectId: 'p', cwd: '/fixture'}), canonical: async path => path, run: () => {started!(); return {outcome: new Promise(resolve => {release = resolve;}), cancel() {canceled++;}};}});
  const preview = (await service.handle({command: 'preview', projectId: 'p', operation: 'status'})).preview!;
  const pending = service.handle({command: 'confirm', projectId: 'p', previewId: preview.previewId, confirmed: true});
  await running; service.clear(); release!({state: 'completed', exitCode: 0, stdout: 'private late result', stderr: '', outputTruncated: false, processGroupStopped: true});
  const result = await pending; assert.equal(canceled, 1); assert.equal(result.error, 'scope_changed'); assert.equal(result.receipt, undefined);
});
