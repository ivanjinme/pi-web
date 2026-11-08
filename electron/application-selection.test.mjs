import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplicationSelection, resolveApplicationStore } from "./application-selection.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const shell = { schema: 1, version: "1.0.0", digest: A, toolset: B };
const pointer = (active = null, previous = null, pending = false, attempted = false, failed = null) => ({ schema: 1, active, previous, pending, attempted, failed });

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "application-selection-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const storeRoot = path.join(base, "applications");
  const bundledRoot = path.join(base, "installation", "resources", "server");
  await mkdir(storeRoot, { recursive: true });
  await mkdir(bundledRoot, { recursive: true });
  await writeFile(path.join(bundledRoot, "sentinel"), "bundled");
  const entries = new Map();
  for (const [id, version] of [[A, "2.0.0"], [B, "3.0.0"], [C, "1.0.0"]]) {
    const serverRoot = path.join(storeRoot, id, "server");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(path.join(serverRoot, "sentinel"), id);
    entries.set(id, { id, version, serverRoot, envelope: {}, shell });
  }
  const calls = [];
  const readPrepared = async (options) => {
    calls.push(options);
    const entry = entries.get(options.id);
    if (!entry) throw Object.assign(new Error("Prepared application missing"), { code: "ENOENT" });
    if (entry.error) throw entry.error;
    if (entry.shell.digest !== options.shell.digest) throw Object.assign(new Error("Application shell incompatible"), { code: "ERR_APPLICATION_INCOMPATIBLE" });
    return entry;
  };
  const options = { storeRoot, bundledRoot, bundledVersion: "1.0.0", key: "test-key", shell, readPrepared };
  return {
    ...options, base, entries, calls,
    create: (extra = {}) => createApplicationSelection({ ...options, ...extra }),
    save: (value) => writeFile(path.join(storeRoot, "current.json"), typeof value === "string" ? value : JSON.stringify(value)),
    saved: async () => JSON.parse(await readFile(path.join(storeRoot, "current.json"), "utf8")),
  };
}

async function stable(f, id = A) {
  await f.create().commit(id);
  const launched = f.create();
  await launched.begin();
  await launched.healthy();
  return launched;
}

test("missing pointer uses bundled; preparing/cancelling and ordinary exit never commit", async (t) => {
  const f = await fixture(t);
  const selection = f.create();
  assert.equal(selection.getCurrent(), undefined);
  assert.deepEqual(await selection.begin(), { id: null, version: "1.0.0", serverRoot: f.bundledRoot });
  await f.readPrepared({ ...f, id: A });
  await selection.healthy();
  assert.equal((await f.create().begin()).id, null);
  await assert.rejects(f.saved(), { code: "ENOENT" });
});

test("profile-local pointers isolate selections while retaining shared prepared artifacts", async (t) => {
  const f = await fixture(t);
  const firstRoot = path.join(f.base, "profile-one", "application-selection");
  const secondRoot = path.join(f.base, "profile-two", "application-selection");
  const first = () => f.create({ selectionRoot: firstRoot });
  const second = () => f.create({ selectionRoot: secondRoot });
  const saved = async (root) => JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));
  await f.save(pointer(C));
  const artifactsBefore = (await readdir(f.storeRoot)).sort();
  assert.equal((await first().begin()).id, null);
  assert.equal((await second().begin()).id, null);
  await Promise.all([first().commit(A), second().commit(B)]);
  assert.deepEqual(await saved(firstRoot), pointer(A, null, true, false));
  assert.deepEqual(await saved(secondRoot), pointer(B, null, true, false));
  const firstStarted = first();
  await firstStarted.begin();
  await firstStarted.healthy();
  await second().begin();
  assert.equal((await second().begin()).id, null);
  assert.deepEqual(await saved(secondRoot), pointer(null, null, false, false, B));
  assert.deepEqual(await saved(firstRoot), pointer(A));
  assert.equal((await first().begin()).serverRoot, f.entries.get(A).serverRoot);
  await firstStarted.rollback();
  assert.deepEqual(await saved(firstRoot), pointer(null, null, false, false, A));
  assert.deepEqual(await saved(secondRoot), pointer(null, null, false, false, B));
  assert.deepEqual(await f.saved(), pointer(C));
  assert.ok(f.calls.every((call) => call.storeRoot === f.storeRoot));
  assert.deepEqual((await readdir(f.storeRoot)).sort(), artifactsBefore);
  for (const id of [A, B, C]) assert.equal(await readFile(path.join(f.entries.get(id).serverRoot, "sentinel"), "utf8"), id);
  for (const root of [firstRoot, secondRoot]) assert.deepEqual(await readdir(root), ["current.json"]);
});

