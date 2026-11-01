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
    super(); this.options = options; this.shown = 0; this.reloads = 0; this.urls = [];
    this.webContents = Object.assign(new EventEmitter(), {
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      setWindowOpenHandler(handler) { this.openWindow = handler; }
    });
    BrowserWindow.windows.push(this);
  }
  async loadURL(url) { this.urls.push(url); }
  show() { this.shown++; }
  reload() { this.reloads++; }
  isDestroyed() { return false; }
}
`;

function runMain(check) {
  const mockUrl = `data:text/javascript,${encodeURIComponent(mock)}`;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { setImmediate } from 'node:timers/promises';
    registerHooks({ resolve(specifier, context, next) {
      return specifier === 'electron' ? { url: ${JSON.stringify(mockUrl)}, shortCircuit: true } : next(specifier, context);
    }});
    const { app, BrowserWindow, dialog, shell } = await import('electron');
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
