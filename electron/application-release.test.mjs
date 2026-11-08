import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createShellDescriptor, prepareApplicationRelease } from "./application-release.mjs";
import { compatibleApplication, validateLayout, verifyApplicationManifest } from "./application-manifest.mjs";

const shell = { schema: 1, version: "1.0.0", digest: "a".repeat(64), toolset: "b".repeat(64) };
const sha = (value, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(value).digest(encoding);

async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "application-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function shellFixture(t) {
  const root = await fixture(t);
  await put(root, "package.json", { version: "2.0.0", dependencies: { "electron-updater": "6.6.2" }, devDependencies: { electron: "45.2.1" } });
  await put(root, "electron/builder.json", { files: ["electron/main.mjs", "!node_modules/**/*"] });
  await put(root, "electron/main.mjs", "export const shell = 1;");
  await put(root, "resources/desktop-update.json", { publicKey: "test-trust" });
  await put(root, "bin/node-version.js", "module.exports = 22;");
  await put(root, "app/page.tsx", "application source");
  await put(root, "node_modules/electron-updater/package.json", { name: "electron-updater", version: "6.6.2", dependencies: { helper: "^1.0.0" } });
  await put(root, "node_modules/electron-updater/index.js", "updater");
  await put(root, "node_modules/helper/package.json", { name: "helper", version: "1.0.1", dependencies: { leaf: "1.0.0" } });
  await put(root, "node_modules/helper/index.js", "helper");
  await put(root, "node_modules/leaf/package.json", { name: "leaf", version: "1.0.0", dependencies: { helper: "^1.0.0" } });
  await put(root, "node_modules/leaf/index.js", "leaf");
  return root;
}

