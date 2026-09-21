/**
 * C02 — voice action → proposal → grant → AX execution → verified result
 * (IMPLEMENTATION_PLAN.md §7.2 C02; §5.9 action lifecycle and execution security; §5.4
 * read/navigate/click/type/select/scroll through AX).
 *
 * `createDesktopActionService({ ax, now, scope })` is the seam between a recognized voice request
 * and the native Accessibility session. It guarantees:
 *
 * - a voice request only ever becomes a proposal: `propose` is inert (no AX read and no AX write),
 *   its argument hash binds the ordered steps (operation, target ref, target fingerprint, value),
 *   the declared effect, and the explicit project scope, and its id is derived from that binding —
 *   a replayed idempotency key returns the same proposal and a changed argument is refused;
 * - nothing executes without the voice grant: `authorize` binds the proposal's argument hash and
 *   expires at most 30 s later (§5.9), an unauthorized `advance` performs zero AX writes and names
 *   `not_authorized`, and a grant past its expiry names `grant_expired` before any AX work;
 * - each `advance` preflights exactly one step against the live control — the granted fingerprint,
 *   the enabled state, and the focus state are re-checked for every step, not once per action — and
 *   any guard stops the step with zero writes, the step reported `unexecuted`, and no evidence;
 * - a step that reaches AX is verified by a read-back, never by the write call returning: the
 *   preflight read is `act:before:<stepId>`, the read-back is `act:after:<stepId>`, and a value the
 *   application did not apply is reported `failed` with `verification_failed` instead of completed;
 * - `cancel` stops the remaining steps between steps: the receipt reports which steps completed and
 *   which stayed unexecuted, and a cancelled action never resumes or reaches AX again;
 * - a stopped step stays unexecuted rather than failed, so a later `advance` after fresh state (or
 *   a fresh grant) can preflight it again, while a verification failure is terminal because blindly
 *   repeating a write whose application is unknown is exactly the duplicate action S02 forbids.
 *
 * The clock is injected: every timestamp and expiry in a proposal, authorization, or receipt comes
 * from `now`, so the same scenario replays byte-stable. The native counterpart of this seam is
 * `native/macos/Sources/Accessibility`, which performs the same preflight, single write, and
 * read-back against real `AXUIElement` state.
 */
import type { Scope } from '../../../contracts/src/index.js';
import {
  MAX_AUTHORIZATION_MS,
  argumentHashFor,
  authorizationIdFor,
  proposalIdFor,
} from './arguments.js';
import { stepEvidenceIds } from './evidence.js';
import {
  authorizationStopReason,
  targetStopReason,
  type LiveAuthorization,
} from './guards.js';
import type {
  DesktopActionAuthorization,
  DesktopActionAuthorizationInput,
  DesktopActionCancelInput,
  DesktopActionEffect,
  DesktopActionOptions,
  DesktopActionOutcome,
  DesktopActionProposal,
  DesktopActionProposeInput,
  DesktopActionService,
  DesktopActionStep,
  DesktopActionAdvanceInput,
  DesktopStepOutcome,
  DesktopStepStatus,
} from './types.js';

export type {
  DesktopActionAuthorization,
  DesktopActionAuthorizationInput,
  DesktopActionCancelInput,
  DesktopActionAdvanceInput,
  DesktopActionEffect,
  DesktopActionOptions,
  DesktopActionOutcome,
  DesktopActionProposal,
  DesktopActionProposeInput,
  DesktopActionService,
  DesktopActionStatus,
  DesktopActionStep,
  DesktopActionStopReason,
  DesktopActionUtterance,
  DesktopAxBridge,
  DesktopAxControl,
  DesktopStepOutcome,
  DesktopStepStatus,
} from './types.js';
export { MAX_AUTHORIZATION_MS, argumentHashFor, canonicalJson, sha256Hex } from './arguments.js';
export { afterEvidenceId, beforeEvidenceId, stepEvidenceIds } from './evidence.js';
export { authorizationStopReason, targetStopReason } from './guards.js';

/** Internal per-step record; the receipt projection is what callers see. */
type InternalStep = {
  step: DesktopActionStep;
  status: 'pending' | 'completed' | 'failed';
  before: string | null;
  after: string | null;
  evidenceIds: string[];
};

/** A guard stop that left the action resumable; it is what the next receipt names. */
type InternalStop = Readonly<{ status: 'denied'; reason: NonNullable<DesktopActionOutcome['reason']> }>;

type InternalProposal = {
  proposal: DesktopActionProposal;
  effect: DesktopActionEffect;
  idempotencyKey: string;
  status: 'proposed' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  steps: InternalStep[];
  authorization: LiveAuthorization | null;
  stop: InternalStop | null;
};

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`C02: ${field} must be a non-empty string`);
  }
  return value;
}

