import { randomUUID, createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createFileLogSource, createGenericLogAdapter, type GenericFormat } from '../../../../packages/harness-generic/src/index';
import { createMemoryImporter, type ImportRunResult } from '../../../../packages/memory/src/import/index';
import type { PrivacyBoundMemoryStore } from '../../../../packages/memory/src/store/index';
import type { MemoryConsolidator } from '../../../../packages/memory/src/consolidation/index';

export type HistoryPreview = Readonly<{ id: string; projectId: string; name: string; bytes: number; expiresAt: number; format: GenericFormat; events: readonly { kind: string; text: string; trust: 'imported' }[] }>;
type Pending = { view: HistoryPreview; path: string; fingerprint: string };
const MAX_BYTES = 64 * 1024 * 1024;
const reducersOnly: MemoryConsolidator = {
  // The encrypted store's deterministic capsule reducers already ingest every admitted event.
  // No unconfigured model is invoked and no plaintext derived memory sidecar is created.
  consolidate: async () => ({ checkpoint: 'encrypted-store-capsules', coverage: { semantic: 'partial', failedJobs: ['semantic-model-not-configured'] } }),
  facts: async () => [], decisions: async () => [], card: async () => undefined,
  coverage: async () => ({ semantic: 'partial', failedJobs: ['semantic-model-not-configured'] }),
  answer: async () => ({ text: 'No semantic answer is available.', supported: false, evidenceIds: [], coverage: { semantic: 'partial', failedJobs: ['semantic-model-not-configured'] }, maxTokens: 0, usedTokens: 0 }),
  close: async () => {},
};
async function fingerprint(path: string): Promise<{ value: string; bytes: number }> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Choose a regular log file under 64 MiB.');
  return { value: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, bytes: info.size };
}

export function createHistoryImportService(options: {
  directory: string;
  activeProjectId(): string | null;
  store(): Promise<PrivacyBoundMemoryStore>;
  privateSessionId?(): string | null;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let pending: Pending | null = null;
  let running: { id: string; abort: AbortController } | null = null;
  let disposed = false;
  let generation = 0;
  function scoped(projectId: string) { if (disposed || !projectId || options.activeProjectId() !== projectId) throw new Error('Select this active project before importing history.'); }
  async function preview(projectId: string, selectedPath: string): Promise<HistoryPreview> {
    scoped(projectId);
    const revision = generation;
    if (running) throw new Error('An import is already running.');
    const path = await realpath(selectedPath);
    const info = await fingerprint(path);
    const extension = extname(path).toLowerCase();
    if (!['.jsonl', '.txt', '.log'].includes(extension)) throw new Error('Choose a JSONL, TXT or LOG history file.');
    const format: GenericFormat = extension === '.jsonl' ? 'jsonl' : 'text';
    const source = createFileLogSource(path);
    const adapter = createGenericLogAdapter({ source, format, sessionId: `history-${projectId}`, scope: { profileId: 'local', projectId, sensitivity: 'normal' } });
    const parsed = await adapter.preview({ limit: 20 });
    scoped(projectId);
    if (revision !== generation) throw Error('Privacy changed. Preview the history again.');
    const view: HistoryPreview = { id: randomUUID(), projectId, name: basename(path), bytes: info.bytes, expiresAt: now() + 120_000, format,
      events: parsed.events.map(item => ({ kind: item.event.kind, text: item.text.slice(0, 1_000), trust: 'imported' })) };
    pending = { view, path, fingerprint: info.value }; return view;
  }
  async function confirm(projectId: string, id: string): Promise<ImportRunResult> {
    scoped(projectId);
    if (running || !pending || pending.view.id !== id || pending.view.projectId !== projectId || pending.view.expiresAt <= now()) throw new Error('That history preview is no longer pending.');
    const selection = pending; pending = null;
    const revision = generation;
    const capturedPrivate = options.privateSessionId?.();
    const controller = new AbortController(); running = { id, abort: controller };
    let importer: Awaited<ReturnType<typeof createMemoryImporter>> | null = null;
    try {
      if ((await fingerprint(selection.path)).value !== selection.fingerprint) throw new Error('The history file changed. Preview it again.');
      const store = await options.store(); scoped(projectId);
      if (revision !== generation || controller.signal.aborted) throw Error('Privacy changed. Preview the history again.');
      const privateSessionId = capturedPrivate ?? store.privacy.privateSessions.openSessions()[0];
      const scope = { profileId: 'local', projectId, sensitivity: 'normal' as const };
      const source = createFileLogSource(selection.path);
      // Checkpoints contain source identities and offsets only; all event content goes through the existing encrypted store.
      const identity = createHash('sha256').update(`${projectId}:${selection.path}`).digest('hex');
      // Preserve source session identity while binding the entire approved import to its capture scope.
      const scopedStore = Object.create(store) as PrivacyBoundMemoryStore;
      scopedStore.ingest = (batch, ingestOptions) => {
        if (revision !== generation || controller.signal.aborted) return Promise.reject(Error('Privacy changed. Preview the history again.'));
        return store.ingest(batch, { ...ingestOptions, privateSessionId: privateSessionId ?? null });
      };
      scopedStore.durableCursor = store.durableCursor.bind(store);
      importer = await createMemoryImporter({ directory: join(options.directory, identity), source, format: selection.view.format, scope, store: scopedStore, consolidator: reducersOnly });
      scoped(projectId);
      // Scope changes abort the bounded reader rather than importing later chunks into a new scope.
      const monitor = setInterval(() => { if (options.activeProjectId() !== projectId || disposed) controller.abort(); }, 25);
      try { return await importer.bootstrap({ signal: controller.signal }); }
      finally { clearInterval(monitor); }
    } finally { await importer?.close(); running = null; }
  }
  function cancel(projectId: string, id: string) {
    scoped(projectId);
    if (pending?.view.id === id && pending.view.projectId === projectId) pending = null;
    else if (running?.id === id) running.abort.abort();
    else throw new Error('That history preview is no longer pending.');
    return { canceled: true };
  }
  return { preview, confirm, cancel, clear() { generation++; pending = null; running?.abort.abort(); }, dispose() { disposed = true; pending = null; running?.abort.abort(); } };
}
