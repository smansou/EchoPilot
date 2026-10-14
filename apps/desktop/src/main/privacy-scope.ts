import type { PrivacyBoundMemoryStore } from '../../../../packages/memory/src/store/index';
import type { IngestOptions } from '../../../../packages/memory/src/store/types';

/** One process-wide user choice; source UUIDs remain intact and late captures stay private. */
export function createProcessPrivacyScope() {
  let sessionId: string | null = null;
  let generation = 0;
  return {
    capture: () => sessionId,
    generation: () => generation,
    invalidate() { generation++; },
    begin(id: string) {
      if (sessionId && sessionId !== id) throw Error('A private session is already active.');
      sessionId = id; generation++;
    },
    end(id: string) {
      if (sessionId !== id) throw Error('That private session is not active.');
      sessionId = null; generation++;
    },
    bind(store: PrivacyBoundMemoryStore) {
      const ingest = store.ingest.bind(store);
      store.ingest = (batch, options?: IngestOptions) => ingest(batch, {
        ...options,
        privateSessionId: options && Object.hasOwn(options, 'privateSessionId') ? options.privateSessionId ?? null : sessionId,
      });
      return store;
    },
  };
}
