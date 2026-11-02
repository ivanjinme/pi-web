import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const mainUrl = new URL("./main.mjs", import.meta.url).href;
const mock = `
import { EventEmitter } from 'node:events';
export const app = Object.assign(new EventEmitter(), {
  exits: [], quits: 0,
  setName() {}, whenReady: async () => {},
  exit(code) { this.exits.push(code); },
  quit() { this.quits++; }
});
export const dialog = {
  errors: [], prompts: [],
  showErrorBox(...args) { this.errors.push(args); },
  async showMessageBox(...args) { this.prompts.push(args); return { response: 0 }; }
};
export const shell = {
  opened: [],
  async openExternal(url) { this.opened.push(url); }
};
export class BrowserWindow extends EventEmitter {
  static windows = [];
  constructor(options) {
    super(); this.options = options; this.shown = 0; this.reloads = 0; this.urls = []; this.overlayUpdates = []; this.fullscreen = false;
    this.webContents = Object.assign(new EventEmitter(), {
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      scripts: [],
      async executeJavaScript(script) { this.scripts.push(script); },
      setWindowOpenHandler(handler) { this.openWindow = handler; }
    });
    BrowserWindow.windows.push(this);
  }
  async loadURL(url) { this.urls.push(url); }
  show() { this.shown++; }
  setTitleBarOverlay(options) { this.overlayUpdates.push(options); }
  reload() { this.reloads++; }
  isDestroyed() { return false; }
  isFullScreen() { return this.fullscreen; }
}
`;

function runMain(check, platform = process.platform) {
  const mockUrl = `data:text/javascript,${encodeURIComponent(mock)}`;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { setImmediate } from 'node:timers/promises';
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'electron' ? { url: ${JSON.stringify(mockUrl)}, shortCircuit: true } : next(specifier, context);
    }});
    const { app, BrowserWindow, dialog, shell } = await import('electron');
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    await import(${JSON.stringify(mainUrl)});
    await setImmediate();
    const window = BrowserWindow.windows[0];
    ${check}
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }));
}

test("desktop waits for its first paint before showing the window", () => {
  runMain(`
    assert.equal(window.shown, 0);
    window.emit('ready-to-show');
    assert.equal(window.shown, 1);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
  `);
});

test("Windows overlays native window controls without a preload or renderer Node integration", () => {
  runMain(`
    assert.equal(window.options.titleBarStyle, 'hidden');
    assert.deepEqual(window.options.titleBarOverlay, { color: '#f8f7ff', symbolColor: '#1d1e21', height: 40 });
    assert.equal(window.options.webPreferences.preload, undefined);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
  `, 'win32');
});

test("non-Windows platforms retain their native title bar", () => {
  for (const platform of ['darwin', 'linux']) {
    runMain(`
      assert.equal(window.options.titleBarStyle, undefined);
      assert.equal(window.options.titleBarOverlay, undefined);
      assert.equal(window.webContents.listenerCount('did-change-theme-color'), 0);
    `, platform);
  }
});

test("native fullscreen state is synchronized on transitions and page reload", () => {
  runMain(`
    window.webContents.emit('dom-ready');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, false/);
    window.fullscreen = true;
    window.emit('enter-full-screen');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, true/);
    window.webContents.emit('dom-ready');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, true/);
    window.fullscreen = false;
    window.emit('leave-full-screen');
    assert.match(window.webContents.scripts.at(-1), /data-native-fullscreen.*, false/);
  `, 'win32');
});

test("theme-color metadata updates native button colors with readable contrast", () => {
  runMain(`
    window.webContents.emit('did-change-theme-color', {}, '#2e2e2e');
    assert.deepEqual(window.overlayUpdates.at(-1), { color: '#2e2e2e', symbolColor: '#f0f1f2' });
    window.webContents.emit('did-change-theme-color', {}, '#f8f7ff');
    assert.deepEqual(window.overlayUpdates.at(-1), { color: '#f8f7ff', symbolColor: '#1d1e21' });
    window.webContents.emit('did-change-theme-color', {}, null);
    assert.equal(window.overlayUpdates.length, 2);
  `, 'win32');
});

test("full-history popups open in the browser without replacing the application", () => {
  runMain(`
    const appUrl = window.urls[0];
    const url = appUrl + '/api/sessions/test/export?inline=1';
    assert.deepEqual(window.webContents.openWindow({ url }), { action: 'deny' });
    await setImmediate();
    assert.deepEqual(shell.opened, [url]);
    assert.deepEqual(window.urls, [appUrl]);
    assert.deepEqual(app.exits, []);
  `);
});

test("external HTTP links open in the browser while unsafe popup schemes stay blocked", () => {
  runMain(`
    const url = 'https://example.com/docs';
    assert.deepEqual(window.webContents.openWindow({ url }), { action: 'deny' });
    for (const blocked of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,test', 'vscode://file/test', 'blob:' + window.urls[0] + '/test']) {
      assert.deepEqual(window.webContents.openWindow({ url: blocked }), { action: 'deny' });
    }
    await setImmediate();
    assert.deepEqual(shell.opened, [url]);
    assert.equal(window.urls.length, 1);
  `);
});

test("a clean renderer exit does not terminate the desktop", () => {
  runMain(`
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await setImmediate();
    assert.deepEqual(app.exits, []);
    assert.equal(app.quits, 0);
    assert.equal(dialog.errors.length, 0);
    assert.equal(dialog.prompts.length, 0);
  `);
});

test("a renderer crash offers reload instead of immediately terminating the desktop", () => {
  runMain(`
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await setImmediate();
    assert.deepEqual(app.exits, []);
    assert.equal(app.quits, 0);
    assert.equal(dialog.prompts.length, 1);
    assert.equal(window.reloads, 1);
  `);
});