function requireEffect(value: unknown): DesktopActionEffect {
  if (value !== 'read' && value !== 'local_write' && value !== 'external') {
    throw new TypeError(`C02: unsupported action effect ${String(value)}`);
  }
  return value;
}

/**
 * A proposal's steps are the only thing the grant binds, so they are validated before hashing:
 * non-empty, one `set_value` operation each, unique step ids, and a string value (clearing a field
 * is a legitimate empty string, so an empty `value` is allowed even though the refs are not).
 */
function validateSteps(steps: ReadonlyArray<DesktopActionStep>): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError('C02: a proposal needs at least one step');
  }
  const seen = new Set<string>();
  for (const step of steps) {
    requireText(step?.stepId, 'step.stepId');
    if (step.operation !== 'set_value') {
      throw new TypeError(`C02: unsupported step operation ${String(step.operation)}`);
    }
    requireText(step.targetRef, `step ${step.stepId} targetRef`);
    requireText(step.targetFingerprint, `step ${step.stepId} targetFingerprint`);
    if (typeof step.value !== 'string') {
      throw new TypeError(`C02: step ${step.stepId} value must be a string`);
    }
    if (seen.has(step.stepId)) {
      throw new TypeError(`C02: duplicate step id ${step.stepId}`);
    }
    seen.add(step.stepId);
  }
}

function validateUtterance(utterance: Readonly<{ utteranceId: string; text: string }> | undefined): void {
  requireText(utterance?.utteranceId, 'utterance.utteranceId');
  requireText(utterance?.text, 'utterance.text');
}

