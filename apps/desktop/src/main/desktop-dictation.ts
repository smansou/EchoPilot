import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { desktopObserveDiagnostics } from './desktop-observe';
import { createDictationGlossary } from '../../../../packages/capture/src/glossary/store';
import type { DictationGlossaryEntry } from '../../../../packages/capture/src/glossary/model';

export type DictationTarget = Readonly<{appBundleId: string; windowTitle: string; role: string; label: string; value: string; enabled: boolean; focused: boolean; fingerprint: string; selection?: Readonly<{location: number; length: number}>}>;
export type DictationPreview = Readonly<{previewId: string; projectId: string; text: string; target: string; app: string; label: string; expiresAt: number; kind: 'insert' | 'undo'}>;
export type DictationResult = Readonly<{ok: boolean; error?: string; preview?: DictationPreview; receipt?: unknown; prepared?: boolean; undoAvailable?: boolean; draftText?: string; entries?: readonly DictationGlossaryEntry[]}>;
export type DesktopActionSession = { request(request: Record<string, unknown>): Promise<unknown>; close(): void };
export type DictationOptions = {bundleDir: string; activeProjectId(): string | null; isPrivate?(): boolean; glossaryDirectory?: string; now?(): number; openSession?(): DesktopActionSession};
type Pending = {view: DictationPreview; state: DictationTarget; before: string; after: string};
const MAX_TEXT_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 196_608;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('malformed_response');
  return value as Record<string, unknown>;
}
function targetState(value: unknown, selectionValue?: unknown): DictationTarget {
  const raw = record(value);
  for (const key of ['appBundleId', 'windowTitle', 'role', 'label', 'value', 'fingerprint']) {
    if (typeof raw[key] !== 'string' || Buffer.byteLength(raw[key] as string) > MAX_TEXT_BYTES) throw Error('unsupported_target');
  }
  if (!['AXTextField', 'AXTextArea'].includes(raw.role as string) || raw.secure === true || raw.subrole === 'AXSecureTextField') throw Error('unsupported_target');
  if (raw.enabled !== true || raw.focused !== true) throw Error('target_not_focused');
  const candidate = selectionValue ?? raw.selection;
  if (candidate !== undefined) {
    const selection = record(candidate);
    if (!Number.isSafeInteger(selection.location) || !Number.isSafeInteger(selection.length)
      || (selection.location as number) < 0 || (selection.length as number) < 0
      || (selection.location as number) + (selection.length as number) > (raw.value as string).length) throw Error('unsupported_target');
  }
  return (candidate === undefined ? raw : {...raw, selection: candidate}) as unknown as DictationTarget;
}

/** One bounded private stdio session; proposals and grants share the same native service instance. */
export function openDesktopActionSession(bundleDir: string): DesktopActionSession {
  const diagnostics = desktopObserveDiagnostics({bundleDir});
  if (!diagnostics.helperPath) throw Error('helper_missing');
  const child = spawn(diagnostics.helperPath, [], {stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '';
  let closed = false;
  let waiter: {resolve(value: unknown): void; reject(error: Error): void} | null = null;
  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    waiter?.reject(Error('helper_closed'));
    waiter = null;
    child.kill('SIGKILL');
  }
  const deadline = setTimeout(close, 10_000);
  deadline.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) { close(); return; }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const current = waiter; waiter = null;
    if (!current || buffer.trim()) { current?.reject(Error('malformed_response')); close(); return; }
    try {
      const response = record(JSON.parse(line));
      if (response.ok !== true) throw Error(typeof response.error === 'string' && response.error.includes('secure_field') ? 'secure_field' : 'native_denied');
      const payload = record(response.result).payload;
      if (typeof payload !== 'string') throw Error('malformed_response');
      current.resolve(JSON.parse(payload));
    } catch (error) { current.reject(error instanceof Error ? error : Error('malformed_response')); close(); }
  });
  child.stderr.resume();
  child.on('error', close);
  child.on('exit', close);
  return {close, request: async (request) => {
    if (closed || waiter) throw Error('helper_unavailable');
    const line = JSON.stringify(request);
    if (Buffer.byteLength(line) > 65_000) throw Error('request_too_large');
    return new Promise((resolve, reject) => {
      waiter = {resolve, reject};
      child.stdin.write(`${line}\n`, (error) => { if (error) close(); });
    });
  }};
}

