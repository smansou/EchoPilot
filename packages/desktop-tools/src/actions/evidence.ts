/**
 * C02 evidence ids are derived from the step, never invented by a caller or a model: the preflight
 * read is `act:before:<stepId>` and the verified read-back is `act:after:<stepId>`. A step that
 * stops at a guard has no evidence at all, because no read of the granted target happened.
 */

/** The preflight read of the step's granted target. */
export function beforeEvidenceId(stepId: string): string {
  return `act:before:${stepId}`;
}

/** The post-action read-back that verified (or disagreed with) the write. */
export function afterEvidenceId(stepId: string): string {
  return `act:after:${stepId}`;
}

/** Both ids in the order they are produced: preflight read first, verified read-back second. */
export function stepEvidenceIds(stepId: string): ReadonlyArray<string> {
  return [beforeEvidenceId(stepId), afterEvidenceId(stepId)];
}