test("constructor rejects non-absolute selection, artifact and bundled roots", async (t) => {
  const f = await fixture(t);
  for (const field of ["storeRoot", "selectionRoot", "bundledRoot"]) {
    for (const value of [null, "", "relative"]) assert.throws(() => f.create({ [field]: value }), /absolute/);
  }
});

test("profile selectionRoot junction cannot redirect pointer writes into the shared store", async (t) => {
  const f = await fixture(t);
  const selectionRoot = path.join(f.base, "profile-link");
  await symlink(f.storeRoot, selectionRoot, "junction");
  await assert.rejects(f.create({ selectionRoot }).commit(A), /selectionRoot.*canonical/);
  await assert.rejects(f.saved(), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("commit is pointer-only; first startup marks attempted before returning and healthy acknowledges", async (t) => {
  const f = await fixture(t);
  const selection = f.create();
  assert.equal(selection.needsHealthAcknowledgement(), false);
  assert.equal((await selection.commit(A)).id, A);
  assert.equal(selection.needsHealthAcknowledgement(), false);
  assert.deepEqual(await f.saved(), pointer(A, null, true, false));
  await selection.healthy();
  assert.deepEqual(await f.saved(), pointer(A, null, true, false));
  const startup = f.create();
  assert.equal((await startup.begin()).serverRoot, f.entries.get(A).serverRoot);
  assert.equal(startup.needsHealthAcknowledgement(), true);
  assert.deepEqual(await f.saved(), pointer(A, null, true, true));
  await startup.begin();
  assert.deepEqual(await f.saved(), pointer(A, null, true, true));
  await startup.healthy();
  assert.equal(startup.needsHealthAcknowledgement(), false);
  assert.deepEqual(await f.saved(), pointer(A));
  const stableStartup = f.create();
  assert.equal((await stableStartup.begin()).id, A);
  assert.equal(stableStartup.needsHealthAcknowledgement(), false);
  assert.deepEqual(f.calls[0], { storeRoot: f.storeRoot, id: A, key: "test-key", shell, devFixture: false });
  const copy = startup.getCurrent();
  copy.serverRoot = "untrusted";
  assert.equal(startup.getCurrent().serverRoot, f.entries.get(A).serverRoot);
});

test("explicit begin after commit in the same instance records an attempt exactly once", async (t) => {
  const f = await fixture(t);
  const selection = f.create();
  await selection.commit(A);
  await selection.begin();
  assert.deepEqual(await f.saved(), pointer(A, null, true, true));
  assert.equal((await selection.begin()).id, A);
  await selection.healthy();
  assert.deepEqual(await f.saved(), pointer(A));
});

test("healthy acknowledgement preserves previous and ordinary restarts remain stable", async (t) => {
  const f = await fixture(t);
  await (await stable(f)).commit(B);
  const second = f.create();
  await second.begin();
  await second.healthy();
  assert.deepEqual(await f.saved(), pointer(B, A));
  assert.equal((await f.create().begin()).id, B);
  assert.deepEqual(await f.saved(), pointer(B, A));
});

test("crash before health falls back to bundled and persists failed candidate", async (t) => {
  const f = await fixture(t);
  await f.create().commit(A);
  await f.create().begin();
  const recovery = f.create();
  assert.deepEqual(await recovery.begin(), { id: null, version: "1.0.0", serverRoot: f.bundledRoot, failed: A });
  assert.deepEqual(await f.saved(), pointer(null, null, false, false, A));
  assert.equal((await f.create().begin()).failed, A);
  await assert.rejects(recovery.commit(A), /failed/);
});

test("crashed candidate restores validated previous and blocks failed candidate retry", async (t) => {
  const f = await fixture(t);
  await (await stable(f)).commit(B);
  await f.create().begin();
  const recovered = f.create();
  assert.equal((await recovered.begin()).id, A);
  assert.deepEqual(await f.saved(), pointer(A, null, false, false, B));
  await assert.rejects(recovered.commit(B), /failed/);
  assert.equal(recovered.getCurrent().failed, B);
});

test("explicit rollback restores previous, records failure and leaves every tree unchanged", async (t) => {
  const f = await fixture(t);
  const selection = await stable(f);
  await selection.commit(B);
  assert.equal((await selection.rollback()).id, A);
  assert.deepEqual(await f.saved(), pointer(A, null, false, false, B));
  for (const id of [A, B, C]) assert.equal(await readFile(path.join(f.entries.get(id).serverRoot, "sentinel"), "utf8"), id);
  assert.equal(await readFile(path.join(f.bundledRoot, "sentinel"), "utf8"), "bundled");
  assert.deepEqual((await readdir(f.storeRoot)).sort(), [A, B, C, "current.json"].sort());
});

test("same/older, missing and unsafe ids cannot be committed", async (t) => {
  const f = await fixture(t);
  const selection = await stable(f);
  const before = await f.saved();
  for (const id of [A, C]) await assert.rejects(selection.commit(id), /newer/);
  for (const id of ["../server", "/other", "A".repeat(64), "", null]) await assert.rejects(selection.commit(id), /id/);
  await assert.rejects(selection.commit("d".repeat(64)), { code: "ENOENT" });
  assert.deepEqual(await f.saved(), before);
});

test("pending selection cannot be replaced before health acknowledgement", async (t) => {
  const f = await fixture(t);
  const selection = f.create();
  await selection.commit(A);
  await assert.rejects(selection.commit(B), /pending/);
  assert.deepEqual(await f.saved(), pointer(A, null, true, false));
});

test("serialized operations prevent a slow commit from clobbering later rollback", async (t) => {
  const f = await fixture(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const selection = f.create({ readPrepared: async (options) => {
    started();
    await gate;
    return f.readPrepared(options);
  } });
  await selection.begin();
  const commit = selection.commit(A);
  await waiting;
  const rollback = selection.rollback();
  release();
  assert.equal((await commit).id, A);
  assert.equal((await rollback).id, null);
  assert.deepEqual(await f.saved(), pointer(null, null, false, false, A));
  assert.equal(selection.getCurrent().id, null);
});

test("rejected operations do not poison the serialization queue", async (t) => {
  const f = await fixture(t);
  const selection = f.create();
  await assert.rejects(selection.commit("bad"));
  assert.equal((await selection.commit(A)).id, A);
});

test("bounded strict pointer schema never trusts supplied paths or versions", async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    "{", " ".repeat(4097), [], null,
    { ...pointer(A), serverRoot: f.bundledRoot }, { ...pointer(A), version: "999.0.0" },
    { ...pointer(A), active: "../outside" }, { ...pointer(A), previous: "../outside" },
    { ...pointer(A), failed: "../outside" }, { ...pointer(A), schema: 2 },
    { ...pointer(A), pending: "true" }, pointer(null, null, true), pointer(A, A), pointer(A, null, false, true),
  ]) {
    await f.save(invalid);
    const selection = f.create();
    await assert.rejects(selection.begin());
    assert.equal(selection.getCurrent(), undefined);
  }
  assert.equal(f.calls.length, 0);
});

test("invalid or missing active prepared entry fails closed without exposing an executable root", async (t) => {
  const f = await fixture(t);
  await f.save(pointer(A));
  f.entries.get(A).error = new Error("Invalid application signature");
  const selection = f.create();
  await assert.rejects(selection.begin(), /signature/);
  assert.equal(selection.getCurrent(), undefined);
  assert.deepEqual(await f.saved(), pointer(A));
  f.entries.delete(A);
  await assert.rejects(f.create().begin(), { code: "ENOENT" });
});

test("shell maintenance explicitly resets incompatible active selection to bundled", async (t) => {
  const f = await fixture(t);
  await stable(f);
  const maintained = f.create({ shell: { ...shell, digest: C } });
  assert.deepEqual(await maintained.begin(), { id: null, version: "1.0.0", serverRoot: f.bundledRoot, failed: A });
  assert.deepEqual(await f.saved(), pointer(null, null, false, false, A));
  assert.equal((await f.create({ shell: { ...shell, digest: C } }).begin()).id, null);
});

test("crash recovery uses bundled when previous is removed or incompatible", async (t) => {
  for (const reason of ["missing", "incompatible"]) {
    const f = await fixture(t);
    await f.save(pointer(B, A, true, true));
    if (reason === "missing") f.entries.delete(A);
    else f.entries.get(A).error = Object.assign(new Error("incompatible"), { code: "ERR_APPLICATION_INCOMPATIBLE" });
    assert.equal((await f.create().begin()).id, null);
    assert.deepEqual(await f.saved(), pointer(null, null, false, false, B));
  }
});

test("corrupt previous entry fails closed and leaves pending pointer intact", async (t) => {
  const f = await fixture(t);
  const saved = pointer(B, A, true, true);
  await f.save(saved);
  f.entries.get(A).error = new Error("Invalid application layout");
  await assert.rejects(f.create().begin(), /layout/);
  assert.deepEqual(await f.saved(), saved);
});

test("pointer symlinks and directory pointers cannot be followed", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.base, "external.json");
  await writeFile(target, JSON.stringify(pointer(A)));
  const filename = path.join(f.storeRoot, "current.json");
  let linked = false;
  try {
    await symlink(target, filename, "file");
    linked = true;
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    t.diagnostic("File symlink unavailable; directory pointer rejection still checked");
  }
  if (linked) await assert.rejects(f.create().begin());
  await rm(filename, { force: true });
  await mkdir(filename);
  await assert.rejects(f.create().begin(), /pointer file/);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), pointer(A));
});

