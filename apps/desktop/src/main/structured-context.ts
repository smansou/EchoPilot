import {createServer, type Server} from 'node:http';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {relative, isAbsolute} from 'node:path';

export type EditorContext = {source: 'vscode_selection'; targetId: string; projectId: string; document: string; version: number; selection: string; language: string; expiresAt: number; trust: 'untrusted_editor_text'};
export type ConnectorPairing = {endpoint: string; token: string; projectId: string; root: string; expiresAt: number};
export type StructuredContextResult = {ok: boolean; error?: string; pairing?: ConnectorPairing; connected?: boolean; context?: EditorContext | null};
type Options = {activeProject(): {projectId: string; cwd: string} | null; now?(): number};

/** Local read-only opt-in connector. No provider, audit payload, disk text, or editor writes. */
export function createStructuredContext(options: Options) {
  const now = options.now ?? Date.now;
  let server: Server | null = null; let pairing: ConnectorPairing | null = null; let context: EditorContext | null = null;
  let generation = 0; let disposed = false; let starting = false;
  let expiry: NodeJS.Timeout | null = null; let contextExpiry: NodeJS.Timeout | null = null;
  function clear() {generation++; pairing = null; context = null; if (expiry) clearTimeout(expiry); if (contextExpiry) clearTimeout(contextExpiry); expiry = null; contextExpiry = null; server?.closeAllConnections(); server?.close(); server = null;}
  function current(projectId: unknown) {const project = options.activeProject(); if (disposed || !project || project.projectId !== projectId) throw Error('inactive_project'); return project;}
  function live(session: ConnectorPairing, started: number) {const project = current(session.projectId); if (generation !== started || pairing !== session || now() >= session.expiresAt || project.cwd !== session.root) throw Error('session_expired');}
  async function receive(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, started: number) {
    const reply = (status: number, error?: string) => {response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(error ? {ok: false, error} : {ok: true}));};
    const chunks: Buffer[] = [];
    try {
      const session = pairing;
      if (!session) throw Error('session_expired');
      live(session, started);
      if (request.method !== 'POST' || request.url !== '/selection' || request.headers.origin !== undefined || request.headers.host !== new URL(session.endpoint).host || request.headers['content-type'] !== 'application/json') throw Error('invalid_origin');
      const bearer = request.headers.authorization ?? ''; const expected = `Bearer ${session.token}`;
      if (Buffer.byteLength(bearer) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(bearer), Buffer.from(expected))) throw Error('unauthorized');
      let bytes = 0;
      request.setTimeout(6000, () => request.destroy());
      for await (const chunk of request) {bytes += chunk.length; if (bytes > 24576) throw Error('output_limit'); chunks.push(Buffer.from(chunk));}
      live(session, started);
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['command','projectId','root','document','version','selection','language','confirmed'].includes(key))) throw Error('invalid_request');
      if (value.command !== 'share-selection' || value.confirmed !== true) throw Error('confirmation_required');
      if (value.projectId !== session.projectId || value.root !== session.root) throw Error('scope_changed');
      if (typeof value.document !== 'string' || value.document.length > 4096 || !isAbsolute(value.document) || typeof value.selection !== 'string' || !value.selection.trim() || Buffer.byteLength(value.selection) > 16384 || typeof value.language !== 'string' || value.language.length > 64 || !Number.isSafeInteger(value.version) || Number(value.version) < 1) throw Error('invalid_request');
      const document = await realpath(value.document);
      const path = relative(session.root, document);
      if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw Error('scope_changed');
      live(session, started);
      context = {source: 'vscode_selection', targetId: randomUUID(), projectId: session.projectId, document: path, version: Number(value.version), selection: value.selection, language: value.language, expiresAt: now() + 30000, trust: 'untrusted_editor_text'};
      if (contextExpiry) clearTimeout(contextExpiry);
      contextExpiry = setTimeout(() => {context = null;}, 30000); contextExpiry.unref();
      reply(200);
    } catch (error) {const code = error instanceof Error ? error.message : ''; reply(403, ['session_expired','inactive_project','invalid_origin','unauthorized','confirmation_required','scope_changed','invalid_request','output_limit'].includes(code) ? code : 'invalid_request');}
    finally {chunks.length = 0;}
  }
  return {clear, dispose() {disposed = true; clear();}, async handle(payload: unknown): Promise<StructuredContextResult> {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid_request');
      const request = payload as Record<string, unknown>;
      if (Object.keys(request).some(key => !['command','projectId','confirmed'].includes(key))) throw Error('invalid_request');
      const project = current(request.projectId);
      if (request.command === 'disconnect') {clear(); return {ok: true, connected: false};}
      if (request.command === 'status') {if (pairing && (now() >= pairing.expiresAt || pairing.projectId !== project.projectId || pairing.root !== project.cwd)) clear(); if (context && now() >= context.expiresAt) context = null; return {ok: true, connected: pairing !== null, context};}
      if (request.command !== 'pair' || request.confirmed !== true) throw Error('confirmation_required');
      if (starting) throw Error('busy'); starting = true; clear(); const started = generation;
      try {
        const root = await realpath(project.cwd);
        if (generation !== started || current(project.projectId).cwd !== project.cwd) throw Error('scope_changed');
        // Require a canonical registered project root; never silently change scope.
        if (root !== project.cwd) throw Error('canonical_project_required');
        const listener = createServer((req, res) => {void receive(req, res, started);});
        listener.requestTimeout = 6000; listener.headersTimeout = 6000; listener.maxHeadersCount = 16;
        listener.maxConnections = 4;
        server = listener;
        await new Promise<void>((resolve, reject) => {listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);});
        if (generation !== started || current(project.projectId).cwd !== root) {listener.close(); throw Error('scope_changed');}
        const address = listener.address(); if (!address || typeof address === 'string') throw Error('unavailable');
        pairing = {endpoint: `http://127.0.0.1:${address.port}/selection`, token: randomBytes(32).toString('hex'), projectId: project.projectId, root, expiresAt: now() + 300000};
        expiry = setTimeout(clear, 300000); expiry.unref();
        return {ok: true, pairing};
      } finally {starting = false;}
    } catch (error) {return {ok: false, error: error instanceof Error && ['invalid_request','inactive_project','confirmation_required','busy','scope_changed','canonical_project_required'].includes(error.message) ? error.message : 'connector_unavailable'};}
  }};
}
