import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesRequest, readResponsesStream } from "./openai-responses";
test("Responses translation preserves screen images, tools, and encrypted reasoning between steps", () => {
  const request = responsesRequest({
    model: "gpt-test",
    messages: [
      { role: "system", content: "Instructions" },
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==", detail: "low" },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        reasoning_details: [
          { type: "reasoning", id: "r", encrypted_content: "opaque" },
        ],
        tool_calls: [
          { id: "call", function: { name: "focus", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call", content: '{"ok":true}' },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "focus",
          description: "point",
          parameters: { type: "object" },
        },
      },
    ],
  });
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.input[0].role, "developer");
  assert.equal(request.input[1].content[1].type, "input_image");
  assert.equal(request.input[2].encrypted_content, "opaque");
  assert.equal(request.input[3].call_id, "call");
  assert.equal(request.input[4].type, "function_call_output");
  assert.equal(request.tools[0].name, "focus");
});
const stream = (events: unknown[]) =>
  new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
test("tool calls return to the actual backend only after response.completed", async () => {
  const result = await readResponsesStream(
    stream([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            { type: "reasoning", encrypted_content: "secret" },
            {
              type: "function_call",
              call_id: "c",
              name: "focus_screen_target",
              arguments: '{"id":"target"}',
            },
          ],
        },
      },
    ]),
    new AbortController().signal,
  );
  assert.equal(result.choices[0]!.finish_reason, "tool_calls");
  assert.equal(
    result.choices[0]!.message.tool_calls[0].function.name,
    "focus_screen_target",
  );
});
test("partial text does not conceal subscription usage errors or incomplete streams", async () => {
  await assert.rejects(
    () =>
      readResponsesStream(
        stream([{ type: "response.output_text.delta", delta: "Hello" }]),
        new AbortController().signal,
      ),
    /before its response completed/,
  );
  await assert.rejects(
    () =>
      readResponsesStream(
        stream([
          {
            type: "response.failed",
            response: {
              error: { code: "subscription_sharing_usage_limit_exceeded" },
            },
          },
        ]),
        new AbortController().signal,
      ),
    /Manage usage/,
  );
  await assert.rejects(
    () =>
      readResponsesStream(
        stream([{ type: "response.incomplete" }]),
        new AbortController().signal,
      ),
    /limit/,
  );
});
