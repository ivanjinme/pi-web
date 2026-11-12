import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { updateKey, updateUrl, verifyManifest } from "./update-signature.mjs";

export const UPDATE_CHANNELS = Object.freeze({ get: "desktop-update:get", state: "desktop-update:state", restart: "desktop-update:restart", check: "desktop-update:check" });
const PERIOD = 4 * 60 * 60 * 1000;
const NETWORK_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"]);

const CHROMIUM_CODES = new Set(["ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_REFUSED", "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK_CHANGED", "ERR_ADDRESS_UNREACHABLE"]);

function errorDetails(error) {
  const message = typeof error?.message === "string" ? error.message.slice(0, 8192) : "";
  const safeMessage = message.replace(/https?:\/\/[^\s"']+/gi, "[url]");
  const securityPattern = /signature|checksum|sha\d*|hash|integrity|unsafe|certificate|cert_|ssl/i;
  const security = error?.name === "AbortError" || /ABORT/i.test(String(error?.code ?? "")) || securityPattern.test(safeMessage) || securityPattern.test(String(error?.code ?? "")) || securityPattern.test(String(error?.cause?.code ?? "")) || securityPattern.test(String(error?.cause?.message ?? "").replace(/https?:\/\/[^\s"']+/gi, "[url]"));
  const chromium = /^net::(ERR_[A-Z_]+)$/.exec(safeMessage)?.[1];
  const http = /^Manifest HTTP (\d{3})$/.exec(safeMessage)?.[1] ?? /^Cannot download "\[url\]", status (\d{3})(?::|$)/.exec(safeMessage)?.[1];
  const status = Number(error?.statusCode ?? http);
  const transient = !security && (error?.name === "TimeoutError" || safeMessage === "Request timed out" || NETWORK_CODES.has(error?.code) || (error?.name === "TypeError" && NETWORK_CODES.has(error?.cause?.code)) || CHROMIUM_CODES.has(chromium) || status === 429 || (status >= 500 && status <= 599));
  const safeCode = (value) => typeof value === "string" && /^(?:UND_ERR_[A-Z_]+|E[A-Z_]+|ERR_[A-Z_]+|HTTP_ERROR_\d{3})$/.test(value) && value.length <= 64 ? value : undefined;
  const address = error?.cause?.address ?? error?.address;
  return {
    transient,
    diagnostic: {
      name: ["Error", "TypeError", "SyntaxError", "TimeoutError", "AbortError", "HttpError"].includes(error?.name) ? error.name : "Error",
      code: safeCode(error?.code), causeCode: safeCode(error?.cause?.code), chromiumCode: CHROMIUM_CODES.has(chromium) ? chromium : undefined,
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
      address: typeof address === "string" && address.length <= 253 && /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(address) ? address : undefined,
      kind: /checksum mismatch/i.test(safeMessage) ? "checksum mismatch" : /signature/i.test(safeMessage) ? "signature error" : /size mismatch/i.test(safeMessage) ? "size mismatch" : error?.name === "SyntaxError" ? "malformed JSON" : safeMessage === "Manifest too large" ? "manifest too large" : ["Invalid stable update manifest", "Invalid EXE metadata", "Invalid base64", "Invalid base64 length"].includes(safeMessage) ? "invalid update metadata" : safeMessage === "No verified update downloaded" ? "missing downloaded files" : security ? "security-or-abort" : transient ? "transient" : "other",
    },
  };
}

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

export function createSignedProvider(Provider, config, signal) {  return class SignedProvider extends Provider {
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

export function createUpdateService({ updater, token, abort = new AbortController(), publish = () => {}, log = console.error, logProgress = log, setTimer = setInterval, clearTimer = clearInterval, setRetryTimer = setTimeout, clearRetryTimer = clearTimeout, statFile = stat, installEnabled = false }) {
  let state = { status: "idle" };
  let timer;
  let retryTimer;
  let retryAttempt = 0;
  let started = false;
  let stopped = false;
  let busy = false;
  let downloadedUpdate;
  let verifiedForInstall = false;
  const change = (next) => { if (!stopped) { state = next; publish({ ...state }); } };
  let differentialStarted = false;
  let differentialFallback = false;
  // 上游日志可能包含完整下载地址；只输出固定分类，不转发原文。
  const upstreamLog = (message) => {
    if (typeof message !== "string") return;
    if (message.startsWith("Differential download: ")) {
      differentialStarted = true;
      logProgress("[desktop-update]", JSON.stringify({ kind: "differential download started" }));
    } else if (message.startsWith("Cannot download differentially, fallback to full download:")) {
      differentialFallback = true;
      const safeMessage = message.slice(0, 8192).replace(/https?:\/\/[^\s"']+/gi, "[url]");
      const statuses = [...safeMessage.matchAll(/Cannot download "\[url\]", status (\d{3})(?::|\b)/g)].map((match) => Number(match[1])).filter((status) => status >= 400 && status <= 599);
      const codes = [...safeMessage.matchAll(/\b(?:net::)?(ERR_[A-Z_]+|UND_ERR_[A-Z_]+|E[A-Z_]+)\b/g)].map((match) => match[1]);
      const network = [...new Set(codes.filter((code) => NETWORK_CODES.has(code) || CHROMIUM_CODES.has(code)))];
      const checksum = /\b(?:checksum mismatch|sha512 checksum mismatch)\b/i.test(safeMessage);
      const missing = codes.includes("ENOENT");
      const reasons = [statuses.length > 0, network.length > 0, checksum, missing].filter(Boolean).length;
      const diagnostic = { kind: "differential download fallback", reason: "unknown" };
      if (reasons === 1 && !/certificate|ERR_CERT_|ERR_SSL_|signature|integrity|unsafe/i.test(safeMessage)) {
        if (statuses.length > 0 && new Set(statuses).size === 1) { diagnostic.reason = "http"; diagnostic.status = statuses[0]; }
        else if (network.length === 1) { diagnostic.reason = "network"; diagnostic.code = network[0]; }
        else if (checksum) diagnostic.reason = "checksum";
        else if (missing) diagnostic.reason = "missing cache";
      }
      logProgress("[desktop-update]", JSON.stringify(diagnostic));
    }
  };
  updater.logger = { info: upstreamLog, warn: upstreamLog, error: upstreamLog, debug: upstreamLog };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = false;
  const onError = (error, kind) => log("[desktop-update]", JSON.stringify({ ...errorDetails(error).diagnostic, ...(kind === "cache cleanup failure" ? { kind } : {}) }));
  const clearRetry = () => { if (retryTimer !== undefined) { clearRetryTimer(retryTimer); retryTimer = undefined; } };
  const scheduleRetry = () => {
    if (!started || stopped || abort.signal.aborted || retryTimer !== undefined) return;
    const delay = Math.min(60_000 * 2 ** Math.min(retryAttempt++, 4), 15 * 60_000);
    const handle = setRetryTimer(() => {
      if (retryTimer !== handle) return;
      retryTimer = undefined;
      void check();
    }, delay);
    retryTimer = handle;
    handle?.unref?.();
  };
  updater.on("error", onError);
  const onProgress = ({ percent }) => {
    if (state.status === "downloading" && Number.isFinite(percent)) {
      change({ ...state, progress: Math.min(100, Math.max(0, percent)) });
    }
  };
  updater.on("download-progress", onProgress);
  async function check() {
    if (stopped || abort.signal.aborted || busy || state.status === "downloaded") return;
    clearRetry();
    differentialStarted = false;
    differentialFallback = false;
    busy = true;
    change({ status: "checking" });
    try {
      const result = await updater.checkForUpdates();
      if (stopped) return;
      if (!result?.isUpdateAvailable) { retryAttempt = 0; change({ status: "idle" }); return; }
      change({ status: "downloading", version: result.updateInfo.version });
      const files = await updater.downloadUpdate(token);
      if (differentialStarted && !differentialFallback) logProgress("[desktop-update]", JSON.stringify({ kind: "differential download completed" }));
      if (!files?.length) throw new Error("No verified update downloaded");
      const downloaded = await statFile(files[0]);
      if (downloaded.size !== result.updateInfo.files[0].size) throw new Error("Downloaded update size mismatch");
      downloadedUpdate = { ...result.updateInfo.files[0], path: files[0], installable: result.updateInfo.installable === true };
      retryAttempt = 0;
      change({ status: "downloaded", version: result.updateInfo.version });
    } catch (error) {
      if (!stopped && !abort.signal.aborted) { onError(error); change({ status: "idle" }); if (errorDetails(error).transient) scheduleRetry(); else retryAttempt = 0; }
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
        catch (cleanupError) { onError(cleanupError, "cache cleanup failure"); }
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
    start() { if (!stopped && !started) { started = true; timer = setTimer(() => void check(), PERIOD); timer?.unref?.(); void check(); } },
    check,
    stop() { stopped = true; if (timer) clearTimer(timer); clearRetry(); abort.abort(); token.cancel(); updater.removeListener("error", onError); updater.removeListener("download-progress", onProgress); },
  };
}

export async function initializeUpdates({ app, publish, log = console.error }) {
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
  return createUpdateService({ updater, token: new CancellationToken(), abort, publish, log, installEnabled });
}

export function registerUpdateBridge({ ipcMain, getWindow, isAppUrl, getService, dialog, installer }) {
  function authorize(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        !event.senderFrame || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error("Untrusted desktop update sender");
    return window;
  }
  ipcMain.handle(UPDATE_CHANNELS.get, (event) => { authorize(event); return getService()?.getState() ?? { status: "idle" }; });
  ipcMain.handle(UPDATE_CHANNELS.check, (event) => { authorize(event); return getService()?.check(); });
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
    for (const channel of [UPDATE_CHANNELS.get, UPDATE_CHANNELS.restart, UPDATE_CHANNELS.check]) ipcMain.removeHandler(channel);
  };
}
