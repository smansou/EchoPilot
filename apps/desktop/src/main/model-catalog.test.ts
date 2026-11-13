import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverModels } from "./model-catalog";
import { openAIModels } from "../shared/model-catalog";
test("account catalog preserves server order, names, and visibility", () => {
  assert.deepEqual(
    openAIModels({
      models: [
        { slug: "new", display_name: "Newest model", visibility: "list" },
        { slug: "hidden", visibility: "hide" },
        { slug: "another", display_name: "Another", visibility: "list" },
      ],
    }).map((m) => [m.id, m.label]),
    [
      ["new", "Newest model"],
      ["another", "Another"],
    ],
  );
});
test("API catalog is not capped to old models, specialized models stay visible but disabled", async () => {
  const models = await discoverModels("openai", "test", (async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal((init?.headers as any).Authorization, "Bearer test");
    return Response.json({
      data: [
        { id: "gpt-6.1-sol" },
        { id: "gpt-4.1" },
        { id: "text-embedding-3-large" },
        { id: "gpt-live-1" },
      ],
    });
  }) as typeof fetch);
  assert.equal(models.length, 4);
  assert.equal(models.find((m) => m.id === "gpt-6.1-sol")?.assistant, true);
  assert.equal(models.find((m) => m.id === "gpt-live-1")?.assistant, false);
});
test("Anthropic discovery follows all catalog pages", async () => {
  let count = 0;
  const models = await discoverModels("anthropic", "test", (async (url) => {
    count++;
    if (count === 1)
      return Response.json({
        data: [{ id: "a", display_name: "A" }],
        has_more: true,
        last_id: "a",
      });
    assert.match(String(url), /after_id=a/);
    return Response.json({
      data: [{ id: "b", display_name: "B" }],
      has_more: false,
    });
  }) as typeof fetch);
  assert.deepEqual(
    models.map((m) => m.id),
    ["a", "b"],
  );
});
test("Gemini catalog uses capabilities and follows page tokens", async () => {
  let count = 0;
  const models = await discoverModels("gemini", "test", (async () =>
    Response.json(
      ++count === 1
        ? {
            models: [
              {
                name: "models/new",
                displayName: "New",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
            nextPageToken: "next",
          }
        : {
            models: [
              {
                name: "models/embed",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          },
    )) as typeof fetch);
  assert.equal(models[0]?.assistant, true);
  assert.equal(models[1]?.assistant, false);
  assert.equal(count, 2);
});