/** User-visible preview is the only capability that can authorize one reversible AX edit. */
export function createDesktopDictationService(options: DictationOptions) {
  const now = options.now ?? Date.now;
  const open = options.openSession ?? (() => openDesktopActionSession(options.bundleDir));
  const pending = new Map<string, Pending>();
  const glossary = options.glossaryDirectory ? createDictationGlossary({directory: options.glossaryDirectory}) : null;
  // Loading errors are surfaced by commands, without an unhandled promise rejection at startup.
  void glossary?.catch(() => {});
  let undo: Pending | null = null;
  let draft: {projectId: string; text: string; expiresAt: number} | null = null;
  let busy = false;
  let disposed = false;
  let activeSession: DesktopActionSession | null = null;
  let generation = 0;
  function clear() {generation++; pending.clear(); undo = null; draft = null; activeSession?.close(); activeSession = null;}
  function scoped(projectId: unknown): string {
    const active = options.activeProjectId();
    if (typeof projectId !== 'string' || projectId !== active || !active || projectId.length > 256) throw Error('inactive_project');
    return projectId;
  }
  function preview(projectId: string, target: string, state: DictationTarget, text: string, kind: 'insert' | 'undo', after: string): DictationPreview {
    pending.clear();
    const view: DictationPreview = {previewId: randomUUID(), projectId, text, target, app: state.appBundleId, label: state.label || state.windowTitle, expiresAt: now() + 30_000, kind};
    pending.set(view.previewId, {view, state, before: state.value, after});
    return view;
  }
  return {
    clear,
    dispose() { disposed = true; clear(); void glossary?.then((store) => store.close()).catch(() => {}); },
    async handle(payload: unknown): Promise<DictationResult> {
      let session: DesktopActionSession | null = null;
      let claimed = false;
      const started = generation;
      const capturedPrivate = options.isPrivate?.() === true;
      function check() {if (generation !== started || disposed) throw Error('cleared');}
      function writable() {check(); if (capturedPrivate || options.isPrivate?.()) throw Error('private_mode');}
      async function live<T>(work: Promise<T>): Promise<T> {const result = await work; check(); return result;}
      try {
        if (disposed) throw Error('disposed');
        const request = record(payload);
        if (busy) throw Error('busy');
        busy = true;
        claimed = true;
        if (request.command === 'glossary' || request.command === 'learnCorrection' || request.command === 'promoteTerm') {
          const projectId = scoped(request.projectId);
          if (!glossary) throw Error('glossary_unavailable');
          if (request.command !== 'glossary') writable();
          const store = await live(glossary);
          scoped(projectId);
          if (request.command !== 'glossary' && request.confirmed !== true) throw Error('confirmation_required');
          if (request.command === 'learnCorrection') {
            for (const key of ['raw', 'corrected']) if (typeof request[key] !== 'string' || !(request[key] as string).trim() || Buffer.byteLength(request[key] as string) > 256) throw Error('invalid_correction');
            writable(); await live(store.learnCorrection({projectId, raw: request.raw as string, corrected: request.corrected as string}));
          }
          if (request.command === 'promoteTerm') {
            if (typeof request.term !== 'string' || Buffer.byteLength(request.term) > 256) throw Error('invalid_correction');
            const entries = await live(store.glossaryForProject(projectId));
            if (!entries.some((entry) => entry.term === request.term && entry.ownerProjectId === projectId && entry.scope === 'project' && entry.userConfirmed)) throw Error('inactive_project');
            writable(); scoped(projectId); await live(store.promoteToGlobal(request.term));
          }
          const entries = await live(store.glossaryForProject(projectId)); scoped(projectId);
          return {ok: true, entries: entries.slice(0, 128)};
        }
        if (request.command === 'status') {
          const projectId = scoped(request.projectId);
          const current = [...pending.values()].find((item) => item.view.projectId === projectId && item.view.expiresAt >= now());
          return {ok: true, ...(current ? {preview: current.view} : {}), prepared: draft?.projectId === projectId && draft.expiresAt >= now(), undoAvailable: undo?.view.projectId === projectId && undo.view.expiresAt + 30_000 >= now()};
        }
        if (request.command === 'prepare-draft') {
          const projectId = scoped(request.projectId);
          if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > MAX_TEXT_BYTES) throw Error('invalid_transcript');
          pending.clear();
          const corrected = glossary ? (await live((await live(glossary)).correctTranscript(request.text, {projectId}))).text : request.text;
          scoped(projectId);
          if (Buffer.byteLength(corrected) > MAX_TEXT_BYTES) throw Error('invalid_transcript');
          draft = {projectId, text: corrected, expiresAt: now() + 120_000};
          return {ok: true, prepared: true, draftText: corrected};
        }
        if (request.command === 'cancel') { scoped(request.projectId); pending.delete(String(request.previewId)); return {ok: true}; }
        if (request.command === 'preview' || request.command === 'previewPrepared') {
          const projectId = scoped(request.projectId);
          const text = request.command === 'previewPrepared' ? draft?.projectId === projectId && draft.expiresAt >= now() ? draft.text : null : request.text;
          if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw Error('invalid_transcript');
          session = open(); activeSession = session;
          const focused = record(await live(session.request({operation: 'focused-target'})));
          const target = focused.targetRef;
          if (typeof target !== 'string' || !/^ax:\d+:(?:\d+(?:\.\d+)*)?$/.test(target)) throw Error('unsupported_target');
          const state = targetState(focused.state, focused.selection);
          const selection = state.selection;
          const after = selection
            ? state.value.slice(0, selection.location) + text + state.value.slice(selection.location + selection.length)
            : state.value + text;
          if (Buffer.byteLength(after) > MAX_TEXT_BYTES) throw Error('target_too_large');
          scoped(projectId);
          return {ok: true, preview: preview(projectId, target, state, text, 'insert', after)};
        }
        if (request.command === 'undoPreview') {
          const projectId = scoped(request.projectId);
          if (!undo || undo.view.projectId !== projectId || now() > undo.view.expiresAt + 30_000) throw Error('undo_unavailable');
          session = open(); activeSession = session;
          const previous = undo;
          const state = targetState(await live(session.request({operation: 'inspect', targetRef: previous.view.target})));
          if (state.fingerprint !== undo.state.fingerprint || state.value !== undo.after) throw Error('stale_target');
          return {ok: true, preview: preview(projectId, undo.view.target, state, undo.before, 'undo', undo.before)};
        }
        if (request.command !== 'confirm' || request.confirmed !== true) throw Error('confirmation_required');
        const item = pending.get(String(request.previewId));
        if (!item) throw Error('preview_missing');
        pending.delete(item.view.previewId);
        const projectId = scoped(request.projectId);
        if (projectId !== item.view.projectId) throw Error('inactive_project');
        if (now() > item.view.expiresAt) throw Error('preview_expired');
        session = open(); activeSession = session;
        if (item.state.selection !== undefined) {
          const focused = record(await live(session.request({operation: 'focused-target'})));
          const currentSelectionValue = focused.selection ?? record(focused.state).selection;
          if (!currentSelectionValue || typeof currentSelectionValue !== 'object' || Array.isArray(currentSelectionValue)) throw Error('stale_target');
          const currentSelection = currentSelectionValue as Record<string, unknown>;
          if (focused.targetRef !== item.view.target
            || currentSelection.location !== item.state.selection.location
            || currentSelection.length !== item.state.selection.length) throw Error('stale_target');
        }
        const state = targetState(await live(session.request({operation: 'inspect', targetRef: item.view.target})));
        if (state.fingerprint !== item.state.fingerprint || state.value !== item.before) throw Error('stale_target');
        const scope = {profileId: 'local', projectId, sensitivity: 'normal'};
        const proposal = record(await live(session.request({operation: 'propose', scope, actionId: item.view.previewId, idempotencyKey: item.view.previewId,
          utterance: {utteranceId: item.view.previewId, text: item.view.text}, effect: 'local_write',
          steps: [{stepId: 'insert', operation: 'set_value', targetRef: item.view.target, targetFingerprint: state.fingerprint, value: item.after, expectedValue: item.before}]})));
        scoped(projectId);
        if (now() > item.view.expiresAt) throw Error('preview_expired');
        const grant = record(await live(session.request({operation: 'authorize', scope, proposalId: proposal.proposalId, utterance: {utteranceId: randomUUID(), text: 'Explicitly confirmed preview'}})));
        if (grant.authorized !== true) throw Error('native_denied');
        scoped(projectId);
        const rechecked = targetState(await live(session.request({operation: 'inspect', targetRef: item.view.target})));
        scoped(projectId);
        if (rechecked.fingerprint !== state.fingerprint || rechecked.value !== item.before) throw Error('stale_target');
        const receipt = record(await live(session.request({operation: 'advance', scope, proposalId: proposal.proposalId})));
        if (receipt.status !== 'completed') return {ok: false, error: typeof receipt.reason === 'string' ? receipt.reason : 'verification_failed', receipt};
        undo = item.view.kind === 'insert' ? item : null;
        return {ok: true, receipt};
      } catch (error) {
        const allowed = new Set(['cleared','private_mode','inactive_project','busy','disposed','confirmation_required','invalid_transcript','invalid_correction','glossary_unavailable','target_too_large','unsupported_target','secure_field','target_not_focused','stale_target','preview_expired','preview_missing','undo_unavailable','helper_missing','helper_closed','helper_unavailable','native_denied','malformed_response']);
        const message = error instanceof Error ? error.message : '';
        return {ok: false, error: allowed.has(message) ? message : 'native_error'};
      } finally { session?.close(); if (claimed) { activeSession = null; busy = false; } }
    },
  };
}
