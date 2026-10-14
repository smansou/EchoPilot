import { createHash, randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';
import type { PrivacyBoundMemoryStore } from '../../../../packages/memory/src/store/index';
import type { CompanionDialogueTurn } from './companion-answers';

export function createDialogueMemory(options: { projectId(): string | null; privateSessionId(): string | null; privacyGeneration(): number; store(): Promise<PrivacyBoundMemoryStore>; now?: () => number }) {
  const now = options.now ?? Date.now;
  return {
    async recent(projectId: string): Promise<readonly CompanionDialogueTurn[]> {
      const privacy = options.privacyGeneration();
      if (options.projectId() !== projectId || options.privateSessionId() !== null) return [];
      const store = await options.store();
      const rows = await store.readDialogue?.(projectId, { limit: 4, maxQuestionChars: 1_000, maxAnswerChars: 2_000 }) ?? [];
      if (options.projectId() !== projectId || privacy !== options.privacyGeneration() || options.privateSessionId() !== null) return [];
      return rows.map(row => ({ id: row.eventId, projectId, occurredAt: row.occurredAt, question: row.question, answer: row.answer, sourceEventIds: [row.eventId] }));
    },
    async persist(projectId: string, question: string, answer: string) {
      const privateSessionId = options.privateSessionId();
      const privacy = options.privacyGeneration();
      if (options.projectId() !== projectId) throw Error('The associated project changed.');
      if (typeof question !== 'string' || !question.trim() || question.length > 1_000 || typeof answer !== 'string' || !answer.trim()) throw Error('Invalid paired dialogue.');
      const boundedAnswer = answer.slice(0, 2_000);
      const payload = { recordType: 'companion-dialogue-v1', question, answer: boundedAnswer, text: `User: ${question} Companion: ${boundedAnswer}`.slice(0, 400) };
      const store = await options.store();
      if (options.projectId() !== projectId || privacy !== options.privacyGeneration()) throw Error('The project or privacy scope changed.');
      const eventId = `companion-dialogue-${randomUUID()}`; const instant = now(); const occurredAt = new Date(instant).toISOString();
      const event: EventEnvelope = { schemaVersion: 1, eventId, sourceId: 'desktop:companion-dialogue', sourceEventId: eventId, sourceSequence: instant, ingestSequence: instant, occurredAt, observedAt: occurredAt,
        scope: { profileId: 'local', projectId, sensitivity: 'normal' }, kind: 'agent_message', trust: 'agent_reported', payloadRef: `companion-dialogue://${eventId}`, contentHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
      await store.ingest({ events: [event], payloads: { [event.payloadRef]: payload } }, { privateSessionId });
    },
  };
}
