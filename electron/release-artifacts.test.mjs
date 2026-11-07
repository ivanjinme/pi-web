import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { retainDesktopRelease } from "./release.mjs";
import { initializeUpdateSigning, MANIFEST_NAME, readReleaseSigning } from "./update-release.mjs";
import { updateKey, verifyManifest } from "./update-signature.mjs";

const version = "1.2.3";
const installerName = `Weclio-${version}-x64-Setup.exe`;
const blockmapName = `${installerName}.blockmap`;
const retainedNames = [installerName, blockmapName, MANIFEST_NAME, "SHA256SUMS.txt"].sort();
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

function fakeInstaller(marker = "first") {
  // 仅满足 PE 头校验，既不是可运行安装器，也不用于验证真实 NSIS blockmap。
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(80, 60);
  bytes.writeUInt32LE(0x4550, 80);
  return Buffer.concat([bytes, Buffer.from(marker)]);
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "weclio-retention-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  const keyPath = join(base, "external-keys/test.ed25519.pem");
  const output = join(root, "output");
  const dist = join(root, "dist");
  await mkdir(join(root, "electron"), { recursive: true });
  await mkdir(output);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "weclio-retention-test", repository: { url: "https://github.com/test-owner/test-desktop.git" } }));
  await writeFile(join(root, "electron/builder.json"), JSON.stringify({ extraMetadata: { name: "weclio-retention-test" } }));
  await initializeUpdateSigning({ root, keyPath });
  const signing = await readReleaseSigning({ root, keyPath });
  const exe = fakeInstaller();
  const map = Buffer.from("unit-only-blockmap\0first");
  await writeFile(join(output, installerName), exe);
  await writeFile(join(output, blockmapName), map);
  return { base, root, keyPath, output, dist, version, signing, exe, map };
}

async function snapshot(dir) {
  const entries = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    entries.push([entry.name, entry.isDirectory() ? await snapshot(join(dir, entry.name)) : await readFile(join(dir, entry.name))]);
  }
  return entries;
}

async function assertRetained(p, exe = p.exe, map = p.map) {
  assert.deepEqual(await readFile(join(p.dist, installerName)), exe);
  assert.deepEqual(await readFile(join(p.dist, blockmapName)), map);
  const manifest = await readFile(join(p.dist, MANIFEST_NAME));
  const envelope = JSON.parse(manifest);
  const payload = verifyManifest(envelope, updateKey(p.signing.config.publicKey));
  assert.deepEqual(payload, {
    version,
    installable: true,
    files: [{
      url: `https://github.com/test-owner/test-desktop/releases/download/desktop-v${version}/${installerName}`,
      sha512: digest(exe, "sha512", "base64"),
      size: exe.length,
    }],
  });
  const sums = await readFile(join(p.dist, "SHA256SUMS.txt"), "utf8");
  const lines = sums.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const covered = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, "SHA256SUMS must use the standard digest + filename format");
    const [, hash, name] = match;
    covered.push(name);
    assert.equal(hash, digest(await readFile(join(p.dist, name))));
  }
  assert.deepEqual(covered.sort(), [installerName, blockmapName, MANIFEST_NAME].sort());
  const privatePem = await readFile(p.keyPath);
  const privateDer = p.signing.privateKey.export({ format: "der", type: "pkcs8" });
  for (const [, bytes] of await snapshot(p.dist)) {
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.includes(privatePem), false);
    assert.equal(bytes.includes(privateDer), false);
    assert.equal(bytes.includes(Buffer.from("PRIVATE KEY")), false);
    assert.equal(bytes.includes(Buffer.from(p.keyPath)), false);
  }
  assert.equal(Buffer.from(envelope.payload, "base64").includes(privateDer), false);
  assert.ok(!(await readdir(p.dist)).some((name) => name.startsWith(".release-")));
  return manifest;
}

test("retention copies the exact installer pair, runtime-valid signed manifest, and matching checksums only", async (t) => {
  const p = await fixture(t);
  const privateBefore = await readFile(p.keyPath);
  const outputBefore = await snapshot(p.output);
  const result = await retainDesktopRelease(p);
  assert.deepEqual(result, {
    installerPath: join(p.dist, installerName),
    blockmapPath: join(p.dist, blockmapName),
    manifestPath: join(p.dist, MANIFEST_NAME),
    sha256: digest(p.exe),
  });
  assert.deepEqual((await readdir(p.dist)).sort(), retainedNames);
  await assertRetained(p);
  assert.deepEqual(await snapshot(p.output), outputBefore);
  assert.deepEqual(await readFile(p.keyPath), privateBefore);
});

