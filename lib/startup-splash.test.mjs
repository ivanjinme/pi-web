import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopStartupPage, startupSplashMarkup, startupSplashStyles } from "./startup-splash.mjs";

test("shared inner markup has 64 positioned golden-angle dots and exactly one status paragraph", () => {
  assert.equal((startupSplashMarkup.match(/class="sp-dot"/g) ?? []).length, 64);
  assert.equal((startupSplashMarkup.match(/<p>/g) ?? []).length, 1);
  assert.ok(!startupSplashMarkup.includes("<main"));
  assert.ok(!startupSplashMarkup.includes('id="startup-splash"'));
  assert.match(startupSplashMarkup, /<p>正在加载工作区…<\/p>/);
  const positions = [...startupSplashMarkup.matchAll(/--x:([^;]+);--y:([^;]+)/g)];
  assert.equal(new Set(positions.map((match) => `${match[1]},${match[2]}`)).size, 64);
  assert.ok(positions.every((match) => Math.hypot(parseFloat(match[1]), parseFloat(match[2])) < 106));
});

test("desktop HTML preserves the shared markup except for its tool preparation status", () => {
  const html = desktopStartupPage();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<main id="startup-splash" role="status" aria-label="正在启动 Weclio">/);
  assert.ok(html.includes(startupSplashMarkup.replace("正在加载工作区…", "首次打开需要准备内置扩展与技能，请稍候。")));
  assert.equal((html.match(/<p>/g) ?? []).length, 1);
  assert.ok(!startupSplashStyles.includes("prefers-color-scheme"));
  assert.ok(html.includes("prefers-color-scheme: dark"));
  assert.doesNotThrow(() => decodeURIComponent(encodeURIComponent(html)));
});

test("shared styles support fullscreen coverage, explicit handoff, and static reduced motion", () => {
  assert.match(startupSplashStyles, /position: fixed;\s+inset: 0;/);
  assert.match(startupSplashStyles, /#startup-splash\[hidden\] \{ display: none; \}/);
  assert.match(startupSplashStyles, /#startup-content\[data-visible\] \{ opacity: 1; \}/);
  assert.match(startupSplashStyles, /html\.dark #startup-splash/);
  assert.match(startupSplashStyles, /#startup-content \{[^}]*flex-direction: column;/);
  assert.match(startupSplashStyles, /sp-backdrop-exit 1500ms/);
  assert.match(startupSplashStyles, /prefers-reduced-motion: reduce/);
  assert.match(startupSplashStyles, /sp-fade-exit 200ms/);
  assert.match(startupSplashStyles, /transform: translate3d\(var\(--x\), var\(--y\), 0\)/);
});
