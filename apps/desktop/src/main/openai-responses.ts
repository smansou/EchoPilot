/** Translate the assistant's tool loop to Responses without losing reasoning items. */
export function responsesRequest(body: any) {
  const input: any[] = [];
  for (const message of body.messages || []) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.reasoning_details)
      input.push(...message.reasoning_details);
    if (message.content) {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content.map((p: any) =>
              p.type === "image_url"
                ? {
                    type: "input_image",
                    image_url: p.image_url.url,
                    detail: p.image_url.detail || "low",
                  }
                : { type: "input_text", text: p.text },
            );
      input.push({
        role: message.role === "system" ? "developer" : message.role,
        content,
      });
    }
    for (const call of message.tool_calls || [])
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  return {
    model: body.model,
    input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 12000,
    ...(body.tools?.length
      ? {
          tools: body.tools.map((t: any) => ({
            type: "function",
            ...t.function,
            strict: false,
          })),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }
      : {}),
    ...(body.response_format ? { text: { format: body.response_format } } : {}),
  };
}
export function responsesResult(response: any) {
  if (response?.status !== "completed")
    throw Error("The assistant response did not complete.");
  const output = response.output || [];
  const calls = output
    .filter((i: any) => i.type === "function_call")
    .map((i: any) => ({
      id: i.call_id,
      type: "function",
      function: { name: i.name, arguments: i.arguments },
    }));
  const text = output
    .filter((i: any) => i.type === "message")
    .flatMap((i: any) => i.content || [])
    .filter((p: any) => p.type === "output_text")
    .map((p: any) => p.text)
    .join("");
  const reasoning = output.filter((i: any) => i.type === "reasoning");
  return {
    choices: [
      {
        finish_reason: calls.length ? "tool_calls" : "stop",
        message: {
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reasoning.length ? { reasoning_details: reasoning } : {}),
        },
      },
    ],
  };
}
export async function readResponsesStream(
  response: Response,
  signal: AbortSignal,
) {
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      response.status === 401
        ? "Your OpenAI connection needs attention. Reconnect in Connections."
        : response.status === 429
          ? "OpenAI usage limit reached. Check your plan usage or API billing."
          : `OpenAI request failed (${response.status}).`,
    );
  }
  if (!response.body) throw Error("OpenAI returned an empty response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024)
        throw Error("The assistant response exceeded its size limit.");
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const raw = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!raw || raw === "[DONE]") continue;
        const event = JSON.parse(raw);
        if (event.type === "response.completed")
          return responsesResult(event.response);
        if (event.type === "response.failed" || event.type === "error") {
          const code = event.response?.error?.code || event.code;
          throw Error(
            String(code).startsWith("subscription_sharing_")
              ? "ChatGPT plan usage is unavailable or its limit was reached. Open Manage usage in Connections."
              : "OpenAI could not complete this request. Check your connection and selected model.",
          );
        }
        if (event.type === "response.incomplete")
          throw Error(
            "The assistant reached its response limit before finishing. Try a smaller request.",
          );
      }
    }
    throw Error(
      "The assistant connection ended before its response completed.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
