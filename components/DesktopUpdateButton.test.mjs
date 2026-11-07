import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const source = await readFile(new URL("./DesktopUpdateButton.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");

function harness(bridge, locale = enLocale) {
  let state = { status: "idle" };
  let effect;
  let updates = 0;
  const errors = [];
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    window: { weclioDesktop: bridge },
    console: { error: (...args) => errors.push(args) },
    require(id) {
      if (id === "react") return {
        useState: () => [state, (next) => { state = next; updates++; }],
        useEffect: (callback) => { effect = callback; },
      };
      if (id === "@/hooks/useI18n") return {
        useI18n: () => ({ locale: locale.id, t: (key) => locale.messages[key] }),
      };
      return require(id);
    },
  });
  const render = () => exports.DesktopUpdateButton();
  render();
  const cleanup = effect();
  return { render, cleanup, errors, updates: () => updates, setLocale: (next) => { locale = next; } };
}

function bridgeFixture() {
  let listener;
  let resolve;
  let reject;
  let unsubscribed = false;
  let restartCalls = 0;
  const restartLocales = [];
  const calls = [];
  return {
    calls,
    bridge: {
      onUpdateState(callback) {
        calls.push("subscribe");
        listener = callback;
        return () => { unsubscribed = true; };
      },
      getUpdateState() {
        calls.push("snapshot");
        return new Promise((yes, no) => { resolve = yes; reject = no; });
      },
      async restartUpdate(locale) { restartCalls++; restartLocales.push(locale); },
    },
    emit: (state) => listener(state),
    resolve: (state) => resolve(state),
    reject: (error) => reject(error),
    unsubscribed: () => unsubscribed,
    restartCalls: () => restartCalls,
    restartLocales: () => restartLocales,
  };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("browser without desktop bridge renders nothing", () => {
  const view = harness(undefined);
  assert.equal(view.render(), null);
  assert.equal(view.cleanup, undefined);
});

test("idle/checking stay hidden; downloading shows only a localized spinner", async () => {
  for (const locale of [enLocale, zhCNLocale]) {
    const fixture = bridgeFixture();
    const view = harness(fixture.bridge, locale);
    assert.deepEqual(fixture.calls, ["subscribe", "snapshot"]);
    fixture.resolve({ status: "idle" });
    await settle();
    assert.equal(view.render(), null);
    fixture.emit({ status: "checking" });
    assert.equal(view.render(), null);
    fixture.emit({ status: "downloading" });
    const html = renderToStaticMarkup(view.render());
    assert.ok(html.includes(`aria-label="${locale.messages["desktopUpdate.downloading"]}"`));
    assert.match(html, /desktop-update-spinner/);
    assert.doesNotMatch(html, /<button|New version|新版本/);
    view.cleanup();
  }
});

test("downloaded snapshot shows a localized, always-clickable restart button", async () => {
  for (const locale of [enLocale, zhCNLocale]) {
    const fixture = bridgeFixture();
    const view = harness(fixture.bridge, locale);
    fixture.resolve({ status: "downloaded", version: "2.0.0" });
    await settle();
    const button = view.render();
    const html = renderToStaticMarkup(button);
    assert.ok(html.includes(locale.messages["desktopUpdate.restart"]));
    assert.match(html, /<button[^>]*type="button"/);
    assert.doesNotMatch(html, /disabled|spinner/);
    await button.props.onClick();
    await view.render().props.onClick();
    assert.equal(fixture.restartCalls(), 2);
    assert.deepEqual(fixture.restartLocales(), [locale.id, locale.id]);
    view.cleanup();
  }
});

test("switching language updates the ready label and native dialog locale without resubscribing", async () => {
  const fixture = bridgeFixture();
  const view = harness(fixture.bridge);
  fixture.resolve({ status: "downloaded" });
  await settle();
  assert.match(renderToStaticMarkup(view.render()), /New version/);
  await view.render().props.onClick();
  view.setLocale(zhCNLocale);
  assert.match(renderToStaticMarkup(view.render()), /新版本/);
  await view.render().props.onClick();
  assert.deepEqual(fixture.restartLocales(), ["en", "zh-CN"]);
  assert.deepEqual(fixture.calls, ["subscribe", "snapshot"]);
  view.cleanup();
});

test("newer subscription events win over a late snapshot and unmount cancels updates", async () => {
  const fixture = bridgeFixture();
  const view = harness(fixture.bridge);
  fixture.emit({ status: "downloaded" });
  fixture.resolve({ status: "checking" });
  await settle();
  assert.equal(view.render().type, "button");
  view.cleanup();
  assert.equal(fixture.unsubscribed(), true);
  const updates = view.updates();
  fixture.emit({ status: "downloading" });
  assert.equal(view.updates(), updates);
});

test("snapshot resolving after unmount does not update state", async () => {
  const fixture = bridgeFixture();
  const view = harness(fixture.bridge);
  view.cleanup();
  fixture.resolve({ status: "downloaded" });
  await settle();
  assert.equal(view.updates(), 0);
});

test("snapshot and restart failures are logged without changing visibility or disabling retry", async () => {
  const fixture = bridgeFixture();
  const failure = new Error("IPC unavailable");
  fixture.bridge.restartUpdate = async () => { throw failure; };
  const view = harness(fixture.bridge);
  fixture.reject(failure);
  await settle();
  assert.equal(view.render(), null);
  assert.equal(view.errors.length, 1);
  fixture.emit({ status: "downloaded" });
  await view.render().props.onClick();
  assert.equal(view.errors.length, 2);
  assert.equal(view.render().props.disabled, undefined);
  view.cleanup();
});

test("update entry is an independent sibling after the user-menu trigger", async () => {
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /<span className="sidebar-user-name">super user<\/span>\s*<\/button>\s*<DesktopUpdateButton \/>/);
  assert.doesNotMatch(source, /setInterval|setTimeout|alert\(|confirm\(|disabled=/);
});
