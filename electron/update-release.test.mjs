import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_KEY_PATH, MANIFEST_NAME, initializeUpdateSigning, prepareSignedUpdate, readReleaseSigning, validateInstaller } from "./update-release.mjs";
import { updateKey, verifyManifest } from "./update-signature.mjs";

async function project(t, extraMetadata = {}) {
  const base = await mkdtemp(join(tmpdir(), "weclio-signing-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  const keyPath = join(base, "keys/key.pem");
  await mkdir(join(root, "electron"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@weclio/pi-web", repository: { url: "git+https://github.com/ivanjinme/pi-web.git" } }));
  await writeFile(join(root, "electron/builder.json"), JSON.stringify({ extraMetadata }));
  return { base, root, keyPath, configPath: join(root, "resources/desktop-update.json") };
}

function pem(type = "ed25519") {
  return generateKeyPairSync(type, type === "rsa" ? { modulusLength: 1024 } : {}).privateKey.export({ format: "pem", type: "pkcs8" });
}

async function putKey(keyPath, value = pem()) {
  await mkdir(resolve(keyPath, ".."), { recursive: true });
  await writeFile(keyPath, value);
}

async function output(root, version = "1.2.3") {
  const installerPath = join(root, `Weclio-${version}-x64-Setup.exe`);
  const blockmapPath = `${installerPath}.blockmap`;
  const bytes = Buffer.alloc(256, 7);
  bytes.write("MZ", 0);
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  await writeFile(installerPath, bytes);
  await writeFile(blockmapPath, "blockmap-output");
  return { installerPath, blockmapPath, version };
}
const digest = (bytes, algorithm, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

test("initialization is idempotent, public only, and uses packager name not product name", async (t) => {
  const p = await project(t);
  const first = await initializeUpdateSigning(p);
  assert.equal(first.created, true);
  assert.equal(first.keyPath, p.keyPath);
  assert.equal(first.configPath, p.configPath);
  assert.notEqual(p.keyPath, DEFAULT_KEY_PATH);
  const secret = await readFile(p.keyPath, "utf8");
  const original = await readFile(p.configPath, "utf8");
  const config = JSON.parse(original);
  assert.equal(config.manifestUrl, `https://github.com/ivanjinme/pi-web/releases/latest/download/${MANIFEST_NAME}`);
  assert.equal(config.updaterCacheDirName, "@wecliopi-web-updater");
  assert.match(config.publicKey, /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(!original.includes("PRIVATE KEY"));
  assert.ok(!original.includes(secret));
  if (process.platform !== "win32") assert.equal((await stat(p.keyPath)).mode & 0o777, 0o600);
  assert.equal((await initializeUpdateSigning(p)).created, false);
  assert.equal(await readFile(p.keyPath, "utf8"), secret);
  assert.equal(await readFile(p.configPath, "utf8"), original);
  assert.equal((await readReleaseSigning(p)).privateKey.asymmetricKeyType, "ed25519");
});

test("extraMetadata.name controls the exact builder cache name", async (t) => {
  const p = await project(t, { name: "Custom/APP:Name", productName: "Ignored" });
  await initializeUpdateSigning(p);
  assert.equal((await readReleaseSigning(p)).config.updaterCacheDirName, "customappname-updater");
});

test("existing external Ed25519 key is reused without regeneration", async (t) => {
  const p = await project(t);
  const key = pem();
  await putKey(p.keyPath, key);
  assert.equal((await initializeUpdateSigning(p)).created, false);
  assert.deepEqual(await readFile(p.keyPath), Buffer.from(key));
});

test("environment may select an absolute external key path", async (t) => {
  const p = await project(t);
  const saved = process.env.WECLIO_DESKTOP_SIGNING_KEY;
  process.env.WECLIO_DESKTOP_SIGNING_KEY = p.keyPath;
  try {
    assert.equal((await initializeUpdateSigning({ root: p.root })).keyPath, p.keyPath);
    assert.equal((await readReleaseSigning({ root: p.root })).keyPath, p.keyPath);
  } finally {
    if (saved === undefined) delete process.env.WECLIO_DESKTOP_SIGNING_KEY;
    else process.env.WECLIO_DESKTOP_SIGNING_KEY = saved;
  }
});

test("config with a missing key fails closed and asks for backup restore", async (t) => {
  const p = await project(t);
  await initializeUpdateSigning(p);
  const config = await readFile(p.configPath);
  await rm(p.keyPath);
  await assert.rejects(initializeUpdateSigning(p), /restore.*backup/i);
  await assert.rejects(readReleaseSigning(p), /restore.*backup/i);
  await assert.rejects(stat(p.keyPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(p.configPath), config);
});

test("absent configuration fails signing preflight without writes", async (t) => {
  const p = await project(t);
  await assert.rejects(readReleaseSigning(p), /config is missing/);
  await assert.rejects(stat(p.keyPath), { code: "ENOENT" });
});

test("wrong key and config metadata changes cannot be silently overwritten", async (t) => {
  const p = await project(t);
  await initializeUpdateSigning(p);
  const originalKey = await readFile(p.keyPath);
  const original = await readFile(p.configPath, "utf8");
  await putKey(p.keyPath);
  for (const method of [initializeUpdateSigning, readReleaseSigning]) await assert.rejects(method(p), /does not match/);
  assert.equal(await readFile(p.configPath, "utf8"), original);
  await putKey(p.keyPath, originalKey);
  for (const change of [
    { manifestUrl: `https://evil.example/releases/latest/download/${MANIFEST_NAME}` },
    { manifestUrl: `https://github.com/other/repo/releases/latest/download/${MANIFEST_NAME}` },
    { manifestUrl: `https://github.com/ivanjinme/pi-web/releases/latest/download/${MANIFEST_NAME}?x=1` },
    { updaterCacheDirName: "wrong-updater" },
    { publicKey: originalKey.toString() },
  ]) {
    const changed = JSON.stringify({ ...JSON.parse(original), ...change });
    await writeFile(p.configPath, changed);
    for (const method of [initializeUpdateSigning, readReleaseSigning]) await assert.rejects(method(p), /does not match/);
    assert.equal(await readFile(p.configPath, "utf8"), changed);
  }
});

test("corrupt and non-Ed25519 keys are never replaced or echoed", async (t) => {
  const p = await project(t);
  for (const key of ["-----BEGIN PRIVATE KEY-----\nsecret-material\n", pem("rsa")]) {
    await putKey(p.keyPath, key);
    await assert.rejects(initializeUpdateSigning(p), (error) => {
      assert.match(error.message, /Ed25519/);
      assert.ok(!error.message.includes("PRIVATE KEY"));
      assert.ok(!error.message.includes("secret-material"));
      return true;
    });
    assert.deepEqual(await readFile(p.keyPath), Buffer.from(key));
    await assert.rejects(stat(p.configPath), { code: "ENOENT" });
  }
});

test("private paths must be absolute and outside lexical and real repository paths", async (t) => {
  const p = await project(t);
  for (const keyPath of ["relative.pem", join(p.root, "key.pem"), join(p.root, "electron/../key.pem")]) {
    await assert.rejects(initializeUpdateSigning({ ...p, keyPath }), /outside|absolute/);
  }
  const alias = join(p.base, "repo-alias");
  try { await symlink(p.root, alias, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
    if (error.code === "EPERM") { t.diagnostic("Directory symlinks unavailable; lexical checks passed"); return; }
    throw error;
  }
  await assert.rejects(initializeUpdateSigning({ ...p, keyPath: join(alias, "new/sub/key.pem") }), /outside/);
  await putKey(join(p.root, "existing.pem"));
  await assert.rejects(readReleaseSigning({ ...p, keyPath: join(alias, "existing.pem") }), /outside/);
  const externalAlias = join(p.root, "external-alias");
  await mkdir(join(p.base, "outside"));
  await symlink(join(p.base, "outside"), externalAlias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(initializeUpdateSigning({ ...p, keyPath: join(externalAlias, "key.pem") }), /outside/);
  if (process.platform === "win32") await assert.rejects(initializeUpdateSigning({ ...p, keyPath: join(p.root.toUpperCase(), "key.pem") }), /outside/);
});

test("signed payload verifies with runtime and hashes the actual installer and sidecar", async (t) => {
  const p = await project(t);
  await initializeUpdateSigning(p);
  const signing = await readReleaseSigning(p);
  const files = await output(p.root);
  const first = await prepareSignedUpdate({ ...files, signing });
  assert.equal(first.manifestName, MANIFEST_NAME);
  const envelope = JSON.parse(first.manifest);
  const payload = verifyManifest(envelope, updateKey(signing.config.publicKey));
  const bytes = await readFile(files.installerPath);
  assert.equal(first.sha256, digest(bytes, "sha256"));
  assert.equal(first.sha256, await validateInstaller(files.installerPath));
  assert.equal(first.sha512, digest(bytes, "sha512", "base64"));
  assert.equal(first.blockmapSha256, digest(await readFile(files.blockmapPath), "sha256"));
  assert.deepEqual(payload, { version: "1.2.3", installable: true, files: [{ url: "https://github.com/ivanjinme/pi-web/releases/download/desktop-v1.2.3/Weclio-1.2.3-x64-Setup.exe", sha512: first.sha512, size: bytes.length }] });
  assert.ok(!first.manifest.includes("PRIVATE KEY"));
  assert.ok(!Buffer.from(envelope.payload, "base64").toString().includes("PRIVATE KEY"));
  bytes[100] ^= 1;
  await writeFile(files.installerPath, Buffer.concat([bytes, Buffer.from("new-build")]));
  await writeFile(files.blockmapPath, "new-map");
  const next = await prepareSignedUpdate({ ...files, signing });
  assert.notEqual(next.sha256, first.sha256);
  assert.notEqual(next.sha512, first.sha512);
  assert.notEqual(next.blockmapSha256, first.blockmapSha256);
  assert.equal(next.size, bytes.length + 9);
  assert.equal(next.sha256, digest(await readFile(files.installerPath), "sha256"));
  verifyManifest(JSON.parse(next.manifest), updateKey(signing.config.publicKey));
});

test("only stable semver, expected filenames and paired nonempty blockmaps may be signed", async (t) => {
  const p = await project(t);
  await initializeUpdateSigning(p);
  const signing = await readReleaseSigning(p);
  const files = await output(p.root);
  for (const version of ["1.2.3-beta", "01.2.3", "1.2", "1.2.3+meta", "9007199254740992.0.0", null]) {
    await assert.rejects(prepareSignedUpdate({ ...files, signing, version }), /stable semver/);
  }
  await assert.rejects(prepareSignedUpdate({ ...files, signing, installerPath: join(p.root, "other.exe") }), /expected names/);
  await assert.rejects(prepareSignedUpdate({ ...files, signing, blockmapPath: join(p.root, "wrong.blockmap") }), /expected names/);
  const other = join(p.base, "other");
  await mkdir(other);
  await writeFile(join(other, "Weclio-1.2.3-x64-Setup.exe.blockmap"), "map");
  await assert.rejects(prepareSignedUpdate({ ...files, signing, blockmapPath: join(other, "Weclio-1.2.3-x64-Setup.exe.blockmap") }), /same output directory/);
  await rm(files.blockmapPath);
  await assert.rejects(prepareSignedUpdate({ ...files, signing }), { code: "ENOENT" });
  await writeFile(files.blockmapPath, "");
  await assert.rejects(prepareSignedUpdate({ ...files, signing }), /nonempty regular/);
  await rm(files.blockmapPath);
  await mkdir(files.blockmapPath);
  await assert.rejects(prepareSignedUpdate({ ...files, signing }), /nonempty regular/);
});

test("plain text fixtures, invalid PE headers, and mismatched signing keys are rejected", async (t) => {
  const p = await project(t);
  await initializeUpdateSigning(p);
  const signing = await readReleaseSigning(p);
  const files = await output(p.root);
  await assert.rejects(prepareSignedUpdate({ ...files, signing: { ...signing, privateKey: generateKeyPairSync("ed25519").privateKey } }), /does not match/);
  await assert.rejects(prepareSignedUpdate({ ...files, signing: { ...signing, config: { ...signing.config, manifestUrl: "https://example.com/manifest.json" } } }), /Invalid GitHub/);
  await writeFile(files.installerPath, "plaintext fixture installer");
  await assert.rejects(prepareSignedUpdate({ ...files, signing }), /PE/);
  for (const offset of [64, 255, 9999]) {
    const bytes = Buffer.alloc(256);
    bytes.write("MZ");
    bytes.writeUInt32LE(offset, 60);
    await writeFile(files.installerPath, bytes);
    await assert.rejects(validateInstaller(files.installerPath), /PE/);
  }
});

test("CLI only accepts --init; importing the helper has no side effects", async (t) => {
  const p = await project(t);
  const file = fileURLToPath(new URL("./update-release.mjs", import.meta.url));
  const exec = promisify(execFile);
  for (const args of [[], ["--sign"], ["--init", "--extra"]]) {
    await assert.rejects(exec(process.execPath, [file, ...args], { env: { ...process.env, WECLIO_DESKTOP_SIGNING_KEY: p.keyPath } }), (error) => {
      assert.match(error.stderr, /Usage:/);
      assert.ok(!error.stderr.includes("PRIVATE KEY"));
      return true;
    });
  }
  const imported = await exec(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./update-release.mjs", import.meta.url).href)})`], { env: { ...process.env, WECLIO_DESKTOP_SIGNING_KEY: p.keyPath } });
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  await assert.rejects(stat(p.keyPath), { code: "ENOENT" });
});
