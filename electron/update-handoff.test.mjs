import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { createUpdateInstaller } from "./update-install.mjs";

const require = createRequire(import.meta.url);
const { BaseUpdater } = require("electron-updater/out/BaseUpdater.js");

for (const fail of [false, true]) {
  test(`stock updater scheduled quit ${fail ? "is vetoed during recovery" : "continues after accepted close"}`, async (t) => {
    const electronMock = new URL("./.updater-electron-mock.cjs", import.meta.url).href;
    const hooks = registerHooks({
      resolve(name, context, next) {
        return name === "electron" ? { url: electronMock, shortCircuit: true } : next(name, context);
      },
      load(url, context, next) {
        return url === electronMock ? { format: "commonjs", source: "module.exports = { autoUpdater: { emit() {} } };", shortCircuit: true } : next(url, context);
      },
    });
    t.after(() => hooks.deregister());
    let closeFinished = false;
    let stopped = 0;
    let quitRequests = 0;
    let restored = 0;
    let errorListener;
    let release;
    let errorShown;
    const released = new Promise((resolve) => { release = resolve; });
    const shown = new Promise((resolve) => { errorShown = resolve; });
    const window = new EventEmitter();
    window.webContents = new EventEmitter();
    window.isDestroyed = () => closeFinished;
    window.close = () => { closeFinished = true; window.emit("closed"); };
    const app = { isPackaged: true, quit() {
      quitRequests++;
      assert.equal(closeFinished, true, "stock updater must not quit before the window closes");
      // 与 main.mjs 的 before-quit 拦截保持相同的实际调用顺序。
      if (!installer.isRecovering()) { stopped++; installer.dispose(); }
    } };
    const stock = {
      _logger: { info() {} }, app,
      install() {
        if (fail) process.nextTick(() => errorListener(new Error("Installer spawn failed")));
        return true;
      },
    };
    const service = {
      canInstall: () => true,
      verifyForInstall: async () => {},
      onInstallError(listener) { errorListener = listener; return () => { errorListener = undefined; }; },
      quitAndInstall: () => BaseUpdater.prototype.quitAndInstall.call(stock, true, true),
    };
    const installer = createUpdateInstaller({
      app, getService: () => service, getWindow: () => window,
      getGate: () => ({ inspect: async () => "ready", lock: async () => "ready", unlock: () => released }),
      dialog: { async showMessageBox(...args) {
        const options = args.at(-1);
        if (options.type === "error") errorShown();
        assert.notEqual(options.type, "question", "restart click must not require another confirmation");
        return { response: 0 };
      } },
      restoreWindow: async () => { restored++; }, log() {},
    });
    await installer.restart("en");
    await nextTurn();
    assert.equal(quitRequests, 1, "exercise the real upstream setImmediate quit");
    if (fail) {
      assert.equal(installer.isRecovering(), true);
      assert.equal(stopped, 0, "a launch error must not stop the server");
      assert.equal(restored, 0, "simulate a still-pending unlock acknowledgement");
      release();
      await shown;
      await nextTurn();
      assert.equal(restored, 1);
      assert.equal(stopped, 0);
      assert.equal(installer.isRecovering(), false);
      installer.dispose();
    } else {
      assert.equal(stopped, 1);
      assert.equal(restored, 0);
      release();
    }
  });
}
