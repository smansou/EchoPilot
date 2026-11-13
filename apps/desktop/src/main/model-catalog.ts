import {
  openAIModels,
  modelLabel,
  type AssistantModel,
} from "../shared/model-catalog";
import type { TextProvider } from "../shared/provider-setup";
export async function discoverModels(
  provider: TextProvider,
  key: string,
  request: typeof fetch = fetch,
): Promise<AssistantModel[]> {
  if (!key) throw Error("Save this provider’s API key to load its models.");
  const models: AssistantModel[] = [];
  let cursor = "";
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const url =
      provider === "anthropic"
        ? "https://api.anthropic.com/v1/models?limit=100" +
          (cursor ? "&after_id=" + encodeURIComponent(cursor) : "")
        : provider === "gemini"
          ? "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000" +
            (cursor ? "&pageToken=" + encodeURIComponent(cursor) : "")
          : provider === "openrouter"
            ? "https://openrouter.ai/api/v1/models"
            : "https://api.openai.com/v1/models";
    const headers =
      provider === "anthropic"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : provider === "gemini"
          ? { "x-goog-api-key": key }
          : { Authorization: `Bearer ${key}` };
    const response = await request(url, {
      headers: headers as Record<string, string>,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "This connection was rejected. Check your API key."
          : `Could not load models (${response.status}). Try refreshing.`,
      );
    const data = (await response.json()) as any;
    if (provider === "openai") return openAIModels(data);
    const rows = provider === "gemini" ? data.models : data.data;
    if (!Array.isArray(rows))
      throw Error("The provider returned an invalid model catalog.");
    for (const m of rows) {
      const id =
        provider === "gemini" ? m.name?.replace(/^models\//, "") : m.id;
      if (typeof id !== "string") continue;
      models.push({
        id,
        label: m.display_name || m.displayName || m.name || modelLabel(id),
        assistant:
          provider !== "gemini" ||
          m.supportedGenerationMethods?.includes("generateContent") === true,
      });
    }
    cursor =
      provider === "gemini"
        ? data.nextPageToken
        : provider === "anthropic" && data.has_more
          ? data.last_id
          : "";
    if (!cursor) return [...new Map(models.map((m) => [m.id, m])).values()];
    if (seen.has(cursor))
      throw Error("The provider repeated a catalog page. Try again.");
    seen.add(cursor);
  }
  throw Error("The model catalog exceeded its page limit.");
}
