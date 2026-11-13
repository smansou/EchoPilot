import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedSecretStore } from "./cached-secret-store";
test("concurrent tool requests read Keychain once per provider per launch", async () => {
  let count = 0;
  const store = cachedSecretStore({
    get: async () => {
      count++;
      await new Promise((r) => setTimeout(r, 10));
      return "private-test";
    },
    put: async () => {},
    delete: async () => {},
  });
  assert.deepEqual(
    await Promise.all([store.get("openai"), store.get("openai")]),
    ["private-test", "private-test"],
  );
  await store.get("openai");
  assert.equal(count, 1);
  store.clear();
  await store.get("openai");
  assert.equal(count, 2);
});
test("replacement and deletion invalidate a cached value, including reads racing a write", async () => {
  let secret: string | null = "old";
  let finish!: () => void;
  const store = cachedSecretStore({
    get: async () => secret,
    put: async (_p, value) => {
      await new Promise<void>((r) => (finish = r));
      secret = value;
    },
    delete: async () => {
      secret = null;
    },
  });
  assert.equal(await store.get("p"), "old");
  const saving = store.put("p", "new");
  await new Promise((r) => setTimeout(r, 0));
  const reading = store.get("p");
  finish();
  await saving;
  assert.equal(await reading, "new");
  await store.delete("p");
  assert.equal(await store.get("p"), null);
});
test("failed and missing credentials are never cached", async () => {
  let count = 0;
  const store = cachedSecretStore({
    get: async () => {
      if (++count === 1) throw Error("Keychain locked");
      return count === 2 ? null : "later";
    },
    put: async () => {},
    delete: async () => {},
  });
  await assert.rejects(() => store.get("p"));
  assert.equal(await store.get("p"), null);
  assert.equal(await store.get("p"), "later");
  assert.equal(count, 3);
});
