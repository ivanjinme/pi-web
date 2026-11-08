import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LIMITS, verifyApplicationManifest } from "./application-manifest.mjs";
import { createApplicationUpdateService } from "./application-updates.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const digest = "a".repeat(64);
const shell = { schema: 1, version: "1.0.0", digest, toolset: digest };
const hash = (bytes) => createHash("sha512").update(bytes).digest("base64");
const missing = () => Object.assign(new Error("Missing prepared entry"), { code: "ENOENT" });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const signed = (body) => {
  const payload = Buffer.from(JSON.stringify(body));
  return { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") };
};

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "weclio-application-updates-")));
  const requests = [];
  const routes = new Map();
  const server = createServer((request, response) => {
    requests.push(request.url);
    const route = routes.get(request.url);
    if (typeof route === "function") route(request, response);
    else if (route) response.end(route);
    else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const archive = Buffer.from("Small non-executable fixture ZIP stand-in");
  const files = ["package.json", "next.config.js", "desktop-packages.mjs", ".next/BUILD_ID", ".next/required-server-files.json", "node_modules/next/dist/bin/next"];
  const layout = Buffer.from(JSON.stringify({ schema: 1, files: files.map((name) => ({ path: name, size: 1, sha256: digest })) }));
  const body = {
    schema: 1, type: "weclio-application", version: "2.0.0", platform: "win32", arch: "x64",
    shell: { version: shell.version, digest }, toolset: digest,
    archive: { url: `${base}/application.zip`, size: archive.length, sha512: hash(archive) },
    layout: { url: `${base}/layout.json`, size: layout.length, sha512: hash(layout), fileCount: files.length, bytes: files.length },
  };
  const cache = new Map();
  const calls = { read: [], prepare: [], apply: [] };
  let current = { version: "1.0.0", id: null };
  const states = [];
  const logs = [];
  const options = {
    config: { manifestUrl: `${base}/desktop-update-manifest.json`, key: publicKey, devFixture: true },
    shell, selection: { getCurrent: () => current }, storeRoot: path.join(root, "store"),
    toolsRoot: path.join(root, "tools"), toolsetManifest: { schema: 1 },
    apply: async (id) => { calls.apply.push(id); },
    publish: (state) => states.push(state), log: (...args) => logs.push(args),
    async readPrepared(options) {
      calls.read.push(options);
      const record = cache.get(options.id);
      if (!record) throw missing();
      return { ...record };
    },
    async prepare(options) {
      calls.prepare.push(options);
      assert.deepEqual(await readFile(options.archivePath), archive);
      assert.deepEqual(await readFile(options.layoutPath), layout);
      assert.equal(options.key, publicKey);
      assert.equal(options.shell, shell);
      options.onProgress({ phase: "extracting", completedBytes: 0, totalBytes: 6 });
      options.onProgress({ phase: "verifying", completedBytes: 6, totalBytes: 6 });
      const release = verifyApplicationManifest(options.envelope, options.key, true);
      const record = { id: release.id, version: release.version, serverRoot: path.join(root, "prepared") };
      cache.set(record.id, record);
      return record;
    },
    ...overrides,
  };
  const service = createApplicationUpdateService(options);
  t.after(async () => {
    service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const setBody = () => {
    const envelope = signed(body);
    routes.set("/desktop-application-manifest.json", JSON.stringify(envelope));
    return verifyApplicationManifest(envelope, publicKey, true);
  };
  const release = setBody();
  routes.set("/layout.json", layout);
  routes.set("/application.zip", archive);
  return { root, base, body, release, setBody, routes, cache, service, calls, states, logs, requests, options, setCurrent: (value) => { current = value; } };
}

async function emptyDownloads(h) {
  assert.deepEqual(await readdir(path.join(h.options.storeRoot, "downloads")), []);
}

test("signed layout then archive are bounded and verified before preparation, with legacy-ready UI state", async (t) => {
  const h = await fixture(t, { installEnabled: true });
  assert.deepEqual(h.service.getState(), { status: "idle" });
  assert.equal(h.service.canInstall(), false);
  await h.service.check();
  assert.deepEqual(h.requests, ["/desktop-application-manifest.json", "/layout.json", "/application.zip"]);
  assert.deepEqual(h.service.getState(), { status: "downloaded", version: "2.0.0", kind: "application" });
  assert.equal(h.service.canInstall(), true);
  assert.equal(h.calls.prepare.length, 1);
  const prepared = h.calls.prepare[0];
  assert.match(path.basename(path.dirname(prepared.archivePath)), /^\.partial-/);
  assert.equal(path.dirname(path.dirname(prepared.archivePath)), path.join(h.options.storeRoot, "downloads"));
  assert.equal(prepared.toolsRoot, h.options.toolsRoot);
  assert.equal(prepared.toolsetManifest, h.options.toolsetManifest);
  assert.ok(h.states.some((state) => state.status === "preparing" && state.phase === "verifying" && state.progress === 100));
  assert.ok(h.states.every((state) => state.progress === undefined || state.progress >= 0 && state.progress <= 100));
  assert.deepEqual(h.calls.apply, []);
  await emptyDownloads(h);
  await h.service.check();
  assert.equal(h.requests.length, 3);
});

test("cached prepared entries are revalidated and reused without artifact requests", async (t) => {
  const h = await fixture(t);
  h.cache.set(h.release.id, { id: h.release.id, version: h.release.version });
  await h.service.check();
  assert.deepEqual(h.requests, ["/desktop-application-manifest.json"]);
  assert.equal(h.calls.read.length, 1);
  assert.equal(h.calls.prepare.length, 0);
  assert.equal(h.service.getState().status, "downloaded");
  assert.equal(h.service.canInstall(), false);
  await assert.rejects(h.service.verifyForInstall(), /download-only/);
  await assert.rejects(h.service.quitAndInstall(), /not verified/);
  h.service.stop();
  assert.deepEqual(h.calls.apply, []);
});

test("HTTP 404 new feed and unsupported legacy filename stay idle", async (t) => {
  const h = await fixture(t);
  h.routes.delete("/desktop-application-manifest.json");
  await h.service.check();
  assert.deepEqual(h.service.getState(), { status: "idle" });
  assert.equal(h.logs.length, 0);
  const unsupported = createApplicationUpdateService({ ...h.options, config: { ...h.options.config, manifestUrl: `${h.base}/old-feed.json` } });
  await unsupported.check();
  unsupported.start();
  unsupported.stop();
  assert.equal(h.requests.length, 1);
});

for (const reason of ["same version", "older version", "failed id", "shell digest", "toolset"]) {
  test(`${reason} is idle without reading cache or requesting artifacts`, async (t) => {
    const h = await fixture(t);
    if (reason === "same version") h.setCurrent({ version: "2.0.0" });
    if (reason === "older version") h.setCurrent({ version: "3.0.0" });
    if (reason === "failed id") h.setCurrent({ version: "1.0.0", failed: h.release.id });
    if (reason === "shell digest") h.body.shell.digest = "b".repeat(64);
    if (reason === "toolset") h.body.toolset = "b".repeat(64);
    h.setBody();
    await h.service.check();
    assert.deepEqual(h.service.getState(), { status: "idle" });
    assert.equal(h.requests.length, 1);
    assert.equal(h.calls.read.length, 0);
    assert.equal(h.calls.prepare.length, 0);
  });
}

test("a business package built from a newer version still applies to the unchanged shell", async (t) => {
  const h = await fixture(t);
  // 业务发版只提升应用版本；壳内容摘要和工具不变时不得因版本号不同而被拒。
  h.body.shell.version = "0.1.12";
  h.setBody();
  await h.service.check();
  assert.deepEqual(h.service.getState(), { status: "downloaded", version: h.body.version, kind: "application" });
});

test("signature rejection precedes any cache read or artifact request and check can retry", async (t) => {
  const h = await fixture(t);
  const envelope = signed(h.body);
  envelope.signature = Buffer.alloc(64).toString("base64");
  h.routes.set("/desktop-application-manifest.json", JSON.stringify(envelope));
  await h.service.check();
  assert.deepEqual(h.service.getState(), { status: "error" });
  assert.equal(h.calls.read.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.calls.prepare.length, 0);
  assert.ok(h.logs[0][1] instanceof Error);
  h.setBody();
  await h.service.check();
  assert.equal(h.service.getState().status, "downloaded");
});

for (const kind of ["oversize", "undersize", "hash", "layout hash", "invalid layout"]) {
  test(`${kind} artifact fails before prepare, preserves unrelated downloads, and can retry`, async (t) => {
    const h = await fixture(t);
    const originalLayout = h.routes.get("/layout.json");
    const originalArchive = h.routes.get("/application.zip");
    const originalBody = structuredClone(h.body);
    await mkdir(path.join(h.options.storeRoot, "downloads", "other-owner"), { recursive: true });
    await writeFile(path.join(h.options.storeRoot, "downloads", "other-owner", "keep"), "keep");
    if (kind === "oversize") h.routes.set("/application.zip", Buffer.alloc(h.body.archive.size + 1));
    if (kind === "undersize") h.routes.set("/application.zip", Buffer.alloc(h.body.archive.size - 1));
    if (kind === "hash") h.routes.set("/application.zip", Buffer.alloc(h.body.archive.size));
    if (kind === "layout hash") h.routes.set("/layout.json", Buffer.alloc(h.body.layout.size));
    if (kind === "invalid layout") {
      const invalid = Buffer.from('{"schema":1,"files":[]}');
      h.routes.set("/layout.json", invalid);
      h.body.layout.size = invalid.length;
      h.body.layout.sha512 = hash(invalid);
      h.setBody();
    }
    await h.service.check();
    assert.deepEqual(h.service.getState(), { status: "error", version: "2.0.0" });
    assert.equal(h.calls.prepare.length, 0);
    assert.deepEqual(await readdir(path.join(h.options.storeRoot, "downloads")), ["other-owner"]);
    assert.equal(await readFile(path.join(h.options.storeRoot, "downloads", "other-owner", "keep"), "utf8"), "keep");
    if (kind.startsWith("layout") || kind === "invalid layout") assert.ok(!h.requests.includes("/application.zip"));
    assert.ok(!JSON.stringify(h.states).includes(h.root));
    h.routes.set("/layout.json", originalLayout);
    h.routes.set("/application.zip", originalArchive);
    Object.assign(h.body, originalBody);
    h.setBody();
    await h.service.check();
    assert.equal(h.service.getState().status, "downloaded");
    assert.equal(h.calls.prepare.length, 1);
    assert.deepEqual(await readdir(path.join(h.options.storeRoot, "downloads")), ["other-owner"]);
  });
}

test("manifest response bound is enforced before artifacts or prepare", async (t) => {
  const h = await fixture(t);
  h.routes.set("/desktop-application-manifest.json", " ".repeat(2 * LIMITS.manifestBytes + 1));
  await h.service.check();
  assert.equal(h.service.getState().status, "error");
  assert.equal(h.requests.length, 1);
  assert.equal(h.calls.prepare.length, 0);
});

test("manual redirects accept five validated hops and reject a sixth", async (t) => {
  const h = await fixture(t);
  const envelope = h.routes.get("/desktop-application-manifest.json");
  h.routes.set("/desktop-application-manifest.json", (_req, res) => { res.writeHead(302, { location: "/hop1" }); res.end(); });
  for (let index = 1; index < 5; index++) h.routes.set(`/hop${index}`, (_req, res) => { res.writeHead(307, { location: `/hop${index + 1}` }); res.end(); });
  h.routes.set("/hop5", (_req, res) => { res.writeHead(302, { location: "/hop6" }); res.end(); });
  h.routes.set("/hop6", envelope);
  await h.service.check();
  assert.equal(h.service.getState().status, "error");
  assert.ok(!h.requests.includes("/hop6"));
  h.routes.set("/hop5", envelope);
  await h.service.check();
  assert.equal(h.service.getState().status, "downloaded");
});

for (const stage of ["manifest", "layout", "archive"]) {
  test(`${stage} unsafe redirect is rejected before following the destination`, async (t) => {
    const h = await fixture(t);
    const route = { manifest: "/desktop-application-manifest.json", layout: "/layout.json", archive: "/application.zip" }[stage];
    h.routes.set(route, (_req, res) => { res.writeHead(302, { location: "http://localhost:1/private" }); res.end(); });
    await h.service.check();
    assert.equal(h.service.getState().status, "error");
    assert.equal(h.calls.prepare.length, 0);
    assert.ok(h.logs.some((args) => String(args[1]).includes("Unsafe")));
  });
}

test("development HTTP exception is never allowed without explicit devFixture", async (t) => {
  const h = await fixture(t);
  const service = createApplicationUpdateService({ ...h.options, config: { ...h.options.config, devFixture: false } });
  await service.check();
  assert.deepEqual(service.getState(), { status: "idle" });
  assert.deepEqual(h.requests, []);
  service.stop();
});

test("concurrent checks and start share one request; stop aborts manifest without late publication", async (t) => {
  const h = await fixture(t);
  const arrived = deferred();
  h.routes.set("/desktop-application-manifest.json", () => { arrived.resolve(); });
  const pending = h.service.check();
  assert.equal(h.service.check(), pending);
  h.service.start();
  await arrived.promise;
  const published = h.states.length;
  h.service.stop();
  await pending;
  await h.service.check();
  assert.equal(h.requests.length, 1);
  assert.equal(h.states.length, published);
  assert.equal(h.logs.length, 0);
  assert.equal(h.service.canInstall(), false);
});

test("stop aborts streaming artifact and cleans only owned partial data", async (t) => {
  const h = await fixture(t);
  const arrived = deferred();
  h.routes.set("/application.zip", (_req, response) => {
    response.writeHead(200);
    response.write("Small");
    arrived.resolve();
  });
  const pending = h.service.check();
  await arrived.promise;
  const published = h.states.length;
  h.service.stop();
  await pending;
  await emptyDownloads(h);
  assert.equal(h.states.length, published);
  assert.equal(h.calls.prepare.length, 0);
  assert.deepEqual(h.calls.apply, []);
});

test("stop during prepare prevents ready publication even if an injected preparer ignores abort", async (t) => {
  const entered = deferred();
  const finish = deferred();
  let options;
  const h = await fixture(t, { prepare: async (value) => { options = value; entered.resolve(); await finish.promise; return { id: h.release.id, version: h.release.version }; } });
  const pending = h.service.check();
  await entered.promise;
  const published = h.states.length;
  h.service.stop();
  assert.equal(options.signal.aborted, true);
  finish.resolve();
  await pending;
  await emptyDownloads(h);
  assert.equal(h.states.length, published);
  assert.equal(h.service.canInstall(), false);
});

test("prepare errors retain existing versions and allow a new fresh download attempt", async (t) => {
  let attempts = 0;
  const h = await fixture(t, { prepare: async () => {
    attempts++;
    if (attempts === 1) throw new Error(`Private path ${h.root}`);
    return { id: h.release.id, version: h.release.version };
  } });
  const version = path.join(h.options.storeRoot, "versions", "keep");
  await mkdir(version, { recursive: true });
  await writeFile(path.join(version, "keep"), "keep");
  await h.service.check();
  assert.deepEqual(h.service.getState(), { status: "error", version: "2.0.0" });
  assert.ok(!JSON.stringify(h.states).includes(h.root));
  assert.ok(String(h.logs[0][1]).includes(h.root));
  await emptyDownloads(h);
  await h.service.check();
  assert.equal(h.service.getState().status, "downloaded");
  assert.equal(await readFile(path.join(version, "keep"), "utf8"), "keep");
  assert.equal(attempts, 2);
});

test("corrupted existing prepared cache is not silently replaced or downloaded", async (t) => {
  const h = await fixture(t, { readPrepared: async () => { throw new Error("Invalid prepared application: corrupt"); } });
  await h.service.check();
  assert.equal(h.service.getState().status, "error");
  assert.equal(h.requests.length, 1);
  assert.equal(h.calls.prepare.length, 0);
});

for (const target of ["store", "downloads"]) {
  test(`linked ${target} directory is rejected without writing outside the store`, async (t) => {
    const h = await fixture(t);
    const outside = path.join(h.root, "outside");
    await mkdir(outside);
    if (target === "downloads") await mkdir(h.options.storeRoot);
    await symlink(outside, target === "store" ? h.options.storeRoot : path.join(h.options.storeRoot, "downloads"), "junction");
    await h.service.check();
    assert.equal(h.service.getState().status, "error");
    assert.deepEqual(await readdir(outside), []);
    assert.equal(h.requests.length, 1);
    assert.equal(h.calls.prepare.length, 0);
  });
}

test("explicit install requires fresh revalidation, awaits apply and propagates asynchronous errors", async (t) => {
  const finish = deferred();
  const h = await fixture(t, { installEnabled: true, apply: async (id) => { h.calls.apply.push(id); await finish.promise; throw new Error("Apply failed"); } });
  await assert.rejects(h.service.quitAndInstall(), /not verified/);
  await h.service.check();
  await assert.rejects(h.service.quitAndInstall(), /not verified/);
  await h.service.verifyForInstall();
  assert.equal(h.calls.read.length, 2);
  assert.deepEqual(h.calls.apply, []);
  assert.equal(typeof h.service.onInstallError(() => assert.fail()) , "function");
  let settled = false;
  const installing = h.service.quitAndInstall();
  installing.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(h.calls.apply, [h.release.id]);
  finish.resolve();
  await assert.rejects(installing, /Apply failed/);
  await assert.rejects(h.service.quitAndInstall(), /not verified/);
  await h.service.verifyForInstall();
  h.service.stop();
  await assert.rejects(h.service.quitAndInstall(), /not verified/);
});

test("manifest and both artifacts carry bounded abortable request deadlines", async (t) => {
  const deadlines = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds) => { deadlines.push(milliseconds); return timeout(milliseconds); });
  const h = await fixture(t);
  await h.service.check();
  assert.equal(h.service.getState().status, "downloaded");
  assert.deepEqual(deadlines, [30_000, 15 * 60_000, 15 * 60_000]);
});

test("progress bursts are throttled but phase transitions and completion are immediate", async (t) => {
  const h = await fixture(t, { prepare: async (options) => {
    const now = Date.now;
    Date.now = () => 10_000;
    try {
      for (let value = 0; value <= 100; value++) options.onProgress({ phase: "verifying", completedBytes: value, totalBytes: 100 });
      options.onProgress({ phase: "extracting", completedBytes: 0, totalBytes: 100 });
      options.onProgress({ phase: "verifying", completedBytes: 50, totalBytes: 100 });
      options.onProgress({ phase: "verifying", completedBytes: 51, totalBytes: 100 });
      options.onProgress({ phase: "verifying", completedBytes: 100, totalBytes: 100 });
    } finally { Date.now = now; }
    return { id: h.release.id, version: h.release.version };
  } });
  await h.service.check();
  assert.deepEqual(h.states.filter((state) => state.phase === "verifying").map((state) => state.progress), [0, 100, 50, 100]);
  assert.equal(h.service.getState().status, "downloaded");
});

test("check coalesces even a reentrant publication callback", async (t) => {
  const h = await fixture(t, { publish: () => { void h.service.check(); } });
  await h.service.check();
  assert.deepEqual(h.requests, ["/desktop-application-manifest.json", "/layout.json", "/application.zip"]);
});

for (const source of ["cache", "prepare"]) {
  test(`mismatched ${source} identity never becomes ready`, async (t) => {
    const h = await fixture(t, source === "cache"
      ? { readPrepared: async () => ({ id: "b".repeat(64), version: "2.0.0" }) }
      : { prepare: async () => ({ id: "b".repeat(64), version: "2.0.0" }) });
    await h.service.check();
    assert.equal(h.service.getState().status, "error");
    assert.equal(h.service.canInstall(), false);
  });
}

for (const reason of ["missing", "id", "version", "current", "failed"]) {
  test(`install-time ${reason} change revokes ready and prior verification`, async (t) => {
    const h = await fixture(t, { installEnabled: true });
    await h.service.check();
    await h.service.verifyForInstall();
    if (reason === "missing") h.cache.delete(h.release.id);
    if (reason === "id") h.cache.get(h.release.id).id = "b".repeat(64);
    if (reason === "version") h.cache.get(h.release.id).version = "3.0.0";
    if (reason === "current") h.setCurrent({ version: "2.0.0" });
    if (reason === "failed") h.setCurrent({ version: "1.0.0", failed: h.release.id });
    await assert.rejects(h.service.verifyForInstall());
    assert.equal(h.service.getState().status, "error");
    assert.equal(h.service.canInstall(), false);
    await assert.rejects(h.service.quitAndInstall(), /not verified/);
    assert.deepEqual(h.calls.apply, []);
  });
}
