import { Buffer } from 'node:buffer';
import type { DesktopObserveResult, ForegroundEvidence } from './desktop-observe';
import type { VoiceTranscriptUpdate } from './voice-worker';

/** Explicit two-press capture; never inserts, shifts focus, or routes captured speech to an agent. */
export function createDictationCapture(options: {
  projectId(): string | null; privateActive(): boolean; muted(): boolean; privacyGeneration(): number;
  conversationEnabled(): boolean; enable(): Promise<void>; disable(): Promise<void>;
  prepare(projectId: string, text: string): Promise<void>; discardDraft?(): void; captureContext?(projectId: string): void; changed(): void;
}) {
  let epoch = 0;
  let starting = false;
  let capture: { projectId: string; privacy: number; phase: 'starting' | 'capturing' | 'preparing'; ownsConversation: boolean; parts: string[]; seen: Set<string> } | null = null;
  let message = 'Press the dictation shortcut to start; press again to prepare a draft.';
  // Retired utterances must not leak into companion routing after capture cancellation.
  const consumed = new Map<string, number>();
  const notify = () => options.changed();
  const valid = (item: NonNullable<typeof capture>) => item.projectId === options.projectId() && item.privacy === options.privacyGeneration() && !options.privateActive() && !options.muted();
  async function cancel(reason = 'Dictation capture canceled.') {
    epoch++;
    const item = capture; capture = null; options.discardDraft?.(); message = reason; notify();
    if (item?.ownsConversation && item.phase !== 'starting') await options.disable();
  }
  async function toggle() {
    if (capture) {
      const item = capture;
      if (item.phase !== 'capturing') { await cancel(); return; }
      if (!valid(item)) { await cancel(); return; }
      item.phase = 'preparing'; const token = epoch; notify();
      try {
        if (item.ownsConversation) await options.disable();
        item.ownsConversation = false;
        if (token !== epoch || capture !== item || !valid(item)) return;
        const text = item.parts.join('\n');
        if (!text.trim()) throw Error('No final transcript was captured. Try dictation again.');
        await options.prepare(item.projectId, text);
        if (token !== epoch || capture !== item || !valid(item)) return;
        capture = null; message = 'Draft prepared. Return to the target field and preview it on the floating widget.'; notify();
      } catch (error) { if (token === epoch) await cancel(error instanceof Error ? error.message : 'Dictation draft could not be prepared.'); }
      return;
    }
    if (starting) { message = 'Microphone startup is finishing. Try the shortcut again.'; notify(); return; }
    const projectId = options.projectId();
    if (!projectId || options.privateActive() || options.muted()) { message = 'Choose a project and leave private or muted mode before dictating.'; notify(); return; }
    const token = ++epoch;
    const item = { projectId, privacy: options.privacyGeneration(), phase: 'starting' as 'starting' | 'capturing' | 'preparing', ownsConversation: !options.conversationEnabled(), parts: [] as string[], seen: new Set<string>() };
    starting = true; options.discardDraft?.();
    options.captureContext?.(projectId);
    capture = item; message = 'Starting dictation capture…'; notify();
    try {
      if (item.ownsConversation) await options.enable();
      if (token !== epoch || capture !== item || !valid(item)) { if (item.ownsConversation) await options.disable(); if (capture === item) await cancel(); return; }
      item.phase = 'capturing'; message = 'Dictating locally. Press the shortcut again to prepare the draft.'; notify();
    } catch { if (item.ownsConversation) await options.disable().catch(() => undefined); if (token === epoch) await cancel('Microphone capture could not start. Review microphone permission and try again.'); }
    finally { starting = false; }
  }
  function transcript(update: VoiceTranscriptUpdate): boolean {
    const item = capture;
    if (!item || item.phase === 'preparing') return consumed.has(update.utteranceId);
    if (item.seen.has(update.utteranceId) || consumed.has(update.utteranceId) && consumed.get(update.utteranceId) !== epoch) return true;
    consumed.set(update.utteranceId, epoch);
    if (consumed.size > 512) consumed.delete(consumed.keys().next().value!);
    // A partial reserves routing ownership; its later final is still admitted exactly once.
    if (!valid(item)) { void cancel(); return true; }
    if (update.phase === 'final' && !item.seen.has(update.utteranceId)) {
      item.seen.add(update.utteranceId);
      const text = update.text.trim();
      if (text && Buffer.byteLength([...item.parts, text].join('\n'), 'utf8') > 16_384) { void cancel('Dictation exceeded its 16,384-byte bound. Capture canceled.'); return true; }
      if (text) item.parts.push(text);
    }
    return true;
  }
  return { toggle, cancel, status: () => ({ phase: capture?.phase ?? 'idle', projectId: capture?.projectId ?? null, message }), transcript };
}

/** A hotkey-start observation lease, independent of microphone startup; never persisted. */
export function createDictationScreenContext(options: {
  projectId(): string | null; privacyGeneration(): number; privateActive(): boolean;
  observe(projectId: string): Promise<DesktopObserveResult>; now?(): number;
}) {
  const now = options.now ?? Date.now;
  let generation = 0;
  let snapshot: { projectId: string; privacy: number; expiresAt: number; evidence: ForegroundEvidence } | null = null;
  function clear() { generation++; snapshot = null; }
  function valid(projectId: string, privacy: number) { return options.projectId() === projectId && options.privacyGeneration() === privacy && !options.privateActive(); }
  function get(projectId: string): ForegroundEvidence | null {
    if (!snapshot || snapshot.projectId !== projectId || now() >= snapshot.expiresAt || !valid(projectId, snapshot.privacy)) { snapshot = null; return null; }
    return structuredClone(snapshot.evidence);
  }
  async function capture(projectId: string) {
    clear(); const token = generation; const privacy = options.privacyGeneration(); const started = now();
    if (!valid(projectId, privacy)) return;
    try {
      const result = await options.observe(projectId);
      if (token !== generation || !valid(projectId, privacy) || now() >= started + 60_000 || result.outcome !== 'observed'
        || result.evidence.projectId !== projectId || !Number.isFinite(result.evidence.observedAtMs)
        || Math.abs(now() - result.evidence.observedAtMs) > 60_000) return;
      // The host's existing evidence bound is retained, with sensitive nodes excluded again before caching.
      const nodes = result.evidence.nodes.filter(node => !node.redacted && !/secure|password/i.test(`${node.role} ${node.subrole ?? ''}`));
      snapshot = { projectId, privacy, expiresAt: Math.min(started + 60_000, result.evidence.observedAtMs + 60_000), evidence: structuredClone({ ...result.evidence, nodes }) };
    } catch { /* Missing/excluded/denied screen evidence leaves raw and memory dictation available. */ }
  }
  return { capture, clear, get };
}
