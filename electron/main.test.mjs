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
export const shell = { openExternal: async () => {} };
export class BrowserWindow extends EventEmitter {
  static windows = [];
  constructor(options) {
    super(); this.options = options; this.shown = 0; this.reloads = 0;
    this.webContents = Object.assign(new EventEmitter(), {
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      setWindowOpenHandler() {}
    });
    BrowserWindow.windows.push(this);
  }
  async loadURL() {}
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
    const { app, BrowserWindow, dialog } = await import('electron');
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
