import { resolveTarget, utteranceNamesLabel } from '../../../gaze/src/resolution/index.js';

type Effect = 'read' | 'local_write' | 'external';
type Step = Readonly<{ stepId: string; value: string }>;
type ProposalState = {
  proposal: {
    proposalId: string;
    requestId: string;
    targetRef: string;
    targetFingerprint: string;
    candidateId: string;
    effect: Effect;
    gazeUsed: boolean;
    confidence: number;
    basis: 'gaze' | 'named' | 'context';
    requiresConfirmation: boolean;
  };
  label: string;
  step: Step | null;
  confirmation?: Readonly<{ expiresAtMs: number }>;
  consumed: boolean;
};

type AxBridge = Readonly<{
  inspect(targetRef: string): Promise<Readonly<{ value: string; fingerprint: string }> | null>;
  setValue(input: Readonly<{ targetRef: string; value: string }>): Promise<void>;
}>;

function unexecuted(step: Step | null) {
  return step ? [{ stepId: step.stepId, status: 'unexecuted' as const, before: null, after: null, evidenceIds: [] as string[] }] : [];
}

function denied(proposalId: string, reason: string, step: Step | null) {
  return { proposalId, status: 'denied' as const, reason, steps: unexecuted(step), evidenceIds: [] as string[] };
}

function textIncludesEffect(text: string, value: string): boolean {
  return text.toLocaleLowerCase().includes(value.toLocaleLowerCase());
}

export function createGazeActionCoordinator(options: Readonly<{
  ax: AxBridge;
  now: () => Date;
  scope: unknown;
  confidenceThreshold?: number;
  autonomy?: 'observe' | 'project-partner' | 'desktop-partner' | 'host-autonomy';
}>) {
  const proposals = new Map<string, ProposalState>();
  const acceptedUtterances = new Set<string>();
  let proposalSequence = 0;
  let confirmationSequence = 0;

  return {
    async propose(input: Readonly<{
      requestId: string;
      utterance: Readonly<{ text: string; wordAt: string }>;
      candidates: readonly Readonly<{
        candidateId: string; targetRef: string; label: string; bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
        semanticScore: number; enabled: boolean;
      }>[];
      gaze: Parameters<typeof resolveTarget>[0]['gaze'];
      effect: Effect;
      step: Step | null;
    }>) {
      if (input.effect !== 'read' && !input.step) {
        return { kind: 'abstain' as const, requestId: input.requestId, reason: 'step_required' };
      }
      const resolution = resolveTarget({
        utterance: input.utterance,
        candidates: input.candidates,
        gaze: input.gaze,
        confidenceThreshold: options.confidenceThreshold ?? 0.8,
      });
      if (resolution.kind === 'abstain') {
        return { kind: 'abstain' as const, requestId: input.requestId, reason: resolution.reason };
      }
      if (resolution.kind === 'clarify') {
        const clarificationOptions = resolution.candidates.map((candidate, position) => ({
          index: position + 1,
          candidateId: candidate.candidateId,
          label: candidate.label,
        }));
        return {
          kind: 'clarify' as const,
          requestId: input.requestId,
          question: `Which target did you mean: ${clarificationOptions.map((entry) => `${entry.index}. ${entry.label}`).join(', ')}?`,
          options: clarificationOptions,
        };
      }

      const live = await options.ax.inspect(resolution.candidate.targetRef);
      if (!live) return { kind: 'abstain' as const, requestId: input.requestId, reason: 'target_unavailable' };
      const proposalId = `gaze-proposal-${++proposalSequence}`;
      const proposal = {
        proposalId,
        requestId: input.requestId,
        targetRef: resolution.candidate.targetRef,
        targetFingerprint: live.fingerprint,
        candidateId: resolution.candidate.candidateId,
        effect: input.effect,
        gazeUsed: resolution.gazeUsed,
        confidence: resolution.confidence,
        basis: resolution.basis,
        requiresConfirmation: input.effect !== 'read' && resolution.gazeUsed,
      } as const;
      proposals.set(proposalId, { proposal, label: resolution.candidate.label, step: input.step, consumed: false });
      return { kind: 'proposal' as const, proposal };
    },

    async confirm(input: Readonly<{ proposalId: string; utterance: Readonly<{ utteranceId: string; text: string }> }>) {
      const state = proposals.get(input.proposalId);
      if (!state) return { confirmed: false as const, reason: 'proposal_not_found' };
      if (state.consumed) return { confirmed: false as const, reason: 'proposal_consumed' };
      if (!utteranceNamesLabel(input.utterance.text, state.label)) {
        return { confirmed: false as const, reason: 'target_not_named' };
      }
      if (!state.step || !textIncludesEffect(input.utterance.text, state.step.value)) {
        return { confirmed: false as const, reason: 'effect_not_named' };
      }
      if (acceptedUtterances.has(input.utterance.utteranceId)) {
        return { confirmed: false as const, reason: 'confirmation_replayed' };
      }
      const confirmationId = `gaze-confirmation-${++confirmationSequence}`;
      const expiresAtMs = options.now().getTime() + 30_000;
      state.confirmation = { expiresAtMs };
      acceptedUtterances.add(input.utterance.utteranceId);
      return { confirmed: true as const, confirmationId, proposalId: input.proposalId, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    async advance(input: Readonly<{ proposalId: string }>) {
      const state = proposals.get(input.proposalId);
      if (!state) return denied(input.proposalId, 'proposal_not_found', null);
      if (state.consumed) return denied(input.proposalId, 'proposal_consumed', state.step);
      if (!state.step) return denied(input.proposalId, 'no_action', null);
      if (state.proposal.requiresConfirmation && !state.confirmation) {
        return denied(input.proposalId, 'confirmation_required', state.step);
      }
      if (state.confirmation && options.now().getTime() > state.confirmation.expiresAtMs) {
        state.consumed = true;
        return denied(input.proposalId, 'confirmation_expired', state.step);
      }
      const live = await options.ax.inspect(state.proposal.targetRef);
      if (!live || live.fingerprint !== state.proposal.targetFingerprint) {
        state.consumed = true;
        return denied(input.proposalId, 'target_identity_changed', state.step);
      }

      state.consumed = true;
      const before = live.value;
      try {
        await options.ax.setValue({ targetRef: state.proposal.targetRef, value: state.step.value });
        const afterControl = await options.ax.inspect(state.proposal.targetRef);
        if (!afterControl || afterControl.fingerprint !== state.proposal.targetFingerprint || afterControl.value !== state.step.value) {
          return {
            proposalId: input.proposalId,
            status: 'failed' as const,
            reason: 'verification_failed',
            steps: [{ stepId: state.step.stepId, status: 'failed' as const, before, after: afterControl?.value ?? null, evidenceIds: [] as string[] }],
            evidenceIds: [] as string[],
          };
        }
        const evidenceIds = [`act:before:${state.step.stepId}`, `act:after:${state.step.stepId}`];
        return {
          proposalId: input.proposalId,
          status: 'completed' as const,
          steps: [{ stepId: state.step.stepId, status: 'completed' as const, before, after: afterControl.value, evidenceIds }],
          evidenceIds,
        };
      } catch {
        return {
          proposalId: input.proposalId,
          status: 'failed' as const,
          reason: 'write_failed',
          steps: [{ stepId: state.step.stepId, status: 'failed' as const, before, after: null, evidenceIds: [] as string[] }],
          evidenceIds: [] as string[],
        };
      }
    },
  };
}
