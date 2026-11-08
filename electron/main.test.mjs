import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const mainUrl = new URL("./main.mjs", import.meta.url).href;
const mock = `
import { EventEmitter } from 'node:events';
export const app = Object.assign(new EventEmitter(), {
  exits: [], quits: 0,
  setName() {}, whenReady: async () => {}, getPath: () => 'test-logs',
  exit(code) { this.exits.push(code); },
  quit() { this.quits++; }
});
export const dialog = {
  errors: [], prompts: [],
  showErrorBox(...args) { this.errors.push(args); },
  async showMessageBox(...args) { this.prompts.push(args); return { response: 0 }; }
};
export const ipcMain = { handle() {}, removeHandler() {} };
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

function runMain(check, platform = process.platform, packaged = false, pending = false, setup = "") {
  const mockUrl = `data:text/javascript,${encodeURIComponent(mock)}`;
  const productionUrl = `data:text/javascript,${encodeURIComponent(`
    import assert from 'node:assert/strict';
    import { BrowserWindow } from 'electron';
    export const starts = [];
    export let stops = 0;
    export async function startProductionServer(options) {
      assert.equal(BrowserWindow.windows.length, 1);
      assert.ok(BrowserWindow.windows[0].urls[0].startsWith('data:text/html'));
      starts.push(options);
      if (${pending}) await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('startup cancelled')),{once:true}));
      return { stop() { stops++; } };
    }
  `)}`;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { setImmediate } from 'node:timers/promises';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
      if (${packaged} && specifier === './production.mjs') return { url: ${JSON.stringify(productionUrl)}, shortCircuit: true };
      return next(specifier, context);
    }});
    const { app, BrowserWindow, dialog, shell } = await import('electron');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const profile = mkdtempSync(join(tmpdir(), 'weclio-main-test-'));
    process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
    app.getPath = (name) => name === 'userData' ? profile : 'test-logs';
    const production = ${packaged} ? await import(${JSON.stringify(productionUrl)}) : null;
    app.isPackaged = ${packaged};
    process.resourcesPath = 'test-resources';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    ${setup}
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

test("Windows overlays native window controls with a sandboxed preload and no renderer Node integration", () => {
  runMain(`
    assert.equal(window.options.titleBarStyle, 'hidden');
    assert.deepEqual(window.options.titleBarOverlay, { color: '#f8f7ff', symbolColor: '#1d1e21', height: 40 });
    assert.match(window.options.webPreferences.preload, /preload\.cjs$/);
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

test("packaged mode shows initialization before starting its service and stops it on quit", () => {
  runMain(`
    assert.equal(production.starts.length, 1);
    assert.equal(production.starts[0].resourcesPath, 'test-resources');
    assert.equal(production.starts[0].logsPath, 'test-logs');
    assert.match(decodeURIComponent(window.urls[0]), /正在启动 Weclio/);
    assert.equal(production.starts[0].url, window.urls[1]);
    assert.equal(production.starts[0].signal.aborted, false);
    app.emit('before-quit');
    assert.equal(production.stops, 0);
    assert.equal(production.starts[0].signal.aborted, false);
    app.emit('will-quit');
    assert.equal(production.stops, 1);
    assert.equal(production.starts[0].signal.aborted, true);
  `, 'win32', true);
});

test("shared tools are profile-independent and startup progress is throttled", () => {
  runMain(`
    if (process.env.LOCALAPPDATA) {
      assert.equal(production.starts[0].toolsetsBase, process.env.LOCALAPPDATA);
      assert.notEqual(production.starts[0].toolsetsBase, profile);
    }
    const now = Date.now;
    Date.now = () => 1000;
    try {
      const progress = production.starts[0].onToolProgress;
      const count = window.webContents.scripts.length;
      progress({ phase:'copying', completedFiles:0, totalFiles:5 });
      progress({ phase:'copying', completedFiles:1, totalFiles:5 });
      progress({ phase:'ready', completedFiles:5, totalFiles:5, reused:false });
      progress({ phase:'ready', completedFiles:5, totalFiles:5, reused:true });
      assert.equal(window.webContents.scripts.length, count + 2);
      assert.match(window.webContents.scripts.at(-1), /5\\/5/);
    } finally { Date.now = now; }
  `, 'win32', true);
});

test("packaged startup restores its remembered port before loading or authorizing the window", () => {
  runMain(`
    assert.equal(production.starts[0].url, 'http://127.0.0.1:8890');
    assert.equal(window.urls[1], 'http://127.0.0.1:8890');
    const navigation = await import(new URL('./navigation.mjs', ${JSON.stringify(mainUrl)}).href);
    assert.equal(navigation.isAppUrl('http://127.0.0.1:8890/api/sessions'), true);
    assert.equal(navigation.isAppUrl('http://127.0.0.1:8888/api/sessions'), false);
  `, 'win32', true, false, `
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(profile, 'desktop-port.json'), JSON.stringify({ port: 8890 }));
    delete process.env.PORT;
    delete process.env.WECLIO_DESKTOP_URL;
  `);
});

test("closing the startup window cancels initialization without a failure dialog", () => {
  runMain(`
    assert.equal(window.urls.length, 1);
    app.emit('before-quit');
    assert.equal(production.starts[0].signal.aborted, false);
    app.emit('will-quit');
    await setImmediate();
    assert.equal(production.starts[0].signal.aborted, true);
    assert.equal(window.urls.length, 1);
    assert.deepEqual(dialog.errors, []);
    assert.deepEqual(app.exits, []);
  `, 'win32', true, true);
});

test("a packaged service failure reports the error and cleans up before exit", () => {
  runMain(`
    production.starts[0].onUnexpectedExit(new Error('service failed'));
    assert.deepEqual(app.exits, [1]);
    assert.equal(production.stops, 1);
    assert.match(dialog.errors[0][1], /service failed/);
  `, 'win32', true);
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
