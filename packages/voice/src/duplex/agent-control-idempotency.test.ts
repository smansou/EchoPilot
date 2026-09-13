/**
 * Regression coverage for the Section 5.6 delivery ledger.
 *
 * The frozen oracle redelivers one `requestId` immediately, which a bounded "remember the last N
 * receipts" cache satisfies by accident. A routed request may be redelivered after any number of
 * newer requests, so these cases pin the obligation that actually has to hold: once a `requestId`
 * was handed to the managed-agent port, no later delivery of that same `requestId` — however far
 * behind it is — may create a second instruction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDuplexController } from './index.js';
import type { DuplexAgentPort, DuplexController, DuplexOutputPort } from './index.js';

type Interrupt = Readonly<{ turnId: string; reason: string }>;

type Harness = Readonly<{
  controller: DuplexController;
  interrupts: Interrupt[];
}>;

/**
 * The device side is irrelevant here, so it is a silent stub; the harness records exactly what the
 * managed-agent port observed. `deliver` lets a case model a slow or failing adapter.
 */
function createHarness(deliver?: DuplexAgentPort['interrupt']): Harness {
  const interrupts: Interrupt[] = [];
  const output: DuplexOutputPort = {
    speaking: () => true,
    cursorMs: () => 0,
    duck: () => {},
    restore: () => {},
    pause: () => {},
    stop: () => {},
  };
  const agent: DuplexAgentPort = {
    interrupt: async (request) => {
      interrupts.push({ turnId: request.turnId, reason: request.reason });
      return deliver === undefined ? 'acknowledged' : deliver(request);
    },
  };
  const controller = createDuplexController({ clock: { now: () => 0 }, output, agent });
  return { controller, interrupts };
}

test('a redelivered requestId is never delivered again, however many newer requests follow', async () => {
  const { controller, interrupts } = createHarness();
  const first = await controller.submitAgentControl({
    requestId: 'ctl-dup',
    turnId: 'turn-1',
    reason: 'user_requested_interrupt',
  });
  for (let index = 0; index < 1_024; index += 1) {
    await controller.submitAgentControl({
      requestId: `ctl-${index}`,
      turnId: 'turn-1',
      reason: `filler-${index}`,
    });
  }
  assert.equal(interrupts.length, 1_025, 'each of the 1,024 newer requests is delivered once');

  const redelivered = await controller.submitAgentControl({
    requestId: 'ctl-dup',
    turnId: 'turn-1',
    reason: 'user_requested_interrupt',
  });
  assert.equal(
    interrupts.length,
    1_025,
    'a redelivery after 1,024 newer requests must not create a second interrupt',
  );
  assert.equal(
    interrupts.filter((request) => request.reason === 'user_requested_interrupt').length,
    1,
    'the original requestId was delivered exactly once',
  );
  assert.deepEqual(redelivered, first, 'the redelivery resolves the original observed receipt');
});

test('concurrent redeliveries of one requestId share a single delivery', async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { controller, interrupts } = createHarness(async () => {
    await gate;
    return 'acknowledged';
  });

  const request = { requestId: 'ctl-concurrent', turnId: 'turn-7', reason: 'user_requested_interrupt' };
  const pending = Promise.all([
    controller.submitAgentControl(request),
    controller.submitAgentControl(request),
    controller.submitAgentControl(request),
  ]);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(interrupts.length, 1, 'one delivery is in flight while the adapter works');

  release();
  const [first, second, third] = await pending;
  assert.equal(interrupts.length, 1, 'concurrent redeliveries must not interrupt more than once');
  assert.deepEqual(first, { requestId: 'ctl-concurrent', turnId: 'turn-7', status: 'acknowledged' });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test('a failed delivery stays explicitly unknown and a redelivery cannot send a second interrupt', async () => {
  const { controller, interrupts } = createHarness(async () => {
    throw new Error('adapter timed out');
  });
  const request = { requestId: 'ctl-timeout', turnId: 'turn-9', reason: 'user_requested_interrupt' };
  const first = await controller.submitAgentControl(request);
  assert.deepEqual(first, { requestId: 'ctl-timeout', turnId: 'turn-9', status: 'unknown' });

  const redelivered = await controller.submitAgentControl(request);
  assert.equal(interrupts.length, 1, 'the failed delivery is not retried as a second instruction');
  assert.deepEqual(redelivered, first, 'the redelivery reuses the observed unknown receipt');
});