async function releaseFixture(t) {
  const root = await fixture(t);
  const serverRoot = join(root, "server");
  const output = join(root, "out");
  await put(serverRoot, "package.json", { version: "2.0.0" });
  for (const path of ["next.config.js", "desktop-packages.mjs", ".next/BUILD_ID", ".next/required-server-files.json", "node_modules/next/dist/bin/next", "public/hello world.txt", "public/world.map", "LICENSE"]) await put(serverRoot, path, path);
  for (const path of [".next/cache/file", ".next/trace", ".next/trace-build", ".next/server/page.js.nft.json", ".next/server/page.js.map", "node_modules/next/index.cjs.map", "public/a.CSS.MAP", "app/source.ts", ".env", "electron/main.mjs"]) await put(serverRoot, path, "excluded");
  await mkdir(join(serverRoot, "public/empty"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signing = { privateKey, config: { manifestUrl: "https://github.com/owner/repository/releases/latest/download/desktop-update-manifest.json", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() } };
  // 只验证生产器协议；这些字节不是 ZIP，不代表真实 ZIP 语义测试。
  const createZip = async ({ archivePath, files, listPath }) => {
    assert.equal(await readFile(listPath, "utf8"), files.join("\n") + "\n");
    assert.equal(files.includes("public/empty"), false);
    await writeFile(archivePath, "unit-test archive bytes", { flag: "wx" });
  };
  return { serverRoot, output, version: "2.0.0", shell, signing, createZip };
}

test("shell fingerprint excludes app source/version and unrelated dependencies", async (t) => {
  const root = await shellFixture(t);
  const options = { root, version: shell.version, toolset: shell.toolset };
  const initial = await createShellDescriptor(options);
  assert.deepEqual(initial, { schema: 1, version: shell.version, digest: initial.digest, toolset: shell.toolset });
  assert.match(initial.digest, /^[a-f0-9]{64}$/);
  await put(root, "app/page.tsx", "new application");
  const pkg = JSON.parse(await readFile(join(root, "package.json")));
  await put(root, "package.json", { ...pkg, version: "99.0.0" });
  await put(root, "node_modules/unrelated/index.js", "unrelated");
  await put(root, "node_modules/leaf/index.js.map", "ignored map");
  assert.deepEqual(await createShellDescriptor(options), initial);
  assert.equal((await createShellDescriptor({ ...options, version: "1.0.1" })).digest, initial.digest);
  assert.equal((await createShellDescriptor({ ...options, toolset: "c".repeat(64) })).digest, initial.digest);
});

test("every stable shell/trust/config/helper/Electron and transitive updater input is bound", async (t) => {
  const root = await shellFixture(t);
  const options = { root, version: shell.version, toolset: shell.toolset };
  let previous = (await createShellDescriptor(options)).digest;
  for (const path of ["electron/main.mjs", "resources/desktop-update.json", "bin/node-version.js", "node_modules/electron-updater/index.js", "node_modules/helper/index.js", "node_modules/leaf/index.js"]) {
    await put(root, path, "changed " + path);
    const next = (await createShellDescriptor(options)).digest;
    assert.notEqual(next, previous, path);
    previous = next;
  }
  const builder = await readFile(join(root, "electron/builder.json"), "utf8");
  await put(root, "electron/builder.json", builder + "\n");
  assert.notEqual((await createShellDescriptor(options)).digest, previous);
  previous = (await createShellDescriptor(options)).digest;
  const pkg = JSON.parse(await readFile(join(root, "package.json")));
  await put(root, "package.json", { ...pkg, devDependencies: { electron: "45.2.2" } });
  assert.notEqual((await createShellDescriptor(options)).digest, previous);
});

test("shell descriptor rejects unsafe inputs, missing closure and links", async (t) => {
  const root = await shellFixture(t);
  const options = { root, version: shell.version, toolset: shell.toolset };
  for (const patch of [{ version: "1.0.0-beta" }, { version: "01.0.0" }, { toolset: "A".repeat(64) }, { toolset: "bad" }]) await assert.rejects(createShellDescriptor({ ...options, ...patch }));
  await put(root, "electron/builder.json", { files: ["../outside"] });
  await assert.rejects(createShellDescriptor(options), /outside/);
  await put(root, "electron/builder.json", { files: ["electron/*.mjs"] });
  await assert.rejects(createShellDescriptor(options), /exact paths/);
  await put(root, "electron/builder.json", { files: ["electron/link/main.mjs"] });
  await symlink(join(root, "electron"), join(root, "electron/link"), "junction");
  await assert.rejects(createShellDescriptor(options), /links/);
  await put(root, "electron/builder.json", { files: ["electron/main.mjs"] });
  await rm(join(root, "node_modules/leaf"), { recursive: true });
  await assert.rejects(createShellDescriptor(options), /Missing updater dependency/);
});

test("shell closure follows package-local dependencies and rejects external linked dependencies", async (t) => {
  const root = await shellFixture(t);
  const options = { root, version: shell.version, toolset: shell.toolset };
  const nested = "node_modules/electron-updater/node_modules/helper";
  await put(root, `${nested}/package.json`, { name: "helper", version: "1.0.2" });
  await put(root, `${nested}/index.js`, "local helper");
  const initial = await createShellDescriptor(options);
  await put(root, "node_modules/helper/index.js", "unused hoisted helper");
  assert.deepEqual(await createShellDescriptor(options), initial);
  await put(root, `${nested}/index.js`, "changed local helper");
  assert.notEqual((await createShellDescriptor(options)).digest, initial.digest);
  const outside = await fixture(t);
  await put(outside, "package.json", { name: "helper", version: "1.0.2" });
  await rm(join(root, nested), { recursive: true });
  await symlink(outside, join(root, nested), "junction");
  await assert.rejects(createShellDescriptor(options), /links/);
});

test("producer signs hashes, versioned artifact URLs and exact filtered regular-file layout", async (t) => {
  const options = await releaseFixture(t);
  const result = await prepareApplicationRelease(options);
  assert.deepEqual(result.files, ["Weclio-2.0.0-x64-Application.zip", "Weclio-2.0.0-x64-Application.files.json", "desktop-application-manifest.json"]);
  assert.deepEqual((await readdir(options.output)).sort(), [...result.files].sort());
  const envelope = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.deepEqual(envelope, result.manifestEnvelope);
  const release = verifyApplicationManifest(envelope, options.signing.config.publicKey);
  const archive = await readFile(result.archivePath);
  const layoutBytes = await readFile(result.layoutPath);
  assert.equal(release.archive.sha512, sha(archive, "sha512", "base64"));
  assert.equal(release.archive.size, archive.length);
  assert.equal(release.layout.sha512, sha(layoutBytes, "sha512", "base64"));
  assert.equal(release.layout.size, layoutBytes.length);
  assert.equal(release.archive.url, "https://github.com/owner/repository/releases/download/desktop-v2.0.0/Weclio-2.0.0-x64-Application.zip");
  assert.equal(release.layout.url, release.archive.url.replace(/\.zip$/, ".files.json"));
  const layout = validateLayout(JSON.parse(layoutBytes), release);
  assert.equal(layout.files.length, 9);
  for (const entry of layout.files) {
    const bytes = await readFile(join(options.serverRoot, entry.path));
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, sha(bytes));
  }
  assert.equal(compatibleApplication(release, shell), true);
  assert.equal(compatibleApplication(release, { ...shell, digest: "c".repeat(64) }), false);
  assert.equal(compatibleApplication(release, { ...shell, toolset: "c".repeat(64) }), false);
  await assert.rejects(prepareApplicationRelease(options), /already exists/);
  assert.deepEqual(await readFile(result.archivePath), archive);
});

test("producer rejects version, signing, descriptor and URL mistakes before archiving", async (t) => {
  const options = await releaseFixture(t);
  let called = false;
  const createZip = async () => { called = true; };
  for (const patch of [
    { version: "2.0.1" }, { version: "2.0.0-rc" }, { shell: { ...shell, schema: 2 } },
    { shell: { ...shell, digest: "bad" } }, { shell: { ...shell, extra: true } },
    { signing: { ...options.signing, privateKey: generateKeyPairSync("ed25519").privateKey } },
    ...["http://github.com/owner/repository/releases/latest/download/desktop-update-manifest.json", "https://github.com/../repository/releases/latest/download/desktop-update-manifest.json", options.signing.config.manifestUrl + "?token=x"].map((manifestUrl) => ({ signing: { ...options.signing, config: { ...options.signing.config, manifestUrl } } })),
  ]) await assert.rejects(prepareApplicationRelease({ ...options, ...patch, createZip }));
  assert.equal(called, false);
  await assert.rejects(prepareApplicationRelease({ ...options, output: join(options.serverRoot, "public/output") }), /outside server/);
});

test("producer refuses links, invalid runtime paths, changed inputs, absent CLI and collisions", async (t) => {
  const options = await releaseFixture(t);
  await symlink(join(options.serverRoot, "node_modules/next"), join(options.serverRoot, "public/link"), "junction");
  await assert.rejects(prepareApplicationRelease(options), /links/);
  await rm(join(options.serverRoot, "public/link"), { recursive: true });
  await put(options.serverRoot, "public/CON.txt", "unsafe Windows path");
  await assert.rejects(prepareApplicationRelease(options), /path segment/);
  await rm(join(options.serverRoot, "public/CON.txt"));
  await assert.rejects(prepareApplicationRelease({ ...options, createZip: undefined }), /explicit local 7za/);
  await assert.rejects(prepareApplicationRelease({ ...options, createZip: async (args) => { await options.createZip(args); await put(options.serverRoot, "LICENSE", "changed"); } }), /changed while archiving/);
  assert.deepEqual(await readdir(options.output), []);
  await put(options.output, "Weclio-2.0.0-x64-Application.files.json", "existing artifact");
  await assert.rejects(prepareApplicationRelease(options), /already exists/);
  assert.equal(await readFile(join(options.output, "Weclio-2.0.0-x64-Application.files.json"), "utf8"), "existing artifact");
});

test("import has no CLI, output or key-read side effects", () => {
  const script = `import { syncBuiltinESMExports } from 'node:module'; import fs from 'node:fs/promises'; for (const key of ['readFile','writeFile','mkdir','mkdtemp','readdir','lstat','realpath']) fs[key] = () => { throw new Error('import side effect: ' + key); }; syncBuiltinESMExports(); await import(${JSON.stringify(new URL("./application-release.mjs", import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
