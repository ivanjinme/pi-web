import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSignedProvider, createUpdateService, makeDownloadOnlyUpdater } from "./updates.mjs";

const require = createRequire(import.meta.url);
const { NsisUpdater } = require("electron-updater");
const { Provider } = require("electron-updater/out/providers/Provider.js");
const updaterRequire = createRequire(require.resolve("electron-updater"));
const { CancellationToken, HttpExecutor, configureRequestUrl, configureRequestOptions, CURRENT_APP_INSTALLER_FILE_NAME } = updaterRequire("builder-util-runtime");
const DownloadOnlyUpdater = makeDownloadOnlyUpdater(NsisUpdater);
const keys = generateKeyPairSync("ed25519");
const bytes = Buffer.from("Weclio integration fixture: clearly NOT AN INSTALLER.\n");
const sha512 = createHash("sha512").update(bytes).digest("base64");

// Keep the updater's own transport, cancellation and digest pipeline. Only replace
// Electron's net.request adapter with node:http; no downloader or stat mocks.
class LocalHttpExecutor extends HttpExecutor {
  createRequest(options, callback) { return request(options, callback); }
  download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, {
        destination, options, onCancel, responseHandler: null,
        callback: (error) => error ? reject(error) : resolve(destination),
      }, 0);
    });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { version = "0.2.0", hash = sha512, size = bytes.length, invalidSignature = false, delayed = false, differential = false, installable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "weclio-updater-integration-"));
  const sessions = [];
  const forbidden = [];
  const requests = [];
  const artifactRequests = [];
  const artifactPath = differential ? `/Weclio-${version}-test.exe` : "/Weclio-test.exe";
  const oldBytes = Buffer.from(bytes);
  oldBytes.fill(0x78, 8, 16);
  oldBytes.fill(0x79, 24, 32);
  const blockmap = (content) => {
    const blocks = [content.subarray(0, 8), content.subarray(8, 16), content.subarray(16, 24), content.subarray(24, 32), content.subarray(32)];
    return gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0,
      checksums: blocks.map((block) => createHash("sha256").update(block).digest("base64")),
      sizes: blocks.map((block) => block.length),
    }] }));
  };
  const transportStarted = deferred();
  let manifest;
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/manifest") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
    } else if (differential && req.url === `/Weclio-0.1.10-test.exe.blockmap`) {
      res.end(blockmap(oldBytes));
    } else if (differential && req.url === `${artifactPath}.blockmap`) {
      res.end(blockmap(bytes));
    } else if (req.url === artifactPath) {
      artifactRequests.push({ range: req.headers.range });
      if (differential && req.headers.range) {
        // 模拟只支持单段 Range 的对象存储，拒绝 multipart 请求。
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
        if (!range) { res.writeHead(416); res.end(); return; }
        const start = Number(range[1]);
        const end = Number(range[2]);
        res.writeHead(206, { "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": end - start + 1 });
        res.end(bytes.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      if (delayed) {
        // Deliberately never finish: cancellation, not a timing race, releases it.
        res.write(bytes.subarray(0, 1), () => transportStarted.resolve());
      } else res.end(bytes);
    } else {
      // Exercise the real NSIS full-download fallback without real blockmaps.
      res.writeHead(404);
      res.end();
    }
  });
  t.after(async () => {
    for (const session of sessions) session.service.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(forbidden, [], "no quit/install hook may be invoked");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const info = { version, ...(installable ? { installable: true } : {}), files: [{ url: `${base}${artifactPath}`, sha512: hash, size }] };
  const payload = Buffer.from(JSON.stringify(info));
  manifest = { payload: payload.toString("base64"), signature: sign(null, payload, keys.privateKey).toString("base64") };
  if (invalidSignature) manifest.signature = Buffer.alloc(64).toString("base64");
  const trap = (name) => () => {
    forbidden.push(name);
    throw new Error(`Forbidden quit/install hook: ${name}`);
  };
  function session({ installEnabled = false } = {}) {
    const abort = new AbortController();
    const token = new CancellationToken();
    const updater = new DownloadOnlyUpdater(null, {
      version: "0.1.10", name: "Weclio-test", isPackaged: true,
      whenReady: async () => {}, userDataPath: root, baseCachePath: root,
      onQuit: trap("app.onQuit"), quit: trap("app.quit"),
    });
    updater.logger = null;
    for (const name of ["quitAndInstall", "install", "doInstall", "spawnLog", "spawnSyncLog"]) updater[name] = trap(name);
    updater.httpExecutor = new LocalHttpExecutor();
    updater.setFeedURL({
      provider: "custom",
      updateProvider: createSignedProvider(Provider, { manifestUrl: `${base}/manifest`, key: keys.publicKey, devFixture: true }, abort.signal),
    });
    const states = [];
    const errors = [];
    const downloaded = [];
    updater.on("update-downloaded", (event) => downloaded.push(event.downloadedFile));
    const service = createUpdateService({ updater, token, abort, installEnabled, publish: (state) => states.push(state), log: (...args) => errors.push(args.join(" ")) });
    const value = { service, updater, token, abort, states, errors, downloaded };
    sessions.push(value);
    return value;
  }
  return { session, requests, artifactRequests, oldBytes, transportStarted, exeRequests: () => artifactRequests.length };
}

function assertIdle(session) {
  assert.deepEqual(session.service.getState(), { status: "idle" });
  assert.ok(!session.states.some((state) => state.status === "downloaded"));
}

async function assertDownloaded(session) {
  await session.service.check();
  assert.deepEqual(session.service.getState(), { status: "downloaded", version: "0.2.0" });
  const transitions = session.states.map((state) => state.status).filter((status, index, states) => index === 0 || status !== states[index - 1]);
  assert.deepEqual(transitions, ["checking", "downloading", "downloaded"]);
  for (const state of session.states.filter((state) => state.progress !== undefined)) {
    assert.equal(state.status, "downloading");
    assert.ok(Number.isFinite(state.progress) && state.progress >= 0 && state.progress <= 100);
  }
  assert.deepEqual(session.errors, []);
  assert.equal(session.downloaded.length, 1);
  const path = session.downloaded[0];
  assert.equal((await stat(path)).size, bytes.length);
  assert.deepEqual(await readFile(path), bytes);
  return path;
}

test("real NSIS pipeline downloads signed fixture bytes, without installing", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const s = f.session();
  try {
    await assertDownloaded(s);
    assert.equal(f.exeRequests(), 1);
    await s.service.check();
    assert.equal(f.exeRequests(), 1, "downloaded service must not download again");
  } finally { s.service.stop(); }
});

