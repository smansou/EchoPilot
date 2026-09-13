/**
 * A01 capture budget (plan §5.4: "Limit initial AX traversal to 500 nodes and 100 ms").
 *
 * The budget is frozen and shared with the helper on every `captureContext` request, so the native
 * traversal stops on its own terms instead of discovering the bound after the fact.
 */
export const AX_CAPTURE_BUDGET: Readonly<{ maxNodes: number; maxTraversalMs: number }> = Object.freeze({
  maxNodes: 500,
  maxTraversalMs: 100,
});
