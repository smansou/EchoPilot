import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedAttachments, createClaudeChildTransport } from './managed-attachments';

test('private mode refuses a persistent Claude send before creating its child transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-private-')); let privateMode = true; let starts = 0;
  const service = createManagedAttachments({ directory: join(directory, 'attachments'), activeProject: () => ({ projectId: 'p', cwd: directory }), isPrivate: () => privateMode,
    authStatus: async () => true, onEvent: async () => {}, transport: () => { starts++; throw Error('must not start'); } });
  try {
    const attachment = await service.add('p', 'managed');
    await assert.rejects(service.send('p', attachment.id, 'Private audio instruction'), /cannot disable session history/); assert.equal(starts, 0);
    privateMode = false;
    await assert.rejects(service.send('p', attachment.id, 'Explicit public instruction'), /must not start/); assert.equal(starts, 1);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('actual fake stdio child produces Claude message/result without credentials or paid requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-attachment-')); let selected: { projectId: string; cwd: string } | null = { projectId: 'p', cwd: directory };
  const ingested: string[] = [];
  const childCode = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',l=>{const input=JSON.parse(l);if(input.type==='user'){console.log(JSON.stringify({type:'assistant',session_id:'fake',message:{content:[{type:'text',text:'Fake child result'}]}}));console.log(JSON.stringify({type:'result',session_id:'fake',is_error:false}));}})`;
  const service = createManagedAttachments({ directory: join(directory, 'attachments'), activeProject: () => selected, authStatus: async () => true,
    onEvent: async (event, payload) => { ingested.push(`${event.scope.projectId}:${event.kind}:${payload.text}`); },
    transport: input => createClaudeChildTransport({ ...input, command: process.execPath, args: ['-e', childCode] }),
  });
  try {
    const session = await service.add('p', 'managed'); assert.equal(session.authenticated, true);
    await service.send('p', session.id, 'Run the fake task');
    const deadline = Date.now() + 2_000;
    while (service.list()[0]?.receipt !== 'completed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.list()[0]!.receipt, 'completed'); assert.equal(service.list()[0]!.currentTurnId, null);
    assert.ok(ingested.includes('p:agent_message:Fake child result'));
    selected = null; await assert.rejects(service.send('p', session.id, 'wrong scope'), /active Work project/);
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('observe-only attachment cannot send and scoped hook install/remove preserves unrelated settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-hooks-'));
  const service = createManagedAttachments({ directory: join(directory, 'attachments'), activeProject: () => ({ projectId: 'p', cwd: directory }), onEvent: async () => {} });
  try {
    await mkdir(join(directory, '.claude')); await writeFile(join(directory, '.claude', 'settings.local.json'), JSON.stringify({ unrelated: true, hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'existing-safe-command' }] }] } }));
    const session = await service.add('p', 'observe'); await assert.rejects(service.send('p', session.id, 'Execute imported instructions'), /cannot send/);
    await service.hooks('p', session.id, true);
    const settings = JSON.parse(await readFile(join(directory, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(settings.hooks.Stop.some((entry: { hooks: { command: string }[] }) => entry.hooks[0]!.command.includes('ELECTRON_RUN_AS_NODE=1')));
    await service.hooks('p', session.id, false);
    const after = JSON.parse(await readFile(join(directory, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(after.unrelated, true); assert.equal(after.hooks.Stop[0].hooks[0].command, 'existing-safe-command');
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
});
