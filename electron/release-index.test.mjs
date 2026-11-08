import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { INDEX_NAME, INDEX_PROTOCOL, buildReleaseIndex, releaseIndexUrl, releaseKind, verifyReleaseIndex } from "./release-index.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const MANIFEST = "https://github.com/owner/repository/releases/latest/download/desktop-update-manifest.json";
const BASE = "https://github.com/owner/repository/releases/download/";
const SHELL = { schema: 1, version: "1.0.0", digest: "a".repeat(64), toolset: "b".repeat(64) };
const signing = { privateKey, config: { manifestUrl: MANIFEST, publicKey: pem } };

const UPDATE_URL = (version, tag) => `${BASE}${tag ?? `desktop-v${version}`}/desktop-update-manifest.json`;
const APP_URL = (version) => `${BASE}desktop-v${version}/desktop-application-manifest.json`;

function envelope(value) {
  const payload = Buffer.from(JSON.stringify(value));
  return { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") };
}

function body(overrides = {}) {
  return {
    schema: INDEX_PROTOCOL, type: "weclio-release-index", version: "2.0.0",
    shell: { version: SHELL.version, digest: SHELL.digest, toolset: SHELL.toolset },
    installer: { version: "2.0.0", manifestUrl: UPDATE_URL("2.0.0") },
    application: null,
    ...overrides,
  };
}

test("release index constants and section kinds", () => {
  assert.equal(INDEX_NAME, "desktop-release-index.json");
  assert.equal(INDEX_PROTOCOL, 1);
  assert.equal(releaseKind({ installer: {}, application: null }), "shell");
  assert.equal(releaseKind({ installer: null, application: {} }), "application");
  assert.equal(releaseKind({ installer: {}, application: {} }), "both");
  assert.equal(releaseKind({ installer: null, application: null }), "none");
  assert.equal(releaseKind({}), "none");
  assert.equal(releaseKind(null), "none");
});

test("build signs and verify normalizes each section combination", () => {
  const installerOnly = buildReleaseIndex({ version: "2.0.0", shell: SHELL, installer: { version: "2.0.0" }, application: null, signing });
  const decoded = JSON.parse(Buffer.from(installerOnly.payload, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["application", "installer", "schema", "shell", "type", "version"]);
  assert.deepEqual(Object.keys(decoded.shell).sort(), ["digest", "toolset", "version"]);
  assert.deepEqual(decoded.installer, { version: "2.0.0", manifestUrl: UPDATE_URL("2.0.0") });
  assert.equal(decoded.application, null);
  const result = verifyReleaseIndex(installerOnly, publicKey);
  assert.deepEqual(result, {
    schema: INDEX_PROTOCOL, type: "weclio-release-index", version: "2.0.0",
    shell: { version: "1.0.0", digest: SHELL.digest, toolset: SHELL.toolset },
    installer: { version: "2.0.0", manifestUrl: UPDATE_URL("2.0.0") },
    application: null,
    id: createHash("sha256").update(Buffer.from(installerOnly.payload, "base64")).digest("hex"),
  });
  // PEM 字符串与 KeyObject 公钥等价；显式发布基址与推导一致时通过。
  assert.deepEqual(verifyReleaseIndex(installerOnly, pem), result);
  buildReleaseIndex({ version: "2.0.0", shell: SHELL, installer: { version: "2.0.0" }, application: null, releaseBase: BASE, signing });

  const applicationOnly = buildReleaseIndex({ version: "3.0.0", shell: SHELL, installer: null, application: { version: "3.0.0" }, signing });
  const applicationResult = verifyReleaseIndex(applicationOnly, publicKey);
  assert.equal(applicationResult.installer, null);
  assert.deepEqual(applicationResult.application, { version: "3.0.0", manifestUrl: APP_URL("3.0.0") });

  const both = buildReleaseIndex({ version: "4.0.0", shell: SHELL, installer: { version: "4.0.0" }, application: { version: "4.0.0" }, signing });
  const bothResult = verifyReleaseIndex(both, publicKey);
  assert.equal(releaseKind(bothResult), "both");
  assert.deepEqual(bothResult.installer, { version: "4.0.0", manifestUrl: UPDATE_URL("4.0.0") });
  assert.deepEqual(bothResult.application, { version: "4.0.0", manifestUrl: APP_URL("4.0.0") });
});

test("installer tag overrides only the release tag in the derived URL", () => {
  const result = verifyReleaseIndex(buildReleaseIndex({ version: "2.0.0", shell: SHELL, installer: { version: "2.0.0", tag: "desktop-v9.9.9" }, application: null, signing }), publicKey);
  assert.equal(result.installer.manifestUrl, UPDATE_URL("2.0.0", "desktop-v9.9.9"));
});

test("build validates versions, sections, shell, release base and signing key", () => {
  const options = { version: "2.0.0", shell: SHELL, installer: { version: "2.0.0" }, application: null, signing };
  for (const mutate of [
    (o) => { o.version = "1.9.9"; }, (o) => { o.version = "2.0.1"; }, (o) => { o.version = "2.0.0-rc"; },
    (o) => { o.installer = null; o.application = null; },
    (o) => { o.shell = { ...SHELL, version: "5.0.0" }; }, (o) => { o.shell = { ...SHELL, schema: 2 }; },
    (o) => { o.shell = { ...SHELL, digest: "A".repeat(64) }; }, (o) => { o.shell = { ...SHELL, extra: 1 }; },
    (o) => { o.releaseBase = "https://evil.example/"; },
    (o) => { o.installer = { version: "2.0.0", extra: 1 }; }, (o) => { o.installer = { version: "2.0.0", tag: "../evil" }; },
    (o) => { o.installer = { version: "2.0.0", tag: "x/y" }; }, (o) => { o.installer = { version: "1.0" }; },
    (o) => { o.application = { version: "2.0.0", manifestUrl: "x" }; },
  ]) {
    const value = { ...options };
    mutate(value);
    assert.throws(() => buildReleaseIndex(value), mutate.toString());
  }
  for (const manifestUrl of [
    "https://evil.example/releases/latest/download/desktop-update-manifest.json",
    "https://github.com/owner/repository/releases/latest/download/desktop-update-manifest.json?x=1",
    "https://github.com/../repository/releases/latest/download/desktop-update-manifest.json",
    "http://github.com/owner/repository/releases/latest/download/desktop-update-manifest.json",
    "https://github.com/owner/repository/releases/download/desktop-update-manifest.json",
  ]) {
    assert.throws(() => buildReleaseIndex({ ...options, signing: { ...signing, config: { ...signing.config, manifestUrl } } }), manifestUrl);
  }
  const other = generateKeyPairSync("ed25519");
  assert.throws(() => buildReleaseIndex({ ...options, signing: { privateKey: other.privateKey, config: signing.config } }));
  assert.throws(() => buildReleaseIndex({ ...options, signing: { privateKey, config: { manifestUrl: MANIFEST, publicKey: other.publicKey.export({ type: "spki", format: "pem" }).toString() } } }));
  assert.throws(() => buildReleaseIndex({ ...options, signing: { privateKey, config: { manifestUrl: MANIFEST } } }));
});

test("verify checks envelope keys, canonical base64 and signature before JSON", () => {
  const signed = envelope(body());
  assert.throws(() => verifyReleaseIndex(signed, generateKeyPairSync("ed25519").publicKey), /signature/);
  assert.throws(() => verifyReleaseIndex(signed, generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey), /signature/);
  assert.throws(() => verifyReleaseIndex({ ...signed, extra: true }));
  for (const malformed of [null, [], {}, { signature: signed.signature }, { payload: signed.payload }]) assert.throws(() => verifyReleaseIndex(malformed, publicKey));
  for (const field of ["payload", "signature"]) {
    for (const bad of ["", "%%%", "YQ", "YR==", signed[field] + "\n", signed[field] + "=", null, 3]) {
      assert.throws(() => verifyReleaseIndex({ ...signed, [field]: bad }, publicKey));
    }
  }
  assert.throws(() => verifyReleaseIndex({ ...signed, signature: Buffer.alloc(63).toString("base64") }, publicKey));
  const tampered = { payload: Buffer.from(JSON.stringify(body({ version: "9.9.9" }))).toString("base64"), signature: signed.signature };
  assert.throws(() => verifyReleaseIndex(tampered, publicKey));
  for (const bytes of [Buffer.from([0xff]), Buffer.from("{")]) {
    assert.throws(() => verifyReleaseIndex({ payload: bytes.toString("base64"), signature: sign(null, bytes, privateKey).toString("base64") }, publicKey));
  }
});

test("verify rejects unknown keys, type/schema changes and missing sections", () => {
  for (const mutate of [
    (v) => { v.schema = 2; }, (v) => { v.schema = "1"; }, (v) => { v.type = "weclio-application"; },
    (v) => { v.extra = 1; }, (v) => { v.installer.extra = 1; }, (v) => { v.application = { version: "2.0.0" }; },
    (v) => { v.shell.extra = 1; }, (v) => { v.shell.schema = 1; }, (v) => { delete v.shell.toolset; },
    (v) => { v.installer = true; }, (v) => { v.installer = []; }, (v) => { delete v.installer; },
  ]) {
    const value = body();
    mutate(value);
    assert.throws(() => verifyReleaseIndex(envelope(value), publicKey), mutate.toString());
  }
  const empty = body({ installer: null, application: null });
  assert.throws(() => verifyReleaseIndex(envelope(empty), publicKey));
});

test("verify enforces stable versions, maximum and shell floor", () => {
  for (const mutate of [
    (v) => { v.version = "01.0.0"; }, (v) => { v.version = "1.0.0"; }, (v) => { v.version = "3.0.0"; },
    (v) => { v.installer.version = "3.0.0"; }, (v) => { v.installer.version = "1.0.0"; },
    (v) => { v.shell.version = "9.0.0"; }, (v) => { v.shell.version = "1.0.0-rc"; },
    (v) => { v.shell.digest = "A".repeat(64); }, (v) => { v.shell.toolset = "b".repeat(63); },
  ]) {
    const value = body();
    mutate(value);
    assert.throws(() => verifyReleaseIndex(envelope(value), publicKey), mutate.toString());
  }
  // 两段可同版本；body.version 取最大值，且不得低于壳版本。
  verifyReleaseIndex(envelope(body({ version: "5.0.0", shell: { version: "5.0.0", digest: SHELL.digest, toolset: SHELL.toolset }, installer: { version: "5.0.0", manifestUrl: UPDATE_URL("5.0.0") }, application: { version: "5.0.0", manifestUrl: APP_URL("5.0.0") } })), publicKey);
  verifyReleaseIndex(envelope(body({ version: "6.0.0", installer: { version: "6.0.0", manifestUrl: UPDATE_URL("6.0.0") }, application: { version: "5.0.0", manifestUrl: APP_URL("5.0.0") } })), publicKey);
  assert.throws(() => verifyReleaseIndex(envelope(body({ version: "5.0.0", installer: { version: "6.0.0", manifestUrl: UPDATE_URL("6.0.0") }, application: { version: "5.0.0", manifestUrl: APP_URL("5.0.0") } })), publicKey));
});

test("verify restricts manifest URLs to HTTPS and exact filenames", () => {
  for (const manifestUrl of [
    `${BASE}desktop-v2.0.0/desktop-application-manifest.json`,
    `${BASE}desktop-v2.0.0/desktop-update-manifest.jsonx`,
    `${BASE}desktop-v2.0.0/footdesktop-update-manifest.json`,
    `${BASE}desktop-v2.0.0/`,
  ]) {
    const value = body();
    value.installer.manifestUrl = manifestUrl;
    assert.throws(() => verifyReleaseIndex(envelope(value), publicKey), manifestUrl);
  }
  for (const manifestUrl of [
    "http://updates.example/desktop-update-manifest.json",
    "http://localhost/desktop-update-manifest.json",
    "http://[::1]/desktop-update-manifest.json",
    "file:///desktop-update-manifest.json",
    "https://user:pass@github.com/o/r/desktop-update-manifest.json",
    "https://github.com/o/r/desktop-update-manifest.json#fragment",
    "https://github.com/o/r/desktop-update-manifest.json/?q=1",
  ]) {
    const value = body();
    value.installer.manifestUrl = manifestUrl;
    assert.throws(() => verifyReleaseIndex(envelope(value), publicKey, true), manifestUrl);
  }
  const local = body();
  local.installer.manifestUrl = "http://127.0.0.1:1234/desktop-v2.0.0/desktop-update-manifest.json";
  assert.throws(() => verifyReleaseIndex(envelope(local), publicKey));
  assert.equal(verifyReleaseIndex(envelope(local), publicKey, true).installer.manifestUrl, local.installer.manifestUrl);
  const appLocal = body({ installer: null, application: { version: "2.0.0", manifestUrl: "http://127.0.0.1:1234/desktop-v2.0.0/desktop-application-manifest.json" } });
  assert.equal(verifyReleaseIndex(envelope(appLocal), publicKey, true).application.manifestUrl, appLocal.application.manifestUrl);
});

test("verify caps payload at 64 KiB and signature at 64 bytes", () => {
  const text = JSON.stringify(body());
  const maximum = Buffer.from(text + " ".repeat(65536 - Buffer.byteLength(text)));
  assert.equal(verifyReleaseIndex({ payload: maximum.toString("base64"), signature: sign(null, maximum, privateKey).toString("base64") }, publicKey).version, "2.0.0");
  const tooBig = Buffer.from(text + " ".repeat(65536 - Buffer.byteLength(text) + 1));
  assert.throws(() => verifyReleaseIndex({ payload: tooBig.toString("base64"), signature: sign(null, tooBig, privateKey).toString("base64") }, publicKey));
});

test("releaseIndexUrl maps only the exact legacy filename", () => {
  assert.equal(releaseIndexUrl("https://updates.example/releases/desktop-update-manifest.json?token=abc").href, "https://updates.example/releases/desktop-release-index.json?token=abc");
  assert.equal(releaseIndexUrl(`${BASE}desktop-v2.0.0/desktop-update-manifest.json`).href, `${BASE}desktop-v2.0.0/desktop-release-index.json`);
  for (const value of [
    null, "bad", "https://updates.example/feed.json", "https://updates.example/desktop-update-manifest.json/child",
    "https://updates.example/my-desktop-update-manifest.json", "https://updates.example/Desktop-update-manifest.json",
    "https://updates.example/desktop%2Dupdate-manifest.json", "https://updates.example/desktop-update-manifest.json#hash",
    "https://u:p@updates.example/desktop-update-manifest.json", "http://localhost/desktop-update-manifest.json",
    "http://[::1]/desktop-update-manifest.json", "http://updates.example/desktop-update-manifest.json",
  ]) assert.equal(releaseIndexUrl(value, true), null, String(value));
  const local = "http://127.0.0.1:1234/desktop-update-manifest.json";
  assert.equal(releaseIndexUrl(local), null);
  assert.equal(releaseIndexUrl(local, true).href, "http://127.0.0.1:1234/desktop-release-index.json");
});
