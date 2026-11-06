import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createEditor, $getSelection, $isRangeSelection } = await jiti.import("lexical");
const { $readDocument, $replaceDocument, $selectRange, $insertParts, selectedParts } = await jiti.import("./editor-document.ts");
const { SkillNode } = await jiti.import("./SkillNode.ts");
const { composerText } = await jiti.import("@/lib/composer");

function fixture(parts) {
  const editor = createEditor({ namespace: "test-composer", nodes: [SkillNode], onError(error) { throw error; } });
  editor.update(() => $replaceDocument(parts), { discrete: true });
  return editor;
}
const read = (editor) => editor.getEditorState().read($readDocument);
const text = (text) => ({ type: "text", text });
const skill = (name) => ({ type: "skill", name });

test("inserts a skill in the middle without replacing surrounding text", () => {
  const editor = fixture([text("前文 /de 后文")]);
  editor.update(() => {
    $selectRange(3, 6);
    $insertParts([skill("design"), text(" ")]);
  }, { discrete: true });
  assert.deepEqual(read(editor).parts, [text("前文 "), skill("design"), text("  后文")]);
  assert.equal(read(editor).start, 10);
});

test("selection offsets preserve newlines and UTF-16 text around skill nodes", () => {
  const editor = fixture([text("😀\n前 "), skill("design"), text(" 后\n结束")]);
  for (const offset of [0, 2, 3, 5, 11, 13, 14, 16]) {
    editor.update(() => $selectRange(offset), { discrete: true });
    assert.equal(read(editor).start, offset);
  }
  assert.equal(composerText(read(editor).parts), "😀\n前 design 后\n结束");
});

test("deleting a partial selection removes the whole skill token", () => {
  const editor = fixture([text("前 "), skill("design"), text(" 后")]);
  editor.update(() => {
    $selectRange(4, 6);
    const selection = $getSelection();
    assert.ok($isRangeSelection(selection));
    selection.removeText();
  }, { discrete: true });
  assert.deepEqual(read(editor).parts, [text("前  后")]);
});

test("copy selection and JSON round trip retain skill identity", () => {
  const parts = [text("前 "), skill("design"), text(" 后")];
  const editor = fixture(parts);
  assert.deepEqual(selectedParts(parts, 2, 8), [skill("design")]);
  const restored = createEditor({ namespace: "test-composer", nodes: [SkillNode], onError(error) { throw error; } });
  restored.setEditorState(restored.parseEditorState(editor.getEditorState().toJSON()));
  assert.deepEqual(read(restored).parts, parts);
});
