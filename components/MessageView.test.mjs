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
