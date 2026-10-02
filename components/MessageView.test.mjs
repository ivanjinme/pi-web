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

function renderMessage(message) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(MessageView, { message })),
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