for (const failure of ["missing blockmap", "empty blockmap", "mispaired blockmap", "blockmap directory", "plain text installer", "bad PE signature", "wrong signing key"]) {
  test(`retention rejects ${failure} before changing existing dist bytes`, async (t) => {
    const p = await fixture(t);
    await retainDesktopRelease(p);
    await writeFile(join(p.dist, "unrelated.txt"), "keep me");
    const before = await snapshot(p.dist);
    // 使用不同的新 EXE，确保失败路径不会提前替换既有安装包。
    await writeFile(join(p.output, installerName), fakeInstaller("must not be retained"));
    const blockmap = join(p.output, blockmapName);
    let expected;
    if (failure === "missing blockmap") {
      await rm(blockmap);
      expected = { code: "ENOENT" };
    } else if (failure === "empty blockmap") {
      await writeFile(blockmap, "");
      expected = /nonempty regular/;
    } else if (failure === "mispaired blockmap") {
      await rename(blockmap, join(p.output, "Weclio-1.2.4-x64-Setup.exe.blockmap"));
      expected = { code: "ENOENT" };
    } else if (failure === "blockmap directory") {
      await rm(blockmap);
      await mkdir(blockmap);
      expected = /nonempty regular/;
    } else if (failure === "plain text installer") {
      await writeFile(join(p.output, installerName), "not a Windows executable");
      expected = /PE/;
    } else if (failure === "bad PE signature") {
      const bytes = fakeInstaller();
      bytes.writeUInt32LE(0, 80);
      await writeFile(join(p.output, installerName), bytes);
      expected = /PE/;
    } else {
      const other = await fixture(t);
      p.signing = { ...p.signing, privateKey: other.signing.privateKey };
      expected = /does not match/;
    }
    await assert.rejects(retainDesktopRelease(p), expected);
    assert.deepEqual(await snapshot(p.dist), before);
  });
}

test("a repeated successful retention replaces the complete pair and manifest without deleting unrelated or older assets", async (t) => {
  const p = await fixture(t);
  await retainDesktopRelease(p);
  const firstManifest = await assertRetained(p);
  const firstSums = await readFile(join(p.dist, "SHA256SUMS.txt"));
  const preserved = [
    ["Weclio-1.2.2-x64-Setup.exe", Buffer.from("old installer")],
    ["Weclio-1.2.2-x64-Setup.exe.blockmap", Buffer.from("old blockmap")],
    ["notes.txt", Buffer.from("unrelated release notes")],
  ];
  for (const [name, bytes] of preserved) await writeFile(join(p.dist, name), bytes);
  const exe = fakeInstaller("second build with changed length");
  const map = Buffer.from("unit-only-blockmap\0second-build");
  await writeFile(join(p.output, installerName), exe);
  await writeFile(join(p.output, blockmapName), map);
  const result = await retainDesktopRelease(p);
  assert.equal(result.sha256, digest(exe));
  assert.notEqual(result.sha256, digest(p.exe));
  assert.notEqual(digest(map), digest(p.map));
  const nextManifest = await assertRetained(p, exe, map);
  assert.notDeepEqual(nextManifest, firstManifest);
  assert.notDeepEqual(await readFile(join(p.dist, "SHA256SUMS.txt")), firstSums);
  for (const [name, bytes] of preserved) assert.deepEqual(await readFile(join(p.dist, name)), bytes);
  assert.deepEqual((await readdir(p.dist)).sort(), [...retainedNames, ...preserved.map(([name]) => name)].sort());
});

test("importing release does not execute the CLI, emit output, or write files", async (t) => {
  const p = await fixture(t);
  const before = await snapshot(p.base);
  const exec = promisify(execFile);
  const result = await exec(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./release.mjs", import.meta.url).href)})`], {
    cwd: p.root,
    env: { ...process.env, WECLIO_DESKTOP_SIGNING_KEY: p.keyPath },
    timeout: 30_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(await snapshot(p.base), before);
});
