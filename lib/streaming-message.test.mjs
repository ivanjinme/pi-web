import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { INITIAL_STREAMING_STATE, reconcileUserMessage, streamReducer } = await jiti.import("./streaming-message.ts");

const assistant = (content = []) => ({
  role: "assistant",
  content,
  model: "test-model",
  provider: "test-provider",
  timestamp: 1,
});
const snapshot = (state, message) => streamReducer(state, { type: "snapshot", message });
const delta = (state, event) => streamReducer(state, { type: "delta", event });

test("confirms the optimistic user bubble across an intervening system message", () => {
  const optimistic = { role: "user", content: "Hello", timestamp: 1 };
  const system = { role: "system", content: "", sections: { rules: "Project rules" } };
  const delivered = { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 2 };
  const messages = [optimistic, system];

  const result = reconcileUserMessage(messages, optimistic, delivered);

  assert.deepEqual(result, [delivered, system]);
  assert.equal(result.filter((message) => message.role === "user").length, 1);
  assert.strictEqual(result[0], delivered);
  assert.strictEqual(result[1], system);
  assert.deepEqual(messages, [optimistic, system]);
});

test("confirms only the pending object, not an earlier same-text message", () => {
  const earlier = { role: "user", content: "Same text" };
  const optimistic = { ...earlier };
  const delivered = { ...earlier, timestamp: 2 };

  const result = reconcileUserMessage([earlier, optimistic], optimistic, delivered);

  assert.strictEqual(result[0], earlier);
  assert.strictEqual(result[1], delivered);
  assert.equal(result.length, 2);
});

test("uses the authoritative delivered content even when extensions change the prompt", () => {
  const optimistic = {
    role: "user",
    content: [{ type: "text", text: "Original" }, { type: "image", source: { type: "base64", data: "image" } }],
  };
  const system = { role: "system", content: "Updated instructions" };
  const delivered = { role: "user", content: [{ type: "text", text: "Expanded prompt" }] };

  assert.deepEqual(reconcileUserMessage([optimistic, system], optimistic, delivered), [delivered, system]);
});

test("appends later same-text queue deliveries after the optimistic marker is consumed", () => {
  const first = { role: "user", content: "Same text" };
  const queued = { ...first, timestamp: 2 };

  assert.deepEqual(reconcileUserMessage([first], null, queued), [first, queued]);
});

test("appends a delivered user message if its optimistic object is no longer present", () => {
  const optimistic = { role: "user", content: "Original" };
  const system = { role: "system", content: "Instructions" };
  const delivered = { role: "user", content: "Original" };

  assert.deepEqual(reconcileUserMessage([system], optimistic, delivered), [system, delivered]);
});

test("builds text and thinking from Pi 0.84 deltas", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant());
  state = delta(state, { type: "thinking_start", contentIndex: 0 });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: "Plan" });
  state = delta(state, { type: "thinking_end", contentIndex: 0, content: "Plan." });
  state = delta(state, { type: "text_start", contentIndex: 1 });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "Hello" });
  state = delta(state, { type: "text_end", contentIndex: 1, content: "Hello!" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "Plan." },
    { type: "text", text: "Hello!" },
  ]);
});

test("reconnect snapshot replaces stale content before deltas continue", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([{ type: "text", text: "stale" }]));
  state = snapshot(state, assistant([{ type: "text", text: "Hello wor" }]));
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "ld" });
  assert.equal(state.streamingMessage.content[0].text, "Hello world");
});

test("uses authoritative toolcall_end and ignores streamed JSON fragments", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant());
  const before = state;
  state = delta(state, { type: "toolcall_start", contentIndex: 0 });
  state = delta(state, { type: "toolcall_delta", contentIndex: 0, delta: '{"path":' });
  assert.strictEqual(state, before);

  state = delta(state, {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } },
  });
  assert.deepEqual(state.streamingMessage.content[0], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "/tmp/a" },
  });
});