test("store root junctions and linked ancestors cannot redirect pointer writes", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.base, "alias");
  await symlink(f.storeRoot, alias, "junction");
  await assert.rejects(f.create({ storeRoot: alias }).commit(A), /canonical|linked/);
  const parent = path.join(f.base, "real-parent");
  const aliasParent = path.join(f.base, "alias-parent");
  await mkdir(parent);
  await symlink(parent, aliasParent, "junction");
  await assert.rejects(f.create({ storeRoot: path.join(aliasParent, "new-directory") }).begin(), /canonical|linked/);
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(f.saved(), { code: "ENOENT" });
});

test("storage resolver chooses canonical storage outside actual installation", async (t) => {
  const f = await fixture(t);
  const localAppData = path.join(f.base, "user-data");
  const resourcesPath = path.join(f.base, "installation", "resources");
  assert.equal(await resolveApplicationStore({ resourcesPath, localAppData }), path.join(localAppData, "Weclio", "applications"));
  const installedResources = path.join(localAppData, "Weclio", "resources");
  await mkdir(installedResources, { recursive: true });
  assert.equal(await resolveApplicationStore({ resourcesPath: installedResources, localAppData }), path.join(localAppData, "Weclio-applications"));
  const alias = path.join(f.base, "installation-alias");
  await symlink(path.dirname(resourcesPath), alias, "junction");
  assert.equal(await resolveApplicationStore({ resourcesPath: path.join(alias, "resources"), localAppData }), path.join(localAppData, "Weclio", "applications"));
});

