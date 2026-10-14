import { createHash, randomUUID } from 'node:crypto';
import type { PrivacyBoundMemoryStore, TimelineItem } from '../../../../packages/memory/src/store/index';
import type { EventEnvelope } from '../../../../packages/contracts/src/index';

export type MemoryNotePreview = { id: string; projectId: string; text: string; sourceId: string | null; sourceEventIds: readonly string[]; expiresAt: number };
export type MemoryRecordView = TimelineItem & { revisionOf?: string; supersededBy?: string; semanticCoverage: 'partial' };
const hash = (item: TimelineItem) => createHash('sha256').update(JSON.stringify([item.id, item.summary, item.sourceEventIds])).digest('hex');
export function describeMemoryRecords(timeline: readonly TimelineItem[]): MemoryRecordView[] {
  const result: MemoryRecordView[] = timeline.map(item => ({ ...item, semanticCoverage: 'partial' }));
  for (const item of result) {
    if (item.trust !== 'user_explicit') continue;
    const match = /^User correction \[([^\]]+)\] — /.exec(item.summary);
    if (!match) continue;
    try { item.revisionOf = decodeURIComponent(match[1]!); } catch { continue; }
    const old = result.find(source => source.id === item.revisionOf);
    if (old && (!old.supersededBy || result.find(row => row.id === old.supersededBy)!.occurredAt <= item.occurredAt)) old.supersededBy = item.id;
  }
  return result;
}
/** Explicit notes/revisions persist as user decisions through the encrypted store, without semantic sidecars. */
export function createMemoryRecordsHost(options: { activeProjectId(): string | null; store(): Promise<PrivacyBoundMemoryStore>; privateSessionId?(): string | null; now?: () => number }) {
  const now = options.now ?? Date.now; let pending: (MemoryNotePreview & { fingerprint: string | null }) | null = null;
  let generation = 0;
  function scoped(projectId: string) { if (!projectId || options.activeProjectId() !== projectId) throw Error('Choose this active project before changing memory.'); }
  async function list(projectId: string): Promise<MemoryRecordView[]> {
    scoped(projectId); const store = await options.store(); const timeline = await store.timeline({ projectId }); scoped(projectId);
    return describeMemoryRecords(timeline);
  }
  async function preview(projectId: string, text: string, sourceId: string | null): Promise<MemoryNotePreview> {
    scoped(projectId);
    const revision = generation;
    if (typeof text !== 'string' || !text.trim() || text.length > 180) throw Error('Enter a note or correction under 180 characters.');
    if (sourceId !== null && (typeof sourceId !== 'string' || sourceId.length > 128 || encodeURIComponent(sourceId).length > 150)) throw Error('Choose a visible source memory with a bounded identifier.');
    const store = await options.store(); const timeline = sourceId ? await store.timeline({ projectId }) : [];
    const source = sourceId ? timeline.find(item => item.id === sourceId) : undefined;
    if (sourceId && !source) throw Error('That source memory is no longer available in this project.');
    scoped(projectId);
    if (revision !== generation) throw Error('Privacy changed. Review the note again.');
    const view: MemoryNotePreview = { id: randomUUID(), projectId, text: text.trim(), sourceId, sourceEventIds: source?.sourceEventIds ?? [], expiresAt: now() + 60_000 };
    pending = { ...view, fingerprint: source ? hash(source) : null }; return view;
  }
  async function confirm(projectId: string, id: string) {
    scoped(projectId);
    if (!pending || pending.id !== id || pending.projectId !== projectId || pending.expiresAt <= now()) throw Error('That memory review is no longer pending.');
    const review = pending; pending = null;
    const revision = generation;
    const capturedPrivate = options.privateSessionId?.();
    const store = await options.store();
    if (review.sourceId) { const source = (await store.timeline({ projectId })).find(item => item.id === review.sourceId); if (!source || hash(source) !== review.fingerprint) throw Error('The source memory changed or was forgotten. Review again.'); }
    scoped(projectId);
    if (revision !== generation) throw Error('Privacy changed. Review the note again.');
    const eventId = `memory-note-${randomUUID()}`; const instant = new Date(now()).toISOString();
    const question = review.sourceId ? `User correction [${encodeURIComponent(review.sourceId)}]` : 'User note';
    const payload = { question, choice: review.text, text: review.text, decidingActor: 'user', correctionOf: review.sourceId, sourceEventIds: review.sourceEventIds, extractionVersion: 'user-authored-v1', semanticCoverage: 'partial' };
    const privateSessionId = capturedPrivate ?? store.privacy.privateSessions.openSessions()[0];
    const event: EventEnvelope = { schemaVersion: 1, eventId, sourceId: 'desktop:user-memory', sourceEventId: eventId, sourceSequence: now(), ingestSequence: now(), occurredAt: instant, observedAt: instant,
      scope: { profileId: 'local', projectId, sensitivity: 'normal' }, kind: 'decision', trust: 'user_explicit', payloadRef: `user-memory://${eventId}`, contentHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    await store.ingest({ events: [event], payloads: { [event.payloadRef]: payload } }, { privateSessionId: privateSessionId ?? null });
    return { eventId, semanticCoverage: 'partial', private: !!privateSessionId };
  }
  function cancel(projectId: string, id: string) { scoped(projectId); if (!pending || pending.id !== id || pending.projectId !== projectId) throw Error('That memory review is no longer pending.'); pending = null; return { canceled: true }; }
  return { list, preview, confirm, cancel, clear() { generation++; pending = null; } };
}
