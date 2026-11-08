import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareApplication, readPreparedApplication, validateZipListing } from "./application-store.mjs";
import { APPLICATION_STARTUP_FILES as required, validateLayout, verifyApplicationManifest } from "./application-manifest.mjs";

const { publicKey: key, privateKey } = generateKeyPairSync("ed25519");
const sha = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const sourceTools = fileURLToPath(new URL("../resources/runtime/win-x64/", import.meta.url));
const toolNames = ["git/usr/bin/unzip.exe", "git/usr/bin/zipinfo.exe"];

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "weclio-application-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// 测试专用的微型 stored ZIP 编写器；生产实现仅调用已验证的 Portable Git 工具。
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function tinyZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes, mode = 0o100644 } of entries) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE((mode * 65536) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes);
    central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(toolset = "b".repeat(64), changes = {}, mutateLayout = () => {}) {
  const entries = [...required, "public/a space.txt"].map((name) => ({ name, bytes: Buffer.from(name === "package.json" ? '{"version":"2.0.0"}' : `test:${name}`) }));
  const archive = tinyZip(entries);
  const layout = { schema: 1, files: entries.map(({ name, bytes }) => ({ path: name, size: bytes.length, sha256: sha(bytes) })) };
  mutateLayout(layout);
  const layoutBytes = Buffer.from(JSON.stringify(layout));
  const body = {
    schema: 1, type: "weclio-application", version: "2.0.0", platform: "win32", arch: "x64",
    shell: { version: "1.0.0", digest: "a".repeat(64) }, toolset,
    archive: { url: "https://updates.example/application.zip", size: archive.length, sha512: sha(archive, "sha512", "base64") },
    layout: { url: "https://updates.example/layout.json", size: layoutBytes.length, sha512: sha(layoutBytes, "sha512", "base64"), fileCount: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes.length, 0) },
    ...changes,
  };
  const payload = Buffer.from(JSON.stringify(body));
  const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") };
  const release = verifyApplicationManifest(envelope, key);
  const shell = { schema: 1, ...body.shell, toolset };
  return { entries, archive, layout, layoutBytes, body, envelope, release, shell };
}

async function installCompleted(storeRoot, data) {
  const destination = path.join(storeRoot, "versions", data.release.id);
  const serverRoot = path.join(destination, "server");
  for (const entry of data.entries) {
    const filename = path.join(serverRoot, entry.name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, entry.bytes);
  }
  await writeFile(path.join(destination, "envelope.json"), JSON.stringify(data.envelope));
  await writeFile(path.join(destination, "layout.json"), data.layoutBytes);
  await writeFile(path.join(destination, "complete.json"), JSON.stringify({ schema: 1, id: data.release.id, layoutSha512: data.body.layout.sha512, fileCount: data.entries.length, bytes: data.body.layout.bytes }));
  return { destination, serverRoot };
}

function options(storeRoot, data, extra = {}) {
  return { storeRoot, id: data.release.id, key, shell: data.shell, envelope: data.envelope, ...extra };
}

function listing(data, members = data.entries.map(({ name, bytes }) => ({ name, size: bytes.length, mode: "-rw-r--r--" }))) {
  const bytes = members.reduce((sum, member) => sum + member.size, 0);
  return [
    `Archive:  test.zip\nZip file size: ${data.archive.length} bytes, number of entries: ${members.length}\n${members.map(({ name, size, mode }) => `${mode}  3.0 unx ${size} b- ${size} stor 20260101.000000 ${name}`).join("\n")}\n${members.length} files, ${bytes} bytes uncompressed, ${bytes} bytes compressed:  0.0%\n`,
    `${members.map((member) => member.name).join("\n")}\n`,
  ];
}

function inspect(data, members) {
  return validateZipListing(...listing(data, members), validateLayout(data.layout, data.release), data.archive.length);
}

test("ZIP inspection accepts exact files and only necessary directory prefixes", () => {
  const data = fixture();
  inspect(data);
  const members = data.entries.map(({ name, bytes }) => ({ name, size: bytes.length, mode: "-rw-r--r--" }));
  members.push({ name: "public/", size: 0, mode: "drwxr-xr-x" });
  inspect(data, members);
});