export function createDesktopActionService(options: DesktopActionOptions): DesktopActionService {
  const { ax, scope } = options;
  const proposals = new Map<string, InternalProposal>();
  const byIdempotencyKey = new Map<string, InternalProposal>();
  let grantSequence = 0;

  function nowMs(): number {
    const at = options.now().getTime();
    if (!Number.isFinite(at)) {
      throw new TypeError('C02: the injected clock returned an invalid date');
    }
    return at;
  }

  function requireProposal(proposalId: string): InternalProposal {
    requireText(proposalId, 'proposalId');
    const found = proposals.get(proposalId);
    if (found === undefined) {
      throw new TypeError(`C02: unknown proposal ${proposalId}`);
    }
    return found;
  }

  /**
   * Project the full action state into a receipt. Completed work is always reported with its
   * evidence; a pending step is `unexecuted` with null values and no evidence, whether it was never
   * reached, was stopped by a guard, or was cancelled; a failed step keeps the disagreeing reads.
   */
  function receiptFor(record: InternalProposal): DesktopActionOutcome {
    const steps: DesktopStepOutcome[] = record.steps.map((entry) => entry.status === 'pending'
      ? {
        stepId: entry.step.stepId,
        status: 'unexecuted' as DesktopStepStatus,
        before: null,
        after: null,
        evidenceIds: [] as ReadonlyArray<string>,
      }
      : {
        stepId: entry.step.stepId,
        status: entry.status,
        before: entry.before,
        after: entry.after,
        evidenceIds: [...entry.evidenceIds],
      });
    const base = {
      actionId: record.proposal.actionId,
      proposalId: record.proposal.proposalId,
      steps,
      evidenceIds: steps.flatMap((entry) => [...entry.evidenceIds]),
    };
    switch (record.status) {
      case 'completed':
        return { ...base, status: 'completed' };
      case 'failed':
        return { ...base, status: 'failed', reason: 'verification_failed' };
      case 'cancelled':
        return { ...base, status: 'cancelled', reason: 'cancelled_by_user' };
      default:
        return record.stop === null
          ? { ...base, status: 'in_progress' }
          : { ...base, status: 'denied', reason: record.stop.reason };
    }
  }

  async function propose(input: DesktopActionProposeInput): Promise<DesktopActionProposal> {
    const actionId = requireText(input?.actionId, 'actionId');
    const idempotencyKey = requireText(input?.idempotencyKey, 'idempotencyKey');
    const effect = requireEffect(input?.effect);
    validateUtterance(input?.utterance);
    const steps: ReadonlyArray<DesktopActionStep> = [...(input?.steps ?? [])];
    validateSteps(steps);

    const argumentHash = await argumentHashFor({ actionId, effect, scope, steps });
    const replay = byIdempotencyKey.get(idempotencyKey);
    if (replay !== undefined) {
      if (replay.proposal.actionId !== actionId || replay.proposal.argumentHash !== argumentHash) {
        throw new TypeError(
          `C02: idempotency key ${idempotencyKey} is already bound to different arguments`,
        );
      }
      return replay.proposal;
    }

    const proposalId = await proposalIdFor({ scope, actionId, idempotencyKey, argumentHash });
    const proposal: DesktopActionProposal = {
      proposalId,
      actionId,
      state: 'proposed',
      argumentHash,
      scope,
    };
    const record: InternalProposal = {
      proposal,
      effect,
      idempotencyKey,
      status: 'proposed',
      steps: steps.map((step) => ({
        step,
        status: 'pending',
        before: null,
        after: null,
        evidenceIds: [],
      })),
      authorization: null,
      stop: null,
    };
    proposals.set(proposalId, record);
    byIdempotencyKey.set(idempotencyKey, record);
    return proposal;
  }

  async function authorize(
    input: DesktopActionAuthorizationInput,
  ): Promise<DesktopActionAuthorization> {
    const record = requireProposal(input?.proposalId);
    validateUtterance(input?.utterance);
    const issuedAtMs = nowMs();

    if (record.status !== 'proposed' && record.status !== 'in_progress') {
      // A grant never re-opens decided work: completed, failed, and cancelled actions stay decided.
      const refusedId = await authorizationIdFor({
        proposalId: record.proposal.proposalId,
        argumentHash: record.proposal.argumentHash,
        utteranceId: input.utterance.utteranceId,
        issuedAtMs,
        sequence: grantSequence,
      });
      return {
        authorizationId: refusedId,
        proposalId: record.proposal.proposalId,
        authorized: false,
        argumentHash: record.proposal.argumentHash,
        expiresAt: new Date(issuedAtMs).toISOString(),
      };
    }

    grantSequence += 1;
    const expiresAtMs = issuedAtMs + MAX_AUTHORIZATION_MS;
    const authorizationId = await authorizationIdFor({
      proposalId: record.proposal.proposalId,
      argumentHash: record.proposal.argumentHash,
      utteranceId: input.utterance.utteranceId,
      issuedAtMs,
      sequence: grantSequence,
    });
    const authorization: LiveAuthorization = {
      authorizationId,
      proposalId: record.proposal.proposalId,
      authorized: true,
      argumentHash: record.proposal.argumentHash,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    record.authorization = authorization;
    // A fresh grant clears the previous guard stop so the step can be preflighted again.
    record.stop = null;
    return {
      authorizationId,
      proposalId: authorization.proposalId,
      authorized: true,
      argumentHash: authorization.argumentHash,
      expiresAt: authorization.expiresAt,
    };
  }

  async function advance(input: DesktopActionAdvanceInput): Promise<DesktopActionOutcome> {
    const record = requireProposal(input?.proposalId);
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
      // Decided actions never execute again; the stored receipt is returned unchanged.
      return receiptFor(record);
    }

    const stopped = authorizationStopReason(record.authorization, nowMs());
    if (stopped !== null) {
      record.stop = { status: 'denied', reason: stopped };
      return receiptFor(record);
    }

    const entry = record.steps.find((candidate) => candidate.status === 'pending');
    if (entry === undefined) {
      record.status = 'completed';
      record.stop = null;
      return receiptFor(record);
    }

    // Preflight: the live control is read here, and that read is the step's before evidence.
    const control = await ax.inspect(entry.step.targetRef);
    if (control === null) {
      record.stop = { status: 'denied', reason: 'target_identity_changed' };
      return receiptFor(record);
    }
    const blocked = targetStopReason(entry.step, control);
    if (blocked !== null) {
      record.stop = { status: 'denied', reason: blocked };
      return receiptFor(record);
    }

    const before = control.value;
    await ax.setValue({ targetRef: entry.step.targetRef, value: entry.step.value });
    const readBack = await ax.inspect(entry.step.targetRef);
    const after = readBack === null ? null : readBack.value;
    const evidenceIds = [...stepEvidenceIds(entry.step.stepId)];

    if (after !== entry.step.value) {
      // The application accepted the AX call but the read-back disagrees: not a verified result.
      entry.status = 'failed';
      entry.before = before;
      entry.after = after;
      entry.evidenceIds = evidenceIds;
      record.status = 'failed';
      record.stop = null;
      return receiptFor(record);
    }

    entry.status = 'completed';
    entry.before = before;
    entry.after = after;
    entry.evidenceIds = evidenceIds;
    record.stop = null;
    record.status = record.steps.some((candidate) => candidate.status === 'pending')
      ? 'in_progress'
      : 'completed';
    return receiptFor(record);
  }

  async function cancel(input: DesktopActionCancelInput): Promise<DesktopActionOutcome> {
    const record = requireProposal(input?.proposalId);
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
      // Cancelling cannot rewrite a decided action: the receipt stays exactly as it was.
      return receiptFor(record);
    }
    record.status = 'cancelled';
    record.stop = null;
    return receiptFor(record);
  }

  return { propose, authorize, advance, cancel };
}
