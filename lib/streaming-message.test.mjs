import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { INITIAL_STREAMING_STATE, streamReducer } = await jiti.import("./streaming-message.ts");

const assistant = (content = []) => ({
  role: "assistant",
  content,
  model: "test-model",
  provider: "test-provider",
  timestamp: 1,
});
const snapshot = (state, message) => streamReducer(state, { type: "snapshot", message });
const delta = (state, event) => streamReducer(state, { type: "delta", event });

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