test("real NSIS differential pipeline downloads only two separate ranges and reuses unchanged bytes", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { differential: true });
  const s = f.session();
  const helper = await s.updater.getOrCreateDownloadHelper();
  await mkdir(helper.cacheDir, { recursive: true });
  await writeFile(join(helper.cacheDir, CURRENT_APP_INSTALLER_FILE_NAME), f.oldBytes);
  await assertDownloaded(s);
  assert.deepEqual(f.artifactRequests, [{ range: "bytes=8-15" }, { range: "bytes=24-31" }]);
  assert.ok(f.requests.includes("/Weclio-0.1.10-test.exe.blockmap"));
  assert.ok(f.requests.includes("/Weclio-0.2.0-test.exe.blockmap"));
});

for (const corruption of ["same-size", "truncated", "missing"]) {
  test(`same updater re-downloads and verifies after ${corruption} cache corruption`, { timeout: 15_000 }, async (t) => {
    // 仅使用临时签名和纯文本；真实安装入口仍全部拦截。
    const f = await fixture(t, { installable: true });
    const s = f.session({ installEnabled: true });
    const path = await assertDownloaded(s);
    await s.service.verifyForInstall();
    if (corruption === "missing") await rm(path);
    else await writeFile(path, corruption === "same-size" ? Buffer.alloc(bytes.length, 0x78) : bytes.subarray(0, 5));
    await assert.rejects(s.service.verifyForInstall(), corruption === "missing" ? /ENOENT/ : /changed after downloading/);
    assert.equal(s.service.getState().status, "idle");
    assert.equal(s.service.canInstall(), false);
    assert.throws(() => s.service.quitAndInstall(), /not verified/);
    assert.equal(s.updater.downloadedUpdateHelper.file, null);
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(stat(s.updater.downloadedUpdateHelper.getUpdateInfoFile()), { code: "ENOENT" });

    await s.service.check();
    assert.equal(f.exeRequests(), 2, "the same updater must fetch fresh bytes instead of reusing corrupt cache");
    assert.deepEqual(s.service.getState(), { status: "downloaded", version: "0.2.0" });
    assert.deepEqual(await readFile(s.downloaded.at(-1)), bytes);
    await s.service.verifyForInstall();
    assert.equal(s.service.canInstall(), true);
    assert.equal(s.updater.autoInstallOnAppQuit, false);
  });
}

