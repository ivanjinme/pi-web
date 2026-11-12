import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { updateKey, updateUrl, verifyManifest } from "./update-signature.mjs";
import { createSignedProvider, createUpdateService, loadUpdateConfig, makeDownloadOnlyUpdater, registerUpdateBridge, UPDATE_CHANNELS } from "./updates.mjs";

const require = createRequire(import.meta.url);
const { Provider } = require("electron-updater/out/providers/Provider.js");
const updaterRequire = createRequire(require.resolve("electron-updater"));
const { DigestTransform } = updaterRequire("builder-util-runtime/out/httpExecutor.js");
const keys = generateKeyPairSync("ed25519");
const pem = keys.publicKey.export({ type: "spki", format: "pem" });
const bytes = Buffer.from("transport test, NOT an installer");
const info = { version: "0.2.0", files: [{ url: "https://example.com/Weclio.exe", sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length }] };
function envelope(value = info) { const payload = Buffer.from(JSON.stringify(value)); return { payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64") }; }

test("manifest binds exact stable version, EXE URL, SHA512 and size before provider returns it", async () => {
  assert.deepEqual(verifyManifest(envelope(), updateKey(pem)), info);
  const abort = new AbortController();
  const Custom = createSignedProvider(Provider, { manifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(envelope()))}`, key: keys.publicKey }, abort.signal);
  const provider = new Custom({}, {}, {});
  const result = await provider.getLatestVersion();
  assert.deepEqual(result, info);
  assert.deepEqual(provider.resolveFiles(result), [{ url: new URL(info.files[0].url), info: info.files[0] }]);
  for (const mutate of [
    (v) => { v.version = "0.3.0"; }, (v) => { v.files[0].url = "https://evil.example/evil.exe"; },
    (v) => { v.files[0].sha512 = Buffer.alloc(64).toString("base64"); }, (v) => { v.files[0].size++; },
  ]) {
    const changed = structuredClone(info); mutate(changed);
    assert.throws(() => verifyManifest({ ...envelope(), payload: Buffer.from(JSON.stringify(changed)).toString("base64") }, keys.publicKey), /signature/);
  }
  assert.throws(() => verifyManifest(envelope(), generateKeyPairSync("ed25519").publicKey), /signature/);
  assert.throws(() => updateKey(generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" })), /Ed25519/);
});

test("signed but unsupported prerelease, webinstaller, bad checksum, size and URL fail closed", () => {
  for (const version of ["1.0.0-beta.1", "1.0.0+build", "01.0.0", "v1.0.0"]) assert.throws(() => verifyManifest(envelope({ ...info, version }), keys.publicKey));
  for (const extra of [{ packages: {} }, { path: "unsigned.exe" }, { files: [] }]) assert.throws(() => verifyManifest(envelope({ ...info, ...extra }), keys.publicKey));
  for (const file of [{ ...info.files[0], sha512: "bad" }, { ...info.files[0], size: 0 }, { ...info.files[0], url: "https://example.com/file.zip" }, { ...info.files[0], url: "https://example.com/Setup.EXE" }]) assert.throws(() => verifyManifest(envelope({ ...info, files: [file] }), keys.publicKey));
  for (const url of ["http://example.com/a.exe", "file:///a.exe", "https://user:pass@example.com/a.exe", "http://localhost/a.exe"]) assert.throws(() => updateUrl(url, true));
  assert.throws(() => updateUrl("http://127.0.0.1/a.exe"));
  assert.equal(updateUrl("http://127.0.0.1/a.exe", true).hostname, "127.0.0.1");
});

test("updater's actual SHA512 stream verifier rejects tampered transport bytes", async () => {
  const consume = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await pipeline(Readable.from([bytes]), new DigestTransform(info.files[0].sha512), consume());
  await assert.rejects(pipeline(Readable.from([Buffer.from("tampered")]), new DigestTransform(info.files[0].sha512), consume()), /checksum mismatch/i);
});

function harness(overrides = {}, fileSize = info.files[0].size) {
  const updater = Object.assign(new EventEmitter(), {
    checks: 0, downloads: 0,
    async checkForUpdates() { this.checks++; return { isUpdateAvailable: true, updateInfo: info }; },
    async downloadUpdate() { this.downloads++; return ["verified.exe"]; }, ...overrides,
  });
  let tick;
  let cleared = 0;
  const states = [];
  const logs = [];
  const retries = new Map();
  let retryId = 0;
  const abort = new AbortController();
  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  const service = createUpdateService({ updater, token, abort, statFile: async () => ({ size: fileSize }), publish: (state) => states.push(state), log: (...args) => logs.push(args), logProgress: (...args) => logs.push(args), setTimer: (fn, ms) => { assert.equal(ms, 4 * 3600 * 1000); tick = fn; return 1; }, clearTimer: () => cleared++, setRetryTimer: (fn, ms) => { const id = ++retryId; retries.set(id, { fn, ms }); return id; }, clearRetryTimer: (id) => retries.delete(id) });
  return { updater, service, states, token, abort, logs, retries, runRetry: () => { const [id, retry] = retries.entries().next().value; retries.delete(id); retry.fn(); }, tick: () => tick(), cleared: () => cleared };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("scheduler runs once on ready, deduplicates downloads and retains downloaded; quit only cancels", async () => {
  let finish;
  const h = harness({ downloadUpdate() { this.downloads++; return new Promise((resolve) => { finish = resolve; }); } });
  h.service.start(); h.service.start(); await flush();
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.updater.autoDownload, false);
  assert.equal(h.updater.allowDowngrade, false);
  assert.equal(h.updater.allowPrerelease, false);
  assert.equal(h.updater.disableWebInstaller, true);
  assert.equal(h.updater.disableDifferentialDownload, false);
  h.tick(); await h.service.check();
  assert.equal(h.updater.checks, 1); assert.equal(h.updater.downloads, 1);
  finish(["verified.exe"]); await flush();
  assert.deepEqual(h.states.map((s) => s.status), ["checking", "downloading", "downloaded"]);
  h.tick(); await flush(); assert.equal(h.updater.checks, 1);
  h.service.stop(); assert.equal(h.cleared(), 1); assert.equal(h.token.cancelled, true); assert.equal(h.abort.signal.aborted, true);
  assert.equal(h.updater.listenerCount("error"), 0);
});

test("installer progress is published only during download and listeners are released on stop", async () => {
  let finish;
  const h = harness({ downloadUpdate() { return new Promise((resolve) => { finish = resolve; }); } });
  h.updater.emit("download-progress", { percent: 10 });
  assert.deepEqual(h.service.getState(), { status: "idle" });
  h.service.start();
  await flush();
  h.updater.emit("download-progress", { percent: 45.6 });
  assert.deepEqual(h.service.getState(), { status: "downloading", version: info.version, progress: 45.6 });
  h.updater.emit("download-progress", { percent: NaN });
  assert.equal(h.service.getState().progress, 45.6);
  h.updater.emit("download-progress", { percent: 110 });
  assert.equal(h.service.getState().progress, 100);
  finish(["verified.exe"]);
  await flush();
  h.updater.emit("download-progress", { percent: 1 });
  assert.deepEqual(h.service.getState(), { status: "downloaded", version: info.version });
  h.service.stop();
  assert.equal(h.updater.listenerCount("download-progress"), 0);
});

test("check/download failures and no-update return hidden idle; next cycle retries", async () => {
  for (const overrides of [
    { async checkForUpdates() { throw new Error("bad signature"); } },
    { async downloadUpdate() { throw new Error("hash mismatch"); } },
    { async checkForUpdates() { return { isUpdateAvailable: false, updateInfo: info }; } },
  ]) {
    const h = harness(overrides); h.service.start(); await flush();
    assert.deepEqual(h.service.getState(), { status: "idle" });
    h.tick(); await flush(); assert.equal(h.service.getState().status, "idle"); h.service.stop();
  }
});

test("transient retries back off, cap, and reset after a successful check", async () => {
  let fail = true;
  const h = harness({ async checkForUpdates() { this.checks++; if (fail) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT", address: "example.com" } }); return { isUpdateAvailable: false }; } });
  h.service.start(); await flush();
  for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    assert.equal(h.retries.size, 1); assert.equal([...h.retries.values()][0].ms, delay);
    h.runRetry(); await flush();
  }
  fail = false; h.runRetry(); await flush(); assert.equal(h.retries.size, 0);
  fail = true; h.tick(); await flush(); assert.equal([...h.retries.values()][0].ms, 60_000);
  h.service.stop(); assert.equal(h.retries.size, 0);
});

test("manual checks cancel pending retries, do not overlap, and do not schedule before start", async () => {
  let finish;
  const error = Object.assign(new Error("network"), { code: "ECONNRESET" });
  const h = harness({ checkForUpdates() { this.checks++; return new Promise((resolve, reject) => { finish = { resolve, reject }; }); } });
  const first = h.service.check(); finish.reject(error); await first; assert.equal(h.retries.size, 0);
  h.service.start(); finish.reject(error); await flush(); assert.equal(h.retries.size, 1);
  const stale = [...h.retries.values()][0].fn;
  const manual = h.service.check(); assert.equal(h.retries.size, 0);
  stale(); h.tick(); await h.service.check(); assert.equal(h.updater.checks, 3);
  finish.resolve({ isUpdateAvailable: false }); await manual; assert.equal(h.retries.size, 0);
  h.service.stop(); stale(); assert.equal(h.updater.checks, 3);
});

test("download network failures retry; security and unknown errors do not", async () => {
  for (const error of [new Error("bad signature"), new Error("hash mismatch"), new Error("Unsafe URL"), new Error("unknown"), new Error("Manifest HTTP 404")]) {
    const h = harness({ async checkForUpdates() { throw error; } }); h.service.start(); await flush(); assert.equal(h.retries.size, 0); h.service.stop();
  }
  for (const error of [Object.assign(new Error("download failed"), { code: "ETIMEDOUT" }), new Error("Manifest HTTP 503"), new Error("Manifest HTTP 429")]) {
    const h = harness({ async downloadUpdate() { throw error; } }); h.service.start(); await flush(); assert.equal(h.retries.size, 1); h.service.stop();
  }
});

test("network diagnostics never log signed URL or credentials", async () => {
  const error = new TypeError("fetch failed https://user:secret@example.com/path?token=secret", { cause: { code: "UND_ERR_CONNECT_TIMEOUT", address: "example.com" } });
  const h = harness({ async checkForUpdates() { this.emit("error", error); throw error; } });
  h.service.start(); await flush();
  assert.deepEqual(JSON.parse(h.logs[0][1]), { name: "TypeError", causeCode: "UND_ERR_CONNECT_TIMEOUT", address: "example.com", kind: "transient" });
  assert.doesNotMatch(JSON.stringify(h.logs), /secret|\/path|token/);
  h.service.stop();
});

test("real updater HTTP and Chromium failures retry without leaking URLs; security errors fail closed", async () => {
  const url = "https://user:secret@example.com/file.exe?token=secret";
  for (const error of [new Error(`Cannot download "${url}", status 503: Service Unavailable`), new Error(`Cannot download "${url}", status 429: Too Many Requests`), new Error("net::ERR_NAME_NOT_RESOLVED"), new Error("net::ERR_CONNECTION_RESET"), new Error("Request timed out"), Object.assign(new Error(`HTTP error ${url}`), { statusCode: 503 }), Object.assign(new Error("timed out"), { name: "TimeoutError" })]) {
    const h = harness({ async downloadUpdate() { this.emit("error", error); throw error; } });
    assert.equal(typeof h.updater.logger.error, "function");
    h.service.start(); await flush(); assert.equal(h.retries.size, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /secret|file\.exe|token/);
    assert.equal(JSON.parse(h.logs[0][1]).kind, "transient"); h.service.stop();
  }
  for (const error of [new Error("net::ERR_CERT_AUTHORITY_INVALID"), new Error("net::ERR_SSL_PROTOCOL_ERROR"), new Error(`Cannot download "${url}", status 403: Forbidden`), Object.assign(new Error("checksum mismatch"), { code: "ECONNRESET" }), Object.assign(new Error("certificate error"), { statusCode: 503 })]) {
    const h = harness({ async checkForUpdates() { throw error; } }); h.service.start(); await flush();
    assert.equal(h.retries.size, 0); assert.doesNotMatch(JSON.stringify(h.logs), /secret|file\.exe|token/); h.service.stop();
  }
});

test("Node DNS and socket causes and the actual timeout DOMException retry", async () => {
  for (const error of [new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }), new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }), new DOMException("The operation was aborted due to timeout", "TimeoutError")]) {
    const h = harness({ async checkForUpdates() { throw error; } }); h.service.start(); await flush();
    assert.equal(h.retries.size, 1); assert.equal(JSON.parse(h.logs[0][1]).kind, "transient"); h.service.stop();
  }
});

test("fixed diagnostics distinguish malformed metadata and missing files without logging messages", async () => {
  for (const [error, kind] of [[new SyntaxError("Unexpected secret JSON"), "malformed JSON"], [new Error("Manifest too large"), "manifest too large"], [new Error("Invalid stable update manifest"), "invalid update metadata"], [new Error("Invalid EXE metadata"), "invalid update metadata"], [new Error("No verified update downloaded"), "missing downloaded files"]]) {
    const h = harness({ async checkForUpdates() { throw error; } }); h.service.start(); await flush();
    assert.equal(JSON.parse(h.logs[0][1]).kind, kind); assert.doesNotMatch(JSON.stringify(h.logs), /secret|Invalid EXE metadata/); assert.equal(h.retries.size, 0); h.service.stop();
  }
});

test("upstream differential logs expose only fixed progress and fallback classifications", async () => {
  const secret = "https://user:secret@example.com/a?token=secret";
  for (const fallback of [false, true]) {
    const h = harness({ async downloadUpdate() {
      this.logger.info(`Differential download: ${secret}`);
      this.logger.warn(`Other message ${secret}`);
      if (fallback) this.logger.error(`Cannot download differentially, fallback to full download: ${secret}`);
      return ["verified.exe"];
    } });
    h.service.start(); await flush();
    assert.deepEqual(h.logs.map((args) => JSON.parse(args[1]).kind), ["differential download started", fallback ? "differential download fallback" : "differential download completed"]);
    assert.doesNotMatch(JSON.stringify(h.logs), /secret|token|example/); h.service.stop();
  }
});

test("differential fallback reports only allowlisted reasons from upstream stacks through caller log", async () => {
  const secret = "https://user:secret@example.com/blockmap?token=secret";
  const cases = [
    [`Error: Cannot download "${secret}", status 404: Not Found\n    at download (${secret})`, { reason: "http", status: 404 }],
    [`Error: net::ERR_CONNECTION_RESET at ${secret}`, { reason: "network", code: "ERR_CONNECTION_RESET" }],
    [`Error: checksum mismatch at ${secret}`, { reason: "checksum" }],
    [`Error: ENOENT: no such file, open '${secret}'`, { reason: "missing cache" }],
    [`Error: Cannot download "${secret}", status 404: checksum mismatch`, { reason: "unknown" }],
    [`Error: unrecognized ${secret}`, { reason: "unknown" }],
  ];
  for (const [reason, expected] of cases) {
    const logs = [];
    const updater = Object.assign(new EventEmitter(), { async checkForUpdates() { return { isUpdateAvailable: false }; } });
    const service = createUpdateService({ updater, token: { cancel() {} }, log: (...args) => logs.push(args) });
    updater.logger.error(`Cannot download differentially, fallback to full download: ${reason}`);
    assert.deepEqual(JSON.parse(logs[0][1]), { kind: "differential download fallback", ...expected });
    assert.doesNotMatch(JSON.stringify(logs), /secret|token|example|blockmap/); service.stop();
  }
});

test("an aborted service does not retry a timeout", async () => {
  let reject;
  const h = harness({ checkForUpdates() { return new Promise((_resolve, fail) => { reject = fail; }); } });
  h.service.start(); h.abort.abort(); reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })); await flush();
  assert.equal(h.retries.size, 0); h.service.stop();
});

test("a signed size mismatch never becomes ready to restart", async () => {
  const h = harness({}, 1);
  h.service.start(); await flush();
  assert.equal(h.service.getState().status, "idle");
  assert.equal(JSON.parse(h.logs[0][1]).kind, "size mismatch");
  assert.ok(!h.states.some((state) => state.status === "downloaded"));
  h.service.stop();
});

test("manifest redirects support release attachments but forbid unsafe targets and loops", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/manifest") { response.end(JSON.stringify(envelope())); return; }
    response.writeHead(302, { location: request.url === "/unsafe" ? "http://example.com/manifest" : request.url === "/loop" ? "/loop" : "/manifest" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const abort = new AbortController();
  function provider(path) {
    const Custom = createSignedProvider(Provider, { manifestUrl: `${base}${path}`, key: keys.publicKey, devFixture: true }, abort.signal);
    return new Custom({}, {}, {});
  }
  assert.deepEqual(await provider("/redirect").getLatestVersion(), info);
  await assert.rejects(provider("/unsafe").getLatestVersion(), /Unsafe/);
  await assert.rejects(provider("/loop").getLatestVersion(), /redirect/);
});

test("late check completion after quit cannot download or publish", async () => {
  let finish;
  const h = harness({ checkForUpdates: () => new Promise((resolve) => { finish = resolve; }) });
  h.service.start(); h.service.stop(); finish({ isUpdateAvailable: true, updateInfo: info }); await flush();
  assert.equal(h.updater.downloads, 0); assert.equal(h.states.length, 1);
});

test("stage1 subclass blocks every installer entry and normal quit hook even under config manipulation", async () => {
  class Unsafe { install() { throw new Error("install"); } doInstall() { throw new Error("spawn"); } quitAndInstall() { throw new Error("quit"); } addQuitHandler() { throw new Error("quit hook"); } }
  const Safe = makeDownloadOnlyUpdater(Unsafe); const updater = new Safe();
  updater.autoInstallOnAppQuit = true;
  updater.quitAndInstall(); updater.addQuitHandler();
  assert.equal(updater.install(), false); assert.equal(updater.doInstall(), false);
  assert.equal(await updater.verifySignature(), null);
});

test("config absent is inert, absolute dev opt-in only, packaged ignores env and loopback switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-update-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await loadUpdateConfig({ packaged: false, env: {} }), null);
  assert.equal(await loadUpdateConfig({ packaged: true, resourcesPath: root, env: { WECLIO_UPDATE_CONFIG: "evil" } }), null);
  await assert.rejects(loadUpdateConfig({ packaged: false, env: { WECLIO_UPDATE_CONFIG: "relative.json" } }), /absolute/);
  const path = join(root, "desktop-update.json");
  await writeFile(path, JSON.stringify({ manifestUrl: "http://127.0.0.1/feed", publicKey: pem, devFixture: true }));
  assert.equal((await loadUpdateConfig({ packaged: false, env: { WECLIO_UPDATE_CONFIG: path } })).devFixture, true);
  await assert.rejects(loadUpdateConfig({ packaged: true, resourcesPath: root }), /Unsafe/);
});

test("packaged configuration is passed directly to the signed installer provider", async (t) => {
  const resourcesPath = new URL("../resources/", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  const config = await loadUpdateConfig({ packaged: true, resourcesPath: fileURLToPath(resourcesPath) });
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    return new Response(null, { status: 404 });
  });
  const Custom = createSignedProvider(Provider, config, new AbortController().signal);
  await assert.rejects(new Custom({}, {}, {}).getLatestVersion(), /Manifest HTTP 404/);
  assert.deepEqual(requested, ["https://github.com/ivanjinme/pi-web/releases/latest/download/desktop-update-manifest.json"]);
});

test("configured updater cache is a single safe directory name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-update-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "desktop-update.json");
  for (const updaterCacheDirName of ["../escape", "..", ".", "C:\\escape", "folder/name", "a\u0000b", 1]) {
    await writeFile(path, JSON.stringify({ manifestUrl: "https://example.com/feed.json", publicKey: pem, updaterCacheDirName }));
    await assert.rejects(loadUpdateConfig({ packaged: true, resourcesPath: root }), /cache directory/);
  }
  await writeFile(path, JSON.stringify({ manifestUrl: "https://example.com/feed.json", publicKey: pem, updaterCacheDirName: "@wecliopi-web-updater" }));
  assert.equal((await loadUpdateConfig({ packaged: true, resourcesPath: root })).updaterCacheDirName, "@wecliopi-web-updater");
});

test("IPC restricts owning window, app origin and main frame; restart is explanation only", async () => {
  const handlers = new Map(); const prompts = [];
  const frame = { url: "http://127.0.0.1:8888/" };
  const contents = { mainFrame: frame }; const window = { webContents: contents, isDestroyed: () => false };
  const remove = registerUpdateBridge({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) }, getWindow: () => window, isAppUrl: (url) => new URL(url).origin === "http://127.0.0.1:8888", getService: () => null, dialog: { async showMessageBox(...args) { prompts.push(args); } } });
  const event = { sender: contents, senderFrame: frame };
  assert.deepEqual(handlers.get(UPDATE_CHANNELS.get)(event), { status: "idle" });
  for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: { url: frame.url } }, { ...event, senderFrame: null }]) assert.throws(() => handlers.get(UPDATE_CHANNELS.get)(bad), /Untrusted/);
  frame.url = "https://evil.example/"; assert.throws(() => handlers.get(UPDATE_CHANNELS.get)(event), /Untrusted/); frame.url = "http://127.0.0.1:8888/";
  await handlers.get(UPDATE_CHANNELS.restart)(event, "zh-CN");
  assert.match(prompts[0][1].message, /不会安装或重启/);
  assert.deepEqual(prompts[0][1].buttons, ["知道了"]);
  // 未注入服务或缺窗口时也不能向任意页面暴露新的更新操作。
  assert.equal(await handlers.get(UPDATE_CHANNELS.check)(event), undefined);
  assert.equal(handlers.has("desktop-update:ready"), false);
  assert.throws(() => handlers.get(UPDATE_CHANNELS.check)({ ...event, sender: {} }), /Untrusted/);
  for (const locale of ["en", "unsupported", undefined]) {
    await handlers.get(UPDATE_CHANNELS.restart)(event, locale);
    const prompt = prompts.at(-1)[1];
    assert.match(prompt.message, /will not install or restart/);
    assert.deepEqual(prompt.buttons, ["Got it"]);
  }
  remove(); assert.equal(handlers.size, 0);
});

test("sandbox preload exposes only named methods and listener unsubscribe", async () => {
  let api; const listeners = new Map(); const invoked = [];
  const ipcRenderer = { invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve({ status: "idle" }); }, on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); } };
  runInNewContext(await readFile(new URL("./preload.cjs", import.meta.url), "utf8"), { require: (name) => { assert.equal(name, "electron"); return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "weclioDesktop"); api = value; } } }; } });
  assert.deepEqual(Object.keys(api), ["getUpdateState", "onUpdateState", "restartUpdate", "checkForUpdates"]);
  assert.equal(typeof api.checkForUpdates, "function");
  await api.getUpdateState(); await api.restartUpdate("zh-CN"); await api.checkForUpdates();
  assert.deepEqual(invoked, [[UPDATE_CHANNELS.get], [UPDATE_CHANNELS.restart, "zh-CN"], [UPDATE_CHANNELS.check]]);
  let received; const unsubscribe = api.onUpdateState((state) => { received = state; });
  listeners.get(UPDATE_CHANNELS.state)({ secret: true }, { status: "downloaded" }); assert.deepEqual(received, { status: "downloaded" }); unsubscribe(); assert.equal(listeners.size, 0);
});
