import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

test("shows expanded skills as commands without instructions", async () => {
  const { getUserMessageDisplayText } = await loadSubject();
  const skill = '<skill name="frontend-design" location="D:/project/.pi/skills/frontend-design/SKILL.md">\nReferences are relative to D:/project/.pi/skills/frontend-design.\n\nPrivate instructions\n</skill>';

  assert.equal(getUserMessageDisplayText(skill), "/skill:frontend-design");
  assert.equal(getUserMessageDisplayText(`${skill}\n\n设计首页\n保留现有布局`), "/skill:frontend-design 设计首页\n保留现有布局");
  assert.equal(getUserMessageDisplayText(`${skill}\n\n  keep whitespace  `), "/skill:frontend-design   keep whitespace  ");
});

test("leaves ordinary messages and incomplete skill blocks unchanged", async () => {
  const { getUserMessageDisplayText } = await loadSubject();
  for (const text of [
    "",
    "/skill:frontend-design 设计首页",
    "Ordinary user message",
    '<skill name="example" location="/skills/example/SKILL.md">\nIncomplete',
    'Example:\n<skill name="example" location="/skills/example/SKILL.md">\nInstructions\n</skill>',
  ]) {
    assert.equal(getUserMessageDisplayText(text), text);
  }
});

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("recognizes commentary text signatures", async () => {
  const { getTextPhase } = await loadSubject();

  assert.equal(
    getTextPhase({ type: "text", text: "Checking files", textSignature: JSON.stringify({ v: 1, id: "msg-1", phase: "commentary" }) }),
    "commentary",
  );
  assert.equal(
    getTextPhase({ type: "text", text: "Done", textSignature: JSON.stringify({ v: 1, id: "msg-2", phase: "final_answer" }) }),
    "final_answer",
  );
  assert.equal(getTextPhase({ type: "text", text: "Legacy", textSignature: "msg-3" }), undefined);
});

test("keeps trailing commentary in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const commentary = { type: "text", text: "Checking the result now.", textSignature: JSON.stringify({ v: 1, id: "msg-1", phase: "commentary" }) };
  const message = assistant([
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    commentary,
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks, [message.content[0], commentary]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("getAssistantErrorMessage surfaces provider failures across message shapes", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  // Codex usage-limit failures persist an empty-content error message.
  const empty = { ...assistant([]), stopReason: "error", errorMessage: "Codex error: The usage limit has been reached." };
  assert.equal(getAssistantErrorMessage(empty), "Codex error: The usage limit has been reached.");

  // Providers that emit an empty text block before failing.
  const emptyText = { ...assistant([{ type: "text", text: "" }]), stopReason: "error", errorMessage: "overloaded" };
  assert.equal(getAssistantErrorMessage(emptyText), "overloaded");

  // Partial output then failure: still an error.
  const partial = { ...assistant([{ type: "text", text: "partial" }]), stopReason: "error", errorMessage: "stream dropped" };
  assert.equal(getAssistantErrorMessage(partial), "stream dropped");

  // Missing errorMessage falls back to a generic box.
  const silent = { ...assistant([]), stopReason: "error" };
  assert.equal(getAssistantErrorMessage(silent), "Model request failed.");

  // Successful and aborted messages carry no error.
  assert.equal(getAssistantErrorMessage(assistant([{ type: "text", text: "done" }])), null);
  assert.equal(getAssistantErrorMessage({ ...assistant([]), stopReason: "aborted" }), null);
});
