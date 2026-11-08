import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createUpdateInstaller } from "./update-install.mjs";
import { createUpdateService } from "./updates.mjs";

const require = createRequire(import.meta.url);
const { BaseUpdater } = require("electron-updater/out/BaseUpdater.js");

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fakeWindow() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  let destroyed = false;
  window.isDestroyed = () => destroyed;
  window.close = () => { destroyed = true; window.emit("closed"); };
  return window;
}

test("upstream install retries after async launch error, vetoes failed scheduled quit, then completes a second handoff", async (t) => {
  let beforeQuitEvents = 0;
  const electronMock = new URL("./.update-retry-electron-mock.cjs", import.meta.url).href;
  const hooks = registerHooks({
    resolve(name, context, next) {
      return name === "electron" ? { url: electronMock, shortCircuit: true } : next(name, context);
    },
    load(url, context, next) {
      return url === electronMock ? {
        format: "commonjs",
        source: "module.exports = { autoUpdater: new (require('node:events').EventEmitter)() };",
        shortCircuit: true,
      } : next(url, context);
    },
  });
  t.after(() => hooks.deregister());
  const electron = require("electron");
  electron.autoUpdater.on("before-quit-for-update", () => { beforeQuitEvents += 1; });

  const directory = await mkdtemp(join(tmpdir(), "weclio-update-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "never-executed.txt");
  const content = Buffer.from("Plain text test download. This file is never executed.\n");
  await writeFile(path, content);
  const updateInfo = {
    version: "99.0.0", installable: true,
    files: [{ url: "https://updates.invalid/never-executed.txt", size: content.length, sha512: createHash("sha512").update(content).digest("base64") }],
  };
  let window = fakeWindow();
  const firstWindow = window;
  let restored = 0;
  let quitRequests = 0;
  let acceptedQuits = 0;
  let vetoedQuits = 0;
  let checks = 0;
  let downloads = 0;
  let lockCalls = 0;
  let unlockCalls = 0;
  let locked = false;
  const releaseUnlock = deferred();
  const errorShown = deferred();
  const installCalls = [];
  const token = { cancel() {} };
  let installer;
  let service;
  const app = {
    isPackaged: true,
    quit() {
      quitRequests += 1;
      assert.equal(window.isDestroyed(), true, "upstream quit must follow actual window closure");
      if (installer.isRecovering()) {
        vetoedQuits += 1;
        return;
      }
      acceptedQuits += 1;
      service.stop();
      installer.dispose();
    },
  };
  const updater = new EventEmitter();
  Object.assign(updater, {
    app,
    _logger: { info() {}, warn() {} },
    quitAndInstallCalled: false,
    downloadedUpdateHelper: { file: path, downloadedFileInfo: { isAdminRightsRequired: false } },
    async checkForUpdates() { checks += 1; return { isUpdateAvailable: true, updateInfo }; },
    async downloadUpdate(receivedToken) { assert.equal(receivedToken, token); downloads += 1; return [path]; },
    install: BaseUpdater.prototype.install,
    quitAndInstall: BaseUpdater.prototype.quitAndInstall,
    dispatchError(error) { updater.emit("error", error); },
    doInstall(options) {
      assert.equal(window.isDestroyed(), true);
      installCalls.push(options);
      if (installCalls.length === 1) {
        process.nextTick(() => updater.emit("error", new Error("Simulated async launch failure")));
      }
      return true;
    },
  });
  Object.defineProperty(updater, "installerPath", { get: () => updater.downloadedUpdateHelper.file });
  service = createUpdateService({ updater, token, installEnabled: true, log() {} });
  t.after(() => service.stop());
  const gate = {
    async inspect() { return locked ? "busy" : "ready"; },
    async lock() { assert.equal(locked, false); locked = true; lockCalls += 1; return "ready"; },
    async unlock() {
      unlockCalls += 1;
      await releaseUnlock.promise;
      locked = false;
    },
  };
  installer = createUpdateInstaller({
    app, getService: () => service, getWindow: () => window, getGate: () => gate,
    dialog: { async showMessageBox(...args) {
      const options = args.at(-1);
      if (options.type === "error") errorShown.resolve();
      assert.notEqual(options.type, "question", "restart click must not require another confirmation");
      return { response: 0 };
    } },
    async restoreWindow() { restored += 1; window = fakeWindow(); },
    log() {},
  });
  t.after(() => installer.dispose());

  await service.check();
  assert.equal(service.canInstall(), true);
  assert.throws(() => service.quitAndInstall(), /not verified/);
  assert.equal(installCalls.length, 0);
  await installer.restart("en");
  await nextTurn();
  assert.equal(installCalls.length, 1, "exercise real BaseUpdater.install on first click");
  assert.equal(updater.quitAndInstallCalled, false, "service error wrapper resets upstream's retry latch");
  assert.equal(installer.isRecovering(), true);
  assert.equal(unlockCalls, 1);
  assert.equal(locked, true, "keep recovery pending until the unlock acknowledgement");
  assert.equal(quitRequests, 1, "exercise real BaseUpdater.quitAndInstall scheduled quit");
  assert.equal(vetoedQuits, 1);
  assert.equal(acceptedQuits, 0);
  assert.equal(restored, 0);
  assert.equal(service.canInstall(), true, "failed scheduled quit must not stop the service");

  releaseUnlock.resolve();
  await errorShown.promise;
  await nextTurn();
  assert.equal(restored, 1);
  assert.notEqual(window, firstWindow);
  assert.equal(window.isDestroyed(), false);
  assert.equal(locked, false);
  assert.equal(installer.isRecovering(), false);
  assert.equal(installer.isClosing(), false);

  await installer.restart("en");
  await nextTurn();
  assert.equal(installCalls.length, 2, "second click must reach doInstall, not silently ignore a latched install");
  assert.deepEqual(installCalls, [
    { isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false },
    { isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false },
  ]);
  assert.equal(quitRequests, 2);
  assert.equal(beforeQuitEvents, 2);
  assert.equal(vetoedQuits, 1);
  assert.equal(acceptedQuits, 1, "successful retry must really finish the upstream quit");
  assert.equal(updater.quitAndInstallCalled, true);
  assert.equal(lockCalls, 2);
  assert.equal(unlockCalls, 1, "successful handoff keeps its gate held until server exit");
  assert.equal(locked, true);
  assert.equal(service.canInstall(), false, "accepted quit stops the service");
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(checks, 1);
  assert.equal(downloads, 1);
});
