import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractSlashToken, composerText, completionText, serializeComposer, restoreComposerText } = await jiti.import("./composer.ts");
const { getDraft, setDraft, clearDraft } = await jiti.import("./draft-store.ts");

for (const text of ["/", "正文 /", "正文\n/", "正文 /design 后文"]) {
  test(`slash completion at a valid boundary: ${JSON.stringify(text)}`, () => {
    const cursor = text.includes(" 后文") ? text.indexOf(" 后文") : text.length;
    assert.equal(extractSlashToken(text, cursor)?.query, text.includes("design") ? "design" : "");
  });
}

for (const text of ["正文/", "https://", "./", "a/b/", " /design args", "正文\t/"]) {
  test(`slash does not trigger inside ordinary text: ${JSON.stringify(text)}`, () => {
    assert.equal(extractSlashToken(text, text.length), null);
  });
}

test("skill references retain position and identity through serialization and history restore", () => {
  const parts = [{ type: "text", text: "前文 " }, { type: "skill", name: "design" }, { type: "text", text: " 后文" }];
  assert.equal(composerText(parts), "前文 design 后文");
  assert.equal(serializeComposer(parts), "前文 /skill:design 后文");
  const expanded = '前文 <skill name="design" location="/skills/design/SKILL.md">\nDefinition\n</skill> 后文';
  assert.deepEqual(restoreComposerText(expanded), parts);
  assert.deepEqual(restoreComposerText(expanded.replace("</skill> 后文", "</skill>，后文")), [
    parts[0], parts[1], { type: "text", text: "，后文" },
  ]);
  assert.equal(completionText(parts).length, composerText(parts).length);
  assert.equal(extractSlashToken(completionText([...parts.slice(0, 2), { type: "text", text: "/" }]), 10), null);
});

test("history restore leaves literal skill commands as text", () => {
  for (const text of [
    "/skill:design",
    "请解释 /skill:design 的作用，不要执行它",
    "前文 /skill:design，请检查",
    "/skill:design/skill:review",
  ]) {
    assert.deepEqual(restoreComposerText(text), [{ type: "text", text }]);
  }
});

test("history restore distinguishes expanded skills from literal commands", () => {
  const text = '解释 /skill:design，然后 <skill name="review" location="/skills/review/SKILL.md">\nInstructions\n</skill>，检查 /skill:unknown';
  assert.deepEqual(restoreComposerText(text), [
    { type: "text", text: "解释 /skill:design，然后 " },
    { type: "skill", name: "review" },
    { type: "text", text: "，检查 /skill:unknown" },
  ]);
});

test("drafts keep skill nodes and clone their contents", () => {
  const parts = [{ type: "skill", name: "design" }];
  setDraft("skill-draft-test", { parts, images: [] });
  parts[0].name = "mutated";
  const draft = getDraft("skill-draft-test");
  assert.equal(draft.parts[0].name, "design");
  draft.parts[0].name = "also-mutated";
  assert.equal(getDraft("skill-draft-test").parts[0].name, "design");
  clearDraft("skill-draft-test");
});
