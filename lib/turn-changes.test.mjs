import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { deriveTurnChanges } = await jiti.import("./turn-changes.ts");
const user = (content = "Change files") => ({ role: "user", content });
const call = (toolCallId, toolName = "edit", input = { path: "demo.ts", edits: [{ oldText: "old", newText: "new" }] }) => ({
  role: "assistant", model: "test", provider: "test",
  content: [{ type: "toolCall", toolCallId, toolName, input }],
});
const patch = `--- a/demo.ts
+++ b/demo.ts
@@ -10,3 +10,4 @@
 before
-old
+new
+extra
 after
`;
const result = (toolCallId, extra = {}) => ({ role: "toolResult", toolCallId, content: [], details: { patch }, ...extra });

test("groups only by user turns, not compactions, preserving chronological order", () => {
  const turns = deriveTurnChanges([
    user(), call("one"), result("one"),
    { role: "custom", customType: "compactionSummary", content: "Summary", display: true },
    call("two", "edit", { path: "other.ts", edits: [{ oldText: "old", newText: "new" }] }), result("two"),
    user("No file changes"), { role: "bashExecution", command: "touch manual.txt", output: "" },
    user(), call("three"), result("three"),
  ]);
  assert.deepEqual(turns.map((turn) => [turn.id, turn.turnIndex, turn.files.length]), [["turn-0", 0, 2], ["turn-2", 2, 1]]);
  assert.equal(turns.at(-1).files[0].sections[0].toolCallId, "three");
  assert.equal(turns[0].added, 4);
  assert.equal(turns[0].removed, 2);
});

test("keeps separate sections for repeated same-path tool calls and uses actual patch rows", () => {
  const turns = deriveTurnChanges([user(), call("one"), result("one"), call("two"), result("two")]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].files.length, 1);
  const file = turns[0].files[0];
  assert.deepEqual(file.sections.map((section) => section.toolCallId), ["one", "two"]);
  assert.equal(file.added, 4);
  assert.equal(file.removed, 2);
  assert.deepEqual(file.sections[0].rows, [
    { kind: "hunk", text: "@@ -10,3 +10,4 @@" },
    { kind: "context", oldNo: 10, newNo: 10, text: "before" },
    { kind: "removed", oldNo: 11, newNo: null, text: "old" },
    { kind: "added", oldNo: null, newNo: 11, text: "new" },
    { kind: "added", oldNo: null, newNo: 12, text: "extra" },
    { kind: "context", oldNo: 12, newNo: 13, text: "after" },
  ]);
});

test("excludes failed, pending, zero-change edits, shell and legacy fallback records", () => {
  assert.deepEqual(deriveTurnChanges([
    user(), call("pending"), call("failed"), result("failed", { isError: true }),
    call("noop"), result("noop", { details: { patch: "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n same\n" } }),
    call("legacy"), result("legacy", { details: { diff: "-old\n+new" } }),
    call("shell", "bash", { command: "echo new > demo.ts" }), result("shell"),
    call("old-input", "edit", { path: "demo.ts", oldText: "old", newText: "new" }), result("old-input"),
  ]), []);
});

test("write content has no inferred additions and mixed aggregates include edits only", () => {
  const turns = deriveTurnChanges([
    user(), call("write", "write", { path: "demo.ts", content: "new\ncontent\n" }), result("write", { details: undefined }),
    call("edit"), result("edit"),
    call("empty", "write", { path: "empty.txt", content: "" }), result("empty", { details: undefined }),
    call("failed-write", "write", { path: "failed.txt", content: "no" }), result("failed-write", { isError: true }),
    call("pending-write", "write", { path: "pending.txt", content: "no" }),
  ]);
  assert.equal(turns[0].files.length, 2);
  assert.deepEqual(turns[0].files[0].sections[0], { kind: "write", toolCallId: "write", content: "new\ncontent\n" });
  assert.equal(turns[0].added, 2);
  assert.equal(turns[0].removed, 1);
  assert.equal(turns[0].files[1].added, 0);
  assert.equal(turns[0].files[1].removed, 0);
});

test("does not mutate input messages and ignores unowned calls before a user turn", () => {
  const messages = [call("orphan"), result("orphan"), user(), call("owned"), result("owned")];
  const original = structuredClone(messages);
  assert.equal(deriveTurnChanges(messages)[0].files[0].sections.length, 1);
  assert.deepEqual(messages, original);
});
