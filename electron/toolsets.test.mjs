import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolsetManifest, ensureToolset, resolveDesktopTools } from "./toolsets.mjs";

const REQUIRED = ["git/bin/bash.exe", "git/cmd/git.exe", "tools/rg.exe", "tools/fd.exe"];
const RECEIPT = ".desktop-toolset-complete.json";

async function fixture(t, installation = "installation") {
  const root = await mkdtemp(path.join(os.tmpdir(), "weclio-toolsets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, installation, "resources");
  const sourceRoot = path.join(resourcesPath, "runtime", "win-x64");
  const storeRoot = path.join(root, "shared");
  for (const name of [...REQUIRED, "git/etc/config"]) {
    const filename = path.join(sourceRoot, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `fixture:${name}`);
  }
  await writeFile(path.join(sourceRoot, "ignored.txt"), "not a tool");
  const manifest = await createToolsetManifest(sourceRoot);
  return { root, resourcesPath, sourceRoot, storeRoot, manifest };
}

function signed(files) {
  const canonical = { schema: 1, files: [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  return { ...canonical, id: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}

async function linkOrSkip(t, target, filename, type) {
  try {
    await symlink(target, filename, type);
    return true;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    t.skip("Symlink privilege unavailable");
    return false;
  }
}

test("manifest includes only regular git/tools files with portable, sorted, content-addressed entries", async (t) => {
  const f = await fixture(t);
  assert.equal(f.manifest.schema, 1);
  assert.deepEqual(f.manifest.files.map((file) => file.path), [...REQUIRED, "git/etc/config"].sort());
  for (const file of f.manifest.files) {
    const content = await readFile(path.join(f.sourceRoot, file.path));
    assert.equal(file.size, content.length);
    assert.equal(file.sha256, createHash("sha256").update(content).digest("hex"));
  }
  assert.deepEqual(f.manifest, signed(f.manifest.files));
  assert.deepEqual(await createToolsetManifest(f.sourceRoot), f.manifest);
  await writeFile(path.join(f.sourceRoot, "tools", "fd.exe"), "changed");
  assert.notEqual((await createToolsetManifest(f.sourceRoot)).id, f.manifest.id);
});

test("migration verifies declared files, reports progress, and leaves source untouched", async (t) => {
  const f = await fixture(t);
  const progress = [];
  const destination = await ensureToolset({ ...f, onProgress: (event) => progress.push(event) });
  assert.equal(destination, path.join(f.storeRoot, f.manifest.id));
  for (const file of f.manifest.files) {
    assert.deepEqual(await readFile(path.join(destination, file.path)), await readFile(path.join(f.sourceRoot, file.path)));
  }
  await assert.rejects(lstat(path.join(destination, "ignored.txt")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, RECEIPT), "utf8")), { schema: 1, id: f.manifest.id });
  assert.equal(progress[0].phase, "copying");
  assert.equal(progress.at(-1).phase, "ready");
  assert.equal(progress.at(-1).completedBytes, f.manifest.files.reduce((sum, file) => sum + file.size, 0));
  assert.equal(progress.at(-1).completedFiles, f.manifest.files.length);
  assert.equal(progress.at(-1).reused, false);
  assert.deepEqual(await readdir(f.storeRoot), [f.manifest.id]);
});

test("warm reuse needs neither source nor a recursive scan of optional files", async (t) => {
  const f = await fixture(t);
  const destination = await ensureToolset(f);
  await rm(f.sourceRoot, { recursive: true });
  await rm(path.join(destination, "git", "etc"), { recursive: true });
  const progress = [];
  assert.equal(await ensureToolset({ ...f, onProgress: (event) => progress.push(event) }), destination);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].reused, true);
});

test("manifest validation rejects unsafe paths, aliases, duplicates, absent binaries, and conflicting paths", async (t) => {
  const f = await fixture(t);
  for (const unsafe of ["../escape", "/tools/rg.exe", "tools/../escape", "tools//file", "tools/./file", "tools\\file", "tools/C:file", "tools/name.", "tools/name ", "tools/CON.exe", "tools/a\u0000b"]) {
    const manifest = signed([...f.manifest.files, { ...f.manifest.files[0], path: unsafe }]);
    await assert.rejects(ensureToolset({ ...f, manifest }), /Invalid/);
  }
  for (const extra of ["TOOLS/fd.exe", "tools/FD.exe", "git/Bin/extra", "git/bin/bash.exe/child"]) {
    await assert.rejects(ensureToolset({ ...f, manifest: signed([...f.manifest.files, { ...f.manifest.files[0], path: extra }]) }));
  }
  await assert.rejects(ensureToolset({ ...f, manifest: signed([...f.manifest.files, f.manifest.files[0]]) }), /duplicate/);
  await assert.rejects(ensureToolset({ ...f, manifest: signed(f.manifest.files.filter((file) => file.path !== REQUIRED[0])) }), /Missing/);
  for (const manifest of [null, {}, { ...f.manifest, schema: 2 }, { ...f.manifest, id: "0".repeat(64) }, signed(f.manifest.files.map((file, index) => index ? file : { ...file, size: -1 })), signed(f.manifest.files.map((file, index) => index ? file : { ...file, sha256: "not a digest" }))]) {
    await assert.rejects(ensureToolset({ ...f, manifest }));
  }
  await assert.rejects(lstat(f.storeRoot), { code: "ENOENT" });
});

test("manifest creation rejects missing binaries", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.sourceRoot, "tools", "fd.exe"));
  await assert.rejects(createToolsetManifest(f.sourceRoot), /Missing/);
});

