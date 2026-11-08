import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { updateKey, updateUrl, verifyManifest } from "./update-signature.mjs";
import { createApplicationUpdateService } from "./application-updates.mjs";
import { createUpdateCoordinator } from "./update-coordinator.mjs";

export const UPDATE_CHANNELS = Object.freeze({ get: "desktop-update:get", state: "desktop-update:state", restart: "desktop-update:restart", check: "desktop-update:check", ready: "desktop-update:ready" });
const PERIOD = 4 * 60 * 60 * 1000;

export async function loadUpdateConfig({ packaged, resourcesPath, env = process.env }) {
  const path = packaged ? join(resourcesPath, "desktop-update.json") : env.WECLIO_UPDATE_CONFIG;
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("WECLIO_UPDATE_CONFIG must be absolute");
  let config;
  try { config = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && packaged) return null; throw error; }
  const devFixture = !packaged && config.devFixture === true;
  const cache = config.updaterCacheDirName;
  if (cache !== undefined && (typeof cache !== "string" || !cache || cache === "." || cache === ".." || /[\\/:<>"|?*]/.test(cache) || Array.from(cache).some((char) => char.charCodeAt(0) < 32))) throw new Error("Invalid updater cache directory name");
  return { manifestUrl: updateUrl(config.manifestUrl, devFixture), key: updateKey(config.publicKey), devFixture, updaterCacheDirName: cache };
}

export function createSignedProvider(Provider, config, signal) {
  return class SignedProvider extends Provider {
    // 与上游 GitHub provider 一致，使用对象存储兼容的单段 Range 请求。
    constructor(_options, _updater, runtime) { super({ ...runtime, isUseMultipleRangeRequest: false }); }
    async getLatestVersion() {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let url = config.manifestUrl;
      let response;
      // GitHub Release 附件会跳转到对象存储；每一跳都遵守相同的传输边界。
      for (let redirects = 0; ; redirects++) {
        response = await fetch(url, { redirect: "manual", signal: requestSignal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects >= 5) throw new Error("Invalid manifest redirect");
        url = updateUrl(new URL(location, url).href, config.devFixture);
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Manifest HTTP ${response.status}`); }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Error("Manifest too large");
        chunks.push(chunk);
      }
      return verifyManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")), config.key, config.devFixture);
    }
    resolveFiles(info) { return info.files.map((file) => ({ url: new URL(file.url), info: file })); }
  };
}

function makeManagedUpdater(NsisUpdater, installEnabled, updaterCacheDirName = "weclio-desktop-updater") {
  return class ManagedUpdater extends NsisUpdater {
    // 普通退出永不安装；开发与测试仍拦截全部安装入口。
    addQuitHandler() {}
    quitAndInstall(...args) { if (installEnabled) return super.quitAndInstall(...args); }
    install(...args) { return installEnabled ? super.install(...args) : false; }
    doInstall(...args) { return installEnabled ? super.doInstall(...args) : false; }
    // 不依赖付费 Authenticode；来源由 Ed25519 清单绑定，文件哈希由 updater 校验。
    async verifySignature() { return null; }
    async loadUpdateConfig() { return { updaterCacheDirName }; }
  };
}

export function makeDownloadOnlyUpdater(NsisUpdater, updaterCacheDirName) {
  return makeManagedUpdater(NsisUpdater, false, updaterCacheDirName);
}

export function createUpdateService({ updater, token, abort = new AbortController(), publish = () => {}, log = console.error, setTimer = setInterval, clearTimer = clearInterval, statFile = stat, installEnabled = false }) {
  let state = { status: "idle" };
  let timer;
  let stopped = false;
  let busy = false;
  let downloadedUpdate;
  let verifiedForInstall = false;
  const change = (next) => { if (!stopped) { state = next; publish({ ...state }); } };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = false;
  const onError = (error) => log("[desktop-update]", error.message);
  updater.on("error", onError);
  async function check() {
    if (stopped || busy || state.status === "downloaded") return;
    busy = true;
    change({ status: "checking" });
    try {
      const result = await updater.checkForUpdates();
      if (stopped) return;
      if (!result?.isUpdateAvailable) { change({ status: "idle" }); return; }
      change({ status: "downloading", version: result.updateInfo.version });
      const files = await updater.downloadUpdate(token);
      if (!files?.length) throw new Error("No verified update downloaded");
      const downloaded = await statFile(files[0]);
      if (downloaded.size !== result.updateInfo.files[0].size) throw new Error("Downloaded update size mismatch");
      downloadedUpdate = { ...result.updateInfo.files[0], path: files[0], installable: result.updateInfo.installable === true };
      change({ status: "downloaded", version: result.updateInfo.version });
    } catch (error) {
      if (!stopped) { onError(error); change({ status: "idle" }); }
    } finally { busy = false; }
  }
  return {
    getState: () => ({ ...state }),
    canInstall: () => installEnabled && !stopped && state.status === "downloaded" && downloadedUpdate?.installable === true,
    async verifyForInstall() {
      if (!installEnabled || stopped || state.status !== "downloaded" || !downloadedUpdate?.installable) throw new Error("Update is download-only");
      verifiedForInstall = false;
      try {
        const hash = createHash("sha512");
        let size = 0;
        for await (const chunk of createReadStream(downloadedUpdate.path)) { size += chunk.length; hash.update(chunk); }
        if (size !== downloadedUpdate.size || hash.digest("base64") !== downloadedUpdate.sha512) throw new Error("Update file changed after downloading");
        verifiedForInstall = true;
      } catch (error) {
        downloadedUpdate = undefined;
        // 上游在同一进程内只检查缓存文件是否存在；清空后才能真正重新下载。
        try { await updater.downloadedUpdateHelper?.clear(); }
        catch (cleanupError) { onError(cleanupError); }
        change({ status: "idle" });
        throw error;
      }
    },
    onInstallError(listener) {
      const failed = (error) => {
        // 上游异步启动失败不会重置此标记；恢复窗口后必须允许用户重试。
        updater.quitAndInstallCalled = false;
        listener(error);
      };
      updater.on("error", failed);
      return () => updater.off("error", failed);
    },
    quitAndInstall() {
      if (!installEnabled || stopped || !verifiedForInstall || state.status !== "downloaded" || !downloadedUpdate?.installable) throw new Error("Update is not verified for installation");
      updater.quitAndInstall(true, true);
    },
    start() { if (!stopped && !timer) { timer = setTimer(() => void check(), PERIOD); timer?.unref?.(); void check(); } },
    check,
    stop() { stopped = true; if (timer) clearTimer(timer); abort.abort(); token.cancel(); updater.removeListener("error", onError); },
  };
}

export async function initializeUpdates({ app, publish, log = console.error, applicationRuntime, applyApplication }) {
  const config = await loadUpdateConfig({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  if (!config || process.platform !== "win32") return null;
  // 复用 server 的生产依赖，不向小型 ASAR 再复制一棵 node_modules。
  const require = app.isPackaged ? createRequire(join(process.resourcesPath, "server/package.json")) : createRequire(import.meta.url);
  const { NsisUpdater } = require("electron-updater");
  const { Provider } = require("electron-updater/out/providers/Provider.js");
  const { CancellationToken } = createRequire(require.resolve("electron-updater"))("builder-util-runtime");
  const abort = new AbortController();
  const installEnabled = app.isPackaged && !config.devFixture;
  const Updater = makeManagedUpdater(NsisUpdater, installEnabled, config.updaterCacheDirName);
  const updater = new Updater({ provider: "custom", updateProvider: createSignedProvider(Provider, config, abort.signal) });
  updater.forceDevUpdateConfig = !app.isPackaged;
  const useApplication = installEnabled && applicationRuntime && typeof applyApplication === "function";
  if (!useApplication) return createUpdateService({ updater, token: new CancellationToken(), abort, publish, log, installEnabled });
  // 不把业务包版本写进 updater：壳 EXE 的升级判断始终基于已安装壳，否则壳维护会被永久抑制。
  let coordinator;
  const legacy = createUpdateService({ updater, token: new CancellationToken(), abort, publish: (state) => coordinator?.receive("legacy", state), log, installEnabled });
  const application = createApplicationUpdateService({
    config, shell: applicationRuntime.shell, selection: applicationRuntime.selection,
    storeRoot: applicationRuntime.storeRoot, toolsRoot: applicationRuntime.toolsRoot,
    toolsetManifest: applicationRuntime.toolsetManifest, apply: applyApplication,
    publish: (state) => coordinator?.receive("application", state), log, installEnabled,
  });
  coordinator = createUpdateCoordinator({ legacy, application, publish });
  return coordinator;
}

export function registerUpdateBridge({ ipcMain, getWindow, isAppUrl, getService, dialog, installer, onApplicationReady }) {
  function authorize(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        !event.senderFrame || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error("Untrusted desktop update sender");
    return window;
  }
  ipcMain.handle(UPDATE_CHANNELS.get, (event) => { authorize(event); return getService()?.getState() ?? { status: "idle" }; });
  ipcMain.handle(UPDATE_CHANNELS.check, (event) => { authorize(event); return getService()?.check(); });
  ipcMain.handle(UPDATE_CHANNELS.ready, (event) => { authorize(event); return onApplicationReady?.(); });
  ipcMain.handle(UPDATE_CHANNELS.restart, async (event, locale) => {
    const window = authorize(event);
    if (installer) return installer.restart(locale);
    const text = locale === "zh-CN" ? {
      title: "Weclio 更新验证",
      message: "当前仅验证更新下载，不会安装或重启。",
      detail: "第一阶段仅支持下载验证，安装功能尚未启用。",
      buttons: ["知道了"],
    } : {
      title: "Weclio update preview",
      message: "This preview only verifies downloads. It will not install or restart the app.",
      detail: "Stage 1 validates downloads only. Installation is not enabled yet.",
      buttons: ["Got it"],
    };
    await dialog.showMessageBox(window, { type: "info", ...text });
  });
  return () => {
    for (const channel of [UPDATE_CHANNELS.get, UPDATE_CHANNELS.restart, UPDATE_CHANNELS.check, UPDATE_CHANNELS.ready]) ipcMain.removeHandler(channel);
  };
}
