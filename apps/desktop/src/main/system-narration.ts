import { createAttentionPolicy, type AttentionDecision, type AttentionPreset } from '../../../../packages/attention/src/index';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';

export type SystemSpeech = Readonly<{ id: string; eventId: string; text: string }>;

export type SystemNarration = Readonly<{
  ingest(event: EventEnvelope, payload: Record<string, unknown>): void;
  userSpeechStarted(): void;
  userSpeechEnded(): void;
  setMuted(muted: boolean): void;
  setPreset(preset: AttentionPreset): void;
  stop(): void;
}>;

function shortAgentText(text: string, verbosity = 'balanced', persona = 'balanced-partner'): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\u0000-\u001f`*_#]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const limits: Record<string, number> = { concise: 18, balanced: 34, detailed: 65, thorough: 90 };
  const words = plain.split(' ').filter(Boolean).slice(0, limits[verbosity] ?? 34);
  const opening = persona === 'brief' ? 'Agent update: ' : persona === 'engineering-direct'
    ? 'Agent reported: ' : persona === 'patient-explainer' ? 'Here is what your agent reported: ' : 'Codex replied: ';
  return (words.length > 0 ? `${opening}${words.join(' ')}${plain.split(' ').length > words.length ? '…' : ''}`
    : 'Your agent has replied. Review the details in Work.').slice(0, 500);
}

export function createSystemNarration(options: Readonly<{
  enabled(): boolean;
  speak(plan: SystemSpeech): void;
  silence(): void;
  now?: () => Date;
  verbosity?(): string;
  persona?(): string;
}>): SystemNarration {
  const policy = createAttentionPolicy(options.now ? { now: options.now } : {});
  const lastAgentText = new Map<string, string>();
  const pending = new Map<string, SystemSpeech>();
  let tickTimer: ReturnType<typeof setTimeout> | null = null;

  const deliver = (decisions: readonly AttentionDecision[]) => {
    for (const decision of decisions) {
      const plan = pending.get(decision.candidateId);
      if (!plan) continue;
      if (decision.outcome === 'spoken' && decision.lease && policy.canSpeak(decision.lease)
        && options.enabled()) options.speak(plan);
      if (decision.outcome !== 'deferred') pending.delete(decision.candidateId);
    }
    if (pending.size > 0 && !tickTimer) {
      tickTimer = setTimeout(() => { tickTimer = null; deliver(policy.tick()); }, 800);
      tickTimer.unref?.();
    }
  };

  return {
    ingest(event, payload) {
      const sessionId = event.scope.sessionId ?? event.sourceId;
      if (event.kind === 'agent_message' && typeof payload.text === 'string') {
        if (options.enabled()) {
          lastAgentText.set(sessionId, payload.text.slice(0, 16_000));
          if (lastAgentText.size > 16) lastAgentText.delete(lastAgentText.keys().next().value!);
        }
        return;
      }
      if (event.kind === 'approval_requested' && options.enabled()) {
        const candidateId = `system-narration:${event.eventId}`;
        pending.set(candidateId, { id: candidateId, eventId: event.eventId, text: 'Your agent needs approval. Review the exact request in Work before deciding.' });
        deliver(policy.submit({ candidateId, sourceId: event.sourceId, eventClass: 'blocking', eventId: event.eventId, sessionId }));
        return;
      }
      if (event.kind !== 'session_state' || payload.phase !== 'completed' || !options.enabled()) return;
      const reply = lastAgentText.get(sessionId);
      if (!reply) return;
      lastAgentText.delete(sessionId);
      const candidateId = `system-narration:${event.eventId}`;
      pending.set(candidateId, { id: candidateId, eventId: event.eventId, text: shortAgentText(reply, options.verbosity?.(), options.persona?.()) });
      deliver(policy.submit({
        candidateId,
        sourceId: event.sourceId,
        eventClass: 'turn-complete',
        eventId: event.eventId,
        sessionId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      }));
    },
    userSpeechStarted: () => { policy.userSpeechStarted(); options.silence(); },
    userSpeechEnded: () => { policy.userSpeechEnded(); if (pending.size > 0) deliver(policy.tick()); },
    setMuted(muted) { policy.updateSettings({ muted }); if (muted) options.silence(); },
    setPreset(preset) { policy.updateSettings({ preset }); },
    stop() { policy.revokeSpeech('stop-speech'); pending.clear(); lastAgentText.clear(); if (tickTimer) clearTimeout(tickTimer); tickTimer = null; options.silence(); },
  };
}
