/**
 * C03 evidence ids are derived from the action, never invented by an extension or a model: the
 * preflight structured read is `int:before:<actionId>` and the verifying read-back is
 * `int:after:<actionId>`. A message that is denied before the connector is touched produces
 * neither, because no state was ever read.
 */

/** The preflight structured read of the target. */
export function beforeEvidenceId(actionId: string): string {
  return `int:before:${actionId}`;
}

/** The read-back that verified (or disagreed with) the structured write. */
export function afterEvidenceId(actionId: string): string {
  return `int:after:${actionId}`;
}

/** A read capability performs exactly one structured read: the preflight id and no read-back. */
export function readEvidenceIds(actionId: string): ReadonlyArray<string> {
  return [beforeEvidenceId(actionId)];
}

/** A write capability performs the preflight read and the verified read-back, in that order. */
export function writeEvidenceIds(actionId: string): ReadonlyArray<string> {
  return [beforeEvidenceId(actionId), afterEvidenceId(actionId)];
}