test("manifest creation rejects linked files", async (t) => {
  const f = await fixture(t);
  if (!await linkOrSkip(t, path.join(f.sourceRoot, "tools", "fd.exe"), path.join(f.sourceRoot, "tools", "linked.exe"), "file")) return;
  await assert.rejects(createToolsetManifest(f.sourceRoot), /Linked/);
});

test("manifest creation rejects linked directories", async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.sourceRoot, "git", "linked");
  if (!await linkOrSkip(t, path.join(f.sourceRoot, "tools"), linked, "junction")) return;
  await assert.rejects(createToolsetManifest(f.sourceRoot), /Linked/);
});

test("failed hashes and sizes preserve source and a previously completed version", async (t) => {
  const f = await fixture(t);
  const previous = await ensureToolset(f);
  await writeFile(path.join(f.sourceRoot, "tools", "fd.exe"), "new-version");
  const next = await createToolsetManifest(f.sourceRoot);
  await writeFile(path.join(f.sourceRoot, "tools", "fd.exe"), "bad-version");
  await assert.rejects(ensureToolset({ ...f, manifest: next }), /hash mismatch/);
  assert.equal(await readFile(path.join(f.sourceRoot, "tools", "fd.exe"), "utf8"), "bad-version");
  assert.equal(await ensureToolset(f), previous);
  await writeFile(path.join(f.sourceRoot, "tools", "fd.exe"), "wrong length");
  await assert.rejects(ensureToolset({ ...f, manifest: next }), /size mismatch/);
  assert.deepEqual(await readdir(f.storeRoot), [f.manifest.id]);
});

test("abort and progress callback failures remove only this preparation's temporary directory", async (t) => {
  const f = await fixture(t);
  await mkdir(f.storeRoot);
  await writeFile(path.join(f.storeRoot, "user-file"), "preserve");
  const controller = new AbortController();
  await assert.rejects(ensureToolset({ ...f, signal: controller.signal, onProgress(event) {
    if (event.completedFiles === 1) controller.abort();
  } }), { name: "AbortError" });
  assert.deepEqual(await readdir(f.storeRoot), ["user-file"]);
  assert.deepEqual(await createToolsetManifest(f.sourceRoot), f.manifest);
  await assert.rejects(ensureToolset({ ...f, onProgress() { throw new Error("UI failed"); } }), /UI failed/);
  assert.deepEqual(await readdir(f.storeRoot), ["user-file"]);
  await assert.rejects(ensureToolset({ ...f, signal: controller.signal }), { name: "AbortError" });
});

test("concurrent preparations converge to one completed immutable id", async (t) => {
  const f = await fixture(t);
  const events = [];
  const results = await Promise.all(Array.from({ length: 6 }, () => ensureToolset({ ...f, onProgress(event) {
    if (event.phase === "ready") events.push(event);
  } })));
  assert.equal(new Set(results).size, 1);
  assert.equal(events.filter((event) => !event.reused).length, 1);
  assert.deepEqual(await readdir(f.storeRoot), [f.manifest.id]);
  assert.equal(await ensureToolset(f), results[0]);
});

test("an unrelated stale publication lock does not block preparation or get removed", async (t) => {
  const f = await fixture(t);
  const staleLock = path.join(f.storeRoot, `.${f.manifest.id}.lock`);
  await mkdir(staleLock, { recursive: true });
  await writeFile(path.join(staleLock, "user-file"), "preserve");
  assert.equal(await ensureToolset(f), path.join(f.storeRoot, f.manifest.id));
  assert.equal(await readFile(path.join(staleLock, "user-file"), "utf8"), "preserve");
  assert.deepEqual((await readdir(f.storeRoot)).sort(), [path.basename(staleLock), f.manifest.id].sort());
});

