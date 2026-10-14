import { randomUUID } from 'node:crypto';
import { openDesktopActionSession, type DesktopActionSession } from './desktop-dictation';

type Operation = 'click' | 'select' | 'scroll' | 'navigate';
type NativeState = {appBundleId: string; role: string; label: string; fingerprint: string; value: string; enabled: boolean; focused: boolean};
export type DesktopActionPreview = {previewId: string; projectId: string; operation: Operation; direction: string; app: string; role: string; label: string; targetRef: string; expiresAt: number};
export type DesktopActionResult = {ok: boolean; error?: string; prepared?: boolean; preview?: DesktopActionPreview; receipt?: unknown; historyStored?: boolean};
export type DesktopActionHistory = {kind: 'desktop_action'; projectId: string; source: 'native_ax_receipt'; actionId: string; app: string; role: string; targetRef: string; operation: Operation; timestamp: string; status: string; verification: string; evidenceIds: readonly string[]};
type Options = {bundleDir: string; activeProjectId(): string | null; now?(): number; openSession?(): DesktopActionSession; onReceipt?(receipt: DesktopActionHistory): Promise<void> | void};
function record(value: unknown): Record<string, unknown> {if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('malformed_response'); return value as Record<string, unknown>;}
function state(value: unknown): NativeState {
  const candidate = record(value);
  if (candidate.secure === true || candidate.role === 'AXSecureTextField' || candidate.subrole === 'AXSecureTextField') throw Error('secure_field');
  for (const key of ['appBundleId','role','label','fingerprint','value']) if (typeof candidate[key] !== 'string' || Buffer.byteLength(candidate[key] as string) > 16_384) throw Error('unsupported_target');
  if (candidate.enabled !== true || candidate.focused !== true) throw Error('target_not_focused');
  return candidate as unknown as NativeState;
}
/** Each preview names exactly the externally focused control; no arbitrary target or coordinate is accepted. */
export function createDesktopActions(options: Options) {
  const now = options.now ?? Date.now;
  const open = options.openSession ?? (() => openDesktopActionSession(options.bundleDir));
  let draft: {projectId: string; operation: Operation; direction: string; expiresAt: number} | null = null;
  let pending: {view: DesktopActionPreview; before: NativeState} | null = null;
  let busy = false;
  let disposed = false;
  let activeSession: DesktopActionSession | null = null;
  let generation = 0;
  function clear() {generation++; draft = null; pending = null; activeSession?.close(); activeSession = null;}
  function scope(value: unknown): string {const project = options.activeProjectId(); if (typeof value !== 'string' || !project || value !== project || value.length > 256) throw Error('inactive_project'); return value;}
  return {
    clear,
    dispose() {disposed = true; clear();},
    async handle(payload: unknown): Promise<DesktopActionResult> {
      let session: DesktopActionSession | null = null;
      let claimed = false;
      const started = generation;
      async function live<T>(work: Promise<T>): Promise<T> {const result = await work; if (generation !== started || disposed) throw Error('cleared'); return result;}
      try {
        if (disposed) throw Error('disposed');
        const request = record(payload);
        const projectId = scope(request.projectId);
        if (busy) throw Error('busy'); busy = true; claimed = true;
        if (request.command === 'status') return {ok: true, prepared: draft?.projectId === projectId && now() <= draft.expiresAt, ...(pending?.view.projectId === projectId && now() <= pending.view.expiresAt ? {preview: pending.view} : {})};
        if (request.command === 'cancel') {draft = null; pending = null; return {ok: true};}
        if (request.command === 'prepareAction') {
          if (!['click','select','scroll','navigate'].includes(String(request.operation))) throw Error('unsupported_action');
          const direction = request.operation === 'scroll' ? String(request.direction) : '';
          if (request.operation === 'scroll' && !['up','down','left','right'].includes(direction)) throw Error('unsupported_action');
          draft = {projectId, operation: request.operation as Operation, direction, expiresAt: now() + 120_000}; pending = null;
          return {ok: true, prepared: true};
        }
        if (request.command === 'previewPrepared') {
          if (!draft || draft.projectId !== projectId || now() > draft.expiresAt) throw Error('draft_missing');
          session = open(); activeSession = session;
          const focused = record(await live(session.request({operation: 'focused-control'})));
          if (typeof focused.targetRef !== 'string' || !/^ax:\d+:(?:\d+(?:\.\d+)*)?$/.test(focused.targetRef)) throw Error('unsupported_target');
          const before = state(focused.state);
          const permitted: Record<Operation, readonly string[]> = {click: ['AXButton','AXCheckBox','AXRadioButton','AXMenuItem','AXPopUpButton'], select: ['AXMenuItem','AXRow','AXCell'], scroll: ['AXScrollArea','AXTextArea','AXList','AXOutline'], navigate: ['AXTextField','AXTextArea','AXButton','AXRow','AXCell']};
          if (!permitted[draft.operation].includes(before.role)) throw Error('unsupported_target');
          scope(projectId);
          const view: DesktopActionPreview = {previewId: randomUUID(), projectId, operation: draft.operation, direction: draft.direction, app: before.appBundleId, role: before.role, label: before.label, targetRef: focused.targetRef, expiresAt: now() + 30_000};
          pending = {view, before}; return {ok: true, preview: view};
        }
        if (request.command !== 'confirm' || request.confirmed !== true) throw Error('confirmation_required');
        const item = pending; pending = null;
        if (!item || item.view.projectId !== projectId || request.previewId !== item.view.previewId) throw Error('preview_missing');
        if (now() > item.view.expiresAt) throw Error('preview_expired');
        session = open(); activeSession = session;
        const current = state(await live(session.request({operation: 'inspect', targetRef: item.view.targetRef})));
        if (current.fingerprint !== item.before.fingerprint || current.value !== item.before.value) throw Error('stale_target');
        const actionScope = {profileId: 'local', projectId, sensitivity: 'normal'};
        const proposal = record(await live(session.request({operation: 'propose', scope: actionScope, actionId: item.view.previewId, idempotencyKey: item.view.previewId,
          utterance: {utteranceId: item.view.previewId, text: `${item.view.operation} explicitly selected focused control`}, effect: item.view.operation === 'click' || item.view.operation === 'select' ? 'external' : 'local_write',
          steps: [{stepId: 'action', operation: item.view.operation, targetRef: item.view.targetRef, targetFingerprint: current.fingerprint, value: item.view.direction, expectedValue: item.before.value}]})));
        scope(projectId);
        const grant = record(await live(session.request({operation: 'authorize', scope: actionScope, proposalId: proposal.proposalId, utterance: {utteranceId: randomUUID(), text: 'Explicit mouse confirmation of displayed action'}})));
        if (grant.authorized !== true) throw Error('native_denied');
        scope(projectId);
        const receipt = record(await live(session.request({operation: 'advance', scope: actionScope, proposalId: proposal.proposalId})));
        if (receipt.status !== 'completed') return {ok: false, error: typeof receipt.reason === 'string' ? receipt.reason : 'verification_failed', receipt};
        draft = null;
        const steps = Array.isArray(receipt.steps) ? receipt.steps : [];
        const verification = steps.length ? record(steps[0]).verification : 'none';
        const evidenceIds = Array.isArray(receipt.evidenceIds) ? receipt.evidenceIds.filter((id): id is string => typeof id === 'string' && id.length <= 256).slice(0, 16) : [];
        let historyStored = false;
        if (options.onReceipt) {
          try {await options.onReceipt({kind: 'desktop_action', projectId, source: 'native_ax_receipt', actionId: item.view.previewId, app: item.view.app, role: item.view.role, targetRef: item.view.targetRef, operation: item.view.operation, timestamp: new Date(now()).toISOString(), status: 'completed', verification: typeof verification === 'string' ? verification : 'none', evidenceIds}); historyStored = true;} catch {}
        }
        if (generation !== started) throw Error('cleared');
        return {ok: true, receipt, historyStored};
      } catch (error) {
        const allowed = new Set(['cleared','busy','disposed','inactive_project','unsupported_action','draft_missing','secure_field','unsupported_target','target_not_focused','stale_target','preview_missing','preview_expired','confirmation_required','helper_missing','native_denied']);
        const message = error instanceof Error ? error.message : '';
        return {ok: false, error: allowed.has(message) ? message : 'native_error'};
      } finally {session?.close(); if (claimed) {busy = false; activeSession = null;}}
    },
  };
}
