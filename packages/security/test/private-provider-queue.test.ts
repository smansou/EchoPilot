import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecurityKernel } from '../src/index';
import { createFileKernelStorage } from '../src/storage';
import type { Operation } from '../src/types';

test('live provider queue retains exact prompt without persisting it; legacy restart queue is scrubbed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-provider-queue-')); const path = join(directory, 'kernel.json');
  const canary = 'PRIVATE-PROVIDER-PROMPT-CANARY'; const sent: string[] = [];
  const dependencies = { storage: createFileKernelStorage(path), secrets: { get: async () => null, put: async () => {}, delete: async () => {} },
    capture: { invoke: async () => ({ artifactRef: 'test://unused' }) }, provider: { complete: async (request: { prompt: string }) => { sent.push(request.prompt); return { text: 'Answer' }; } } };
  const operation: Operation = { requestId: 'private-question', capability: 'provider_egress', resource: { providerId: 'openai', projectId: 'project' }, dataCategory: 'project_memory_summary', destination: 'provider', effect: 'external', arguments: { prompt: canary }, idempotencyKey: 'private-question' };
  try {
    const kernel = createSecurityKernel(dependencies);
    await kernel.grantCapability({ subject: 'user', capability: operation.capability, resource: operation.resource, dataCategory: operation.dataCategory, destination: operation.destination, effect: operation.effect, lifetime: 'once' });
    await kernel.enqueue(operation);
    assert.equal((await readFile(path, 'utf8')).includes(canary), false);
    assert.equal((await kernel.runTargeted(operation.requestId))?.status, 'completed'); assert.deepEqual(sent, [canary]);
    await kernel.enqueue({ ...operation, requestId: 'cancelled-private', idempotencyKey: 'cancelled-private' });
    kernel.clearProviderRequests();
    await kernel.grantCapability({ subject: 'user', capability: operation.capability, resource: operation.resource, dataCategory: operation.dataCategory, destination: operation.destination, effect: operation.effect, lifetime: 'once' });
    assert.equal(await kernel.runTargeted('cancelled-private'), undefined);
    await Promise.all(Array.from({ length: 8 }, (_, index) => kernel.enqueue({ ...operation, requestId: `concurrent-${index}`, idempotencyKey: `concurrent-${index}` })));
    const concurrentFile = JSON.parse(await readFile(path, 'utf8')); assert.equal(concurrentFile.queue.length, 0);
    assert.equal((await readFile(path, 'utf8')).includes(canary), false);
    kernel.clearProviderRequests();
    const legacy = JSON.parse(await readFile(path, 'utf8')); legacy.queue = [operation]; await writeFile(path, JSON.stringify(legacy));
    const reopened = createSecurityKernel(dependencies); await reopened.ready();
    assert.equal((await readFile(path, 'utf8')).includes(canary), false);
    assert.equal(await reopened.runTargeted(operation.requestId), undefined); assert.deepEqual(sent, [canary]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
