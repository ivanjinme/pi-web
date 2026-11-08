import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { APPLICATION_MANIFEST_NAME, APPLICATION_PROTOCOL, APPLICATION_STARTUP_FILES, LIMITS, applicationManifestUrl, compareVersions, compatibleApplication, isStableVersion, validateLayout, verifyApplicationManifest } from "./application-manifest.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const digest = "a".repeat(64);
const sha512 = Buffer.alloc(64, 1).toString("base64");
const required = ["package.json", "next.config.js", "desktop-packages.mjs", ".next/BUILD_ID", ".next/required-server-files.json", "node_modules/next/dist/bin/next"];

function body() {
  return {
    schema: 1, type: "weclio-application", version: "2.0.0", platform: "win32", arch: "x64",
    shell: { version: "1.0.0", digest }, toolset: digest,
    archive: { url: "https://updates.example/releases/app.zip", size: 100, sha512 },
    layout: { url: "https://updates.example/releases/layout.json", size: 100, sha512, fileCount: required.length, bytes: required.length },
  };
}

function envelope(value, raw) {
  const payload = raw ?? Buffer.from(JSON.stringify(value));
  return { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") };
}

function layout(extra = []) {
  return { schema: 1, files: [...required, ...extra].map((path) => ({ path, size: 1, sha256: digest })) };
}

function releaseFor(value) {
  return { layout: { fileCount: value.files.length, bytes: value.files.reduce((sum, file) => sum + file.size, 0) } };
}

function rejectLayout(value) {
  assert.throws(() => validateLayout(value, releaseFor(value)));
}

test("protocol constants and canonical stable versions", () => {
  assert.equal(APPLICATION_MANIFEST_NAME, "desktop-application-manifest.json");
  assert.equal(APPLICATION_PROTOCOL, 1);
  assert.equal(Object.isFrozen(APPLICATION_STARTUP_FILES), true);
  assert.deepEqual(APPLICATION_STARTUP_FILES, required);
  assert.deepEqual(LIMITS, { manifestBytes: 65536, layoutBytes: 16 * 1024 * 1024, archiveBytes: 2 * 1024 ** 3, expandedBytes: 4 * 1024 ** 3, files: 100000 });
  for (const value of ["0.0.0", "1.2.3", "9007199254740991.0.0"]) assert.equal(isStableVersion(value), true);
  for (const value of [null, 123, "1.2", "01.2.3", "1.2.03", "v1.2.3", "1.2.3-rc", "1.2.3+build", "1.2.3\n", " 1.2.3", "9007199254740992.0.0"]) {
    assert.equal(isStableVersion(value), false, String(value));
    assert.throws(() => compareVersions(value, "1.0.0"));
  }
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.9", "1.2.10"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.99"), 1);
});

test("signed application body returns only normalized fields and raw-payload identity", () => {
  const value = body();
  const signed = envelope(value);
  const result = verifyApplicationManifest(signed, publicKey);
  assert.deepEqual(result, { ...value, id: createHash("sha256").update(Buffer.from(signed.payload, "base64")).digest("hex") });
  const spaced = envelope(null, Buffer.from(JSON.stringify(value, null, 2)));
  assert.notEqual(verifyApplicationManifest(spaced, publicKey).id, result.id);
  const pem = publicKey.export({ type: "spki", format: "pem" });
  assert.deepEqual(verifyApplicationManifest(signed, pem), result);
});