test("existing empty, corrupt, or user-owned destination is never replaced or removed", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.storeRoot, f.manifest.id);
  await mkdir(destination, { recursive: true });
  await assert.rejects(ensureToolset(f));
  assert.deepEqual(await readdir(destination), []);
  await writeFile(path.join(destination, "user-file"), "preserve");
  await writeFile(path.join(destination, RECEIPT), "not JSON");
  await assert.rejects(ensureToolset(f));
  assert.equal(await readFile(path.join(destination, "user-file"), "utf8"), "preserve");
  assert.deepEqual(await readdir(f.storeRoot), [f.manifest.id]);
});

test("warm reuse rejects missing or invalid receipt and missing or resized required files", async (t) => {
  const f = await fixture(t);
  const destination = await ensureToolset(f);
  const receipt = path.join(destination, RECEIPT);
  const contents = await readFile(receipt);
  await rm(receipt);
  await assert.rejects(ensureToolset(f), { code: "ENOENT" });
  await writeFile(receipt, JSON.stringify({ schema: 1, id: "wrong" }));
  await assert.rejects(ensureToolset(f), /receipt/);
  await writeFile(receipt, contents);
  const binary = path.join(destination, REQUIRED[0]);
  const original = await readFile(binary);
  await writeFile(binary, "short");
  await assert.rejects(ensureToolset(f), /Invalid completed/);
  await rm(binary);
  await assert.rejects(ensureToolset(f), { code: "ENOENT" });
  await writeFile(binary, original);
  assert.equal(await ensureToolset(f), destination);
});

test("warm reuse rejects same-size tampering of every required binary without changing the store", async (t) => {
  const f = await fixture(t);
  const destination = await ensureToolset(f);
  await rm(f.sourceRoot, { recursive: true });
  for (const name of REQUIRED) {
    const binary = path.join(destination, name);
    const original = await readFile(binary);
    const tampered = Buffer.from(original);
    tampered[0] ^= 0xff;
    await writeFile(binary, tampered);
    assert.equal((await lstat(binary)).size, original.length);
    await assert.rejects(ensureToolset(f), /Invalid completed toolset file/);
    assert.deepEqual(await readFile(binary), tampered);
    await writeFile(binary, original);
  }
  assert.equal(await ensureToolset(f), destination);
  assert.deepEqual(await readdir(f.storeRoot), [f.manifest.id]);
});

test("linked completed binaries are rejected", async (t) => {
  const f = await fixture(t);
  const destination = await ensureToolset(f);
  const binary = path.join(destination, REQUIRED[0]);
  await rm(binary);
  if (!await linkOrSkip(t, path.join(f.sourceRoot, REQUIRED[0]), binary, "file")) return;
  await assert.rejects(ensureToolset(f), /Not a regular/);
});

test("linked source subdirectories are rejected without leaving temporary output", async (t) => {
  const f = await fixture(t);
  const originalTools = path.join(f.root, "original-tools");
  await mkdir(originalTools);
  for (const name of ["fd.exe", "rg.exe"]) await writeFile(path.join(originalTools, name), `fixture:tools/${name}`);
  await rm(path.join(f.sourceRoot, "tools"), { recursive: true });
  if (!await linkOrSkip(t, originalTools, path.join(f.sourceRoot, "tools"), "junction")) return;
  await assert.rejects(ensureToolset(f), /Not a regular/);
  await assert.rejects(createToolsetManifest(f.sourceRoot), /Invalid toolset directory/);
  assert.deepEqual(await readdir(f.storeRoot), []);
});

test("stores must be absolute and outside the actual source and installation tree", async (t) => {
  const f = await fixture(t);
  for (const storeRoot of [undefined, "relative", f.sourceRoot, path.join(f.sourceRoot, "nested"), path.join(f.resourcesPath, "shared"), path.join(f.root, "installation", "shared")]) {
    await assert.rejects(ensureToolset({ ...f, storeRoot }), /absolute|outside/);
  }
  const alias = path.join(f.root, "installation-alias");
  if (!await linkOrSkip(t, path.join(f.root, "installation"), alias, "junction")) return;
  await assert.rejects(ensureToolset({ ...f, storeRoot: path.join(alias, "shared") }), /outside/);
  const sourceAlias = path.join(f.root, "source-alias");
  if (!await linkOrSkip(t, f.sourceRoot, sourceAlias, "junction")) return;
  await assert.rejects(ensureToolset({ ...f, sourceRoot: sourceAlias, storeRoot: path.join(f.root, "installation", "shared") }), /outside/);
  assert.equal(await ensureToolset({ ...f, sourceRoot: sourceAlias }), path.join(f.storeRoot, f.manifest.id));
});

