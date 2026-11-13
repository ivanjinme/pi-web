import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopStartupPage, startupSplashMarkup, startupSplashStyles } from "./startup-splash.mjs";

test("shared inner markup has 64 positioned golden-angle dots and a text-free progress bar", () => {
  assert.equal((startupSplashMarkup.match(/class="sp-dot"/g) ?? []).length, 64);
  assert.doesNotMatch(startupSplashMarkup, /<p>|正在加载工作区|首次打开/);
  assert.ok(!startupSplashMarkup.includes("<main"));
  assert.ok(!startupSplashMarkup.includes('id="startup-splash"'));
  assert.match(startupSplashMarkup, /class="sp-line" role="progressbar" aria-label="正在启动 Weclio"/);
  assert.doesNotMatch(startupSplashMarkup, /aria-valuenow/);
  const positions = [...startupSplashMarkup.matchAll(/--x:([^;]+);--y:([^;]+)/g)];
  assert.equal(new Set(positions.map((match) => `${match[1]},${match[2]}`)).size, 64);
  assert.ok(positions.every((match) => Math.hypot(parseFloat(match[1]), parseFloat(match[2])) < 106));
});

test("desktop and app share the same text-free splash markup", () => {
  const html = desktopStartupPage();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<main id="startup-splash" role="status" aria-label="正在启动 Weclio">/);
  assert.ok(html.includes(startupSplashMarkup));
  assert.doesNotMatch(html, /<p>|正在加载工作区|首次打开/);
  assert.ok(!startupSplashStyles.includes("prefers-color-scheme"));
  assert.ok(html.includes("prefers-color-scheme: dark"));
  assert.doesNotThrow(() => decodeURIComponent(encodeURIComponent(html)));
});

test("progress bar uses a delayed thin sweep and stops during exit or reduced motion", () => {
  assert.match(startupSplashStyles, /width: min\(320px, calc\(100vw - 48px\)\);\s+height: 2px;/);
  assert.match(startupSplashStyles, /sp-line-in 400ms ease-out 1200ms forwards/);
  assert.match(startupSplashStyles, /sp-sweep 1400ms ease-in-out 1200ms infinite/);
  assert.match(startupSplashStyles, /#startup-splash\[data-exit\] \.sp-line::after \{ animation: none; \}/);
  assert.match(startupSplashStyles, /prefers-reduced-motion: reduce[\s\S]*\.sp-line \{ display: none; \}/);
});

test("exit keeps particle scatter without an expanding wave", () => {
  assert.doesNotMatch(startupSplashMarkup + startupSplashStyles, /sp-exit-wave|sp-wave-exit/);
  assert.match(startupSplashStyles, /#startup-splash\[data-exit\] \.sp-dot \{ animation: sp-scatter/);
  assert.match(startupSplashStyles, /#startup-splash\[data-exit\] \.sp-line \{ opacity: 1; animation: sp-line-out/);
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
