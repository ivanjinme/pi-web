import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateService } from "./updates.mjs";

const CONTENT = Buffer.from("This is plain text, never an installer or executable.\n");
const SHA512 = createHash("sha512").update(CONTENT).digest("base64");

class FakeUpdater extends EventEmitter {
  constructor(path, info) {
    super();
    this.path = path;
    this.info = info;
    this.calls = [];
    this.autoInstallOnAppQuit = true;
  }
  async checkForUpdates() {
    this.calls.push(["check"]);
    return { isUpdateAvailable: true, updateInfo: this.info };
  }
  async downloadUpdate(token) {
    this.calls.push(["download", token]);
    return [this.path];
  }
  quitAndInstall(...args) { this.calls.push(["quitAndInstall", ...args]); }
  install() { assert.fail("Direct installation must never be called"); }
  doInstall() { assert.fail("Native installation must never be called"); }
}

async function fixture(t, { installEnabled = true, useDefault = false, marker = true, omitMarker = false, size = CONTENT.length, sha512 = SHA512 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "weclio-install-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "downloaded-update.txt");
  await writeFile(path, CONTENT);
  const info = { version: "99.0.0", files: [{ url: "https://updates.invalid/plaintext.txt", size, sha512 }] };
  if (!omitMarker) info.installable = marker;
  const updater = new FakeUpdater(path, info);
  const token = { cancelled: 0, cancel() { this.cancelled += 1; } };
  const abort = new AbortController();
  const states = [];
  const logs = [];
  const options = {
    updater, token, abort,
    publish: (state) => states.push(state),
    log: (...args) => logs.push(args),
    setTimer: () => assert.fail("Install-boundary tests must not start polling"),
    clearTimer: () => assert.fail("No polling timer should exist"),
  };
  if (!useDefault) options.installEnabled = installEnabled;
  const service = createUpdateService(options);
  t.after(() => service.stop());
  return {
    service, updater, token, abort, path, states, logs,
    handoffs: () => updater.calls.filter(([name]) => name === "quitAndInstall"),
  };
}

function assertNoHandoff(h) {
  assert.deepEqual(h.handoffs(), []);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
}

test("enabled production service needs downloaded state and fresh disk verification before stock updater handoff", async (t) => {
  const h = await fixture(t);
  assert.equal(h.service.canInstall(), false);
  await assert.rejects(h.service.verifyForInstall(), /download-only/);
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  assertNoHandoff(h);

  await h.service.check();
  assert.deepEqual(h.service.getState(), { status: "downloaded", version: "99.0.0" });
  assert.equal(h.service.canInstall(), true);
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  assertNoHandoff(h);
  assert.deepEqual(h.updater.calls, [["check"], ["download", h.token]]);

  await h.service.verifyForInstall();
  assertNoHandoff(h);
  h.service.quitAndInstall();
  assert.deepEqual(h.handoffs(), [["quitAndInstall", true, true]]);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.deepEqual(h.states.map(({ status }) => status), ["checking", "downloading", "downloaded"]);
});

for (const { name, options } of [
  { name: "legacy stage-one/GitHub fixture without marker", options: { omitMarker: true } },
  { name: "explicitly non-installable signature marker", options: { marker: false } },
  { name: "string marker instead of signed boolean true", options: { marker: "true" } },
]) {
  test(`${name} never installs even when production installation is enabled`, async (t) => {
    const h = await fixture(t, options);
    await h.service.check();
    assert.equal(h.service.getState().status, "downloaded");
    assert.equal(h.service.canInstall(), false);
    await assert.rejects(h.service.verifyForInstall(), /download-only/);
    assert.throws(() => h.service.quitAndInstall(), /not verified/);
    assertNoHandoff(h);
  });
}

test("development/default installEnabled=false stays download-only even with signed installable=true", async (t) => {
  const h = await fixture(t, { useDefault: true });
  await h.service.check();
  assert.equal(h.service.getState().status, "downloaded");
  assert.equal(h.service.canInstall(), false);
  await assert.rejects(h.service.verifyForInstall(), /download-only/);
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  assertNoHandoff(h);
});

for (const kind of ["same-length hash tampering", "changed file size", "missing file"]) {
  test(`${kind} revokes previously granted verification and prevents handoff`, async (t) => {
    const h = await fixture(t);
    await h.service.check();
    await h.service.verifyForInstall();
    assert.equal(h.service.canInstall(), true);
    if (kind === "missing file") {
      await rm(h.path);
    } else if (kind === "changed file size") {
      await writeFile(h.path, Buffer.concat([CONTENT, Buffer.from("extra")]));
    } else {
      const tampered = Buffer.from(CONTENT);
      tampered[0] ^= 1;
      assert.equal(tampered.length, CONTENT.length);
      await writeFile(h.path, tampered);
    }
    await assert.rejects(h.service.verifyForInstall(), kind === "missing file" ? /ENOENT/ : /changed after downloading/);
    assert.deepEqual(h.service.getState(), { status: "idle" });
    assert.equal(h.service.canInstall(), false);
    assert.throws(() => h.service.quitAndInstall(), /not verified/);
    assertNoHandoff(h);
  });
}

test("cache cleanup failures are logged without hiding the verification error or allowing installation", async (t) => {
  const h = await fixture(t);
  h.updater.downloadedUpdateHelper = { async clear() { throw new Error("Cache cleanup failed"); } };
  await h.service.check();
  await writeFile(h.path, Buffer.alloc(CONTENT.length, 0x78));
  await assert.rejects(h.service.verifyForInstall(), /changed after downloading/);
  assert.equal(h.service.getState().status, "idle");
  assert.equal(h.service.canInstall(), false);
  assert.ok(h.logs.some((args) => args.includes("Cache cleanup failed")));
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  assertNoHandoff(h);
});

test("actual disk content must match the manifest hash, not merely its size or installable marker", async (t) => {
  const h = await fixture(t, { sha512: createHash("sha512").update("different manifest content").digest("base64") });
  await h.service.check();
  assert.equal(h.service.getState().status, "downloaded");
  await assert.rejects(h.service.verifyForInstall(), /changed after downloading/);
  assert.equal(h.service.getState().status, "idle");
  assert.equal(h.service.canInstall(), false);
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  assertNoHandoff(h);
});

test("downloaded plaintext with a mismatched manifest size never becomes installable", async (t) => {
  const h = await fixture(t, { size: CONTENT.length + 1 });
  await h.service.check();
  assert.deepEqual(h.service.getState(), { status: "idle" });
  assert.equal(h.service.canInstall(), false);
  assert.ok(h.logs.some((args) => args.includes("Downloaded update size mismatch")));
  await assert.rejects(h.service.verifyForInstall(), /download-only/);
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  assertNoHandoff(h);
});

test("onInstallError subscribes to the fake updater and unsubscribe removes only that listener", async (t) => {
  const h = await fixture(t);
  const received = [];
  const originalListeners = h.updater.listenerCount("error");
  const unsubscribe = h.service.onInstallError((error) => received.push(error));
  assert.equal(h.updater.listenerCount("error"), originalListeners + 1);
  const first = new Error("Fake updater install failure");
  h.updater.emit("error", first);
  assert.deepEqual(received, [first]);
  assert.ok(h.logs.some((args) => args.includes(first.message)));
  unsubscribe();
  assert.equal(h.updater.listenerCount("error"), originalListeners);
  h.updater.emit("error", new Error("After unsubscribe"));
  assert.deepEqual(received, [first]);
  assertNoHandoff(h);
});

test("stop revokes verified installation, cancels the token, and never auto-installs on quit", async (t) => {
  const h = await fixture(t);
  await h.service.check();
  await h.service.verifyForInstall();
  assert.equal(h.service.canInstall(), true);
  h.service.stop();
  assert.equal(h.service.canInstall(), false);
  assert.equal(h.token.cancelled, 1);
  assert.equal(h.abort.signal.aborted, true);
  assert.equal(h.updater.listenerCount("error"), 0);
  await assert.rejects(h.service.verifyForInstall(), /download-only/);
  assert.throws(() => h.service.quitAndInstall(), /not verified/);
  await h.service.check();
  assert.deepEqual(h.updater.calls, [["check"], ["download", h.token]]);
  assertNoHandoff(h);
});

test("explicit verified handoff does not enable automatic installation on subsequent quit", async (t) => {
  const h = await fixture(t);
  await h.service.check();
  await h.service.verifyForInstall();
  h.service.quitAndInstall();
  assert.deepEqual(h.handoffs(), [["quitAndInstall", true, true]]);
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  h.service.stop();
  assert.equal(h.updater.autoInstallOnAppQuit, false);
  assert.equal(h.handoffs().length, 1);
});
