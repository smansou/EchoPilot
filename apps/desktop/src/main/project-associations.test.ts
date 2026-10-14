import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectAssociations } from './project-associations';

test('explicit folder association survives restart without launching or authenticating any agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-association-'));
  try {
    const path = join(directory, 'profile', 'projects.json'); const registry = await createProjectAssociations(path);
    assert.equal(registry.current(), null); const selected = await registry.associate(directory);
    assert.deepEqual(registry.current(), selected); await registry.associate(directory); assert.equal(registry.list().length, 1);
    const reopened = await createProjectAssociations(path); assert.deepEqual(reopened.current(), selected);
    await assert.rejects(reopened.select('unknown'), /unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent mutations keep both associations and failed persistence never changes active scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-association-race-'));
  try {
    const a = join(directory, 'a'); const b = join(directory, 'b'); await mkdir(a); await mkdir(b);
    const path = join(directory, 'projects.json'); const registry = await createProjectAssociations(path);
    const [first, second] = await Promise.all([registry.associate(a), registry.associate(b)]);
    assert.equal(registry.list().length, 2);
    await Promise.all([registry.select(first.projectId), registry.select(second.projectId)]);
    const reopened = await createProjectAssociations(path);
    assert.deepEqual(reopened.current(), second); assert.equal(reopened.list().length, 2);
    const failing = await createProjectAssociations(path, { persist: async () => { throw Error('disk-full'); } });
    await assert.rejects(failing.select(first.projectId), /disk-full/);
    assert.deepEqual(failing.current(), second);
    await assert.rejects(failing.associate(directory), /disk-full/);
    assert.equal(failing.list().length, 2); assert.deepEqual(failing.current(), second);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
