export type AssistantModel = { id: string; label: string; assistant: boolean };
/** Keep every returned model visible, while preventing audio/image-only choices for reasoning. */
export function modelLabel(id: string) {
  return id
    .replace(/^models\//, "")
    .replace(/^gpt-/, "GPT-")
    .replace(/^claude-/, "Claude ")
    .replace(/^gemini-/, "Gemini ")
    .replace(/-/g, " ")
    .replace(/^GPT /, "GPT-");
}
export function openAIModels(data: any): AssistantModel[] {
  if (Array.isArray(data.models))
    return data.models
      .filter((m: any) => m.visibility === "list" && typeof m.slug === "string")
      .map((m: any) => ({
        id: m.slug,
        label: m.display_name || modelLabel(m.slug),
        assistant: true,
      }));
  return (data.data || [])
    .filter((m: any) => typeof m.id === "string")
    .map((m: any) => ({
      id: m.id,
      label: modelLabel(m.id),
      assistant:
        /^(gpt-|o[1-9]|chatgpt-|ft:)/.test(m.id) &&
        !/(audio|realtime|live|transcrib|tts|image|search|instruct|embedding|moderation)/i.test(
          m.id,
        ),
    }))
    .sort((a: AssistantModel, b: AssistantModel) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
}