test("signature and canonical base64 are checked before trusting JSON", () => {
  const signed = envelope(body());
  const other = generateKeyPairSync("ed25519").publicKey;
  assert.throws(() => verifyApplicationManifest(signed, other), /signature/);
  assert.throws(() => verifyApplicationManifest({ ...signed, payload: Buffer.from("not JSON").toString("base64") }, publicKey), /signature/);
  for (const field of ["payload", "signature"]) {
    for (const bad of ["", "%%%", "YQ", "YR==", signed[field] + "\n", signed[field] + "=", null, 3]) {
      assert.throws(() => verifyApplicationManifest({ ...signed, [field]: bad }, publicKey));
    }
  }
  assert.throws(() => verifyApplicationManifest({ ...signed, signature: Buffer.alloc(63).toString("base64") }, publicKey));
  assert.throws(() => verifyApplicationManifest({ ...signed, extra: true }, publicKey));
  for (const value of [null, [], {}, { signature: signed.signature }]) assert.throws(() => verifyApplicationManifest(value, publicKey));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
  assert.throws(() => verifyApplicationManifest(signed, rsa), /signature/);
  assert.throws(() => verifyApplicationManifest(envelope(null, Buffer.from([0xff])), publicKey));
  assert.throws(() => verifyApplicationManifest(envelope(null, Buffer.from("{")), publicKey));
});

test("application schemas reject legacy EXE, unknown fields, platform and protocol changes", () => {
  const mutations = [
    (v) => { v.schema = 2; }, (v) => { v.schema = "1"; },
    (v) => { v.type = "desktop-update"; }, (v) => { v.platform = "linux"; },
    (v) => { v.arch = "arm64"; }, (v) => { delete v.platform; },
    (v) => { v.version = "01.0.0"; }, (v) => { v.shell.version = "1.0.0-beta"; },
    (v) => { v.shell.digest = "A".repeat(64); }, (v) => { v.toolset = "a".repeat(63); },
    (v) => { v.shell = null; }, (v) => { v.shell.extra = 1; },
    (v) => { v.files = []; }, (v) => { v.path = "app.exe"; },
    (v) => { v.archive.url = "https://updates.example/app.exe"; },
    (v) => { v.layout.url = "https://updates.example/app.zip"; },
    (v) => { v.archive.extra = "ignored"; }, (v) => { v.layout.extra = "ignored"; },
    (v) => { v["__proto__"] = null; Object.defineProperty(v, "constructor", { value: {}, enumerable: true }); },
  ];
  for (const mutate of mutations) {
    const value = body();
    mutate(value);
    assert.throws(() => verifyApplicationManifest(envelope(value), publicKey), mutate.toString());
  }
  assert.throws(() => verifyApplicationManifest(envelope({ version: "1.0.0", files: [{ url: "https://updates.example/app.exe", size: 1, sha512 }] }), publicKey));
});

test("manifest hashes, payload and archive/layout limits are bounded", () => {
  for (const [field, property, values] of [
    ["archive", "size", [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER, LIMITS.archiveBytes + 1]],
    ["layout", "size", [0, LIMITS.layoutBytes + 1]],
    ["layout", "fileCount", [0, LIMITS.files + 1, 1.5]],
    ["layout", "bytes", [0, LIMITS.expandedBytes + 1, Number.MAX_SAFE_INTEGER]],
    ["archive", "sha512", ["a".repeat(128), Buffer.alloc(63).toString("base64"), sha512.slice(0, -2), sha512 + "\n"]],
    ["layout", "sha512", [null, "bad"]],
  ]) {
    for (const invalid of values) {
      const value = body();
      value[field][property] = invalid;
      assert.throws(() => verifyApplicationManifest(envelope(value), publicKey));
    }
  }
  const value = body();
  value.archive.size = LIMITS.archiveBytes;
  value.layout.size = LIMITS.layoutBytes;
  value.layout.fileCount = LIMITS.files;
  value.layout.bytes = LIMITS.expandedBytes;
  verifyApplicationManifest(envelope(value), publicKey);
  const text = JSON.stringify(body());
  const maximum = Buffer.from(text + " ".repeat(LIMITS.manifestBytes - Buffer.byteLength(text)));
  verifyApplicationManifest(envelope(null, maximum), publicKey);
  assert.throws(() => verifyApplicationManifest(envelope(null, Buffer.concat([maximum, Buffer.from(" ")])), publicKey));
});

