import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(MessageView, { ...props, message })),
  );
}

test("does not render system instructions as user or assistant chat bubbles", () => {
  assert.equal(renderMessage({
    role: "system",
    content: "Internal instructions",
    sections: { rules: "Project rules" },
    toolsAdded: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
  }), "");
});

for (const blockContent of [false, true]) {
  test(`renders expanded skill commands without their body (${blockContent ? "blocks" : "string"})`, () => {
    const text = '<skill name="frontend-design" location="/private/skills/frontend-design/SKILL.md">\nPrivate skill instructions\n</skill>\n\n设计首页';
    const message = {
      role: "user",
      content: blockContent ? [
        { type: "text", text },
        { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
      ] : text,
    };
    const original = structuredClone(message);
    const html = renderMessage(message);

    assert.match(html, /\/skill:frontend-design 设计首页/);
    assert.doesNotMatch(html, /Private skill instructions|\/private\/skills|&lt;skill/);
    if (blockContent) assert.match(html, /<img/);
    assert.deepEqual(message, original);
  });
}

for (const blockContent of [false, true]) {
  test(`hides skill bodies inserted in the middle of historical messages (${blockContent ? "blocks" : "string"})`, () => {
    const text = '前文 <skill name="design" location="/private/design/SKILL.md">\nPrivate design instructions\n</skill> 中间 <skill name="review" location="/private/review/SKILL.md">\nPrivate review instructions\n</skill> 后文';
    const message = { role: "user", content: blockContent ? [{ type: "text", text }] : text };
    const original = structuredClone(message);
    const html = renderMessage(message);
    assert.match(html, /前文 \/skill:design 中间 \/skill:review 后文/);
    assert.doesNotMatch(html, /Private (design|review) instructions|\/private\/|&lt;skill/);
    assert.deepEqual(message, original);
  });
}

const editMessage = {
  role: "assistant", model: "test", provider: "test",
  content: [
    { type: "toolCall", toolCallId: "edit-1", toolName: "edit", input: { path: "demo.ts", edits: [{ oldText: "old", newText: "new" }] } },
    { type: "toolCall", toolCallId: "read-1", toolName: "read", input: { path: "demo.ts" } },
    { type: "text", text: "Finished." },
  ],
};

test("only recorded changes add a jump button to the existing tool header", () => {
  const html = renderMessage(editMessage, {
    onOpenChanges: () => {}, changeToolCallIds: new Set(["edit-1"]),
  });
  assert.equal((html.match(/class="tool-changes-link"/g) ?? []).length, 1);
  assert.match(html, /aria-label="View in Changes"/);
  assert.match(html, />edit<\/span>/);
  assert.match(html, />read<\/span>/);
  assert.match(html, /Finished\./);
  let openButtons = 0;
  for (const [tag] of html.matchAll(/<\/?button\b[^>]*>/g)) {
    if (tag.startsWith("</")) openButtons--;
    else {
      assert.equal(openButtons, 0, "jump button must not be nested inside the expand button");
      openButtons++;
    }
  }
  assert.equal(openButtons, 0);
  assert.doesNotMatch(html, /data-turn-changes|files changed|Written content/);
});

test("unrecorded tools and messages without a jump handler retain their original headers", () => {
  assert.doesNotMatch(renderMessage(editMessage, {
    onOpenChanges: () => {}, changeToolCallIds: new Set(),
  }), /tool-changes-link/);
  assert.doesNotMatch(renderMessage(editMessage, {
    changeToolCallIds: new Set(["edit-1"]),
  }), /tool-changes-link/);
});

test("memoization updates affected tool links without invalidating unrelated history", () => {
  const before = { message: editMessage, onOpenChanges: () => {}, changeToolCallIds: new Set() };
  assert.equal(MessageView.compare(before, { ...before, changeToolCallIds: new Set(["other-call"]) }), true);
  assert.equal(MessageView.compare(before, { ...before, changeToolCallIds: new Set(["edit-1"]) }), false);
  assert.equal(MessageView.compare(before, { ...before, onOpenChanges: () => {} }), false);
});

const largeText = `<strong>${"x".repeat(100_000)}</strong>`;

for (const [name, message] of [
  ["user", { role: "user", content: largeText }],
  ["assistant", { role: "assistant", content: [{ type: "text", text: largeText }] }],
]) {
  test(`renders oversized ${name} messages on demand as plain text`, () => {
    const html = renderMessage(message);

    assert.match(html, /Message exceeds 100,000 characters/);
    assert.doesNotMatch(html, /<strong>/);
  });
}
