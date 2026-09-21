/**
 * C04 acceptance oracle (capture-sampling half) — no-change periods and the frequency/energy
 * budgets (IMPLEMENTATION_PLAN.md §7.2 C04; BACKLOG C04 acceptance criteria 2 and 3).
 *
 * `packages/capture/src/sampling/index.ts` must export (this file freezes these names):
 *
 *   createCaptureSampler({ policy }) → CaptureSampler
 *
 *     policy — the capture budget from the session configuration:
 *       { minIntervalMs, maxCapturesPerHour, maxEnergyMsPerDay, captureCostMs }
 *     sampler:
 *       observe({ atMs, signature }) → SamplingDecision
 *         One desktop observation. `signature` is the observation's identity (app + document +
 *         focused control + window title + content revision). The first signature seen is a change;
 *         a signature that differs from the last observed one is a change; a repeated signature is
 *         'unchanged'. A change that a budget blocks stays *pending*, so the newest state is
 *         admitted as soon as a budget allows it — a deferred change is never silently dropped.
 *         Decision =
 *           { capture: true,  reason: 'changed' }
 *         | { capture: false, reason: 'unchanged' }
 *         | { capture: false, reason: 'throttled', budget: 'frequency' | 'energy' }
 *         | { capture: false, reason: 'stopped' }
 *         Budget order: the minimum interval and the rolling one-hour capture cap are 'frequency';
 *         the rolling 24 h energy budget (one `captureCostMs` per admitted capture) is 'energy'.
 *         An admitted capture consumes `captureCostMs`; a throttled observation consumes nothing.
 *       stop() → void
 *         Stops the sampler: every later observation is { capture: false, reason: 'stopped' },
 *         regardless of signature, and the sampler never admits another capture. Revocation and
 *         private sessions use this, so it must be permanent and idempotent.
 *
 * The cases below are the fixture's `samplerProbe` (fixtures/desktop/history/README.md): synthetic
 * timestamps and signatures only, no real screen content. This oracle pins an exact decision per
 * observation so a no-change tick can never turn into a model call, and a change can never be lost
 * to a budget.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FIXTURE_URL = new URL('../../../../fixtures/desktop/history/c04-day-replay.json', import.meta.url);
const ROLLING_DAY_MS = 86_400_000;
const ROLLING_HOUR_MS = 3_600_000;

type SamplingPolicy = Readonly<{
  minIntervalMs: number;
  maxCapturesPerHour: number;
  maxEnergyMsPerDay: number;
  captureCostMs: number;
}>;
type SamplingDecision = Readonly<{
  capture: boolean;
  reason: 'changed' | 'unchanged' | 'throttled' | 'stopped';
  budget?: 'frequency' | 'energy';
}>;
type CaptureSampler = Readonly<{
  observe(observation: Readonly<{ atMs: number; signature: string }>): SamplingDecision;
  stop(): void;
}>;
type CaptureSamplingModule = Readonly<{
  createCaptureSampler(options: Readonly<{ policy: SamplingPolicy }>): CaptureSampler;
}>;

type ProbeObservation = Readonly<{
  label: string;
  atOffsetMs: number;
  signature: string;
  capture: boolean;
  reason: SamplingDecision['reason'];
  budget?: 'frequency' | 'energy';
}>;
type ProbeCase = Readonly<{
  policy: SamplingPolicy;
  observations: ReadonlyArray<ProbeObservation>;
}>;
type Fixture = Readonly<{ samplerProbe: Readonly<Record<string, ProbeCase>> }>;

const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as Fixture;

function probeCase(key: string): ProbeCase {
  const probe = fixture.samplerProbe[key];
  assert.ok(probe, `fixture ${FIXTURE_URL.pathname} is missing samplerProbe.${key}`);
  return probe;
}

const MISSING_BEHAVIOR = 'C04 required capture sampling behavior is not implemented yet: '
  + 'packages/capture/src/sampling/index.ts must export createCaptureSampler({ policy }) returning '
  + 'observe({ atMs, signature }) → SamplingDecision and stop() over the frozen sampling seam.';

/** Until the implementation exists every test fails with the missing behavior, never an import crash. */
function missingModule(detail: string): CaptureSamplingModule {
  return {
    createCaptureSampler(): never {
      assert.fail(`${MISSING_BEHAVIOR} ${detail}`);
    },
  };
}

async function loadCaptureSamplingModule(): Promise<CaptureSamplingModule> {
  // The specifier is assembled at runtime so a missing implementation is reported as missing
  // behavior instead of a resolution crash that hides what the oracle is waiting for.
  const specifier = ['.', 'index.js'].join('/');
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    return missingModule(`importing ${specifier} failed: ${(error as Error).message}`);
  }
  if (typeof loaded.createCaptureSampler !== 'function') {
    return missingModule('createCaptureSampler is not exported');
  }
  return loaded as unknown as CaptureSamplingModule;
}

const sampling = await loadCaptureSamplingModule();

type ProbeRun = Readonly<{
  sampler: CaptureSampler;
  decisions: ReadonlyArray<Readonly<{ observation: ProbeObservation; decision: SamplingDecision }>>;
}>;