test("desktop resolver selects the ordinary canonical storeBase candidate and reuses it without source", async (t) => {
  const f = await fixture(t);
  const storeBase = path.join(f.root, "local-app-data");
  await writeFile(path.join(f.resourcesPath, "desktop-toolset.json"), JSON.stringify(f.manifest));
  const options = { resourcesPath: f.resourcesPath, storeBase };
  const expected = path.join(storeBase, "Weclio", "toolsets", f.manifest.id);
  assert.equal(await resolveDesktopTools(options), expected);
  await rm(f.sourceRoot, { recursive: true });
  assert.equal(await resolveDesktopTools(options), expected);
  await assert.rejects(lstat(path.join(storeBase, "Weclio-toolsets")), { code: "ENOENT" });
});

test("desktop resolver falls back outside a custom LOCALAPPDATA/Weclio installation", async (t) => {
  const f = await fixture(t, path.join("local-app-data", "Weclio"));
  const storeBase = path.join(f.root, "local-app-data");
  await writeFile(path.join(f.resourcesPath, "desktop-toolset.json"), JSON.stringify(f.manifest));
  assert.equal(await resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase }), path.join(storeBase, "Weclio-toolsets", f.manifest.id));
  await assert.rejects(lstat(path.join(storeBase, "Weclio", "toolsets")), { code: "ENOENT" });
  assert.deepEqual(await createToolsetManifest(f.sourceRoot), f.manifest);
});

test("desktop resolver checks junction aliases and returns the canonical outside candidate", async (t) => {
  const f = await fixture(t);
  const storeBase = path.join(f.root, "local-app-data");
  const baseAlias = path.join(f.root, "base-alias");
  const installationAlias = path.join(f.root, "installation-alias");
  await mkdir(storeBase);
  if (!await linkOrSkip(t, path.dirname(f.resourcesPath), path.join(storeBase, "Weclio"), "junction")) return;
  if (!await linkOrSkip(t, storeBase, baseAlias, "junction")) return;
  if (!await linkOrSkip(t, path.dirname(f.resourcesPath), installationAlias, "junction")) return;
  await writeFile(path.join(f.resourcesPath, "desktop-toolset.json"), JSON.stringify(f.manifest));
  assert.equal(await resolveDesktopTools({ resourcesPath: path.join(installationAlias, "resources"), storeBase: baseAlias }), path.join(storeBase, "Weclio-toolsets", f.manifest.id));
  await assert.rejects(lstat(path.join(storeBase, "Weclio", "toolsets")), { code: "ENOENT" });
});

test("desktop resolver rejects unsafe bases and keeps explicit storeRoot strict", async (t) => {
  const f = await fixture(t, "local-app-data");
  const storeBase = path.join(f.root, "local-app-data");
  await writeFile(path.join(f.resourcesPath, "desktop-toolset.json"), JSON.stringify(f.manifest));
  for (const invalid of [undefined, null, "", "relative"]) {
    await assert.rejects(resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase: invalid }), /absolute.*storeBase/);
  }
  await assert.rejects(resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase }), /dedicated installation directory/);
  await assert.rejects(lstat(path.join(storeBase, "Weclio")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(storeBase, "Weclio-toolsets")), { code: "ENOENT" });
  const safeBase = path.join(f.root, "safe-base");
  await assert.rejects(resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase: safeBase, storeRoot: path.join(storeBase, "explicit") }), /outside/);
  for (const invalid of [null, "relative"]) {
    await assert.rejects(resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase: safeBase, storeRoot: invalid }), /absolute.*storeRoot/);
  }
  await assert.rejects(lstat(safeBase), { code: "ENOENT" });
  assert.equal(await resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase: "relative", storeRoot: f.storeRoot }), path.join(f.storeRoot, f.manifest.id));
});

test("desktop resolver preserves absent-manifest legacy behavior and requires valid metadata otherwise", async (t) => {
  const f = await fixture(t);
  assert.equal(await resolveDesktopTools({ resourcesPath: f.resourcesPath }), f.sourceRoot);
  assert.equal(await resolveDesktopTools({ resourcesPath: f.resourcesPath, storeBase: "relative", storeRoot: "relative" }), f.sourceRoot);
  const filename = path.join(f.resourcesPath, "desktop-toolset.json");
  await writeFile(filename, "malformed");
  await assert.rejects(resolveDesktopTools(f), SyntaxError);
  await writeFile(filename, "{}");
  await assert.rejects(resolveDesktopTools(f), /manifest/);
  await writeFile(filename, JSON.stringify(f.manifest));
  await assert.rejects(resolveDesktopTools({ resourcesPath: f.resourcesPath }), /absolute/);
  await assert.rejects(resolveDesktopTools({ ...f, storeRoot: path.join(f.root, "installation", "cache") }), /outside/);
  const destination = await resolveDesktopTools(f);
  assert.equal(destination, path.join(f.storeRoot, f.manifest.id));
  await rm(f.sourceRoot, { recursive: true });
  assert.equal(await resolveDesktopTools(f), destination);
});
