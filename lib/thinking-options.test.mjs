import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { resolveThinkingLevel } from "./thinking-level.ts";

const inputSource = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

test("thinking menu renders SDK levels directly instead of filtering a hardcoded list", async () => {
  const modelsSource = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");

  assert.match(modelsSource, /thinkingLevels\[key\] = getSupportedThinkingLevels\(m\)/);
  assert.match(inputSource, /thinkingOptions = availableThinkingLevels \?\? \[\]/);
  assert.match(inputSource, /thinkingOptions\.map\(/);
  assert.doesNotMatch(inputSource, /THINKING_LEVELS|availableThinkingLevels\.includes/);
});

test("thinking menu has one label column without duplicated descriptions", () => {
  const menuSource = inputSource.slice(
    inputSource.indexOf("{thinkingDropdownOpen && ("),
    inputSource.indexOf("{!isStreaming && onToolPresetChange && ("),
  );

  assert.match(menuSource, /\{lvl\}/);
  assert.match(menuSource, /onThinkingLevelChange\(lvl\)/);
  assert.doesNotMatch(menuSource, /\{desc\}|THINKING_LEVEL_DESC_KEYS|chat\.thinking|thinkingLevelMap|mappedVal|showOriginal/);
});

test("minimal and low stay distinct Pi levels even when both map to low", () => {
  const levels = getSupportedThinkingLevels({
    reasoning: true,
    thinkingLevelMap: { minimal: "low", low: "low" },
  });

  assert.ok(levels.includes("minimal"));
  assert.ok(levels.includes("low"));
  assert.ok(!levels.includes("auto"));
});

test("new drafts default to medium without exposing or sending an auto level", async () => {
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

  assert.match(hookSource, /ThinkingLevelOption = ThinkingLevel;/);
  assert.match(hookSource, /\[requestedThinkingLevel, setThinkingLevel\] = useState<ThinkingLevelOption \| null>\(isNew \? "medium" : null\)/);
  assert.match(hookSource, /resolveThinkingLevel\(requestedThinkingLevel, displayModel/);
  assert.match(hookSource, /thinkingLevel !== null \? \{ thinkingLevel \} : \{\}/);
  assert.doesNotMatch(hookSource, /thinkingLevel[^\n]*"auto"|level === "auto"/);
  assert.doesNotMatch(inputSource, /thinking(?:Level|Options|DisplayLabel)[^\n]*"auto"|thinkingLevelMap/);
  assert.match(hookSource, /if \(d\.context\.thinkingLevel\) \{/);
});

test("draft thinking resolution matches SDK clamping for every capability subset", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (let mask = 1; mask < 1 << levels.length; mask++) {
    const model = {
      reasoning: true,
      thinkingLevelMap: Object.fromEntries(levels.map((level, index) => [level, mask & (1 << index) ? level : null])),
    };
    const supported = getSupportedThinkingLevels(model);
    for (const requested of levels) {
      assert.equal(resolveThinkingLevel(requested, supported), clampThinkingLevel(model, requested));
    }
  }
  assert.equal(resolveThinkingLevel("medium", getSupportedThinkingLevels({ reasoning: false })), "off");
  assert.equal(resolveThinkingLevel(null, ["off"]), null);
  assert.equal(resolveThinkingLevel("medium", undefined), "medium");
});
