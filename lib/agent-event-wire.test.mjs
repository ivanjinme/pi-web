import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isEventIncludedInSnapshot, toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");

test("projects Pi 0.84 message updates without repeated full snapshots", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  assert.deepEqual(toClientAgentEvent({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "o",
      partial,
    },
  }), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o" },
  });
});

test("filters noisy events and minimizes agent_end", () => {
  assert.equal(toClientAgentEvent({ type: "turn_start" }), null);
  assert.equal(toClientAgentEvent({ type: "tool_execution_update" }), null);
  assert.deepEqual(toClientAgentEvent({ type: "agent_end", messages: [] }), { type: "agent_end" });
});

test("deduplicates only the event represented by reconnect snapshot identity", () => {
  const snapshot = { role: "assistant", content: [] };
  assert.equal(isEventIncludedInSnapshot({ type: "message_update", message: snapshot }, snapshot), true);
  assert.equal(isEventIncludedInSnapshot({ type: "message_update", message: { ...snapshot } }, snapshot), false);
  assert.equal(isEventIncludedInSnapshot({ type: "message_end", message: snapshot }, snapshot), false);
});
