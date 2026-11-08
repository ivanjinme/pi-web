import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplicationRuntime } from "./application-runtime.mjs";

const { publicKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const A = "a".repeat(64);
const B = "b".repeat(64);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pointer = (id, pending = true, attempted = false) => ({ schema: 1, active: id, previous: null, pending, attempted, failed: null });

async function fixture(t, directory = os.tmpdir()) {
  const base = await mkdtemp(path.join(directory, ".application-runtime-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const resourcesPath = path.join(base, "installation", "resources");
  const localAppData = path.join(base, "local-data");
  const profilePath = path.join(base, "profile");
  await mkdir(resourcesPath, { recursive: true });
  const files = ["git/bin/bash.exe", "git/cmd/git.exe", "tools/fd.exe", "tools/rg.exe"].map((name) => ({ path: name, size: 1, sha256: A }));
  const toolsetManifest = { schema: 1, files, id: hash(JSON.stringify({ schema: 1, files })) };
  const shell = { schema: 1, version: "1.2.3", digest: A, toolset: toolsetManifest.id };
  const config = { manifestUrl: "https://updates.example/releases/desktop-update-manifest.json", publicKey: pem };
  const put = (name, value) => writeFile(path.join(resourcesPath, name), typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  await put("desktop-shell.json", shell);
  await put("desktop-update.json", config);
  await put("desktop-toolset.json", toolsetManifest);
  const options = { resourcesPath, localAppData, profilePath, toolsRoot: path.join(base, "toolsets"), shellVersion: shell.version };
  return { base, shell, toolsetManifest, config, put, ...options, create: (extra = {}) => createApplicationRuntime({ ...options, ...extra }) };
}

test("legacy installation without descriptor returns null before requiring new metadata or arguments", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.resourcesPath, "desktop-shell.json"));
  await f.put("desktop-update.json", "not JSON");
  assert.equal(await f.create({ profilePath: "relative", localAppData: "relative", shellVersion: "bad" }), null);
  assert.equal(await createApplicationRuntime({ resourcesPath: `.missing-runtime-${randomUUID()}` }), null);
  assert.equal(await createApplicationRuntime({ resourcesPath: path.join(f.base, "missing-install") }), null);
  assert.deepEqual((await readdir(f.base)).sort(), ["installation"]);
});

test("descriptor requires exact schema, stable matching version and lower-case SHA-256 identifiers", async (t) => {
  const f = await fixture(t);
  for (const value of [
    null, [], {}, { ...f.shell, extra: true }, { ...f.shell, schema: 2 },
    { ...f.shell, schema: "1" }, { ...f.shell, version: "01.2.3" },
    { ...f.shell, version: "1.2.3-beta" }, { ...f.shell, version: "1.2.4" },
    { ...f.shell, digest: "A".repeat(64) }, { ...f.shell, digest: A.slice(1) },
    { ...f.shell, toolset: "bad" }, { ...f.shell, toolset: null },
  ]) {
    await f.put("desktop-shell.json", value);
    await assert.rejects(f.create(), /shell descriptor|shellVersion/);
  }
  await f.put("desktop-shell.json", f.shell);
  for (const shellVersion of [undefined, "1.2.4", "bad"]) await assert.rejects(f.create({ shellVersion }), /shellVersion/);
});

test("present descriptor requires absolute resources/profile and a safe data base", async (t) => {
  const f = await fixture(t, process.cwd());
  const relative = path.relative(process.cwd(), f.resourcesPath);
  assert.equal(path.isAbsolute(relative), false);
  await assert.rejects(f.create({ resourcesPath: relative }), /absolute resourcesPath/);
  for (const profilePath of [undefined, null, "", "relative"]) await assert.rejects(f.create({ profilePath }), /absolute.*profilePath/);
  for (const toolsRoot of [undefined, null, "", "relative"]) await assert.rejects(f.create({ toolsRoot }), /toolsRoot/);
  await assert.rejects(f.create({ localAppData: "relative" }), /absolute localAppData/);
});

test("descriptor JSON is bounded, regular-file only and strict UTF-8", async (t) => {
  const f = await fixture(t);
  for (const content of ["{", Buffer.from([0xff]), " ".repeat(65537)]) {
    await f.put("desktop-shell.json", content);
    await assert.rejects(f.create());
  }
  const descriptor = path.join(f.resourcesPath, "desktop-shell.json");
  await rm(descriptor);
  await mkdir(descriptor);
  await assert.rejects(f.create(), /metadata file/);
});

test("installed public config requires HTTPS and a valid Ed25519 public key", async (t) => {
  const f = await fixture(t);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  for (const config of [
    null, [], {}, { ...f.config, manifestUrl: "file:///updates.json" },
    { ...f.config, manifestUrl: "http://127.0.0.1/feed.json", devFixture: true },
    { ...f.config, manifestUrl: "https://user:password@example.com/feed.json" },
    { ...f.config, manifestUrl: `${f.config.manifestUrl}#fragment` },
    { ...f.config, publicKey: "invalid" }, { ...f.config, publicKey: rsa },
  ]) {
    await f.put("desktop-update.json", config);
    await assert.rejects(f.create());
  }
  for (const content of ["{", " ".repeat(65537)]) {
    await f.put("desktop-update.json", content);
    await assert.rejects(f.create());
  }
  await rm(path.join(f.resourcesPath, "desktop-update.json"));
  await assert.rejects(f.create(), { code: "ENOENT" });
});

test("factory ignores development feed environment and strips config to public normalized runtime fields", async (t) => {
  const f = await fixture(t);
  const names = ["WECLIO_UPDATE_CONFIG"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const development = path.join(f.base, "development.json");
  await writeFile(development, JSON.stringify({ manifestUrl: "http://127.0.0.1/dev-feed.json", publicKey: "invalid", devFixture: true }));
  process.env.WECLIO_UPDATE_CONFIG = development;
  await f.put("desktop-update.json", { ...f.config, devFixture: true, updaterCacheDirName: "extra-public-setting" });
  const runtime = await f.create();
  assert.deepEqual(Object.keys(runtime.config).sort(), ["devFixture", "key", "manifestUrl"]);
  assert.equal(runtime.config.manifestUrl instanceof URL, true);
  assert.equal(runtime.config.manifestUrl.href, f.config.manifestUrl);
  assert.equal(runtime.config.devFixture, false);
  assert.equal(runtime.config.key.type, "public");
  assert.equal(runtime.config.key.asymmetricKeyType, "ed25519");
  assert.equal(runtime.config.key.export({ type: "spki", format: "pem" }).toString(), pem);
});

test("toolset metadata requires matching descriptor id, schema, file metadata and consistent canonical identity", async (t) => {
  const f = await fixture(t);
  for (const value of [
    null, [], {}, { ...f.toolsetManifest, schema: 2 }, { ...f.toolsetManifest, id: B },
    { ...f.toolsetManifest, id: "bad" }, { ...f.toolsetManifest, files: null },
    { ...f.toolsetManifest, files: [] }, { ...f.toolsetManifest, files: [null] },
    { ...f.toolsetManifest, files: [{ path: "tools/rg.exe", size: -1, sha256: A }] },
    { ...f.toolsetManifest, files: [{ path: "tools/rg.exe", size: 1, sha256: "bad" }] },
    { ...f.toolsetManifest, files: [{ path: "", size: 1, sha256: A }] },
    { ...f.toolsetManifest, files: f.toolsetManifest.files.map((file) => ({ ...file, size: 2 })) },
  ]) {
    await f.put("desktop-toolset.json", value);
    await assert.rejects(f.create(), /toolset/);
  }
  for (const content of ["{", Buffer.from([0xff]), " ".repeat(16 * 1024 * 1024 + 1)]) {
    await f.put("desktop-toolset.json", content);
    await assert.rejects(f.create());
  }
  await rm(path.join(f.resourcesPath, "desktop-toolset.json"));
  await assert.rejects(f.create(), { code: "ENOENT" });
});

test("normal factory returns metadata and an unstarted selection without provisioning servers or tools", async (t) => {
  const f = await fixture(t);
  const runtime = await f.create();
  assert.deepEqual(Object.keys(runtime).sort(), ["config", "selection", "shell", "storeRoot", "toolsRoot", "toolsetManifest"]);
  assert.deepEqual(runtime.shell, f.shell);
  assert.deepEqual(runtime.toolsetManifest, f.toolsetManifest);
  assert.equal(runtime.storeRoot, path.join(f.localAppData, "Weclio", "applications"));
  assert.equal(runtime.toolsRoot, f.toolsRoot);
  assert.equal(runtime.selection.getCurrent(), undefined);
  for (const method of ["begin", "commit", "healthy", "rollback", "getCurrent"]) assert.equal(typeof runtime.selection[method], "function");
  assert.deepEqual(await readdir(f.base), ["installation"]);
  assert.deepEqual((await readdir(f.resourcesPath)).sort(), ["desktop-shell.json", "desktop-toolset.json", "desktop-update.json"]);
  const bundled = await runtime.selection.begin();
  assert.deepEqual(bundled, { id: null, version: f.shell.version, serverRoot: path.join(f.resourcesPath, "server") });
  assert.deepEqual(await readdir(path.join(f.profilePath, "application-selection")), []);
});

test("profile-specific selections share validated cache artifacts without sharing selection pointers", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const readPrepared = async (options) => {
    calls.push(options);
    return { id: options.id, version: options.id === A ? "2.0.0" : "3.0.0", serverRoot: path.join(options.storeRoot, "versions", options.id, "server"), envelope: {} };
  };
  const first = await f.create({ readPrepared });
  const otherProfile = path.join(f.base, "custom-profile");
  const second = await f.create({ profilePath: otherProfile, readPrepared });
  assert.equal(first.storeRoot, second.storeRoot);
  const artifacts = path.join(first.storeRoot, "versions");
  for (const id of [A, B]) {
    await mkdir(path.join(artifacts, id, "server"), { recursive: true });
    await writeFile(path.join(artifacts, id, "server", "sentinel"), id);
  }
  await Promise.all([first.selection.commit(A), second.selection.commit(B)]);
  const profilePointer = (profile) => readFile(path.join(profile, "application-selection", "current.json"), "utf8").then(JSON.parse);
  assert.deepEqual(await profilePointer(f.profilePath), pointer(A));
  assert.deepEqual(await profilePointer(otherProfile), pointer(B));
  await first.selection.begin();
  await first.selection.healthy();
  assert.deepEqual(await profilePointer(f.profilePath), pointer(A, false));
  assert.deepEqual(await profilePointer(otherProfile), pointer(B));
  await second.selection.rollback();
  assert.equal((await profilePointer(otherProfile)).failed, B);
  assert.deepEqual(await profilePointer(f.profilePath), pointer(A, false));
  assert.ok(calls.every((options) => options.storeRoot === first.storeRoot && options.devFixture === false));
  for (const options of calls) {
    assert.deepEqual(options.shell, f.shell);
    assert.equal(options.key.asymmetricKeyType, "ed25519");
  }
  assert.deepEqual(await readdir(first.storeRoot), ["versions"]);
  for (const id of [A, B]) assert.equal(await readFile(path.join(artifacts, id, "server", "sentinel"), "utf8"), id);
  for (const profile of [f.profilePath, otherProfile]) assert.deepEqual(await readdir(path.join(profile, "application-selection")), ["current.json"]);
});
