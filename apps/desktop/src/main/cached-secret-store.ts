import type { SecretStore } from "../../../../packages/security/src/types";
/** Successful reads stay only in the main process for this launch, never in app files or renderers. */
export function cachedSecretStore(store: SecretStore) {
  const values = new Map<string, string>();
  const reads = new Map<string, Promise<string | null>>();
  const revisions = new Map<string, number>();
  const writes = new Map<string, Promise<void>>();
  let epoch = 0;
  function invalidate(provider: string) {
    values.delete(provider);
    reads.delete(provider);
    revisions.set(provider, (revisions.get(provider) || 0) + 1);
  }
  function mutate(provider: string, operation: () => Promise<void>) {
    invalidate(provider);
    const previous = writes.get(provider) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(operation)
      .finally(() => {
        invalidate(provider);
        if (writes.get(provider) === task) writes.delete(provider);
      });
    writes.set(provider, task);
    return task;
  }
  return {
    async get(provider: string): Promise<string | null> {
      await writes.get(provider);
      if (values.has(provider)) return values.get(provider)!;
      const active = reads.get(provider);
      if (active) return active;
      const version = revisions.get(provider) || 0,
        currentEpoch = epoch;
      const task = store
        .get(provider)
        .then((value) => {
          if (
            value !== null &&
            currentEpoch === epoch &&
            (revisions.get(provider) || 0) === version
          )
            values.set(provider, value);
          return value;
        })
        .finally(() => {
          if (reads.get(provider) === task) reads.delete(provider);
        });
      reads.set(provider, task);
      return task;
    },
    put(provider: string, secret: string) {
      return mutate(provider, () => store.put(provider, secret));
    },
    delete(provider: string) {
      return mutate(provider, () => store.delete(provider));
    },
    clear() {
      epoch++;
      values.clear();
      reads.clear();
    },
  };
}
