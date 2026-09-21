/**
 * C03 visual evidence ids are derived from the action, never invented: the pre-click fresh frame is
 * `vis:before:<actionId>` and the post-click frame is `vis:after:<actionId>`. A refusal that
 * captured nothing (a structured route, or a stale observation) reports no evidence at all.
 */

/** The fresh frame the click was derived from. */
export function beforeEvidenceId(actionId: string): string {
  return `vis:before:${actionId}`;
}

/** The fresh frame the click was verified against. */
export function afterEvidenceId(actionId: string): string {
  return `vis:after:${actionId}`;
}

/** Both frames in the order they are captured; only reached when a click was attempted. */
export function clickEvidenceIds(actionId: string): ReadonlyArray<string> {
  return [beforeEvidenceId(actionId), afterEvidenceId(actionId)];
}