test("storage resolver detects installation aliases and rejects unsafe explicit bases actionably", async (t) => {
  const f = await fixture(t);
  const localAppData = path.join(f.base, "data");
  const resourcesPath = path.join(f.base, "installation", "resources");
  await mkdir(localAppData);
  await symlink(path.dirname(resourcesPath), path.join(localAppData, "Weclio"), "junction");
  assert.equal(await resolveApplicationStore({ resourcesPath, localAppData }), path.join(localAppData, "Weclio-applications"));
  for (const base of [undefined, "", "relative"]) await assert.rejects(resolveApplicationStore({ resourcesPath, localAppData: base }), /absolute localAppData/);
  const fileBase = path.join(f.base, "not-a-directory");
  await writeFile(fileBase, "file");
  await assert.rejects(resolveApplicationStore({ resourcesPath, localAppData: fileBase }), /Invalid localAppData/);
  const occupied = path.join(f.base, "occupied");
  await mkdir(path.join(occupied, "resources"), { recursive: true });
  await assert.rejects(resolveApplicationStore({ resourcesPath: path.join(occupied, "resources"), localAppData: occupied }), /Reinstall/);
});

test("production default dynamically validates signed store entries and handles shell maintenance", async (t) => {
  const f = await fixture(t);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const contents = new Map([
    ["package.json", JSON.stringify({ version: "2.0.0" })], ["next.config.js", "export default {};"],
    ["desktop-packages.mjs", "export default [];"], [".next/BUILD_ID", "fixture"],
    [".next/required-server-files.json", "{}"], ["node_modules/next/dist/bin/next", "// fixture"],
  ]);
  const layout = Buffer.from(JSON.stringify({ schema: 1, files: [...contents].map(([name, content]) => ({ path: name, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") })) }));
  const bytes = [...contents.values()].reduce((total, content) => total + Buffer.byteLength(content), 0);
  const layoutSha512 = createHash("sha512").update(layout).digest("base64");
  const body = {
    schema: 1, type: "weclio-application", version: "2.0.0", platform: "win32", arch: "x64",
    shell: { version: shell.version, digest: shell.digest }, toolset: shell.toolset,
    archive: { url: "https://updates.example/app.zip", size: 1, sha512: Buffer.alloc(64).toString("base64") },
    layout: { url: "https://updates.example/layout.json", size: layout.length, sha512: layoutSha512, fileCount: contents.size, bytes },
  };
  const payload = Buffer.from(JSON.stringify(body));
  const id = createHash("sha256").update(payload).digest("hex");
  const destination = path.join(f.storeRoot, "versions", id);
  const serverRoot = path.join(destination, "server");
  for (const [name, content] of contents) {
    const filename = path.join(serverRoot, ...name.split("/"));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  await writeFile(path.join(destination, "envelope.json"), JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") }));
  await writeFile(path.join(destination, "layout.json"), layout);
  await writeFile(path.join(destination, "complete.json"), JSON.stringify({ schema: 1, id, layoutSha512, fileCount: contents.size, bytes }));
  const production = (extra = {}) => f.create({ readPrepared: undefined, key: publicKey, ...extra });
  await production().commit(id);
  assert.equal((await production().begin()).serverRoot, serverRoot);
  const started = production();
  assert.equal((await started.begin()).id, null);
  assert.equal(started.getCurrent().failed, id);
  await f.save(pointer(id));
  const maintained = production({ shell: { ...shell, digest: C } });
  assert.equal((await maintained.begin()).id, null);
  assert.equal(maintained.getCurrent().failed, id);
});