test("application artifact URLs require HTTPS except explicit IPv4 fixtures", () => {
  for (const url of ["http://updates.example/app.zip", "http://localhost/app.zip", "http://[::1]/app.zip", "file:///app.zip", "https://user:pass@updates.example/app.zip", "https://updates.example/app.zip#fragment"]) {
    const value = body();
    value.archive.url = url;
    assert.throws(() => verifyApplicationManifest(envelope(value), publicKey, true), url);
  }
  const value = body();
  value.archive.url = "http://127.0.0.1:1234/app.zip";
  value.layout.url = "http://127.0.0.1:1234/layout.json";
  assert.throws(() => verifyApplicationManifest(envelope(value), publicKey));
  assert.equal(verifyApplicationManifest(envelope(value), publicKey, true).archive.url, value.archive.url);
});

test("layout normalizes ordering without mutation or extra computed fields", () => {
  const value = layout(["LICENSE", "public/image.png", "node_modules/pkg/world.map", ".next/server/app/page.js"]);
  const before = structuredClone(value);
  const result = validateLayout(value, releaseFor(value));
  assert.deepEqual(Object.keys(result), ["schema", "files"]);
  assert.deepEqual(result.files.map((entry) => entry.path), [...before.files.map((entry) => entry.path)].sort());
  assert.deepEqual(value, before);
  result.files[0].size = 99;
  assert.deepEqual(value, before);
  value.files.push({ path: "public/empty", size: 0, sha256: digest });
  validateLayout(value, releaseFor(value));
});

test("layout rejects unsafe Windows paths, deployment exclusions and invalid roots", () => {
  for (const path of [
    "/public/a", "C:/public/a", "public\\a", "public/../a", "public/./a", "public//a", "public/a/", "public/a\n", "public/a\u0000", "public/a\u0085",
    "public/a.", "public/a ", "public/a:stream", "public/a?", "public/a*", "public/<a>", "public/a|b",
    "public/CON", "public/NUL.txt", "public/aux", "public/PRN", "public/com1.js", "public/LPT9", "public/COM¹.txt", "public/CONIN$", "public/CONOUT$.txt",
    "public/" + "a".repeat(241), "other/file", "public", ".next", "node_modules", "package.json/child", "LICENSE/child", "PACKAGE.JSON",
    ".next/cache/entry", ".next/CACHE/entry", ".next/trace", ".next/trace-build", ".next/server/page.js.nft.json",
    "public/a.js.map", "public/a.TS.MAP", "node_modules/p/a.cjs.map", "public/a.mjs.map", "public/a.jsx.map", "public/a.cts.map", "public/a.mts.map", "public/a.tsx.map", "public/a.css.map",
  ]) rejectLayout(layout([path]));
  validateLayout(layout(["public/world.map", "public/styles.scss.map", "public/a.js.map.json", "public/a.js.map/asset", "node_modules/p/trace", "public/cache/a"]), releaseFor(layout(["public/world.map", "public/styles.scss.map", "public/a.js.map.json", "public/a.js.map/asset", "node_modules/p/trace", "public/cache/a"])));
});

test("layout rejects duplicates, directory case aliases, and file/directory clashes in either order", () => {
  for (const extras of [
    ["public/a", "public/a"], ["public/a", "public/A"],
    ["public/Dir/a", "public/dir/b"], ["node_modules/PKG/a", "node_modules/pkg/b"],
    ["public/a", "public/a/b"], ["public/a/b", "public/a"],
    [".next/BUILD_ID/child"], ["public/a/B/c", "public/a/b/d"],
  ]) rejectLayout(layout(extras));
});