test("ZIP inspection rejects links, aliases, traversal, ADS, extras, duplicates, omissions and size/type mismatches", () => {
  const data = fixture();
  const members = data.entries.map(({ name, bytes }) => ({ name, size: bytes.length, mode: "-rw-r--r--" }));
  for (const name of ["../outside", "/package.json", "C:/bad", "public\\a space.txt", "public/a space.txt:ads", "public/A space.txt", "public/a space.txt.", "git/bin/git.exe", "public/unneeded/", "public/../package.json", "public/a\nspace.txt"]) {
    assert.throws(() => inspect(data, [...members, { name, size: 0, mode: name.endsWith("/") ? "drwxr-xr-x" : "-rw-r--r--" }]), name);
  }
  assert.throws(() => inspect(data, [...members, members[0]]), /duplicate/);
  assert.throws(() => inspect(data, members.slice(1)), /missing/);
  for (const mode of ["lrwxrwxrwx", "prw-------", "brw-------", "?rw-------", "drwxr-xr-x"]) {
    assert.throws(() => inspect(data, members.map((member, i) => i === 0 ? { ...member, mode } : member)), mode);
  }
  assert.throws(() => inspect(data, members.map((member, i) => i === 0 ? { ...member, size: member.size + 1 } : member)), /unexpected/);
  const [long, names] = listing(data);
  assert.throws(() => validateZipListing(long, names.replace("package.json", "LICENSE"), data.layout, data.archive.length), /format/);
  assert.throws(() => validateZipListing(long.replace("bytes, number", "bytes, unknown"), names, data.layout, data.archive.length), /size/);
  assert.throws(() => validateZipListing(long + "extra\n", names, data.layout, data.archive.length), /count/);
});

test("signature and compatibility fail before archive or store access", async (t) => {
  const root = await temporary(t);
  const data = fixture();
  const storeRoot = path.join(root, "must-not-exist");
  const extra = { archivePath: path.join(root, "missing.zip"), layoutPath: path.join(root, "missing.json") };
  await assert.rejects(prepareApplication(options(storeRoot, data, { ...extra, envelope: { ...data.envelope, signature: Buffer.alloc(64).toString("base64") } })), /signature/);
  await assert.rejects(prepareApplication(options(storeRoot, data, { ...extra, shell: { ...data.shell, digest: "c".repeat(64) } })), { code: "ERR_APPLICATION_INCOMPATIBLE" });
  await assert.rejects(lstat(storeRoot), { code: "ENOENT" });
});

test("warm reads bind receipt, layout digest, identity and all six startup hashes; noncritical files are not rehashed", async (t) => {
  const storeRoot = await temporary(t);
  const data = fixture();
  const { serverRoot, destination } = await installCompleted(storeRoot, data);
  const record = await readPreparedApplication(options(storeRoot, data));
  assert.deepEqual(record, { id: data.release.id, version: "2.0.0", serverRoot, envelope: data.envelope });
  await writeFile(path.join(serverRoot, "public/a space.txt"), "changed noncritical");
  await readPreparedApplication(options(storeRoot, data));
  for (const name of required) {
    const original = data.entries.find((entry) => entry.name === name).bytes;
    const changed = Buffer.from(original);
    changed[0] ^= 1;
    await writeFile(path.join(serverRoot, name), changed);
    await assert.rejects(readPreparedApplication(options(storeRoot, data)), /file hash/);
    await writeFile(path.join(serverRoot, name), original);
  }
  await writeFile(path.join(destination, "layout.json"), Buffer.alloc(data.layoutBytes.length));
  await assert.rejects(readPreparedApplication(options(storeRoot, data)), /layout digest/);
  await writeFile(path.join(destination, "layout.json"), data.layoutBytes);
  await writeFile(path.join(destination, "complete.json"), "{}");
  await assert.rejects(readPreparedApplication(options(storeRoot, data)), /receipt/);
});

test("existing completed version is reused without touching absent archives or tools", async (t) => {
  const storeRoot = await temporary(t);
  const data = fixture();
  await installCompleted(storeRoot, data);
  const events = [];
  await prepareApplication(options(storeRoot, data, { onProgress: (event) => events.push(event) }));
  assert.deepEqual(events, [{ phase: "ready", completedBytes: data.body.layout.bytes, totalBytes: data.body.layout.bytes, completedFiles: data.entries.length, totalFiles: data.entries.length }]);
});

