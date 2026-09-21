/**
 * C04 capture sampling — the frequency/energy budget between a desktop observation and a capture
 * (IMPLEMENTATION_PLAN.md §7.2 C04; BACKLOG C04 acceptance criteria 2 and 3).
 *
 * `createCaptureSampler({ policy })` freezes the decision every desktop observation gets before the
 * raw window boundary is touched, so a no-change period can never turn into a capture or a model
 * call, and a change can never be lost to a budget:
 *
 * - the first signature ever seen is a change; a signature that differs from the last observed one
 *   is a change; a repeated signature is `{ capture: false, reason: 'unchanged' }`;
 * - a change that a budget blocks stays *pending*, so the newest state is admitted as soon as a
 *   budget allows it — a deferred change is never silently dropped, it is retried on the next
 *   observation (the deferred signature is admitted at the exact instant the window frees);
 * - the rolling one-hour cap and the minimum interval are `frequency`; the rolling 24 h energy
 *   budget (one `captureCostMs` per admitted capture) is `energy`; the frequency windows are
 *   checked first, so a change blocked by both reports `frequency`;
 * - an admitted capture consumes `captureCostMs`; a throttled or unchanged observation consumes
 *   nothing, so an exhausted budget is not silently charged by no-change ticks;
 * - `stop()` is permanent and idempotent: every later observation is `{ capture: false, reason:
 *   'stopped' }` regardless of signature. Revocation and private sessions use it, and it never
 *   resets or leaks budget state, so a stopped sampler can never admit another capture.
 *
 * The sampler is pull-based and stateless outside this module: callers decide *which* desktop
 * observations are admissible (excluded applications and activity outside an explicit work session
 * never reach it), and the sampler decides whether an admissible change is captured yet.
 */

/** One rolling hour in milliseconds: the window `maxCapturesPerHour` is measured over. */
export const ROLLING_HOUR_MS = 3_600_000;
/** One rolling day in milliseconds: the window `maxEnergyMsPerDay` is measured over. */
export const ROLLING_DAY_MS = 86_400_000;

/** The capture budget from the session configuration. */
export type SamplingPolicy = Readonly<{
  minIntervalMs: number;
  maxCapturesPerHour: number;
  maxEnergyMsPerDay: number;
  captureCostMs: number;
}>;

/** The decision for one observation. `budget` is present only on a throttled decision. */
export type SamplingDecision = Readonly<{
  capture: boolean;
  reason: 'changed' | 'unchanged' | 'throttled' | 'stopped';
  budget?: 'frequency' | 'energy';
}>;

/** One desktop observation: its identity signature and the clock instant it was seen at. */
export type CaptureObservation = Readonly<{ atMs: number; signature: string }>;

export type CaptureSampler = Readonly<{
  observe(observation: CaptureObservation): SamplingDecision;
  stop(): void;
}>;

export function createCaptureSampler(options: Readonly<{ policy: SamplingPolicy }>): CaptureSampler {
  const { policy } = options;
  let stopped = false;
  let lastObservedSignature: string | undefined;
  let lastAdmittedSignature: string | undefined;
  let admittedAtMs: Array<number> = [];

  function admittedIn(atMs: number, windowMs: number): number {
    let count = 0;
    for (const candidate of admittedAtMs) if (candidate > atMs - windowMs && candidate <= atMs) count += 1;
    return count;
  }

  function throttled(budget: 'frequency' | 'energy'): SamplingDecision {
    return { capture: false, reason: 'throttled', budget };
  }

  return {
    observe(observation: CaptureObservation): SamplingDecision {
      if (stopped) return { capture: false, reason: 'stopped' };
      const { atMs, signature } = observation;
      // The newest state is still unadmitted while a throttled change is pending, so a repeat of
      // that signature is the retry of the change, not a fresh no-change observation.
      const pending = lastObservedSignature !== lastAdmittedSignature;
      const changed = lastObservedSignature === undefined || signature !== lastObservedSignature || pending;
      lastObservedSignature = signature;
      // Observations are monotonic; a capture older than the energy window can never bind again.
      admittedAtMs = admittedAtMs.filter((candidate) => candidate > atMs - ROLLING_DAY_MS);
      if (!changed) return { capture: false, reason: 'unchanged' };

      const lastAdmittedAt = admittedAtMs[admittedAtMs.length - 1];
      if (lastAdmittedAt !== undefined && atMs - lastAdmittedAt < policy.minIntervalMs) {
        return throttled('frequency');
      }
      if (admittedIn(atMs, ROLLING_HOUR_MS) >= policy.maxCapturesPerHour) return throttled('frequency');
      const energyInRollingDay = admittedIn(atMs, ROLLING_DAY_MS) * policy.captureCostMs;
      if (energyInRollingDay + policy.captureCostMs > policy.maxEnergyMsPerDay) return throttled('energy');

      admittedAtMs.push(atMs);
      lastAdmittedSignature = signature;
      return { capture: true, reason: 'changed' };
    },
    stop(): void {
      stopped = true;
    },
  };
}