test("real NSIS digest pipeline rejects a wrong signed hash", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { hash: Buffer.alloc(64).toString("base64") });
  const s = f.session();
  try {
    await s.service.check();
    assertIdle(s);
    assert.equal(f.exeRequests(), 1);
    assert.deepEqual(s.downloaded, []);
    assert.match(s.errors.join("\n"), /checksum mismatch/i);
  } finally { s.service.stop(); }
});

test("real file stat rejects a wrong signed size before service publishes downloaded", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { size: bytes.length + 1 });
  const s = f.session();
  try {
    await s.service.check();
    assertIdle(s);
    assert.equal(f.exeRequests(), 1);
    assert.match(s.errors.join("\n"), /size mismatch/i);
    // The underlying updater verified the hash; the service must still reject size.
    assert.equal(s.downloaded.length, 1);
    assert.deepEqual(await readFile(s.downloaded[0]), bytes);
  } finally { s.service.stop(); }
});

test("invalid Ed25519 signature never requests an EXE or blockmap", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { invalidSignature: true });
  const s = f.session();
  try {
    await s.service.check();
    assertIdle(s);
    assert.deepEqual(f.requests, ["/manifest"]);
    assert.deepEqual(s.downloaded, []);
    assert.match(s.errors.join("\n"), /signature/i);
  } finally { s.service.stop(); }
});

for (const version of ["0.1.10", "0.1.9"]) {
  test(`signed ${version} does not download over installed 0.1.10`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, { version });
    const s = f.session();
    try {
      await s.service.check();
      assertIdle(s);
      assert.deepEqual(s.states.map((state) => state.status), ["checking", "idle"]);
      assert.deepEqual(f.requests, ["/manifest"]);
      assert.deepEqual(s.downloaded, []);
      assert.deepEqual(s.errors, []);
    } finally { s.service.stop(); }
  });
}

test("fresh updater instances reuse verified cache but re-download same-size tampering", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const first = f.session();
  let path;
  try { path = await assertDownloaded(first); } finally { first.service.stop(); }
  assert.equal(f.exeRequests(), 1);
  const second = f.session();
  try {
    assert.equal(await assertDownloaded(second), path);
    assert.equal(f.exeRequests(), 1, "fresh instance must reuse valid disk cache");
  } finally { second.service.stop(); }
  await writeFile(path, Buffer.alloc(bytes.length, 0x78));
  const third = f.session();
  try {
    assert.equal(await assertDownloaded(third), path);
    assert.equal(f.exeRequests(), 2, "same-size tampering must fail cached SHA512 and use verified transport again");
  } finally { third.service.stop(); }
  assert.equal(f.requests.filter((url) => url === "/manifest").length, 3);
});

test("stop cancels an in-flight real HTTP download without publishing downloaded", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { delayed: true });
  const s = f.session();
  const checking = s.service.check();
  try {
    await f.transportStarted.promise;
    assert.equal(s.service.getState().status, "downloading");
    const beforeStop = structuredClone(s.states);
    s.service.stop();
    await checking;
    assert.equal(s.token.cancelled, true);
    assert.equal(s.abort.signal.aborted, true);
    assert.deepEqual(s.states, beforeStop, "no late publication after shutdown");
    assert.ok(!s.states.some((state) => state.status === "downloaded"));
    assert.deepEqual(s.downloaded, []);
    assert.equal(f.exeRequests(), 1);
  } finally {
    s.service.stop();
    await checking;
  }
});