test("absent ids return ENOENT; malformed ids and incomplete or incompatible existing versions are not replaceable", async (t) => {
  const storeRoot = await temporary(t);
  const data = fixture();
  await mkdir(path.join(storeRoot, "versions"));
  await assert.rejects(readPreparedApplication(options(storeRoot, data)), { code: "ENOENT" });
  for (const id of ["../escape", "A".repeat(64), "a".repeat(63), undefined]) await assert.rejects(readPreparedApplication(options(storeRoot, data, { id })), /release id/);
  const destination = path.join(storeRoot, "versions", data.release.id);
  await mkdir(destination);
  await assert.rejects(prepareApplication(options(storeRoot, data)), /incomplete existing version/);
  assert.deepEqual(await readdir(destination), []);
  await installCompleted(storeRoot, data);
  await assert.rejects(readPreparedApplication(options(storeRoot, data, { shell: { ...data.shell, digest: "d".repeat(64) } })), { code: "ERR_APPLICATION_INCOMPATIBLE" });
  await assert.rejects(readPreparedApplication(options("relative", data)), /absolute/);
});

test("versions, target and startup path links are rejected", async (t) => {
  const root = await temporary(t);
  const data = fixture();
  const realStore = path.join(root, "real");
  const linkedStore = path.join(root, "linked");
  const { serverRoot } = await installCompleted(realStore, data);
  await mkdir(linkedStore);
  try {
    await symlink(path.join(realStore, "versions"), path.join(linkedStore, "versions"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Creating directory links requires unavailable permissions");
    throw error;
  }
  await assert.rejects(readPreparedApplication(options(linkedStore, data)), /not a directory/);
  const next = path.join(serverRoot, ".next");
  const other = path.join(root, "other");
  await mkdir(other);
  await rm(next, { recursive: true });
  await symlink(other, next, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readPreparedApplication(options(realStore, data)), /regular file/);
});

async function toolsOrSkip(t) {
  if (process.platform !== "win32") {
    t.skip("Portable Git ZIP integration requires Windows; pure validators run on every platform");
    return null;
  }
  const files = [];
  for (const name of toolNames) {
    let bytes;
    try {
      bytes = await readFile(path.join(sourceTools, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      t.skip("Portable Git zipinfo.exe/unzip.exe fixture is not installed");
      return null;
    }
    files.push({ path: name, size: bytes.length, sha256: sha(bytes) });
  }
  return { schema: 1, files, id: sha(JSON.stringify({ schema: 1, files })) };
}

async function archives(root, data) {
  const archivePath = path.join(root, "tiny.zip");
  const layoutPath = path.join(root, "tiny.json");
  await writeFile(archivePath, data.archive);
  await writeFile(layoutPath, data.layoutBytes);
  return { archivePath, layoutPath };
}

test("tiny Portable Git integration: verified preparation, concurrency, progress, reuse and metadata isolation", async (t) => {
  const toolsetManifest = await toolsOrSkip(t);
  if (!toolsetManifest) return;
  const root = await temporary(t);
  const data = fixture(toolsetManifest.id);
  const storeRoot = path.join(root, "store");
  const events = [];
  const opts = options(storeRoot, data, { ...await archives(root, data), toolsRoot: sourceTools, toolsetManifest, onProgress: (event) => events.push(event) });
  const records = await Promise.all([prepareApplication(opts), prepareApplication(opts)]);
  assert.deepEqual(records[0], records[1]);
  assert.equal(events.at(-1).phase, "ready");
  assert.ok(events.some((event) => event.phase === "extracting"));
  assert.ok(events.some((event) => event.phase === "verifying" && event.completedFiles === data.entries.length));
  for (const event of events.filter((event) => event.phase === "ready")) assert.equal(event.completedFiles, data.entries.length);
  assert.deepEqual(await readdir(path.join(storeRoot, "versions")), [data.release.id]);
  assert.deepEqual((await readdir(path.dirname(records[0].serverRoot))).sort(), ["complete.json", "envelope.json", "layout.json", "server"]);
  for (const entry of data.entries) assert.deepEqual(await readFile(path.join(records[0].serverRoot, entry.name)), entry.bytes);
  await rm(opts.archivePath);
  await rm(opts.layoutPath);
  assert.deepEqual(await prepareApplication(opts), records[0]);
});

test("tiny integration rejects wrong artifacts and unverified executables before staging", async (t) => {
  const toolsetManifest = await toolsOrSkip(t);
  if (!toolsetManifest) return;
  const root = await temporary(t);
  const data = fixture(toolsetManifest.id);
  const storeRoot = path.join(root, "store");
  const opts = options(storeRoot, data, { ...await archives(root, data), toolsRoot: sourceTools, toolsetManifest });
  await writeFile(opts.archivePath, Buffer.alloc(data.archive.length));
  await assert.rejects(prepareApplication(opts), /artifact hash/);
  await writeFile(opts.archivePath, data.archive);
  await writeFile(opts.layoutPath, Buffer.alloc(data.layoutBytes.length));
  await assert.rejects(prepareApplication(opts), /artifact hash/);
  await writeFile(opts.layoutPath, data.layoutBytes);
  const badTools = structuredClone(toolsetManifest);
  badTools.files[0].sha256 = "0".repeat(64);
  await assert.rejects(prepareApplication({ ...opts, toolsetManifest: badTools }), /toolset digest/);
  const fakeTools = path.join(root, "fake-tools");
  for (const file of toolsetManifest.files) {
    await mkdir(path.dirname(path.join(fakeTools, file.path)), { recursive: true });
    await writeFile(path.join(fakeTools, file.path), Buffer.alloc(file.size));
  }
  await assert.rejects(prepareApplication({ ...opts, toolsRoot: fakeTools }), /file hash/);
  await assert.rejects(lstat(storeRoot), { code: "ENOENT" });
});

test("tiny integration rejects traversal members and local-header name mismatches before extraction", async (t) => {
  const toolsetManifest = await toolsOrSkip(t);
  if (!toolsetManifest) return;
  const root = await temporary(t);
  const base = fixture(toolsetManifest.id);
  const traversal = tinyZip([...base.entries, { name: "../escape", bytes: Buffer.from("bad") }]);
  const localMismatch = Buffer.from(base.archive);
  Buffer.from("../evil.json").copy(localMismatch, 30);
  for (const [index, archive] of [traversal, localMismatch].entries()) {
    const data = fixture(toolsetManifest.id, { archive: { ...base.body.archive, size: archive.length, sha512: sha(archive, "sha512", "base64") } });
    data.archive = archive;
    const storeRoot = path.join(root, `store-${index}`);
    const phases = [];
    const opts = options(storeRoot, data, { ...await archives(root, data), toolsRoot: sourceTools, toolsetManifest, onProgress: ({ phase }) => phases.push(phase) });
    await assert.rejects(prepareApplication(opts));
    assert.deepEqual(phases, []);
    await assert.rejects(lstat(storeRoot), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(root, "escape")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(root, "evil.json")), { code: "ENOENT" });
  }
});

test("tiny integration rejects noncritical extracted hash mismatch and package version mismatch without publishing", async (t) => {
  const toolsetManifest = await toolsOrSkip(t);
  if (!toolsetManifest) return;
  const root = await temporary(t);
  const cases = [
    fixture(toolsetManifest.id, {}, (layout) => { layout.files.at(-1).sha256 = "0".repeat(64); }),
    fixture(toolsetManifest.id, { version: "3.0.0" }),
  ];
  for (let index = 0; index < cases.length; index++) {
    const data = cases[index];
    const storeRoot = path.join(root, `store-${index}`);
    const events = [];
    const opts = options(storeRoot, data, { ...await archives(root, data), toolsRoot: sourceTools, toolsetManifest, onProgress: ({ phase }) => events.push(phase) });
    await assert.rejects(prepareApplication(opts), index === 0 ? /file hash/ : /package version/);
    assert.ok(events.includes("verifying"));
    assert.ok(!events.includes("ready"));
    assert.deepEqual(await readdir(path.join(storeRoot, "versions")), []);
  }
});

test("tiny integration aborts and cleans only its own staging directory, never reporting ready", async (t) => {
  const toolsetManifest = await toolsOrSkip(t);
  if (!toolsetManifest) return;
  const root = await temporary(t);
  const data = fixture(toolsetManifest.id);
  const storeRoot = path.join(root, "store");
  const sentinel = path.join(storeRoot, "versions", ".stage-unrelated");
  await mkdir(sentinel, { recursive: true });
  await writeFile(path.join(sentinel, "keep"), "keep");
  const controller = new AbortController();
  const phases = [];
  const opts = options(storeRoot, data, { ...await archives(root, data), toolsRoot: sourceTools, toolsetManifest, signal: controller.signal, onProgress: ({ phase }) => { phases.push(phase); if (phase === "extracting") controller.abort(); } });
  await assert.rejects(prepareApplication(opts), { name: "AbortError" });
  assert.ok(!phases.includes("ready"));
  assert.deepEqual(await readdir(path.join(storeRoot, "versions")), [".stage-unrelated"]);
  assert.equal(await readFile(path.join(sentinel, "keep"), "utf8"), "keep");
});