test("layout rejects schema, metadata, count/total mismatch, overflow and missing runtime files", () => {
  for (const mutate of [
    (v) => { v.schema = 2; }, (v) => { v.extra = true; },
    (v) => { v.files[0].symlink = "elsewhere"; }, (v) => { v.files[0].mode = 0o777; },
    (v) => { v.files[0].size = -1; }, (v) => { v.files[0].size = 0.5; },
    (v) => { v.files[0].size = "1"; }, (v) => { v.files[0].sha256 = "A".repeat(64); },
    (v) => { v.files[0].sha256 = "a".repeat(63); }, (v) => { v.files[0].path = null; },
    (v) => { v.files[0].size = Number.MAX_SAFE_INTEGER; },
    (v) => { v.files[0].size = LIMITS.expandedBytes; },
  ]) {
    const value = layout();
    mutate(value);
    rejectLayout(value);
  }
  for (let index = 0; index < required.length; index += 1) {
    const value = layout();
    value.files.splice(index, 1);
    rejectLayout(value);
  }
  const value = layout();
  for (const expected of [{ fileCount: 1, bytes: 6 }, { fileCount: 6, bytes: 7 }, { fileCount: 6, bytes: 0 }, { fileCount: 6, bytes: LIMITS.expandedBytes + 1 }]) assert.throws(() => validateLayout(value, { layout: expected }));
  for (const malformed of [null, [], {}, { schema: 1, files: null }, { schema: 1, files: [] }, { schema: 1, files: [null] }]) assert.throws(() => validateLayout(malformed, releaseFor(value)));
  assert.throws(() => validateLayout(value, null));
  const tooMany = { schema: 1, files: Array(LIMITS.files + 1).fill({ path: "public/a", size: 0, sha256: digest }) };
  rejectLayout(tooMany);
});

test("compatibility requires matching shell content digest and toolset, not the packaging version", () => {
  const value = body();
  const shell = { schema: 1, version: value.shell.version, digest, toolset: digest };
  assert.equal(compatibleApplication(value, shell), true);
  assert.equal(compatibleApplication({ ...value, version: "99.0.0" }, shell), true);
  // 业务发版只提升应用版本；壳内容摘要不变时仍应在同一壳上可用。
  assert.equal(compatibleApplication({ ...value, shell: { ...value.shell, version: "1.0.1" } }, shell), true);
  for (const patch of [{ schema: 2 }, { digest: "b".repeat(64) }, { digest: "A".repeat(64) }, { toolset: "b".repeat(64) }, { toolset: null }]) assert.equal(compatibleApplication(value, { ...shell, ...patch }), false);
  assert.equal(compatibleApplication({ ...value, shell: { ...value.shell, digest: "b".repeat(64) } }, shell), false);
  assert.equal(compatibleApplication({ ...value, toolset: "b".repeat(64) }, shell), false);
  for (const malformed of [null, {}, { shell: null }, { ...value, toolset: "bad" }, { ...value, shell: { ...value.shell, digest: "bad" } }]) assert.equal(compatibleApplication(malformed, shell), false);
  for (const malformed of [null, {}, { ...shell, schema: "1" }]) assert.equal(compatibleApplication(value, malformed), false);
});

test("application manifest URL derives only the exact legacy filename and preserves base/query", () => {
  assert.equal(applicationManifestUrl("https://updates.example/releases/desktop-update-manifest.json?token=abc").href, "https://updates.example/releases/desktop-application-manifest.json?token=abc");
  for (const value of [null, "bad", "https://updates.example/feed.json", "https://updates.example/desktop-update-manifest.json/child", "https://updates.example/my-desktop-update-manifest.json", "https://updates.example/Desktop-update-manifest.json", "https://updates.example/desktop%2Dupdate-manifest.json", "https://updates.example/desktop-update-manifest.json#hash", "https://u:p@updates.example/desktop-update-manifest.json", "http://localhost/desktop-update-manifest.json", "http://[::1]/desktop-update-manifest.json"]) assert.equal(applicationManifestUrl(value, true), null, String(value));
  const local = "http://127.0.0.1:1234/desktop-update-manifest.json";
  assert.equal(applicationManifestUrl(local), null);
  assert.equal(applicationManifestUrl(local, true).href, "http://127.0.0.1:1234/desktop-application-manifest.json");
});
