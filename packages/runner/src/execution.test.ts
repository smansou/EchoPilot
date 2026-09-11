import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process.js';
import { parseResult, runCodex } from './codex.js';
import { isAllowedPath, validateChangedPaths, commitWorktree, createTicketWorktree, integrateCommit } from './git.js';

test('process bounds output, accepts stdin, and cancels without interaction', async () => {
  const normal = await runProcess({ command: process.execPath, args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d));process.stderr.write("x".repeat(1000))'], input: 'hello', cwd: process.cwd(), maxOutputBytes: 64 });
  assert.equal(normal.code, 0); assert.equal(normal.stdout, 'hello'); assert.equal(normal.stderr.length, 64);
  const timeout = await runProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), timeoutMs: 30 });
  assert.equal(timeout.timedOut, true);
  const abort = new AbortController(); abort.abort();
  assert.equal((await runProcess({ command: 'does-not-exist', args: [], cwd: process.cwd(), signal: abort.signal })).aborted, true);
});
test('ownership rejects control files and traversal, validates result shape', () => {
  assert.equal(isAllowedPath('apps/widget/a.ts', ['apps/widget/**']), true);
  for (const file of ['../secret', 'packages/runner/a.ts', '.runner/state.json', 'scripts/runner.mjs', 'apps/progress/index.html', 'packages/RUNNER/a.ts', 'apps/AGENTS.md', 'apps/.gitattributes', 'scripts/build-progress.mjs']) assert.equal(isAllowedPath(file, ['packages', 'apps', 'scripts', '.runner', '..']), false);
  assert.throws(() => parseResult({ verdict: 'approve', summary: 'ok', issues: [1] }, 'reviewer'));
});
test('fake Codex invocation parses structured output and exposes usage without content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-codex-'));
  try {
    const command = join(directory, 'fake-codex');
    await writeFile(command, `#!${process.execPath}\nconst fs=require('fs'); const a=process.argv;fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({verdict:'approve',summary:'checked',issues:[]}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:4,output_tokens:3},secret:'not forwarded'}));`, { mode: 0o700 });
    const events: unknown[] = []; let spawnedPid = 0;
    const result = await runCodex({ command, cwd: directory, outputDirectory: directory, prompt: 'test only', model: 'fake', effort: 'low', role: 'reviewer', onSpawn: pid => { spawnedPid = pid; }, onEvent: event => events.push(event) });
    assert.equal(result.process.code, 0); assert.equal((result.result as { verdict: string }).verdict, 'approve');
    assert.deepEqual(result.usage, { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 });
    assert.ok(!JSON.stringify(events).includes('secret'));
    assert.ok(Number.isSafeInteger(spawnedPid) && spawnedPid > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('isolated worktree commit integrates only allowed changes into clean branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echopilot-git-'));
  const git = async (...args: string[]) => { const result = await runProcess({ command: 'git', args, cwd: directory }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  try {
    await git('init', '-b', 'codex/test'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Fixture');
    await writeFile(join(directory, '.gitignore'), '.runner/\n'); await git('add', '.gitignore'); await git('commit', '-m', 'fixture');
    const tree = await createTicketWorktree({ repository: directory, ticketId: 'A01', attempt: 1, baseRef: 'HEAD' });
    await mkdir(join(tree.path, 'apps')); await writeFile(join(tree.path, 'apps', 'fixture.ts'), 'export const value=1;\n');
    assert.deepEqual(await validateChangedPaths(tree.path, ['apps']), ['apps/fixture.ts']);
    const committed = await commitWorktree({ worktree: tree.path, allowedPaths: ['apps'], message: 'test change', baseRef: tree.baseCommit });
    const integrated = await integrateCommit({ repository: directory, expectedBranch: 'codex/test', commit: committed.commit });
    assert.equal(integrated.integrated, true);
    assert.equal(await git('status', '--porcelain'), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('quota errors preserve provider diagnosis and trigger the circuit callback', async () => {
 const directory=await mkdtemp(join(tmpdir(),'echopilot-quota-'));
 try{
  const command=join(directory,'fake-codex');
  await writeFile(command,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again later."}}));process.exitCode=1;`,{mode:0o700});
  const failures:string[]=[];
  const result=await runCodex({command,cwd:directory,outputDirectory:directory,prompt:'fixture',model:'fake',effort:'low',role:'worker',onFailure:(_message,kind)=>failures.push(kind)});
  assert.equal(result.failureKind,'quota');assert.match(result.error!,/usage limit/);assert.deepEqual(failures,['quota']);assert.equal(result.result,null);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('silent worker is cancelled before its overall execution deadline',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'echopilot-stall-'));
 try{
  const command=join(directory,'fake-codex');
  await writeFile(command,`#!${process.execPath}\nsetInterval(()=>{},1000);`,{mode:0o700});
  const result=await runCodex({command,cwd:directory,outputDirectory:directory,prompt:'fixture',model:'fake',effort:'low',role:'worker',idleTimeoutMs:100,timeoutMs:5000});
  assert.equal(result.failureKind,'stalled');assert.equal(result.process.aborted,true);assert.equal(result.process.timedOut,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