/** Replays one probe case; `stopBefore` is the label of the observation stopped before. */
function runProbe(probe: ProbeCase, stopBefore?: string): ProbeRun {
  const sampler = sampling.createCaptureSampler({ policy: probe.policy });
  const decisions: Array<Readonly<{ observation: ProbeObservation; decision: SamplingDecision }>> = [];
  for (const observation of probe.observations) {
    if (stopBefore !== undefined && observation.label === stopBefore) sampler.stop();
    decisions.push({ observation, decision: sampler.observe({ atMs: observation.atOffsetMs, signature: observation.signature }) });
  }
  return { sampler, decisions };
}

function assertExactDecisions(run: ProbeRun): void {
  for (const { observation, decision } of run.decisions) {
    assert.equal(decision.capture, observation.capture, `${observation.label}: capture decision`);
    assert.equal(decision.reason, observation.reason, `${observation.label}: reason`);
    assert.equal(decision.budget, observation.budget, `${observation.label}: budget`);
  }
}

function admittedOffsets(run: ProbeRun): ReadonlyArray<number> {
  return run.decisions.filter(({ decision }) => decision.capture).map(({ observation }) => observation.atOffsetMs);
}

test('C04 sampling: a change is admitted at most once per min interval and per rolling hour', () => {
  const probe = probeCase('frequencyCase');
  const run = runProbe(probe);
  assertExactDecisions(run);

  const admitted = admittedOffsets(run);
  assert.equal(
    run.decisions.filter(({ observation, decision }) => decision.capture && observation.atOffsetMs < ROLLING_HOUR_MS).length,
    probe.policy.maxCapturesPerHour,
    'the rolling hour admits the per-hour cap and no more',
  );
  assert.ok(
    run.decisions.filter(({ observation }) => observation.reason === 'unchanged').length >= 2,
    'a repeated signature never captures',
  );
  const throttled = run.decisions.filter(({ decision }) => decision.reason === 'throttled');
  assert.equal(throttled.length, 3, 'the min interval twice and the hourly cap once block a change');
  assert.ok(
    throttled.every(({ decision }) => decision.budget === 'frequency'),
    'the min interval and the hourly cap are both frequency budgets',
  );
  for (let index = 1; index < admitted.length; index += 1) {
    const previous = admitted[index - 1] ?? 0;
    const current = admitted[index] ?? 0;
    assert.ok(current - previous >= probe.policy.minIntervalMs, 'no two admitted captures break the min interval');
  }
  for (let index = 0; index < admitted.length; index += 1) {
    const at = admitted[index] ?? 0;
    const inHour = admitted.filter((candidate) => candidate > at - ROLLING_HOUR_MS && candidate <= at).length;
    assert.ok(inHour <= probe.policy.maxCapturesPerHour, 'no rolling hour exceeds the capture cap');
  }

  // The change the min interval blocked is not lost: the same signature is admitted at the moment
  // the interval allows it, and the hourly cap frees again when the rolling window moves on.
  const retried = run.decisions.find(({ observation }) => observation.label === 'pending-change-retried-at-min-interval');
  assert.ok(retried, 'the probe declares the deferred change');
  assert.equal(retried.decision.capture, true);
  const refreshed = run.decisions.find(({ observation }) => observation.label === 'hour-window-refresh');
  assert.ok(refreshed, 'the probe declares the hourly-window refresh');
  assert.equal(refreshed.decision.capture, true);
});

test('C04 sampling: the 24 h energy budget stops capture until the rolling day frees it', () => {
  const probe = probeCase('energyCase');
  const run = runProbe(probe);
  assertExactDecisions(run);

  const admitted = admittedOffsets(run);
  for (const at of admitted) {
    const inDay = admitted.filter((candidate) => candidate > at - ROLLING_DAY_MS && candidate <= at).length;
    assert.ok(inDay * probe.policy.captureCostMs <= probe.policy.maxEnergyMsPerDay, 'the rolling day never exceeds the energy budget');
  }
  const energyThrottles = run.decisions.filter(({ decision }) => decision.budget === 'energy');
  assert.equal(energyThrottles.length, 2, 'the energy budget, never a frequency budget, blocks these changes');
  assert.ok(
    energyThrottles.every(({ decision }) => decision.reason === 'throttled'),
    'an exhausted energy budget reports throttled, not unchanged',
  );
  const refreshed = run.decisions.find(({ observation }) => observation.label === 'energy-window-refresh');
  assert.ok(refreshed, 'the probe declares the energy-window refresh');
  assert.equal(refreshed.decision.capture, true, 'the next rolling day frees the energy budget again');
});

test('C04 sampling: stop() ends capture permanently without disturbing budget state', () => {
  const probe = probeCase('stopCase');
  const firstStopped = probe.observations[1];
  assert.ok(firstStopped, 'the probe declares the first stopped observation');
  const run = runProbe(probe, firstStopped.label);
  assertExactDecisions(run);

  assert.equal(run.decisions[0]?.decision.capture, true, 'the capture before the stop is admitted');
  assert.ok(
    run.decisions.slice(1).every(({ decision }) => decision.capture === false && decision.reason === 'stopped'),
    'after stop() even a changed signature reports stopped',
  );
  run.sampler.stop();
  const last = probe.observations[probe.observations.length - 1];
  const after = run.sampler.observe({ atMs: last?.atOffsetMs ?? 0, signature: 'state-after-stop' });
  assert.equal(after.reason, 'stopped', 'stop() is idempotent and permanent');
});
