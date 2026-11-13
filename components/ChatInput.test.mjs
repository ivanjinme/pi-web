import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ContextRing } = await jiti.import("./composer/ComposerControls.tsx");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN");

function renderInput(props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, ...props }),
  ));
}

function renderRing(usage) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ContextRing, { usage }),
  ));
}

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("permission UI defaults to Full access independently of the tool preset", () => {
  for (const toolPreset of [undefined, "none", "default", "full"]) {
    let changes = 0;
    const html = renderInput({ toolPreset, onToolPresetChange() { changes++; } });
    assert.match(html, /aria-label="Permission mode: Full access"/);
    assert.match(html, /<span>Full access<\/span>/);
    assert.equal(changes, 0);
  }
});

test("shell footer groups permission separately from context, model, and circular send control", async () => {
  const html = renderInput({ contextUsage: { percent: 25, contextWindow: 1000, tokens: 250 } });
  assert.match(html, /class="composer-shell"><div class="composer-shell-editor">[\s\S]*?<\/div><div class="composer-shell-footer"><div class="composer-shell-permission"><button[^>]*aria-label="Permission mode: Full access"[\s\S]*?<\/button><\/div><div class="composer-shell-actions"><button[^>]*class="composer-context-ring"[\s\S]*?<\/button><button[^>]*class="composer-control-chip composer-model-chip"[\s\S]*?<\/button><button[^>]*class="composer-send-button"[^>]*disabled=""[^>]*aria-label="Send"/);
  const css = await readFile(new URL("./composer/composer.css", import.meta.url), "utf8");
  const sendRule = css.match(/\.composer-send-button\s*\{([^}]+)\}/)?.[1];
  assert.match(sendRule, /width:\s*32px/);
  assert.match(sendRule, /height:\s*32px/);
  assert.match(sendRule, /border-radius:\s*50%/);
});

test("composer uses the redesigned placeholder with English and Chinese messages", () => {
  assert.equal(enLocale.messages["chat.messagePlaceholder"], "Assign task, paste for image, @ for file, / for commands");
  assert.equal(zhCNLocale.messages["chat.messagePlaceholder"], "分配任务，粘贴图片，@ 引用文件，/ 调用命令");
  assert.ok(renderInput().includes(enLocale.messages["chat.messagePlaceholder"]));
  for (const [props, key] of [
    [{ isStreaming: true }, "chat.agentPlaceholder"],
    [{ isStreaming: true, onSteer() {} }, "chat.steerPlaceholder"],
    [{ isStreaming: true, onFollowUp() {} }, "chat.steerPlaceholder"],
    [{ isCompacting: true, isStreaming: true, onSteer() {} }, "chat.compacting"],
  ]) {
    assert.ok(renderInput(props).includes(enLocale.messages[key]));
  }
});

test("model chip shows selected provider's model name and raw thinking depth and locks while streaming", () => {
  const props = {
    model: { provider: "selected", modelId: "shared-id" },
    modelList: [
      { provider: "other", id: "shared-id", name: "Wrong provider name" },
      { provider: "selected", id: "shared-id", name: "Selected model name" },
    ],
    thinkingLevel: "minimal",
    availableThinkingLevels: ["off", "minimal", "low"],
    onModelChange() {},
    onThinkingLevelChange() {},
  };
  for (const isStreaming of [false, true]) {
    const html = renderInput({ ...props, isStreaming });
    const chip = html.match(/<button[^>]*class="composer-control-chip composer-model-chip"[^>]*>/)?.[0];
    assert.ok(chip);
    assert.equal(chip.includes('disabled=""'), isStreaming);
    assert.match(chip, /aria-haspopup="dialog" aria-expanded="false"/);
    assert.match(html, /class="composer-control-truncate">Selected model name<\/span><span class="composer-model-depth">· minimal<\/span>/);
    assert.doesNotMatch(html, /Wrong provider name/);
    if (isStreaming) assert.match(html, /class="composer-send-button"[^>]*aria-label="Stop agent"/);
  }
});

test("model chip falls back to model ID and unknown thinking depth", () => {
  const html = renderInput({ model: { provider: "custom", modelId: "unlisted-id" } });
  assert.match(html, /class="composer-control-truncate">unlisted-id<\/span><span class="composer-model-depth">· —<\/span>/);
});

test("context ring remains visible with an unknown summary until its percentage is known", () => {
  for (const usage of [undefined, null, { percent: null, contextWindow: 1000, tokens: 500 }]) {
    const html = renderRing(usage);
    assert.match(html, /class="composer-context-ring" data-severity="unknown"/);
    assert.match(html, /tokens · Unknown/);
    assert.doesNotMatch(html, /tokens · 0%/);
    assert.match(renderInput({ contextUsage: usage }), /composer-context-ring/);
  }
  assert.match(renderRing(null), /Context usage: — \/ — tokens · Unknown/);
  assert.match(renderRing({ percent: null, contextWindow: 1000, tokens: 500 }), /Context usage: 500 \/ 1.0k tokens · Unknown/);
});

test("context ring clamps percentage and applies severity thresholds to its accessible token summary", () => {
  for (const [percent, expected, severity] of [
    [-20, 0, "normal"], [0, 0, "normal"], [59, 59, "normal"],
    [60, 60, "warning"], [84, 84, "warning"], [85, 85, "critical"],
    [100, 100, "critical"], [150, 100, "critical"],
  ]) {
    const html = renderRing({ percent, contextWindow: 200_000, tokens: 12_345 });
    assert.ok(html.includes(`data-severity="${severity}"`));
    assert.ok(html.includes(`aria-label="Context usage: 12.3k / 200.0k tokens · ${expected}%"`));
    const dash = html.match(/stroke-dasharray="([^"]+)"/);
    assert.ok(dash);
    const [progress, circumference] = dash[1].split(" ").map(Number);
    assert.ok(Math.abs(circumference - 2 * Math.PI * 7) < 1e-10);
    assert.ok(Math.abs(progress - expected / 100 * circumference) < 1e-10);
  }
});

test("context ring formats missing, small, and million-scale token counts", () => {
  for (const [tokens, contextWindow, summary] of [
    [null, 2_000_000, "— / 2.0M"],
    [999, 1000, "999 / 1.0k"],
    [1_250_000, 2_500_000, "1.3M / 2.5M"],
    [0, 500, "0 / 500"],
  ]) {
    assert.ok(renderRing({ percent: 0, contextWindow, tokens }).includes(`Context usage: ${summary} tokens · 0%`));
  }
});
