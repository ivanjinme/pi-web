import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseUnifiedPatch } = await jiti.import("./patch.ts");
const { deriveTurnChanges } = await jiti.import("./turn-changes.ts");

const patch = `--- a/demo.txt
+++ b/demo.txt
@@ -1 +1 @@
--- old
+++ new
`;

test("header-looking lines inside a hunk stay content and contribute to turn counts", () => {
  const files = parseUnifiedPatch(patch);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].rows[1], {
    type: "line",
    left: { lineNo: 1, text: "-- old", type: "removed" },
    right: { lineNo: 1, text: "++ new", type: "added" },
  });
  const turns = deriveTurnChanges([
    { role: "user", content: "Edit" },
    { role: "assistant", model: "test", provider: "test", content: [{ type: "toolCall", toolCallId: "edit-1", toolName: "edit", input: { path: "demo.txt", edits: [{ oldText: "-- old", newText: "++ new" }] } }] },
    { role: "toolResult", toolCallId: "edit-1", content: [], details: { patch } },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].added, 1);
  assert.equal(turns[0].removed, 1);
});

test("recognizes real headers after hunk counts end, including zero-length sides", () => {
  const files = parseUnifiedPatch(`${patch}--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+++ literal
+last
--- a/deleted.txt
+++ /dev/null
@@ -1,1 +0,0 @@
--- removed
`);
  assert.equal(files.length, 3);
  assert.equal(files[1].newPath, "b/added.txt");
  assert.equal(files[1].rows[1].right.text, "++ literal");
  assert.equal(files[1].rows[2].right.lineNo, 2);
  assert.equal(files[2].rows[1].left.text, "-- removed");
});
