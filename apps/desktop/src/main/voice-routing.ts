import { randomUUID } from 'node:crypto';
import { createRoutingState } from '../../../../packages/routing/src/state/index';
import { parseCommand, parseExplicitPrefix } from '../../../../packages/routing/src/grammar';
import type { ManagedWork, WorkSession } from './managed-work';
import type { VoiceTranscriptUpdate } from './voice-worker';
import type { createCompanionAnswers, CompanionSnapshot } from './companion-answers';

export type VoicePending = Readonly<{ kind: 'agent_instruction'; id: string; sessionId: string | null; projectId: string | null; instruction: string; candidates: readonly string[]; expiresAt: number }>;
export type VoiceRoutingSnapshot = Readonly<{ enabled: boolean; sessionId: string | null; pending: VoicePending | null; companion: CompanionSnapshot | null; message: string; dispatching: boolean }>;

/** No persistence, ambient credentials, captures or provider grants: only explicitly scoped Work. */
export function createVoiceRouting(options: {
  work: ManagedWork;
  stopSpeech(): void;
  stopListening(): Promise<void>;
  companion?: ReturnType<typeof createCompanionAnswers>;
  now?: () => number;
  autoAnswerAllowed?(projectId: string): boolean;
  consumeAutoAnswer?(projectId: string): boolean;
}) {
  const now = options.now ?? Date.now;
  const router = createRoutingState({ sessions: [], now: () => new Date(now()) });
  let enabled = false;
  let sessionId: string | null = null;
  let pending: VoicePending | null = null;
  let message = 'Choose a session and enable voice review.';
  let dispatching = false;
  const seen = new Set<string>();
  function eligible(): readonly WorkSession[] { return options.work.list().filter(s => s.active && s.authenticated && s.compatible); }
  function requireTarget(id: string): WorkSession {
    const target = eligible().find(s => s.id === id);
    if (!target) throw new Error('That voice scope is no longer active and authenticated.');
    return target;
  }
  function snapshot(): VoiceRoutingSnapshot {
    if (pending && pending.expiresAt <= now()) { pending = null; message = 'Voice review expired. Please repeat your request.'; }
    if (sessionId && !options.work.list().some(s => s.id === sessionId && s.active)) { enabled = false; sessionId = null; pending = null; message = 'Voice scope ended. Choose an active session.'; }
    if (enabled && sessionId && !eligible().some(s => s.id === sessionId)) { enabled = false; pending = null; message = 'Sign-in must be refreshed before enabling voice delivery.'; }
    return { enabled, sessionId, pending: pending ? { ...pending, candidates: [...pending.candidates] } : null, companion: options.companion?.snapshot() ?? null, message, dispatching };
  }
  function configure(id: string | null, on: boolean): VoiceRoutingSnapshot {
    if (on && !id) throw new Error('Select an active signed-in Work session first.');
    if (id) {
      const target = on ? requireTarget(id) : options.work.list().find(s => s.id === id && s.active);
      if (!target) throw new Error('That Work project is no longer active.');
      router.setProject(target.projectId);
    }
    // A changed scope or an explicit disable invalidates all prior authorizations.
    if (sessionId !== id || !on) pending = null;
    sessionId = id; enabled = on;
    message = on ? 'Voice review enabled. Spoken requests require confirmation before sending.' : 'Voice review is off.';
    return snapshot();
  }
  async function confirm(id: string, targetId: string): Promise<VoiceRoutingSnapshot> {
    snapshot();
    const review = pending;
    if (!enabled || !review || review.id !== id || dispatching) throw new Error('That voice review is no longer pending.');
    if (targetId !== sessionId || (review.sessionId && targetId !== review.sessionId)
      || !review.candidates.includes(targetId)) throw new Error('Choose the reviewed session as your voice scope first.');
    const target = requireTarget(targetId);
    if (review.projectId && target.projectId !== review.projectId) throw new Error('The reviewed project changed.');
    // Consume synchronously before awaiting; double-clicks and duplicate confirmations never send twice.
    pending = null; dispatching = true;
    try {
      await options.work.refreshAuth();
      if (!enabled || sessionId !== targetId || review.expiresAt <= now()) throw new Error('The voice scope or review changed before delivery.');
      requireTarget(targetId);
      await options.work.send(targetId, review.instruction);
      message = `Request acknowledged by ${target.label}.`;
    } catch (error) { message = error instanceof Error ? error.message : 'Voice delivery failed.'; throw error; }
    finally { dispatching = false; }
    return snapshot();
  }
  function cancel(id: string): VoiceRoutingSnapshot {
    if (!pending || pending.id !== id) throw new Error('That voice review is no longer pending.');
    pending = null; message = 'Voice request canceled.'; return snapshot();
  }
  async function transcript(update: VoiceTranscriptUpdate): Promise<VoiceRoutingSnapshot> {
    snapshot();
    if (update.phase !== 'final' || !update.text.trim() || seen.has(update.utteranceId)) return snapshot();
    seen.add(update.utteranceId);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
    const text = update.text.trim();
    // Emergency controls work even with review off. Speech controls never interrupt agent work.
    if (/^(?:stop|pause|stop speaking|quiet|silence)[.!?]?$/i.test(text)) { options.stopSpeech(); return snapshot(); }
    if (/^(?:mute|pause listening|stop listening)[.!?]?$/i.test(text)) {
      options.companion?.clear();
      configure(sessionId, false); options.stopSpeech(); await options.stopListening(); return snapshot();
    }
    if (/^stop all[.!?]?$/i.test(text)) {
      pending = null; options.companion?.clear(); options.stopSpeech();
      const results = await Promise.allSettled(eligible().filter(s => s.currentTurnId).map(s => options.work.interrupt(s.id)));
      message = results.some(r => r.status === 'rejected') ? 'Some managed turns could not confirm interruption.' : 'Managed turn interruptions acknowledged; external work may still run.';
      return snapshot();
    }
    if (/^confirm answer request[.!?]?$/i.test(text) && options.companion) {
      const review = options.companion.snapshot().pending;
      if (!review) { message = 'No companion answer is pending confirmation.'; return snapshot(); }
      pending = null; await options.companion.confirm(review.id); message = options.companion.snapshot().message; return snapshot();
    }
    if (/^cancel(?: (?:that|request|answer))?[.!?]?$/i.test(text)) { pending = null; options.companion?.clear(); message = 'Voice request canceled.'; return snapshot(); }
    // Companion questions need an explicitly associated project, never agent authentication.
    const explicit = parseExplicitPrefix(text);
    const question = explicit?.destination === 'companion' ? explicit.rest : text;
    if (options.companion && (!explicit || explicit.destination === 'companion') && /^(?:what|why|how|when|where|who|is|are|did|does|can|tell me|do we)\b/i.test(question)) {
      router.setActiveSessions(eligible().map(s => ({ sessionId: s.id, projectId: s.projectId, label: s.label, active: true, harness: 'codex' })));
      const destination = router.route({ utteranceId: update.utteranceId, text });
      if (!destination.hold && !destination.quotedContent && !destination.modeChange && !destination.dictation && destination.destination !== 'harness' && parseCommand(question)?.kind !== 'instruction') {
        pending = null; await options.companion.preview(question, { includeScreen: /\b(?:on my screen|on screen|looking at)\b/i.test(question) });
        const review = options.companion.snapshot().pending;
        if (review && options.autoAnswerAllowed?.(review.projectId) === true && options.consumeAutoAnswer?.(review.projectId) === true) await options.companion.confirm(review.id);
        message = options.companion.snapshot().message; return snapshot();
      }
    }
    if (!enabled || !sessionId) return snapshot();
    if (/^confirm send request[.!?]?$/i.test(text)) {
      if (!pending) { message = 'No spoken request is pending confirmation.'; return snapshot(); }
      if (!pending.sessionId) { message = 'Choose the intended session before confirming this request.'; return snapshot(); }
      return confirm(pending.id, pending.sessionId);
    }
    if (/^cancel(?: (?:that|request))?[.!?]?$/i.test(text)) { pending = null; message = 'Voice request canceled.'; return snapshot(); }
    if (/^stop (?:agent|work|codex)[.!?]?$/i.test(text)) {
      pending = null; const target = requireTarget(sessionId);
      if (target.currentTurnId) { await options.work.interrupt(target.id); message = 'Managed turn interruption acknowledged.'; }
      else message = 'No managed turn is running in this scope.';
      return snapshot();
    }
    if (/^(?:do (?:that|it)|send (?:that|it)|that one|the other one)[.!?]?$/i.test(text)) {
      message = 'Please name the session and say the complete request; that reference is ambiguous.';
      return snapshot();
    }
    router.setActiveSessions(eligible().map(s => ({ sessionId: s.id, projectId: s.projectId, label: s.label, active: true, harness: 'codex' })));
    const decision = router.route({ utteranceId: update.utteranceId, text });
    if (decision.hold || decision.quotedContent || decision.modeChange || decision.dictation) return snapshot();
    const prefix = parseExplicitPrefix(text);
    const command = parseCommand(prefix?.destination === 'harness' ? prefix.rest : text);
    const instruction = command?.kind === 'instruction' ? command.task : text;
    if (command && command.kind !== 'instruction') { message = 'Please say the complete request and name its session.'; return snapshot(); }
    if (decision.destination !== 'harness' && router.mode().kind !== 'agent_direct') {
      // Companion questions stay local; ordinary scoped instructions can still be reviewed explicitly.
      if (/^(what|why|how|when|where|who|is|are|tell me)\b/i.test(text) || decision.destination !== 'companion') {
        message = 'This speech stays with the companion. Use Work to send a request.'; return snapshot();
      }
    }
    const targetId = decision.targetSessionId ?? (decision.requiresClarification ? null : sessionId);
    const candidates = decision.requiresClarification ? [...(decision.candidates ?? eligible().map(s => s.id))] : [targetId!];
    if (targetId && targetId !== sessionId) { message = 'This request names another session. Select that voice scope and repeat it.'; return snapshot(); }
    const target = targetId ? requireTarget(targetId) : null;
    options.companion?.clear();
    pending = { kind: 'agent_instruction', id: randomUUID(), sessionId: targetId, projectId: target?.projectId ?? null, instruction, candidates, expiresAt: now() + 30_000 };
    message = target ? `Review the request for ${target.label}, then confirm Send.` : 'Which session did you mean? Choose the intended session for this request.';
    return snapshot();
  }
  return { snapshot, configure, confirm, cancel, transcript };
}
